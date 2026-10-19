import { Keypair, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { fromBase64, fromHex, toBase64, utf8 } from '../lib/bytes';
import { sha256Hex } from '../lib/hash';
import {
  makeDontHaveMessage,
  makeGetScpQuorumSetMessage,
  makeGetTxSetMessage,
  makeScpMessage,
  makeScpQuorumSetMessage,
  makeTransactionMessage,
  makeTxSetMessage,
  parseStellarMessage,
  stellarMessageId,
  tryParseStellarMessage,
} from './stellarMessage';

const H1 = sha256Hex('one');
const kp = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(9));

function nodeId(k: Keypair): xdr.PublicKey {
  return xdr.PublicKey.publicKeyTypeEd25519(k.rawPublicKey());
}

function sampleQset(): xdr.ScpQuorumSet {
  return new xdr.ScpQuorumSet({ threshold: 1, validators: [nodeId(kp)], innerSets: [] });
}

function sampleEnvelope(): xdr.ScpEnvelope {
  const nominate = new xdr.ScpNomination({
    quorumSetHash: fromHex(H1),
    votes: [utf8('value-a')],
    accepted: [],
  });
  const statement = new xdr.ScpStatement({
    nodeId: nodeId(kp),
    slotIndex: xdr.Uint64.fromString('7'),
    pledges: xdr.ScpStatementPledges.scpStNominate(nominate),
  });
  return new xdr.ScpEnvelope({ statement, signature: new Uint8Array(64).fill(1) });
}

function sampleTxEnvelope(): xdr.TransactionEnvelope {
  const source = xdr.MuxedAccount.keyTypeEd25519(kp.rawPublicKey());
  const tx = new xdr.Transaction({
    sourceAccount: source,
    fee: 100,
    seqNum: xdr.Int64.fromString('1'),
    cond: xdr.Preconditions.precondNone(),
    memo: xdr.Memo.memoNone(),
    operations: [
      new xdr.Operation({
        sourceAccount: null,
        body: xdr.OperationBody.bumpSequence(new xdr.BumpSequenceOp({ bumpTo: xdr.Int64.fromString('5') })),
      }),
    ],
    ext: xdr.TransactionExt.v0(),
  });
  return xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({ tx, signatures: [] }));
}

describe('stellarMessage', () => {
  it('round-trips SCP_MESSAGE from an object or base64', () => {
    const env = sampleEnvelope();
    const fromObj = makeScpMessage(env);
    const fromB64 = makeScpMessage(env.toXdr('base64'));
    expect(fromObj).toBe(fromB64);
    const parsed = parseStellarMessage(fromObj);
    expect(parsed.kind).toBe('scpMessage');
    if (parsed.kind !== 'scpMessage') return;
    expect(parsed.envelopeXdr).toBe(env.toXdr('base64'));
    expect(parsed.envelope.statement.slotIndex.toString()).toBe('7');
  });

  it('round-trips TRANSACTION', () => {
    const env = sampleTxEnvelope();
    const parsed = parseStellarMessage(makeTransactionMessage(env.toXdr('base64')));
    expect(parsed.kind).toBe('transaction');
    if (parsed.kind === 'transaction') expect(parsed.envelopeXdr).toBe(env.toXdr('base64'));
  });

  it('round-trips TX_SET and GET_TX_SET', () => {
    const txSet = new xdr.TransactionSet({ previousLedgerHash: fromHex(H1), txs: [sampleTxEnvelope()] });
    const parsed = parseStellarMessage(makeTxSetMessage(txSet));
    expect(parsed.kind).toBe('txSet');
    if (parsed.kind === 'txSet') {
      expect(parsed.txSetXdr).toBe(txSet.toXdr('base64'));
      expect(parsed.txSet.txs).toHaveLength(1);
    }
    expect(parseStellarMessage(makeGetTxSetMessage(H1))).toEqual({ kind: 'getTxSet', hash: H1 });
  });

  it('round-trips SCP_QUORUMSET and GET_SCP_QUORUMSET', () => {
    const q = sampleQset();
    const parsed = parseStellarMessage(makeScpQuorumSetMessage(q.toXdr('base64')));
    expect(parsed.kind).toBe('scpQuorumset');
    if (parsed.kind === 'scpQuorumset') {
      expect(parsed.qsetXdr).toBe(q.toXdr('base64'));
      expect(parsed.qset.threshold).toBe(1);
    }
    expect(parseStellarMessage(makeGetScpQuorumSetMessage(H1))).toEqual({ kind: 'getScpQuorumset', hash: H1 });
  });

  it('round-trips DONT_HAVE with the item type', () => {
    expect(parseStellarMessage(makeDontHaveMessage('txSet', H1))).toEqual({ kind: 'dontHave', itemType: 'txSet', hash: H1 });
    expect(parseStellarMessage(makeDontHaveMessage('scpQuorumset', H1))).toEqual({
      kind: 'dontHave',
      itemType: 'scpQuorumset',
      hash: H1,
    });
    const raw = xdr.StellarMessage.dontHave(
      new xdr.DontHave({ type: xdr.MessageType.generalizedTxSet, reqHash: fromHex(H1) }),
    ).toXdr('base64');
    expect(parseStellarMessage(raw)).toEqual({ kind: 'dontHave', itemType: 'txSet', hash: H1 });
    // The raw XDR carries MessageType TX_SET (= 7).
    const decoded = xdr.StellarMessage.fromXdr(makeDontHaveMessage('txSet', H1), 'base64');
    if (decoded.type !== 'dontHave') throw new Error(`expected dontHave, got ${decoded.type}`);
    expect(decoded.dontHave.type.value).toBe(7);
  });

  it('rejects bad hashes, malformed XDR and unsupported types', () => {
    expect(() => makeGetTxSetMessage('ABCD')).toThrow(/hash/);
    expect(() => makeGetTxSetMessage(H1.toUpperCase())).toThrow(/hash/);
    expect(() => parseStellarMessage('AAAA')).toThrow();
    expect(() => parseStellarMessage(makeGetTxSetMessage(H1) + 'AAAA')).toThrow();
    const getScpState = xdr.StellarMessage.getScpState(5).toXdr('base64');
    expect(() => parseStellarMessage(getScpState)).toThrow(/unsupported/);
    expect(tryParseStellarMessage(getScpState)).toBeNull();
    expect(tryParseStellarMessage('***')).toBeNull();
  });

  it('never throws on mutated peer messages; what it accepts re-encodes to the same bytes', () => {
    const seeds = [
      makeScpMessage(sampleEnvelope()),
      makeTransactionMessage(sampleTxEnvelope()),
      makeTxSetMessage(new xdr.TransactionSet({ previousLedgerHash: fromHex(H1), txs: [sampleTxEnvelope()] })),
      makeScpQuorumSetMessage(sampleQset()),
      makeDontHaveMessage('scpQuorumset', H1),
      makeGetTxSetMessage(H1),
    ];
    let s = 7;
    const rand = (n: number) => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s % n;
    };
    let accepted = 0;
    for (const seed of seeds) {
      const bytes = fromBase64(seed);
      for (let i = 0; i < 300; i++) {
        // XDR is 4-byte aligned: overwrite one byte, set one word to a small
        // value (lengths, discriminants), or truncate.
        let m = bytes.slice();
        const at = rand(m.length);
        if (i % 3 === 0) m[at] = rand(256);
        else if (i % 3 === 1) m.set([0, 0, 0, rand(4)], at - (at % 4));
        else m = m.slice(0, at);
        const b64 = toBase64(m);
        const parsed = tryParseStellarMessage(b64);
        if (!parsed) continue;
        accepted++;
        // canonical XDR only: the parsed message encodes back to the input
        expect(xdr.StellarMessage.fromXdr(b64, 'base64').toXdr('base64')).toBe(b64);
      }
    }
    expect(accepted).toBeGreaterThan(200);
  });

  it('message id is sha256 of the raw bytes', () => {
    const msg = makeGetTxSetMessage(H1);
    expect(stellarMessageId(msg)).toBe(sha256Hex(fromBase64(msg)));
  });
});
