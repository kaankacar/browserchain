// Ported from stellar-core (Apache-2.0): src/transactions/OfferExchange.cpp
// Exchange math for crossing offers: exchangeV10 with the price error
// thresholds, adjustOffer and exact price comparisons. Protocol 23 rounding
// (before the protocol 29 change in exchangeV10).
//
// Terms (see OfferExchange.h): the taker sends "sheep" and receives "wheat";
// the crossed offer sells wheat for sheep at `price` = sheep per wheat.

import { INT64_MAX } from '../math';
import {
  exchangeV10WithoutPriceErrorThresholds,
  type ExchangeResultV10,
  type ExchangeRounding,
} from '../offers';
import type { Price } from '../types';

export { exchangeV10WithoutPriceErrorThresholds };
export type { ExchangeResultV10, ExchangeRounding };

/**
 * checkPriceErrorBound: the effective price sheepSend / wheatReceive is
 * within 1% of `price`. With canFavorWheat, any error in favor of the wheat
 * seller is accepted.
 */
export function checkPriceErrorBound(price: Price, wheatReceive: bigint, sheepSend: bigint, canFavorWheat: boolean): boolean {
  const n = BigInt(price.n);
  const d = BigInt(price.d);
  const lhs = 100n * n * wheatReceive;
  const rhs = 100n * d * sheepSend;
  if (canFavorWheat && rhs > lhs) return true;
  const absDiff = lhs > rhs ? lhs - rhs : rhs - lhs;
  return absDiff <= n * wheatReceive;
}

/** applyPriceErrorThresholds */
export function applyPriceErrorThresholds(
  price: Price,
  wheatReceive: bigint,
  sheepSend: bigint,
  wheatStays: boolean,
  round: ExchangeRounding,
): ExchangeResultV10 {
  if (wheatReceive > 0n && sheepSend > 0n) {
    const wheatReceiveValue = wheatReceive * BigInt(price.n);
    const sheepSendValue = sheepSend * BigInt(price.d);
    // exchangeV10 favors the offer that stays in the book.
    if (wheatStays && sheepSendValue < wheatReceiveValue) throw new Error('favored sheep when wheat stays');
    if (!wheatStays && sheepSendValue > wheatReceiveValue) throw new Error('favored wheat when sheep stays');

    if (round === 'NORMAL') {
      // Both sides must get a price no more than 1% worse than the crossed price.
      if (!checkPriceErrorBound(price, wheatReceive, sheepSend, false)) {
        wheatReceive = 0n;
        sheepSend = 0n;
      }
    } else if (!checkPriceErrorBound(price, wheatReceive, sheepSend, true)) {
      throw new Error('exceeded price error bound');
    }
  } else if (round === 'PATH_PAYMENT_STRICT_SEND') {
    // Strict send may sell sheep for no wheat, but never send no sheep.
    if (sheepSend === 0n) throw new Error('invalid amount of sheep sent');
  } else {
    wheatReceive = 0n;
    sheepSend = 0n;
  }
  return { numWheatReceived: wheatReceive, numSheepSend: sheepSend, wheatStays };
}

/** exchangeV10: exchangeV10WithoutPriceErrorThresholds followed by applyPriceErrorThresholds. */
export function exchangeV10(
  price: Price,
  maxWheatSend: bigint,
  maxWheatReceive: bigint,
  maxSheepSend: bigint,
  maxSheepReceive: bigint,
  round: ExchangeRounding,
): ExchangeResultV10 {
  const r = exchangeV10WithoutPriceErrorThresholds(price, maxWheatSend, maxWheatReceive, maxSheepSend, maxSheepReceive, round);
  return applyPriceErrorThresholds(price, r.numWheatReceived, r.numSheepSend, r.wheatStays, round);
}

/**
 * adjustOffer: the amount an offer selling wheat can keep, given what its
 * seller can send and receive. Applying it to an adjusted offer has no effect.
 */
export function adjustOffer(price: Price, maxWheatSend: bigint, maxSheepReceive: bigint): bigint {
  return exchangeV10(price, maxWheatSend, INT64_MAX, INT64_MAX, maxSheepReceive, 'NORMAL').numWheatReceived;
}

// priceErrorBoundHoldsForFullClear
function priceErrorBoundHoldsForFullClear(price: Price, wheat: bigint): boolean {
  if (wheat <= 0n) return false;
  const prod = wheat * BigInt(price.n);
  return 100n * (prod % BigInt(price.d)) <= prod;
}

/**
 * offerCanClearForZero: a small offer that the price error threshold could
 * remove without a trade. Used by the overlay check before protocol 29.
 */
export function offerCanClearForZero(price: Price, amount: bigint): boolean {
  if (price.n <= price.d) return false;
  if (amount < 1n || amount > 100n) return false;
  const prod = amount * BigInt(price.n);
  return (
    priceErrorBoundHoldsForFullClear(price, amount) &&
    prod % BigInt(price.d) !== 0n &&
    !priceErrorBoundHoldsForFullClear(price, amount - 1n)
  );
}

// ---------------------------------------------------------------- prices

/** Exact price comparison (stellar-core Price operators): a.n * b.d vs a.d * b.n. */
export function comparePrices(a: Price, b: Price): number {
  const l = BigInt(a.n) * BigInt(b.d);
  const r = BigInt(a.d) * BigInt(b.n);
  return l < r ? -1 : l > r ? 1 : 0;
}

/** The inverse price (d/n). */
export function invertPrice(p: Price): Price {
  return { n: p.d, d: p.n };
}

/** A price is usable when both parts are positive int32 values. */
export function isPriceValid(p: Price): boolean {
  return Number.isInteger(p.n) && Number.isInteger(p.d) && p.n > 0 && p.d > 0 && p.n <= 0x7fffffff && p.d <= 0x7fffffff;
}
