// Ported from stellar-core (Apache-2.0): src/transactions/test/ExchangeTests.cpp
// Exchange math tests with the values for protocol 23 (before the protocol 29
// rounding change).

import { describe, expect, it } from 'vitest';
import { INT64_MAX } from '../math';
import type { Price } from '../types';
import {
  adjustOffer,
  applyPriceErrorThresholds,
  checkPriceErrorBound,
  comparePrices,
  exchangeV10,
  invertPrice,
  isPriceValid,
  offerCanClearForZero,
} from './exchange';

const P = (n: number, d: number): Price => ({ n, d });
const b = (x: number | bigint) => BigInt(x);

describe('exchangeV10 (ExchangeTests.cpp)', () => {
  function favorsStayer(p: Price, wheatStays: boolean, wheatReceive: bigint, sheepSend: bigint) {
    if (wheatStays) expect(sheepSend * b(p.d) >= wheatReceive * b(p.n)).toBe(true);
    else expect(sheepSend * b(p.d) <= wheatReceive * b(p.n)).toBe(true);
  }

  it('is limited by maxWheatSend and maxSheepSend', () => {
    const check = (p: Price, maxWheatSend: number, maxSheepSend: number, wheatReceive: number, sheepSend: number) => {
      const r = exchangeV10(p, b(maxWheatSend), INT64_MAX, b(maxSheepSend), INT64_MAX, 'NORMAL');
      expect(r.wheatStays).toBe(maxWheatSend * p.n > maxSheepSend * p.d);
      expect(r.numWheatReceived).toBe(b(wheatReceive));
      expect(r.numSheepSend).toBe(b(sheepSend));
      favorsStayer(p, r.wheatStays, r.numWheatReceived, r.numSheepSend);
    };
    // price > 1: exact boundary, then between two values
    check(P(3, 2), 3000, 4501, 3000, 4500);
    check(P(3, 2), 3000, 4500, 3000, 4500);
    check(P(3, 2), 3000, 4499, 2999, 4499);
    check(P(3, 2), 2999, 4499, 2999, 4498);
    check(P(3, 2), 2999, 4498, 2998, 4497);
    // price < 1
    check(P(2, 3), 3000, 2001, 3000, 2000);
    check(P(2, 3), 3000, 2000, 3000, 2000);
    check(P(2, 3), 3000, 1999, 2998, 1999);
    check(P(2, 3), 2999, 2000, 2999, 1999);
    check(P(2, 3), 2999, 1999, 2998, 1999);
  });

  it('is limited by maxWheatReceive and maxSheepReceive (protocol < 29 values)', () => {
    const check = (p: Price, maxWheatReceive: number, maxSheepReceive: number, wheatReceive: number, sheepSend: number) => {
      const r = exchangeV10(p, INT64_MAX, b(maxWheatReceive), INT64_MAX, b(maxSheepReceive), 'NORMAL');
      expect(r.wheatStays).toBe(maxSheepReceive * p.d > maxWheatReceive * p.n);
      expect(r.numWheatReceived).toBe(b(wheatReceive));
      expect(r.numSheepSend).toBe(b(sheepSend));
      favorsStayer(p, r.wheatStays, r.numWheatReceived, r.numSheepSend);
    };
    check(P(3, 2), 3000, 4501, 3000, 4500);
    check(P(3, 2), 3000, 4500, 3000, 4500);
    check(P(3, 2), 3000, 4499, 2999, 4498);
    check(P(3, 2), 2999, 4499, 2999, 4499);
    check(P(3, 2), 2999, 4498, 2998, 4497); // protocol 29 would give 2999 / 4498
    check(P(2, 3), 3000, 2001, 3000, 2000);
    check(P(2, 3), 3000, 2000, 3000, 2000);
    check(P(2, 3), 3000, 1999, 2999, 1999);
    check(P(2, 3), 2999, 2000, 2998, 1999);
    check(P(2, 3), 2999, 1999, 2999, 1999);
  });

  it('is limited by maxWheatSend and maxWheatReceive', () => {
    const check = (p: Price, maxWheatSend: number, maxWheatReceive: number, wheatReceive: number, sheepSend: number) => {
      const r = exchangeV10(p, b(maxWheatSend), b(maxWheatReceive), INT64_MAX, INT64_MAX, 'NORMAL');
      expect(r.wheatStays).toBe(maxWheatSend > maxWheatReceive);
      expect([r.numWheatReceived, r.numSheepSend]).toEqual([b(wheatReceive), b(sheepSend)]);
      favorsStayer(p, r.wheatStays, r.numWheatReceived, r.numSheepSend);
    };
    check(P(3, 2), 3000, 3001, 3000, 4500);
    check(P(3, 2), 3000, 3000, 3000, 4500);
    check(P(3, 2), 3000, 2999, 2999, 4499);
    check(P(2, 3), 3000, 3001, 3000, 2000);
    check(P(2, 3), 3000, 3000, 3000, 2000);
    check(P(2, 3), 3000, 2999, 2998, 1999);
  });

  it('is limited by maxSheepSend and maxSheepReceive', () => {
    const check = (p: Price, maxSheepSend: number, maxSheepReceive: number, wheatReceive: number, sheepSend: number) => {
      const r = exchangeV10(p, INT64_MAX, INT64_MAX, b(maxSheepSend), b(maxSheepReceive), 'NORMAL');
      expect(r.wheatStays).toBe(maxSheepReceive > maxSheepSend);
      expect([r.numWheatReceived, r.numSheepSend]).toEqual([b(wheatReceive), b(sheepSend)]);
      favorsStayer(p, r.wheatStays, r.numWheatReceived, r.numSheepSend);
    };
    check(P(3, 2), 4500, 4501, 3000, 4500);
    check(P(3, 2), 4500, 4500, 3000, 4500);
    check(P(3, 2), 4500, 4499, 2999, 4498);
    check(P(2, 3), 2000, 2001, 3000, 2000);
    check(P(2, 3), 2000, 2000, 3000, 2000);
    check(P(2, 3), 2000, 1999, 2999, 1999);
  });

  it('exchanges nothing when the 1% price error threshold is exceeded', () => {
    const check = (maxWheatSend: number, maxWheatReceive: number, wheatReceive: number, sheepSend: number) => {
      const r = exchangeV10(P(3, 2), b(maxWheatSend), b(maxWheatReceive), INT64_MAX, INT64_MAX, 'NORMAL');
      expect(r.wheatStays).toBe(maxWheatSend > maxWheatReceive);
      expect([r.numWheatReceived, r.numSheepSend]).toEqual([b(wheatReceive), b(sheepSend)]);
    };
    check(28, 27, 0, 0);
    check(28, 26, 26, 39);
    check(52, 51, 51, 77);
    check(52, 50, 50, 75);
  });

  it('rounds for PATH_PAYMENT_STRICT_RECEIVE', () => {
    const check = (p: Price, maxWheatSend: number, maxWheatReceive: number, round: 'NORMAL' | 'PATH_PAYMENT_STRICT_RECEIVE', w: number, s: number) => {
      const r = exchangeV10(p, b(maxWheatSend), b(maxWheatReceive), INT64_MAX, INT64_MAX, round);
      expect(r.wheatStays).toBe(maxWheatSend > maxWheatReceive);
      expect([r.numWheatReceived, r.numSheepSend]).toEqual([b(w), b(s)]);
    };
    // no thresholding
    check(P(3, 2), 28, 27, 'NORMAL', 0, 0);
    check(P(3, 2), 28, 27, 'PATH_PAYMENT_STRICT_RECEIVE', 27, 41);
    // unchanged if wheat is more valuable
    check(P(3, 2), 150, 101, 'NORMAL', 101, 152);
    check(P(3, 2), 150, 101, 'PATH_PAYMENT_STRICT_RECEIVE', 101, 152);
    // transfer can increase if sheep is more valuable
    check(P(2, 3), 150, 101, 'NORMAL', 100, 67);
    check(P(2, 3), 150, 101, 'PATH_PAYMENT_STRICT_RECEIVE', 101, 68);
  });

  it('rounds for PATH_PAYMENT_STRICT_SEND', () => {
    const check = (
      p: Price,
      maxWheatSend: bigint,
      maxWheatReceive: bigint,
      maxSheepSend: bigint,
      round: 'NORMAL' | 'PATH_PAYMENT_STRICT_SEND',
      w: bigint,
      s: bigint,
    ) => {
      const r = exchangeV10(p, maxWheatSend, maxWheatReceive, maxSheepSend, INT64_MAX, round);
      if (maxWheatReceive === INT64_MAX) expect(r.wheatStays).toBe(true);
      else {
        const sv = maxSheepSend * b(p.d) < maxWheatReceive * b(p.n) ? maxSheepSend * b(p.d) : maxWheatReceive * b(p.n);
        expect(r.wheatStays).toBe(maxWheatSend * b(p.n) > sv);
      }
      expect([r.numWheatReceived, r.numSheepSend]).toEqual([w, s]);
    };
    check(P(3, 2), 28n, INT64_MAX, 41n, 'NORMAL', 0n, 0n);
    check(P(3, 2), 28n, INT64_MAX, 41n, 'PATH_PAYMENT_STRICT_SEND', 27n, 41n);
    // wheat more valuable
    expect(adjustOffer(P(3, 2), 97n, INT64_MAX)).toBe(97n);
    check(P(3, 2), 97n, INT64_MAX, 145n, 'NORMAL', 96n, 144n);
    check(P(3, 2), 97n, INT64_MAX, 145n, 'PATH_PAYMENT_STRICT_SEND', 96n, 145n);
    // sheep more valuable
    check(P(2, 3), 97n, 95n, INT64_MAX, 'NORMAL', 94n, 63n);
    check(P(2, 3), 97n, 95n, INT64_MAX, 'PATH_PAYMENT_STRICT_SEND', 95n, INT64_MAX);
    // can send something while receiving nothing
    check(P(2, 1), 1n, INT64_MAX, 1n, 'NORMAL', 0n, 0n);
    check(P(2, 1), 1n, INT64_MAX, 1n, 'PATH_PAYMENT_STRICT_SEND', 0n, 1n);
  });

  it('keeps every result within its limits (exhaustive small values)', () => {
    const rounds = ['NORMAL', 'PATH_PAYMENT_STRICT_RECEIVE'] as const;
    for (const p of [P(1, 1), P(3, 2), P(2, 3), P(7, 3), P(1, 100), P(97, 13)]) {
      for (let ws = 1n; ws <= 12n; ws++) {
        for (let wr = 1n; wr <= 12n; wr++) {
          for (const ss of [1n, 5n, 17n, INT64_MAX]) {
            for (const round of rounds) {
              // Path payments only cross offers that adjustOffer left unchanged.
              if (round !== 'NORMAL' && adjustOffer(p, ws, INT64_MAX) !== ws) continue;
              const r = exchangeV10(p, ws, wr, ss, INT64_MAX, round);
              expect(r.numWheatReceived >= 0n && r.numWheatReceived <= (ws < wr ? ws : wr)).toBe(true);
              expect(r.numSheepSend >= 0n && r.numSheepSend <= ss).toBe(true);
              // Zero on one side means zero on both outside strict send.
              expect(r.numWheatReceived === 0n).toBe(r.numSheepSend === 0n);
              if (r.numWheatReceived > 0n) favorsStayer(p, r.wheatStays, r.numWheatReceived, r.numSheepSend);
            }
          }
        }
      }
    }
  });
});

describe('adjustOffer (ExchangeTests.cpp "Adjust Offer")', () => {
  it('applies the limits', () => {
    expect(adjustOffer(P(1, 1000), 2001n, INT64_MAX)).toBe(2000n);
    expect(adjustOffer(P(1, 1000), 2000n, INT64_MAX)).toBe(2000n);
    expect(adjustOffer(P(1, 1000), 1999n, INT64_MAX)).toBe(1000n);
    expect(adjustOffer(P(1, 1000), 2000n, 3n)).toBe(2000n);
    expect(adjustOffer(P(1, 1000), 2000n, 2n)).toBe(2000n);
    expect(adjustOffer(P(1, 1000), 2000n, 1n)).toBe(1000n);
    expect(adjustOffer(P(1000, 1), 401n, INT64_MAX)).toBe(401n);
    expect(adjustOffer(P(1000, 1), 400n, INT64_MAX)).toBe(400n);
    expect(adjustOffer(P(1000, 1), 399n, INT64_MAX)).toBe(399n);
    expect(adjustOffer(P(1000, 1), 400n, 400n * 1000n + 1n)).toBe(400n);
    expect(adjustOffer(P(1000, 1), 400n, 400n * 1000n)).toBe(400n);
    expect(adjustOffer(P(1000, 1), 400n, 400n * 1000n - 1n)).toBe(399n);
  });

  it('has no effect on an adjusted offer', () => {
    const twice = (p: Price, maxWheatSend: bigint, maxSheepReceive: bigint, expected: bigint) => {
      expect(adjustOffer(p, maxWheatSend, maxSheepReceive)).toBe(expected);
      expect(adjustOffer(p, expected, maxSheepReceive)).toBe(expected);
    };
    twice(P(7, 3), 429n, INT64_MAX, 429n);
    twice(P(7, 3), 428n, INT64_MAX, 428n);
    twice(P(7, 3), 427n, INT64_MAX, 427n);
    twice(P(7, 3), 428n, 999n, 428n);
    twice(P(7, 3), 428n, 997n, 427n);
    twice(P(7, 3), 428n, 998n, 427n); // protocol 29 would give 428
    twice(P(3, 7), 1001n, INT64_MAX, 1001n);
    twice(P(3, 7), 1000n, INT64_MAX, 999n);
    twice(P(3, 7), 999n, INT64_MAX, 999n);
    twice(P(3, 7), 1000n, 429n, 999n);
    twice(P(3, 7), 1000n, 428n, 999n);
    twice(P(3, 7), 1000n, 427n, 997n);
  });

  it('removes small offers that do not meet the thresholds', () => {
    expect(adjustOffer(P(3, 2), 29n, INT64_MAX)).toBe(0n);
    expect(adjustOffer(P(3, 2), 28n, INT64_MAX)).toBe(28n);
    expect(adjustOffer(P(3, 2), 27n, INT64_MAX)).toBe(0n);
    expect(adjustOffer(P(3, 2), 26n, INT64_MAX)).toBe(26n);
    expect(adjustOffer(P(3, 2), 51n, INT64_MAX)).toBe(51n);
    expect(adjustOffer(P(3, 2), 50n, INT64_MAX)).toBe(50n);
  });
});

describe('price error bounds (ExchangeTests.cpp)', () => {
  it('accepts at most 1% error, unbounded in favor of wheat when allowed', () => {
    const validate = (p: Price, wheatReceive: bigint, high: bigint, low: bigint, canFavorWheat: boolean) => {
      expect(checkPriceErrorBound(p, wheatReceive, high + 1n, canFavorWheat)).toBe(canFavorWheat);
      expect(checkPriceErrorBound(p, wheatReceive, high, canFavorWheat)).toBe(true);
      expect(checkPriceErrorBound(p, wheatReceive, low, canFavorWheat)).toBe(true);
      expect(checkPriceErrorBound(p, wheatReceive, low - 1n, canFavorWheat)).toBe(false);
    };
    for (const canFavorWheat of [false, true]) {
      validate(P(1, 1), 1000n, 1010n, 990n, canFavorWheat);
      validate(P(5, 2), 1000n, 2525n, 2475n, canFavorWheat);
      validate(P(2, 5), 1000n, 404n, 396n, canFavorWheat);
      validate(P(7, 3), 1000n, 2356n, 2310n, canFavorWheat);
      validate(P(3, 7), 1000n, 432n, 425n, canFavorWheat);
    }
  });

  it('applyPriceErrorThresholds rejects results that favor the wrong side and invalid strict send results', () => {
    // wheat stays but sheep is favored
    expect(() => applyPriceErrorThresholds(P(1, 1), 10n, 9n, true, 'NORMAL')).toThrow(/favored sheep/);
    // sheep stays but wheat is favored
    expect(() => applyPriceErrorThresholds(P(1, 1), 10n, 11n, false, 'NORMAL')).toThrow(/favored wheat/);
    // path payments may favor the wheat seller without bound, but not the sheep seller by more than 1%
    expect(applyPriceErrorThresholds(P(1, 1), 10n, 20n, true, 'PATH_PAYMENT_STRICT_RECEIVE').numSheepSend).toBe(20n);
    expect(() => applyPriceErrorThresholds(P(1, 1), 1000n, 980n, false, 'PATH_PAYMENT_STRICT_SEND')).toThrow(/price error/);
    // strict send can never send no sheep
    expect(() => applyPriceErrorThresholds(P(1, 1), 0n, 0n, true, 'PATH_PAYMENT_STRICT_SEND')).toThrow(/sheep/);
    expect(applyPriceErrorThresholds(P(1, 1), 0n, 5n, true, 'PATH_PAYMENT_STRICT_SEND')).toEqual({ numWheatReceived: 0n, numSheepSend: 5n, wheatStays: true });
    // outside strict send, one side zero means no exchange
    expect(applyPriceErrorThresholds(P(1, 1), 0n, 5n, true, 'NORMAL')).toEqual({ numWheatReceived: 0n, numSheepSend: 0n, wheatStays: true });
  });
});

describe('price helpers', () => {
  it('compares prices exactly', () => {
    expect(comparePrices(P(1, 3), P(2, 6))).toBe(0);
    expect(comparePrices(P(1, 3), P(1, 2))).toBe(-1);
    expect(comparePrices(P(2147483647, 2147483646), P(2147483646, 2147483645))).toBe(-1);
    expect(comparePrices(P(2147483647, 1), P(1, 2147483647))).toBe(1);
    expect(invertPrice(P(3, 7))).toEqual(P(7, 3));
    expect(isPriceValid(P(1, 1))).toBe(true);
    expect(isPriceValid(P(0, 1))).toBe(false);
    expect(isPriceValid(P(1, -1))).toBe(false);
  });

  it('offerCanClearForZero finds the smallest amounts that meet the full-clear bound', () => {
    // 20 * 5/3 = 33.33: the full clear is within 1%, 19 is not.
    expect(offerCanClearForZero(P(5, 3), 20n)).toBe(true);
    expect(offerCanClearForZero(P(5, 3), 19n)).toBe(false);
    expect(offerCanClearForZero(P(5, 3), 21n)).toBe(false); // exact product
    expect(offerCanClearForZero(P(101, 100), 1n)).toBe(true);
    expect(offerCanClearForZero(P(101, 100), 2n)).toBe(false);
    for (let a = 0n; a <= 100n; a++) expect(offerCanClearForZero(P(3, 2), a)).toBe(false);
    expect(offerCanClearForZero(P(2, 3), 20n)).toBe(false); // price <= 1
    expect(offerCanClearForZero(P(5, 3), 101n)).toBe(false); // above 100
    expect(offerCanClearForZero(P(5, 3), 0n)).toBe(false);
  });
});
