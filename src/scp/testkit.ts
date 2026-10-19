// Ported from stellar-core (Apache-2.0): src/scp/test/SCPTests.cpp (TestSCP
// driver, makePrepare & co). Test helpers for the SCP module (used by
// *.test.ts only).

import { Keypair } from '@stellar/stellar-sdk/base';
import { expect } from 'vitest';
import { sha256, sha256Hex } from '../lib/hash';
import type { SCPDriver } from './driver';
import { cloneQSet } from './quorum';
import { SCP } from './scp';
import { TIMER_BALLOT, ValidationLevel } from './types';
import type { Ballot, Envelope, EnvelopeState, Hash, NodeId, Pledges, QuorumSet, Value } from './types';
import { hashQuorumSet } from './xdr';

// ---------------------------------------------------------------------------
// Catch2-style sections

export type SectionFn = (name: string, body: () => void) => void;
export type SectionBody = (section: SectionFn) => void;

const SEP = '\u0000';

/**
 * Discover the leaf section paths of a Catch2-style test body. Like Catch2,
 * each run executes the body from the top and enters exactly one unfinished
 * section per level. A run that throws marks its leaf as done and goes on.
 */
export function discoverSectionPaths(body: SectionBody, maxRuns = 5000): string[][] {
  const completed = new Set<string>();
  const leaves: string[][] = [];

  for (let run = 0; run < maxRuns; run++) {
    const stack: string[] = [];
    const sawChild: boolean[] = []; // per stack entry: a child section call was seen
    const entered: boolean[] = []; // per depth: a section was entered in this run
    let pending = false; // an unfinished section was skipped
    let aborted = false;
    let progress = false; // a section was newly completed in this run
    let innermostAtThrow: string | null = null;
    let leaf: string[] | null = null;
    let anySection = false;

    const section: SectionFn = (name, fn) => {
      anySection = true;
      const depth = stack.length;
      if (depth > 0) sawChild[depth - 1] = true;
      const path = [...stack, name];
      const key = path.join(SEP);
      if (completed.has(key)) return;
      if (entered[depth]) {
        pending = true;
        return;
      }
      entered[depth] = true;
      entered.length = depth + 1;

      stack.push(name);
      sawChild.push(false);
      const outerPending = pending;
      pending = false;
      try {
        fn();
      } catch (err) {
        if (!aborted) {
          aborted = true;
          innermostAtThrow = key;
          if (!sawChild[sawChild.length - 1]) {
            // a leaf failed: count it as done
            completed.add(key);
            progress = true;
            leaf = path;
          }
        }
        throw err;
      } finally {
        const saw = sawChild.pop();
        stack.pop();
        if (!aborted) {
          if (!pending) {
            completed.add(key);
            progress = true;
          }
          if (!saw) leaf = path;
        }
        pending = outerPending || pending;
      }
    };

    let threw = false;
    try {
      body(section);
    } catch {
      threw = true; // reported when the path runs on its own
    }

    if (!anySection) {
      leaves.push([]);
      return leaves;
    }
    if (leaf !== null) leaves.push(leaf);
    if (!threw && !pending) return leaves;
    if (threw && !progress) {
      // force progress so a failure in shared code cannot loop forever
      if (innermostAtThrow === null) return leaves;
      completed.add(innermostAtThrow);
    }
  }
  throw new Error('discoverSectionPaths: too many runs');
}

/** Run the body entering only the sections on `path`. */
export function runSectionPath(body: SectionBody, path: readonly string[]): void {
  const stack: string[] = [];
  let deepest = 0;
  const section: SectionFn = (name, fn) => {
    const depth = stack.length;
    if (depth >= path.length || path[depth] !== name) return;
    stack.push(name);
    deepest = Math.max(deepest, stack.length);
    try {
      fn();
    } finally {
      stack.pop();
    }
  };
  body(section);
  if (deepest !== path.length) throw new Error(`section path not found: ${path.join(' > ')}`);
}

// ---------------------------------------------------------------------------
// Keys and values

const keyCache = new Map<string, Keypair>();

/** Deterministic test key (stellar-core SIMULATION_CREATE_NODE style). */
export function nodeKeypair(name: string | number): Keypair {
  const k = String(name);
  let kp = keyCache.get(k);
  if (!kp) {
    kp = Keypair.fromRawEd25519Seed(sha256(`NODE_SEED_${k}`));
    keyCache.set(k, kp);
  }
  return kp;
}

export function nodeId(name: string | number): NodeId {
  return nodeKeypair(name).publicKey();
}

export interface TestValues {
  /** x < y < z < zz (32-byte values) */
  x: Value;
  y: Value;
  z: Value;
  zz: Value;
  /** independent of the others */
  k: Value;
}

/** setupValues() from SCPTests.cpp, seeded instead of random. */
export function setupValues(seed: number | string = 0): TestValues {
  const d = `SEED_VALUE_DATA_${seed}`;
  const v: Value[] = [];
  for (let i = 0; i < 4; i++) v.push(sha256Hex(`${d}/${i}`));
  v.sort();
  return { x: v[0], y: v[1], z: v[2], zz: v[3], k: sha256Hex(d) };
}

// ---------------------------------------------------------------------------
// Envelope builders (makePrepare & co in SCPTests.cpp, unsigned)

export function makeEnvelope(node: NodeId, slotIndex: number, pledges: Pledges): Envelope {
  return { statement: { nodeId: node, slotIndex, pledges }, signature: '' };
}

const cb = (b: Ballot | null | undefined): Ballot | null => (b ? { counter: b.counter, value: b.value } : null);

export function makePrepare(
  node: NodeId,
  qSetHash: Hash,
  slotIndex: number,
  ballot: Ballot,
  prepared: Ballot | null = null,
  nC = 0,
  nH = 0,
  preparedPrime: Ballot | null = null,
): Envelope {
  return makeEnvelope(node, slotIndex, {
    type: 'prepare',
    quorumSetHash: qSetHash,
    ballot: cb(ballot)!,
    prepared: cb(prepared),
    preparedPrime: cb(preparedPrime),
    nC,
    nH,
  });
}

export function makeConfirm(
  node: NodeId,
  qSetHash: Hash,
  slotIndex: number,
  prepareCounter: number,
  b: Ballot,
  nC: number,
  nH: number,
): Envelope {
  return makeEnvelope(node, slotIndex, {
    type: 'confirm',
    ballot: cb(b)!,
    nPrepared: prepareCounter,
    nCommit: nC,
    nH,
    quorumSetHash: qSetHash,
  });
}

export function makeExternalize(node: NodeId, qSetHash: Hash, slotIndex: number, commit: Ballot, nH: number): Envelope {
  return makeEnvelope(node, slotIndex, { type: 'externalize', commit: cb(commit)!, nH, commitQuorumSetHash: qSetHash });
}

export function makeNominate(
  node: NodeId,
  qSetHash: Hash,
  slotIndex: number,
  votes: readonly Value[],
  accepted: readonly Value[],
): Envelope {
  return makeEnvelope(node, slotIndex, {
    type: 'nominate',
    quorumSetHash: qSetHash,
    votes: [...votes].sort(),
    accepted: [...accepted].sort(),
  });
}

export function verifyPrepare(
  actual: Envelope,
  node: NodeId,
  qSetHash: Hash,
  slotIndex: number,
  ballot: Ballot,
  prepared: Ballot | null = null,
  nC = 0,
  nH = 0,
  preparedPrime: Ballot | null = null,
): void {
  const exp = makePrepare(node, qSetHash, slotIndex, ballot, prepared, nC, nH, preparedPrime);
  expect(actual.statement).toEqual(exp.statement);
}

export function verifyConfirm(
  actual: Envelope,
  node: NodeId,
  qSetHash: Hash,
  slotIndex: number,
  nPrepared: number,
  b: Ballot,
  nC: number,
  nH: number,
): void {
  const exp = makeConfirm(node, qSetHash, slotIndex, nPrepared, b, nC, nH);
  expect(actual.statement).toEqual(exp.statement);
}

export function verifyExternalize(
  actual: Envelope,
  node: NodeId,
  qSetHash: Hash,
  slotIndex: number,
  commit: Ballot,
  nH: number,
): void {
  const exp = makeExternalize(node, qSetHash, slotIndex, commit, nH);
  expect(actual.statement).toEqual(exp.statement);
}

export function verifyNominate(
  actual: Envelope,
  node: NodeId,
  qSetHash: Hash,
  slotIndex: number,
  votes: readonly Value[],
  accepted: readonly Value[],
): void {
  const exp = makeNominate(node, qSetHash, slotIndex, votes, accepted);
  expect(actual.statement).toEqual(exp.statement);
}

// ---------------------------------------------------------------------------
// TestSCP driver

interface TimerData {
  absoluteTimeout: number;
  callback: (() => void) | null;
}

// Copied from HerderSCPDriver.cpp
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

export class TestSCP implements SCPDriver {
  readonly scp: SCP;
  initialBallotTimeoutMs = 1000;
  incrementBallotTimeoutMs = 1000;
  initialNominationTimeoutMs = 1000;
  incrementNominationTimeoutMs = 1000;

  priorityLookup: (n: NodeId) => bigint;
  hashValueCalculator: (v: Value) => bigint = () => 0n;
  validateValueOverride: ((slotIndex: number, value: Value, nomination: boolean) => ValidationLevel) | null = null;

  readonly quorumSets = new Map<Hash, QuorumSet>();
  readonly envs: Envelope[] = [];
  readonly externalizedValues = new Map<number, Value>();
  readonly heardFromQuorums = new Map<number, Ballot[]>();

  // only used by nomination protocol
  expectedCandidates = new Set<Value>();
  compositeValue: Value = '';

  readonly timers = new Map<number, TimerData>();
  currentTimerOffset = 0;

  constructor(node: NodeId, qSetLocal: QuorumSet, isValidator = true) {
    this.scp = new SCP(this, node, isValidator, qSetLocal);
    this.priorityLookup = (n) => (n === this.scp.getLocalNodeId() ? 1000n : 1n);
    this.storeQuorumSet(this.scp.getLocalQuorumSet());
  }

  signEnvelope(_env: Envelope): void {}

  storeQuorumSet(qSet: QuorumSet): Hash {
    const h = hashQuorumSet(qSet);
    this.quorumSets.set(h, cloneQSet(qSet));
    return h;
  }

  validateValue(slotIndex: number, value: Value, nomination: boolean): ValidationLevel {
    if (this.validateValueOverride) return this.validateValueOverride(slotIndex, value, nomination);
    return ValidationLevel.FullyValidated;
  }

  extractValidValue(_slotIndex: number, _value: Value): Value | null {
    return null;
  }

  ballotDidHearFromQuorum(slotIndex: number, ballot: Ballot): void {
    let l = this.heardFromQuorums.get(slotIndex);
    if (!l) {
      l = [];
      this.heardFromQuorums.set(slotIndex, l);
    }
    l.push({ ...ballot });
  }

  heardFromQuorumsOf(slotIndex: number): Ballot[] {
    return this.heardFromQuorums.get(slotIndex) ?? [];
  }

  valueExternalized(slotIndex: number, value: Value): void {
    if (this.externalizedValues.has(slotIndex)) throw new Error('Value already externalized');
    this.externalizedValues.set(slotIndex, value);
  }

  getQSet(qSetHash: Hash): QuorumSet | null {
    return this.quorumSets.get(qSetHash) ?? null;
  }

  emitEnvelope(envelope: Envelope): void {
    this.envs.push(envelope);
  }

  // used to test BallotProtocol and bypass nomination
  bumpState(slotIndex: number, v: Value): boolean {
    return this.scp.getSlot(slotIndex, true)!.bumpState(v, true);
  }

  nominate(slotIndex: number, value: Value, timedout: boolean): boolean {
    return this.scp.getSlot(slotIndex, true)!.nominate(value, value, timedout);
  }

  combineCandidates(_slotIndex: number, candidates: Value[]): Value | null {
    if (candidates.length !== this.expectedCandidates.size) {
      throw new Error(`combineCandidates: expected ${this.expectedCandidates.size} candidates, got ${candidates.length}`);
    }
    for (const c of candidates) {
      if (!this.expectedCandidates.has(c)) throw new Error('combineCandidates: unexpected candidate');
    }
    if (this.compositeValue === '') throw new Error('combineCandidates: no composite value set');
    return this.compositeValue;
  }

  // override the internal hashing scheme in order to make tests
  // more predictable.
  computeHashNode(_slotIndex: number, _prev: Value, isPriority: boolean, _roundNumber: number, n: NodeId): bigint {
    return isPriority ? this.priorityLookup(n) : 0n;
  }

  // override the value hashing, to make tests more predictable.
  computeValueHash(_slotIndex: number, _prev: Value, _roundNumber: number, value: Value): bigint {
    return this.hashValueCalculator(value);
  }

  computeTimeout(roundNumber: number, isNomination: boolean): number {
    const initial = isNomination ? this.initialNominationTimeoutMs : this.initialBallotTimeoutMs;
    const increment = isNomination ? this.incrementNominationTimeoutMs : this.incrementBallotTimeoutMs;
    return Math.min(initial + (roundNumber - 1) * increment, MAX_TIMEOUT_MS);
  }

  setupTimer(_slotIndex: number, timerId: number, timeoutMs: number, cb: (() => void) | null): void {
    this.timers.set(timerId, { absoluteTimeout: this.currentTimerOffset + (cb ? timeoutMs : 0), callback: cb });
  }

  stopTimer(_slotIndex: number, timerId: number): void {
    this.timers.delete(timerId);
  }

  getBallotProtocolTimer(): TimerData {
    return this.timers.get(TIMER_BALLOT) ?? { absoluteTimeout: 0, callback: null };
  }

  // pretends the time moved forward
  bumpTimerOffset(): number {
    // increase by more than the maximum timeout
    this.currentTimerOffset += 5 * 3600 * 1000;
    return this.currentTimerOffset;
  }

  // returns true if a ballot protocol timer exists (in the past or future)
  hasBallotTimer(): boolean {
    return !!this.getBallotProtocolTimer().callback;
  }

  // returns true if the ballot protocol timer is scheduled in the future
  // false if scheduled in the past
  hasBallotTimerUpcoming(): boolean {
    // timer must be scheduled in the past or future
    expect(this.hasBallotTimer()).toBe(true);
    return this.currentTimerOffset < this.getBallotProtocolTimer().absoluteTimeout;
  }

  getLatestCompositeCandidate(slotIndex: number): Value | null {
    return this.scp.getSlot(slotIndex, true)!.getLatestCompositeCandidate();
  }

  receiveEnvelope(envelope: Envelope): EnvelopeState {
    return this.scp.receiveEnvelope(envelope);
  }

  getEntireState(index: number): Envelope[] {
    return this.scp.getSlot(index, false)!.getEntireCurrentState();
  }

  getCurrentEnvelope(index: number, id: NodeId): Envelope {
    const e = this.getEntireState(index).find((x) => x.statement.nodeId === id);
    if (!e) throw new Error('not found');
    return e;
  }

  getNominationLeaders(slotIndex: number): NodeId[] {
    return this.scp.getSlot(slotIndex, false)!.getNominationLeaders();
  }
}
