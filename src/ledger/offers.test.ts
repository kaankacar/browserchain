import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { genesisHeader } from './genesis';
import { offerKey, trustlineKey } from './keys';
import { INT64_MAX, addBalanceChecked, bigDivide, bigDivide128 } from './math';
import { newAccountEntry } from './ops/createAccount';
import {
  acquireLiabilities,
  bestOffer,
  compareOffers,
  createOfferEntry,
  eraseOfferEntry,
  exchangeV10WithoutPriceErrorThresholds,
  generateOfferId,
  offerLiabilities,
  releaseLiabilities,
} from './offers';
import { LedgerRoot } from './state';
import type { AccountEntry, OfferEntry, TrustLineEntry } from './types';

const seller = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const USD = { type: 'credit_alphanum4' as const, code: 'USD', issuer };

function offer(id: bigint, amount: bigint, n: number, d: number, selling: OfferEntry['selling'] = { type: 'native' }, buying: OfferEntry['buying'] = USD): OfferEntry {
  return { kind: 'offer', sellerId: seller, offerId: id, selling, buying, amount, price: { n, d }, flags: 0, lastModifiedLedgerSeq: 1 };
}

describe('math', () => {
  it('bigDivide rounds and detects overflow', () => {
    expect(bigDivide(7n, 3n, 2n, 'down')).toBe(10n);
    expect(bigDivide(7n, 3n, 2n, 'up')).toBe(11n);
    expect(bigDivide(INT64_MAX, 2n, 1n, 'down')).toBeNull();
    expect(bigDivide128(INT64_MAX * 3n, 3n, 'down')).toBe(INT64_MAX);
    expect(() => bigDivide(1n, 1n, 0n, 'down')).toThrow();
  });

  it('addBalanceChecked keeps balances within [0, max]', () => {
    expect(addBalanceChecked(5n, -5n)).toBe(0n);
    expect(addBalanceChecked(5n, -6n)).toBeNull();
    expect(addBalanceChecked(5n, 5n, 10n)).toBe(10n);
    expect(addBalanceChecked(5n, 6n, 10n)).toBeNull();
    expect(addBalanceChecked(INT64_MAX, 1n)).toBeNull();
  });
});

describe('offer liabilities (exchangeV10 without thresholds)', () => {
  it('matches stellar-core for simple prices', () => {
    expect(offerLiabilities(offer(1n, 50n, 1, 1))).toEqual({ selling: 50n, buying: 50n });
    expect(offerLiabilities(offer(1n, 50n, 2, 1))).toEqual({ selling: 50n, buying: 100n });
    // price 1/3: buying = floor(10 / 3) = 3, selling = ceil(3 * 3 / 1) = 9
    expect(offerLiabilities(offer(1n, 10n, 1, 3))).toEqual({ selling: 9n, buying: 3n });
    // price 3/2 (wheat more valuable): selling = 10, buying = floor(10 * 3 / 2) = 15
    expect(offerLiabilities(offer(1n, 10n, 3, 2))).toEqual({ selling: 10n, buying: 15n });
    expect(offerLiabilities(offer(1n, 1n, 1, 2))).toEqual({ selling: 0n, buying: 0n });
  });

  it('respects all limits and rounding modes', () => {
    const r = exchangeV10WithoutPriceErrorThresholds({ n: 3, d: 2 }, 100n, 40n, 100n, 100n, 'NORMAL');
    // The sheep side is smaller: wheatReceive limited by maxWheatReceive.
    expect(r.wheatStays).toBe(true);
    expect(r.numWheatReceived).toBe(40n);
    expect(r.numSheepSend).toBe(60n);
    const s = exchangeV10WithoutPriceErrorThresholds({ n: 1, d: 3 }, 100n, 1000n, 7n, 1000n, 'PATH_PAYMENT_STRICT_SEND');
    expect(s.wheatStays).toBe(true);
    expect(s.numSheepSend).toBe(7n);
    expect(s.numWheatReceived).toBe(21n);
  });
});

describe('offer helpers', () => {
  it('orders offers by price (double) then id', () => {
    const list = [offer(5n, 1n, 2, 1), offer(2n, 1n, 1, 3), offer(9n, 1n, 2, 6), offer(1n, 1n, 1, 1)];
    expect([...list].sort(compareOffers).map((o) => o.offerId)).toEqual([2n, 9n, 1n, 5n]);
  });

  it('acquire/release liabilities, create/erase entries and generate ids', () => {
    const acc = newAccountEntry(seller, 1000n, 1n, 1);
    const tl: TrustLineEntry = {
      kind: 'trustline',
      accountId: seller,
      asset: USD,
      balance: 0n,
      limit: 1000n,
      flags: 1,
      buyingLiabilities: 0n,
      sellingLiabilities: 0n,
      lastModifiedLedgerSeq: 1,
    };
    const header = { ...genesisHeader('offers'), baseReserve: 100 };
    const root = new LedgerRoot([acc, tl]);
    const ltx = root.begin(header, 2);
    const id = generateOfferId(ltx);
    expect(id).toBe(1n);
    expect(ltx.header.idPool).toBe(1n);
    const o = offer(id, 300n, 1, 2);
    expect(createOfferEntry(ltx, o)).toBe('SUCCESS');
    acquireLiabilities(ltx, o);
    let a = ltx.getAccount(seller)!;
    expect(a.numSubEntries).toBe(1);
    expect(a.sellingLiabilities).toBe(300n);
    expect((ltx.get(trustlineKey(seller, USD)) as TrustLineEntry).buyingLiabilities).toBe(150n);
    expect(bestOffer(ltx, { type: 'native' }, USD)!.offerId).toBe(1n);
    expect(bestOffer(ltx, { type: 'native' }, USD, () => true)).toBeUndefined();
    // Reserve: 1000 - 3 * 100 = 700 available minus 300 selling liabilities = 400; a 2nd offer needs 100.
    const o2 = offer(generateOfferId(ltx), 400n, 1, 1);
    expect(createOfferEntry(ltx, o2)).toBe('SUCCESS');
    expect(() => acquireLiabilities(ltx, o2)).toThrow();
    releaseLiabilities(ltx, o);
    eraseOfferEntry(ltx, o.offerId);
    eraseOfferEntry(ltx, o2.offerId);
    a = ltx.getAccount(seller)!;
    expect(a.numSubEntries).toBe(0);
    expect(a.sellingLiabilities).toBe(0n);
    expect(ltx.get(offerKey(1n))).toBeUndefined();
    ltx.commit();
    expect(root.size()).toBe(2);

    const poor: AccountEntry = { ...newAccountEntry(seller, 250n, 1n, 1) };
    const root2 = new LedgerRoot([poor]);
    const ltx2 = root2.begin(header, 2);
    expect(createOfferEntry(ltx2, offer(1n, 1n, 1, 1))).toBe('LOW_RESERVE');
    ltx2.rollback();
  });
});
