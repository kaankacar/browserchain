// Quorum policy (ARCHITECTURE 10.6): a directory of the validators we know
// and the local quorum set they lead to.
//
// auto mode: the quorum set is { ceil(2n/3) of self + active validators }.
// A validator is active when it was heard (verified SCP envelope or signed
// status) within VALIDATOR_ACTIVE_MS, did not say bye, its announced LCL is
// within 1 of ours and on our chain, and it takes part in consensus: a
// status alone does not make a validator active (obs-1). The herder decides
// when a change is applied (additions at slot boundaries, removals after a
// stall or a bye).
// manual mode: the user's quorum set, never changed automatically.
//
// Member book: the validators this node saw as active members on its own
// chain, with the ledger at which it first saw each one. Fork verdicts and
// snapshot trust count only members seen at or before the ledger in
// question (ARCHITECTURE 12.2, 12.3), so identities that appear later count
// for nothing. The node persists the book.

import { VALIDATOR_ACTIVE_MS } from '../lib/constants';
import type { Clock } from '../lib/clock';
import type { LclRef, PeerInfo, PeerSyncState } from '../overlay/types';
import { checkQuorumSetSanity, compareNodeIds, normalizeQSet, sortNodeIds } from '../scp/quorum';
import type { NodeId, QuorumSet } from '../scp/types';
import { checkQuorumIntersection, faultTolerance, type IntersectionResult } from './quorumAnalysis';

export type QuorumMode = 'auto' | 'manual';

/** States in which a peer counts as following the chain (auto mode). */
const FOLLOWING: ReadonlySet<PeerSyncState> = new Set<PeerSyncState>(['booting', 'synced', 'stalled']);

export interface ValidatorRecord {
  nodeId: NodeId;
  name: string;
  isSelf: boolean;
  /** Announces itself as a validator. */
  validator: boolean;
  /** Last verified SCP envelope or signed status (local ms), 0 if never. */
  lastHeard: number;
  lastStatusAt: number;
  /** Highest slot seen in its SCP envelopes. */
  lastSlot: number;
  /** Last verified SCP envelope for a slot in [LCL-1, LCL+2] at the time (local ms), 0 if never. */
  lastScpAt: number;
  /** When this node was first heard of (local ms): its grace period starts here. */
  firstSeen: number;
  state: PeerSyncState | null;
  lcl: LclRef | null;
  qsetHash: string | null;
  quorumMode: QuorumMode | null;
  connected: boolean;
  /** Said bye; inactive until heard again. */
  gone: boolean;
  /** Known to be on another branch (set by fork handling). */
  forked: boolean;
}

/** The member book keeps at most this many validators (the one active least recently goes first). */
export const MAX_MEMBERS = 256;

/**
 * A validator counts as active without SCP envelopes for this long after it
 * is first heard of: tabs that start together see each other while booting,
 * before anybody votes, and must not each close ledgers alone.
 */
export const PARTICIPATION_GRACE_MS = 5_000;

/** A validator seen as an active member on our chain. */
export interface MemberEntry {
  nodeId: NodeId;
  /** Lowest ledger of our chain at which we saw it as an active member. */
  since: number;
  /** Highest such ledger (eviction order). */
  last: number;
}

const STRKEY_ACCOUNT = /^G[A-Z2-7]{55}$/;

/** max(1, ceil(2n/3)). */
export function autoThreshold(n: number): number {
  return Math.max(1, Math.ceil((2 * n) / 3));
}

/** The auto-mode quorum set over `ids` (normalized). */
export function autoQuorumSet(ids: Iterable<NodeId>): QuorumSet {
  const validators = sortNodeIds(new Set(ids));
  return { threshold: autoThreshold(validators.length), validators, innerSets: [] };
}

export interface QuorumManagerOptions {
  selfId: NodeId;
  selfName: string;
  clock: Clock;
  mode?: QuorumMode;
  manualQset?: QuorumSet | null;
  validating?: boolean;
  /** Default VALIDATOR_ACTIVE_MS. */
  activeWindowMs?: number;
  /** Default PARTICIPATION_GRACE_MS. */
  participationGraceMs?: number;
}

export class QuorumManager {
  readonly selfId: NodeId;
  private readonly clock: Clock;
  private readonly activeWindowMs: number;
  private readonly graceMs: number;
  private readonly records = new Map<NodeId, ValidatorRecord>();
  private readonly members = new Map<NodeId, { since: number; last: number }>();
  private mode: QuorumMode;
  private manual: QuorumSet | null;
  private validating: boolean;
  private lcl: LclRef = { seq: 0, hash: '' };
  private lclPrevHash = '';
  private intersectionCache: { key: string; result: IntersectionResult } | null = null;

  constructor(opts: QuorumManagerOptions) {
    this.selfId = opts.selfId;
    this.clock = opts.clock;
    this.activeWindowMs = opts.activeWindowMs ?? VALIDATOR_ACTIVE_MS;
    this.graceMs = opts.participationGraceMs ?? PARTICIPATION_GRACE_MS;
    this.validating = opts.validating ?? true;
    this.records.set(opts.selfId, {
      nodeId: opts.selfId,
      name: opts.selfName,
      isSelf: true,
      validator: this.validating,
      lastHeard: 0,
      lastStatusAt: 0,
      lastSlot: 0,
      lastScpAt: 0,
      firstSeen: this.clock.now(),
      state: null,
      lcl: null,
      qsetHash: null,
      quorumMode: null,
      connected: true,
      gone: false,
      forked: false,
    });
    this.mode = opts.mode ?? 'auto';
    this.manual = null;
    if (this.mode === 'manual') {
      if (!opts.manualQset) throw new Error('manual quorum mode needs a quorum set');
      this.setManual(opts.manualQset);
    }
  }

  // ------------------------------------------------------------ directory

  private record(nodeId: NodeId): ValidatorRecord {
    let r = this.records.get(nodeId);
    if (!r) {
      r = {
        nodeId,
        name: '',
        isSelf: false,
        validator: true,
        lastHeard: 0,
        lastStatusAt: 0,
        lastSlot: 0,
        lastScpAt: 0,
        firstSeen: this.clock.now(),
        state: null,
        lcl: null,
        qsetHash: null,
        quorumMode: null,
        connected: false,
        gone: false,
        forked: false,
      };
      this.records.set(nodeId, r);
    }
    return r;
  }

  /** A verified hello/status from a connected peer. */
  noteStatus(peer: PeerInfo): void {
    if (peer.nodeId === this.selfId) return;
    const r = this.record(peer.nodeId);
    const now = this.clock.now();
    const ann = peer.ann;
    r.name = ann.name;
    r.validator = ann.validator;
    r.state = ann.state;
    r.lcl = { seq: ann.lcl.seq, hash: ann.lcl.hash };
    r.qsetHash = ann.qsetHash || null;
    r.quorumMode = ann.quorumMode;
    r.connected = true;
    r.gone = false;
    r.lastHeard = now;
    r.lastStatusAt = now;
  }

  noteDisconnected(nodeId: NodeId, bye: boolean): void {
    const r = this.records.get(nodeId);
    if (!r || r.isSelf) return;
    r.connected = false;
    if (bye) r.gone = true;
  }

  /**
   * A verified, new SCP envelope from `nodeId`. One for a slot around ours
   * (LCL-1 to LCL+2) shows that it takes part in consensus. Only envelopes
   * for our LCL and later make it heard.
   */
  noteEnvelope(nodeId: NodeId, slot: number): void {
    if (nodeId === this.selfId) return;
    const r = this.record(nodeId);
    const now = this.clock.now();
    if (slot >= this.lcl.seq - 1 && slot <= this.lcl.seq + 2) r.lastScpAt = now;
    if (slot < this.lcl.seq) return;
    r.lastHeard = now;
    if (slot > r.lastSlot) r.lastSlot = slot;
  }

  noteQSetHash(nodeId: NodeId, hash: string): void {
    if (nodeId === this.selfId) return;
    this.record(nodeId).qsetHash = hash;
  }

  setSelfName(name: string): void {
    this.record(this.selfId).name = name;
  }

  setValidating(on: boolean): void {
    this.validating = on;
    this.record(this.selfId).validator = on;
  }

  isValidating(): boolean {
    return this.validating;
  }

  /** Our LCL and its parent hash (for the "same chain" checks). */
  setLocalChain(lcl: LclRef, prevHash: string): void {
    this.lcl = { seq: lcl.seq, hash: lcl.hash };
    this.lclPrevHash = prevHash;
    const self = this.record(this.selfId);
    self.lcl = { ...this.lcl };
  }

  setSelfState(state: PeerSyncState, qsetHash: string): void {
    const self = this.record(this.selfId);
    self.state = state;
    self.qsetHash = qsetHash;
    self.quorumMode = this.mode;
    self.lastHeard = this.clock.now();
  }

  markForked(nodeId: NodeId, forked: boolean): void {
    if (nodeId === this.selfId) return;
    this.record(nodeId).forked = forked;
  }

  isForked(nodeId: NodeId): boolean {
    return this.records.get(nodeId)?.forked ?? false;
  }

  isGone(nodeId: NodeId): boolean {
    return this.records.get(nodeId)?.gone ?? false;
  }

  get(nodeId: NodeId): ValidatorRecord | undefined {
    const r = this.records.get(nodeId);
    return r ? { ...r, lcl: r.lcl ? { ...r.lcl } : null } : undefined;
  }

  /** Forget disconnected nodes not heard since `cutoff` (local ms). Returns how many were dropped. */
  prune(cutoff: number): number {
    let n = 0;
    for (const [id, r] of [...this.records]) {
      if (r.isSelf || r.connected || r.lastHeard >= cutoff) continue;
      this.records.delete(id);
      n++;
    }
    return n;
  }

  name(nodeId: NodeId): string {
    return this.records.get(nodeId)?.name ?? '';
  }

  /** Every known node, self first, then by node id. */
  list(): ValidatorRecord[] {
    const out = [...this.records.values()].map((r) => ({ ...r, lcl: r.lcl ? { ...r.lcl } : null }));
    out.sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : compareNodeIds(a.nodeId, b.nodeId)));
    return out;
  }

  /**
   * Is `ref` consistent with our chain? false when it names our LCL (or its
   * parent) with another hash, null when we cannot tell.
   */
  isConsistent(ref: LclRef): boolean | null {
    if (ref.seq === this.lcl.seq) return ref.hash === this.lcl.hash;
    if (ref.seq === this.lcl.seq - 1 && this.lclPrevHash) return ref.hash === this.lclPrevHash;
    return null;
  }

  // ------------------------------------------------------------ member book

  /**
   * Record the validators that are active members on our chain right now:
   * active, with a recent signed status whose LCL is our LCL or its parent.
   * A peer one ledger ahead, or on another branch, is not recorded. Returns
   * true when the book gained a validator or an earlier ledger for one.
   */
  noteMembers(now = this.clock.now()): boolean {
    let changed = false;
    for (const r of this.records.values()) {
      if (r.isSelf || !r.lcl || now - r.lastStatusAt > this.activeWindowMs) continue;
      if (!this.isActive(r.nodeId, now) || this.isConsistent(r.lcl) !== true) continue;
      if (this.noteMember(r.nodeId, r.lcl.seq)) changed = true;
    }
    return changed;
  }

  /**
   * `nodeId` was an active member at ledger `seq` of our chain (a status on
   * our chain, or its CONFIRM / EXTERNALIZE of the value we closed for that
   * ledger). Returns true when this is news worth persisting.
   */
  noteMember(nodeId: NodeId, seq: number): boolean {
    if (nodeId === this.selfId || !Number.isSafeInteger(seq) || seq < 1) return false;
    const m = this.members.get(nodeId);
    if (m) {
      if (seq > m.last) m.last = seq;
      if (seq >= m.since) return false;
      m.since = seq;
      return true;
    }
    this.members.set(nodeId, { since: seq, last: seq });
    this.evictMembers();
    return this.members.has(nodeId);
  }

  /** Ledger at which we first saw `nodeId` as an active member, or undefined. */
  memberSince(nodeId: NodeId): number | undefined {
    return this.members.get(nodeId)?.since;
  }

  /** Was `nodeId` an active member at or before ledger `seq` of our chain? */
  wasMemberAt(nodeId: NodeId, seq: number): boolean {
    const since = this.members.get(nodeId)?.since;
    return since !== undefined && since <= seq;
  }

  memberCount(): number {
    return this.members.size;
  }

  /** Lowest ledger at which we saw any validator as an active member, or undefined when the book is empty. */
  earliestMemberSince(): number | undefined {
    let min: number | undefined;
    for (const m of this.members.values()) if (min === undefined || m.since < min) min = m.since;
    return min;
  }

  /** The book, sorted by node id (to persist it). */
  exportMembers(): MemberEntry[] {
    return sortNodeIds(this.members.keys()).map((nodeId) => ({ nodeId, ...this.members.get(nodeId)! }));
  }

  /** Load a persisted book; malformed entries are skipped. Returns how many were loaded. */
  importMembers(entries: unknown): number {
    if (!Array.isArray(entries)) return 0;
    let n = 0;
    for (const e of entries as Partial<MemberEntry>[]) {
      if (!e || typeof e.nodeId !== 'string' || !STRKEY_ACCOUNT.test(e.nodeId) || e.nodeId === this.selfId) continue;
      const since = e.since;
      const last = e.last;
      if (!Number.isSafeInteger(since) || !Number.isSafeInteger(last) || since! < 1 || last! < since!) continue;
      const m = this.members.get(e.nodeId);
      if (m) {
        m.since = Math.min(m.since, since!);
        m.last = Math.max(m.last, last!);
      } else {
        this.members.set(e.nodeId, { since: since!, last: last! });
      }
      n++;
    }
    this.evictMembers();
    return n;
  }

  /** Forget every member (a resync starts the chain over). */
  clearMembers(): void {
    this.members.clear();
  }

  private evictMembers(): void {
    while (this.members.size > MAX_MEMBERS) {
      let victim: NodeId | null = null;
      let victimLast = Infinity;
      for (const [id, m] of this.members) {
        if (m.last < victimLast || (m.last === victimLast && victim !== null && compareNodeIds(id, victim) > 0)) {
          victim = id;
          victimLast = m.last;
        }
      }
      if (victim === null) return;
      this.members.delete(victim);
    }
  }

  // ------------------------------------------------------------ policy

  getMode(): QuorumMode {
    return this.mode;
  }

  setAuto(): void {
    this.mode = 'auto';
    this.manual = null;
  }

  /** Throws when the set is not sane. */
  setManual(qset: QuorumSet): void {
    const err = checkQuorumSetSanity(qset, false);
    if (err !== null) throw new Error(`invalid quorum set: ${err}`);
    this.mode = 'manual';
    this.manual = normalizeQSet(qset);
  }

  getManual(): QuorumSet | null {
    return this.manual ? normalizeQSet(this.manual) : null;
  }

  isActive(nodeId: NodeId, now = this.clock.now()): boolean {
    const r = this.records.get(nodeId);
    if (!r) return false;
    if (r.isSelf) return this.validating;
    if (!r.validator || r.gone || r.forked) return false;
    if (now - r.lastHeard > this.activeWindowMs) return false;
    if (r.lcl && now - r.lastStatusAt <= this.activeWindowMs) {
      if (!r.state || !FOLLOWING.has(r.state)) return false;
      if (Math.abs(r.lcl.seq - this.lcl.seq) > 1) return false;
      return this.isConsistent(r.lcl) !== false && this.participates(r, now);
    }
    // heard only through SCP (not a direct peer): it works on our slot
    return r.lastSlot >= this.lcl.seq && r.lastSlot <= this.lcl.seq + 2;
  }

  /**
   * Does a peer with a fresh status take part in consensus (obs-1)? It sent
   * a signed SCP envelope for a recent slot within the active window, or it
   * voted in our open slot (LCL+1, or LCL+2 when it is one ahead): while a
   * slot is stuck nobody sends anything new, and validators that voted in it
   * must not drop each other. A peer first heard of within the grace period
   * counts too: tabs that start together boot before anybody votes.
   */
  private participates(r: ValidatorRecord, now: number): boolean {
    if (now - r.firstSeen <= this.graceMs) return true;
    if (r.lastScpAt > 0 && now - r.lastScpAt <= this.activeWindowMs) return true;
    return r.lastSlot > this.lcl.seq && r.lastSlot <= this.lcl.seq + 2;
  }

  /** Active validators (self included when validating), sorted. */
  activeIds(now = this.clock.now()): NodeId[] {
    const out: NodeId[] = [];
    for (const id of this.records.keys()) if (this.isActive(id, now)) out.push(id);
    return sortNodeIds(out);
  }

  /** The auto-mode quorum set right now. Never empty: falls back to self. */
  autoQSet(now = this.clock.now()): QuorumSet {
    const ids = this.activeIds(now);
    if (ids.length === 0) ids.push(this.selfId);
    return autoQuorumSet(ids);
  }

  /** The quorum set the policy wants now. */
  desiredQSet(now = this.clock.now()): QuorumSet {
    return this.mode === 'manual' && this.manual ? normalizeQSet(this.manual) : this.autoQSet(now);
  }

  // ------------------------------------------------------------ analysis

  faultTolerance(qset: QuorumSet): number {
    return faultTolerance(qset);
  }

  /**
   * Quorum intersection over the known validators. `lookup` resolves quorum
   * set hashes (null when unknown); our own set is passed in.
   */
  intersection(localQset: QuorumSet, lookup: (hash: string) => QuorumSet | null): IntersectionResult {
    const map = new Map<NodeId, QuorumSet | null>();
    map.set(this.selfId, localQset);
    const parts = [JSON.stringify(localQset)];
    for (const r of this.records.values()) {
      if (r.isSelf) continue;
      const q = r.qsetHash ? lookup(r.qsetHash) : null;
      map.set(r.nodeId, q);
      parts.push(`${r.nodeId}=${q ? r.qsetHash : ''}`);
    }
    // the brute-force check is costly at 16 nodes: cache it by its input
    const key = parts.join('|');
    if (this.intersectionCache?.key === key) return this.intersectionCache.result;
    const result = checkQuorumIntersection(this.selfId, map);
    this.intersectionCache = { key, result };
    return result;
  }
}
