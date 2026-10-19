// Storage that keeps a node running when IndexedDB fails: a full disk
// (QuotaExceededError), a lost connection, or a database that does not open
// (some private modes). From then on new data goes to memory and consensus
// goes on; data written before stays readable from IndexedDB. Rollbacks and
// resyncs that happen in memory mode hide the newer IndexedDB data, so reads
// never mix branches. One error is reported through onFallback.

import { KEEP_SNAPSHOTS } from '../storage/idbStorage';
import { MemoryStorage } from '../storage/memoryStorage';
import type { Storage, StoredLedger, StoredTx } from '../storage/types';
import { compareTxsNewestFirst } from '../storage/util';

/** True for errors that mean "IndexedDB will not take more writes". */
export function isStorageFailure(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown; code?: unknown; inner?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22) return true;
  // the backing store failed (Chromium reports disk and LevelDB errors as UnknownError)
  if (name === 'UnknownError') return true;
  if (/quota/i.test(message) || /quota/i.test(name)) return true;
  // the connection was closed under us (site data cleared, browser shutdown)
  if (name === 'InvalidStateError' || /is not open|connection is closing|database connection/i.test(message)) return true;
  return e.inner !== undefined && isStorageFailure(e.inner);
}

export class FallbackStorage implements Storage {
  private mem: MemoryStorage | null = null;
  private primaryOpen = false;
  /** Primary ledgers, txs and snapshots above this seq are hidden (truncated in memory mode). */
  private ceiling = Infinity;

  constructor(
    readonly primary: Storage,
    private readonly onFallback: (reason: string, err: unknown) => void = () => undefined,
  ) {}

  /** True once writes go to memory. */
  get inMemory(): boolean {
    return this.mem !== null;
  }

  private async switchToMemory(reason: string, err: unknown): Promise<MemoryStorage> {
    if (!this.mem) {
      // memory mode lasts until the tab closes: bound its snapshots like IndexedDB's
      this.mem = new MemoryStorage({ keepSnapshots: KEEP_SNAPSHOTS });
      await this.mem.open();
      try {
        this.onFallback(reason, err);
      } catch {
        // reporting must not break the write
      }
    }
    return this.mem;
  }

  async open(): Promise<void> {
    if (this.mem) await this.mem.open();
    try {
      await this.primary.open();
      this.primaryOpen = true;
    } catch (err) {
      this.primaryOpen = false;
      this.ceiling = 0;
      await this.switchToMemory('IndexedDB could not be opened', err);
    }
  }

  async close(): Promise<void> {
    if (this.mem) await this.mem.close();
    if (this.primaryOpen) {
      this.primaryOpen = false;
      await this.primary.close().catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ writes

  private async write(what: string, op: (s: Storage) => Promise<void>): Promise<void> {
    if (this.mem) return op(this.mem);
    try {
      await op(this.primary);
    } catch (err) {
      if (!isStorageFailure(err)) throw err;
      await op(await this.switchToMemory(`IndexedDB refused ${what}`, err));
    }
  }

  setMeta<T>(key: string, value: T): Promise<void> {
    return this.write('a settings write', (s) => s.setMeta(key, value));
  }

  putLedger(ledger: StoredLedger, txs: StoredTx[]): Promise<void> {
    return this.write(`ledger ${ledger.seq}`, (s) => s.putLedger(ledger, txs));
  }

  putSnapshot(seq: number, data: string): Promise<void> {
    return this.write(`snapshot ${seq}`, (s) => s.putSnapshot(seq, data));
  }

  async truncateAfter(seq: number): Promise<void> {
    if (!this.mem) return this.primary.truncateAfter(seq);
    this.ceiling = Math.min(this.ceiling, seq);
    await this.mem.truncateAfter(seq);
    if (this.primaryOpen) await this.primary.truncateAfter(seq).catch(() => undefined);
  }

  async clearChain(): Promise<void> {
    if (!this.mem) return this.primary.clearChain();
    this.ceiling = 0;
    await this.mem.clearChain();
    if (this.primaryOpen) await this.primary.clearChain().catch(() => undefined);
  }

  // ------------------------------------------------------------ reads

  /** A primary read in memory mode: failures read as "nothing there". */
  private async fromPrimary<T>(read: () => Promise<T>, empty: T): Promise<T> {
    if (!this.primaryOpen) return empty;
    try {
      return await read();
    } catch {
      return empty;
    }
  }

  /** Primary txs of ledgers that memory did not replace and that are not hidden. */
  private async visiblePrimaryTxs(mem: MemoryStorage, txs: StoredTx[]): Promise<StoredTx[]> {
    const replaced = new Map<number, boolean>();
    const out: StoredTx[] = [];
    for (const t of txs) {
      if (t.ledgerSeq > this.ceiling) continue;
      let r = replaced.get(t.ledgerSeq);
      if (r === undefined) replaced.set(t.ledgerSeq, (r = (await mem.getLedger(t.ledgerSeq)) !== undefined));
      if (!r) out.push(t);
    }
    return out;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    if (!this.mem) return this.primary.getMeta<T>(key);
    const v = await this.mem.getMeta<T>(key);
    return v !== undefined ? v : this.fromPrimary(() => this.primary.getMeta<T>(key), undefined);
  }

  async getLedger(seq: number): Promise<StoredLedger | undefined> {
    if (!this.mem) return this.primary.getLedger(seq);
    const v = await this.mem.getLedger(seq);
    if (v || seq > this.ceiling) return v;
    return this.fromPrimary(() => this.primary.getLedger(seq), undefined);
  }

  async getLedgers(from: number, to: number): Promise<StoredLedger[]> {
    if (!this.mem) return this.primary.getLedgers(from, to);
    const byseq = new Map<number, StoredLedger>();
    const top = Math.min(to, this.ceiling);
    if (from <= top) for (const l of await this.fromPrimary(() => this.primary.getLedgers(from, top), [])) byseq.set(l.seq, l);
    for (const l of await this.mem.getLedgers(from, to)) byseq.set(l.seq, l);
    return [...byseq.values()].sort((a, b) => a.seq - b.seq);
  }

  async getLatestLedgers(limit: number, beforeSeq?: number): Promise<StoredLedger[]> {
    if (!this.mem) return this.primary.getLatestLedgers(limit, beforeSeq);
    const byseq = new Map<number, StoredLedger>();
    const below = Math.min(beforeSeq ?? Infinity, this.ceiling + 1);
    if (below > 0) {
      const rows = await this.fromPrimary(() => this.primary.getLatestLedgers(limit, below === Infinity ? undefined : below), []);
      for (const l of rows) byseq.set(l.seq, l);
    }
    for (const l of await this.mem.getLatestLedgers(limit, beforeSeq)) byseq.set(l.seq, l);
    return [...byseq.values()].sort((a, b) => b.seq - a.seq).slice(0, Math.max(0, Math.floor(limit)));
  }

  async getMaxLedgerSeq(): Promise<number> {
    if (!this.mem) return this.primary.getMaxLedgerSeq();
    const m = await this.mem.getMaxLedgerSeq();
    const p =
      this.ceiling === Infinity
        ? await this.fromPrimary(() => this.primary.getMaxLedgerSeq(), 0)
        : ((await this.fromPrimary(() => this.primary.getLatestLedgers(1, this.ceiling + 1), []))[0]?.seq ?? 0);
    return Math.max(m, p);
  }

  async getTx(hash: string): Promise<StoredTx | undefined> {
    if (!this.mem) return this.primary.getTx(hash);
    const mem = this.mem;
    const v = await mem.getTx(hash);
    if (v) return v;
    const p = await this.fromPrimary(() => this.primary.getTx(hash), undefined);
    return p ? (await this.visiblePrimaryTxs(mem, [p]))[0] : undefined;
  }

  async getTxsByLedger(seq: number): Promise<StoredTx[]> {
    if (!this.mem) return this.primary.getTxsByLedger(seq);
    if ((await this.mem.getLedger(seq)) || seq > this.ceiling) return this.mem.getTxsByLedger(seq);
    return this.fromPrimary(() => this.primary.getTxsByLedger(seq), []);
  }

  private async mergeTxs(limit: number, fromMem: StoredTx[], fromPrimary: StoredTx[]): Promise<StoredTx[]> {
    const byHash = new Map<string, StoredTx>();
    for (const t of await this.visiblePrimaryTxs(this.mem!, fromPrimary)) byHash.set(t.hash, t);
    for (const t of fromMem) byHash.set(t.hash, t);
    return [...byHash.values()].sort(compareTxsNewestFirst).slice(0, Math.max(0, Math.floor(limit)));
  }

  async getTxsByAccount(accountId: string, limit: number, beforeLedgerSeq?: number): Promise<StoredTx[]> {
    if (!this.mem) return this.primary.getTxsByAccount(accountId, limit, beforeLedgerSeq);
    const [m, p] = await Promise.all([
      this.mem.getTxsByAccount(accountId, limit, beforeLedgerSeq),
      this.fromPrimary(() => this.primary.getTxsByAccount(accountId, limit, beforeLedgerSeq), []),
    ]);
    return this.mergeTxs(limit, m, p);
  }

  async getLatestTxs(limit: number, beforeLedgerSeq?: number): Promise<StoredTx[]> {
    if (!this.mem) return this.primary.getLatestTxs(limit, beforeLedgerSeq);
    const [m, p] = await Promise.all([
      this.mem.getLatestTxs(limit, beforeLedgerSeq),
      this.fromPrimary(() => this.primary.getLatestTxs(limit, beforeLedgerSeq), []),
    ]);
    return this.mergeTxs(limit, m, p);
  }

  async getSnapshot(seq: number): Promise<string | undefined> {
    if (!this.mem) return this.primary.getSnapshot(seq);
    const v = await this.mem.getSnapshot(seq);
    if (v !== undefined || seq > this.ceiling) return v;
    return this.fromPrimary(() => this.primary.getSnapshot(seq), undefined);
  }

  async getLatestSnapshotAtOrBefore(seq: number): Promise<{ seq: number; data: string } | undefined> {
    if (!this.mem) return this.primary.getLatestSnapshotAtOrBefore(seq);
    const m = await this.mem.getLatestSnapshotAtOrBefore(seq);
    const cap = Math.min(seq, this.ceiling);
    const p = cap >= 0 ? await this.fromPrimary(() => this.primary.getLatestSnapshotAtOrBefore(cap), undefined) : undefined;
    if (!m) return p;
    if (!p) return m;
    return p.seq > m.seq ? p : m;
  }

  async listSnapshotSeqs(): Promise<number[]> {
    if (!this.mem) return this.primary.listSnapshotSeqs();
    const seqs = new Set<number>(await this.mem.listSnapshotSeqs());
    for (const s of await this.fromPrimary(() => this.primary.listSnapshotSeqs(), [])) if (s <= this.ceiling) seqs.add(s);
    return [...seqs].sort((a, b) => a - b);
  }
}
