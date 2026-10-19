// Order book levels, path payment quotes and path finding. Quotes must equal
// the result of the real operation on the same ledger.

import { Keypair } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it } from 'vitest';
import { pick, randInt, seededRng } from '../../lib/random';
import type { OfferEntry, Price } from '../types';
import { reduceMaxOffersToCrossForTesting } from './convert';
import { findPaths, priceLevels, quoteStrictReceive, quoteStrictSend } from './quote';
import { Dex, XLM, XLM_ASSET, credit, type TAsset } from './testkit';

const P = (n: number, d: number): Price => ({ n, d });

afterEach(() => {
  reduceMaxOffersToCrossForTesting(1000);
});

/** Three assets with a 3-hop chain of books plus a worse direct book. */
function market() {
  const d = new Dex();
  const [issuer, mm1, mm2, mm3, mmDirect, source, dest] = d.accounts(7);
  const [A, B, C, D] = ['AAA', 'BBB', 'CCC', 'DDD'].map((c) => credit(c, issuer));
  const give = (kp: Keypair, a: TAsset, amount: bigint) => {
    d.trust(kp, a);
    if (amount > 0n) d.issue(issuer, kp, a, amount);
  };
  give(source, A, 1_000_000n);
  give(dest, D, 0n);
  give(mm1, A, 0n);
  give(mm1, B, 1_000_000n);
  give(mm2, B, 0n);
  give(mm2, C, 1_000_000n);
  give(mm3, C, 0n);
  give(mm3, D, 1_000_000n);
  give(mmDirect, A, 0n);
  give(mmDirect, D, 1_000_000n);
  // A -> B -> C -> D at 1:1 with some depth and rounding, and a direct A -> D book at 2:1.
  d.sell(mm1, B, A, 3_000n, P(1, 1));
  d.sell(mm1, B, A, 5_000n, P(7, 6));
  d.sell(mm2, C, B, 4_000n, P(9, 10));
  d.sell(mm2, C, B, 4_000n, P(11, 10));
  d.sell(mm3, D, C, 6_000n, P(1, 1));
  d.sell(mm3, D, C, 6_000n, P(5, 4));
  d.sell(mmDirect, D, A, 10_000n, P(2, 1));
  return { d, issuer, source, dest, mm1, A, B, C, D };
}

describe('priceLevels', () => {
  it('groups offers by exact price and can invert prices', () => {
    const o = (id: number, n: number, d: number, amount: bigint) =>
      ({ offerId: BigInt(id), price: P(n, d), amount }) as OfferEntry;
    const levels = priceLevels([o(1, 2, 3, 10n), o(2, 4, 6, 5n), o(3, 1, 1, 7n), o(4, 3, 2, 1n), o(5, 6, 4, 2n)]);
    expect(levels).toEqual([
      { price: P(2, 3), amount: 15n, offers: 2 },
      { price: P(1, 1), amount: 7n, offers: 1 },
      { price: P(3, 2), amount: 3n, offers: 2 },
    ]);
    expect(priceLevels([o(1, 2, 3, 10n)], true)).toEqual([{ price: P(3, 2), amount: 10n, offers: 1 }]);
    expect(priceLevels([])).toEqual([]);
  });

  it('works on getOrderBook output', () => {
    const { d, A, B } = market();
    expect(priceLevels(d.book(B, A)).map((l) => [l.price, l.amount])).toEqual([
      [P(1, 1), 3_000n],
      [P(7, 6), 5_000n],
    ]);
  });
});

describe('quotes', () => {
  it('quote strict send and strict receive exactly like the operations', () => {
    for (const mode of ['send', 'receive'] as const) {
      const { d, source, dest, A, B, C, D } = market();
      const path = [B.asset, C.asset];
      const before = d.lm.stateHash();
      const q =
        mode === 'send'
          ? quoteStrictSend(d.lm, { sendAsset: A.asset, destAsset: D.asset, path, sendAmount: 8_000n })
          : quoteStrictReceive(d.lm, { sendAsset: A.asset, destAsset: D.asset, path, destAmount: 7_000n });
      expect(q.ok).toBe(true);
      if (!q.ok) return;
      // Quoting does not touch the ledger.
      expect(d.lm.stateHash()).toBe(before);
      const r =
        mode === 'send'
          ? d.strictSend(source, dest, A, 8_000n, D, 1n, [B, C])
          : d.strictReceive(source, dest, A, 1_000_000n, D, 7_000n, [B, C]);
      expect(r.code.endsWith('_SUCCESS')).toBe(true);
      expect(r.claimed).toEqual(q.offers);
      expect(r.last!.amount).toBe(q.destAmount);
      expect(1_000_000n - d.balance(source, A)).toBe(q.sendAmount);
      expect(q.offers.length).toBeGreaterThan(3);
    }
  });

  it('reports TOO_FEW_OFFERS, OFFER_CROSS_SELF and EXCEEDED_WORK_LIMIT', () => {
    const { d, mm1, A, B, C, D } = market();
    const req = { sendAsset: A.asset, destAsset: D.asset, path: [B.asset, C.asset] };
    expect(quoteStrictSend(d.lm, { ...req, sendAmount: 100_000n })).toEqual({ ok: false, error: 'TOO_FEW_OFFERS' });
    expect(quoteStrictReceive(d.lm, { ...req, destAmount: 100_000n })).toEqual({ ok: false, error: 'TOO_FEW_OFFERS' });
    expect(quoteStrictSend(d.lm, { ...req, sendAmount: 10n, sourceId: mm1.publicKey() })).toEqual({ ok: false, error: 'OFFER_CROSS_SELF' });
    reduceMaxOffersToCrossForTesting(2);
    expect(quoteStrictSend(d.lm, { ...req, sendAmount: 10n })).toEqual({ ok: false, error: 'EXCEEDED_WORK_LIMIT' });
    reduceMaxOffersToCrossForTesting(3);
    expect(quoteStrictSend(d.lm, { ...req, sendAmount: 10n }).ok).toBe(true);
    // No conversion needed.
    expect(quoteStrictSend(d.lm, { sendAsset: A.asset, destAsset: A.asset, sendAmount: 5n })).toMatchObject({ ok: true, destAmount: 5n, offers: [] });
    expect(() => quoteStrictSend(d.lm, { ...req, sendAmount: 0n })).toThrow();
  });

  it('follows the ledger: a new ledger invalidates the cached state', () => {
    const { d, source, dest, A, B, C, D } = market();
    const req = { sendAsset: A.asset, destAsset: D.asset, path: [B.asset, C.asset], sendAmount: 2_000n };
    const q1 = quoteStrictSend(d.lm, req);
    expect(quoteStrictSend(d.lm, req)).toEqual(q1);
    d.strictSend(source, dest, A, 2_000n, D, 1n, [B, C]);
    const q2 = quoteStrictSend(d.lm, req);
    expect(q2).not.toEqual(q1);
    expect(q2.ok && q1.ok && q2.offers[0].amountSold).toBeTruthy();
  });

  it('findPaths ranks paths by the amount received or sent', () => {
    const { d, A, D, B, C } = market();
    const send = findPaths(d.lm, { mode: 'strictSend', sendAsset: A.asset, destAsset: D.asset, amount: 2_000n });
    expect(send.map((q) => q.path)).toEqual([[B.asset, C.asset], []]);
    expect(send[0].destAmount).toBeGreaterThan(send[1].destAmount);
    // The direct book at 2:1 gives 1000 D for 2000 A.
    expect(send[1].destAmount).toBe(1_000n);
    const receive = findPaths(d.lm, { mode: 'strictReceive', sendAsset: A.asset, destAsset: D.asset, amount: 1_000n, limit: 1 });
    expect(receive).toHaveLength(1);
    expect(receive[0].path).toEqual([B.asset, C.asset]);
    expect(receive[0].sendAmount).toBeLessThan(2_000n);
    // A path longer than allowed is not found.
    expect(findPaths(d.lm, { mode: 'strictSend', sendAsset: A.asset, destAsset: D.asset, amount: 2_000n, maxPathLength: 1 }).map((q) => q.path)).toEqual([[]]);
    // No route at all.
    expect(findPaths(d.lm, { mode: 'strictSend', sendAsset: D.asset, destAsset: A.asset, amount: 10n })).toEqual([]);
  });

  it('matches execution on random books (strict send and strict receive)', () => {
    const rng = seededRng(77);
    let compared = 0;
    let multiHop = 0;
    for (let round = 0; round < 8; round++) {
      const d = new Dex();
      const [issuer, source, dest, ...makers] = d.accounts(7, 10_000n * XLM);
      const assets = ['AAA', 'BBB', 'CCC'].map((c) => credit(c, issuer));
      const all: TAsset[] = [XLM_ASSET, ...assets];
      const byAsset = (p: (typeof all)[number]['asset']) =>
        all.find((a) => a.asset.type === p.type && (p.type === 'native' || (a.asset.type !== 'native' && a.asset.code === p.code)))!;
      for (const kp of [source, dest, ...makers]) {
        for (const a of assets) {
          d.trust(kp, a);
          d.issue(issuer, kp, a, 1_000_000n);
        }
      }
      for (let i = 0; i < 40; i++) {
        const kp = pick(rng, makers);
        const s = pick(rng, all);
        let b = pick(rng, all);
        while (b === s) b = pick(rng, all);
        d.sell(kp, s, b, BigInt(randInt(rng, 1, 5_000)), P(randInt(rng, 1, 20), randInt(rng, 1, 20)));
      }
      d.checkInvariants();
      for (let req = 0; req < 3; req++) {
        const sendA = pick(rng, all);
        let destA = pick(rng, all);
        while (destA === sendA) destA = pick(rng, all);
        const mode = (round + req) % 2 === 0 ? 'strictSend' : 'strictReceive';
        const amount = BigInt(randInt(rng, 1, 2_000));
        const quotes = findPaths(d.lm, { mode, sendAsset: sendA.asset, destAsset: destA.asset, amount, limit: 3 });
        for (const q of quotes) {
          const path = q.path.map(byAsset);
          // Re-quote right before executing (the previous execution changed the books).
          const fresh =
            mode === 'strictSend'
              ? quoteStrictSend(d.lm, { sendAsset: sendA.asset, destAsset: destA.asset, path: q.path, sendAmount: amount })
              : quoteStrictReceive(d.lm, { sendAsset: sendA.asset, destAsset: destA.asset, path: q.path, destAmount: amount });
          const r =
            mode === 'strictSend'
              ? d.strictSend(source, dest, sendA, amount, destA, 1n, path)
              : d.strictReceive(source, dest, sendA, 100_000_000n, destA, amount, path);
          if (!fresh.ok) {
            expect(r.code.endsWith('_SUCCESS')).toBe(false);
            continue;
          }
          expect(r.code.endsWith('_SUCCESS'), r.code).toBe(true);
          expect(r.claimed).toEqual(fresh.offers);
          expect(r.last!.amount).toBe(fresh.destAmount);
          compared++;
          if (q.path.length > 0) multiHop++;
        }
      }
      d.checkInvariants();
    }
    expect(compared).toBeGreaterThan(15);
    expect(multiHop).toBeGreaterThan(5);
  });

  it('findPaths gives the same results under any budget it does not reach', () => {
    const { d, A, D } = market();
    for (const mode of ['strictSend', 'strictReceive'] as const) {
      const req = { mode, sendAsset: A.asset, destAsset: D.asset, amount: 1_000n, maxPathLength: 5 };
      const all = findPaths(d.lm, req);
      expect(all.length).toBe(2);
      expect(findPaths(d.lm, { ...req, maxSteps: 1_000_000 })).toEqual(all);
      expect(findPaths(d.lm, { ...req, maxSteps: 100 })).toEqual(all);
    }
  });

  /** 10 assets, every one sold for every other one at price 2 (the books never cross). */
  function denseMarket() {
    const d = new Dex();
    const [issuer] = d.accounts(1);
    const assets = [XLM_ASSET, ...['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III'].map((c) => credit(c, issuer))];
    const makers = d.accounts(assets.length, 10_000n * XLM);
    assets.forEach((a, i) => {
      for (const b of assets) if (b !== XLM_ASSET) d.trust(makers[i], b);
      if (a !== XLM_ASSET) d.issue(issuer, makers[i], a, 100_000_000n);
      for (const b of assets) if (b !== a) expect(d.sell(makers[i], a, b, 1_000_000n, P(2, 1)).effect).toBe('created');
    });
    return { d, assets };
  }

  it('findPaths stops at its step budget on a dense market', () => {
    // 8,801 simple paths of up to 5 intermediate assets from one asset to
    // another. Without a budget every one was quoted.
    const { d, assets } = denseMarket();
    let quotes = 0;
    const view = {
      lastClosed: () => {
        quotes++;
        return d.lm.lastClosed();
      },
      allEntries: () => d.lm.allEntries(),
    };
    const req = { mode: 'strictSend' as const, sendAsset: assets[1].asset, destAsset: assets[2].asset, amount: 10_000n, maxPathLength: 5 };
    const found = findPaths(view, req);
    expect(quotes).toBeLessThanOrEqual(2_000);
    // The direct book is the first candidate the walk reaches, and the best.
    expect(found[0].path).toEqual([]);
    expect(found[0].destAmount).toBe(5_000n);
    // A smaller budget quotes less; the best path is still found.
    quotes = 0;
    expect(findPaths(view, { ...req, maxSteps: 50 })[0]).toEqual(found[0]);
    expect(quotes).toBeLessThanOrEqual(50);
  });

  it('findPaths keeps the shortest paths when the budget cuts the search', () => {
    // The destination sorts after every other neighbour. A depth-first walk
    // spent the default budget below the first neighbour and returned a
    // 1-hop path for 2,500 instead of the direct book for 5,000.
    const { d, assets } = denseMarket();
    for (const maxPathLength of [3, 5]) {
      const req = { mode: 'strictSend' as const, sendAsset: assets[1].asset, destAsset: assets[9].asset, amount: 10_000n, maxPathLength };
      const unbounded = findPaths(d.lm, { ...req, maxSteps: 10_000_000 });
      expect(unbounded[0].path).toEqual([]);
      expect(unbounded[0].destAmount).toBe(5_000n);
      // The rest are 1-hop paths: two conversions at price 2 give 2,500.
      expect(unbounded.slice(1).map((q) => [q.path.length, q.destAmount])).toEqual(Array(4).fill([1, 2_500n]));
      expect(findPaths(d.lm, req), `maxPathLength ${maxPathLength}`).toEqual(unbounded);
    }
  });
});
