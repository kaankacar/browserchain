import { Keypair, Operation, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { compareBytes, concatBytes, fromBase64, fromHex, toHex, xorBytes } from '../lib/bytes';
import { networkPassphrase } from '../lib/constants';
import { networkIdOf, sha256, sha256Hex } from '../lib/hash';
import { verifyHex } from '../lib/keys';
import { decodeTransaction } from './tx';
import { computeTxSetHash, decodeTxSet, isCanonicalOrder, makeTxSet, sortForApply } from './txset';
import { TestLedger } from './testkit';
import {
  decodeStellarValue,
  encodeStellarValue,
  makeSignedStellarValue,
  stellarValueSignaturePayload,
  verifyStellarValueSignature,
} from './value';

const NETWORK_ID = networkIdOf(networkPassphrase());
const TXSET = 'cd'.repeat(32);

describe('StellarValue codec', () => {
  it('round trips basic and signed values as lowercase hex', () => {
    const basic = { txSetHash: TXSET, closeTime: 1_790_000_123, upgrades: [], signature: null };
    const hex = encodeStellarValue(basic);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(decodeStellarValue(hex)).toEqual(basic);
    const kp = Keypair.random();
    const signed = makeSignedStellarValue(NETWORK_ID, kp, TXSET, 1_790_000_123);
    expect(signed.signature!.nodeId).toBe(kp.publicKey());
    expect(decodeStellarValue(encodeStellarValue(signed))).toEqual(signed);
    const x = xdr.StellarValue.fromXdr(fromHex(encodeStellarValue(signed)));
    expect(x.ext.type).toBe('stellarValueSigned');
  });

  it('rejects StellarValue ext arms other than basic and signed (STELLAR_VALUE_EMPTY_TX_SET)', () => {
    // stellar-base 15 could not decode this arm at all; stellar-sdk 17 can.
    // It stays malformed here, so values decode exactly as before.
    const kp = Keypair.random();
    const signature = new xdr.LedgerCloseValueSignature({
      nodeId: xdr.PublicKey.publicKeyTypeEd25519(kp.rawPublicKey()),
      signature: new Uint8Array(64),
    });
    const empty = new xdr.StellarValue({
      txSetHash: fromHex(TXSET),
      closeTime: 1_790_000_123n,
      upgrades: [],
      ext: xdr.StellarValueExt.stellarValueEmptyTxSet(
        new xdr.StellarValueProposedValue({
          txSetHash: fromHex(TXSET),
          previousLedgerHash: new Uint8Array(32),
          previousLedgerVersion: 23,
          lcValueSignature: signature,
        }),
      ),
    });
    expect(() => decodeStellarValue(toHex(empty.toXdr()))).toThrow(/unsupported ext/);
    // an unknown discriminant (3) is still an XDR decode error
    const signed = makeSignedStellarValue(NETWORK_ID, kp, TXSET, 1_790_000_123);
    const bytes = fromHex(encodeStellarValue(signed));
    bytes.set([0, 0, 0, 3], 32 + 8 + 4);
    expect(() => decodeStellarValue(toHex(bytes))).toThrow();
  });

  it('signs networkId || ENVELOPE_TYPE_SCPVALUE || txSetHash || closeTime', () => {
    const payload = stellarValueSignaturePayload(NETWORK_ID, TXSET, 258);
    expect(payload.length).toBe(32 + 4 + 32 + 8);
    expect(toHex(payload.slice(0, 32))).toBe(toHex(NETWORK_ID));
    expect(toHex(payload.slice(32, 36))).toBe('00000004');
    expect(toHex(payload.slice(36, 68))).toBe(TXSET);
    expect(toHex(payload.slice(68))).toBe('0000000000000102');
    const kp = Keypair.random();
    const v = makeSignedStellarValue(NETWORK_ID, kp, TXSET, 258);
    expect(verifyHex(kp.publicKey(), payload, v.signature!.signature)).toBe(true);
    expect(verifyStellarValueSignature(NETWORK_ID, v)).toBe(true);
    expect(verifyStellarValueSignature(NETWORK_ID, { ...v, closeTime: 259 })).toBe(false);
    expect(verifyStellarValueSignature(networkIdOf('other'), v)).toBe(false);
    expect(verifyStellarValueSignature(NETWORK_ID, { ...v, signature: null })).toBe(false);
  });

  it('throws on malformed values', () => {
    expect(() => decodeStellarValue('zz')).toThrow();
    expect(() => decodeStellarValue('00')).toThrow();
    const hex = encodeStellarValue({ txSetHash: TXSET, closeTime: 5, upgrades: [], signature: null });
    expect(() => decodeStellarValue(`${hex}00000000`)).toThrow();
    expect(() => decodeStellarValue(hex.slice(0, -2))).toThrow();
  });
});

describe('transaction sets', () => {
  const t = new TestLedger();
  const envelopes = t.channels.slice(0, 6).map((kp) =>
    t.tx(kp, [Operation.bumpSequence({ bumpTo: '100' })]),
  );

  it('makeTxSet sorts by envelope hash and hashes prev || envelopes', () => {
    const prev = t.lm.lastClosed().hash;
    const set = makeTxSet(prev, envelopes);
    const hashes = set.txs.map((e) => sha256(fromBase64(e)));
    expect(isCanonicalOrder(hashes)).toBe(true);
    expect(set.hash).toBe(sha256Hex(concatBytes(fromHex(prev), ...set.txs.map(fromBase64))));
    expect(set.previousLedgerHash).toBe(prev);
    expect(makeTxSet(prev, [...envelopes].reverse())).toEqual(set);
    expect(makeTxSet(prev, [...envelopes, envelopes[0]])).toEqual(set);
    expect(() => makeTxSet(prev, ['garbage'])).toThrow();
    const decoded = xdr.TransactionSet.fromXdr(fromBase64(set.xdr));
    expect(decoded.txs).toHaveLength(envelopes.length);
  });

  it('decodeTxSet re-hashes and keeps the order', () => {
    const prev = t.lm.lastClosed().hash;
    const set = makeTxSet(prev, envelopes);
    expect(decodeTxSet(set.xdr)).toEqual(set);
    const reversed = new xdr.TransactionSet({
      previousLedgerHash: fromHex(prev),
      txs: [...set.txs].reverse().map((e) => xdr.TransactionEnvelope.fromXdr(e, 'base64')),
    });
    const d = decodeTxSet(reversed.toXdr('base64'));
    expect(d.txs).toEqual([...set.txs].reverse());
    expect(d.hash).not.toBe(set.hash);
    expect(isCanonicalOrder(d.txs.map((e) => sha256(fromBase64(e))))).toBe(false);
    expect(() => decodeTxSet('AAAA')).toThrow();
  });

  it('hashes tx sets with more envelopes than a call can take arguments', () => {
    // A peer controls the envelope count; spreading them into one call threw RangeError.
    const prev = 'cd'.repeat(32);
    const envs = Array.from({ length: 150_000 }, (_, i) => new Uint8Array([i & 0xff, (i >> 8) & 0xff, i >> 16]));
    const all = new Uint8Array(32 + 3 * envs.length);
    all.set(fromHex(prev), 0);
    envs.forEach((e, i) => all.set(e, 32 + 3 * i));
    expect(computeTxSetHash(prev, envs)).toBe(sha256Hex(all));
  });

  it('empty tx set hash is sha256(prev)', () => {
    const prev = 'ab'.repeat(32);
    const set = makeTxSet(prev, []);
    expect(set.hash).toBe(sha256Hex(fromHex(prev)));
    expect(set.txs).toEqual([]);
  });

  it('apply order: batches by account sequence, each sorted by hash XOR set hash', () => {
    const a = t.channels[0];
    const b = t.channels[1];
    const c = t.channels[2];
    const envs = [
      t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })]),
      t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { seqOffset: 1n }),
      t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { seqOffset: 2n }),
      t.tx(b, [Operation.bumpSequence({ bumpTo: '0' })]),
      t.tx(b, [Operation.bumpSequence({ bumpTo: '0' })], { seqOffset: 1n }),
      t.tx(c, [Operation.bumpSequence({ bumpTo: '0' })]),
    ];
    const set = makeTxSet(t.lm.lastClosed().hash, envs);
    const txs = set.txs.map((e) => decodeTransaction(e, t.lm.networkId));
    const order = sortForApply(txs, set.hash);
    expect(order).toHaveLength(6);
    const key = (x: (typeof txs)[number]) => xorBytes(x.fullHash, fromHex(set.hash));
    // Batch sizes: 3 accounts, then 2, then 1.
    const batches = [order.slice(0, 3), order.slice(3, 5), order.slice(5)];
    expect(new Set(batches[0].map((x) => x.sourceId)).size).toBe(3);
    expect(batches[1].map((x) => x.sourceId).sort()).toEqual([a.publicKey(), b.publicKey()].sort());
    expect(batches[2][0].sourceId).toBe(a.publicKey());
    for (const batch of batches) {
      for (let i = 1; i < batch.length; i++) expect(compareBytes(key(batch[i - 1]), key(batch[i]))).toBe(-1);
    }
    // Per account, sequence numbers increase in apply order.
    const seqA = order.filter((x) => x.sourceId === a.publicKey()).map((x) => x.seqNum);
    expect(seqA).toEqual([...seqA].sort((x, y) => (x < y ? -1 : 1)));
    // Deterministic regardless of input order.
    expect(sortForApply([...txs].reverse(), set.hash).map((x) => x.hashHex)).toEqual(order.map((x) => x.hashHex));
  });
});
