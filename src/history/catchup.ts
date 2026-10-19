// Catch-up (ARCHITECTURE 12.2): bring the local ledger to a target (seq,
// hash) announced by peers, by replaying the source's ledgers or by loading
// the source's snapshot first.
//
// Nothing from the source is trusted. Before anything is applied, the header
// chain is downloaded and checked link by link (previousLedgerHash) from our
// LCL (or the verified snapshot) to the target hash. Every replayed ledger
// must then reproduce the verified header hash, and its tx set must match the
// header's StellarValue. A source that fails a check is reported as
// 'bad-source' and the caller tries another peer.

import { CHECKPOINT_FREQUENCY } from '../lib/constants';
import type { Logger } from '../lib/log';
import { decodeLedgerHeader, hashLedgerHeader } from '../ledger/header';
import { loadLedgerFromSnapshot, type LedgerManager } from '../ledger/manager';
import type { LedgerCloseResult, LedgerHeader, LedgerSnapshot } from '../ledger/types';
import type { LclRef, RequestBody, ResponseBody } from '../overlay/types';
import { MAX_LEDGERS_PER_REQUEST } from './server';

export type CatchupErrorCode =
  /** The source does not have what we asked for. */
  | 'no-data'
  /** The source sent data that does not verify (tampered, or another chain than the target). */
  | 'bad-source'
  /** Our LCL is not on the source's chain. */
  | 'fork'
  /** A request failed (timeout, disconnect). */
  | 'network'
  /** Our replay gave another hash than the verified header: local state must be reloaded. */
  | 'diverged'
  | 'aborted';

export class CatchupError extends Error {
  constructor(
    readonly code: CatchupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatchupError';
  }
}

export interface CatchupHost {
  request(nodeId: string, body: RequestBody, timeoutMs?: number): Promise<ResponseBody>;
  passphrase: string;
  logger: Logger;
  /** The current ledger. */
  ledger(): LedgerManager;
  /**
   * Install a ledger loaded from a verified snapshot. The host stores the
   * snapshot and removes stored ledgers after it.
   */
  installSnapshot(lm: LedgerManager, data: string): Promise<void>;
  /** A ledger replayed from the source: persist it and update the queue. */
  replayed(result: LedgerCloseResult): void;
  progress?(p: { target: number; current: number; source: string }): void;
  aborted?(): boolean;
  /**
   * True once this attempt has used its time budget (catchupAttemptBudgetMs):
   * the next request fails with 'network' instead of being sent. What was
   * replayed so far is kept.
   */
  expired?(): boolean;
  requestTimeoutMs?: number;
}

/**
 * Time budget of one catch-up attempt from one source: 30 s, plus 5 s for
 * every 64 ledgers to fetch. A source that answers each request just before
 * the request timeout cannot hold us in catching-up much longer than this.
 */
export function catchupAttemptBudgetMs(ledgers: number): number {
  return 30_000 + 5_000 * Math.ceil(Math.max(0, ledgers) / MAX_LEDGERS_PER_REQUEST);
}

export interface CatchupResult {
  source: string;
  from: number;
  to: number;
  replayed: number;
  /** Seq of the snapshot we loaded, or null when we only replayed. */
  snapshot: number | null;
}

async function ask<K extends ResponseBody['kind']>(
  host: CatchupHost,
  source: string,
  body: RequestBody & { kind: K },
): Promise<Extract<ResponseBody, { kind: K }>> {
  if (host.aborted?.()) throw new CatchupError('aborted', 'catch-up aborted');
  if (host.expired?.()) throw new CatchupError('network', `the catch-up attempt took too long (before a ${body.kind} request)`);
  let res: ResponseBody;
  try {
    res = await host.request(source, body, host.requestTimeoutMs);
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CatchupError(code === 'no-data' ? 'no-data' : 'network', `${body.kind} request failed: ${msg}`);
  }
  if (host.aborted?.()) throw new CatchupError('aborted', 'catch-up aborted');
  if (res.kind !== body.kind) throw new CatchupError('bad-source', `expected a ${body.kind} answer`);
  return res as Extract<ResponseBody, { kind: K }>;
}

function decodeHeader(b64: string, seq: number): LedgerHeader {
  let h: LedgerHeader;
  try {
    h = decodeLedgerHeader(b64);
  } catch {
    throw new CatchupError('bad-source', `header ${seq} is malformed`);
  }
  if (h.ledgerSeq !== seq) throw new CatchupError('bad-source', `header ${seq} claims seq ${h.ledgerSeq}`);
  return h;
}

/** Hash of the source's header at seq (null when it does not have it). */
export async function fetchHeaderHash(host: CatchupHost, source: string, seq: number): Promise<string | null> {
  const res = await ask(host, source, { kind: 'headers', from: seq, to: seq });
  const item = res.items.find((i) => i.seq === seq);
  return item ? hashLedgerHeader(decodeHeader(item.headerXdr, seq)) : null;
}

/**
 * Download headers [from, to] and check that they link from prevHash (the
 * hash of ledger from-1) and end at endHash. Returns seq -> verified hash,
 * including from-1.
 */
export async function fetchHeaderChain(
  host: CatchupHost,
  source: string,
  from: number,
  to: number,
  prevHash: string,
  endHash: string,
): Promise<Map<number, string>> {
  const verified = new Map<number, string>([[from - 1, prevHash]]);
  let prev = prevHash;
  for (let b = from; b <= to; b += MAX_LEDGERS_PER_REQUEST) {
    const e = Math.min(to, b + MAX_LEDGERS_PER_REQUEST - 1);
    const res = await ask(host, source, { kind: 'headers', from: b, to: e });
    const items = [...res.items].sort((x, y) => x.seq - y.seq);
    let expect = b;
    for (const it of items) {
      if (it.seq < expect || it.seq > e) continue;
      if (it.seq !== expect) throw new CatchupError('no-data', `source lacks header ${expect}`);
      const h = decodeHeader(it.headerXdr, it.seq);
      if (h.previousLedgerHash !== prev) {
        throw new CatchupError('bad-source', `header ${it.seq} does not link to ledger ${it.seq - 1}`);
      }
      prev = hashLedgerHeader(h);
      verified.set(it.seq, prev);
      expect++;
    }
    if (expect <= e) throw new CatchupError('no-data', `source lacks header ${expect}`);
  }
  if (prev !== endHash) throw new CatchupError('bad-source', `header chain does not end at the target ${endHash.slice(0, 8)}`);
  return verified;
}

/**
 * Replay ledgers [from, to] from the source. Each one must reproduce the
 * verified hash. Returns the number of ledgers applied.
 */
export async function replayLedgers(
  host: CatchupHost,
  source: string,
  verified: Map<number, string>,
  from: number,
  to: number,
): Promise<number> {
  let replayed = 0;
  for (let b = from; b <= to; b += MAX_LEDGERS_PER_REQUEST) {
    const e = Math.min(to, b + MAX_LEDGERS_PER_REQUEST - 1);
    if (host.ledger().lastClosed().header.ledgerSeq >= e) continue;
    const res = await ask(host, source, { kind: 'ledgers', from: b, to: e });
    const items = [...res.items].sort((x, y) => x.seq - y.seq);
    for (const item of items) {
      const lm = host.ledger();
      const lcl = lm.lastClosed();
      const lclSeq = lcl.header.ledgerSeq;
      if (item.seq <= lclSeq || item.seq > e) continue;
      if (item.seq !== lclSeq + 1) throw new CatchupError('no-data', `source lacks ledger ${lclSeq + 1}`);
      const expected = verified.get(item.seq);
      if (expected === undefined) throw new CatchupError('bad-source', `unexpected ledger ${item.seq}`);
      if (verified.get(lclSeq) !== lcl.hash) throw new CatchupError('fork', `our ledger ${lclSeq} is not on the verified chain`);
      const header = decodeHeader(item.headerXdr, item.seq);
      if (hashLedgerHeader(header) !== expected) {
        throw new CatchupError('bad-source', `header ${item.seq} does not match the verified chain`);
      }
      let txSet;
      try {
        txSet = lm.decodeTxSet(item.txSetXdr);
      } catch {
        throw new CatchupError('bad-source', `tx set of ledger ${item.seq} is malformed`);
      }
      if (txSet.hash !== header.scpValue.txSetHash) {
        throw new CatchupError('bad-source', `tx set of ledger ${item.seq} does not match its header`);
      }
      let result: LedgerCloseResult;
      try {
        result = lm.closeLedger(txSet, header.scpValue);
      } catch (err) {
        throw new CatchupError('bad-source', `ledger ${item.seq} cannot be applied: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (result.hash !== expected) {
        throw new CatchupError('diverged', `replay of ledger ${item.seq} gave ${result.hash.slice(0, 8)}, expected ${expected.slice(0, 8)}`);
      }
      host.replayed(result);
      replayed++;
      host.progress?.({ target: to, current: item.seq, source });
    }
    if (host.ledger().lastClosed().header.ledgerSeq < e) {
      throw new CatchupError('no-data', `source lacks ledger ${host.ledger().lastClosed().header.ledgerSeq + 1}`);
    }
  }
  return replayed;
}

/** Latest checkpoint <= seq (0 when none). */
export function checkpointAtOrBefore(seq: number): number {
  return seq - (seq % CHECKPOINT_FREQUENCY);
}

/**
 * Catch up to `target` from one source (ARCHITECTURE 12.2). Throws a
 * CatchupError; 'fork' means our LCL is not on the source's chain.
 */
export async function catchUpFrom(
  host: CatchupHost,
  source: string,
  target: LclRef,
  opts: { allowSnapshot?: boolean } = {},
): Promise<CatchupResult> {
  const start = host.ledger().lastClosed();
  const startSeq = start.header.ledgerSeq;
  if (startSeq >= target.seq) {
    if (startSeq === target.seq && start.hash !== target.hash) throw new CatchupError('fork', 'same seq, other hash');
    return { source, from: startSeq, to: startSeq, replayed: 0, snapshot: null };
  }
  const cp = checkpointAtOrBefore(target.seq);
  const snapshotHelps = (opts.allowSnapshot ?? true) && cp >= CHECKPOINT_FREQUENCY && cp > startSeq;

  // Step 2: is our LCL on the source's chain?
  const theirs = await fetchHeaderHash(host, source, startSeq).catch((err: unknown) => {
    if (err instanceof CatchupError && err.code === 'no-data') return null;
    throw err;
  });
  if (theirs !== null && theirs !== start.hash) {
    throw new CatchupError('fork', `ledger ${startSeq} differs from the source's`);
  }
  if (theirs === null && !snapshotHelps) throw new CatchupError('no-data', `source lacks header ${startSeq}`);

  if (snapshotHelps) {
    const res = await ask(host, source, { kind: 'snapshot', atOrBefore: cp });
    if (res.seq > startSeq && res.seq <= target.seq) {
      let lm: LedgerManager;
      try {
        lm = loadLedgerFromSnapshot(JSON.parse(res.data) as LedgerSnapshot, host.passphrase);
      } catch (err) {
        throw new CatchupError('bad-source', `snapshot ${res.seq} does not verify: ${err instanceof Error ? err.message : String(err)}`);
      }
      const snap = lm.lastClosed();
      if (snap.header.ledgerSeq !== res.seq) throw new CatchupError('bad-source', 'snapshot seq mismatch');
      // The headers below the snapshot are not required: a source that joined
      // from a snapshot stores none, and a liar can forge them anyway. Whether
      // a snapshot may be used at all is the caller's decision (Node: only at
      // genesis, or when no source can replay and peers vouch strongly).
      const verified =
        res.seq === target.seq
          ? new Map<number, string>([[res.seq, snap.hash]])
          : await fetchHeaderChain(host, source, res.seq + 1, target.seq, snap.hash, target.hash);
      if (res.seq === target.seq && snap.hash !== target.hash) {
        throw new CatchupError('bad-source', 'snapshot is not the target ledger');
      }
      await host.installSnapshot(lm, res.data);
      host.logger.info(`loaded snapshot ${res.seq} from ${source.slice(0, 8)}`);
      const replayed = await replayLedgers(host, source, verified, res.seq + 1, target.seq);
      return { source, from: startSeq, to: target.seq, replayed, snapshot: res.seq };
    }
    if (theirs === null) throw new CatchupError('no-data', `source has no usable snapshot`);
  }

  const verified = await fetchHeaderChain(host, source, startSeq + 1, target.seq, start.hash, target.hash);
  const replayed = await replayLedgers(host, source, verified, startSeq + 1, target.seq);
  return { source, from: startSeq, to: target.seq, replayed, snapshot: null };
}
