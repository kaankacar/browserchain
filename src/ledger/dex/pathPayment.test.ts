// Ported from stellar-core (Apache-2.0): src/transactions/test/PathPaymentTests.cpp,
// src/transactions/test/PathPaymentStrictSendTests.cpp
// PathPaymentStrictReceive / PathPaymentStrictSend scenarios (protocol 10+
// expectations) plus BrowserChain-specific checks.

import { Account, Keypair, MuxedAccount, Operation, xdr } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it } from 'vitest';
import { utf8 } from '../../lib/bytes';
import { INT64_MAX } from '../math';
import { af } from '../testkit';
import { AUTH_REQUIRED_FLAG, AUTH_REVOCABLE_FLAG, type Price } from '../types';
import { assetToXdr } from '../xdrutil';
import { reduceMaxOffersToCrossForTesting } from './convert';
import { Dex, XLM, XLM_ASSET, atoms, credit, decodeOutcome, type DexOutcome, type TAsset } from './testkit';

const P = (n: number, d: number): Price => ({ n, d });

afterEach(() => {
  reduceMaxOffersToCrossForTesting(1000);
});

/** The stellar-core test world: two gateways and their assets. */
function world() {
  const d = new Dex();
  const [gateway, gateway2] = d.accounts(2, 10_000n * XLM);
  const cur1 = credit('CUR1', gateway);
  const cur2 = credit('CUR2', gateway);
  const idr = credit('IDR', gateway);
  const cur3 = credit('CUR3', gateway2);
  const cur4 = credit('CUR4', gateway2);
  const usd = credit('USD', gateway2);
  const issuerOf = (a: TAsset): Keypair => (a.asset.type !== 'native' && a.asset.issuer === gateway2.publicKey() ? gateway2 : gateway);
  /** Trust `a` with `limit` and receive `amount` from its issuer. */
  const give = (kp: Keypair, a: TAsset, amount: bigint, limit: bigint = INT64_MAX) => {
    d.trust(kp, a, limit);
    if (amount > 0n) d.issue(issuerOf(a), kp, a, amount);
  };
  return { d, gateway, gateway2, cur1, cur2, cur3, cur4, idr, usd, give };
}

type World = ReturnType<typeof world>;

/** source, destination and market makers mm12 (cur2 for cur1), mm23, mm34, each offering at `price`. */
function chain(w: World, sizes: [bigint, bigint, bigint], price: Price = P(1, 1), limit = 200n) {
  const { d, cur1, cur2, cur3, cur4, give } = w;
  const [source, destination, mm12, mm23, mm34] = d.accounts(5);
  give(source, cur1, 0n, limit);
  give(mm12, cur1, 0n, limit);
  give(mm12, cur2, sizes[0], limit);
  give(mm23, cur2, 0n, limit);
  give(mm23, cur3, sizes[1], limit);
  give(mm34, cur3, 0n, limit);
  give(mm34, cur4, sizes[2], limit);
  give(destination, cur4, 0n, limit);
  const o1 = d.sell(mm12, cur2, cur1, sizes[0], price).offer!.offerId;
  const o2 = d.sell(mm23, cur3, cur2, sizes[1], price).offer!.offerId;
  const o3 = d.sell(mm34, cur4, cur3, sizes[2], price).offer!.offerId;
  return { source, destination, mm12, mm23, mm34, o1, o2, o3 };
}

function balances(d: Dex, kp: Keypair, assets: TAsset[]): bigint[] {
  return assets.map((a) => d.balance(kp, a));
}

describe('strict receive and strict send through the order book', () => {
  it('takes all offers, one offer per exchange (3 hops, strict receive)', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4, give } = w;
    const c = chain(w, [40n, 20n, 10n], P(2, 1));
    give(c.source, cur1, 80n, 200n);
    const r = d.strictReceive(c.source, c.destination, cur1, 80n, cur4, 10n, [cur1, cur2, cur3, cur4]);
    expect(r.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
    // Offers in path order (source side first).
    expect(atoms(r.claimed)).toEqual([
      [c.o1, 40n, 80n],
      [c.o2, 20n, 40n],
      [c.o3, 10n, 20n],
    ]);
    expect(r.claimed.map((a) => a.sellerId)).toEqual([c.mm12, c.mm23, c.mm34].map((k) => k.publicKey()));
    expect(r.last).toEqual({ destination: c.destination.publicKey(), asset: cur4.asset, amount: 10n });
    const all = [cur1, cur2, cur3, cur4];
    expect(balances(d, c.source, all)).toEqual([0n, 0n, 0n, 0n]);
    expect(balances(d, c.mm12, all)).toEqual([80n, 0n, 0n, 0n]);
    expect(balances(d, c.mm23, all)).toEqual([0n, 40n, 0n, 0n]);
    expect(balances(d, c.mm34, all)).toEqual([0n, 0n, 20n, 0n]);
    expect(balances(d, c.destination, all)).toEqual([0n, 0n, 0n, 10n]);
    expect([c.o1, c.o2, c.o3].map((id) => d.offer(id))).toEqual([undefined, undefined, undefined]);
    // The result names every counterparty.
    expect(r.result.accounts).toEqual(expect.arrayContaining([c.destination, c.mm12, c.mm23, c.mm34].map((k) => k.publicKey())));
    d.checkInvariants();
  });

  it('takes all offers, one offer per exchange (3 hops, strict send)', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4, give } = w;
    const c = chain(w, [40n, 20n, 10n], P(2, 1));
    give(c.source, cur1, 80n, 200n);
    const r = d.strictSend(c.source, c.destination, cur1, 80n, cur4, 10n, [cur2, cur3]);
    expect(r.code).toBe('PATH_PAYMENT_STRICT_SEND_SUCCESS');
    expect(atoms(r.claimed)).toEqual([
      [c.o1, 40n, 80n],
      [c.o2, 20n, 40n],
      [c.o3, 10n, 20n],
    ]);
    expect(r.last).toEqual({ destination: c.destination.publicKey(), asset: cur4.asset, amount: 10n });
    expect(d.balance(c.destination, cur4)).toBe(10n);
    expect(d.balance(c.source, cur1)).toBe(0n);
    d.checkInvariants();
  });

  function multiMarket(w: World, sourceCur1: bigint) {
    const { d, cur1, cur2, cur3, cur4, give } = w;
    const [source, destination, mm12, mm23, mm34] = d.accounts(5);
    give(source, cur1, sourceCur1, 200n);
    give(mm12, cur1, 0n, 200n);
    give(mm12, cur2, 35n, 200n);
    give(mm23, cur2, 0n, 200n);
    give(mm23, cur3, 23n, 200n);
    give(mm34, cur3, 0n, 200n);
    give(mm34, cur4, 16n, 200n);
    give(destination, cur4, 0n, 200n);
    const o = (kp: Keypair, s: TAsset, b: TAsset, p: Price, amount: bigint) => d.sell(kp, s, b, amount, p).offer!.offerId;
    const o1a = o(mm12, cur2, cur1, P(3, 2), 10n);
    const o1b = o(mm12, cur2, cur1, P(2, 1), 16n);
    const o1c = o(mm12, cur2, cur1, P(4, 3), 9n);
    const o2a = o(mm23, cur3, cur2, P(2, 1), 5n);
    const o2b = o(mm23, cur3, cur2, P(3, 2), 6n);
    const o2c = o(mm23, cur3, cur2, P(4, 3), 12n);
    const o3a = o(mm34, cur4, cur3, P(4, 3), 9n);
    const o3b = o(mm34, cur4, cur3, P(3, 2), 6n);
    const o3c = o(mm34, cur4, cur3, P(2, 1), 1n);
    return { source, destination, mm12, mm23, mm34, o1a, o1b, o1c, o2a, o2b, o2c, o3a, o3b, o3c };
  }

  it('takes all offers, multiple offers per exchange, best price first (strict receive and send)', () => {
    for (const mode of ['receive', 'send'] as const) {
      const w = world();
      const { d, cur1, cur2, cur3, cur4 } = w;
      const m = multiMarket(w, 59n);
      const path = [cur1, cur2, cur3, cur4];
      const r =
        mode === 'receive'
          ? d.strictReceive(m.source, m.destination, cur1, 59n, cur4, 16n, path)
          : d.strictSend(m.source, m.destination, cur1, 59n, cur4, 16n, path);
      expect(r.code.endsWith('_SUCCESS'), mode).toBe(true);
      expect(atoms(r.claimed), mode).toEqual([
        [m.o1c, 9n, 12n],
        [m.o1a, 10n, 15n],
        [m.o1b, 16n, 32n],
        [m.o2c, 12n, 16n],
        [m.o2b, 6n, 9n],
        [m.o2a, 5n, 10n],
        [m.o3a, 9n, 12n],
        [m.o3b, 6n, 9n],
        [m.o3c, 1n, 2n],
      ]);
      const all = [cur1, cur2, cur3, cur4];
      expect(balances(d, m.source, all)).toEqual([0n, 0n, 0n, 0n]);
      expect(balances(d, m.mm12, all)).toEqual([59n, 0n, 0n, 0n]);
      expect(balances(d, m.mm23, all)).toEqual([0n, 35n, 0n, 0n]);
      expect(balances(d, m.mm34, all)).toEqual([0n, 0n, 23n, 0n]);
      expect(balances(d, m.destination, all)).toEqual([0n, 0n, 0n, 16n]);
      expect(d.offersOf(m.mm12).length + d.offersOf(m.mm23).length + d.offersOf(m.mm34).length).toBe(0);
      d.checkInvariants();
    }
  });

  it('takes best offers, multiple offers per exchange (strict receive)', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4 } = w;
    const m = multiMarket(w, 58n);
    const r = d.strictReceive(m.source, m.destination, cur1, 51n, cur4, 15n, [cur1, cur2, cur3, cur4]);
    expect(atoms(r.claimed)).toEqual([
      [m.o1c, 9n, 12n],
      [m.o1a, 10n, 15n],
      [m.o1b, 12n, 24n],
      [m.o2c, 12n, 16n],
      [m.o2b, 6n, 9n],
      [m.o2a, 3n, 6n],
      [m.o3a, 9n, 12n],
      [m.o3b, 6n, 9n],
    ]);
    expect(d.offer(m.o1b)!.amount).toBe(4n);
    expect(d.offer(m.o2a)!.amount).toBe(2n);
    expect(d.offer(m.o3c)!.amount).toBe(1n);
    const all = [cur1, cur2, cur3, cur4];
    expect(balances(d, m.source, all)).toEqual([7n, 0n, 0n, 0n]);
    expect(balances(d, m.mm12, all)).toEqual([51n, 4n, 0n, 0n]);
    expect(balances(d, m.mm23, all)).toEqual([0n, 31n, 2n, 0n]);
    expect(balances(d, m.mm34, all)).toEqual([0n, 0n, 21n, 1n]);
    expect(balances(d, m.destination, all)).toEqual([0n, 0n, 0n, 15n]);
    d.checkInvariants();
  });

  it('takes best offers, multiple offers per exchange; the last crossed offer can sell nothing (strict send)', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4 } = w;
    const m = multiMarket(w, 58n);
    const r = d.strictSend(m.source, m.destination, cur1, 55n, cur4, 15n, [cur1, cur2, cur3, cur4]);
    expect(atoms(r.claimed)).toEqual([
      [m.o1c, 9n, 12n],
      [m.o1a, 10n, 15n],
      [m.o1b, 14n, 28n],
      [m.o2c, 12n, 16n],
      [m.o2b, 6n, 9n],
      [m.o2a, 4n, 8n],
      [m.o3a, 9n, 12n],
      [m.o3b, 6n, 9n],
      [m.o3c, 0n, 1n],
    ]);
    expect(r.last!.amount).toBe(15n);
    expect(d.offer(m.o1b)!.amount).toBe(2n);
    expect(d.offer(m.o2a)!.amount).toBe(1n);
    expect(d.offer(m.o3c)!.amount).toBe(1n);
    const all = [cur1, cur2, cur3, cur4];
    expect(balances(d, m.source, all)).toEqual([3n, 0n, 0n, 0n]);
    expect(balances(d, m.mm12, all)).toEqual([55n, 2n, 0n, 0n]);
    expect(balances(d, m.mm23, all)).toEqual([0n, 33n, 1n, 0n]);
    expect(balances(d, m.mm34, all)).toEqual([0n, 0n, 22n, 1n]);
    expect(balances(d, m.destination, all)).toEqual([0n, 0n, 0n, 15n]);
    d.checkInvariants();
  });

  it('a crossed offer that sends nothing is removed when it cannot stay (strict send)', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4, give } = w;
    // Like the previous case, but the last offer belongs to an account that
    // can only receive 2 CUR3: after getting 1 it cannot hold the offer.
    const [source, destination, mm12, mm23, mm34, mm34b] = d.accounts(6);
    give(source, cur1, 58n, 200n);
    give(mm12, cur1, 0n, 200n);
    give(mm12, cur2, 35n, 200n);
    give(mm23, cur2, 0n, 200n);
    give(mm23, cur3, 23n, 200n);
    give(mm34, cur3, 0n, 200n);
    give(mm34, cur4, 16n, 200n);
    give(mm34b, cur3, 0n, 2n);
    give(mm34b, cur4, 1n, 200n);
    give(destination, cur4, 0n, 200n);
    const o = (kp: Keypair, s: TAsset, b: TAsset, p: Price, amount: bigint) => d.sell(kp, s, b, amount, p).offer!.offerId;
    o(mm12, cur2, cur1, P(3, 2), 10n);
    o(mm12, cur2, cur1, P(2, 1), 16n);
    o(mm12, cur2, cur1, P(4, 3), 9n);
    o(mm23, cur3, cur2, P(2, 1), 5n);
    o(mm23, cur3, cur2, P(3, 2), 6n);
    o(mm23, cur3, cur2, P(4, 3), 12n);
    o(mm34, cur4, cur3, P(4, 3), 9n);
    o(mm34, cur4, cur3, P(3, 2), 6n);
    const o3c = o(mm34b, cur4, cur3, P(2, 1), 1n);
    const r = d.strictSend(source, destination, cur1, 55n, cur4, 15n, [cur1, cur2, cur3, cur4]);
    expect(atoms(r.claimed).at(-1)).toEqual([o3c, 0n, 1n]);
    expect(d.offer(o3c)).toBeUndefined();
    expect(balances(d, mm34b, [cur3, cur4])).toEqual([1n, 1n]);
    expect(balances(d, mm34, [cur3, cur4])).toEqual([21n, 1n]);
    d.checkInvariants();
  });

  it('handles rounding errors (CNY for XLM, strict receive and strict send)', () => {
    for (const mode of ['receive', 'send'] as const) {
      const { d } = world();
      const issuer = d.account(5_999_999_400n);
      const source = d.account(1_989_999_000n);
      const destination = d.account(499_999_700n);
      const seller = d.account(20_999_999_300n);
      const cny = credit('CNY', issuer);
      d.trust(destination, cny);
      d.trust(seller, cny, 1_000_000_000_000n);
      d.issue(issuer, seller, cny, 1_700_000_000n);
      const offer = d.sell(seller, cny, XLM_ASSET, 145_000_000n, P(2000, 29)).offer!.offerId;
      const before = d.balance(source, XLM_ASSET);
      if (mode === 'receive') {
        const r = d.strictReceive(source, destination, XLM_ASSET, 1_382_068_965n, cny, 20_000_000n);
        // 1379310345 = ceil(20000000 * 2000 / 29)
        expect(atoms(r.claimed)).toEqual([[offer, 20_000_000n, 1_379_310_345n]]);
        expect(d.offer(offer)!.amount).toBe(125_000_000n);
        expect(d.balance(source, XLM_ASSET)).toBe(before - 100n - 1_379_310_345n);
        expect(d.balance(seller, cny)).toBe(1_680_000_000n);
        expect(d.balance(destination, cny)).toBe(20_000_000n);
      } else {
        const r = d.strictSend(source, destination, XLM_ASSET, 1_382_068_965n, cny, 20_039_999n);
        // 20039999 = floor(1382068965 * 29 / 2000)
        expect(atoms(r.claimed)).toEqual([[offer, 20_039_999n, 1_382_068_965n]]);
        expect(d.offer(offer)!.amount).toBe(145_000_000n - 20_039_999n);
        expect(d.balance(source, XLM_ASSET)).toBe(before - 100n - 1_382_068_965n);
        expect(d.balance(seller, cny)).toBe(1_700_000_000n - 20_039_999n);
        expect(d.balance(destination, cny)).toBe(20_039_999n);
      }
      d.checkInvariants();
    }
  });

  it('recalculates sheepValue for a limited maker (strict receive, 1 and 2 offers)', () => {
    {
      const { d, cur1, cur2, give } = world();
      const [source, mm, destination] = d.accounts(3);
      give(source, cur1, 2n, 2n);
      give(mm, cur1, 0n, 2n);
      give(mm, cur2, 2000n, 2000n);
      give(destination, cur2, 0n, 1001n);
      const o1 = d.sell(mm, cur2, cur1, 2000n, P(1, 1000)).offer!.offerId;
      const r = d.strictReceive(source, destination, cur1, 2n, cur2, 1001n, [cur1, cur2]);
      expect(r.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
      expect(d.offer(o1)).toBeUndefined();
      expect([d.balance(source, cur1), d.balance(mm, cur1), d.balance(mm, cur2), d.balance(destination, cur2)]).toEqual([0n, 2n, 999n, 1001n]);
      d.checkInvariants();
    }
    {
      const { d, cur1, cur2, give } = world();
      const [source, mm, destination] = d.accounts(3);
      give(source, cur1, 7n, 7n);
      give(mm, cur1, 0n, 10n);
      give(mm, cur2, 10_000n, 10_000n);
      give(destination, cur2, 0n, 6001n);
      const o1 = d.sell(mm, cur2, cur1, 5000n, P(1, 1000)).offer!.offerId;
      const o2 = d.sell(mm, cur2, cur1, 5000n, P(1, 1000)).offer!.offerId;
      d.strictReceive(source, destination, cur1, 7n, cur2, 6001n, [cur1, cur2]);
      expect(d.offer(o1)).toBeUndefined();
      expect(d.offer(o2)!.amount).toBe(3000n);
      expect([d.balance(source, cur1), d.balance(mm, cur1), d.balance(mm, cur2), d.balance(destination, cur2)]).toEqual([0n, 7n, 3999n, 6001n]);
      d.checkInvariants();
    }
  });

  it('strict send rounding: 1 offer, 2 offers, and sending some while receiving nothing', () => {
    const run = (sendAmount: bigint, offers: bigint[]) => {
      const { d, cur1, cur2, give } = world();
      const [source, mm, destination] = d.accounts(3);
      give(source, cur1, 100n, 100n);
      give(mm, cur1, 0n, 2000n);
      give(mm, cur2, 2000n, 2000n);
      give(destination, cur2, 0n, 2000n);
      const ids = offers.map((a) => d.sell(mm, cur2, cur1, a, P(5, 3)).offer!.offerId);
      const r = d.strictSend(source, destination, cur1, sendAmount, cur2, 1n, []);
      expect(r.code).toBe('PATH_PAYMENT_STRICT_SEND_SUCCESS');
      d.checkInvariants();
      return { d, r, ids, source, mm, destination, cur1, cur2 };
    };
    {
      const { d, ids, source, mm, destination, cur1, cur2 } = run(3n, [3n]);
      expect(d.offer(ids[0])).toBeUndefined();
      expect([d.balance(source, cur1), d.balance(mm, cur1), d.balance(mm, cur2), d.balance(destination, cur2)]).toEqual([97n, 3n, 1999n, 1n]);
    }
    {
      const { d, ids, source, mm, destination, cur1, cur2 } = run(8n, [3n, 6n]);
      expect(ids.map((id) => d.offer(id))).toEqual([undefined, undefined]);
      expect([d.balance(source, cur1), d.balance(mm, cur1), d.balance(mm, cur2), d.balance(destination, cur2)]).toEqual([92n, 8n, 1996n, 4n]);
    }
    {
      const { d, r, ids, source, mm, destination, cur1, cur2 } = run(6n, [3n, 6n]);
      expect(d.offer(ids[0])).toBeUndefined();
      expect(d.offer(ids[1])!.amount).toBe(6n);
      expect(r.claimed.at(-1)).toMatchObject({ offerId: ids[1], amountSold: 0n, amountBought: 1n });
      expect([d.balance(source, cur1), d.balance(mm, cur1), d.balance(mm, cur2), d.balance(destination, cur2)]).toEqual([94n, 6n, 1997n, 3n]);
    }
  });

  it('runs through cycles: arbitrage succeeds, anti-arbitrage needs a large send max', () => {
    const run = (price: Price, sendMaxMultiplier: bigint) => {
      const { d, gateway, gateway2, idr, usd } = world();
      const payment = 100_000_000n;
      const offerAmount = 8n * payment;
      const initial = 2n * offerAmount;
      const setup = () => {
        const kp = d.account(initial);
        d.trust(kp, idr);
        d.issue(gateway, kp, idr, initial);
        d.trust(kp, usd);
        d.issue(gateway2, kp, usd, initial);
        return kp;
      };
      const source = setup();
      const destination = setup();
      const [c0, c1, c2] = [setup(), setup(), setup()];
      // c0 sells XLM for IDR, c1 sells USD for XLM, c2 sells IDR for USD.
      const o0 = d.sell(c0, XLM_ASSET, idr, offerAmount, price).offer!.offerId;
      const o1 = d.sell(c1, usd, XLM_ASSET, offerAmount, price).offer!.offerId;
      const o2 = d.sell(c2, idr, usd, offerAmount, price).offer!.offerId;
      const srcBefore = d.balance(source, XLM_ASSET);
      const dstBefore = d.balance(destination, XLM_ASSET);
      const r = d.strictReceive(source, destination, XLM_ASSET, sendMaxMultiplier * payment, XLM_ASSET, payment, [usd, idr]);
      return { d, r, source, destination, srcBefore, dstBefore, o0, o1, o2, offerAmount };
    };
    {
      const { d, r, source, destination, srcBefore, dstBefore, o0, o1, o2, offerAmount } = run(P(1, 2), 1n);
      expect(r.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
      expect(atoms(r.claimed)).toEqual([
        [o1, 25_000_000n, 12_500_000n],
        [o2, 50_000_000n, 25_000_000n],
        [o0, 100_000_000n, 50_000_000n],
      ]);
      expect(d.balance(source, XLM_ASSET)).toBe(srcBefore - 100n - 12_500_000n);
      expect(d.balance(destination, XLM_ASSET)).toBe(dstBefore + 100_000_000n);
      expect(d.offer(o0)!.amount).toBe(offerAmount - 100_000_000n);
      d.checkInvariants();
    }
    expect(run(P(2, 1), 1n).r.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_OVER_SENDMAX');
    {
      const { d, r, source, srcBefore } = run(P(2, 1), 8n);
      expect(r.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
      expect(d.balance(source, XLM_ASSET)).toBe(srcBefore - 100n - 800_000_000n);
      d.checkInvariants();
    }
  });
});

describe('long paths', () => {
  it('crosses six books with the maximum of five path assets, both ways', () => {
    for (const mode of ['receive', 'send'] as const) {
      const d = new Dex();
      const [issuer, source, destination, ...makers] = d.accounts(9);
      const assets = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map((c) => credit(c, issuer));
      const give = (kp: Keypair, a: TAsset, amount: bigint) => {
        d.trust(kp, a);
        if (amount > 0n) d.issue(issuer, kp, a, amount);
      };
      give(source, assets[0], 10_000n);
      give(destination, assets[6], 0n);
      // makers[i] sells A(i+1) for A(i) at 1/2: each hop halves the cost.
      for (let i = 0; i < 6; i++) {
        give(makers[i], assets[i], 0n);
        give(makers[i], assets[i + 1], 10_000n);
        d.sell(makers[i], assets[i + 1], assets[i], 10_000n, P(1, 2));
      }
      const path = assets.slice(1, 6);
      const r =
        mode === 'receive'
          ? d.strictReceive(source, destination, assets[0], 100n, assets[6], 6400n, path)
          : d.strictSend(source, destination, assets[0], 100n, assets[6], 6400n, path);
      expect(r.code.endsWith('_SUCCESS'), r.code).toBe(true);
      expect(r.claimed).toHaveLength(6);
      // 100 A0 -> 200 A1 -> ... -> 6400 A6
      expect(r.claimed.map((c) => c.amountSold)).toEqual([200n, 400n, 800n, 1600n, 3200n, 6400n]);
      expect(d.balance(destination, assets[6])).toBe(6400n);
      expect(d.balance(source, assets[0])).toBe(9_900n);
      d.checkInvariants();
    }
  });
});

describe('self, destination and issuer cases', () => {
  it('does not cross our own offer when a better one is available', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4, give } = w;
    const c = chain(w, [10n, 10n, 10n], P(1, 1), 20n);
    give(c.source, cur1, 10n, 30n);
    give(c.source, cur2, 10n, 30n);
    // Our own offer is worse than mm12's.
    d.sell(c.source, cur2, cur1, 10n, P(100, 99));
    const r = d.strictReceive(c.source, c.destination, cur1, 10n, cur4, 10n, [cur1, cur2, cur3, cur4]);
    expect(atoms(r.claimed)).toEqual([
      [c.o1, 10n, 10n],
      [c.o2, 10n, 10n],
      [c.o3, 10n, 10n],
    ]);
    expect(balances(d, c.source, [cur1, cur2])).toEqual([0n, 10n]);
    d.checkInvariants();
  });

  it('fails with OFFER_CROSS_SELF when our own offer is the best, at any hop', () => {
    for (const hop of [0, 1, 2]) {
      const w = world();
      const { d, cur1, cur2, cur3, cur4, give } = w;
      const [source, destination, m1, m2] = d.accounts(4);
      const pairs: [TAsset, TAsset][] = [
        [cur2, cur1],
        [cur3, cur2],
        [cur4, cur3],
      ];
      const makers = [m1, m2];
      let next = 0;
      give(source, cur1, 10n, 20n);
      give(destination, cur4, 0n, 20n);
      for (let i = 0; i < 3; i++) {
        const [s, b] = pairs[i];
        const kp = i === hop ? source : makers[next++];
        give(kp, s, 10n, 20n);
        if (kp !== source || b !== cur1) give(kp, b, 0n, 20n);
        d.sell(kp, s, b, 10n, P(1, 1));
      }
      const r = d.strictReceive(source, destination, cur1, 10n, cur4, 10n, [cur1, cur2, cur3, cur4]);
      expect(r.code, `hop ${hop}`).toBe('PATH_PAYMENT_STRICT_RECEIVE_OFFER_CROSS_SELF');
      const s = d.strictSend(source, destination, cur1, 10n, cur4, 10n, [cur2, cur3]);
      expect(s.code, `hop ${hop}`).toBe('PATH_PAYMENT_STRICT_SEND_OFFER_CROSS_SELF');
      expect(d.balance(source, cur1)).toBe(10n);
      d.checkInvariants();
    }
  });

  it('crosses offers of the destination', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4, give } = w;
    const [source, destination, mm23, mm34] = d.accounts(4);
    give(source, cur1, 10n, 20n);
    give(destination, cur1, 0n, 20n);
    give(destination, cur2, 10n, 20n);
    give(destination, cur4, 0n, 20n);
    give(mm23, cur2, 0n, 20n);
    give(mm23, cur3, 10n, 20n);
    give(mm34, cur3, 0n, 20n);
    give(mm34, cur4, 10n, 20n);
    const o1 = d.sell(destination, cur2, cur1, 10n, P(1, 1)).offer!.offerId;
    const o2 = d.sell(mm23, cur3, cur2, 10n, P(1, 1)).offer!.offerId;
    const o3 = d.sell(mm34, cur4, cur3, 10n, P(1, 1)).offer!.offerId;
    const r = d.strictReceive(source, destination, cur1, 10n, cur4, 10n, [cur1, cur2, cur3, cur4]);
    expect(atoms(r.claimed)).toEqual([
      [o1, 10n, 10n],
      [o2, 10n, 10n],
      [o3, 10n, 10n],
    ]);
    expect(balances(d, destination, [cur1, cur2, cur3, cur4])).toEqual([10n, 0n, 0n, 10n]);
    d.checkInvariants();
  });

  it('pays the issuer without a destination account only on a direct path', () => {
    const { d, gateway, idr, usd, give } = world();
    const source = d.account();
    give(source, idr, 10n, 20n);
    // The issuer merges away; a direct payment back to it still works.
    d.must(gateway, Operation.accountMerge({ destination: d.t.root.publicKey() }));
    const r = d.strictReceive(source, gateway.publicKey(), idr, 10n, idr, 5n);
    expect(r.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
    expect(r.claimed).toEqual([]);
    expect(d.balance(source, idr)).toBe(5n);
    expect(d.strictSend(source, gateway.publicKey(), idr, 5n, idr, 5n).code).toBe('PATH_PAYMENT_STRICT_SEND_SUCCESS');
    expect(d.balance(source, idr)).toBe(0n);
    // Any conversion needs the destination account.
    expect(d.strictReceive(source, gateway.publicKey(), idr, 10n, usd, 10n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_NO_DESTINATION');
    expect(d.strictSend(source, gateway.publicKey(), idr, 10n, usd, 10n).code).toBe('PATH_PAYMENT_STRICT_SEND_NO_DESTINATION');
  });

  it('pays itself', () => {
    const w = world();
    const { d, idr, give } = w;
    const account = d.account();
    const before = d.balance(account, XLM_ASSET);
    expect(d.strictReceive(account, account, XLM_ASSET, 20n, XLM_ASSET, 20n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
    expect(d.balance(account, XLM_ASSET)).toBe(before - 100n);
    give(account, idr, 10n, 20n);
    expect(d.strictReceive(account, account, idr, 10n, idr, 10n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
    expect(d.balance(account, idr)).toBe(10n);
    d.issue(w.gateway, account, idr, 9n);
    // The destination is credited first, so the line overflows (19 + 2 > 20).
    expect(d.strictReceive(account, account, idr, 2n, idr, 2n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_LINE_FULL');
    // Strict send debits first.
    expect(d.strictSend(account, account, idr, 2n, idr, 2n).code).toBe('PATH_PAYMENT_STRICT_SEND_SUCCESS');
    expect(d.balance(account, idr)).toBe(19n);
  });

  it('accepts a muxed destination and credits the underlying account', () => {
    const { d, usd, give } = world();
    const [source, dest] = d.accounts(2);
    give(source, usd, 100n);
    give(dest, usd, 0n);
    const muxed = new MuxedAccount(new Account(dest.publicKey(), '0'), '42').accountId();
    expect(muxed.startsWith('M')).toBe(true);
    const r = d.strictSend(source, muxed, usd, 30n, usd, 30n);
    expect(r.code).toBe('PATH_PAYMENT_STRICT_SEND_SUCCESS');
    expect(r.last!.destination).toBe(dest.publicKey());
    expect(d.balance(dest, usd)).toBe(30n);
  });
});

describe('failure codes', () => {
  function rawStrictReceive(sendAsset: xdr.Asset, sendMax: bigint, dest: string, destAsset: xdr.Asset, destAmount: bigint, path: xdr.Asset[] = []) {
    return new xdr.Operation({
      sourceAccount: null,
      body: xdr.OperationBody.pathPaymentStrictReceive(
        new xdr.PathPaymentStrictReceiveOp({
          sendAsset,
          sendMax: xdr.Int64(sendMax),
          destination: xdr.MuxedAccount.keyTypeEd25519(Keypair.fromPublicKey(dest).rawPublicKey()),
          destAsset,
          destAmount: xdr.Int64(destAmount),
          path,
        }),
      ),
    });
  }

  function rawStrictSend(sendAsset: xdr.Asset, sendAmount: bigint, dest: string, destAsset: xdr.Asset, destMin: bigint, path: xdr.Asset[] = []) {
    return new xdr.Operation({
      sourceAccount: null,
      body: xdr.OperationBody.pathPaymentStrictSend(
        new xdr.PathPaymentStrictSendOp({
          sendAsset,
          sendAmount: xdr.Int64(sendAmount),
          destination: xdr.MuxedAccount.keyTypeEd25519(Keypair.fromPublicKey(dest).rawPublicKey()),
          destAsset,
          destMin: xdr.Int64(destMin),
          path,
        }),
      ),
    });
  }

  it('rejects malformed path payments', () => {
    const { d, gateway, idr } = world();
    const [a, b] = d.accounts(2);
    const I = assetToXdr(idr.asset);
    const N = xdr.Asset.assetTypeNative();
    const bad = xdr.Asset.assetTypeCreditAlphanum12(
      new xdr.AlphaNum12({ assetCode: utf8('AB\0\0\0\0\0\0\0\0\0\0'), issuer: xdr.PublicKey.publicKeyTypeEd25519(gateway.rawPublicKey()) }),
    );
    const B = b.publicKey();
    const cases: [string, xdr.Operation, string][] = [
      ['dest amount 0', rawStrictReceive(N, 10n, B, N, 0n), 'PATH_PAYMENT_STRICT_RECEIVE_MALFORMED'],
      ['dest amount negative', rawStrictReceive(N, 10n, B, N, -1n), 'PATH_PAYMENT_STRICT_RECEIVE_MALFORMED'],
      ['send max 0', rawStrictReceive(N, 0n, B, N, 10n), 'PATH_PAYMENT_STRICT_RECEIVE_MALFORMED'],
      ['send max negative', rawStrictReceive(N, -10n, B, N, 10n), 'PATH_PAYMENT_STRICT_RECEIVE_MALFORMED'],
      ['send asset invalid', rawStrictReceive(bad, 10n, B, N, 10n), 'PATH_PAYMENT_STRICT_RECEIVE_MALFORMED'],
      ['dest asset invalid', rawStrictReceive(N, 10n, B, bad, 10n), 'PATH_PAYMENT_STRICT_RECEIVE_MALFORMED'],
      ['path asset invalid', rawStrictReceive(N, 10n, B, I, 10n, [bad]), 'PATH_PAYMENT_STRICT_RECEIVE_MALFORMED'],
      ['send amount 0', rawStrictSend(N, 0n, B, N, 10n), 'PATH_PAYMENT_STRICT_SEND_MALFORMED'],
      ['dest min 0', rawStrictSend(N, 10n, B, N, 0n), 'PATH_PAYMENT_STRICT_SEND_MALFORMED'],
      ['dest min negative', rawStrictSend(N, 10n, B, N, -5n), 'PATH_PAYMENT_STRICT_SEND_MALFORMED'],
      ['send: path asset invalid', rawStrictSend(N, 10n, B, I, 10n, [N, bad]), 'PATH_PAYMENT_STRICT_SEND_MALFORMED'],
    ];
    for (const [name, op, code] of cases) {
      const env = d.t.rawTx(a, [op]);
      const cv = d.lm.checkValid(env);
      expect(cv.code, name).toBe('txFAILED');
      expect(cv.detail, name).toContain(code);
      expect(decodeOutcome(d.t.apply(env)).code, name).toBe(code);
    }
    // More than 5 path assets cannot even be encoded.
    expect(() => rawStrictSend(N, 10n, B, I, 10n, [N, N, N, N, N, N]).toXdr()).toThrow();
  });

  it('checks the destination: NO_DESTINATION, NO_TRUST, NOT_AUTHORIZED, LINE_FULL', () => {
    const { d, gateway, idr, give } = world();
    const [source, noTrust, full] = d.accounts(3);
    give(source, idr, 10n, 20n);
    const nobody = Keypair.random().publicKey();
    expect(d.strictReceive(source, nobody, idr, 10n, idr, 10n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_NO_DESTINATION');
    expect(d.strictSend(source, nobody, idr, 10n, idr, 10n).code).toBe('PATH_PAYMENT_STRICT_SEND_NO_DESTINATION');
    expect(d.strictReceive(source, noTrust, idr, 1n, idr, 1n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_NO_TRUST');
    expect(d.strictSend(source, noTrust, idr, 1n, idr, 1n).code).toBe('PATH_PAYMENT_STRICT_SEND_NO_TRUST');
    // The issuer itself also fails on a missing trust line.
    expect(d.strictReceive(gateway, noTrust, idr, 1n, idr, 1n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_NO_TRUST');
    give(full, idr, 10n, 20n);
    expect(d.strictReceive(source, full, idr, 11n, idr, 11n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_LINE_FULL');
    expect(d.strictSend(source, full, idr, 10n, idr, 10n).code).toBe('PATH_PAYMENT_STRICT_SEND_SUCCESS');
    d.issue(gateway, source, idr, 5n);
    expect(d.strictSend(source, full, idr, 1n, idr, 1n).code).toBe('PATH_PAYMENT_STRICT_SEND_LINE_FULL');
    expect(d.balance(source, idr)).toBe(5n);
    expect(d.balance(full, idr)).toBe(20n);

    // Not authorized (deauthorized, or only authorized to maintain liabilities).
    const gate = d.account();
    const eur = credit('EUR', gate);
    d.must(gate, Operation.setOptions({ setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG) }));
    const [payer, deauth, maintain] = d.accounts(3);
    for (const kp of [payer, deauth, maintain]) {
      d.trust(kp, eur, 100n);
      d.must(gate, Operation.setTrustLineFlags({ trustor: kp.publicKey(), asset: eur.sdk, flags: { authorized: true } }));
    }
    d.issue(gate, payer, eur, 50n);
    d.must(gate, Operation.setTrustLineFlags({ trustor: deauth.publicKey(), asset: eur.sdk, flags: { authorized: false } }));
    d.must(
      gate,
      Operation.setTrustLineFlags({ trustor: maintain.publicKey(), asset: eur.sdk, flags: { authorized: false, authorizedToMaintainLiabilities: true } }),
    );
    for (const kp of [deauth, maintain]) {
      expect(d.strictReceive(payer, kp, eur, 10n, eur, 10n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_NOT_AUTHORIZED');
      expect(d.strictSend(payer, kp, eur, 10n, eur, 10n).code).toBe('PATH_PAYMENT_STRICT_SEND_NOT_AUTHORIZED');
    }
  });

  it('checks the source: UNDERFUNDED, SRC_NO_TRUST, SRC_NOT_AUTHORIZED', () => {
    const { d, idr, usd, give } = world();
    const [source, dest] = d.accounts(2, 10n * XLM);
    give(dest, idr, 0n);
    give(dest, usd, 0n);
    expect(d.strictReceive(source, dest, idr, 10n, idr, 10n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SRC_NO_TRUST');
    expect(d.strictSend(source, dest, idr, 10n, idr, 10n).code).toBe('PATH_PAYMENT_STRICT_SEND_SRC_NO_TRUST');
    give(source, idr, 5n);
    expect(d.strictReceive(source, dest, idr, 10n, idr, 6n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_UNDERFUNDED');
    expect(d.strictSend(source, dest, idr, 6n, idr, 6n).code).toBe('PATH_PAYMENT_STRICT_SEND_UNDERFUNDED');
    // Native: only the balance above the reserve can be sent.
    const acc = d.accountEntry(source);
    const free = acc.balance - d.lm.minBalance(acc) - 100n; // the next fee
    expect(d.strictReceive(source, dest, XLM_ASSET, free + 1n, XLM_ASSET, free + 1n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_UNDERFUNDED');
    expect(d.strictSend(source, dest, XLM_ASSET, free, XLM_ASSET, 1n).code).toBe('PATH_PAYMENT_STRICT_SEND_UNDERFUNDED');

    const gate = d.account();
    const eur = credit('EUR', gate);
    d.must(gate, Operation.setOptions({ setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG) }));
    const [payer, receiver] = d.accounts(2);
    for (const kp of [payer, receiver]) {
      d.trust(kp, eur, 100n);
      d.must(gate, Operation.setTrustLineFlags({ trustor: kp.publicKey(), asset: eur.sdk, flags: { authorized: true } }));
    }
    d.issue(gate, payer, eur, 50n);
    d.must(gate, Operation.setTrustLineFlags({ trustor: payer.publicKey(), asset: eur.sdk, flags: { authorized: false } }));
    expect(d.strictReceive(payer, receiver, eur, 10n, eur, 10n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SRC_NOT_AUTHORIZED');
    expect(d.strictSend(payer, receiver, eur, 10n, eur, 10n).code).toBe('PATH_PAYMENT_STRICT_SEND_SRC_NOT_AUTHORIZED');
  });

  it('fails with TOO_FEW_OFFERS at the first, middle or last exchange', () => {
    for (const short of [0, 1, 2]) {
      const w = world();
      const { d, cur1, cur2, cur3, cur4, give } = w;
      const sizes: [bigint, bigint, bigint] = [10n, 10n, 10n];
      sizes[short] = 9n;
      const c = chain(w, sizes, P(1, 1), 20n);
      give(c.source, cur1, 10n, 20n);
      const r = d.strictReceive(c.source, c.destination, cur1, 10n, cur4, 10n, [cur1, cur2, cur3, cur4]);
      expect(r.code, `hop ${short}`).toBe('PATH_PAYMENT_STRICT_RECEIVE_TOO_FEW_OFFERS');
      const s = d.strictSend(c.source, c.destination, cur1, 10n, cur4, 9n, [cur2, cur3]);
      expect(s.code, `hop ${short}`).toBe('PATH_PAYMENT_STRICT_SEND_TOO_FEW_OFFERS');
      // Nothing moved.
      expect(d.balance(c.source, cur1)).toBe(10n);
      expect(d.balance(c.destination, cur4)).toBe(0n);
      expect([c.o1, c.o2, c.o3].map((id) => d.offer(id)!.amount)).toEqual(sizes);
    }
    // No offers at all.
    const { d, idr, usd, give } = world();
    const [s, t] = d.accounts(2);
    give(s, idr, 10n);
    give(t, usd, 0n);
    expect(d.strictReceive(s, t, idr, 10n, usd, 1n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_TOO_FEW_OFFERS');
    expect(d.strictSend(s, t, idr, 1n, usd, 1n).code).toBe('PATH_PAYMENT_STRICT_SEND_TOO_FEW_OFFERS');
  });

  it('fails with OVER_SENDMAX and UNDER_DESTMIN', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4, idr, give } = w;
    const [source, destination] = d.accounts(2);
    expect(d.strictReceive(source, destination, XLM_ASSET, 10n, XLM_ASSET, 11n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_OVER_SENDMAX');
    give(source, idr, 10n, 10n);
    give(destination, idr, 0n, 10n);
    expect(d.strictReceive(source, destination, idr, 9n, idr, 10n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_OVER_SENDMAX');
    expect(d.strictSend(source, destination, idr, 9n, idr, 10n).code).toBe('PATH_PAYMENT_STRICT_SEND_UNDER_DESTMIN');
    // With a real path at 2:1 per hop, 10 CUR4 costs 80 CUR1.
    const c = chain(w, [40n, 20n, 10n], P(2, 1));
    give(c.source, cur1, 80n, 200n);
    expect(d.strictReceive(c.source, c.destination, cur1, 79n, cur4, 10n, [cur1, cur2, cur3, cur4]).code).toBe(
      'PATH_PAYMENT_STRICT_RECEIVE_OVER_SENDMAX',
    );
    expect(d.strictSend(c.source, c.destination, cur1, 80n, cur4, 11n, [cur2, cur3]).code).toBe('PATH_PAYMENT_STRICT_SEND_UNDER_DESTMIN');
    expect([c.o1, c.o2, c.o3].map((id) => d.offer(id)!.amount)).toEqual([40n, 20n, 10n]);
    expect(d.strictReceive(c.source, c.destination, cur1, 80n, cur4, 10n, [cur1, cur2, cur3, cur4]).code).toBe(
      'PATH_PAYMENT_STRICT_RECEIVE_SUCCESS',
    );
    d.checkInvariants();
  });

  it('fails with opEXCEEDED_WORK_LIMIT when the hops together cross too many offers', () => {
    const w = world();
    const { d, cur1, cur2, cur3, cur4, give } = w;
    const c = chain(w, [10n, 10n, 10n], P(1, 1), 20n);
    give(c.source, cur1, 10n, 20n);
    const restore = reduceMaxOffersToCrossForTesting(2);
    try {
      const r = d.strictReceive(c.source, c.destination, cur1, 10n, cur4, 10n, [cur1, cur2, cur3, cur4]);
      expect(r.code).toBe('opEXCEEDED_WORK_LIMIT');
      expect(d.strictSend(c.source, c.destination, cur1, 10n, cur4, 10n, [cur2, cur3]).code).toBe('opEXCEEDED_WORK_LIMIT');
      reduceMaxOffersToCrossForTesting(3);
      expect(d.strictSend(c.source, c.destination, cur1, 10n, cur4, 10n, [cur2, cur3]).code).toBe('PATH_PAYMENT_STRICT_SEND_SUCCESS');
    } finally {
      restore();
    }
    d.checkInvariants();
  });
});

describe('liabilities', () => {
  function market(sellerIsDestination: boolean) {
    const { d, cur1, cur2, give } = world();
    const [source, destination, mm12] = d.accounts(3);
    give(source, cur1, 100n, 200n);
    give(mm12, cur1, 0n, 200n);
    give(mm12, cur2, 100n, 200n);
    give(destination, cur2, sellerIsDestination ? 100n : 0n, 200n);
    if (sellerIsDestination) d.sell(destination, XLM_ASSET, cur2, 50n, P(1, 1));
    else d.sell(source, cur1, XLM_ASSET, 50n, P(1, 1));
    d.sell(mm12, cur2, cur1, 100n, P(1, 1));
    return { d, source, destination, cur1, cur2 };
  }

  it('cannot pay away the balance promised to selling liabilities', () => {
    for (const mode of ['receive', 'send'] as const) {
      const { d, source, destination, cur1, cur2 } = market(false);
      const pay = (n: bigint): DexOutcome =>
        mode === 'receive'
          ? d.strictReceive(source, destination, cur1, n, cur2, n, [cur1, cur2])
          : d.strictSend(source, destination, cur1, n, cur2, n, [cur1, cur2]);
      expect(pay(51n).code).toBe(mode === 'receive' ? 'PATH_PAYMENT_STRICT_RECEIVE_UNDERFUNDED' : 'PATH_PAYMENT_STRICT_SEND_UNDERFUNDED');
      expect(pay(50n).code.endsWith('_SUCCESS')).toBe(true);
      d.checkInvariants();
    }
  });

  it('cannot receive beyond the limit reserved by buying liabilities', () => {
    for (const mode of ['receive', 'send'] as const) {
      const { d, source, destination, cur1, cur2 } = market(true);
      const pay = (n: bigint): DexOutcome =>
        mode === 'receive'
          ? d.strictReceive(source, destination, cur1, n, cur2, n, [cur1, cur2])
          : d.strictSend(source, destination, cur1, n, cur2, n, [cur1, cur2]);
      expect(pay(51n).code).toBe(mode === 'receive' ? 'PATH_PAYMENT_STRICT_RECEIVE_LINE_FULL' : 'PATH_PAYMENT_STRICT_SEND_LINE_FULL');
      expect(pay(50n).code.endsWith('_SUCCESS')).toBe(true);
      d.checkInvariants();
    }
  });
});
