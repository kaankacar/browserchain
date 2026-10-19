// Pure display helpers. No React, no DOM, no clock: callers pass "now".

import type { AssetView } from '../../node/api';

/** "GABCDEFGH...WXYZ" style shortening that keeps both ends. */
export function middleEllipsis(s: string, head = 6, tail = 6): string {
  if (!s) return '';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Group an unsigned integer string with commas: "1234567" -> "1,234,567". */
export function groupDigits(intStr: string): string {
  const neg = intStr.startsWith('-');
  const digits = neg ? intStr.slice(1) : intStr;
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
  }
  return (neg ? '-' : '') + out;
}

/** Integer or fixed-decimal number with grouping, locale independent. */
export function formatNumber(n: number, fractionDigits = 0): string {
  if (!Number.isFinite(n)) return '–';
  const fixed = Math.abs(n).toFixed(fractionDigits);
  const [int, frac] = fixed.split('.');
  const sign = n < 0 && Number(fixed) !== 0 ? '-' : '';
  return sign + groupDigits(int) + (frac ? `.${frac}` : '');
}

/** 1,284 / 12.9K / 4.2M / 1.1B. */
/** SCP ballot counter. UINT32_MAX is the infinite ballot of an externalized value (stellar-core). */
export function formatBallotCounter(n: number): string {
  return n === 0xffffffff ? '∞' : formatNumber(n);
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  // [show from, divide by, suffix]: thousands stay grouped up to 9,999.
  const units: [number, number, string][] = [
    [1e12, 1e12, 'T'],
    [1e9, 1e9, 'B'],
    [1e6, 1e6, 'M'],
    [1e4, 1e3, 'K'],
  ];
  for (const [from, v, suffix] of units) {
    if (abs >= from) {
      const scaled = abs / v;
      const digits = scaled >= 100 ? 0 : 1;
      const txt = scaled.toFixed(digits).replace(/\.0$/, '');
      return `${sign}${txt}${suffix}`;
    }
  }
  if (Number.isInteger(n)) return formatNumber(n);
  return formatNumber(n, abs < 10 ? 2 : 1);
}

export interface AmountFormatOptions {
  /** Max fraction digits shown (truncated, never rounded up). Default 7. */
  maxDecimals?: number;
  /** Always show at least this many fraction digits. Default 0. */
  minDecimals?: number;
  /** Thousands separators. Default true. */
  group?: boolean;
}

/**
 * Format a 7-decimal amount string from the API ("10000.0000000") for display.
 * Works on the string, so it never loses precision. Truncates extra digits.
 */
export function formatAmount(amount: string | null | undefined, opts: AmountFormatOptions = {}): string {
  if (amount === null || amount === undefined || amount === '') return '–';
  const { maxDecimals = 7, minDecimals = 0, group = true } = opts;
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return amount;
  const neg = m[1] === '-';
  const int = m[2].replace(/^0+(?=\d)/, '');
  let frac = (m[3] ?? '').slice(0, Math.max(0, maxDecimals));
  frac = frac.replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(Math.min(minDecimals, maxDecimals), '0');
  const isZero = /^0*$/.test(int) && /^0*$/.test(frac);
  const intOut = group ? groupDigits(int) : int;
  return `${neg && !isZero ? '-' : ''}${intOut}${frac ? `.${frac}` : ''}`;
}

/** Amount with an asset code suffix: "1,250.5 XLM". */
export function formatAssetAmount(amount: string, asset: AssetView | string, opts?: AmountFormatOptions): string {
  const code = typeof asset === 'string' ? assetCodeFromKey(asset) : asset.code;
  return `${formatAmount(amount, opts)} ${code}`;
}

/** Compare two 7-decimal amount strings numerically (exact). */
export function compareAmounts(a: string, b: string): number {
  const x = amountToStroops(a);
  const y = amountToStroops(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** "12.5" -> 125000000n. Returns null when the text is not a valid amount. */
export function tryAmountToStroops(text: string): bigint | null {
  const m = /^(-)?(\d+)(?:\.(\d{1,7}))?$/.exec(text.trim());
  if (!m) return null;
  const v = BigInt(m[2]) * 10_000_000n + BigInt((m[3] ?? '').padEnd(7, '0'));
  return m[1] ? -v : v;
}

export function amountToStroops(text: string): bigint {
  const v = tryAmountToStroops(text);
  if (v === null) throw new Error(`invalid amount: ${text}`);
  return v;
}

export function stroopsToAmount(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  return `${neg ? '-' : ''}${abs / 10_000_000n}.${(abs % 10_000_000n).toString().padStart(7, '0')}`;
}

/** Durations: 450 ms, 4.98 s, 1m 05s, 2h 03m. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
  }
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h < 48) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "just now", "4s ago", "3m ago", "2h ago", "5d ago". */
export function timeAgo(thenMs: number, nowMs: number): string {
  const d = nowMs - thenMs;
  if (!Number.isFinite(d)) return '–';
  if (d < 1500) return 'just now';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-10-15 14:03:22 UTC" from unix seconds. */
export function formatUtc(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '–';
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes(),
  )}:${pad2(d.getUTCSeconds())} UTC`;
}

/** "14:03:22.123" (local time unless utc). For log timestamps. */
export function formatTimeOfDay(ms: number, utc = false): string {
  const d = new Date(ms);
  const h = utc ? d.getUTCHours() : d.getHours();
  const m = utc ? d.getUTCMinutes() : d.getMinutes();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  const msPart = utc ? d.getUTCMilliseconds() : d.getMilliseconds();
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(msPart).padStart(3, '0')}`;
}

/** "manageSellOffer" -> "Manage sell offer". */
export function opTypeLabel(type: string): string {
  if (!type) return '';
  const special: Record<string, string> = {
    createPassiveSellOffer: 'Passive sell offer',
    pathPaymentStrictReceive: 'Path payment (strict receive)',
    pathPaymentStrictSend: 'Path payment (strict send)',
    setTrustLineFlags: 'Set trustline flags',
    clawbackClaimableBalance: 'Clawback claimable balance',
  };
  if (special[type]) return special[type];
  const words = type
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type Tone = 'ok' | 'bad' | 'warn' | 'neutral';

/** Tone of a tx or op result code. */
export function resultTone(code: string | null | undefined): Tone {
  if (!code) return 'neutral';
  if (code === 'txSUCCESS' || /_SUCCESS$/.test(code)) return 'ok';
  if (code === 'pending' || code === 'PENDING' || code === 'TRY_AGAIN_LATER') return 'warn';
  return 'bad';
}

/** "PAYMENT_UNDERFUNDED" -> "Payment underfunded"; "txBAD_SEQ" -> "Bad sequence". */
export function humanizeCode(code: string): string {
  const known: Record<string, string> = {
    txSUCCESS: 'Success',
    txFAILED: 'One or more operations failed',
    txBAD_SEQ: 'Bad sequence number',
    txBAD_AUTH: 'Missing or invalid signature',
    txBAD_AUTH_EXTRA: 'Unused signatures',
    txINSUFFICIENT_BALANCE: 'Insufficient balance for the fee',
    txINSUFFICIENT_FEE: 'Fee too low',
    txNO_ACCOUNT: 'Source account does not exist',
    txTOO_EARLY: 'Too early (time bounds)',
    txTOO_LATE: 'Too late (time bounds)',
    txMALFORMED: 'Malformed transaction',
    txNOT_SUPPORTED: 'Not supported on this network',
    txMISSING_OPERATION: 'No operations',
    opNO_ACCOUNT: 'Operation source account missing',
    opNOT_SUPPORTED: 'Operation not supported',
    opBAD_AUTH: 'Operation not authorized',
  };
  if (known[code]) return known[code];
  const body = code.replace(/^(tx|op)/, '');
  const words = body.replace(/_/g, ' ').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------- assets

export const NATIVE_ASSET: AssetView = { type: 'native', code: 'XLM' };

export function isNative(a: AssetView): boolean {
  return a.type === 'native';
}

/** "XLM" or "CODE:ISSUER" (stable key for maps and selects). */
export function assetKey(a: AssetView): string {
  return a.type === 'native' ? 'XLM' : `${a.code}:${a.issuer ?? ''}`;
}

export function assetCodeFromKey(key: string): string {
  if (key === 'XLM' || key === 'native') return 'XLM';
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
}

/** Parse "XLM" / "native" / "CODE:ISSUER". Throws on malformed input. */
export function parseAssetKey(key: string): AssetView {
  const k = key.trim();
  if (k === 'XLM' || k === 'native') return NATIVE_ASSET;
  const i = k.indexOf(':');
  if (i <= 0) throw new Error(`invalid asset: ${key}`);
  const code = k.slice(0, i);
  const issuer = k.slice(i + 1);
  if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) throw new Error(`invalid asset code: ${code}`);
  if (!/^G[A-Z2-7]{55}$/.test(issuer)) throw new Error(`invalid issuer: ${issuer}`);
  return { type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code, issuer };
}

export function sameAsset(a: AssetView, b: AssetView): boolean {
  return assetKey(a) === assetKey(b);
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${formatNumber(n)} ${n === 1 ? word : pluralWord}`;
}

/** First line of a value that may be long (for table cells). */
export function clampText(s: string, max = 64): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export const HEX64 = /^[0-9a-f]{64}$/;

export function isHex64(s: string): boolean {
  return HEX64.test(s.trim().toLowerCase());
}

/** Looks like a StrKey account id (G...). Use StrKey for a full checksum check. */
export function looksLikeAccountId(s: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(s);
}

/** Amount with 7 decimals where the details value is a plain number string. */
export function looksLikeAmount(s: string): boolean {
  return /^-?\d+\.\d{7}$/.test(s);
}
