// In-memory Storage for tests and the simulation. Values are copied on the
// way in and out (like IndexedDB), and data survives close()/open() on the
// same instance, so a simulated node can restart with its chain.

import type { Storage, StoredLedger, StoredTx } from './types';
import { compareTxsApplyOrder, compareTxsNewestFirst, requireSeq, txAccounts, validateLedgerAndTxs } from './util';

export class MemoryStorage implements Storage {
  private readonly keepSnapshots: number;
  private isOpen = false;
  private readonly meta = new Map<string, unknown>();
  private readonly ledgers = new Map<number, StoredLedger>();
  private readonly txs = new Map<string, StoredTx>();
  private readonly txsByLedger = new Map<number, Set<string>>();
  private readonly txsByAccount = new Map<string, Set<string>>();
  private readonly snapshots = new Map<number, string>();

  /** keepSnapshots: keep only the newest snapshots (default: all, as the simulation expects). */
  constructor(opts: { keepSnapshots?: number } = {}) {
    this.keepSnapshots = Math.max(1, opts.keepSnapshots ?? Infinity);
  }

  async open(): Promise<void> {
    this.isOpen = true;
  }

  async close(): Promise<void> {
    this.isOpen = false;
  }

  // ------------------------------------------------------------ meta

  async getMeta<T>(key: string): Promise<T | undefined> {
    this.check();
    return this.meta.has(key) ? (structuredClone(this.meta.get(key)) as T) : undefined;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    this.check();
    this.meta.set(key, structuredClone(value));
  }

  // ------------------------------------------------------------ ledgers

  async putLedger(ledger: StoredLedger, txs: StoredTx[]): Promise<void> {
    this.check();
    validateLedgerAndTxs(ledger, txs);
    // Copy everything first so a bad value cannot leave a half-written ledger.
    const ledgerCopy = structuredClone(ledger);
    const txCopies = txs.map((t) => structuredClone(t));
    for (const hash of [...(this.txsByLedger.get(ledger.seq) ?? [])]) this.removeTx(hash);
    this.ledgers.set(ledger.seq, ledgerCopy);
    for (const tx of txCopies) {
      this.removeTx(tx.hash);
      this.addTx(tx);
    }
  }

  async getLedger(seq: number): Promise<StoredLedger | undefined> {
    this.check();
    const l = this.ledgers.get(seq);
    return l ? structuredClone(l) : undefined;
  }

  async getLedgers(from: number, to: number): Promise<StoredLedger[]> {
    this.check();
    if (from > to) return [];
    return this.sortedLedgerSeqs()
      .filter((s) => s >= from && s <= to)
      .map((s) => structuredClone(this.ledgers.get(s) as StoredLedger));
  }

  async getLatestLedgers(limit: number, beforeSeq?: number): Promise<StoredLedger[]> {
    this.check();
    const n = Math.floor(limit);
    if (!(n > 0)) return [];
    const out: StoredLedger[] = [];
    const seqs = this.sortedLedgerSeqs();
    for (let i = seqs.length - 1; i >= 0 && out.length < n; i--) {
      if (beforeSeq !== undefined && seqs[i] >= beforeSeq) continue;
      out.push(structuredClone(this.ledgers.get(seqs[i]) as StoredLedger));
    }
    return out;
  }

  async getMaxLedgerSeq(): Promise<number> {
    this.check();
    let max = 0;
    for (const s of this.ledgers.keys()) if (s > max) max = s;
    return max;
  }

  // ------------------------------------------------------------ txs

  async getTx(hash: string): Promise<StoredTx | undefined> {
    this.check();
    const t = this.txs.get(hash);
    return t ? structuredClone(t) : undefined;
  }

  async getTxsByLedger(seq: number): Promise<StoredTx[]> {
    this.check();
    return this.collect(this.txsByLedger.get(seq))
      .sort(compareTxsApplyOrder)
      .map((t) => structuredClone(t));
  }

  async getTxsByAccount(accountId: string, limit: number, beforeLedgerSeq?: number): Promise<StoredTx[]> {
    this.check();
    const n = Math.floor(limit);
    if (!(n > 0)) return [];
    return this.collect(this.txsByAccount.get(accountId))
      .filter((t) => beforeLedgerSeq === undefined || t.ledgerSeq < beforeLedgerSeq)
      .sort(compareTxsNewestFirst)
      .slice(0, n)
      .map((t) => structuredClone(t));
  }

  async getLatestTxs(limit: number, beforeLedgerSeq?: number): Promise<StoredTx[]> {
    this.check();
    const n = Math.floor(limit);
    if (!(n > 0)) return [];
    const seqs = [...this.txsByLedger.keys()].sort((a, b) => b - a);
    const out: StoredTx[] = [];
    for (const seq of seqs) {
      if (beforeLedgerSeq !== undefined && seq >= beforeLedgerSeq) continue;
      for (const t of this.collect(this.txsByLedger.get(seq)).sort(compareTxsNewestFirst)) {
        out.push(structuredClone(t));
        if (out.length >= n) return out;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ snapshots

  async putSnapshot(seq: number, data: string): Promise<void> {
    this.check();
    requireSeq(seq);
    this.snapshots.set(seq, data);
    if (this.snapshots.size > this.keepSnapshots) {
      const sorted = [...this.snapshots.keys()].sort((a, b) => a - b);
      for (const s of sorted.slice(0, sorted.length - this.keepSnapshots)) this.snapshots.delete(s);
    }
  }

  async getSnapshot(seq: number): Promise<string | undefined> {
    this.check();
    return this.snapshots.get(seq);
  }

  async getLatestSnapshotAtOrBefore(seq: number): Promise<{ seq: number; data: string } | undefined> {
    this.check();
    let best: number | undefined;
    for (const s of this.snapshots.keys()) {
      if (s <= seq && (best === undefined || s > best)) best = s;
    }
    return best === undefined ? undefined : { seq: best, data: this.snapshots.get(best) as string };
  }

  async listSnapshotSeqs(): Promise<number[]> {
    this.check();
    return [...this.snapshots.keys()].sort((a, b) => a - b);
  }

  // ------------------------------------------------------------ rollback

  async truncateAfter(seq: number): Promise<void> {
    this.check();
    for (const s of [...this.ledgers.keys()]) if (s > seq) this.ledgers.delete(s);
    for (const s of [...this.txsByLedger.keys()]) {
      if (s > seq) for (const hash of [...(this.txsByLedger.get(s) ?? [])]) this.removeTx(hash);
    }
    for (const s of [...this.snapshots.keys()]) if (s > seq) this.snapshots.delete(s);
  }

  async clearChain(): Promise<void> {
    this.check();
    this.ledgers.clear();
    this.txs.clear();
    this.txsByLedger.clear();
    this.txsByAccount.clear();
    this.snapshots.clear();
  }

  // ------------------------------------------------------------ private

  private check(): void {
    if (!this.isOpen) throw new Error('MemoryStorage is not open');
  }

  private sortedLedgerSeqs(): number[] {
    return [...this.ledgers.keys()].sort((a, b) => a - b);
  }

  private collect(hashes: Set<string> | undefined): StoredTx[] {
    if (!hashes) return [];
    const out: StoredTx[] = [];
    for (const h of hashes) {
      const t = this.txs.get(h);
      if (t) out.push(t);
    }
    return out;
  }

  private addTx(tx: StoredTx): void {
    this.txs.set(tx.hash, tx);
    addTo(this.txsByLedger, tx.ledgerSeq, tx.hash);
    for (const a of txAccounts(tx)) addTo(this.txsByAccount, a, tx.hash);
  }

  private removeTx(hash: string): void {
    const tx = this.txs.get(hash);
    if (!tx) return;
    this.txs.delete(hash);
    removeFrom(this.txsByLedger, tx.ledgerSeq, hash);
    for (const a of txAccounts(tx)) removeFrom(this.txsByAccount, a, hash);
  }
}

function addTo<K>(index: Map<K, Set<string>>, key: K, hash: string): void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(hash);
}

function removeFrom<K>(index: Map<K, Set<string>>, key: K, hash: string): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(hash);
  if (set.size === 0) index.delete(key);
}
