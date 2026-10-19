// Decode Stellar XDR (base64 or hex) into plain JSON for display.
// Structs become objects, unions { armName: value } (or the arm name when
// void), enums their name, 64-bit ints decimal strings, keys StrKeys.

import { Asset, SignerKey, StrKey, encodeMuxedAccountToAddress, xdr } from '@stellar/stellar-sdk/base';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const XDR_TYPES = [
  'TransactionEnvelope',
  'TransactionResult',
  'LedgerHeader',
  'ScpEnvelope',
  'TransactionMeta',
  'TransactionResultPair',
  'TransactionSet',
  'StellarValue',
  'ScpQuorumSet',
  'LedgerEntry',
  'LedgerKey',
  'Operation',
  'Asset',
] as const;

export type XdrTypeName = (typeof XDR_TYPES)[number];

/** Types tried, in order, by detectXdrType. */
const DETECT_ORDER: XdrTypeName[] = [
  'TransactionEnvelope',
  'TransactionResult',
  'LedgerHeader',
  'ScpEnvelope',
  'TransactionMeta',
  'TransactionResultPair',
  'TransactionSet',
  'ScpQuorumSet',
  'StellarValue',
  'LedgerEntry',
  'LedgerKey',
];

interface XdrClass {
  fromXdr(input: string, format: 'hex' | 'base64'): unknown;
}

/** The classes of XDR_TYPES. Static references (not xdr[type]) keep the xdr namespace tree-shakable. */
const XDR_CLASSES: Record<XdrTypeName, XdrClass> = {
  TransactionEnvelope: xdr.TransactionEnvelope,
  TransactionResult: xdr.TransactionResult,
  LedgerHeader: xdr.LedgerHeader,
  ScpEnvelope: xdr.ScpEnvelope,
  TransactionMeta: xdr.TransactionMeta,
  TransactionResultPair: xdr.TransactionResultPair,
  TransactionSet: xdr.TransactionSet,
  StellarValue: xdr.StellarValue,
  ScpQuorumSet: xdr.ScpQuorumSet,
  LedgerEntry: xdr.LedgerEntry,
  LedgerKey: xdr.LedgerKey,
  Operation: xdr.Operation,
  Asset: xdr.Asset,
};

function xdrClass(type: XdrTypeName): XdrClass {
  const cls = XDR_CLASSES[type];
  if (!cls || typeof cls.fromXdr !== 'function') throw new Error(`Unknown XDR type ${type}`);
  return cls;
}

/** Accept base64 (default) or hex, ignoring whitespace. */
export function normalizeXdrInput(input: string): { data: string; format: 'base64' | 'hex' } {
  const s = input.replace(/\s+/g, '');
  if (!s) throw new Error('Paste some XDR first.');
  // XDR in base64 almost always has upper-case letters ("AAAA..."), so an
  // all-hex string is treated as hex.
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return { data: s.toLowerCase(), format: 'hex' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error('Input is neither base64 nor hex.');
  return { data: s, format: 'base64' };
}

export function parseXdr(type: XdrTypeName, input: string): unknown {
  const { data, format } = normalizeXdrInput(input);
  return xdrClass(type).fromXdr(data, format);
}

/** Decode to JSON. Throws a readable error. */
export function decodeXdr(type: XdrTypeName, input: string): Json {
  let value: unknown;
  try {
    value = parseXdr(type, input);
  } catch (err) {
    const msg = (err as Error).message.replace(/^XDR (Read )?Error: /, '');
    throw new Error(`Not a valid ${type}: ${msg}`);
  }
  return xdrToJson(value);
}

/** The first type the input decodes as (exactly, with no trailing bytes). */
export function detectXdrType(input: string): XdrTypeName | null {
  let norm: { data: string; format: 'base64' | 'hex' };
  try {
    norm = normalizeXdrInput(input);
  } catch {
    return null;
  }
  for (const t of DETECT_ORDER) {
    try {
      xdrClass(t).fromXdr(norm.data, norm.format);
      return t;
    } catch {
      // try the next type
    }
  }
  return null;
}

// ---------------------------------------------------------------- conversion
// js-xdr 5 values: XdrValue subclasses describe themselves with a static
// `schema` (struct, union or enum); opaque typedefs are BytesValues; XDR
// strings are XdrStrings; 64-bit ints are bigints.

/** A js-xdr 5 schema, as much of it as the walker reads. */
interface Schema {
  kind: string;
  name?: string;
  entries?: [string, unknown][];
  switchOn?: { kind: string; nameByValue?: ReadonlyMap<number, string> };
  cases?: { name: string; discriminant: number; arm: { kind: string; name?: string } }[];
}

function schemaOf(v: object): Schema | undefined {
  const c = (v as { constructor?: { schema?: Schema } }).constructor;
  return c?.schema;
}

const TEXT_FIELDS = new Set(['text', 'homeDomain', 'dataName', 'name', 'string', 'versionStr']);

function bytesToJson(b: Uint8Array, field: string | undefined): Json {
  if (field && TEXT_FIELDS.has(field)) {
    const s = new TextDecoder('utf-8', { fatal: false }).decode(b);
    if (/^[\x20-\x7e\u00a0-\uffff]*$/.test(s)) return s;
  }
  if (field === 'assetCode') {
    return new TextDecoder().decode(b).replace(/\0+$/, '');
  }
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
  return hex;
}

function tryStellarValue(b: Uint8Array): Json | undefined {
  try {
    return xdrToJson(xdr.StellarValue.fromXdr(b));
  } catch {
    return undefined;
  }
}

/** Convert any js-xdr value to JSON. `field` is the parent field name (for heuristics). */
export function xdrToJson(v: unknown, field?: string, parentType?: string): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof xdr.BytesValue) return xdrToJson(v.toBytes(), field, parentType);
  if (v instanceof xdr.XdrString) return bytesToJson(v.bytes, field);
  if (v instanceof Uint8Array) {
    // SCP values are opaque StellarValue XDR: show the decoded form next to the hex.
    if ((parentType === 'ScpBallot' && field === 'value') || (parentType === 'ScpNomination' && (field === 'votes' || field === 'accepted'))) {
      const decoded = tryStellarValue(v);
      if (decoded !== undefined) return { hex: bytesToJson(v, undefined), stellarValue: decoded };
    }
    return bytesToJson(v, field);
  }
  if (Array.isArray(v)) return v.map((x) => xdrToJson(x, field, parentType));
  if (typeof v !== 'object') return String(v);

  if (v instanceof xdr.EnumValue) return v.name;

  const schema = schemaOf(v);
  if (schema?.kind === 'union') return unionToJson(v as xdr.XdrValue, schema);
  if (schema?.kind === 'struct' && schema.entries) {
    const rec = v as unknown as Record<string, unknown>;
    const out: { [k: string]: Json } = {};
    for (const [k] of schema.entries) out[k] = xdrToJson(rec[k], k, schema.name);
    return out;
  }

  // Fallback: plain object.
  const out: { [k: string]: Json } = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = xdrToJson(val, k);
  return out;
}

/** The name the JSON shows for a union arm: the enum member, or "v<N>" when the union switches on an int. */
function armLabel(schema: Schema, c: { name: string; discriminant: number }): string {
  const sw = schema.switchOn;
  if (sw?.kind === 'enum') return sw.nameByValue?.get(c.discriminant) ?? c.name;
  if (sw?.kind === 'int32' || sw?.kind === 'uint32') return `v${c.discriminant}`;
  return c.name;
}

function unionToJson(u: xdr.XdrValue, schema: Schema): Json {
  try {
    switch (schema.name) {
      case 'PublicKey':
        return StrKey.encodeEd25519PublicKey((u as xdr.PublicKey).ed25519.toBytes());
      case 'MuxedAccount':
        return encodeMuxedAccountToAddress(u as xdr.MuxedAccount);
      case 'SignerKey':
        return SignerKey.encodeSignerKey(u as xdr.SignerKey);
      case 'Asset':
        return Asset.fromOperation(u as xdr.Asset).toString();
      default:
        break;
    }
  } catch {
    // fall through to the generic form
  }
  const type = (u as unknown as { type: string }).type;
  const c = schema.cases?.find((x) => x.name === type);
  if (!c) return type;
  const name = armLabel(schema, c);
  if (c.arm.kind === 'void' || !c.arm.name) return name;
  const val = (u as unknown as Record<string, unknown>)[c.arm.name];
  if (val === undefined) return name;
  return { [name]: xdrToJson(val, c.arm.name, schema.name) };
}

/** Pretty JSON text (2-space indent). */
export function jsonText(j: Json): string {
  return JSON.stringify(j, null, 2);
}
