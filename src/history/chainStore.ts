// The local chain: Storage plus an in-memory window of recent ledgers.
//
// Writes go through one queue so they reach Storage in order (closeLedger is
// synchronous, Storage is async). Recent ledgers stay in memory, so history
// requests and fork checks can be answered before the write completes.
// Loading follows ARCHITECTURE 11: latest local snapshot, then replay of the
// stored ledgers after it (or genesis when nothing is stored).

import { xdr } from '@stellar/stellar-sdk/base';
import type { Clock } from '../lib/clock';
import { CHECKPOINT_FREQUENCY } from '../lib/constants';
import type { Logger } from '../lib/log';
import { decodeLedgerHeader } from '../ledger/header';
import { LedgerManager, createGenesisLedger, loadLedgerFromSnapshot } from '../ledger/manager';
import type { LedgerCloseResult, LedgerSnapshot } from '../ledger/types';
import type { Storage, StoredLedger, StoredTx } from '../storage/types';

export const RECENT_LEDGERS = 512;
const READ_BATCH = 64;

/**
 * A branch weight covers at most this many ledgers after the fork point
 * (ARCHITECTURE 12.3). Every node weighs the same window, so fork verdicts
 * stay consistent, and one branchWeight request reads at most this many
 * ledgers.
 */
export const MAX_BRANCH_WEIGHT_LEDGERS = 1024;

/** Last seq of the weighed window after `afterSeq` on a branch whose LCL is `toSeq`. */
export function branchWeightEnd(afterSeq: number, toSeq: number): number {
  return Math.min(toSeq, afterSeq + MAX_BRANCH_WEIGHT_LEDGERS);
}

/** StoredLedger for a closed ledger. */
export function toStoredLedger(result: LedgerCloseResult, externalizedBy: number, closedAt: number): StoredLedger {
  let opCount = 0;
  let failed = 0;
  for (const r of result.results) {
    opCount += r.operations.length;
    if (!r.successful) failed++;
  }
  return {
    seq: result.header.ledgerSeq,
    hash: result.hash,
    headerXdr: result.headerXdr,
    txSetXdr: result.txSet.xdr,
    resultSetXdr: result.resultSetXdr,
    closeTime: result.header.scpValue.closeTime,
    txCount: result.results.length,
    opCount,
    failedTxCount: failed,
    closedAt,
    externalizedBy,
  };
}

/** StoredTx records of a closed ledger, in apply order. */
export function toStoredTxs(result: LedgerCloseResult): StoredTx[] {
  const seq = result.header.ledgerSeq;
  const closeTime = result.header.scpValue.closeTime;
  return result.results.map((r) => ({
    hash: r.hash,
    ledgerSeq: seq,
    applyIndex: r.applyIndex,
    envelopeXdr: r.envelopeXdr,
    resultXdr: r.resultXdr,
    sourceAccount: r.sourceAccount,
    feeCharged: r.feeCharged.toString(),
    maxFee: r.maxFee.toString(),
    successful: r.successful,
    resultCode: r.resultCode,
    closeTime,
    accounts: [...r.accounts],
    summaryJson: JSON.stringify({ operations: r.operations, memo: r.memo }),
  }));
}

/** StoredLedger for genesis (ledger 1). Its tx set and result set are empty placeholders. */
export function genesisStoredLedger(lm: LedgerManager, closedAt: number): StoredLedger {
  const lcl = lm.lastClosed();
  const txSet = new xdr.TransactionSet({ previousLedgerHash: new Uint8Array(32), txs: [] });
  const resultSet = new xdr.TransactionResultSet({ results: [] });
  return {
    seq: lcl.header.ledgerSeq,
    hash: lcl.hash,
    headerXdr: lcl.headerXdr,
    txSetXdr: txSet.toXdr('base64'),
    resultSetXdr: resultSet.toXdr('base64'),
    closeTime: lcl.header.scpValue.closeTime,
    txCount: 0,
    opCount: 0,
    failedTxCount: 0,
    closedAt,
    externalizedBy: 0,
  };
}

/** Replay one stored ledger on lm. Throws when it does not reproduce the stored hash. */
export function replayStoredLedger(lm: LedgerManager, stored: StoredLedger): LedgerCloseResult {
  const header = decodeLedgerHeader(stored.headerXdr);
  if (header.ledgerSeq !== stored.seq) throw new Error(`stored ledger ${stored.seq} has header seq ${header.ledgerSeq}`);
  const txSet = lm.decodeTxSet(stored.txSetXdr);
  const result = lm.closeLedger(txSet, header.scpValue);
  if (result.hash !== stored.hash) throw new Error(`replay of ledger ${stored.seq} gave another hash`);
  return result;
}

export interface LoadResult {
  ledger: LedgerManager;
  /** Seq of the snapshot we started from (1 = genesis). */
  fromSnapshot: number;
  /** Ledgers replayed from storage. */
  replayed: number;
  /** Set when storage had a gap or a bad ledger: everything after it was removed. */
  truncatedAfter: number | null;
}

export interface ChainStoreOptions {
  storage: Storage;
  passphrase: string;
  clock: Clock;
  logger: Logger;
  recentCapacity?: number;
}

export class ChainStore {
  readonly storage: Storage;
  readonly passphrase: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly capacity: number;
  /** seq -> ledger, a contiguous window ending at the LCL (when known). */
  private readonly recent = new Map<number, StoredLedger>();
  /** Txs of the recent ledgers we closed in this session (to rewrite a ledger). */
  private readonly recentTxs = new Map<number, StoredTx[]>();
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;

  constructor(opts: ChainStoreOptions) {
    this.storage = opts.storage;
    this.passphrase = opts.passphrase;
    this.clock = opts.clock;
    this.log = opts.logger;
    this.capacity = opts.recentCapacity ?? RECENT_LEDGERS;
  }

  /** Writes that failed (storage errors are logged, not thrown). */
  writeFailures(): number {
    return this.failures;
  }

  private enqueue(what: string, fn: () => Promise<void>): Promise<void> {
    const p = this.queue.then(fn).catch((err: unknown) => {
      this.failures++;
      this.log.error(`storage ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.queue = p;
    return p;
  }

  /** Resolves when every queued write has finished. */
  flush(): Promise<void> {
    return this.queue;
  }

  // ------------------------------------------------------------ loading

  /** Rebuild the ledger from Storage (snapshot + replay), or create genesis. */
  async loadLedger(): Promise<LoadResult> {
    await this.flush();
    this.recent.clear();
    this.recentTxs.clear();
    const genesis = createGenesisLedger(this.passphrase);
    const stored1 = await this.storage.getLedger(1);
    if (stored1 && stored1.hash !== genesis.lastClosed().hash) {
      this.log.warn('stored chain belongs to another network; clearing it');
      await this.storage.clearChain();
    }
    const maxLedger = await this.storage.getMaxLedgerSeq();
    const snaps = await this.storage.listSnapshotSeqs();
    if (maxLedger === 0 && snaps.length === 0) {
      const g = genesisStoredLedger(genesis, this.clock.now());
      await this.storage.putLedger(g, []);
      this.remember(g);
      return { ledger: genesis, fromSnapshot: 1, replayed: 0, truncatedAfter: null };
    }
    if (!stored1) {
      // keep ledger 1 around for history requests
      const g = genesisStoredLedger(genesis, this.clock.now());
      await this.storage.putLedger(g, []);
    }

    let lm: LedgerManager | null = null;
    let fromSnapshot = 1;
    for (const seq of [...snaps].sort((a, b) => b - a)) {
      const data = await this.storage.getSnapshot(seq);
      if (!data) continue;
      try {
        lm = loadLedgerFromSnapshot(JSON.parse(data) as LedgerSnapshot, this.passphrase);
        fromSnapshot = seq;
        break;
      } catch (err) {
        this.log.warn(`snapshot ${seq} is unusable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!lm) lm = genesis;

    let seq = lm.lastClosed().header.ledgerSeq + 1;
    let replayed = 0;
    let truncatedAfter: number | null = null;
    outer: while (seq <= maxLedger) {
      const batch = await this.storage.getLedgers(seq, Math.min(maxLedger, seq + READ_BATCH - 1));
      if (batch.length === 0) {
        truncatedAfter = seq - 1;
        break;
      }
      for (const stored of batch) {
        if (stored.seq !== seq) {
          truncatedAfter = seq - 1;
          break outer;
        }
        try {
          replayStoredLedger(lm, stored);
        } catch (err) {
          this.log.warn(`stored ledger ${seq} does not replay: ${err instanceof Error ? err.message : String(err)}`);
          truncatedAfter = seq - 1;
          break outer;
        }
        replayed++;
        seq++;
      }
    }
    if (truncatedAfter !== null) {
      await this.storage.truncateAfter(truncatedAfter);
      this.log.warn(`removed stored ledgers after ${truncatedAfter}`);
      // a failed replay may already have advanced lm: load again from the cut storage
      const again = await this.loadLedger();
      return { ...again, truncatedAfter };
    }
    const lclSeq = lm.lastClosed().header.ledgerSeq;
    const latest = await this.storage.getLatestLedgers(this.capacity, lclSeq + 1);
    for (const l of latest.reverse()) this.remember(l);
    return { ledger: lm, fromSnapshot, replayed, truncatedAfter };
  }

  // ------------------------------------------------------------ writing

  /**
   * Record a closed ledger: it is in memory at once, in Storage soon after.
   * `snapshot` is the JSON snapshot taken right after closing a checkpoint ledger.
   */
  record(
    result: LedgerCloseResult,
    externalizedBy: number,
    snapshot: string | null,
  ): { stored: StoredLedger; txs: StoredTx[]; persisted: Promise<void> } {
    const stored = toStoredLedger(result, externalizedBy, this.clock.now());
    const txs = toStoredTxs(result);
    this.remember(stored);
    this.recentTxs.set(stored.seq, txs);
    const persisted = this.enqueue(`putLedger ${stored.seq}`, async () => {
      await this.storage.putLedger(stored, txs);
      if (snapshot !== null) await this.storage.putSnapshot(stored.seq, snapshot);
    });
    return { stored, txs, persisted };
  }

  /**
   * Raise the externalizedBy count of a recent ledger (more CONFIRM or
   * EXTERNALIZE statements arrived after we closed it). Only ledgers closed
   * in this session can be updated.
   */
  raiseExternalizedBy(seq: number, count: number): void {
    const l = this.recent.get(seq);
    const txs = this.recentTxs.get(seq);
    if (!l || !txs || count <= l.externalizedBy) return;
    const updated = { ...l, externalizedBy: count };
    this.recent.set(seq, updated);
    void this.enqueue(`update ledger ${seq}`, () => this.storage.putLedger(updated, txs));
  }

  putSnapshot(seq: number, data: string): Promise<void> {
    return this.enqueue(`putSnapshot ${seq}`, () => this.storage.putSnapshot(seq, data));
  }

  /** Drop ledgers, txs and snapshots after seq. */
  truncateAfter(seq: number): Promise<void> {
    for (const k of [...this.recent.keys()]) if (k > seq) this.recent.delete(k);
    for (const k of [...this.recentTxs.keys()]) if (k > seq) this.recentTxs.delete(k);
    return this.enqueue(`truncateAfter ${seq}`, () => this.storage.truncateAfter(seq));
  }

  /** Delete the whole chain (identity and other meta stay). */
  clear(): Promise<void> {
    this.recent.clear();
    this.recentTxs.clear();
    return this.enqueue('clearChain', () => this.storage.clearChain());
  }

  private remember(l: StoredLedger): void {
    this.recent.set(l.seq, l);
    if (this.recent.size > this.capacity) {
      let min = Infinity;
      for (const k of this.recent.keys()) if (k < min) min = k;
      this.recent.delete(min);
    }
    // txs are only needed while a ledger's externalizedBy may still change
    for (const k of [...this.recentTxs.keys()]) if (k < l.seq - 32) this.recentTxs.delete(k);
  }

  // ------------------------------------------------------------ reading

  /** A recent ledger from memory. */
  recentLedger(seq: number): StoredLedger | undefined {
    return this.recent.get(seq);
  }

  /** Our ledger hash at seq when it is in memory. */
  hashAt(seq: number): string | undefined {
    return this.recent.get(seq)?.hash;
  }

  async getLedger(seq: number): Promise<StoredLedger | undefined> {
    return this.recent.get(seq) ?? (await this.storage.getLedger(seq));
  }

  async hashAtAsync(seq: number): Promise<string | undefined> {
    return (await this.getLedger(seq))?.hash;
  }

  /** Ledgers in [from, to], ascending, missing ones skipped. Memory first, then Storage. */
  async getLedgers(from: number, to: number): Promise<StoredLedger[]> {
    if (from > to) return [];
    const out = new Map<number, StoredLedger>();
    let allRecent = true;
    for (let s = from; s <= to; s++) {
      const r = this.recent.get(s);
      if (r) out.set(s, r);
      else allRecent = false;
    }
    if (!allRecent) {
      for (const l of await this.storage.getLedgers(from, to)) if (!out.has(l.seq)) out.set(l.seq, l);
    }
    return [...out.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Sum of externalizedBy over our ledgers in (afterSeq, branchWeightEnd(afterSeq, toSeq)]. */
  async branchWeight(afterSeq: number, toSeq: number): Promise<number> {
    const end = branchWeightEnd(afterSeq, toSeq);
    let sum = 0;
    for (let from = afterSeq + 1; from <= end; from += 256) {
      const batch = await this.getLedgers(from, Math.min(end, from + 255));
      for (const l of batch) sum += l.externalizedBy;
    }
    return sum;
  }

  /** Latest stored snapshot with seq <= atOrBefore. */
  async snapshotAtOrBefore(atOrBefore: number): Promise<{ seq: number; data: string } | undefined> {
    await this.flush();
    return this.storage.getLatestSnapshotAtOrBefore(atOrBefore);
  }

  /** Transaction envelopes of our ledgers after seq (to re-queue after a rollback). */
  async txEnvelopesAfter(seq: number, toSeq: number): Promise<string[]> {
    await this.flush();
    const out: string[] = [];
    for (let s = seq + 1; s <= toSeq; s++) {
      for (const tx of await this.storage.getTxsByLedger(s)) out.push(tx.envelopeXdr);
    }
    return out;
  }

  /** True when seq is a checkpoint (a snapshot is taken after closing it). */
  static isCheckpoint(seq: number): boolean {
    return seq > 0 && seq % CHECKPOINT_FREQUENCY === 0;
  }
}

