// Determinism and invariants of the DEX under random traffic: two managers
// that apply the same transaction sets must produce identical ledgers, and
// every ledger must keep liabilities, sub-entries and asset supply consistent.

import { Asset as SdkAsset, Keypair, Operation, type xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { TOTAL_COINS } from '../../lib/constants';
import { sha256 } from '../../lib/hash';
import { pick, randInt, seededRng, type Rng } from '../../lib/random';
import { loadLedgerFromSnapshot } from '../manager';
import { TestLedger, stroopsToString } from '../testkit';
import type { Asset, LedgerEntry, OfferEntry, TrustLineEntry } from '../types';
import { checkDexInvariants, decodeOutcome } from './testkit';

const amt = stroopsToString;
const key = (label: string): Keypair => Keypair.fromRawEd25519Seed(sha256(`dex-determinism|${label}`));

interface SimAsset {
  sdk: SdkAsset;
  asset: Asset;
}

function simAsset(code: string, issuer: Keypair): SimAsset {
  return { sdk: new SdkAsset(code, issuer.publicKey()), asset: { type: 'credit_alphanum4', code, issuer: issuer.publicKey() } };
}

const NATIVE: SimAsset = { sdk: SdkAsset.native(), asset: { type: 'native' } };

/** Two ledgers that always close identical tx sets with identical values. */
class Twin {
  readonly a = new TestLedger();
  readonly b = new TestLedger();
  constructor() {
    this.b.node = this.a.node;
    this.b.closeTime = this.a.closeTime;
  }
  close(envs: string[]) {
    const ra = this.a.close(envs);
    const rb = this.b.close(envs);
    expect(rb.hash).toBe(ra.hash);
    expect(rb.resultSetXdr).toBe(ra.resultSetXdr);
    return ra;
  }
}

function supply(entries: LedgerEntry[], a: Asset): bigint {
  if (a.type === 'native') {
    return entries.reduce((s, e) => (e.kind === 'account' ? s + e.balance : s), 0n);
  }
  return entries.reduce((s, e) => {
    if (e.kind !== 'trustline') return s;
    const t = e as TrustLineEntry;
    return t.asset.code === a.code && t.asset.issuer === a.issuer ? s + t.balance : s;
  }, 0n);
}

/** One random DEX operation for `trader` against the current state. */
function randomOp(rng: Rng, t: TestLedger, trader: Keypair, traders: Keypair[], assets: SimAsset[]): xdr.Operation {
  const [selling, buying] = (() => {
    const s = pick(rng, assets);
    let b = pick(rng, assets);
    while (b === s) b = pick(rng, assets);
    return [s, b];
  })();
  const price = { n: randInt(rng, 1, 40), d: randInt(rng, 1, 40) };
  const amount = BigInt(randInt(rng, 1, 3_000));
  const other = pick(rng, traders.filter((k) => k !== trader));
  const mine = t.lm.getOffersByAccount(trader.publicKey());
  const roll = rng();
  if (roll < 0.3) {
    return Operation.manageSellOffer({ selling: selling.sdk, buying: buying.sdk, amount: amt(amount), price });
  }
  if (roll < 0.42) {
    return Operation.manageBuyOffer({ selling: selling.sdk, buying: buying.sdk, buyAmount: amt(amount), price });
  }
  if (roll < 0.5) {
    return Operation.createPassiveSellOffer({ selling: selling.sdk, buying: buying.sdk, amount: amt(amount), price });
  }
  if (roll < 0.62 && mine.length > 0) {
    // Update or delete one of our offers (sometimes with other assets).
    const o: OfferEntry = pick(rng, mine);
    const sameAssets = rng() < 0.7;
    const s = sameAssets ? assets.find((x) => x.asset.type === o.selling.type && (x.asset.type === 'native' || (o.selling.type !== 'native' && x.asset.code === o.selling.code)))! : selling;
    const b = sameAssets ? assets.find((x) => x.asset.type === o.buying.type && (x.asset.type === 'native' || (o.buying.type !== 'native' && x.asset.code === o.buying.code)))! : buying;
    const newAmount = rng() < 0.3 ? 0n : amount;
    return Operation.manageSellOffer({ selling: s.sdk, buying: b.sdk, amount: amt(newAmount), price, offerId: o.offerId.toString() });
  }
  const third = assets.find((x) => x !== selling && x !== buying)!;
  const path = rng() < 0.5 ? [third.sdk] : [];
  if (roll < 0.82) {
    return Operation.pathPaymentStrictSend({
      sendAsset: selling.sdk,
      sendAmount: amt(amount),
      destination: other.publicKey(),
      destAsset: buying.sdk,
      destMin: amt(BigInt(randInt(rng, 1, 50))),
      path,
    });
  }
  return Operation.pathPaymentStrictReceive({
    sendAsset: selling.sdk,
    sendMax: amt(amount * 4n),
    destination: other.publicKey(),
    destAsset: buying.sdk,
    destAmount: amt(BigInt(randInt(rng, 1, 1_000))),
    path,
  });
}

describe('DEX determinism', () => {
  it('two managers stay identical and consistent under random DEX traffic', () => {
    const rng = seededRng(20261015);
    const twin = new Twin();
    const t = twin.a;
    const issuers = [key('issuer-a'), key('issuer-b')];
    const traders = Array.from({ length: 8 }, (_, i) => key(`trader-${i}`));
    const AAA = simAsset('AAA', issuers[0]);
    const BBB = simAsset('BBB', issuers[1]);
    const assets = [NATIVE, AAA, BBB];

    // Setup: accounts, trust lines and initial balances.
    twin.close([
      t.tx(
        t.root,
        [...issuers, ...traders].map((k) => Operation.createAccount({ destination: k.publicKey(), startingBalance: '1000' })),
      ),
    ]);
    twin.close(traders.map((k) => t.tx(k, [Operation.changeTrust({ asset: AAA.sdk }), Operation.changeTrust({ asset: BBB.sdk })])));
    twin.close([
      t.tx(issuers[0], traders.map((k) => Operation.payment({ destination: k.publicKey(), asset: AAA.sdk, amount: amt(100_000n) }))),
      t.tx(issuers[1], traders.map((k) => Operation.payment({ destination: k.publicKey(), asset: BBB.sdk, amount: amt(100_000n) }))),
    ]);
    const issued = 100_000n * BigInt(traders.length);

    const codes = new Map<string, number>();
    let crossed = 0;
    for (let ledger = 0; ledger < 60; ledger++) {
      const envs: string[] = [];
      for (const trader of traders) {
        if (rng() < 0.25) continue;
        const ops = Array.from({ length: randInt(rng, 1, 3) }, () => randomOp(rng, t, trader, traders, assets));
        envs.push(t.tx(trader, ops));
      }
      const r = twin.close(envs);
      for (const res of r.results) {
        for (let i = 0; i < res.operations.length; i++) {
          const code = res.operations[i].resultCode;
          codes.set(code, (codes.get(code) ?? 0) + 1);
          if (res.successful) crossed += decodeOutcome(res, i).claimed.length;
        }
      }
      const entries = t.lm.allEntries();
      expect(checkDexInvariants(entries, t.lm.lastClosed().header.baseReserve)).toEqual([]);
      expect(supply(entries, AAA.asset)).toBe(issued);
      expect(supply(entries, BBB.asset)).toBe(issued);
      expect(supply(entries, NATIVE.asset) + t.lm.lastClosed().header.feePool).toBe(TOTAL_COINS);
    }

    // The traffic exercised the DEX: offers were made, crossed and failed in many ways.
    expect(crossed).toBeGreaterThan(200);
    expect(codes.get('MANAGE_SELL_OFFER_SUCCESS') ?? 0).toBeGreaterThan(100);
    expect(codes.get('MANAGE_BUY_OFFER_SUCCESS') ?? 0).toBeGreaterThan(30);
    expect(codes.get('PATH_PAYMENT_STRICT_SEND_SUCCESS') ?? 0).toBeGreaterThan(30);
    expect(codes.get('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS') ?? 0).toBeGreaterThan(20);
    expect([...codes.keys()].filter((c) => !c.endsWith('_SUCCESS')).length).toBeGreaterThan(5);
    expect(t.lm.lastClosed().header.idPool).toBeGreaterThan(100n);
    expect(twin.b.lm.stateHash()).toBe(t.lm.stateHash());

    // A node that loads a snapshot continues identically.
    const restored = new TestLedger(loadLedgerFromSnapshot(JSON.parse(JSON.stringify(t.lm.snapshot(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))));
    restored.node = t.node;
    restored.closeTime = t.closeTime;
    for (const [s, b] of [
      [AAA, BBB],
      [BBB, NATIVE],
      [NATIVE, AAA],
    ]) {
      expect(restored.lm.getOrderBook(s.asset, b.asset)).toEqual(t.lm.getOrderBook(s.asset, b.asset));
    }
    const envs = traders.slice(0, 4).map((k) => t.tx(k, [randomOp(rng, t, k, traders, assets)]));
    const r1 = t.close(envs);
    const r2 = restored.close(envs);
    expect(r2.hash).toBe(r1.hash);
  });

  it('gives identical results for the same book regardless of offer creation batching', () => {
    // Offers created one per ledger or all in one transaction get the same ids
    // and cross the same way.
    const build = (batched: boolean) => {
      const t = new TestLedger();
      t.node = key('node');
      const issuer = key('batch-issuer');
      const [maker, taker] = [key('batch-maker'), key('batch-taker')];
      const USD = simAsset('USD', issuer);
      t.close([t.tx(t.root, [issuer, maker, taker].map((k) => Operation.createAccount({ destination: k.publicKey(), startingBalance: '1000' })))]);
      t.close([maker, taker].map((k) => t.tx(k, [Operation.changeTrust({ asset: USD.sdk })])));
      t.close([t.tx(issuer, [Operation.payment({ destination: taker.publicKey(), asset: USD.sdk, amount: '1000' })])]);
      const offers = [
        { n: 3, d: 2 },
        { n: 1, d: 1 },
        { n: 2, d: 3 },
        { n: 1, d: 1 },
      ].map((price) => Operation.manageSellOffer({ selling: NATIVE.sdk, buying: USD.sdk, amount: '10', price }));
      if (batched) t.close([t.tx(maker, offers)]);
      else for (const op of offers) t.close([t.tx(maker, [op])]);
      const r = t.close([t.tx(taker, [Operation.manageSellOffer({ selling: USD.sdk, buying: NATIVE.sdk, amount: '25', price: { n: 1, d: 1 } })])]);
      return { book: t.lm.getOrderBook(NATIVE.asset, USD.asset), claimed: decodeOutcome(r.results[0]).claimed, entries: t.lm.allEntries() };
    };
    const one = build(false);
    const all = build(true);
    expect(all.claimed).toEqual(one.claimed);
    expect(all.book.map((o) => [o.offerId, o.amount])).toEqual(one.book.map((o) => [o.offerId, o.amount]));
    // 2/3 first, then the two 1/1 offers in id order (the second partially).
    expect(one.claimed.map((c) => c.offerId)).toEqual([3n, 2n, 4n]);
    const strip = (es: LedgerEntry[]) => es.map((e) => ({ ...e, lastModifiedLedgerSeq: 0 }));
    expect(strip(all.entries).filter((e) => e.kind !== 'account')).toEqual(strip(one.entries).filter((e) => e.kind !== 'account'));
  });
});
