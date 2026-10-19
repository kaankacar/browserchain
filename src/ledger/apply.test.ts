import { Asset, Keypair, Operation, StrKey, xdr } from '@stellar/stellar-sdk/base';
import { beforeEach, describe, expect, it } from 'vitest';
import { fromBase64, toHex } from '../lib/bytes';
import { TOTAL_COINS } from '../lib/constants';
import { sha256Hex } from '../lib/hash';
import { accountKey, dataKey } from './keys';
import { TestLedger, XLM, customLedger, newAccountEntry, opResultTr } from './testkit';
import { makeSignedStellarValue } from './value';

function opCodes(r: { operations: { resultCode: string }[] }): string[] {
  return r.operations.map((o) => o.resultCode);
}

const native = Asset.native();

describe('closeLedger', () => {
  let t: TestLedger;
  let a: Keypair;
  let b: Keypair;

  beforeEach(() => {
    t = new TestLedger();
    a = Keypair.random();
    b = Keypair.random();
    t.fund([a, b], 100n * XLM);
  });

  it('produces the next header', () => {
    const prev = t.lm.lastClosed();
    const env = t.tx(a, [Operation.payment({ destination: b.publicKey(), asset: native, amount: '1' })]);
    const r = t.close([env]);
    expect(r.header.ledgerSeq).toBe(prev.header.ledgerSeq + 1);
    expect(r.header.previousLedgerHash).toBe(prev.hash);
    expect(r.header.scpValue.closeTime).toBe(t.closeTime);
    expect(r.header.scpValue.txSetHash).toBe(r.txSet.hash);
    expect(r.header.scpValue.signature!.nodeId).toBe(t.node.publicKey());
    expect(r.header.bucketListHash).toBe(t.lm.stateHash());
    expect(r.header.totalCoins).toBe(TOTAL_COINS);
    expect(r.header.feePool).toBe(prev.header.feePool + 100n);
    expect(r.header.txSetResultHash).toBe(sha256Hex(fromBase64(r.resultSetXdr)));
    expect(r.hash).toBe(t.lm.lastClosed().hash);
    expect(r.headerXdr).toBe(t.lm.lastClosed().headerXdr);
    expect(r.changedKeys).toEqual([accountKey(a.publicKey()), accountKey(b.publicKey())].sort());
    expect(t.lm.getAccount(b.publicKey())!.lastModifiedLedgerSeq).toBe(r.header.ledgerSeq);
  });

  it('closes empty ledgers', () => {
    const r = t.close([]);
    expect(r.results).toEqual([]);
    expect(r.changedKeys).toEqual([]);
    const set = xdr.TransactionResultSet.fromXdr(r.resultSetXdr, 'base64');
    expect(set.results).toHaveLength(0);
  });

  it('result set pairs carry the transaction hash and a real TransactionResult', () => {
    const tx = t.build(a, [Operation.payment({ destination: b.publicKey(), asset: native, amount: '1' })]);
    const r = t.close([tx.toEnvelope().toXdr('base64')]);
    const set = xdr.TransactionResultSet.fromXdr(r.resultSetXdr, 'base64');
    expect(toHex(set.results[0].transactionHash.toBytes())).toBe(toHex(tx.hash()));
    const res = xdr.TransactionResult.fromXdr(r.results[0].resultXdr, 'base64');
    expect(res.feeCharged.toString()).toBe('100');
    expect(res.result.type).toBe('txSuccess');
    expect(xdr.expectUnionVariant(opResultTr(r.results[0].resultXdr), 'payment').paymentResult.type).toBe('paymentSuccess');
    expect(r.results[0]).toMatchObject({
      hash: toHex(tx.hash()),
      applyIndex: 0,
      sourceAccount: a.publicKey(),
      feeCharged: 100n,
      maxFee: 100n,
      successful: true,
      resultCode: 'txSUCCESS',
      memo: { type: 'none', value: null },
    });
    expect(r.results[0].accounts).toEqual([a.publicKey(), b.publicKey()]);
  });

  it('reports deleted keys and leaves untouched entries alone', () => {
    t.apply(t.tx(a, [Operation.manageData({ name: 'gone', value: 'x' })]));
    const created = t.ledgerSeq;
    const r = t.close([t.tx(a, [Operation.manageData({ name: 'gone', value: null })])]);
    expect(r.changedKeys).toEqual([accountKey(a.publicKey()), dataKey(a.publicKey(), 'gone')].sort());
    expect(t.lm.getAccount(b.publicKey())!.lastModifiedLedgerSeq).toBeLessThan(created);
  });

  describe('reserves', () => {
    it('count sub-entries and sponsored claimable balances in the minimum balance', () => {
      const usd = new Asset('USD', b.publicKey());
      const r = t.apply(
        t.tx(a, [
          Operation.changeTrust({ asset: usd }),
          Operation.manageData({ name: 'd', value: 'v' }),
          Operation.setOptions({ signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 1 } }),
        ]),
      );
      expect(r.successful).toBe(true);
      let acc = t.lm.getAccount(a.publicKey())!;
      expect(acc.numSubEntries).toBe(3);
      expect(t.lm.minBalance(acc)).toBe(5n * 5_000_000n);
      // Spendable: balance - 2.5 XLM.
      const spendable = acc.balance - 100n - 25_000_000n;
      const tooMuch = (spendable + 1n).toString();
      const fmt = (v: string) => `${v.slice(0, -7) || '0'}.${v.slice(-7).padStart(7, '0')}`;
      expect(opCodes(t.apply(t.tx(a, [Operation.payment({ destination: b.publicKey(), asset: native, amount: fmt(tooMuch) })])))).toEqual([
        'PAYMENT_UNDERFUNDED',
      ]);
      acc = t.lm.getAccount(a.publicKey())!;
      const exact = (acc.balance - 100n - 25_000_000n).toString();
      expect(opCodes(t.apply(t.tx(a, [Operation.payment({ destination: b.publicKey(), asset: native, amount: fmt(exact) })])))).toEqual([
        'PAYMENT_SUCCESS',
      ]);
      expect(t.lm.getAccount(a.publicKey())!.balance).toBe(25_000_000n);
    });
  });

  it('an existing operation source must sign at its threshold', () => {
    const r = t.lm.checkValid(
      t.tx(a, [Operation.payment({ destination: a.publicKey(), asset: native, amount: '1', source: b.publicKey() })]),
    );
    expect(r.code).toBe('txFAILED');
    expect(r.detail).toBe('operation 0 (payment): opBAD_AUTH');
    const ok = t.apply(
      t.tx(a, [Operation.payment({ destination: a.publicKey(), asset: native, amount: '1', source: b.publicKey() })], {
        signers: [a, b],
      }),
    );
    expect(ok.successful).toBe(true);
    expect(ok.operations[0].sourceAccount).toBe(b.publicKey());
  });

  describe('fees', () => {
    it('charges baseFee * opCount even for higher bids, and charges failed transactions', () => {
      const ok = t.apply(t.tx(a, [Operation.bumpSequence({ bumpTo: '0' }), Operation.bumpSequence({ bumpTo: '0' })], { baseFee: 1000 }));
      expect(ok.feeCharged).toBe(200n);
      expect(ok.maxFee).toBe(2000n);
      const pool = t.lm.lastClosed().header.feePool;
      const failed = t.apply(t.tx(a, [Operation.payment({ destination: Keypair.random().publicKey(), asset: native, amount: '1' })]));
      expect(failed.resultCode).toBe('txFAILED');
      expect(failed.feeCharged).toBe(100n);
      expect(t.lm.lastClosed().header.feePool).toBe(pool + 100n);
      const total = t.lm.allEntries().reduce((s, e) => s + (e.kind === 'account' ? e.balance : 0n), 0n);
      expect(total + t.lm.lastClosed().header.feePool).toBe(TOTAL_COINS);
    });

    it('the fee phase may drain below the reserve; apply then reports txINSUFFICIENT_BALANCE', () => {
      const x = Keypair.random();
      t.close([t.tx(t.root, [Operation.createAccount({ destination: x.publicKey(), startingBalance: '1.0000150' })])]);
      const seq = t.seqOf(x.publicKey());
      const e1 = t.tx(x, [Operation.bumpSequence({ bumpTo: '0' })], { seq: seq + 1n });
      const e2 = t.tx(x, [Operation.bumpSequence({ bumpTo: '0' })], { seq: seq + 2n });
      expect(t.lm.checkTxSetValid(t.lm.makeTxSet(t.lm.lastClosed().hash, [e1, e2]), t.closeTime + 5).valid).toBe(false);
      const r = t.close([e1, e2]);
      expect(r.results.map((x) => x.resultCode)).toEqual(['txINSUFFICIENT_BALANCE', 'txINSUFFICIENT_BALANCE']);
      expect(r.results.map((x) => x.feeCharged)).toEqual([100n, 100n]);
      expect(t.balanceOf(x.publicKey())).toBe(XLM - 50n);
      expect(t.seqOf(x.publicKey())).toBe(seq + 2n);
    });

    it('charges at most the balance', () => {
      const x = Keypair.random();
      const c = new TestLedger(customLedger([newAccountEntry(x.publicKey(), 50n, 1n, 1)]));
      const r = c.close([c.tx(x, [Operation.bumpSequence({ bumpTo: '0' }), Operation.bumpSequence({ bumpTo: '0' })])]);
      expect(r.results[0].feeCharged).toBe(50n);
      expect(r.results[0].resultCode).toBe('txINSUFFICIENT_BALANCE');
      expect(c.balanceOf(x.publicKey())).toBe(0n);
      expect(r.header.feePool).toBe(50n);
    });
  });

  describe('sequence numbers', () => {
    it('are consumed by failed transactions but not by bad-sequence ones', () => {
      const seq = t.seqOf(a.publicKey());
      const failed = t.apply(t.tx(a, [Operation.payment({ destination: Keypair.random().publicKey(), asset: native, amount: '1' })]));
      expect(failed.resultCode).toBe('txFAILED');
      expect(t.seqOf(a.publicKey())).toBe(seq + 1n);
      const bad = t.apply(t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { seq: seq + 5n }));
      expect(bad.resultCode).toBe('txBAD_SEQ');
      expect(bad.feeCharged).toBe(100n);
      expect(t.seqOf(a.publicKey())).toBe(seq + 1n);
      expect(t.lm.getAccount(a.publicKey())!.seqLedger).toBe(t.ledgerSeq - 1);
    });

    it('applies chains of one account in sequence order within a ledger', () => {
      const seq = t.seqOf(a.publicKey());
      const envs = [3n, 1n, 2n].map((k) =>
        t.tx(a, [Operation.manageData({ name: `k${k}`, value: 'v' })], { seq: seq + k }),
      );
      const r = t.close(envs);
      expect(r.results.every((x) => x.successful)).toBe(true);
      expect(t.seqOf(a.publicKey())).toBe(seq + 3n);
      expect(t.lm.getDataEntries(a.publicKey()).map((d) => d.name)).toEqual(['k1', 'k2', 'k3']);
    });
  });

  describe('atomicity', () => {
    it('applies all operations, then rolls everything back if one failed', () => {
      const ghost = Keypair.random().publicKey();
      const bBefore = t.balanceOf(b.publicKey());
      const r = t.apply(
        t.tx(a, [
          Operation.payment({ destination: b.publicKey(), asset: native, amount: '10' }),
          Operation.payment({ destination: ghost, asset: native, amount: '1' }),
          Operation.manageData({ name: 'n', value: 'v' }),
        ]),
      );
      expect(r.resultCode).toBe('txFAILED');
      expect(opCodes(r)).toEqual(['PAYMENT_SUCCESS', 'PAYMENT_NO_DESTINATION', 'MANAGE_DATA_SUCCESS']);
      expect(t.balanceOf(b.publicKey())).toBe(bBefore);
      expect(t.lm.getEntry(dataKey(a.publicKey(), 'n'))).toBeUndefined();
      expect(t.balanceOf(a.publicKey())).toBe(100n * XLM - 300n);
    });

    it('later operations see earlier successful ones but not failed ones', () => {
      const x = Keypair.random().publicKey();
      const r = t.apply(
        t.tx(a, [
          Operation.createAccount({ destination: x, startingBalance: '0.5' }),
          Operation.payment({ destination: x, asset: native, amount: '1' }),
          Operation.createAccount({ destination: x, startingBalance: '2' }),
          Operation.payment({ destination: x, asset: native, amount: '1' }),
        ]),
      );
      expect(opCodes(r)).toEqual([
        'CREATE_ACCOUNT_LOW_RESERVE',
        'PAYMENT_NO_DESTINATION',
        'CREATE_ACCOUNT_SUCCESS',
        'PAYMENT_SUCCESS',
      ]);
      expect(t.lm.getAccount(x)).toBeUndefined();
    });

    it('DEX operations go to the DEX module', () => {
      // Without a USD trustline the offer cannot succeed: the stub answers
      // opNOT_SUPPORTED, the real DEX a MANAGE_SELL_OFFER_* failure.
      const env = t.rawTx(a, [
        Operation.manageSellOffer({
          selling: native,
          buying: new Asset('USD', b.publicKey()),
          amount: '1',
          price: '1',
        }),
      ]);
      const r = t.apply(env);
      expect(r.resultCode).toBe('txFAILED');
      expect(opCodes(r)[0]).toMatch(/^(opNOT_SUPPORTED|MANAGE_SELL_OFFER_\w+)$/);
      expect(r.feeCharged).toBe(100n);
    });
  });

  describe('signatures at apply time', () => {
    it('re-checks operation signatures against the current state (opBAD_AUTH -> txFAILED)', () => {
      const s = Keypair.random();
      t.apply(t.tx(b, [Operation.setOptions({ signer: { ed25519PublicKey: s.publicKey(), weight: 1 } })]));
      const seq = t.seqOf(a.publicKey());
      const remove = t.tx(
        a,
        [Operation.setOptions({ signer: { ed25519PublicKey: s.publicKey(), weight: 0 }, source: b.publicKey() })],
        { seq: seq + 1n, signers: [a, b] },
      );
      const use = t.tx(a, [Operation.manageData({ name: 'x', value: 'y', source: b.publicKey() })], {
        seq: seq + 2n,
        signers: [a, s],
      });
      const set = t.lm.makeTxSet(t.lm.lastClosed().hash, [remove, use]);
      expect(t.lm.checkTxSetValid(set, t.closeTime + 5).valid).toBe(true);
      const r = t.close([remove, use]);
      expect(r.results.map((x) => x.resultCode)).toEqual(['txSUCCESS', 'txFAILED']);
      expect(opCodes(r.results[1])).toEqual(['opBAD_AUTH']);
      expect(t.seqOf(a.publicKey())).toBe(seq + 2n);
      expect(t.lm.getEntry(dataKey(b.publicKey(), 'x'))).toBeUndefined();
    });

    it('re-checks the source signature (txBAD_AUTH) and still consumes the sequence number', () => {
      const s = Keypair.random();
      t.apply(t.tx(a, [Operation.setOptions({ signer: { ed25519PublicKey: s.publicKey(), weight: 1 } })]));
      const seq = t.seqOf(a.publicKey());
      const remove = t.tx(a, [Operation.setOptions({ signer: { ed25519PublicKey: s.publicKey(), weight: 0 } })], { seq: seq + 1n });
      const use = t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { seq: seq + 2n, signers: [s] });
      const r = t.close([remove, use]);
      expect(r.results.map((x) => x.resultCode)).toEqual(['txSUCCESS', 'txBAD_AUTH']);
      expect(r.results[1].operations[0].resultCode).toBe('txBAD_AUTH');
      expect(t.seqOf(a.publicKey())).toBe(seq + 2n);
    });

    it('removes a pre-auth signer even when its transaction fails', () => {
      const cur = t.seqOf(a.publicKey());
      const later = t.build(a, [Operation.payment({ destination: Keypair.random().publicKey(), asset: native, amount: '1' })], {
        seq: cur + 2n,
        signers: [],
      });
      t.apply(t.tx(a, [Operation.setOptions({ signer: { preAuthTx: later.hash(), weight: 1 } })]));
      expect(t.lm.getAccount(a.publicKey())!.signers).toHaveLength(1);
      const r = t.apply(later.toEnvelope().toXdr('base64'));
      expect(r.resultCode).toBe('txFAILED');
      expect(t.lm.getAccount(a.publicKey())!.signers).toEqual([]);
      expect(t.lm.getAccount(a.publicKey())!.numSubEntries).toBe(0);
      expect(StrKey.isValidEd25519PublicKey(a.publicKey())).toBe(true);
    });
  });

  describe('errors', () => {
    it('rejects mismatched tx sets and values without changing state', () => {
      const lcl = t.lm.lastClosed();
      const hash = t.lm.stateHash();
      const set = t.lm.makeTxSet(lcl.hash, []);
      const value = makeSignedStellarValue(t.lm.networkId, t.node, set.hash, t.closeTime + 5);
      expect(() => t.lm.closeLedger(t.lm.makeTxSet('00'.repeat(32), []), value)).toThrow();
      expect(() => t.lm.closeLedger(set, { ...value, txSetHash: 'ff'.repeat(32) })).toThrow();
      expect(() => t.lm.closeLedger(set, { ...value, upgrades: ['00'] })).toThrow();
      expect(() => t.lm.closeLedger({ ...set, hash: 'ee'.repeat(32) }, { ...value, txSetHash: 'ee'.repeat(32) })).toThrow();
      expect(t.lm.lastClosed().hash).toBe(lcl.hash);
      expect(t.lm.stateHash()).toBe(hash);
      expect(t.lm.closeLedger(set, value).header.ledgerSeq).toBe(lcl.header.ledgerSeq + 1);
    });
  });
});
