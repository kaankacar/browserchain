// Crossing cost must not grow with the size of the order book: every
// operation that crosses used to read and sort the whole book of its pair,
// so a large book (tens of thousands of offers) made each ledger close slow
// on every node.

import { Keypair, Operation, Asset as SdkAsset } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../lib/hash';
import { genesisEntries } from '../genesis';
import { LedgerTxn } from '../state';
import { TEST_PASSPHRASE, TestLedger, XLM, customLedger, newAccountEntry } from '../testkit';
import type { AccountEntry, CreditAsset, LedgerEntry, OfferEntry, TrustLineEntry } from '../types';
import { checkDexInvariants, decodeOutcome } from './testkit';

const MAX = 9_223_372_036_854_775_807n;

/** A ledger whose USD/XLM book (selling USD) holds `n` offers of 100 USD at prices 1..50. */
function bigBook(n: number) {
  const issuer = Keypair.fromRawEd25519Seed(sha256('book-issuer'));
  const taker = Keypair.fromRawEd25519Seed(sha256('book-taker'));
  const usd: CreditAsset = { type: 'credit_alphanum4', code: 'USD', issuer: issuer.publicKey() };
  const entries: LedgerEntry[] = [...genesisEntries(TEST_PASSPHRASE)];
  entries.push(newAccountEntry(issuer.publicKey(), 1000n * XLM, 1n << 32n, 1));
  const takerAcc = newAccountEntry(taker.publicKey(), 1_000_000n * XLM, 1n << 32n, 1);
  takerAcc.numSubEntries = 1;
  entries.push(takerAcc, trustLine(taker.publicKey(), usd, 0n));
  let id = 0n;
  for (let m = 0; m * 1000 < n; m++) {
    const seller = Keypair.fromRawEd25519Seed(sha256(`book-maker-${m}`)).publicKey();
    const count = Math.min(1000, n - m * 1000);
    const acc: AccountEntry = newAccountEntry(seller, 30_000n * XLM, 1n << 32n, 1);
    acc.numSubEntries = count + 1;
    const tl = trustLine(seller, usd, BigInt(count) * 100n * XLM);
    for (let i = 0; i < count; i++) {
      id++;
      const price = { n: 1 + (i % 50), d: 1 };
      const o: OfferEntry = { kind: 'offer', sellerId: seller, offerId: id, selling: usd, buying: { type: 'native' }, amount: 100n * XLM, price, flags: 0, lastModifiedLedgerSeq: 1 };
      entries.push(o);
      tl.sellingLiabilities += 100n * XLM;
      acc.buyingLiabilities += 100n * XLM * BigInt(price.n);
    }
    entries.push(acc, tl);
  }
  const t = new TestLedger(customLedger(entries, TEST_PASSPHRASE, (h) => (h.idPool = id)));
  return { t, taker, usd: new SdkAsset('USD', issuer.publicKey()) };
}

function trustLine(accountId: string, asset: CreditAsset, balance: bigint): TrustLineEntry {
  return { kind: 'trustline', accountId, asset, balance, limit: MAX, flags: 1, buyingLiabilities: 0n, sellingLiabilities: 0n, lastModifiedLedgerSeq: 1 };
}

/**
 * A ledger with `makers` x 1000 offers that sell 1 USD for 1 XLM, and two
 * takers ("heavy" and "light") that hold USD trust lines and much XLM.
 */
function flatBook(makers: number) {
  const issuer = Keypair.fromRawEd25519Seed(sha256('flat-issuer'));
  const heavy = Keypair.fromRawEd25519Seed(sha256('flat-heavy'));
  const light = Keypair.fromRawEd25519Seed(sha256('flat-light'));
  const usd: CreditAsset = { type: 'credit_alphanum4', code: 'USD', issuer: issuer.publicKey() };
  const entries: LedgerEntry[] = [...genesisEntries(TEST_PASSPHRASE)];
  entries.push(newAccountEntry(issuer.publicKey(), 1000n * XLM, 1n << 32n, 1));
  for (const k of [heavy, light]) {
    const acc = newAccountEntry(k.publicKey(), 1_000_000n * XLM, 1n << 32n, 1);
    acc.numSubEntries = 1;
    entries.push(acc, trustLine(k.publicKey(), usd, 0n));
  }
  let id = 0n;
  for (let m = 0; m < makers; m++) {
    const seller = Keypair.fromRawEd25519Seed(sha256(`flat-maker-${m}`)).publicKey();
    const acc: AccountEntry = newAccountEntry(seller, 3000n * XLM, 1n << 32n, 1);
    acc.numSubEntries = 1001;
    const tl = trustLine(seller, usd, 1000n * XLM);
    for (let i = 0; i < 1000; i++) {
      id++;
      entries.push({ kind: 'offer', sellerId: seller, offerId: id, selling: usd, buying: { type: 'native' }, amount: XLM, price: { n: 1, d: 1 }, flags: 0, lastModifiedLedgerSeq: 1 });
      tl.sellingLiabilities += XLM;
      acc.buyingLiabilities += XLM;
    }
    entries.push(acc, tl);
  }
  const t = new TestLedger(customLedger(entries, TEST_PASSPHRASE, (h) => (h.idPool = id)));
  return { t, heavy, light, usd: new SdkAsset('USD', issuer.publicKey()) };
}

describe('order book scale', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads a bounded number of entries per crossing, whatever the book size', () => {
    const { t, taker, usd } = bigBook(20_000);
    expect(checkDexInvariants(t.lm.allEntries(), t.lm.lastClosed().header.baseReserve)).toEqual([]);
    const ops = Array.from({ length: 20 }, () =>
      Operation.pathPaymentStrictReceive({ sendAsset: SdkAsset.native(), sendMax: '1000', destination: taker.publicKey(), destAsset: usd, destAmount: '0.0000010', path: [] }),
    );
    const env = t.tx(taker, ops);
    const lookup = vi.spyOn(LedgerTxn.prototype, 'lookup');
    const r = t.apply(env);
    expect(r.resultCode).toBe('txSUCCESS');
    // 20 crossings of the best offers (ids 1, 51, 101, ... sell at price 1).
    expect(decodeOutcome(r, 0).claimed.map((c) => c.offerId)).toEqual([1n]);
    expect(decodeOutcome(r, 19).claimed.map((c) => c.offerId)).toEqual([1n]);
    // The whole book is 20,000 offers; each operation may read only a few.
    expect(lookup.mock.calls.length).toBeLessThan(5_000);
    lookup.mockRestore();
    expect(checkDexInvariants(t.lm.allEntries(), t.lm.lastClosed().header.baseReserve)).toEqual([]);
  });

  it('a crossing costs the same after earlier transactions of the ledger took many offers', () => {
    // The heavy transaction takes 9,990 offers. The light transactions cross
    // one offer per operation; the second one always applies after the heavy
    // one. Each of their crossings used to read every offer changed earlier
    // in the ledger, so the close time grew with the square of the work.
    const run = (withHeavy: boolean, withLight: boolean) => {
      const { t, heavy, light, usd } = flatBook(10);
      const take = (k: Keypair, amount: string) =>
        Operation.pathPaymentStrictReceive({ sendAsset: SdkAsset.native(), sendMax: '1000000', destination: k.publicKey(), destAsset: usd, destAmount: amount, path: [] });
      const envs: string[] = [];
      if (withHeavy) envs.push(t.tx(heavy, Array.from({ length: 10 }, () => take(heavy, '999'))));
      if (withLight) {
        const seq = t.seqOf(light.publicKey());
        for (let j = 1n; j <= 2n; j++) envs.push(t.tx(light, Array.from({ length: 100 }, () => take(light, '0.0000001')), { seq: seq + j }));
      }
      const lookup = vi.spyOn(LedgerTxn.prototype, 'lookup');
      const r = t.close(envs);
      const calls = lookup.mock.calls.length;
      lookup.mockRestore();
      expect(r.results.map((x) => x.resultCode)).toEqual(envs.map(() => 'txSUCCESS'));
      expect(checkDexInvariants(t.lm.allEntries(), t.lm.lastClosed().header.baseReserve)).toEqual([]);
      return calls;
    };
    const both = run(true, true);
    const heavyOnly = run(true, false);
    const lightOnly = run(false, true);
    // Re-reading the taken offers costs about 10,000 lookups per light operation.
    expect(both - heavyOnly).toBeLessThan(2 * lightOnly + 20_000);
  });
});
