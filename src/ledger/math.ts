// Integer helpers for ledger arithmetic (int64 semantics on bigint).
// Ported from stellar-core (Apache-2.0): src/util/numeric.cpp, src/util/types.cpp

export const INT64_MAX = 9_223_372_036_854_775_807n;
export const INT64_MIN = -9_223_372_036_854_775_808n;
export const UINT64_MAX = 18_446_744_073_709_551_615n;
export const UINT32_MAX = 4_294_967_295;
export const INT32_MAX = 2_147_483_647;

export type Rounding = 'down' | 'up';

/** bigDivide: a * b / c with the given rounding. Null when the result does not fit in int64. */
export function bigDivide(a: bigint, b: bigint, c: bigint, round: Rounding): bigint | null {
  if (a < 0n || b < 0n || c <= 0n) throw new Error('bigDivide: invalid arguments');
  return bigDivide128(a * b, c, round);
}

export function bigDivideOrThrow(a: bigint, b: bigint, c: bigint, round: Rounding): bigint {
  const r = bigDivide(a, b, c, round);
  if (r === null) throw new Error('bigDivide overflow');
  return r;
}

/** bigDivide for a 128-bit numerator. Null when the result does not fit in int64. */
export function bigDivide128(x: bigint, c: bigint, round: Rounding): bigint | null {
  if (x < 0n || c <= 0n) throw new Error('bigDivide128: invalid arguments');
  let q = x / c;
  if (round === 'up' && q * c !== x) q += 1n;
  return q > INT64_MAX ? null : q;
}

export function bigDivide128OrThrow(x: bigint, c: bigint, round: Rounding): bigint {
  const r = bigDivide128(x, c, round);
  if (r === null) throw new Error('bigDivide128 overflow');
  return r;
}

/**
 * stellar::addBalance(int64& balance, int64 delta, int64 maxBalance):
 * the new balance, or null if it would leave [0, maxBalance].
 */
export function addBalanceChecked(balance: bigint, delta: bigint, maxBalance: bigint = INT64_MAX): bigint | null {
  if (balance < 0n || maxBalance < 0n) throw new Error('addBalance: invalid state');
  if (delta === 0n) return balance;
  const next = balance + delta;
  if (next < 0n || next > maxBalance) return null;
  return next;
}

export function minBig(...xs: bigint[]): bigint {
  let m = xs[0];
  for (const x of xs) if (x < m) m = x;
  return m;
}

export function maxBig(...xs: bigint[]): bigint {
  let m = xs[0];
  for (const x of xs) if (x > m) m = x;
  return m;
}
