import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { concatBytes, toHex, utf8 } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import {
  canonicalJson,
  cloneEntry,
  computeStateHash,
  deserializeEntry,
  entryHash,
  serializeEntry,
} from './entries';
import { entryKey } from './keys';
import { newAccountEntry } from './ops/createAccount';
import { LedgerRoot } from './state';
import type { ClaimableBalanceEntry, DataEntry, LedgerEntry, OfferEntry, TrustLineEntry } from './types';

const A = Keypair.random().publicKey();
const B = Keypair.random().publicKey();

export function sampleEntries(): LedgerEntry[] {
  const acc = newAccountEntry(A, 123_4567890n, 5n << 32n, 7);
  acc.signers = [{ key: B, weight: 3 }];
  acc.homeDomain = 'example.com';
  acc.inflationDest = B;
  acc.sellingLiabilities = 10n;
  acc.seqTime = 1_790_000_000n;
  acc.seqLedger = 9;
  const tl: TrustLineEntry = {
    kind: 'trustline',
    accountId: A,
    asset: { type: 'credit_alphanum4', code: 'USD', issuer: B },
    balance: 5n,
    limit: 9_223_372_036_854_775_807n,
    flags: 1,
    buyingLiabilities: 2n,
    sellingLiabilities: 3n,
    lastModifiedLedgerSeq: 3,
  };
  const offer: OfferEntry = {
    kind: 'offer',
    sellerId: A,
    offerId: 42n,
    selling: { type: 'native' },
    buying: { type: 'credit_alphanum12', code: 'LONGCODE', issuer: B },
    amount: 100n,
    price: { n: 3, d: 7 },
    flags: 1,
    lastModifiedLedgerSeq: 4,
  };
  const data: DataEntry = { kind: 'data', accountId: A, name: 'k:ey', value: 'AAEC', lastModifiedLedgerSeq: 5 };
  const cb: ClaimableBalanceEntry = {
    kind: 'claimableBalance',
    balanceId: 'ab'.repeat(32),
    claimants: [
      {
        destination: B,
        predicate: {
          type: 'and',
          predicates: [
            { type: 'not', predicate: { type: 'beforeAbsoluteTime', time: 100n } },
            { type: 'or', predicates: [{ type: 'unconditional' }, { type: 'beforeAbsoluteTime', time: 5n }] },
          ],
        },
      },
    ],
    asset: { type: 'native' },
    amount: 77n,
    flags: 0,
    sponsor: A,
    lastModifiedLedgerSeq: 6,
  };
  return [acc, tl, offer, data, cb];
}

describe('canonicalJson', () => {
  it('sorts keys recursively without whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}',
    );
  });

  it('escapes strings like JSON and rejects bigint', () => {
    expect(canonicalJson({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
    expect(() => canonicalJson({ x: 1n })).toThrow();
  });
});

describe('entry serialization', () => {
  it('round trips every entry kind', () => {
    for (const e of sampleEntries()) {
      const s = serializeEntry(e);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
      expect(deserializeEntry(JSON.parse(JSON.stringify(s)))).toEqual(e);
    }
  });

  it('turns bigint fields into decimal strings', () => {
    const s = serializeEntry(sampleEntries()[0]) as Record<string, unknown>;
    expect(s.balance).toBe('1234567890');
    expect(s.seqNum).toBe((5n << 32n).toString());
    expect(s.numSubEntries).toBe(0);
  });

  it('rejects malformed entries', () => {
    expect(() => deserializeEntry({ kind: 'account' })).toThrow();
    expect(() => deserializeEntry({ kind: 'bogus', lastModifiedLedgerSeq: 1 })).toThrow();
    const s = serializeEntry(sampleEntries()[1]) as Record<string, unknown>;
    expect(() => deserializeEntry({ ...s, balance: 5 })).toThrow();
  });

  it('cloneEntry is a deep copy', () => {
    const [acc, , offer, , cb] = sampleEntries();
    const c = cloneEntry(acc);
    expect(c).toEqual(acc);
    if (c.kind === 'account') {
      c.signers[0].weight = 9;
      c.thresholds.low = 9;
    }
    expect(acc.kind === 'account' && acc.signers[0].weight).toBe(3);
    expect(acc.kind === 'account' && acc.thresholds.low).toBe(0);
    const o = cloneEntry(offer as OfferEntry);
    o.price.n = 99;
    expect((offer as OfferEntry).price.n).toBe(3);
    const b = cloneEntry(cb as ClaimableBalanceEntry);
    b.claimants[0].destination = A;
    expect((cb as ClaimableBalanceEntry).claimants[0].destination).toBe(B);
  });
});

describe('state hash', () => {
  it('matches the documented formula', () => {
    const entries = sampleEntries();
    const items = entries
      .map((e) => {
        const k = entryKey(e);
        const eh = sha256(concatBytes(utf8(k), new Uint8Array([0]), utf8(canonicalJson(serializeEntry(e)))));
        return { k, eh };
      })
      .sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
    const parts: Uint8Array[] = [];
    for (const { k, eh } of items) parts.push(utf8(k), new Uint8Array([0]), eh);
    expect(computeStateHash(entries)).toBe(toHex(sha256(concatBytes(...parts))));
    expect(toHex(entryHash(entries[0]))).toBe(toHex(items.find((i) => i.k === entryKey(entries[0]))!.eh));
  });

  it('does not depend on entry order and changes with content', () => {
    const entries = sampleEntries();
    const h = computeStateHash(entries);
    expect(computeStateHash([...entries].reverse())).toBe(h);
    const changed = sampleEntries();
    (changed[3] as DataEntry).value = 'AAED';
    expect(computeStateHash(changed)).not.toBe(h);
  });

  it('hashes states larger than the argument limit of one function call', () => {
    // 3 parts per entry were spread into one call: RangeError at about 41,000 entries (V8).
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < 60_000; i++) {
      entries.push(newAccountEntry(StrKey.encodeEd25519PublicKey(sha256(`big-state|${i}`)), BigInt(i), 0n, 1));
    }
    const items = entries
      .map((e) => [entryKey(e), entryHash(e)] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    let len = 0;
    for (const [k, h] of items) len += utf8(k).length + 1 + h.length;
    const all = new Uint8Array(len);
    let off = 0;
    for (const [k, h] of items) {
      const kb = utf8(k);
      all.set(kb, off);
      off += kb.length + 1; // the 0x00 separator is already zero
      all.set(h, off);
      off += h.length;
    }
    const expected = toHex(sha256(all));
    expect(computeStateHash(entries)).toBe(expected);
    expect(new LedgerRoot(entries).stateHash()).toBe(expected);
  });
});
