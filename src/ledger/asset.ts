import type { Asset, CreditAsset } from './types';

export const NATIVE: Asset = { type: 'native' };

/** Canonical asset id: "native" or "CODE:ISSUER". */
export function assetId(a: Asset): string {
  return a.type === 'native' ? 'native' : `${a.code}:${a.issuer}`;
}

/** Display form: "XLM" or "CODE:ISSUER". */
export function assetLabel(a: Asset): string {
  return a.type === 'native' ? 'XLM' : `${a.code}:${a.issuer}`;
}

export function assetEquals(a: Asset, b: Asset): boolean {
  return assetId(a) === assetId(b);
}

export function creditAsset(code: string, issuer: string): CreditAsset {
  if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) throw new Error(`invalid asset code: ${code}`);
  return { type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code, issuer };
}

/** Parse "native" / "XLM" / "CODE:ISSUER". */
export function parseAssetId(id: string): Asset {
  if (id === 'native' || id === 'XLM') return NATIVE;
  const i = id.indexOf(':');
  if (i <= 0) throw new Error(`invalid asset id: ${id}`);
  return creditAsset(id.slice(0, i), id.slice(i + 1));
}
