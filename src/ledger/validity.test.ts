import {
  Account,
  Asset,
  Keypair,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import { beforeEach, describe, expect, it } from 'vitest';
import { toHex, utf8 } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import { TestLedger, XLM } from './testkit';
import { accountIdFromString, int64 } from './xdrutil';

type BuilderOptions = NonNullable<ConstructorParameters<typeof TransactionBuilder>[1]>;

/** Raw payment operation (bypasses the SDK's argument checks). */
function rawPayment(dest: string, amount: bigint, source?: string): xdr.Operation {
  return new xdr.Operation({
    sourceAccount: source ? xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(source)) : null,
    body: xdr.OperationBody.payment(
      new xdr.PaymentOp({
        destination: xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(dest)),
        asset: xdr.Asset.assetTypeNative(),
        amount: int64(amount),
      }),
    ),
  });
}

function pay(dest: string, amount = '1'): xdr.Operation {
  return Operation.payment({ destination: dest, asset: Asset.native(), amount });
}

describe('checkValid', () => {
  let t: TestLedger;
  let a: Keypair;
  let b: Keypair;

  beforeEach(() => {
    t = new TestLedger();
    a = Keypair.random();
    b = Keypair.random();
    t.fund([a, b]);
  });

  it('accepts a valid transaction and reports its fields', () => {
    const tx = t.build(a, [pay(b.publicKey()), pay(b.publicKey())]);
    const r = t.lm.checkValid(tx.toEnvelope().toXdr('base64'));
    expect(r).toEqual({
      ok: true,
      hash: toHex(tx.hash()),
      sourceAccount: a.publicKey(),
      seqNum: t.seqOf(a.publicKey()) + 1n,
      fee: 200n,
      opCount: 2,
    });
  });

  it('does not change the state', () => {
    const before = t.lm.stateHash();
    t.lm.checkValid(t.tx(a, [pay(b.publicKey())]));
    t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [] }));
    expect(t.lm.stateHash()).toBe(before);
  });

  it('rejects undecodable envelopes with txMALFORMED and an empty hash', () => {
    const r = t.lm.checkValid('not-an-envelope');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('txMALFORMED');
    expect(r.hash).toBe('');
  });

  it('txMISSING_OPERATION', () => {
    expect(t.lm.checkValid(t.tx(a, [])).code).toBe('txMISSING_OPERATION');
  });

  it('txINSUFFICIENT_FEE below baseFee * opCount', () => {
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { baseFee: 99 })).code).toBe('txINSUFFICIENT_FEE');
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey()), pay(b.publicKey())], { baseFee: 75 })).code).toBe(
      'txINSUFFICIENT_FEE',
    );
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { baseFee: 1000 })).ok).toBe(true);
  });

  it('txBAD_SEQ for gaps and replays; seqNumOverride validates chains', () => {
    const cur = t.seqOf(a.publicKey());
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { seq: cur })).code).toBe('txBAD_SEQ');
    const next2 = t.tx(a, [pay(b.publicKey())], { seq: cur + 2n });
    expect(t.lm.checkValid(next2).code).toBe('txBAD_SEQ');
    expect(t.lm.checkValid(next2, { seqNumOverride: cur + 1n }).ok).toBe(true);
    expect(t.lm.checkValid(next2, { seqNumOverride: cur }).code).toBe('txBAD_SEQ');
  });

  it('txBAD_SEQ for the starting sequence number of the next ledger', () => {
    const seq = BigInt(t.ledgerSeq + 1) << 32n;
    const env = t.tx(a, [pay(b.publicKey())], { seq });
    expect(t.lm.checkValid(env, { seqNumOverride: seq - 1n }).code).toBe('txBAD_SEQ');
  });

  it('txNO_ACCOUNT for an unknown source', () => {
    const ghost = Keypair.random();
    const env = t.tx(ghost, [pay(b.publicKey())], { seq: 1n });
    const r = t.lm.checkValid(env);
    expect(r.code).toBe('txNO_ACCOUNT');
    expect(r.sourceAccount).toBe(ghost.publicKey());
  });

  it('time bounds: txTOO_EARLY and txTOO_LATE against the close time', () => {
    const now = t.lm.lastClosed().header.scpValue.closeTime;
    const early = t.tx(a, [pay(b.publicKey())], { timebounds: { minTime: now + 100, maxTime: 0 } });
    expect(t.lm.checkValid(early).code).toBe('txTOO_EARLY');
    expect(t.lm.checkValid(early, { closeTime: now + 100 }).ok).toBe(true);
    const late = t.tx(a, [pay(b.publicKey())], { timebounds: { minTime: 0, maxTime: now - 1 } });
    expect(t.lm.checkValid(late).code).toBe('txTOO_LATE');
    expect(t.lm.checkValid(late, { closeTime: now - 1 }).ok).toBe(true);
    const open = t.tx(a, [pay(b.publicKey())], { timebounds: { minTime: 0, maxTime: 0 } });
    expect(t.lm.checkValid(open, { closeTime: 4_000_000_000 }).ok).toBe(true);
  });

  it('ledger bounds: txTOO_EARLY and txTOO_LATE against LCL + 1', () => {
    const next = t.ledgerSeq + 1;
    const early = t.tx(a, [pay(b.publicKey())], { ledgerbounds: { minLedger: next + 1, maxLedger: 0 } });
    expect(t.lm.checkValid(early).code).toBe('txTOO_EARLY');
    expect(t.lm.checkValid(early, { ledgerSeq: next + 1 }).ok).toBe(true);
    const late = t.tx(a, [pay(b.publicKey())], { ledgerbounds: { minLedger: 0, maxLedger: next } });
    expect(t.lm.checkValid(late).code).toBe('txTOO_LATE');
    const ok = t.tx(a, [pay(b.publicKey())], { ledgerbounds: { minLedger: next, maxLedger: next + 1 } });
    expect(t.lm.checkValid(ok).ok).toBe(true);
  });

  it('txINSUFFICIENT_BALANCE counts reserve, liabilities and pending fees', () => {
    const poor = Keypair.random();
    // 1 XLM = exactly the 2-entry reserve: nothing left for the fee.
    t.close([t.tx(t.root, [Operation.createAccount({ destination: poor.publicKey(), startingBalance: '1' })])]);
    expect(t.lm.checkValid(t.tx(poor, [pay(b.publicKey(), '0.0000001')])).code).toBe('txINSUFFICIENT_BALANCE');
    const ok = Keypair.random();
    t.close([t.tx(t.root, [Operation.createAccount({ destination: ok.publicKey(), startingBalance: '1.0000300' })])]);
    const env = t.tx(ok, [pay(b.publicKey(), '0.0000001')]);
    expect(t.lm.checkValid(env).ok).toBe(true);
    expect(t.lm.checkValid(env, { pendingFees: 200n }).ok).toBe(true);
    expect(t.lm.checkValid(env, { pendingFees: 201n }).code).toBe('txINSUFFICIENT_BALANCE');
  });

  it('txBAD_AUTH for missing or wrong signatures, txBAD_AUTH_EXTRA for unused ones', () => {
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [] })).code).toBe('txBAD_AUTH');
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [b] })).code).toBe('txBAD_AUTH');
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [a, Keypair.random()] })).code).toBe(
      'txBAD_AUTH_EXTRA',
    );
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [a, a] })).code).toBe('txBAD_AUTH_EXTRA');
  });

  it('txNOT_SUPPORTED for v0 and fee bump envelopes and V2 preconditions', () => {
    const tx = t.build(a, [pay(b.publicKey())]);
    const v1 = xdr.expectUnionVariant(tx.toEnvelope(), 'envelopeTypeTx').v1;
    const inner = v1.tx;
    const v0 = xdr.TransactionEnvelope.envelopeTypeTxV0(
      new xdr.TransactionV0Envelope({
        tx: new xdr.TransactionV0({
          sourceAccountEd25519: StrKey.decodeEd25519PublicKey(a.publicKey()),
          fee: inner.fee,
          seqNum: inner.seqNum,
          timeBounds: null,
          memo: inner.memo,
          operations: inner.operations,
          ext: xdr.TransactionV0Ext.v0(),
        }),
        signatures: v1.signatures,
      }),
    );
    const r0 = t.lm.checkValid(v0.toXdr('base64'));
    expect(r0.code).toBe('txNOT_SUPPORTED');
    expect(r0.sourceAccount).toBe(a.publicKey());

    const fb = TransactionBuilder.buildFeeBumpTransaction(b, '200', tx, t.passphrase);
    fb.sign(b);
    const rf = t.lm.checkValid(fb.toEnvelope().toXdr('base64'));
    expect(rf.code).toBe('txNOT_SUPPORTED');
    expect(rf.hash).toBe(toHex(fb.hash()));

    const cur = t.seqOf(a.publicKey());
    const withPre = (opts: Partial<BuilderOptions>) => {
      const p = new TransactionBuilder(new Account(a.publicKey(), cur.toString()), {
        fee: '100',
        networkPassphrase: t.passphrase,
        ...opts,
      })
        .addOperation(pay(b.publicKey()))
        .setTimeout(0)
        .build();
      p.sign(a);
      return p.toEnvelope().toXdr('base64');
    };
    expect(t.lm.checkValid(withPre({ minAccountSequenceAge: 10n })).code).toBe('txNOT_SUPPORTED');
    expect(t.lm.checkValid(withPre({ minAccountSequenceLedgerGap: 1 })).code).toBe('txNOT_SUPPORTED');
    expect(t.lm.checkValid(withPre({ extraSigners: [b.publicKey()] })).code).toBe('txNOT_SUPPORTED');
  });

  it('minSeqNum relaxes the sequence check (minSeqNum <= account seq < tx seq)', () => {
    const cur = t.seqOf(a.publicKey());
    const relaxed = (seq: bigint, minSeq: bigint) => {
      const p = new TransactionBuilder(new Account(a.publicKey(), (seq - 1n).toString()), {
        fee: '100',
        networkPassphrase: t.passphrase,
        minAccountSequence: minSeq.toString(),
      })
        .addOperation(pay(b.publicKey()))
        .setTimeout(0)
        .build();
      p.sign(a);
      return p.toEnvelope().toXdr('base64');
    };
    expect(t.lm.checkValid(relaxed(cur + 5n, cur)).ok).toBe(true);
    expect(t.lm.checkValid(relaxed(cur + 5n, cur + 1n)).code).toBe('txBAD_SEQ');
    expect(t.lm.checkValid(relaxed(cur, 0n)).code).toBe('txBAD_SEQ');
    const r = t.apply(relaxed(cur + 5n, 0n));
    expect(r.successful).toBe(true);
    expect(t.seqOf(a.publicKey())).toBe(cur + 5n);
  });

  it('txMALFORMED for classic transactions with Soroban data', () => {
    const cur = t.seqOf(a.publicKey());
    const tx = new TransactionBuilder(new Account(a.publicKey(), cur.toString()), {
      fee: '100',
      networkPassphrase: t.passphrase,
    })
      .addOperation(pay(b.publicKey()))
      .setSorobanData(new SorobanDataBuilder().build())
      .setTimeout(0)
      .build();
    tx.sign(a);
    expect(t.lm.checkValid(tx.toEnvelope().toXdr('base64')).code).toBe('txMALFORMED');
  });

  it('txFAILED with the failing operation for malformed or unsupported operations', () => {
    const malformed = t.lm.checkValid(t.tx(a, [pay(b.publicKey()), rawPayment(b.publicKey(), 0n)]));
    expect(malformed.code).toBe('txFAILED');
    expect(malformed.detail).toBe('operation 1 (payment): PAYMENT_MALFORMED');
    const infl = t.lm.checkValid(t.tx(a, [Operation.inflation({})]));
    expect(infl.code).toBe('txFAILED');
    expect(infl.detail).toContain('opNOT_SUPPORTED');
    const sponsor = t.lm.checkValid(t.tx(a, [Operation.beginSponsoringFutureReserves({ sponsoredId: b.publicKey() })]));
    expect(sponsor.detail).toContain('opNOT_SUPPORTED');
  });

  it('muxed source accounts use the underlying account', () => {
    const env = t.tx(a, [pay(b.publicKey())], { muxedId: '42' });
    const r = t.lm.checkValid(env);
    expect(r.ok).toBe(true);
    expect(r.sourceAccount).toBe(a.publicKey());
    const res = t.apply(env);
    expect(res.successful).toBe(true);
    expect(res.operations[0].sourceAccount.startsWith('M')).toBe(true);
  });

  describe('multisig thresholds', () => {
    let s1: Keypair;
    let s2: Keypair;
    beforeEach(() => {
      s1 = Keypair.random();
      s2 = Keypair.random();
      const res = t.apply(
        t.tx(a, [
          Operation.setOptions({ signer: { ed25519PublicKey: s1.publicKey(), weight: 1 } }),
          Operation.setOptions({ signer: { ed25519PublicKey: s2.publicKey(), weight: 1 } }),
          Operation.setOptions({ masterWeight: 1, lowThreshold: 1, medThreshold: 2, highThreshold: 3 }),
        ]),
      );
      expect(res.resultCode).toBe('txSUCCESS');
    });

    it('MEDIUM operations need weight 2', () => {
      const one = t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [a] }));
      expect(one.code).toBe('txFAILED');
      expect(one.detail).toContain('opBAD_AUTH');
      expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [a, s1] })).ok).toBe(true);
      expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [s1, s2] })).ok).toBe(true);
      expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [a, s1, s2] })).code).toBe('txBAD_AUTH_EXTRA');
    });

    it('HIGH operations need weight 3, LOW operations weight 1', () => {
      const so = Operation.setOptions({ homeDomain: 'x.org', masterWeight: 1 });
      expect(t.lm.checkValid(t.tx(a, [so], { signers: [a, s1] })).detail).toContain('opBAD_AUTH');
      expect(t.lm.checkValid(t.tx(a, [so], { signers: [a, s1, s2] })).ok).toBe(true);
      // Without threshold or signer changes SetOptions is MEDIUM.
      expect(t.lm.checkValid(t.tx(a, [Operation.setOptions({ homeDomain: 'x.org' })], { signers: [a, s1] })).ok).toBe(
        true,
      );
      expect(t.lm.checkValid(t.tx(a, [Operation.bumpSequence({ bumpTo: '1' })], { signers: [s2] })).ok).toBe(true);
      expect(t.lm.checkValid(t.tx(a, [Operation.accountMerge({ destination: b.publicKey() })], { signers: [a, s1] })).detail).toContain(
        'opBAD_AUTH',
      );
    });

    it('a zero master weight disables the master key', () => {
      t.apply(t.tx(a, [Operation.setOptions({ masterWeight: 0 })], { signers: [a, s1, s2] }));
      expect(t.lm.getAccount(a.publicKey())!.thresholds.master).toBe(0);
      expect(t.lm.checkValid(t.tx(a, [Operation.bumpSequence({ bumpTo: '1' })], { signers: [a] })).code).toBe('txBAD_AUTH');
      expect(t.lm.checkValid(t.tx(a, [Operation.bumpSequence({ bumpTo: '1' })], { signers: [s1] })).ok).toBe(true);
    });
  });

  it('pre-auth transaction signers authorize one exact transaction and are removed after it applies', () => {
    const cur = t.seqOf(a.publicKey());
    const later = t.build(a, [pay(b.publicKey(), '3')], { seq: cur + 2n, signers: [] });
    const preAuth = StrKey.encodePreAuthTx(later.hash());
    const r1 = t.apply(t.tx(a, [Operation.setOptions({ signer: { preAuthTx: later.hash(), weight: 1 } })]));
    expect(r1.successful).toBe(true);
    expect(t.lm.getAccount(a.publicKey())!.signers).toEqual([{ key: preAuth, weight: 1 }]);
    expect(t.lm.getAccount(a.publicKey())!.numSubEntries).toBe(1);

    const env = later.toEnvelope().toXdr('base64');
    expect(t.lm.checkValid(env).ok).toBe(true);
    const other = t.tx(a, [pay(b.publicKey(), '4')], { signers: [] });
    expect(t.lm.checkValid(other).code).toBe('txBAD_AUTH');

    const before = t.balanceOf(b.publicKey());
    const r2 = t.apply(env);
    expect(r2.resultCode).toBe('txSUCCESS');
    expect(t.balanceOf(b.publicKey())).toBe(before + 3n * XLM);
    expect(t.lm.getAccount(a.publicKey())!.signers).toEqual([]);
    expect(t.lm.getAccount(a.publicKey())!.numSubEntries).toBe(0);
  });

  it('hash-x signers accept the preimage as the signature', () => {
    const preimage = utf8('open sesame');
    const hashX = StrKey.encodeSha256Hash(sha256(preimage));
    t.apply(t.tx(a, [Operation.setOptions({ signer: { sha256Hash: sha256(preimage), weight: 1 } })]));
    expect(t.lm.getAccount(a.publicKey())!.signers[0].key).toBe(hashX);
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [], hashX: [preimage] })).ok).toBe(true);
    expect(t.lm.checkValid(t.tx(a, [pay(b.publicKey())], { signers: [], hashX: [utf8('wrong')] })).code).toBe(
      'txBAD_AUTH',
    );
    const r = t.apply(t.tx(a, [pay(b.publicKey())], { signers: [], hashX: [preimage] }));
    expect(r.successful).toBe(true);
  });

  it('an operation source that does not exist yet must sign for itself', () => {
    const x = Keypair.random();
    const ops = [
      Operation.createAccount({ destination: x.publicKey(), startingBalance: '10' }),
      Operation.payment({ destination: a.publicKey(), asset: Asset.native(), amount: '1', source: x.publicKey() }),
    ];
    expect(t.lm.checkValid(t.tx(a, ops, { signers: [a, x] })).ok).toBe(true);
    const unsigned = t.lm.checkValid(t.tx(a, ops, { signers: [a] }));
    expect(unsigned.code).toBe('txFAILED');
    expect(unsigned.detail).toBe('operation 1 (payment): opBAD_AUTH');
    const r = t.apply(t.tx(a, ops, { signers: [a, x] }));
    expect(r.resultCode).toBe('txSUCCESS');
    expect(t.balanceOf(x.publicKey())).toBe(9n * XLM);
  });

  it('accountIdFromString round trips', () => {
    const id = accountIdFromString(a.publicKey());
    expect(StrKey.encodeEd25519PublicKey(id.ed25519.toBytes())).toBe(a.publicKey());
  });
});
