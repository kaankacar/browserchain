// Amount helpers. On-ledger amounts are int64 stroops (bigint). Display
// amounts are decimal strings with 7 fraction digits, like Horizon.

export const STROOPS_PER_UNIT = 10_000_000n;
export const INT64_MAX = 9_223_372_036_854_775_807n;

export function formatAmount(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(7, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${frac}`;
}

/** Parse "12.5" or "0.0000001" into stroops. Throws on bad input or more than 7 decimals. */
export function parseAmount(text: string): bigint {
  const s = text.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,7}))?$/.exec(s);
  if (!m) throw new Error(`invalid amount: ${text}`);
  const whole = BigInt(m[2]);
  const frac = BigInt((m[3] ?? '').padEnd(7, '0'));
  const v = whole * STROOPS_PER_UNIT + frac;
  if (v > INT64_MAX) throw new Error(`amount too large: ${text}`);
  return m[1] ? -v : v;
}

/** Shorter display: trims trailing zeros ("10.5000000" -> "10.5"). */
export function prettyAmount(stroops: bigint): string {
  const s = formatAmount(stroops);
  return s.replace(/\.?0+$/, '') || '0';
}
