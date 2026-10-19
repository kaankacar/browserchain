// Small helpers between @stellar/stellar-sdk/base XDR objects and ledger types.
// Ported from stellar-core (Apache-2.0): src/util/types.cpp (isAssetValid, isStringValid)

import { StrKey, encodeMuxedAccountToAddress, xdr } from '@stellar/stellar-sdk/base';
import { latin1, toHex, utf8 } from '../lib/bytes';
import type { Asset, CreditAsset } from './types';

/** Uint8Array (or a subclass) -> plain Uint8Array copy. */
export function u8(b: Uint8Array): Uint8Array {
  return new Uint8Array(b);
}

/** int64 / uint64 XDR value (a bigint in js-xdr 5) -> bigint. */
export function big(v: bigint | number | { toString(): string }): bigint {
  return typeof v === 'bigint' ? v : BigInt(v.toString());
}

/** bigint -> int64 field value (range checked). */
export function int64(v: bigint): bigint {
  return xdr.Int64(v);
}

/** bigint -> uint64 field value (range checked). */
export function uint64(v: bigint): bigint {
  return xdr.Uint64(v);
}

// ---------------------------------------------------------------- operations

/** An OperationBody arm, by its type name ("payment", "manageSellOffer", ...). */
export type OpBody<K extends xdr.OperationBody['type']> = Extract<xdr.OperationBody, { type: K }>;

/** The body of an operation of type `type`. Throws when the body is another arm. */
export function opBody<K extends xdr.OperationBody['type']>(op: { body: xdr.OperationBody }, type: K): OpBody<K> {
  if (op.body.type !== type) throw new Error(`expected a ${type} operation, got ${op.body.type}`);
  return op.body as OpBody<K>;
}

// ---------------------------------------------------------------- accounts

export function accountIdToString(a: xdr.AccountId): string {
  return StrKey.encodeEd25519PublicKey(a.ed25519.value);
}

export function accountIdFromString(g: string): xdr.AccountId {
  return xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(g));
}

/** Underlying G... account of a muxed account. */
export function muxedToAccountId(m: xdr.MuxedAccount): string {
  if (m.type === 'keyTypeMuxedEd25519') return StrKey.encodeEd25519PublicKey(m.med25519.ed25519.value);
  return StrKey.encodeEd25519PublicKey(m.ed25519.value);
}

/** M... for muxed accounts, G... otherwise. */
export function muxedToAddress(m: xdr.MuxedAccount): string {
  return encodeMuxedAccountToAddress(m);
}

export function isMuxed(m: xdr.MuxedAccount): boolean {
  return m.type === 'keyTypeMuxedEd25519';
}

export function muxedFromAccountId(g: string): xdr.MuxedAccount {
  return xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(g));
}

// ---------------------------------------------------------------- strings

/** An XDR string as js-xdr 5 decodes it (XdrString), or raw bytes, or a JS string. */
export type XdrStringLike = xdr.XdrString | Uint8Array | string;

/** isStringValid: no control characters and no bytes >= 0x80. */
export function isStringValid(b: XdrStringLike): boolean {
  for (const c of xdrStringBytes(b)) {
    if (c < 0x20 || c >= 0x7f) return false;
  }
  return true;
}

/** XDR string -> raw bytes (JS strings are encoded as UTF-8, like js-xdr does). */
export function xdrStringBytes(v: XdrStringLike): Uint8Array {
  if (typeof v === 'string') return utf8(v);
  if (v instanceof Uint8Array) return v;
  return v.bytes;
}

/** XDR string -> JS string (bytes read as latin1 so nothing is lost for ASCII). */
export function xdrStringToText(v: XdrStringLike): string {
  if (typeof v === 'string') return v;
  return latin1(xdrStringBytes(v));
}

/** XDR string -> UTF-8 text (for display of memos). */
export function xdrStringToUtf8(v: XdrStringLike): string {
  if (typeof v === 'string') return v;
  return new TextDecoder().decode(xdrStringBytes(v));
}

// ---------------------------------------------------------------- assets

/** Asset code bytes are valid: alphanumeric ASCII, zeros only trailing, at least `minChars` chars. */
function assetCodeValid(code: Uint8Array, minChars: number): boolean {
  let zeros = false;
  let chars = 0;
  for (const b of code) {
    if (b === 0) {
      zeros = true;
    } else if (zeros) {
      return false;
    } else {
      const alnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
      if (!alnum) return false;
      chars++;
    }
  }
  return chars >= minChars;
}

type AnyAsset = xdr.Asset | xdr.ChangeTrustAsset;

/** isAssetValid (pool share assets are not valid here). */
export function isXdrAssetValid(a: AnyAsset): boolean {
  switch (a.type) {
    case 'assetTypeNative':
      return true;
    case 'assetTypeCreditAlphanum4':
      return assetCodeValid(a.alphaNum4.assetCode.value, 1);
    case 'assetTypeCreditAlphanum12':
      return assetCodeValid(a.alphaNum12.assetCode.value, 5);
    default:
      return false;
  }
}

/** Code bytes -> string (up to the first zero byte). */
export function assetCodeToString(code: Uint8Array): string {
  let s = '';
  for (const b of code) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** XDR asset -> ledger asset. Call only on valid assets (codes are not re-checked). */
export function assetFromXdr(a: AnyAsset): Asset {
  switch (a.type) {
    case 'assetTypeNative':
      return { type: 'native' };
    case 'assetTypeCreditAlphanum4': {
      const x = a.alphaNum4;
      return { type: 'credit_alphanum4', code: assetCodeToString(x.assetCode.value), issuer: accountIdToString(x.issuer) };
    }
    case 'assetTypeCreditAlphanum12': {
      const x = a.alphaNum12;
      return { type: 'credit_alphanum12', code: assetCodeToString(x.assetCode.value), issuer: accountIdToString(x.issuer) };
    }
    default:
      throw new Error('unsupported asset type');
  }
}

/** Code string -> fixed-size code bytes (one byte per char, zero padded). */
function codeBytes(code: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < code.length && i < len; i++) out[i] = code.charCodeAt(i) & 0xff;
  return out;
}

/** Ledger asset -> XDR asset. */
export function assetToXdr(a: Asset): xdr.Asset {
  if (a.type === 'native') return xdr.Asset.assetTypeNative();
  if (a.type === 'credit_alphanum4') {
    return xdr.Asset.assetTypeCreditAlphanum4(
      new xdr.AlphaNum4({ assetCode: codeBytes(a.code, 4), issuer: accountIdFromString(a.issuer) }),
    );
  }
  return xdr.Asset.assetTypeCreditAlphanum12(
    new xdr.AlphaNum12({ assetCode: codeBytes(a.code, 12), issuer: accountIdFromString(a.issuer) }),
  );
}

/** Credit asset from an issuer and an AllowTrust AssetCode (getAsset). */
export function assetFromCode(issuer: string, code: xdr.AssetCode): { asset: CreditAsset; valid: boolean } {
  if (code.type === 'assetTypeCreditAlphanum4') {
    const raw = code.assetCode4.value;
    return {
      asset: { type: 'credit_alphanum4', code: assetCodeToString(raw), issuer },
      valid: assetCodeValid(raw, 1),
    };
  }
  const raw = code.assetCode12.value;
  return {
    asset: { type: 'credit_alphanum12', code: assetCodeToString(raw), issuer },
    valid: assetCodeValid(raw, 5),
  };
}

/** Readable asset from XDR even when invalid (for display). */
export function assetLabelFromXdr(a: AnyAsset): string {
  switch (a.type) {
    case 'assetTypeNative':
      return 'XLM';
    case 'assetTypeCreditAlphanum4':
      return `${assetCodeToString(a.alphaNum4.assetCode.value)}:${accountIdToString(a.alphaNum4.issuer)}`;
    case 'assetTypeCreditAlphanum12':
      return `${assetCodeToString(a.alphaNum12.assetCode.value)}:${accountIdToString(a.alphaNum12.issuer)}`;
    case 'assetTypePoolShare':
      return 'POOL_SHARE';
    default:
      return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------- signer keys

/** SignerKey -> StrKey (G..., T..., X..., P...). */
export function signerKeyToString(k: xdr.SignerKey): string {
  switch (k.type) {
    case 'signerKeyTypeEd25519':
      return StrKey.encodeEd25519PublicKey(k.ed25519.value);
    case 'signerKeyTypePreAuthTx':
      return StrKey.encodePreAuthTx(k.preAuthTx.value);
    case 'signerKeyTypeHashX':
      return StrKey.encodeSha256Hash(k.hashX.value);
    case 'signerKeyTypeEd25519SignedPayload':
      return StrKey.encodeSignedPayload(k.ed25519SignedPayload.toXdr());
    default:
      throw new Error('unknown signer key type');
  }
}

/** Claimable balance id XDR -> hex of the 32-byte hash. */
export function balanceIdToHex(id: xdr.ClaimableBalanceId): string {
  return toHex(id.v0.value);
}
