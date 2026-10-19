// Offer helpers shared by the ledger core and the DEX: liabilities, offer
// entry creation/removal with sub-entry counting, and order book ordering.
// Ported from stellar-core (Apache-2.0): src/transactions/OfferExchange.cpp,
// src/transactions/TransactionUtils.cpp

import { assetEquals } from './asset';
import { addBuyingLiabilities, addSellingLiabilities, createSubentry, loadTrustLine, removeSubentry } from './balances';
import type { SponsorshipResult } from './balances';
import { accountKey, offerKey } from './keys';
import { INT64_MAX, bigDivide128OrThrow, bigDivideOrThrow, minBig } from './math';
import type { LedgerTxn } from './state';
import type { AccountEntry, Asset, OfferEntry, Price } from './types';

export type ExchangeRounding = 'NORMAL' | 'PATH_PAYMENT_STRICT_RECEIVE' | 'PATH_PAYMENT_STRICT_SEND';

export interface ExchangeResultV10 {
  numWheatReceived: bigint;
  numSheepSend: bigint;
  wheatStays: boolean;
}

// calculateOfferValue: min(maxSend * priceN, maxReceive * priceD) (128-bit).
function calculateOfferValue(priceN: bigint, priceD: bigint, maxSend: bigint, maxReceive: bigint): bigint {
  return minBig(maxSend * priceN, maxReceive * priceD);
}

/**
 * exchangeV10WithoutPriceErrorThresholds, as in protocol 23 (before the
 * protocol 29 rounding change).
 */
export function exchangeV10WithoutPriceErrorThresholds(
  price: Price,
  maxWheatSend: bigint,
  maxWheatReceive: bigint,
  maxSheepSend: bigint,
  maxSheepReceive: bigint,
  round: ExchangeRounding,
): ExchangeResultV10 {
  const n = BigInt(price.n);
  const d = BigInt(price.d);
  const wheatValue = calculateOfferValue(n, d, maxWheatSend, maxSheepReceive);
  const sheepValue = calculateOfferValue(d, n, maxSheepSend, maxWheatReceive);
  const wheatStays = wheatValue > sheepValue;

  let wheatReceive: bigint;
  let sheepSend: bigint;
  if (wheatStays) {
    if (round === 'PATH_PAYMENT_STRICT_SEND') {
      wheatReceive = bigDivide128OrThrow(sheepValue, n, 'down');
      sheepSend = minBig(maxSheepSend, maxSheepReceive);
    } else if (n > d || round === 'PATH_PAYMENT_STRICT_RECEIVE') {
      wheatReceive = bigDivide128OrThrow(sheepValue, n, 'down');
      sheepSend = bigDivideOrThrow(wheatReceive, n, d, 'up');
    } else {
      sheepSend = bigDivide128OrThrow(sheepValue, d, 'down');
      wheatReceive = bigDivideOrThrow(sheepSend, d, n, 'down');
    }
  } else if (n > d) {
    wheatReceive = bigDivide128OrThrow(wheatValue, n, 'down');
    sheepSend = bigDivideOrThrow(wheatReceive, n, d, 'down');
  } else {
    sheepSend = bigDivide128OrThrow(wheatValue, d, 'down');
    wheatReceive = bigDivideOrThrow(sheepSend, d, n, 'up');
  }

  if (wheatReceive < 0n || wheatReceive > minBig(maxWheatReceive, maxWheatSend)) {
    throw new Error('wheatReceive out of bounds');
  }
  if (sheepSend < 0n || sheepSend > minBig(maxSheepReceive, maxSheepSend)) {
    throw new Error('sheepSend out of bounds');
  }
  return { numWheatReceived: wheatReceive, numSheepSend: sheepSend, wheatStays };
}

/** Liabilities of an offer: selling = amount it can sell, buying = amount it can receive. */
export function offerLiabilities(o: Pick<OfferEntry, 'price' | 'amount'>): { selling: bigint; buying: bigint } {
  const r = exchangeV10WithoutPriceErrorThresholds(o.price, o.amount, INT64_MAX, INT64_MAX, INT64_MAX, 'NORMAL');
  return { selling: r.numWheatReceived, buying: r.numSheepSend };
}

/** getOfferBuyingLiabilities */
export function offerBuyingLiabilities(o: Pick<OfferEntry, 'price' | 'amount'>): bigint {
  return offerLiabilities(o).buying;
}

/** getOfferSellingLiabilities */
export function offerSellingLiabilities(o: Pick<OfferEntry, 'price' | 'amount'>): bigint {
  return offerLiabilities(o).selling;
}

// acquireOrReleaseLiabilities: throws when the seller's lines cannot hold them (a bug).
function acquireOrRelease(ltx: LedgerTxn, offer: Readonly<OfferEntry>, isAcquire: boolean): void {
  if (assetEquals(offer.buying, offer.selling)) throw new Error('buying and selling same asset');
  const { buying, selling } = offerLiabilities(offer);
  const sign = isAcquire ? 1n : -1n;
  const header = ltx.header;
  const seller = offer.sellerId;

  if (offer.buying.type === 'native') {
    const acc = ltx.loadAccount(seller);
    if (!acc) throw new Error('account does not exist');
    if (!addBuyingLiabilities(header, acc, sign * buying)) throw new Error('could not add buying liabilities');
  } else {
    const line = loadTrustLine(ltx, seller, offer.buying);
    if (!line) throw new Error('trustline does not exist');
    if (!line.addBuyingLiabilities(header, sign * buying)) throw new Error('could not add buying liabilities');
  }

  if (offer.selling.type === 'native') {
    const acc = ltx.loadAccount(seller);
    if (!acc) throw new Error('account does not exist');
    if (!addSellingLiabilities(header, acc, sign * selling)) throw new Error('could not add selling liabilities');
  } else {
    const line = loadTrustLine(ltx, seller, offer.selling);
    if (!line) throw new Error('trustline does not exist');
    if (!line.addSellingLiabilities(header, sign * selling)) throw new Error('could not add selling liabilities');
  }
}

/** acquireLiabilities: add the offer's liabilities to the seller's account/trustlines. */
export function acquireLiabilities(ltx: LedgerTxn, offer: Readonly<OfferEntry>): void {
  acquireOrRelease(ltx, offer, true);
}

/** releaseLiabilities: remove the offer's liabilities from the seller's account/trustlines. */
export function releaseLiabilities(ltx: LedgerTxn, offer: Readonly<OfferEntry>): void {
  acquireOrRelease(ltx, offer, false);
}

/** generateID: next offer id from the header's idPool. */
export function generateOfferId(ltx: LedgerTxn): bigint {
  ltx.header.idPool += 1n;
  return ltx.header.idPool;
}

/**
 * Create an offer entry, counting it as a sub-entry of the seller (checks the
 * sub-entry limit and reserve). Does not touch liabilities.
 */
export function createOfferEntry(ltx: LedgerTxn, offer: OfferEntry): SponsorshipResult {
  const seller = ltx.loadAccount(offer.sellerId);
  if (!seller) throw new Error('seller does not exist');
  const r = createSubentry(ltx.header, seller, 1);
  if (r !== 'SUCCESS') return r;
  ltx.create(offer);
  return 'SUCCESS';
}

/** Erase an offer entry and release its sub-entry. Does not touch liabilities. */
export function eraseOfferEntry(ltx: LedgerTxn, offerId: bigint): void {
  const key = offerKey(offerId);
  const offer = ltx.get(key) as Readonly<OfferEntry> | undefined;
  if (!offer) throw new Error(`offer ${offerId} does not exist`);
  const seller = ltx.load(accountKey(offer.sellerId)) as AccountEntry | undefined;
  if (!seller) throw new Error('seller does not exist');
  removeSubentry(seller, 1);
  ltx.erase(key);
}

/**
 * removeOffersByAccountAndAsset: delete every offer of `accountId` buying or
 * selling `asset`, releasing liabilities and sub-entries (used when
 * authorization is revoked).
 */
export function removeOffersByAccountAndAsset(ltx: LedgerTxn, accountId: string, asset: Asset): void {
  const offers = ltx
    .offersOf(accountId)
    .filter((o) => assetEquals(o.buying, asset) || assetEquals(o.selling, asset))
    .map((o) => o.offerId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of offers) {
    const offer = ltx.get(offerKey(id)) as Readonly<OfferEntry>;
    releaseLiabilities(ltx, offer);
    eraseOfferEntry(ltx, id);
  }
}

/**
 * Order book order (stellar-core isBetterOffer): lower price first, compared
 * as double n/d, then lower offer id.
 */
export function compareOffers(a: Readonly<OfferEntry>, b: Readonly<OfferEntry>): number {
  const pa = a.price.n / a.price.d;
  const pb = b.price.n / b.price.d;
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
}

/** Best offer selling `selling` for `buying`, or undefined. Optional filter skips offers. */
export function bestOffer(
  ltx: LedgerTxn,
  selling: Asset,
  buying: Asset,
  skip?: (o: Readonly<OfferEntry>) => boolean,
): Readonly<OfferEntry> | undefined {
  let best: Readonly<OfferEntry> | undefined;
  for (const o of ltx.offersByPair(selling, buying)) {
    if (skip && skip(o)) continue;
    if (!best || compareOffers(o, best) < 0) best = o;
  }
  return best;
}
