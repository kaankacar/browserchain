// IndexedDB Storage (library 'idb'). One database per network and identity
// slot; the caller picks the name. Object stores:
//   meta       out-of-line string keys
//   ledgers    key seq
//   txs        key hash; index 'ledgerSeq' on [ledgerSeq, applyIndex];
//              multi-entry index 'accounts' on [account, ledgerSeq, applyIndex]
//              (stored in the extra field `_acct`, so per-account history is
//              ordered newest first without sorting)
//   snapshots  key seq

import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { Storage, StoredLedger, StoredTx } from './types';
import { requireSeq, txAccounts, validateLedgerAndTxs } from './util';

export const IDB_VERSION = 1;
/**
 * Snapshots kept (the newest ones). One is taken every 64 ledgers and holds
 * the whole state, so keeping all of them fills the quota of a long-running
 * node. Eight cover about 43 minutes: enough for fork rollbacks; an older
 * fork point replays from genesis.
 */
export const KEEP_SNAPSHOTS = 8;

type AccountKey = [string, number, number];

interface TxRecord extends StoredTx {
  _acct: AccountKey[];
}

interface SnapshotRecord {
  seq: number;
  data: string;
}

interface ChainDB extends DBSchema {
  meta: { key: string; value: unknown };
  ledgers: { key: number; value: StoredLedger };
  txs: {
    key: string;
    value: TxRecord;
    indexes: { ledgerSeq: [number, number]; accounts: AccountKey };
  };
  snapshots: { key: number; value: SnapshotRecord };
}

type Db = IDBPDatabase<ChainDB>;

function toRecord(tx: StoredTx): TxRecord {
  const acct: AccountKey[] = txAccounts(tx).map((a) => [a, tx.ledgerSeq, tx.applyIndex]);
  return { ...tx, _acct: acct };
}

function fromRecord(r: TxRecord): StoredTx {
  const { _acct: _ignored, ...tx } = r;
  return tx;
}

function abortQuietly(tx: IDBPTransaction<ChainDB, StoreNames<ChainDB>[], 'readwrite'>): void {
  try {
    tx.abort();
  } catch {
    // already finished or aborted
  }
}

/**
 * Collects request promises of one transaction. Each gets a no-op handler at
 * once, so requests aborted by a later failure are not unhandled rejections.
 */
class Ops {
  readonly list: Promise<unknown>[] = [];

  add(p: Promise<unknown>): void {
    p.catch(() => undefined);
    this.list.push(p);
  }
}

export class IdbStorage implements Storage {
  private db: Db | null = null;
  private opening: Promise<void> | null = null;
  private readonly keepSnapshots: number;

  constructor(
    readonly name: string,
    opts: { keepSnapshots?: number } = {},
  ) {
    if (!name) throw new Error('IdbStorage: database name is required');
    this.keepSnapshots = Math.max(1, opts.keepSnapshots ?? KEEP_SNAPSHOTS);
  }

  /** Delete a whole database (for example a fresh resync of a slot). Close it first. */
  static async destroy(name: string): Promise<void> {
    await deleteDB(name);
  }

  async open(): Promise<void> {
    if (this.db) return;
    if (!this.opening) {
      this.opening = openDB<ChainDB>(this.name, IDB_VERSION, {
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            db.createObjectStore('meta');
            db.createObjectStore('ledgers', { keyPath: 'seq' });
            const txs = db.createObjectStore('txs', { keyPath: 'hash' });
            txs.createIndex('ledgerSeq', ['ledgerSeq', 'applyIndex']);
            txs.createIndex('accounts', '_acct', { multiEntry: true });
            db.createObjectStore('snapshots', { keyPath: 'seq' });
          }
        },
        // Another connection wants to upgrade or delete: let it.
        blocking: () => this.dropConnection(),
        terminated: () => {
          this.db = null;
        },
      }).then(
        (db) => {
          this.db = db;
          this.opening = null;
        },
        (err: unknown) => {
          this.opening = null;
          throw err;
        },
      );
    }
    await this.opening;
  }

  async close(): Promise<void> {
    if (this.opening) await this.opening.catch(() => undefined);
    this.dropConnection();
  }

  // ------------------------------------------------------------ meta

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.requireDb().get('meta', key)) as T | undefined;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    await this.requireDb().put('meta', value, key);
  }

  // ------------------------------------------------------------ ledgers

  async putLedger(ledger: StoredLedger, txs: StoredTx[]): Promise<void> {
    const db = this.requireDb();
    validateLedgerAndTxs(ledger, txs);
    const records = txs.map(toRecord);
    const tx = db.transaction(['ledgers', 'txs'], 'readwrite');
    const ops = new Ops();
    ops.add(tx.done);
    try {
      const txStore = tx.objectStore('txs');
      const old = await txStore.index('ledgerSeq').getAllKeys(IDBKeyRange.bound([ledger.seq], [ledger.seq, Infinity]));
      for (const k of old) ops.add(txStore.delete(k));
      ops.add(tx.objectStore('ledgers').put(ledger));
      for (const r of records) ops.add(txStore.put(r));
      await Promise.all(ops.list);
    } catch (err) {
      abortQuietly(tx);
      throw err;
    }
  }

  async getLedger(seq: number): Promise<StoredLedger | undefined> {
    return this.requireDb().get('ledgers', seq);
  }

  async getLedgers(from: number, to: number): Promise<StoredLedger[]> {
    const db = this.requireDb();
    if (from > to) return [];
    return db.getAll('ledgers', IDBKeyRange.bound(from, to));
  }

  async getLatestLedgers(limit: number, beforeSeq?: number): Promise<StoredLedger[]> {
    const db = this.requireDb();
    const n = Math.floor(limit);
    if (!(n > 0)) return [];
    const range = beforeSeq === undefined ? null : IDBKeyRange.upperBound(beforeSeq, true);
    const out: StoredLedger[] = [];
    let cursor = await db.transaction('ledgers').store.openCursor(range, 'prev');
    while (cursor && out.length < n) {
      out.push(cursor.value);
      if (out.length < n) cursor = await cursor.continue();
    }
    return out;
  }

  async getMaxLedgerSeq(): Promise<number> {
    const cursor = await this.requireDb().transaction('ledgers').store.openKeyCursor(null, 'prev');
    return cursor ? cursor.key : 0;
  }

  // ------------------------------------------------------------ txs

  async getTx(hash: string): Promise<StoredTx | undefined> {
    const r = await this.requireDb().get('txs', hash);
    return r ? fromRecord(r) : undefined;
  }

  async getTxsByLedger(seq: number): Promise<StoredTx[]> {
    const rows = await this.requireDb().getAllFromIndex('txs', 'ledgerSeq', IDBKeyRange.bound([seq], [seq, Infinity]));
    return rows.map(fromRecord);
  }

  async getTxsByAccount(accountId: string, limit: number, beforeLedgerSeq?: number): Promise<StoredTx[]> {
    const db = this.requireDb();
    const n = Math.floor(limit);
    if (!(n > 0)) return [];
    const range = IDBKeyRange.bound([accountId], [accountId, beforeLedgerSeq ?? Infinity], false, true);
    return this.collectNewest(db.transaction('txs').store.index('accounts').openCursor(range, 'prev'), n);
  }

  async getLatestTxs(limit: number, beforeLedgerSeq?: number): Promise<StoredTx[]> {
    const db = this.requireDb();
    const n = Math.floor(limit);
    if (!(n > 0)) return [];
    const range = beforeLedgerSeq === undefined ? null : IDBKeyRange.upperBound([beforeLedgerSeq], true);
    return this.collectNewest(db.transaction('txs').store.index('ledgerSeq').openCursor(range, 'prev'), n);
  }

  // ------------------------------------------------------------ snapshots

  /** Stores the snapshot and deletes all but the newest `keepSnapshots`, in one transaction. */
  async putSnapshot(seq: number, data: string): Promise<void> {
    requireSeq(seq);
    const tx = this.requireDb().transaction('snapshots', 'readwrite');
    const ops = new Ops();
    ops.add(tx.done);
    try {
      ops.add(tx.store.put({ seq, data }));
      const keys = await tx.store.getAllKeys();
      for (const k of keys.slice(0, Math.max(0, keys.length - this.keepSnapshots))) ops.add(tx.store.delete(k));
      await Promise.all(ops.list);
    } catch (err) {
      abortQuietly(tx as unknown as IDBPTransaction<ChainDB, StoreNames<ChainDB>[], 'readwrite'>);
      throw err;
    }
  }

  async getSnapshot(seq: number): Promise<string | undefined> {
    return (await this.requireDb().get('snapshots', seq))?.data;
  }

  async getLatestSnapshotAtOrBefore(seq: number): Promise<{ seq: number; data: string } | undefined> {
    const cursor = await this.requireDb()
      .transaction('snapshots')
      .store.openCursor(IDBKeyRange.upperBound(seq), 'prev');
    return cursor ? { seq: cursor.value.seq, data: cursor.value.data } : undefined;
  }

  async listSnapshotSeqs(): Promise<number[]> {
    return this.requireDb().getAllKeys('snapshots');
  }

  // ------------------------------------------------------------ rollback

  async truncateAfter(seq: number): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction(['ledgers', 'txs', 'snapshots'], 'readwrite');
    const ops = new Ops();
    ops.add(tx.done);
    try {
      const txStore = tx.objectStore('txs');
      const keys = await txStore.index('ledgerSeq').getAllKeys(IDBKeyRange.lowerBound([seq, Infinity], true));
      const above = IDBKeyRange.lowerBound(seq, true);
      ops.add(tx.objectStore('ledgers').delete(above));
      ops.add(tx.objectStore('snapshots').delete(above));
      for (const k of keys) ops.add(txStore.delete(k));
      await Promise.all(ops.list);
    } catch (err) {
      abortQuietly(tx);
      throw err;
    }
  }

  async clearChain(): Promise<void> {
    const tx = this.requireDb().transaction(['ledgers', 'txs', 'snapshots'], 'readwrite');
    const ops = new Ops();
    ops.add(tx.done);
    try {
      ops.add(tx.objectStore('ledgers').clear());
      ops.add(tx.objectStore('txs').clear());
      ops.add(tx.objectStore('snapshots').clear());
      await Promise.all(ops.list);
    } catch (err) {
      abortQuietly(tx);
      throw err;
    }
  }

  // ------------------------------------------------------------ private

  private requireDb(): Db {
    if (!this.db) throw new Error(`IdbStorage ${this.name} is not open`);
    return this.db;
  }

  private dropConnection(): void {
    const db = this.db;
    this.db = null;
    db?.close();
  }

  private async collectNewest(
    first: Promise<{ value: TxRecord; continue(): Promise<unknown> } | null>,
    n: number,
  ): Promise<StoredTx[]> {
    const out: StoredTx[] = [];
    type C = { value: TxRecord; continue(): Promise<C | null> };
    let cursor = (await first) as C | null;
    while (cursor && out.length < n) {
      out.push(fromRecord(cursor.value));
      if (out.length < n) cursor = await cursor.continue();
    }
    return out;
  }
}
