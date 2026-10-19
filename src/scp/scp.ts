// Ported from stellar-core (Apache-2.0): src/scp/SCP.cpp
//
// Main entry point of the SCP library. The host (herder) implements
// SCPDriver, feeds received envelopes with receiveEnvelope and starts slots
// with nominate. SCP never touches the network, storage or clock directly.

import { StrKey } from '@stellar/stellar-sdk/base';
import type { SCPDriver } from './driver';
import { LocalNode } from './localNode';
import { getCompanionQuorumSetHashFromStatement } from './ballot';
import { UINT32_MAX } from './quorum';
import { Slot } from './slot';
import { EnvelopeState, TIMER_BALLOT, TIMER_NOMINATION } from './types';
import type { Ballot, Envelope, Hash, NodeId, QuorumSet, SlotInfo, Statement, Value } from './types';

const HEX_RE = /^(?:[0-9a-f]{2})*$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function isU32(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= UINT32_MAX;
}

function isValueHex(v: unknown): boolean {
  return typeof v === 'string' && HEX_RE.test(v);
}

function isHashHex(v: unknown): boolean {
  return typeof v === 'string' && HASH_RE.test(v);
}

function isBallotShape(b: unknown): boolean {
  if (b === null || typeof b !== 'object') return false;
  const x = b as Ballot;
  return isU32(x.counter) && isValueHex(x.value);
}

function isOptBallotShape(b: unknown): boolean {
  return b === null || isBallotShape(b);
}

const validNodeIds = new Set<string>();

// a valid G... StrKey (checksum included); results are cached
function isNodeIdShape(id: string): boolean {
  if (validNodeIds.has(id)) return true;
  if (!StrKey.isValidEd25519PublicKey(id)) return false;
  if (validNodeIds.size >= 4096) validNodeIds.clear();
  validNodeIds.add(id);
  return true;
}

/**
 * Structural check of an envelope built outside SCP: a G... node id, field
 * types, uint32 counters and lowercase hex values/hashes. (stellar-core gets
 * this from XDR.) Signatures are not checked here; the herder does that.
 */
export function isWellFormedEnvelope(env: Envelope): boolean {
  if (env === null || typeof env !== 'object') return false;
  const st = env.statement;
  if (st === null || typeof st !== 'object') return false;
  if (typeof st.nodeId !== 'string' || !isNodeIdShape(st.nodeId)) return false;
  if (!Number.isSafeInteger(st.slotIndex) || st.slotIndex < 0) return false;
  const p = st.pledges;
  if (p === null || typeof p !== 'object') return false;
  switch (p.type) {
    case 'nominate':
      return (
        isHashHex(p.quorumSetHash) &&
        Array.isArray(p.votes) &&
        Array.isArray(p.accepted) &&
        p.votes.every(isValueHex) &&
        p.accepted.every(isValueHex)
      );
    case 'prepare':
      return (
        isHashHex(p.quorumSetHash) &&
        isBallotShape(p.ballot) &&
        isOptBallotShape(p.prepared) &&
        isOptBallotShape(p.preparedPrime) &&
        isU32(p.nC) &&
        isU32(p.nH)
      );
    case 'confirm':
      return (
        isHashHex(p.quorumSetHash) &&
        isBallotShape(p.ballot) &&
        isU32(p.nPrepared) &&
        isU32(p.nCommit) &&
        isU32(p.nH)
      );
    case 'externalize':
      return isHashHex(p.commitQuorumSetHash) && isBallotShape(p.commit) && isU32(p.nH);
    default:
      return false;
  }
}

/** Short readable form of a ballot, e.g. "(2,1a2b3c4d)". */
export function ballotToStr(b: Ballot | null, valueString: (v: Value) => string = (v) => v.slice(0, 8)): string {
  return b ? `(${b.counter},${valueString(b.value)})` : '(<null_ballot>)';
}

/** One-line description of a statement (SCP::envToStr). */
export function statementToStr(
  st: Statement,
  valueString: (v: Value) => string = (v) => v.slice(0, 8),
  nodeString: (n: NodeId) => string = (n) => `${n.slice(0, 5)}…${n.slice(-4)}`,
): string {
  const qSetHash = getCompanionQuorumSetHashFromStatement(st).slice(0, 6);
  const bs = (b: Ballot | null) => ballotToStr(b, valueString);
  let out = `{ENV@${nodeString(st.nodeId)} |  i: ${st.slotIndex}`;
  const p = st.pledges;
  switch (p.type) {
    case 'prepare':
      out += ` | PREPARE | D: ${qSetHash} | b: ${bs(p.ballot)} | p: ${bs(p.prepared)} | p': ${bs(p.preparedPrime)}`;
      out += ` | c.n: ${p.nC} | h.n: ${p.nH}`;
      break;
    case 'confirm':
      out += ` | CONFIRM | D: ${qSetHash} | b: ${bs(p.ballot)} | p.n: ${p.nPrepared} | c.n: ${p.nCommit} | h.n: ${p.nH}`;
      break;
    case 'externalize':
      out += ` | EXTERNALIZE | c: ${bs(p.commit)} | h.n: ${p.nH} | (lastD): ${qSetHash}`;
      break;
    case 'nominate':
      out += ` | NOMINATE | D: ${qSetHash} | X: {${p.votes.map((v) => `'${valueString(v)}'`).join(' ,')}}`;
      out += ` | Y: {${p.accepted.map((v) => `'${valueString(v)}'`).join(' ,')}}`;
      break;
  }
  return `${out} }`;
}

export class SCP {
  private readonly localNode: LocalNode;
  private readonly knownSlots = new Map<number, Slot>();

  /**
   * qset is checked (throws if not sane) and normalized, as stellar-core's
   * LocalNode does. getLocalQuorumSet() returns the normalized set.
   */
  constructor(
    private readonly driver: SCPDriver,
    nodeId: NodeId,
    isValidator: boolean,
    qset: QuorumSet,
  ) {
    this.localNode = new LocalNode(nodeId, isValidator, qset);
  }

  getDriver(): SCPDriver {
    return this.driver;
  }

  getLocalNode(): LocalNode {
    return this.localNode;
  }

  /**
   * Main entry point: processes the envelope, updates the state and calls
   * the driver as needed. The envelope must not be modified afterwards.
   */
  receiveEnvelope(env: Envelope): EnvelopeState {
    if (!isWellFormedEnvelope(env)) return EnvelopeState.INVALID;
    return this.getSlot(env.statement.slotIndex, true)!.processEnvelope(env, false);
  }

  /** Submit a value for slotIndex. previousValue is the value of slotIndex - 1. */
  nominate(slotIndex: number, value: Value, previousValue: Value): boolean {
    // stellar-core asserts isValidator(); watchers never nominate.
    if (!this.isValidator()) return false;
    return this.getSlot(slotIndex, true)!.nominate(value, previousValue, false);
  }

  /** Stops nomination for a slot. */
  stopNomination(slotIndex: number): void {
    this.getSlot(slotIndex, false)?.stopNomination();
  }

  /**
   * Replace the local quorum set (checked and normalized; throws if not
   * sane). Peers learn its hash with the next statement this node emits.
   *
   * Unlike stellar-core (static quorum sets), open slots are re-evaluated
   * right away against the statements we already hold, as if they had just
   * arrived; this may emit envelopes. To also announce the new set on a
   * stalled slot, follow with abandonBallot(slot) or, if that returns false,
   * refreshNomination(slot, freshValue). Both do nothing before the slot's
   * nomination starts (for example after setStateFromEnvelope): then the
   * first nominate() announces the set, voting our own value if needed.
   */
  updateLocalQuorumSet(qset: QuorumSet): void {
    const oldHash = this.localNode.getQuorumSetHash();
    this.localNode.updateQuorumSet(qset);
    if (this.localNode.getQuorumSetHash() === oldHash) return;
    for (const index of this.getKnownSlots()) {
      const slot = this.knownSlots.get(index);
      if (slot && slot.ballotProtocol.getPhase() !== 'EXTERNALIZE') slot.reevaluate();
    }
  }

  /** A copy of the normalized local quorum set. */
  getLocalQuorumSet(): QuorumSet {
    return this.localNode.getQuorumSetCopy();
  }

  getLocalQuorumSetHash(): Hash {
    return this.localNode.getQuorumSetHash();
  }

  getLocalNodeId(): NodeId {
    return this.localNode.getNodeId();
  }

  isValidator(): boolean {
    return this.localNode.isValidator();
  }

  /**
   * Watcher mode (false): keep processing envelopes but never emit. Slots
   * that exist stop emitting; new slots start in the new mode. Turning it
   * back on affects new slots only.
   */
  setValidator(on: boolean): void {
    this.localNode.setValidator(on);
    if (!on) {
      for (const slot of this.knownSlots.values()) slot.setFullyValidated(false);
    }
  }

  /** Forget all slots < maxSlotIndex (except slotToKeep) and stop their timers. */
  purgeSlots(maxSlotIndex: number, slotToKeep?: number): void {
    this.purgeSlotsOutsideRange(maxSlotIndex, null, slotToKeep ?? null);
  }

  /** Forget slots outside [minSlotIndex, maxSlotIndex] (null = unbounded), except slotToKeep. */
  purgeSlotsOutsideRange(minSlotIndex: number | null, maxSlotIndex: number | null, slotToKeep: number | null): void {
    for (const index of [...this.knownSlots.keys()]) {
      if (index === slotToKeep) continue;
      const below = minSlotIndex !== null && index < minSlotIndex;
      const above = maxSlotIndex !== null && index > maxSlotIndex;
      if (below || above) {
        this.knownSlots.delete(index);
        this.driver.stopTimer(index, TIMER_NOMINATION);
        this.driver.stopTimer(index, TIMER_BALLOT);
      }
    }
  }

  /** The latest envelopes this node emitted for the slot (empty when not fully validated). */
  getLatestMessagesSend(slotIndex: number): Envelope[] {
    return this.getSlot(slotIndex, false)?.getLatestMessagesSend() ?? [];
  }

  /**
   * Latest envelopes of every node for the slot: nominations, then ballot
   * statements, in node id order. Our own only when the slot is fully validated.
   */
  getCurrentState(slotIndex: number): Envelope[] {
    return this.collectState(slotIndex, false);
  }

  /** Like getCurrentState, but always includes our own envelopes. */
  getEntireCurrentState(slotIndex: number): Envelope[] {
    return this.collectState(slotIndex, true);
  }

  private collectState(slotIndex: number, forceSelf: boolean): Envelope[] {
    const res: Envelope[] = [];
    this.processCurrentState(
      slotIndex,
      (e) => {
        res.push(e);
        return true;
      },
      forceSelf,
    );
    return res;
  }

  /** Calls f for all latest messages of the slot; f returns false to stop. */
  processCurrentState(slotIndex: number, f: (env: Envelope) => boolean, forceSelf: boolean): void {
    this.getSlot(slotIndex, false)?.processCurrentState(f, forceSelf);
  }

  /** Envelopes that contributed to externalizing the slot (empty if not externalized). */
  getExternalizingState(slotIndex: number): Envelope[] {
    return this.getSlot(slotIndex, false)?.getExternalizingState() ?? [];
  }

  getSlotInfo(slotIndex: number): SlotInfo | null {
    return this.getSlot(slotIndex, false)?.getInfo() ?? null;
  }

  /** Known slot indexes, ascending. */
  getKnownSlots(): number[] {
    return [...this.knownSlots.keys()].sort((a, b) => a - b);
  }

  getHighestKnownSlotIndex(): number {
    let max = 0;
    for (const k of this.knownSlots.keys()) if (k > max) max = k;
    return max;
  }

  isSlotFullyValidated(slotIndex: number): boolean {
    return this.getSlot(slotIndex, false)?.isFullyValidated() ?? false;
  }

  /** True if we received messages from a v-blocking set for the slot. */
  gotVBlocking(slotIndex: number): boolean {
    return this.getSlot(slotIndex, false)?.gotVBlocking() ?? false;
  }

  // ---- extras (stellar-core SCP methods outside ARCHITECTURE section 6)

  /** The externalized value of the slot, or null. */
  getExternalizedValue(slotIndex: number): Value | null {
    return this.getSlot(slotIndex, false)?.ballotProtocol.getExternalizedValue() ?? null;
  }

  /** The current nomination round leaders of the slot. */
  getNominationLeaders(slotIndex: number): NodeId[] {
    return this.getSlot(slotIndex, false)?.getNominationLeaders() ?? [];
  }

  /** The latest message from a node, newest slot first, or null. */
  getLatestMessage(nodeId: NodeId): Envelope | null {
    for (const index of this.getKnownSlots().reverse()) {
      const res = this.knownSlots.get(index)!.getLatestMessage(nodeId);
      if (res !== null) return res;
    }
    return null;
  }

  /** True if newSt (same node and slot) replaces oldSt. */
  isNewerNominationOrBallotSt(oldSt: Statement, newSt: Statement): boolean {
    if (oldSt.slotIndex !== newSt.slotIndex || oldSt.nodeId !== newSt.nodeId) return false;
    return this.getSlot(oldSt.slotIndex, false)?.isNewerNominationOrBallotSt(oldSt, newSt) ?? false;
  }

  /** Restore our own state from an envelope we emitted before (after a restart). */
  setStateFromEnvelope(slotIndex: number, env: Envelope): boolean {
    return this.getSlot(slotIndex, true)!.setStateFromEnvelope(env);
  }

  /**
   * Abandon the current ballot of the slot and move to counter + 1 (what the
   * ballot timer does). Emits a newer statement, so peers also learn about a
   * changed local quorum set. No-op before the ballot protocol starts.
   */
  abandonBallot(slotIndex: number): boolean {
    return this.getSlot(slotIndex, false)?.abandonBallot() ?? false;
  }

  /**
   * BrowserChain extension (not in stellar-core). While the slot is still
   * nominating (no candidate yet), vote for `value` (a fresh value of ours,
   * e.g. the same tx set with a later close time) even if we are not a round
   * leader, and emit the newer nomination. Peers take a node's new quorum set
   * only from a strictly newer statement, so after updateLocalQuorumSet on a
   * stuck slot call abandonBallot(slot) and, if that returns false,
   * refreshNomination(slot, freshValue). Nomination votes do not affect safety.
   */
  refreshNomination(slotIndex: number, value: Value): boolean {
    return this.getSlot(slotIndex, false)?.nominationProtocol.addVote(value) ?? false;
  }

  /** Number of statements recorded over all known slots. */
  getCumulativeStatementCount(): number {
    let c = 0;
    for (const s of this.knownSlots.values()) c += s.getStatementCount();
    return c;
  }

  empty(): boolean {
    return this.knownSlots.size === 0;
  }

  /** Low-level slot access (tests and tools). */
  getSlot(slotIndex: number, create: boolean): Slot | null {
    let res = this.knownSlots.get(slotIndex);
    if (res === undefined) {
      if (!create) return null;
      res = new Slot(slotIndex, this);
      this.knownSlots.set(slotIndex, res);
    }
    return res;
  }

  // ---- helpers to stringify for logging

  getValueString(v: Value): string {
    return this.driver.getValueString ? this.driver.getValueString(v) : v.slice(0, 8);
  }

  ballotToStr(b: Ballot | null): string {
    return ballotToStr(b, (v) => this.getValueString(v));
  }

  envToStr(e: Envelope | Statement): string {
    const st = 'statement' in e ? e.statement : e;
    const nodeString = this.driver.toShortString ? (n: NodeId) => this.driver.toShortString!(n) : undefined;
    return statementToStr(st, (v) => this.getValueString(v), nodeString);
  }
}
