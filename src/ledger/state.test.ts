import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { computeStateHash } from './entries';
import { genesisHeader } from './genesis';
import { accountKey, dataKey, entryKey, entryOwner, offerKey, trustlineKey } from './keys';
import { newAccountEntry } from './ops/createAccount';
import { seededRng, pick, randInt } from '../lib/random';
import { compareOffers } from './offers';
import { LedgerRoot, LedgerTxn } from './state';
import type { AccountEntry, Asset, DataEntry, LedgerEntry, LedgerKey, OfferEntry, TrustLineEntry } from './types';

const A = Keypair.random().publicKey();
const B = Keypair.random().publicKey();
const header = genesisHeader('state test');

function data(name: string, value = 'AA=='): DataEntry {
  return { kind: 'data', accountId: A, name, value, lastModifiedLedgerSeq: 1 };
}

function offer(id: bigint, seller = A): OfferEntry {
  return {
    kind: 'offer',
    sellerId: seller,
    offerId: id,
    selling: { type: 'native' },
    buying: { type: 'credit_alphanum4', code: 'USD', issuer: B },
    amount: 10n,
    price: { n: 1, d: 1 },
    flags: 0,
    lastModifiedLedgerSeq: 1,
  };
}

/** Run `fn` and count calls of LedgerTxn methods (no argument recording: counts may be huge on a regression). */
function countCalls(methods: string[], fn: () => void): number {
  const proto = LedgerTxn.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const saved = methods.map((m) => [m, proto[m]] as const);
  let calls = 0;
  for (const [m, orig] of saved) {
    proto[m] = function (this: unknown, ...args: unknown[]) {
      calls++;
      return orig.apply(this, args);
    };
  }
  try {
    fn();
  } finally {
    for (const [m, orig] of saved) proto[m] = orig;
  }
  return calls;
}

function rootWith(): LedgerRoot {
  return new LedgerRoot([newAccountEntry(A, 100n, 1n, 1), newAccountEntry(B, 200n, 1n, 1), data('x')]);
}

describe('LedgerTxn', () => {
  it('load records a copy with lastModifiedLedgerSeq; get does not record', () => {
    const root = rootWith();
    const ltx = root.begin(header, 5);
    const viewed = ltx.get(accountKey(A)) as AccountEntry;
    expect(viewed.lastModifiedLedgerSeq).toBe(1);
    const acc = ltx.loadAccount(A)!;
    expect(acc.lastModifiedLedgerSeq).toBe(5);
    acc.balance = 50n;
    expect((ltx.get(accountKey(A)) as AccountEntry).balance).toBe(50n);
    expect((root.get(accountKey(A)) as AccountEntry).balance).toBe(100n);
    const changed = ltx.commit();
    expect(changed).toEqual([accountKey(A)]);
    expect((root.get(accountKey(A)) as AccountEntry).balance).toBe(50n);
    expect((root.get(accountKey(B)) as AccountEntry).lastModifiedLedgerSeq).toBe(1);
  });

  it('nested commit and rollback', () => {
    const root = rootWith();
    const ltx = root.begin(header, 2);
    const child = ltx.child();
    child.loadAccount(A)!.balance = 1n;
    child.create(data('y'));
    child.erase(dataKey(A, 'x'));
    const grand = child.child();
    grand.loadAccount(B)!.balance = 2n;
    grand.rollback();
    child.commit();
    expect((ltx.get(accountKey(A)) as AccountEntry).balance).toBe(1n);
    expect((ltx.get(accountKey(B)) as AccountEntry).balance).toBe(200n);
    expect(ltx.has(dataKey(A, 'y'))).toBe(true);
    expect(ltx.has(dataKey(A, 'x'))).toBe(false);
    const other = ltx.child();
    other.loadAccount(B)!.balance = 3n;
    other.rollback();
    const changed = ltx.commit();
    expect(changed.sort()).toEqual([accountKey(A), dataKey(A, 'x'), dataKey(A, 'y')].sort());
    expect(root.get(dataKey(A, 'x'))).toBeUndefined();
    expect((root.get(dataKey(A, 'y')) as DataEntry).lastModifiedLedgerSeq).toBe(2);
  });

  it('rolls back the header with the transaction', () => {
    const root = rootWith();
    const ltx = root.begin(header, 2);
    const child = ltx.child();
    child.header.idPool = 7n;
    child.rollback();
    expect(ltx.header.idPool).toBe(0n);
    const child2 = ltx.child();
    child2.header.idPool = 9n;
    child2.commit();
    expect(ltx.header.idPool).toBe(9n);
    ltx.rollback();
  });

  it('refuses to use a parent with an open child and checks create/erase', () => {
    const root = rootWith();
    const ltx = root.begin(header, 2);
    expect(() => root.begin(header, 2)).toThrow();
    const child = ltx.child();
    expect(() => ltx.get(accountKey(A))).toThrow();
    expect(() => child.create(newAccountEntry(A, 1n, 1n, 1))).toThrow();
    expect(() => child.erase(dataKey(A, 'nope'))).toThrow();
    child.rollback();
    expect(ltx.get(accountKey(A))).toBeDefined();
    ltx.rollback();
    const again = root.begin(header, 2);
    again.rollback();
  });

  it('erase then create in the same transaction', () => {
    const root = rootWith();
    const ltx = root.begin(header, 3);
    ltx.erase(dataKey(A, 'x'));
    expect(ltx.load(dataKey(A, 'x'))).toBeUndefined();
    ltx.create(data('x', 'AQ=='));
    ltx.commit();
    expect((root.get(dataKey(A, 'x')) as DataEntry).value).toBe('AQ==');
  });

  it('queries merge root indexes with pending changes', () => {
    const root = new LedgerRoot([
      newAccountEntry(A, 100n, 1n, 1),
      offer(1n),
      offer(2n),
      offer(3n, B),
      data('x'),
      {
        kind: 'trustline',
        accountId: A,
        asset: { type: 'credit_alphanum4', code: 'USD', issuer: B },
        balance: 0n,
        limit: 10n,
        flags: 1,
        buyingLiabilities: 0n,
        sellingLiabilities: 0n,
        lastModifiedLedgerSeq: 1,
      } as TrustLineEntry,
    ]);
    const ltx = root.begin(header, 2);
    const child = ltx.child();
    child.erase(offerKey(1n));
    child.create(offer(4n));
    child.create(data('z'));
    expect(child.offersOf(A).map((o) => o.offerId)).toEqual([2n, 4n]);
    expect(child.offersOf(B).map((o) => o.offerId)).toEqual([3n]);
    expect(
      child
        .offersByPair({ type: 'native' }, { type: 'credit_alphanum4', code: 'USD', issuer: B })
        .map((o) => o.offerId)
        .sort(),
    ).toEqual([2n, 3n, 4n]);
    expect(child.dataOf(A).map((d) => d.name)).toEqual(['x', 'z']);
    expect(child.trustLinesOf(A)).toHaveLength(1);
    expect(child.has(trustlineKey(A, { type: 'credit_alphanum4', code: 'USD', issuer: B }))).toBe(true);
    child.commit();
    ltx.commit();
    expect(root.offerKeys({ type: 'native' }, { type: 'credit_alphanum4', code: 'USD', issuer: B }).size).toBe(3);
    expect(root.ownedKeys(A).has(offerKey(1n))).toBe(false);
  });

  it('offersInBookOrder equals the sorted pair view under random nested changes', () => {
    const rng = seededRng(77);
    const usd: Asset = { type: 'credit_alphanum4', code: 'USD', issuer: B };
    const eur: Asset = { type: 'credit_alphanum4', code: 'EUR', issuer: B };
    const pairs: [Asset, Asset][] = [
      [{ type: 'native' }, usd],
      [usd, { type: 'native' }],
      [usd, eur],
    ];
    const prices = [
      { n: 1, d: 1 },
      { n: 2, d: 2 },
      { n: 3, d: 7 },
      { n: 7, d: 3 },
      { n: 1, d: 3 },
      { n: 2, d: 6 },
    ];
    const mk = (id: bigint): OfferEntry => {
      const [selling, buying] = pick(rng, pairs);
      return { ...offer(id, pick(rng, [A, B])), selling, buying, price: { ...pick(rng, prices) }, amount: BigInt(randInt(rng, 1, 9)) };
    };
    let nextId = 1n;
    const root = new LedgerRoot(Array.from({ length: 60 }, () => mk(nextId++)));
    const expectSame = (t: LedgerTxn) => {
      for (const [s, b] of pairs) {
        const want = t.offersByPair(s, b).sort(compareOffers).map((o) => o.offerId);
        expect([...t.offersInBookOrder(s, b)].map((o) => o.offerId)).toEqual(want);
      }
    };
    for (let round = 0; round < 25; round++) {
      const ltx = root.begin(header, 2 + round);
      const levels: LedgerTxn[] = [ltx];
      for (let step = 0; step < 30; step++) {
        const top = levels[levels.length - 1];
        const r = rng();
        const existing: bigint[] = [];
        for (let id = 1n; id < nextId; id++) if (top.has(offerKey(id))) existing.push(id);
        if (r < 0.15) levels.push(top.child());
        else if (r < 0.25 && levels.length > 1) {
          const c = levels.pop()!;
          if (rng() < 0.5) c.commit();
          else c.rollback();
        } else if (r < 0.45 && existing.length > 0) top.erase(offerKey(pick(rng, existing)));
        else if (r < 0.75 && existing.length > 0) {
          const o = top.load(offerKey(pick(rng, existing))) as OfferEntry;
          if (rng() < 0.5) o.price = { ...pick(rng, prices) };
          else o.amount += 1n;
        } else if (r < 0.85 && existing.length > 0) {
          // Move an offer to another pair (erase and re-create with the same id).
          const id = pick(rng, existing);
          top.erase(offerKey(id));
          top.create(mk(id));
        } else top.create(mk(nextId++));
        expectSame(levels[levels.length - 1]);
      }
      // The order is fixed when asked: changes made while walking it do not show up.
      const top = levels[levels.length - 1];
      const view = top.offersInBookOrder(pairs[0][0], pairs[0][1]);
      const before = [...view].map((o) => o.offerId);
      if (before.length > 0) top.erase(offerKey(before[0]));
      top.create(mk(nextId++));
      expect([...view].map((o) => o.offerId)).toEqual(before);
      while (levels.length > 1) levels.pop()!.commit();
      if (rng() < 0.7) ltx.commit();
      else ltx.rollback();
      for (const [s, b] of pairs) {
        expect(root.sortedBook(s, b).map((o) => o.offerId)).toEqual(
          [...root.offerKeys(s, b)].map((k) => root.get(k) as OfferEntry).sort(compareOffers).map((o) => o.offerId),
        );
      }
    }
  });

  it('owner and book queries equal a view of every key under random nested changes', () => {
    const rng = seededRng(91);
    const owners = [A, B];
    const usd: Asset = { type: 'credit_alphanum4', code: 'USD', issuer: B };
    const eur: Asset = { type: 'credit_alphanum4', code: 'EUR', issuer: A };
    const pairs: [Asset, Asset][] = [
      [{ type: 'native' }, usd],
      [usd, eur],
    ];
    let nextId = 1n;
    let nextName = 0;
    const mkOffer = (id: bigint): OfferEntry => {
      const [selling, buying] = pick(rng, pairs);
      const p = pick(rng, [{ n: 1, d: 1 }, { n: 2, d: 2 }, { n: 3, d: 7 }, { n: 7, d: 3 }]);
      return { ...offer(id, pick(rng, owners)), selling, buying, price: { ...p }, amount: BigInt(randInt(rng, 1, 9)) };
    };
    const mkOther = (): LedgerEntry => {
      const owner = pick(rng, owners);
      if (rng() < 0.5) return { ...data(`n${nextName++}`), accountId: owner };
      const asset: Asset = { type: 'credit_alphanum4', code: `C${nextName++}`, issuer: owner === A ? B : A };
      return { kind: 'trustline', accountId: owner, asset, balance: 0n, limit: 10n, flags: 1, buyingLiabilities: 0n, sellingLiabilities: 0n, lastModifiedLedgerSeq: 1 };
    };
    const initial: LedgerEntry[] = [newAccountEntry(A, 100n, 1n, 1), newAccountEntry(B, 100n, 1n, 1)];
    for (let i = 0; i < 30; i++) initial.push(mkOffer(nextId++), mkOther());
    const root = new LedgerRoot(initial);
    const universe = new Set<LedgerKey>(initial.map(entryKey));
    const expectSame = (t: LedgerTxn) => {
      const all = [...universe].sort().map((k) => t.get(k)).filter((e): e is Readonly<LedgerEntry> => e !== undefined);
      for (const owner of owners) {
        const ownedBy = (kind: LedgerEntry['kind']) => all.filter((e) => e.kind === kind && entryOwner(e) === owner).map(entryKey);
        expect(t.offersOf(owner).map(entryKey)).toEqual(ownedBy('offer'));
        expect(t.trustLinesOf(owner).map(entryKey)).toEqual(ownedBy('trustline'));
        expect(t.dataOf(owner).map(entryKey)).toEqual(ownedBy('data'));
      }
      for (const [s, b] of pairs) {
        const want = all
          .filter((e): e is Readonly<OfferEntry> => e.kind === 'offer' && e.selling.type === s.type && e.buying.type === b.type && JSON.stringify(e.selling) === JSON.stringify(s) && JSON.stringify(e.buying) === JSON.stringify(b))
          .sort(compareOffers)
          .map((o) => o.offerId);
        expect([...t.offersInBookOrder(s, b)].map((o) => o.offerId)).toEqual(want);
      }
    };
    for (let round = 0; round < 20; round++) {
      const levels: LedgerTxn[] = [root.begin(header, 2 + round)];
      for (let step = 0; step < 40; step++) {
        const top = levels[levels.length - 1];
        const live = [...universe].filter((k) => k.startsWith('A:') === false && top.has(k));
        const r = rng();
        if (r < 0.12) levels.push(top.child());
        else if (r < 0.22 && levels.length > 1) {
          const c = levels.pop()!;
          if (rng() < 0.5) c.commit();
          else c.rollback();
        } else if (r < 0.4 && live.length > 0) top.erase(pick(rng, live));
        else if (r < 0.6 && live.length > 0) {
          const e = top.load(pick(rng, live))!;
          if (e.kind === 'offer') e.amount += 1n;
          else if (e.kind === 'data') e.value = 'AQ==';
          else if (e.kind === 'trustline') e.balance += 1n;
        } else if (r < 0.7) {
          // Read without recording: must not change any view.
          for (const owner of owners) top.offersOf(owner);
        } else {
          const e = rng() < 0.6 ? mkOffer(nextId++) : mkOther();
          universe.add(entryKey(e));
          top.create(e);
        }
        expectSame(levels[levels.length - 1]);
      }
      while (levels.length > 1) levels.pop()!.commit();
      if (rng() < 0.7) levels[0].commit();
      else levels[0].rollback();
    }
  });

  it('book and owner queries do not re-read every earlier change of the ledger', () => {
    // Earlier transactions of the ledger took the 20,000 best offers of a book
    // and changed many other entries. A later crossing must not read them all
    // again for each query (that made ledger close time quadratic).
    const usd: Asset = { type: 'credit_alphanum4', code: 'USD', issuer: B };
    const native: Asset = { type: 'native' };
    const book: OfferEntry[] = [];
    for (let i = 1; i <= 20_100; i++) book.push({ ...offer(BigInt(i), i <= 20_000 ? B : A), selling: usd, buying: native });
    const others: DataEntry[] = Array.from({ length: 5_000 }, (_, i) => ({ ...data(`d${i}`), accountId: B }));
    const root = new LedgerRoot([newAccountEntry(A, 100n, 1n, 1), newAccountEntry(B, 100n, 1n, 1), ...book, ...others]);
    const ltx = root.begin(header, 2);
    for (let i = 1; i <= 20_000; i++) ltx.erase(offerKey(BigInt(i)));
    for (const d of others) (ltx.load(entryKey(d)) as DataEntry).value = 'AQ==';
    const calls = countCalls(['lookup'], () => {
      for (let q = 0; q < 200; q++) {
        const op = ltx.child();
        const best = op.offersInBookOrder(usd, native)[Symbol.iterator]().next().value as Readonly<OfferEntry>;
        expect(best.offerId).toBe(20_001n);
        expect(op.offersOf(A)).toHaveLength(100);
        op.rollback();
      }
    });
    ltx.rollback();
    // A full re-read is 25,000 lookups per query.
    expect(calls).toBeLessThan(50_000);
  });

  it('book walks skip offers taken by earlier transactions and earlier operations at once', () => {
    // Earlier transactions took offers 1..10,000 (ledger level) and earlier
    // operations of this transaction took 10,001..60,000 (transaction level).
    const usd: Asset = { type: 'credit_alphanum4', code: 'USD', issuer: B };
    const native: Asset = { type: 'native' };
    const book: OfferEntry[] = [];
    for (let i = 1; i <= 60_010; i++) book.push({ ...offer(BigInt(i), B), selling: usd, buying: native });
    const root = new LedgerRoot([newAccountEntry(A, 100n, 1n, 1), newAccountEntry(B, 100n, 1n, 1), ...book]);
    const ltxLedger = root.begin(header, 2);
    for (let i = 1; i <= 10_000; i++) ltxLedger.erase(offerKey(BigInt(i)));
    const ltxTx = ltxLedger.child();
    for (let i = 10_001; i <= 60_000; i++) ltxTx.erase(offerKey(BigInt(i)));
    const calls = countCalls(['lookup', 'changedBefore', 'changedInChain'], () => {
      for (let q = 0; q < 500; q++) {
        const op = ltxTx.child();
        const best = op.offersInBookOrder(usd, native)[Symbol.iterator]().next().value as Readonly<OfferEntry>;
        expect(best.offerId).toBe(60_001n);
        op.rollback();
      }
    });
    ltxTx.rollback();
    ltxLedger.rollback();
    // About one pass over the 60,000 taken offers in total, not one per query.
    expect(calls).toBeLessThan(200_000);
  });

  it('caches entry hashes without changing the state hash', () => {
    const root = rootWith();
    const h1 = root.stateHash();
    expect(root.stateHash()).toBe(h1);
    expect(h1).toBe(computeStateHash([...root.values()]));
    const ltx = root.begin(header, 2);
    ltx.loadAccount(A)!.balance = 1n;
    ltx.commit();
    const h2 = root.stateHash();
    expect(h2).not.toBe(h1);
    expect(h2).toBe(computeStateHash([...root.values()]));
  });
});
