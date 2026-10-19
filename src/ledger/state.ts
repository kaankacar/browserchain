// Ledger state with a nested transactional layer, modelled on stellar-core's
// LedgerTxn (docs/ARCHITECTURE.md 7.1).
//
// LedgerRoot holds the last closed state. A LedgerTxn records changes on top
// of its parent (another LedgerTxn or the root). `load` returns a working copy
// that is recorded as written (its lastModifiedLedgerSeq is set); `get` reads
// without recording (stellar-core loadWithoutRecord). While a child is open,
// the parent may not be used. Entry objects obtained before a child commits
// must be loaded again afterwards.

import { assetEquals } from './asset';
import { cloneEntry, entryHash, stateHashFromEntryHashes } from './entries';
import { claimableBalanceKey, entryKey, entryOwner, keyKind, offerKey, offerPairKey } from './keys';
import { compareOffers } from './offers';
import type {
  AccountEntry,
  Asset,
  ClaimableBalanceEntry,
  DataEntry,
  Hash,
  LedgerEntry,
  LedgerHeader,
  LedgerKey,
  OfferEntry,
  TrustLineEntry,
} from './types';

export function cloneHeader(h: LedgerHeader): LedgerHeader {
  return {
    ...h,
    scpValue: {
      ...h.scpValue,
      upgrades: [...h.scpValue.upgrades],
      signature: h.scpValue.signature ? { ...h.scpValue.signature } : null,
    },
    skipList: [...h.skipList] as LedgerHeader['skipList'],
  };
}

/** Read access shared by the root and transactions. */
export interface LedgerReader {
  get(key: LedgerKey): Readonly<LedgerEntry> | undefined;
}

// ---------------------------------------------------------------- root

export class LedgerRoot implements LedgerReader {
  private readonly entries = new Map<LedgerKey, LedgerEntry>();
  private readonly byOwner = new Map<string, Set<LedgerKey>>();
  private readonly byPair = new Map<string, Set<LedgerKey>>();
  private readonly balances = new Set<LedgerKey>();
  private readonly hashCache = new Map<LedgerKey, Uint8Array>();
  /** Offers of a pair in book order (compareOffers), built on demand, dropped when the pair changes. */
  private readonly books = new Map<string, readonly Readonly<OfferEntry>[]>();
  private openChild = false;

  constructor(entries: Iterable<LedgerEntry> = []) {
    for (const e of entries) {
      const k = entryKey(e);
      if (this.entries.has(k)) throw new Error(`duplicate ledger entry ${k}`);
      this.put(k, cloneEntry(e));
    }
  }

  get(key: LedgerKey): Readonly<LedgerEntry> | undefined {
    return this.entries.get(key);
  }

  size(): number {
    return this.entries.size;
  }

  keys(): IterableIterator<LedgerKey> {
    return this.entries.keys();
  }

  values(): IterableIterator<Readonly<LedgerEntry>> {
    return this.entries.values();
  }

  /** Keys of trustlines, offers and data entries owned by an account. */
  ownedKeys(accountId: string): ReadonlySet<LedgerKey> {
    return this.byOwner.get(accountId) ?? EMPTY;
  }

  /** Keys of offers selling `selling` for `buying`. */
  offerKeys(selling: Asset, buying: Asset): ReadonlySet<LedgerKey> {
    return this.byPair.get(offerPairKey(selling, buying)) ?? EMPTY;
  }

  /** Offers selling `selling` for `buying`, best first (compareOffers). Read only; do not mutate. */
  sortedBook(selling: Asset, buying: Asset): readonly Readonly<OfferEntry>[] {
    const pair = offerPairKey(selling, buying);
    let book = this.books.get(pair);
    if (!book) {
      const offers: Readonly<OfferEntry>[] = [];
      for (const k of this.byPair.get(pair) ?? EMPTY) offers.push(this.entries.get(k) as OfferEntry);
      book = offers.sort(compareOffers);
      this.books.set(pair, book);
    }
    return book;
  }

  allOfferKeys(): LedgerKey[] {
    const out: LedgerKey[] = [];
    for (const s of this.byPair.values()) for (const k of s) out.push(k);
    return out;
  }

  claimableBalanceKeys(): ReadonlySet<LedgerKey> {
    return this.balances;
  }

  /** Open a top-level transaction. `ledgerSeq` is written into lastModifiedLedgerSeq. */
  begin(header: LedgerHeader, ledgerSeq: number): LedgerTxn {
    if (this.openChild) throw new Error('LedgerRoot already has an open transaction');
    this.openChild = true;
    return new LedgerTxn(this, null, cloneHeader(header), ledgerSeq);
  }

  /** @internal Called by the top-level LedgerTxn. Returns the keys that changed. */
  applyChanges(changes: Map<LedgerKey, LedgerEntry | null>): LedgerKey[] {
    const changed: LedgerKey[] = [];
    for (const [k, v] of changes) {
      if (v === null) {
        if (this.entries.has(k)) {
          this.remove(k);
          changed.push(k);
        }
      } else {
        if (this.entries.has(k)) this.remove(k);
        this.put(k, v);
        changed.push(k);
      }
    }
    return changed.sort();
  }

  /** @internal */
  childClosed(): void {
    this.openChild = false;
  }

  /** Flat state hash (docs/ARCHITECTURE.md 5.6). Entry hashes are cached. */
  stateHash(): Hash {
    const items: [LedgerKey, Uint8Array][] = [];
    for (const [k, e] of this.entries) {
      let h = this.hashCache.get(k);
      if (!h) {
        h = entryHash(e, k);
        this.hashCache.set(k, h);
      }
      items.push([k, h]);
    }
    return stateHashFromEntryHashes(items);
  }

  private put(k: LedgerKey, e: LedgerEntry): void {
    this.entries.set(k, e);
    const owner = entryOwner(e);
    if (owner) addTo(this.byOwner, owner, k);
    if (e.kind === 'offer') {
      const pair = offerPairKey(e.selling, e.buying);
      addTo(this.byPair, pair, k);
      this.books.delete(pair);
    }
    if (e.kind === 'claimableBalance') this.balances.add(k);
  }

  private remove(k: LedgerKey): void {
    const e = this.entries.get(k);
    if (!e) return;
    this.entries.delete(k);
    this.hashCache.delete(k);
    const owner = entryOwner(e);
    if (owner) removeFrom(this.byOwner, owner, k);
    if (e.kind === 'offer') {
      const pair = offerPairKey(e.selling, e.buying);
      removeFrom(this.byPair, pair, k);
      this.books.delete(pair);
    }
    if (e.kind === 'claimableBalance') this.balances.delete(k);
  }
}

const EMPTY: ReadonlySet<LedgerKey> = new Set();

function addTo(m: Map<string, Set<LedgerKey>>, k: string, v: LedgerKey): void {
  let s = m.get(k);
  if (!s) {
    s = new Set();
    m.set(k, s);
  }
  s.add(v);
}

function removeFrom(m: Map<string, Set<LedgerKey>>, k: string, v: LedgerKey): void {
  const s = m.get(k);
  if (!s) return;
  s.delete(v);
  if (s.size === 0) m.delete(k);
}

// ---------------------------------------------------------------- transactions

export class LedgerTxn implements LedgerReader {
  /** Working header. Children start from a copy; it is written back on commit. */
  header: LedgerHeader;
  readonly ledgerSeq: number;
  private readonly changes = new Map<LedgerKey, LedgerEntry | null>();
  // Indexes over `changes`, so queries do not read every change of the chain
  // (the ledger-level transaction holds all changes of the ledger so far).
  /** Order in which keys first entered `changes` (tells what had changed when a query started). */
  private readonly changeOrder = new Map<LedgerKey, number>();
  /** Keys whose value here is an offer, by pair; and the pair of each. */
  private readonly offersHere = new Map<string, Set<LedgerKey>>();
  private readonly offerPairHere = new Map<LedgerKey, string>();
  /** Keys of owned entries (trust lines, offers, data) written here, by owner. May be stale: readers re-check. */
  private readonly ownedHere = new Map<string, Set<LedgerKey>>();
  /** Per pair: how many leading offers of the root book are in `changes`. */
  private readonly changedBookPrefix = new Map<string, { book: readonly Readonly<OfferEntry>[]; n: number }>();
  private state: 'open' | 'committed' | 'rolledBack' = 'open';
  private childOpen = false;

  /** @internal Use LedgerRoot.begin or LedgerTxn.child. */
  constructor(
    private readonly root: LedgerRoot,
    private readonly parent: LedgerTxn | null,
    header: LedgerHeader,
    ledgerSeq: number,
  ) {
    this.header = header;
    this.ledgerSeq = ledgerSeq;
  }

  /** Open a nested transaction. */
  child(): LedgerTxn {
    this.assertUsable();
    this.childOpen = true;
    return new LedgerTxn(this.root, this, cloneHeader(this.header), this.ledgerSeq);
  }

  /** Current entry without recording it (read only; do not mutate). */
  get(key: LedgerKey): Readonly<LedgerEntry> | undefined {
    this.assertUsable();
    return this.lookup(key);
  }

  getAccount(accountId: string): Readonly<AccountEntry> | undefined {
    return this.get(`A:${accountId}`) as Readonly<AccountEntry> | undefined;
  }

  has(key: LedgerKey): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Working copy of an entry, recorded as written by this transaction
   * (stellar-core LedgerTxn::load). Mutate it in place.
   */
  load(key: LedgerKey): LedgerEntry | undefined {
    this.assertUsable();
    const own = this.changes.get(key);
    if (own !== undefined) return own ?? undefined;
    const cur = this.parent ? this.parent.lookup(key) : this.root.get(key);
    if (!cur) return undefined;
    const copy = cloneEntry(cur as LedgerEntry);
    copy.lastModifiedLedgerSeq = this.ledgerSeq;
    this.write(key, copy);
    return copy;
  }

  loadAccount(accountId: string): AccountEntry | undefined {
    return this.load(`A:${accountId}`) as AccountEntry | undefined;
  }

  /** Add a new entry. Throws if the key exists. Returns the stored entry. */
  create<T extends LedgerEntry>(entry: T): T {
    this.assertUsable();
    const key = entryKey(entry);
    if (this.lookup(key)) throw new Error(`ledger entry already exists: ${key}`);
    const copy = cloneEntry(entry);
    copy.lastModifiedLedgerSeq = this.ledgerSeq;
    this.write(key, copy);
    return copy;
  }

  /** Delete an entry. Throws if it does not exist. */
  erase(key: LedgerKey): void {
    this.assertUsable();
    if (!this.lookup(key)) throw new Error(`ledger entry does not exist: ${key}`);
    this.write(key, null);
  }

  /** Merge the changes into the parent (or the root). Returns changed keys at the root level. */
  commit(): LedgerKey[] {
    this.assertUsable();
    if (this.parent && this.parent.state !== 'open') throw new Error('parent LedgerTxn is closed');
    this.state = 'committed';
    if (this.parent) {
      for (const [k, v] of this.changes) this.parent.write(k, v);
      this.parent.header = this.header;
      this.parent.childOpen = false;
      return [];
    }
    const changed = this.root.applyChanges(this.changes);
    this.root.childClosed();
    return changed;
  }

  /** Discard the changes. Also abandons an open child (after an exception). */
  rollback(): void {
    if (this.state !== 'open') return;
    this.state = 'rolledBack';
    this.childOpen = false;
    if (this.parent) this.parent.childOpen = false;
    else this.root.childClosed();
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  // ------------------------------------------------------------ queries

  /** Trustlines of an account, sorted by key. Read only. */
  trustLinesOf(accountId: string): Readonly<TrustLineEntry>[] {
    return this.ownedOfKind(accountId, 'trustline') as Readonly<TrustLineEntry>[];
  }

  /** Offers of a seller, sorted by key. Read only. */
  offersOf(sellerId: string): Readonly<OfferEntry>[] {
    return this.ownedOfKind(sellerId, 'offer') as Readonly<OfferEntry>[];
  }

  /** Data entries of an account, sorted by key. Read only. */
  dataOf(accountId: string): Readonly<DataEntry>[] {
    return this.ownedOfKind(accountId, 'data') as Readonly<DataEntry>[];
  }

  /** Offers selling `selling` for `buying` (unsorted). Read only. */
  offersByPair(selling: Asset, buying: Asset): Readonly<OfferEntry>[] {
    this.assertUsable();
    const keys = new Set<LedgerKey>(this.root.offerKeys(selling, buying));
    this.collectChangedKeys(keys, (k) => k.startsWith('O:'));
    const out: Readonly<OfferEntry>[] = [];
    for (const k of keys) {
      const e = this.lookup(k);
      if (e && e.kind === 'offer' && assetEquals(e.selling, selling) && assetEquals(e.buying, buying)) out.push(e);
    }
    return out;
  }

  /**
   * Offers selling `selling` for `buying` in book order (compareOffers), as
   * this transaction sees them now. The order is fixed when called: later
   * changes are not seen. Lazy: reading the first offers does not read the
   * whole book. Read only; do not mutate.
   */
  offersInBookOrder(selling: Asset, buying: Asset): Iterable<Readonly<OfferEntry>> {
    this.assertUsable();
    const pair = offerPairKey(selling, buying);
    const base = this.root.sortedBook(selling, buying);
    // Leading root offers that are all changed in the chain: skipped at once.
    const start = this.bookPrefixChanged(pair, base);
    // Each transaction of the chain, with how many keys it had changed now.
    const levels: [LedgerTxn, number][] = [];
    // Offers of the pair whose current version was written in the chain.
    const written = new Set<LedgerKey>();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    for (let t: LedgerTxn | null = this; t; t = t.parent) {
      levels.push([t, t.changeOrder.size]);
      for (const k of t.offersHere.get(pair) ?? EMPTY) written.add(k);
    }
    const overlay: Readonly<OfferEntry>[] = [];
    for (const k of written) {
      const e = this.lookup(k);
      if (e && e.kind === 'offer' && assetEquals(e.selling, selling) && assetEquals(e.buying, buying)) overlay.push(e);
    }
    overlay.sort(compareOffers);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      *[Symbol.iterator]() {
        let i = start;
        let j = 0;
        for (;;) {
          // Root offers changed in this transaction chain appear (if at all) in the overlay.
          while (i < base.length && self.changedBefore(offerKey(base[i].offerId), levels)) i++;
          const a = i < base.length ? base[i] : undefined;
          const b = j < overlay.length ? overlay[j] : undefined;
          if (a && (!b || compareOffers(a, b) < 0)) {
            i++;
            yield a;
          } else if (b) {
            j++;
            yield b;
          } else {
            return;
          }
        }
      },
    };
  }

  /** All claimable balances, sorted by key. Read only. */
  claimableBalances(): Readonly<ClaimableBalanceEntry>[] {
    this.assertUsable();
    const keys = new Set<LedgerKey>(this.root.claimableBalanceKeys());
    this.collectChangedKeys(keys, (k) => k.startsWith('C:'));
    const out: Readonly<ClaimableBalanceEntry>[] = [];
    for (const k of [...keys].sort()) {
      const e = this.lookup(k);
      if (e && e.kind === 'claimableBalance') out.push(e);
    }
    return out;
  }

  getClaimableBalance(balanceIdHex: string): Readonly<ClaimableBalanceEntry> | undefined {
    return this.get(claimableBalanceKey(balanceIdHex)) as Readonly<ClaimableBalanceEntry> | undefined;
  }

  // ------------------------------------------------------------ internals

  /** @internal Visible value through the chain (no usability check). */
  lookup(key: LedgerKey): Readonly<LedgerEntry> | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let t: LedgerTxn | null = this;
    while (t) {
      const v = t.changes.get(key);
      if (v !== undefined) return v ?? undefined;
      t = t.parent;
    }
    return this.root.get(key);
  }

  private collectChangedKeys(into: Set<LedgerKey>, filter: (k: LedgerKey) => boolean): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let t: LedgerTxn | null = this;
    while (t) {
      for (const k of t.changes.keys()) if (filter(k)) into.add(k);
      t = t.parent;
    }
  }

  /** Record a change (load, create, erase or a child's commit) and keep the indexes. */
  private write(key: LedgerKey, value: LedgerEntry | null): void {
    if (!this.changeOrder.has(key)) this.changeOrder.set(key, this.changeOrder.size);
    this.changes.set(key, value);
    const oldPair = this.offerPairHere.get(key);
    if (oldPair !== undefined) {
      removeFrom(this.offersHere, oldPair, key);
      this.offerPairHere.delete(key);
    }
    if (!value) return;
    // Entries never change pair or owner in place, so the index stays right after load.
    if (value.kind === 'offer') {
      const pair = offerPairKey(value.selling, value.buying);
      addTo(this.offersHere, pair, key);
      this.offerPairHere.set(key, pair);
    }
    const owner = entryOwner(value);
    if (owner) addTo(this.ownedHere, owner, key);
  }

  /** True when `key` was changed in the chain when `levels` (transaction, change count) was taken. */
  private changedBefore(key: LedgerKey, levels: readonly [LedgerTxn, number][]): boolean {
    for (const [t, n] of levels) {
      const i = t.changeOrder.get(key);
      if (i !== undefined && i < n) return true;
    }
    return false;
  }

  /** True when `key` is changed in this transaction or an ancestor. */
  private changedInChain(key: LedgerKey): boolean {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    for (let t: LedgerTxn | null = this; t; t = t.parent) if (t.changes.has(key)) return true;
    return false;
  }

  /**
   * How many leading offers of the root book `base` are changed in this
   * transaction or its ancestors. Cached per pair: ancestors do not change
   * while this transaction is open and its own changes only grow, so the
   * count only grows.
   */
  private bookPrefixChanged(pair: string, base: readonly Readonly<OfferEntry>[]): number {
    let c = this.changedBookPrefix.get(pair);
    if (!c || c.book !== base) {
      c = { book: base, n: 0 };
      this.changedBookPrefix.set(pair, c);
    }
    if (this.parent) c.n = Math.max(c.n, this.parent.bookPrefixChanged(pair, base));
    while (c.n < base.length && this.changedInChain(offerKey(base[c.n].offerId))) c.n++;
    return c.n;
  }

  private ownedOfKind(owner: string, kind: LedgerEntry['kind']): Readonly<LedgerEntry>[] {
    this.assertUsable();
    const keys = new Set<LedgerKey>();
    for (const k of this.root.ownedKeys(owner)) if (keyKind(k) === kind) keys.add(k);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    for (let t: LedgerTxn | null = this; t; t = t.parent) {
      for (const k of t.ownedHere.get(owner) ?? EMPTY) if (keyKind(k) === kind) keys.add(k);
    }
    const out: Readonly<LedgerEntry>[] = [];
    for (const k of [...keys].sort()) {
      const e = this.lookup(k);
      if (e && e.kind === kind && entryOwner(e) === owner) out.push(e);
    }
    return out;
  }

  private assertUsable(): void {
    if (this.state !== 'open') throw new Error('LedgerTxn is closed');
    if (this.childOpen) throw new Error('LedgerTxn has an open child');
  }
}
