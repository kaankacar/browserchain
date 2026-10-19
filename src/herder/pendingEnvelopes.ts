// Ported from stellar-core (Apache-2.0): src/herder/PendingEnvelopes.cpp (simplified)
//
// SCP envelopes wait here until the quorum set and every tx set they refer to
// are known (ARCHITECTURE 10.4). Missing items are requested from the peer
// that sent the envelope, then from the statement's node, then from the other
// peers (GET_TX_SET / GET_SCP_QUORUMSET, DONT_HAVE moves to the next peer).
// Ready envelopes for slots the herder cannot process yet (future slots, or
// any slot while not synced) stay buffered in arrival order.

import type { Clock, TimerHandle } from '../lib/clock';
import { LEDGER_VALIDITY_BRACKET } from '../lib/constants';
import type { Logger } from '../lib/log';
import type { Rng } from '../lib/random';
import type { TxSetInfo } from '../ledger/types';
import { makeGetScpQuorumSetMessage, makeGetTxSetMessage } from '../overlay/stellarMessage';
import { getCompanionQuorumSetHashFromStatement } from '../scp/ballot';
import { checkQuorumSetSanity } from '../scp/quorum';
import type { Envelope, Hash, QuorumSet } from '../scp/types';
import { hashQuorumSet } from '../scp/xdr';
import type { HerderNet } from './types';
import { Lru } from './lru';
import { decodeValue, statementValues, txSetStats, type TxSetStats } from './values';

export const FETCH_RETRY_MS = 1000;
export const FETCH_ROUNDS = 3;
/** Give up an item after this many requests (or retries without peers). */
export const FETCH_MAX_ATTEMPTS = 30;
export const MAX_WAITING_ENVELOPES = 2000;
export const MAX_BUFFERED_PER_SLOT = 512;
export const TX_SET_CACHE_SIZE = 256;
export const QSET_CACHE_SIZE = 512;
/**
 * Max votes, and max accepted values, in a nomination. SCP checks every value
 * of a round leader's nomination (a signature check each), so a huge one
 * would cost every node seconds per slot.
 */
export const MAX_NOMINATION_VALUES = 64;

/** True for a nomination with more than MAX_NOMINATION_VALUES votes or accepted values. */
export function isOversizedNomination(env: Envelope): boolean {
  const p = env.statement.pledges;
  return p.type === 'nominate' && (p.votes.length > MAX_NOMINATION_VALUES || p.accepted.length > MAX_NOMINATION_VALUES);
}

export interface CachedTxSet {
  info: TxSetInfo;
  /** Latest slot this tx set was used for (purging). */
  slot: number;
  stats: TxSetStats;
}

export interface PendingDeps {
  clock: Clock;
  logger: Logger;
  rng: Rng;
  net: HerderNet;
  networkId: Uint8Array;
  /** LCL seq and hash. */
  lcl(): { seq: number; hash: string };
  /** True when envelopes for the slot may go to SCP right now. */
  canProcess(slot: number): boolean;
  /** Feed a ready envelope to SCP. */
  process(env: Envelope, from: string | null): void;
  /** A ready envelope was buffered because its slot cannot be processed yet. */
  onBuffered?(env: Envelope, from: string | null): void;
}

export type ReceiveStatus = 'duplicate' | 'discarded' | 'fetching' | 'ready' | 'buffered';

interface Waiting {
  key: string;
  env: Envelope;
  slot: number;
  from: string | null;
  arrival: number;
  missing: Set<string>;
}

interface Tracker {
  item: string;
  kind: 'txSet' | 'qset';
  hash: string;
  waiting: Set<string>;
  preferred: string[];
  tried: Set<string>;
  current: string | null;
  rounds: number;
  attempts: number;
  timer: TimerHandle | null;
  /** Highest slot of the envelopes waiting for it (tags the cached item). */
  slot: number;
}

interface Buffered {
  env: Envelope;
  from: string | null;
  arrival: number;
}

function txItem(hash: string): string {
  return `t:${hash}`;
}

function qsetItem(hash: string): string {
  return `q:${hash}`;
}

export class PendingEnvelopes {
  private readonly txSets = new Map<Hash, CachedTxSet>();
  private readonly qsets = new Lru<Hash, QuorumSet>(QSET_CACHE_SIZE);
  /** Our own quorum sets: never evicted. */
  private readonly pinnedQSets = new Map<Hash, QuorumSet>();
  /** Envelope keys seen per slot (processing dedupe). */
  private readonly seen = new Map<number, Set<string>>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly trackers = new Map<string, Tracker>();
  private readonly buffered = new Map<number, Buffered[]>();
  private arrival = 0;
  private stopped = false;

  constructor(private readonly deps: PendingDeps) {}

  // ------------------------------------------------------------ envelopes

  /**
   * A signature-checked envelope from the network. `key` identifies its
   * bytes, `from` is the peer it came from (null: local or unknown).
   */
  receive(env: Envelope, key: string, from: string | null): ReceiveStatus {
    if (this.stopped || isOversizedNomination(env)) return 'discarded';
    const slot = env.statement.slotIndex;
    let seenSet = this.seen.get(slot);
    if (seenSet?.has(key)) return 'duplicate';
    const items = this.dependencies(env);
    if (items === null) return 'discarded';
    if (!seenSet) {
      seenSet = new Set();
      this.seen.set(slot, seenSet);
    }
    seenSet.add(key);
    const arrival = ++this.arrival;
    for (const it of items) {
      // keep tx sets as long as the newest envelope that needs them
      const c = it[0] === 't' ? this.txSets.get(it.slice(2)) : undefined;
      if (c && slot > c.slot) c.slot = slot;
    }
    const missing = items.filter((it) => !this.has(it));
    if (missing.length === 0) return this.ready(env, key, from, arrival);
    if (this.waiting.size >= MAX_WAITING_ENVELOPES) this.evictOldestWaiting();
    const w: Waiting = { key, env, slot, from, arrival, missing: new Set(missing) };
    this.waiting.set(key, w);
    for (const item of missing) this.fetch(item, w);
    return 'fetching';
  }

  /** True when this exact envelope was already received for the slot. */
  isSeen(slot: number, key: string): boolean {
    return this.seen.get(slot)?.has(key) ?? false;
  }

  /** Quorum set and tx set items an envelope needs; null if a value is malformed or unsigned. */
  dependencies(env: Envelope): string[] | null {
    const st = env.statement;
    const items = [qsetItem(getCompanionQuorumSetHashFromStatement(st))];
    for (const v of statementValues(st)) {
      const info = decodeValue(v);
      if (!info || !info.signature) return null;
      const it = txItem(info.txSetHash);
      if (!items.includes(it)) items.push(it);
    }
    return items;
  }

  private has(item: string): boolean {
    const hash = item.slice(2);
    return item[0] === 't' ? this.txSets.has(hash) : this.qsets.has(hash) || this.pinnedQSets.has(hash);
  }

  private ready(env: Envelope, key: string, from: string | null, arrival: number): ReceiveStatus {
    const slot = env.statement.slotIndex;
    if (this.deps.canProcess(slot)) {
      this.deps.process(env, from);
      return 'ready';
    }
    let list = this.buffered.get(slot);
    if (!list) {
      list = [];
      this.buffered.set(slot, list);
    }
    if (list.length >= MAX_BUFFERED_PER_SLOT) {
      this.seen.get(slot)?.delete(key);
      return 'discarded';
    }
    list.push({ env, from, arrival });
    this.deps.onBuffered?.(env, from);
    return 'buffered';
  }

  /**
   * Feed buffered envelopes whose slot can be processed now (arrival order),
   * and forget buffered slots at or below the LCL.
   */
  pump(): void {
    const lcl = this.deps.lcl().seq;
    const slots = [...this.buffered.keys()].sort((a, b) => a - b);
    for (const slot of slots) {
      if (this.stopped) return;
      if (slot <= lcl) {
        this.buffered.delete(slot);
        continue;
      }
      if (!this.deps.canProcess(slot)) continue;
      const list = this.buffered.get(slot) ?? [];
      this.buffered.delete(slot);
      list.sort((a, b) => a.arrival - b.arrival);
      for (const b of list) this.deps.process(b.env, b.from);
    }
  }

  /** Slots with buffered envelopes, ascending. */
  bufferedSlots(): number[] {
    return [...this.buffered.keys()].sort((a, b) => a - b);
  }

  /** Buffered envelopes of a slot (arrival order). */
  bufferedEnvelopes(slot: number): Envelope[] {
    return (this.buffered.get(slot) ?? []).map((b) => b.env);
  }

  waitingCount(): number {
    return this.waiting.size;
  }

  // ------------------------------------------------------------ tx sets

  getTxSet(hash: Hash): CachedTxSet | undefined {
    return this.txSets.get(hash);
  }

  /**
   * Store a tx set. Unsolicited ones (nobody is waiting for them) are kept
   * only when they build on our LCL, unless `force`. Returns true if stored.
   */
  addTxSet(info: TxSetInfo, opts: { slot?: number; force?: boolean } = {}): boolean {
    if (this.stopped) return false;
    const lcl = this.deps.lcl();
    const item = txItem(info.hash);
    const tracker = this.trackers.get(item);
    const slot = Math.max(opts.slot ?? lcl.seq + 1, tracker?.slot ?? 0);
    const existing = this.txSets.get(info.hash);
    if (existing) {
      if (slot > existing.slot) existing.slot = slot;
      return false;
    }
    if (!tracker && !opts.force && info.previousLedgerHash !== lcl.hash) return false;
    this.txSets.set(info.hash, { info, slot, stats: txSetStats(info, this.deps.networkId) });
    this.evictTxSets();
    if (tracker) this.resolve(tracker);
    return true;
  }

  /** True if someone waits for this tx set. */
  isFetching(kind: 'txSet' | 'qset', hash: Hash): boolean {
    return this.trackers.has(kind === 'txSet' ? txItem(hash) : qsetItem(hash));
  }

  private evictTxSets(): void {
    if (this.txSets.size <= TX_SET_CACHE_SIZE) return;
    const current = this.deps.lcl().seq + 1;
    // oldest slots first; keep tx sets of the current slot and later
    const victims = [...this.txSets.entries()]
      .filter(([, c]) => c.slot < current)
      .sort((a, b) => a[1].slot - b[1].slot);
    for (const [hash] of victims) {
      if (this.txSets.size <= TX_SET_CACHE_SIZE) break;
      this.txSets.delete(hash);
    }
  }

  // ------------------------------------------------------------ quorum sets

  getQSet(hash: Hash): QuorumSet | null {
    return this.pinnedQSets.get(hash) ?? this.qsets.get(hash) ?? null;
  }

  /** Our own quorum set: always answerable. */
  pinQSet(qset: QuorumSet): Hash {
    const hash = hashQuorumSet(qset);
    this.pinnedQSets.set(hash, qset);
    return hash;
  }

  /** A quorum set from the network. Returns its hash, or null if not sane. */
  addQSet(qset: QuorumSet): Hash | null {
    const hash = hashQuorumSet(qset);
    const item = qsetItem(hash);
    const tracker = this.trackers.get(item);
    if (checkQuorumSetSanity(qset, false) !== null) {
      // PendingEnvelopes::discardSCPEnvelopesWithQSet
      if (tracker) this.giveUp(tracker, 'insane quorum set');
      return null;
    }
    if (!this.pinnedQSets.has(hash)) this.qsets.set(hash, qset);
    if (tracker) this.resolve(tracker);
    return hash;
  }

  // ------------------------------------------------------------ fetching

  private fetch(item: string, w: Waiting): void {
    let t = this.trackers.get(item);
    if (!t) {
      t = {
        item,
        kind: item[0] === 't' ? 'txSet' : 'qset',
        hash: item.slice(2),
        waiting: new Set(),
        preferred: [],
        tried: new Set(),
        current: null,
        rounds: 0,
        attempts: 0,
        timer: null,
        slot: w.slot,
      };
      this.trackers.set(item, t);
    }
    t.waiting.add(w.key);
    if (w.slot > t.slot) t.slot = w.slot;
    for (const p of [w.from, w.env.statement.nodeId]) {
      if (p && !t.preferred.includes(p)) t.preferred.push(p);
    }
    if (t.timer === null && t.current === null) this.askNext(t);
  }

  /** A peer said it does not have an item: ask the next one now. */
  onDontHave(kind: 'txSet' | 'qset', hash: Hash, from: string): void {
    const t = this.trackers.get(kind === 'txSet' ? txItem(hash) : qsetItem(hash));
    if (!t || t.current !== from) return;
    this.askNext(t);
  }

  private askNext(t: Tracker): void {
    if (t.timer !== null) {
      this.deps.clock.clearTimeout(t.timer);
      t.timer = null;
    }
    if (this.stopped || this.trackers.get(t.item) !== t) return;
    if (++t.attempts > FETCH_MAX_ATTEMPTS) {
      this.giveUp(t, 'too many attempts');
      return;
    }
    const connected = this.deps.net.peers().map((p) => p.nodeId);
    const connectedSet = new Set(connected);
    let candidates = this.order(t, connected, connectedSet);
    if (candidates.length === 0 && connected.length > 0) {
      t.rounds++;
      if (t.rounds >= FETCH_ROUNDS) {
        this.giveUp(t, 'no peer has it');
        return;
      }
      t.tried.clear();
      candidates = this.order(t, connected, connectedSet);
    }
    const peer = candidates[0];
    t.current = peer ?? null;
    if (peer) {
      t.tried.add(peer);
      const msg = t.kind === 'txSet' ? makeGetTxSetMessage(t.hash) : makeGetScpQuorumSetMessage(t.hash);
      this.deps.net.sendStellar(peer, msg);
    }
    t.timer = this.deps.clock.setTimeout(() => {
      t.timer = null;
      this.askNext(t);
    }, FETCH_RETRY_MS);
  }

  private order(t: Tracker, connected: string[], connectedSet: Set<string>): string[] {
    const first = t.preferred.filter((p) => connectedSet.has(p) && !t.tried.has(p));
    const rest = connected.filter((p) => !t.tried.has(p) && !first.includes(p));
    // seeded shuffle so that requests spread over peers
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(this.deps.rng() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return [...first, ...rest];
  }

  private resolve(t: Tracker): void {
    this.dropTracker(t);
    const ready: Waiting[] = [];
    for (const key of t.waiting) {
      const w = this.waiting.get(key);
      if (!w) continue;
      w.missing.delete(t.item);
      if (w.missing.size === 0) {
        this.waiting.delete(key);
        ready.push(w);
      }
    }
    ready.sort((a, b) => a.arrival - b.arrival);
    for (const w of ready) {
      if (this.stopped) return;
      this.ready(w.env, w.key, w.from, w.arrival);
    }
  }

  private giveUp(t: Tracker, why: string): void {
    this.dropTracker(t);
    let n = 0;
    for (const key of t.waiting) {
      const w = this.waiting.get(key);
      if (!w) continue;
      this.discardWaiting(w);
      n++;
    }
    if (n > 0) this.deps.logger.debug(`gave up fetching ${t.kind} ${t.hash.slice(0, 8)} (${why}); dropped ${n} envelopes`);
  }

  private dropTracker(t: Tracker): void {
    if (t.timer !== null) this.deps.clock.clearTimeout(t.timer);
    t.timer = null;
    if (this.trackers.get(t.item) === t) this.trackers.delete(t.item);
  }

  private discardWaiting(w: Waiting): void {
    this.waiting.delete(w.key);
    // the envelope may come back later (e.g. from scpState)
    this.seen.get(w.slot)?.delete(w.key);
    for (const item of w.missing) {
      const t = this.trackers.get(item);
      if (!t) continue;
      t.waiting.delete(w.key);
      if (t.waiting.size === 0) this.dropTracker(t);
    }
  }

  private evictOldestWaiting(): void {
    let oldest: Waiting | undefined;
    for (const w of this.waiting.values()) if (!oldest || w.arrival < oldest.arrival) oldest = w;
    if (oldest) this.discardWaiting(oldest);
  }

  // ------------------------------------------------------------ cleanup

  /** Forget data for slots < minSlot, and buffered slots beyond the validity bracket. */
  purge(minSlot: number): void {
    const maxSlot = this.deps.lcl().seq + LEDGER_VALIDITY_BRACKET;
    for (const slot of [...this.seen.keys()]) if (slot < minSlot || slot > maxSlot) this.seen.delete(slot);
    for (const slot of [...this.buffered.keys()]) if (slot < minSlot || slot > maxSlot) this.buffered.delete(slot);
    for (const w of [...this.waiting.values()]) if (w.slot < minSlot || w.slot > maxSlot) this.discardWaiting(w);
    for (const [hash, c] of [...this.txSets]) if (c.slot < minSlot) this.txSets.delete(hash);
  }

  /** Drop everything tied to the chain (after a rollback or resync). Quorum sets stay. */
  reset(): void {
    for (const t of [...this.trackers.values()]) this.dropTracker(t);
    this.waiting.clear();
    this.buffered.clear();
    this.seen.clear();
    this.txSets.clear();
  }

  stop(): void {
    this.stopped = true;
    this.reset();
  }
}
