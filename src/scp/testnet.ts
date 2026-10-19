// In-process network of SCP instances for tests (used by sim*.test.ts).
//
// Each SimNode is an SCP instance plus a minimal herder stand-in: it buffers
// envelopes for future slots, triggers the next slot after externalizing,
// validates values like HerderSCPDriver (MaybeValid for slots other than
// LCL+1) and runs timers on the shared VirtualClock. Links have seeded random
// delays (messages get reordered), optional drops and optional signatures.

import type { Keypair } from '@stellar/stellar-sdk/base';
import { fromHex, readUint64BE, toHex, writeUint32BE, writeUint64BE, concatBytes } from '../lib/bytes';
import { VirtualClock, type TimerHandle } from '../lib/clock';
import { networkIdOf } from '../lib/hash';
import { seededRng, type Rng } from '../lib/random';
import type { SCPDriver } from './driver';
import { computeHashNode, computeValueHash } from './hash';
import { UINT32_MAX } from './quorum';
import { SCP } from './scp';
import { nodeKeypair } from './testkit';
import { ValidationLevel } from './types';
import type { Ballot, Envelope, Hash, NodeId, NominatePledge, Pledges, QuorumSet, Value } from './types';
import { signEnvelope, verifyEnvelope } from './xdr';

export const SIM_NETWORK_ID = networkIdOf('BrowserChain SCP simulation');

const MAGIC = 0x53435056; // "SCPV"

/** A test value: magic(4) || slot(8) || node index(4) || nonce(4). */
export function makeSimValue(slot: number, nodeIndex: number, nonce = 0): Value {
  return toHex(concatBytes(writeUint32BE(MAGIC), writeUint64BE(BigInt(slot)), writeUint32BE(nodeIndex), writeUint32BE(nonce)));
}

export function parseSimValue(value: Value): { slot: number; nodeIndex: number; nonce: number } | null {
  if (value.length !== 40) return null;
  const b = fromHex(value);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0) !== MAGIC) return null;
  return { slot: Number(readUint64BE(b, 4)), nodeIndex: dv.getUint32(12), nonce: dv.getUint32(16) };
}

export const GENESIS_VALUE: Value = makeSimValue(0, 0, 0);

export type ByzantineMode =
  /** sends conflicting (signed) nominations to two halves of its peers */
  | 'equivocate-nomination'
  /** also equivocates on ballot statements and (when signing) forges envelopes of others */
  | 'equivocate-all'
  /** also sends random well-formed statements (odd counters, values it has seen) to random peers */
  | 'random';

export interface NodeSpec {
  name: string | number;
  /** crashed from the start: never sends or receives */
  crashed?: boolean;
  byzantine?: ByzantineMode;
  /** non-validator: follows the network, never emits */
  watcher?: boolean;
}

/** One envelope a node emitted (for checks on what peers saw). */
export interface EmittedRecord {
  at: number;
  slot: number;
  type: string;
  qsetHash: Hash;
}

export interface NetworkOptions {
  seed: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** probability that a message gets a large extra delay */
  slowRate?: number;
  slowExtraMs?: number;
  /** probability that a message is lost */
  dropRate?: number;
  /** when > 0, nodes re-send their latest envelopes (herder rebroadcast) */
  rebroadcastMs?: number;
  /** sign envelopes and verify them on receipt */
  signing?: boolean;
  /** delay before a node nominates the next slot after externalizing */
  triggerDelayMs?: [number, number];
}

export interface SimStats {
  delivered: number;
  dropped: number;
  rejectedSignature: number;
  emitted: number;
  /** envelopes a Byzantine node sent in two conflicting versions */
  equivocations: number;
  /** forged envelopes sent by a Byzantine node */
  forgeries: number;
  /** random statements sent by 'random' Byzantine nodes */
  randomStatements: number;
  /** exceptions thrown by SCP at honest nodes (receive, timers, nominate) */
  exceptions: number;
  /** exceptions thrown by SCP at Byzantine nodes (they run honest SCP code too) */
  byzantineExceptions: number;
}

export class SimNode implements SCPDriver {
  readonly id: NodeId;
  readonly keypair: Keypair;
  scp!: SCP;
  crashed: boolean;
  readonly byzantine: ByzantineMode | null;
  readonly watcher: boolean;
  readonly emittedLog: EmittedRecord[] = [];

  /** last externalized slot (LCL) */
  lcl = 0;
  targetSlot = 0;
  readonly externalized = new Map<number, Value>();
  readonly externalizedAt = new Map<number, number>();
  readonly slotStartedAt = new Map<number, number>();
  private readonly future = new Map<number, Envelope[]>();
  private readonly timers = new Map<string, TimerHandle>();
  private rebroadcastHandle: TimerHandle | null = null;
  /** per peer-group growing sets used when equivocating */
  private readonly equivocation = new Map<string, { votes: Set<Value>; accepted: Set<Value> }>();
  private randomNonce = 0;
  /** true once restart() ran */
  private restarted = false;

  constructor(
    readonly net: ScpTestNetwork,
    readonly index: number,
    spec: NodeSpec,
  ) {
    this.keypair = nodeKeypair(`sim-${spec.name}`);
    this.id = this.keypair.publicKey();
    this.crashed = spec.crashed ?? false;
    this.byzantine = spec.byzantine ?? null;
    this.watcher = spec.watcher ?? false;
  }

  init(qset: QuorumSet): void {
    this.scp = new SCP(this, this.id, !this.watcher, qset);
    this.net.registerQSet(this.scp.getLocalQuorumSet(), this.scp.getLocalQuorumSetHash());
  }

  isHonest(): boolean {
    return this.byzantine === null;
  }

  isLive(): boolean {
    return !this.crashed;
  }

  // ---- herder stand-in

  /** Nominate our value for LCL+1. */
  trigger(): void {
    if (this.crashed) return;
    const slot = this.lcl + 1;
    if (slot > this.targetSlot) return;
    this.slotStartedAt.set(slot, this.net.clock.now());
    const prev = this.lcl === 0 ? GENESIS_VALUE : this.externalized.get(this.lcl)!;
    this.guard('nominate', () => this.scp.nominate(slot, makeSimValue(slot, this.index, this.net.nonce(this.index)), prev));
  }

  /** Run an SCP call like the herder does: an exception is logged (here: counted), never fatal. */
  guard(what: string, f: () => void): void {
    try {
      f();
    } catch (err) {
      this.net.onException(this, what, err);
    }
  }

  receive(env: Envelope): void {
    if (this.crashed) return;
    if (this.net.options.signing && !this.net.checkSignature(env)) {
      this.net.stats.rejectedSignature++;
      return;
    }
    const slot = env.statement.slotIndex;
    // a restarted SCP instance knows no closed slot (the herder compares those with its ledger)
    if (this.restarted && slot <= this.lcl) return;
    if (slot > this.lcl + 1) {
      // future slot: wait until we get there (bounded)
      let l = this.future.get(slot);
      if (!l) {
        l = [];
        this.future.set(slot, l);
      }
      if (l.length < 1000) l.push(env);
      return;
    }
    this.guard('receive', () => this.scp.receiveEnvelope(env));
  }

  private onLclChanged(): void {
    const slot = this.lcl + 1;
    const buffered = this.future.get(slot) ?? [];
    this.future.delete(slot);
    for (const env of buffered) {
      if (this.crashed) return;
      this.guard('receive', () => this.scp.receiveEnvelope(env));
    }
    // forget old slots (herder: LCL - MAX_SLOTS_TO_REMEMBER)
    if (this.lcl > 12) this.scp.purgeSlots(this.lcl - 12);
    const [lo, hi] = this.net.options.triggerDelayMs ?? [50, 250];
    this.net.clock.setTimeout(() => this.trigger(), lo + this.net.rng() * (hi - lo));
  }

  startRebroadcast(periodMs: number): void {
    const tick = () => {
      if (this.crashed) return;
      for (const slot of [this.lcl, this.lcl + 1]) {
        for (const env of this.scp.getLatestMessagesSend(slot)) this.net.broadcast(this, env, true);
      }
      this.rebroadcastHandle = this.net.clock.setTimeout(tick, periodMs);
    };
    this.rebroadcastHandle = this.net.clock.setTimeout(tick, periodMs * (0.5 + this.net.rng()));
  }

  crash(): void {
    this.crashed = true;
    for (const h of this.timers.values()) this.net.clock.clearTimeout(h);
    this.timers.clear();
    if (this.rebroadcastHandle !== null) this.net.clock.clearTimeout(this.rebroadcastHandle);
  }

  /**
   * Restart like a reloaded tab: a new SCP instance gets our latest
   * envelopes of the open slot back (herder restoreScpState, EXTERNALIZE
   * skipped), then the peers' current state of that slot (scpState answer),
   * then a new trigger. Envelopes for closed slots are ignored from now on.
   */
  restart(): void {
    if (this.crashed) return;
    const slot = this.lcl + 1;
    const saved = this.scp.getLatestMessagesSend(slot).map((e) => structuredClone(e));
    const qset = this.scp.getLocalQuorumSet();
    this.crash();
    this.crashed = false;
    this.restarted = true;
    this.scp = new SCP(this, this.id, !this.watcher, qset);
    this.guard('restore', () => {
      for (const e of saved) if (e.statement.pledges.type !== 'externalize') this.scp.setStateFromEnvelope(slot, e);
    });
    for (const peer of this.net.nodes) {
      if (peer === this || peer.crashed) continue;
      for (const e of peer.scp.getCurrentState(slot)) this.net.send(peer, this, e);
    }
    if (this.net.options.rebroadcastMs) this.startRebroadcast(this.net.options.rebroadcastMs);
    this.net.clock.setTimeout(() => this.trigger(), 200 + this.net.rng() * 800);
  }

  // ---- SCPDriver

  signEnvelope(env: Envelope): void {
    if (this.net.options.signing) signEnvelope(env, this.keypair, SIM_NETWORK_ID);
  }

  getQSet(hash: Hash): QuorumSet | null {
    return this.net.qsets.get(hash) ?? null;
  }

  emitEnvelope(env: Envelope): void {
    if (this.crashed) return;
    this.net.stats.emitted++;
    const p = env.statement.pledges;
    this.emittedLog.push({
      at: this.net.clock.now(),
      slot: env.statement.slotIndex,
      type: p.type,
      qsetHash: p.type === 'externalize' ? p.commitQuorumSetHash : p.quorumSetHash,
    });
    if (this.byzantine) this.emitByzantine(env);
    else this.net.broadcast(this, env);
  }

  validateValue(slotIndex: number, value: Value, _nomination: boolean): ValidationLevel {
    const info = parseSimValue(value);
    if (info === null) return ValidationLevel.Invalid;
    // like HerderSCPDriver: values for other slots cannot be fully checked
    if (slotIndex !== this.lcl + 1) return ValidationLevel.MaybeValid;
    return info.slot === slotIndex ? ValidationLevel.FullyValidated : ValidationLevel.Invalid;
  }

  extractValidValue(_slotIndex: number, _value: Value): Value | null {
    return null;
  }

  combineCandidates(_slotIndex: number, candidates: Value[]): Value | null {
    // deterministic: the highest candidate
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  computeHashNode(slotIndex: number, prev: Value, isPriority: boolean, roundNumber: number, nodeId: NodeId): bigint {
    return computeHashNode(slotIndex, prev, isPriority, roundNumber, nodeId);
  }

  computeValueHash(slotIndex: number, prev: Value, roundNumber: number, value: Value): bigint {
    return computeValueHash(slotIndex, prev, roundNumber, value);
  }

  computeTimeout(roundNumber: number, _isNomination: boolean): number {
    // HerderSCPDriver in ARCHITECTURE 10.1: 1 s per round, capped at 30 s
    return Math.min(1000 * roundNumber, 30_000);
  }

  setupTimer(slotIndex: number, timerId: number, timeoutMs: number, cb: (() => void) | null): void {
    const key = `${slotIndex}:${timerId}`;
    const old = this.timers.get(key);
    if (old !== undefined) this.net.clock.clearTimeout(old);
    this.timers.delete(key);
    if (cb === null || this.crashed) return;
    const h = this.net.clock.setTimeout(() => {
      this.timers.delete(key);
      if (!this.crashed) this.guard(`timer ${timerId}`, cb);
    }, timeoutMs);
    this.timers.set(key, h);
  }

  stopTimer(slotIndex: number, timerId: number): void {
    const key = `${slotIndex}:${timerId}`;
    const old = this.timers.get(key);
    if (old !== undefined) this.net.clock.clearTimeout(old);
    this.timers.delete(key);
  }

  valueExternalized(slotIndex: number, value: Value): void {
    if (this.externalized.has(slotIndex)) throw new Error(`${this.index}: slot ${slotIndex} externalized twice`);
    this.externalized.set(slotIndex, value);
    this.externalizedAt.set(slotIndex, this.net.clock.now());
    this.net.onExternalized(this, slotIndex, value);
    if (slotIndex === this.lcl + 1) {
      this.lcl = slotIndex;
      // leave the SCP call stack before touching SCP again
      this.net.clock.setTimeout(() => {
        if (!this.crashed) this.onLclChanged();
      }, 0);
    }
  }

  // ---- Byzantine behavior

  private groupOf(peer: SimNode): 'A' | 'B' {
    return peer.index % 2 === 0 ? 'A' : 'B';
  }

  private emitByzantine(env: Envelope): void {
    const st = env.statement;
    const slot = st.slotIndex;
    if (this.byzantine === 'random') {
      this.net.broadcast(this, env);
      this.emitRandom(slot);
      return;
    }
    for (const peer of this.net.nodes) {
      if (peer === this) continue;
      const group = this.groupOf(peer);
      let out: Envelope = env;
      if (st.pledges.type === 'nominate') {
        this.net.stats.equivocations++;
        // each group sees an ever growing set that includes a value only it gets
        const key = `${slot}:${group}`;
        let s = this.equivocation.get(key);
        if (!s) {
          s = { votes: new Set(), accepted: new Set() };
          this.equivocation.set(key, s);
        }
        const own = makeSimValue(slot, this.index, group === 'A' ? 7001 : 7002);
        const p = st.pledges as NominatePledge;
        for (const v of p.votes) s.votes.add(v);
        for (const v of p.accepted) s.accepted.add(v);
        s.votes.add(own);
        s.accepted.add(own); // claims to have accepted it, too
        out = this.resign({
          statement: {
            ...st,
            pledges: { ...p, votes: [...s.votes].sort(), accepted: [...s.accepted].sort() },
          },
          signature: '',
        });
      } else if (this.byzantine === 'equivocate-all' && st.pledges.type === 'prepare' && group === 'B') {
        this.net.stats.equivocations++;
        // group B sees a PREPARE for a different value at the same counter
        const alt = makeSimValue(slot, this.index, 7003);
        out = this.resign({
          statement: { ...st, pledges: { ...st.pledges, ballot: { counter: st.pledges.ballot.counter, value: alt } } },
          signature: '',
        });
      }
      this.net.send(this, peer, out);
    }
    if (this.byzantine === 'equivocate-all' && this.net.options.signing) {
      // forged envelope in the name of an honest node: must be dropped
      // (only with signatures; without them it would be a second Byzantine node)
      const victim = this.net.nodes.find((n) => n !== this && n.isHonest());
      if (victim) {
        const forged: Envelope = {
          statement: {
            nodeId: victim.id,
            slotIndex: slot,
            pledges: {
              type: 'externalize',
              commit: { counter: 1, value: makeSimValue(slot, this.index, 7004) },
              nH: 1,
              commitQuorumSetHash: victim.scp.getLocalQuorumSetHash(),
            },
          },
          signature: '',
        };
        signEnvelope(forged, this.keypair, SIM_NETWORK_ID); // wrong key
        this.net.stats.forgeries++;
        for (const peer of this.net.nodes) if (peer !== this && peer !== victim) this.net.send(this, peer, forged);
      }
    }
  }

  private resign(env: Envelope): Envelope {
    if (this.net.options.signing) signEnvelope(env, this.keypair, SIM_NETWORK_ID);
    return env;
  }

  /** Random well-formed (mostly sane) statements built from values this node has seen. */
  private emitRandom(slot: number): void {
    const rng = this.net.rng;
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
    const info = this.scp.getSlotInfo(slot);
    const values = new Set<Value>([makeSimValue(slot, this.index, 9_000 + (this.randomNonce++ % 3))]);
    if (info) {
      for (const v of [...info.nomination.votes, ...info.nomination.accepted]) values.add(v);
      for (const b of [info.ballot.current, info.ballot.prepared, info.ballot.preparedPrime, info.ballot.high]) {
        if (b) values.add(b.value);
      }
      for (const s of info.latestStatements) {
        const n = s.nomination?.pledges;
        if (n?.type === 'nominate') for (const v of n.votes) values.add(v);
        const b = s.ballot?.pledges;
        if (b?.type === 'prepare') values.add(b.ballot.value);
        else if (b?.type === 'confirm') values.add(b.ballot.value);
        else if (b?.type === 'externalize') values.add(b.commit.value);
      }
    }
    const vals = [...values].filter((v) => parseSimValue(v)?.slot === slot);
    const cur = info?.ballot.current?.counter ?? 1;
    const counters = [0, 1, 1, 2, cur, cur, cur + 1, cur + 2, UINT32_MAX - 1, UINT32_MAX].map((c) => Math.min(c, UINT32_MAX));
    const counter = (min: number) => Math.max(min, pick(counters));
    const ballot = (min: number): Ballot => ({ counter: counter(min), value: pick(vals) });
    const qSetHash = this.scp.getLocalQuorumSetHash();
    const make = (): Pledges => {
      const t = rng();
      if (t < 0.4) {
        const b = ballot(1);
        let p: Ballot | null = rng() < 0.6 ? ballot(0) : null;
        let pp: Ballot | null = rng() < 0.3 ? ballot(0) : null;
        if (p && pp && !(pp.value !== p.value && (pp.counter < p.counter || (pp.counter === p.counter && pp.value < p.value)))) {
          pp = null;
        }
        if (!p && rng() < 0.5) {
          p = pp; // p' alone is sane too, but try p alone as well
          pp = null;
        }
        const nH = p && rng() < 0.6 ? Math.floor(rng() * (p.counter + 1)) : 0;
        const nC = nH !== 0 && b.counter >= nH && rng() < 0.5 ? 1 + Math.floor(rng() * nH) : 0;
        return { type: 'prepare', quorumSetHash: qSetHash, ballot: b, prepared: p, preparedPrime: pp, nC, nH };
      }
      if (t < 0.65) {
        const b = ballot(1);
        const nH = Math.floor(rng() * (b.counter + 1));
        const nCommit = Math.floor(rng() * (nH + 1));
        return { type: 'confirm', ballot: b, nPrepared: counter(0), nCommit, nH, quorumSetHash: qSetHash };
      }
      if (t < 0.75) {
        const c = ballot(1);
        return { type: 'externalize', commit: c, nH: Math.max(c.counter, counter(0)), commitQuorumSetHash: qSetHash };
      }
      const votes = vals.filter(() => rng() < 0.5).sort();
      const accepted = vals.filter(() => rng() < 0.3).sort();
      if (votes.length + accepted.length === 0) votes.push(pick(vals));
      return { type: 'nominate', quorumSetHash: qSetHash, votes, accepted };
    };
    for (const peer of this.net.nodes) {
      if (peer === this || rng() < 0.5) continue;
      const n = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        this.net.stats.randomStatements++;
        this.net.send(this, peer, this.resign({ statement: { nodeId: this.id, slotIndex: slot, pledges: make() }, signature: '' }));
      }
    }
  }
}

export class ScpTestNetwork {
  readonly clock = new VirtualClock(1_800_000_000_000);
  readonly rng: Rng;
  readonly nodes: SimNode[] = [];
  readonly qsets = new Map<Hash, QuorumSet>();
  readonly stats: SimStats = {
    delivered: 0,
    dropped: 0,
    rejectedSignature: 0,
    emitted: 0,
    equivocations: 0,
    forgeries: 0,
    randomStatements: 0,
    exceptions: 0,
    byzantineExceptions: 0,
  };
  /** first externalized value per slot (any node), for the safety check */
  readonly decided = new Map<number, Value>();
  readonly violations: string[] = [];
  private readonly sigCache = new Map<string, boolean>();
  private readonly nonces = new Map<number, number>();

  constructor(readonly options: NetworkOptions) {
    this.rng = seededRng(options.seed);
  }

  /** Create nodes, then give each its quorum set (qsetFor sees all node ids). */
  addNodes(specs: NodeSpec[], qsetFor: (ids: NodeId[], index: number) => QuorumSet): SimNode[] {
    const created = specs.map((s, i) => new SimNode(this, this.nodes.length + i, s));
    this.nodes.push(...created);
    const ids = this.nodes.map((n) => n.id);
    for (const n of created) n.init(qsetFor(ids, n.index));
    return created;
  }

  registerQSet(q: QuorumSet, hash: Hash): void {
    this.qsets.set(hash, q);
  }

  /** Change a node's quorum set (herder: scp.updateLocalQuorumSet). */
  updateQSet(node: SimNode, q: QuorumSet): void {
    node.scp.updateLocalQuorumSet(q);
    this.registerQSet(node.scp.getLocalQuorumSet(), node.scp.getLocalQuorumSetHash());
  }

  nonce(index: number): number {
    const n = (this.nonces.get(index) ?? 0) + 1;
    this.nonces.set(index, n);
    return n;
  }

  honestLive(): SimNode[] {
    return this.nodes.filter((n) => n.isHonest() && n.isLive());
  }

  checkSignature(env: Envelope): boolean {
    const key = `${env.signature}|${JSON.stringify(env.statement)}`;
    let ok = this.sigCache.get(key);
    if (ok === undefined) {
      ok = verifyEnvelope(env, SIM_NETWORK_ID);
      this.sigCache.set(key, ok);
    }
    return ok;
  }

  broadcast(from: SimNode, env: Envelope, _rebroadcast = false): void {
    for (const peer of this.nodes) if (peer !== from) this.send(from, peer, env);
  }

  send(from: SimNode, to: SimNode, env: Envelope): void {
    const o = this.options;
    if (o.dropRate && this.rng() < o.dropRate) {
      this.stats.dropped++;
      return;
    }
    const lo = o.minDelayMs ?? 5;
    const hi = o.maxDelayMs ?? 150;
    let delay = lo + this.rng() * (hi - lo);
    if (this.rng() < (o.slowRate ?? 0.05)) delay += this.rng() * (o.slowExtraMs ?? 1000);
    const copy = structuredClone(env);
    // messages already in flight still arrive if the sender crashes later
    this.clock.setTimeout(() => {
      this.stats.delivered++;
      to.receive(copy);
    }, delay);
  }

  /** An SCP call threw. At an honest node this is a bug (checkSafety reports it). */
  onException(node: SimNode, what: string, err: unknown): void {
    if (!node.isHonest()) {
      this.stats.byzantineExceptions++;
      return;
    }
    this.stats.exceptions++;
    if (this.violations.length < 20) {
      this.violations.push(`node ${node.index} ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onExternalized(node: SimNode, slot: number, value: Value): void {
    if (!node.isHonest()) return;
    const prev = this.decided.get(slot);
    if (prev === undefined) this.decided.set(slot, value);
    else if (prev !== value) this.violations.push(`slot ${slot}: node ${node.index} externalized a different value`);
  }

  /** Start all live nodes on slot 1 and run until every honest live node externalized `slots` slots. */
  async run(slots: number, maxMs: number): Promise<boolean> {
    for (const n of this.nodes) n.targetSlot = slots;
    for (const n of this.nodes) {
      if (!n.isLive()) continue;
      if (this.options.rebroadcastMs) n.startRebroadcast(this.options.rebroadcastMs);
      this.clock.setTimeout(() => n.trigger(), this.rng() * 100);
    }
    return this.runUntil(() => this.honestLive().every((n) => n.lcl >= slots), maxMs);
  }

  runUntil(pred: () => boolean, maxMs: number): Promise<boolean> {
    return this.clock.runUntil(pred, maxMs, 250);
  }

  /** Safety over all honest nodes (crashed ones included): one value per slot. */
  checkSafety(): void {
    for (const n of this.nodes) {
      if (!n.isHonest()) continue;
      for (const [slot, v] of n.externalized) {
        const d = this.decided.get(slot);
        if (d !== v) this.violations.push(`slot ${slot}: node ${n.index} disagrees`);
      }
    }
    if (this.violations.length > 0) throw new Error(`safety violated: ${this.violations.join('; ')}`);
  }

  /** Longest time (ms) any honest live node took from starting a slot to externalizing it. */
  maxSlotLatency(): number {
    let max = 0;
    for (const n of this.honestLive()) {
      for (const [slot, at] of n.externalizedAt) {
        const start = n.slotStartedAt.get(slot);
        if (start !== undefined) max = Math.max(max, at - start);
      }
    }
    return max;
  }
}

/** Flat quorum set: threshold t over all ids. */
export function flatQSet(ids: NodeId[], threshold: number): QuorumSet {
  return { threshold, validators: [...ids], innerSets: [] };
}

/** Byzantine fault threshold for n nodes: t = n - f with f = floor((n - 1) / 3). */
export function bftThreshold(n: number): number {
  return n - Math.floor((n - 1) / 3);
}
