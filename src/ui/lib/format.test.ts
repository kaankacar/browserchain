import { describe, expect, it } from 'vitest';
import {
  amountToStroops,
  assetKey,
  compareAmounts,
  formatAmount,
  formatAssetAmount,
  formatBallotCounter,
  formatCompact,
  formatDuration,
  formatNumber,
  formatTimeOfDay,
  formatUtc,
  groupDigits,
  humanizeCode,
  isHex64,
  middleEllipsis,
  opTypeLabel,
  parseAssetKey,
  resultTone,
  stroopsToAmount,
  timeAgo,
  tryAmountToStroops,
} from './format';

const ISSUER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

describe('middleEllipsis', () => {
  it('keeps short strings and shortens long ones', () => {
    expect(middleEllipsis('abc')).toBe('abc');
    expect(middleEllipsis('')).toBe('');
    expect(middleEllipsis(ISSUER)).toBe('GDVEU3…JCZA57');
    expect(middleEllipsis(ISSUER, 4, 4)).toBe('GDVE…ZA57');
    expect(middleEllipsis('0123456789abc', 6, 6)).toBe('0123456789abc');
  });
});

describe('numbers', () => {
  it('groups digits', () => {
    expect(groupDigits('1')).toBe('1');
    expect(groupDigits('1234')).toBe('1,234');
    expect(groupDigits('1234567')).toBe('1,234,567');
    expect(groupDigits('-1234567')).toBe('-1,234,567');
    expect(groupDigits('100000000000')).toBe('100,000,000,000');
  });
  it('formats numbers without locale differences', () => {
    expect(formatNumber(1284)).toBe('1,284');
    expect(formatNumber(3.14159, 2)).toBe('3.14');
    expect(formatNumber(-0.001, 2)).toBe('0.00');
    expect(formatNumber(Number.NaN)).toBe('–');
  });
  it('compacts large numbers', () => {
    expect(formatCompact(1284)).toBe('1,284');
    expect(formatCompact(12_900)).toBe('12.9K');
    expect(formatCompact(4_200_000)).toBe('4.2M');
    expect(formatCompact(1_000_000_000)).toBe('1B');
    expect(formatCompact(250_000)).toBe('250K');
    expect(formatCompact(3.456)).toBe('3.46');
    expect(formatCompact(-12_900)).toBe('-12.9K');
  });
  it('shows the infinite SCP ballot (UINT32_MAX) as ∞', () => {
    expect(formatBallotCounter(1)).toBe('1');
    expect(formatBallotCounter(1234)).toBe('1,234');
    expect(formatBallotCounter(4294967295)).toBe('∞');
  });
});

describe('amounts', () => {
  it('formats 7-decimal strings exactly', () => {
    expect(formatAmount('10000.0000000')).toBe('10,000');
    expect(formatAmount('12.5000000')).toBe('12.5');
    expect(formatAmount('0.0000001')).toBe('0.0000001');
    expect(formatAmount('100000000000.0000000')).toBe('100,000,000,000');
    expect(formatAmount('-3.2500000')).toBe('-3.25');
    expect(formatAmount('-0.0000000')).toBe('0');
    expect(formatAmount('7')).toBe('7');
  });
  it('truncates instead of rounding and pads when asked', () => {
    expect(formatAmount('1.9999999', { maxDecimals: 2 })).toBe('1.99');
    expect(formatAmount('5.0000000', { minDecimals: 2 })).toBe('5.00');
    expect(formatAmount('1234.5000000', { group: false, minDecimals: 2 })).toBe('1234.50');
  });
  it('passes through placeholders and junk', () => {
    expect(formatAmount(null)).toBe('–');
    expect(formatAmount('')).toBe('–');
    expect(formatAmount('abc')).toBe('abc');
  });
  it('adds asset codes', () => {
    expect(formatAssetAmount('2.5000000', { type: 'native', code: 'XLM' })).toBe('2.5 XLM');
    expect(formatAssetAmount('2.5000000', `USDB:${ISSUER}`)).toBe('2.5 USDB');
  });
  it('converts between strings and stroops', () => {
    expect(amountToStroops('12.5')).toBe(125_000_000n);
    expect(amountToStroops('0.0000001')).toBe(1n);
    expect(tryAmountToStroops('1.12345678')).toBeNull();
    expect(tryAmountToStroops('x')).toBeNull();
    expect(stroopsToAmount(125_000_000n)).toBe('12.5000000');
    expect(stroopsToAmount(-1n)).toBe('-0.0000001');
    expect(compareAmounts('10.0000000', '9.9999999')).toBe(1);
    expect(compareAmounts('1', '1.0000000')).toBe(0);
  });
});

describe('time', () => {
  it('formats durations', () => {
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(4980)).toBe('4.98 s');
    expect(formatDuration(12_340)).toBe('12.3 s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_723_000)).toBe('1h 02m');
    expect(formatDuration(3 * 86_400_000)).toBe('3d 0h');
    expect(formatDuration(-1)).toBe('–');
  });
  it('formats relative time', () => {
    const now = 1_790_000_000_000;
    expect(timeAgo(now - 500, now)).toBe('just now');
    expect(timeAgo(now - 4_200, now)).toBe('4s ago');
    expect(timeAgo(now - 3 * 60_000, now)).toBe('3m ago');
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(timeAgo(now - 5 * 86_400_000, now)).toBe('5d ago');
  });
  it('formats UTC timestamps', () => {
    expect(formatUtc(0)).toBe('1970-01-01 00:00:00 UTC');
    expect(formatUtc(1_790_000_000)).toBe('2026-09-21 14:13:20 UTC');
    expect(formatTimeOfDay(Date.UTC(2026, 9, 15, 14, 3, 22, 7), true)).toBe('14:03:22.007');
  });
});

describe('labels and codes', () => {
  it('labels operation types', () => {
    expect(opTypeLabel('manageSellOffer')).toBe('Manage sell offer');
    expect(opTypeLabel('createAccount')).toBe('Create account');
    expect(opTypeLabel('payment')).toBe('Payment');
    expect(opTypeLabel('pathPaymentStrictSend')).toBe('Path payment (strict send)');
  });
  it('maps result codes to tones and text', () => {
    expect(resultTone('txSUCCESS')).toBe('ok');
    expect(resultTone('PAYMENT_SUCCESS')).toBe('ok');
    expect(resultTone('txFAILED')).toBe('bad');
    expect(resultTone('PAYMENT_UNDERFUNDED')).toBe('bad');
    expect(resultTone('TRY_AGAIN_LATER')).toBe('warn');
    expect(resultTone(undefined)).toBe('neutral');
    expect(humanizeCode('PAYMENT_UNDERFUNDED')).toBe('Payment underfunded');
    expect(humanizeCode('txBAD_SEQ')).toBe('Bad sequence number');
    expect(humanizeCode('opNO_TRUST')).toBe('No trust');
  });
  it('round-trips asset keys', () => {
    expect(assetKey({ type: 'native', code: 'XLM' })).toBe('XLM');
    const usd = parseAssetKey(`USDB:${ISSUER}`);
    expect(usd).toEqual({ type: 'credit_alphanum4', code: 'USDB', issuer: ISSUER });
    expect(assetKey(usd)).toBe(`USDB:${ISSUER}`);
    expect(parseAssetKey(`LONGERCODE:${ISSUER}`).type).toBe('credit_alphanum12');
    expect(parseAssetKey('native').type).toBe('native');
    expect(() => parseAssetKey('USDB')).toThrow();
    expect(() => parseAssetKey('TOO-LONG-CODE!:GABC')).toThrow();
  });
  it('detects 64-hex hashes', () => {
    expect(isHex64('a'.repeat(64))).toBe(true);
    expect(isHex64('A'.repeat(64))).toBe(true);
    expect(isHex64('a'.repeat(63))).toBe(false);
  });
});
