// Ledger entries: cloning, JSON serialization and the flat state hash
// (docs/ARCHITECTURE.md 5.6 and 5.7).

import { concatBytes, toHex, utf8 } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import { entryKey } from './keys';
import type {
  AccountEntry,
  Asset,
  ClaimPredicate,
  ClaimableBalanceEntry,
  DataEntry,
  Hash,
  LedgerEntry,
  LedgerKey,
  OfferEntry,
  SerializedEntry,
  TrustLineEntry,
} from './types';

// ---------------------------------------------------------------- cloning

function cloneAsset<T extends Asset>(a: T): T {
  return (a.type === 'native' ? { type: 'native' } : { type: a.type, code: a.code, issuer: a.issuer }) as T;
}

export function clonePredicate(p: ClaimPredicate): ClaimPredicate {
  switch (p.type) {
    case 'unconditional':
      return { type: 'unconditional' };
    case 'and':
    case 'or':
      return { type: p.type, predicates: [clonePredicate(p.predicates[0]), clonePredicate(p.predicates[1])] };
    case 'not':
      return { type: 'not', predicate: clonePredicate(p.predicate) };
    case 'beforeAbsoluteTime':
      return { type: 'beforeAbsoluteTime', time: p.time };
  }
}

/** Deep copy of an entry. */
export function cloneEntry<T extends LedgerEntry>(e: T): T {
  switch (e.kind) {
    case 'account':
      return {
        ...e,
        thresholds: { ...e.thresholds },
        signers: e.signers.map((s) => ({ key: s.key, weight: s.weight })),
      } as T;
    case 'trustline':
      return { ...e, asset: cloneAsset(e.asset) } as T;
    case 'offer':
      return { ...e, selling: cloneAsset(e.selling), buying: cloneAsset(e.buying), price: { ...e.price } } as T;
    case 'data':
      return { ...e } as T;
    case 'claimableBalance':
      return {
        ...e,
        asset: cloneAsset(e.asset),
        claimants: e.claimants.map((c) => ({ destination: c.destination, predicate: clonePredicate(c.predicate) })),
      } as T;
  }
}

// ---------------------------------------------------------------- JSON

/** JSON-safe deep copy: bigint becomes a decimal string. */
function toJsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) out[k] = toJsonSafe(x);
    }
    return out;
  }
  return v;
}

/** Entry to plain JSON (bigint fields become decimal strings). */
export function serializeEntry(e: LedgerEntry): SerializedEntry {
  return toJsonSafe(e) as SerializedEntry;
}

/** JSON with object keys sorted recursively and no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v}`);
  }
}

// ---------------------------------------------------------------- deserialization

class EntryFormatError extends Error {}

function fail(msg: string): never {
  throw new EntryFormatError(`malformed ledger entry: ${msg}`);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(`${what} is not an object`);
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') fail(`${k} is not a string`);
  return v;
}

function int(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(`${k} is not an integer`);
  return v;
}

function big(o: Record<string, unknown>, k: string): bigint {
  const v = o[k];
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) fail(`${k} is not a decimal string`);
  return BigInt(v);
}

function asset(v: unknown, what: string): Asset {
  const o = obj(v, what);
  if (o.type === 'native') return { type: 'native' };
  if (o.type !== 'credit_alphanum4' && o.type !== 'credit_alphanum12') fail(`${what}.type`);
  return { type: o.type, code: str(o, 'code'), issuer: str(o, 'issuer') };
}

function predicate(v: unknown, depth = 0): ClaimPredicate {
  if (depth > 8) fail('predicate too deep');
  const o = obj(v, 'predicate');
  switch (o.type) {
    case 'unconditional':
      return { type: 'unconditional' };
    case 'and':
    case 'or': {
      const ps = o.predicates;
      if (!Array.isArray(ps) || ps.length !== 2) fail('predicates');
      return { type: o.type, predicates: [predicate(ps[0], depth + 1), predicate(ps[1], depth + 1)] };
    }
    case 'not':
      return { type: 'not', predicate: predicate(o.predicate, depth + 1) };
    case 'beforeAbsoluteTime':
      return { type: 'beforeAbsoluteTime', time: big(o, 'time') };
    default:
      fail('predicate type');
  }
}

/** Inverse of serializeEntry. Throws on malformed input. */
export function deserializeEntry(s: SerializedEntry): LedgerEntry {
  const o = obj(s, 'entry');
  const lastModifiedLedgerSeq = int(o, 'lastModifiedLedgerSeq');
  switch (o.kind) {
    case 'account': {
      const th = obj(o.thresholds, 'thresholds');
      const signers = o.signers;
      if (!Array.isArray(signers)) fail('signers');
      const inflationDest = o.inflationDest;
      if (inflationDest !== null && typeof inflationDest !== 'string') fail('inflationDest');
      const e: AccountEntry = {
        kind: 'account',
        accountId: str(o, 'accountId'),
        balance: big(o, 'balance'),
        seqNum: big(o, 'seqNum'),
        numSubEntries: int(o, 'numSubEntries'),
        numSponsoring: int(o, 'numSponsoring'),
        numSponsored: int(o, 'numSponsored'),
        inflationDest: inflationDest as string | null,
        flags: int(o, 'flags'),
        homeDomain: str(o, 'homeDomain'),
        thresholds: { master: int(th, 'master'), low: int(th, 'low'), med: int(th, 'med'), high: int(th, 'high') },
        signers: signers.map((x) => {
          const so = obj(x, 'signer');
          return { key: str(so, 'key'), weight: int(so, 'weight') };
        }),
        buyingLiabilities: big(o, 'buyingLiabilities'),
        sellingLiabilities: big(o, 'sellingLiabilities'),
        seqLedger: int(o, 'seqLedger'),
        seqTime: big(o, 'seqTime'),
        lastModifiedLedgerSeq,
      };
      return e;
    }
    case 'trustline': {
      const a = asset(o.asset, 'asset');
      if (a.type === 'native') fail('trustline asset');
      const e: TrustLineEntry = {
        kind: 'trustline',
        accountId: str(o, 'accountId'),
        asset: a,
        balance: big(o, 'balance'),
        limit: big(o, 'limit'),
        flags: int(o, 'flags'),
        buyingLiabilities: big(o, 'buyingLiabilities'),
        sellingLiabilities: big(o, 'sellingLiabilities'),
        lastModifiedLedgerSeq,
      };
      return e;
    }
    case 'offer': {
      const p = obj(o.price, 'price');
      const e: OfferEntry = {
        kind: 'offer',
        sellerId: str(o, 'sellerId'),
        offerId: big(o, 'offerId'),
        selling: asset(o.selling, 'selling'),
        buying: asset(o.buying, 'buying'),
        amount: big(o, 'amount'),
        price: { n: int(p, 'n'), d: int(p, 'd') },
        flags: int(o, 'flags'),
        lastModifiedLedgerSeq,
      };
      return e;
    }
    case 'data': {
      const e: DataEntry = {
        kind: 'data',
        accountId: str(o, 'accountId'),
        name: str(o, 'name'),
        value: str(o, 'value'),
        lastModifiedLedgerSeq,
      };
      return e;
    }
    case 'claimableBalance': {
      const cs = o.claimants;
      if (!Array.isArray(cs)) fail('claimants');
      const e: ClaimableBalanceEntry = {
        kind: 'claimableBalance',
        balanceId: str(o, 'balanceId'),
        claimants: cs.map((c) => {
          const co = obj(c, 'claimant');
          return { destination: str(co, 'destination'), predicate: predicate(co.predicate) };
        }),
        asset: asset(o.asset, 'asset'),
        amount: big(o, 'amount'),
        flags: int(o, 'flags'),
        sponsor: str(o, 'sponsor'),
        lastModifiedLedgerSeq,
      };
      return e;
    }
    default:
      fail(`unknown kind ${String(o.kind)}`);
  }
}

// ---------------------------------------------------------------- hashing

const SEP = new Uint8Array([0]);

/** sha256(utf8(key) || 0x00 || utf8(canonicalJson(serializeEntry(e)))). */
export function entryHash(e: LedgerEntry, key: LedgerKey = entryKey(e)): Uint8Array {
  return sha256(concatBytes(utf8(key), SEP, utf8(canonicalJson(serializeEntry(e)))));
}

/** State hash from (key, entryHash) pairs; sorts by key (string order). */
export function stateHashFromEntryHashes(items: Iterable<[LedgerKey, Uint8Array]>): Hash {
  const arr = [...items].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // One buffer filled in a loop: spreading 3 parts per entry into one call
  // throws RangeError once the state has tens of thousands of entries.
  const keys = arr.map(([k]) => utf8(k));
  let len = 0;
  for (let i = 0; i < arr.length; i++) len += keys[i].length + SEP.length + arr[i][1].length;
  const buf = new Uint8Array(len);
  let off = 0;
  for (let i = 0; i < arr.length; i++) {
    buf.set(keys[i], off);
    off += keys[i].length;
    buf.set(SEP, off);
    off += SEP.length;
    buf.set(arr[i][1], off);
    off += arr[i][1].length;
  }
  return toHex(sha256(buf));
}

/** stateHash over a list of entries (docs/ARCHITECTURE.md 5.6). */
export function computeStateHash(entries: Iterable<LedgerEntry>): Hash {
  const items: [LedgerKey, Uint8Array][] = [];
  for (const e of entries) {
    const k = entryKey(e);
    items.push([k, entryHash(e, k)]);
  }
  return stateHashFromEntryHashes(items);
}
