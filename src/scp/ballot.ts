// Ported from stellar-core (Apache-2.0): src/scp/BallotProtocol.cpp
//
// Numbers in parenthesis refer to the steps of the ballot protocol in the SCP
// white paper, as in the C++ source. Left out (newer stellar-core features):
// empty-tx-set replacement, the structurally-valid validation level, the
// confirm-commit validity re-check, JSON info and quorum-state reporting.

import { compareNodeIds, isQuorum, isQuorumSetSane, isVBlockingSt, UINT32_MAX } from './quorum';
import type { Slot } from './slot';
import { EnvelopeState, TIMER_BALLOT, ValidationLevel } from './types';
import type {
  Ballot,
  BallotPhase,
  ConfirmPledge,
  Envelope,
  ExternalizePledge,
  Hash,
  NodeId,
  PreparePledge,
  Statement,
  Value,
} from './types';

// max number of transitions that can occur from processing one message
const MAX_ADVANCE_SLOT_RECURSION = 50;

/** [low, high] counters. */
export type Interval = [number, number];

type StatementPredicate = (st: Statement) => boolean;
type BallotStatementType = 'prepare' | 'confirm' | 'externalize';

// SCPStatementType values: PREPARE < CONFIRM < EXTERNALIZE (< NOMINATE).
const STATEMENT_RANK = { prepare: 0, confirm: 1, externalize: 2, nominate: 3 } as const;

const ZERO_BALLOT: Ballot = Object.freeze({ counter: 0, value: '' });

function ballot(counter: number, value: Value): Ballot {
  return { counter, value };
}

function copyBallot(b: Ballot): Ballot {
  return { counter: b.counter, value: b.value };
}

function invariant(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SCP invariant violated: ${msg}`);
}

// ---------------------------------------------------------------------------
// Ballot comparison helpers

/** Ballots are ordered by counter, then by value (byte order). */
export function compareBallots(b1: Ballot, b2: Ballot): number {
  if (b1.counter < b2.counter) return -1;
  if (b2.counter < b1.counter) return 1;
  // ballots are also strictly ordered by value
  if (b1.value < b2.value) return -1;
  if (b2.value < b1.value) return 1;
  return 0;
}

/** compareBallots for optional ballots: a missing ballot is the smallest. */
export function compareOptBallots(b1: Ballot | null, b2: Ballot | null): number {
  if (b1 && b2) return compareBallots(b1, b2);
  if (b1 && !b2) return 1;
  if (!b1 && b2) return -1;
  return 0;
}

/** b1 ~ b2 */
export function areBallotsCompatible(b1: Ballot, b2: Ballot): boolean {
  return b1.value === b2.value;
}

/** b1 <= b2 && b1 !~ b2 */
export function areBallotsLessAndIncompatible(b1: Ballot, b2: Ballot): boolean {
  return compareBallots(b1, b2) <= 0 && !areBallotsCompatible(b1, b2);
}

/** b1 <= b2 && b1 ~ b2 */
export function areBallotsLessAndCompatible(b1: Ballot, b2: Ballot): boolean {
  return compareBallots(b1, b2) <= 0 && areBallotsCompatible(b1, b2);
}

function sortBallots(ballots: Iterable<Ballot>): Ballot[] {
  const unique = new Map<string, Ballot>();
  for (const b of ballots) unique.set(`${b.counter}:${b.value}`, b);
  return [...unique.values()].sort(compareBallots);
}

// ---------------------------------------------------------------------------
// Statement helpers (static in the C++ class)

/** BallotProtocol::isNewerStatement: total order on ballot statements of one node. */
export function isNewerBallotStatement(oldst: Statement, st: Statement): boolean {
  const t = st.pledges.type;

  // statement type (PREPARE < CONFIRM < EXTERNALIZE)
  if (oldst.pledges.type !== t) return STATEMENT_RANK[oldst.pledges.type] < STATEMENT_RANK[t];

  // can't have duplicate EXTERNALIZE statements
  if (t === 'externalize') return false;

  if (t === 'confirm') {
    // sorted by (b, p, p', h) (p' = 0 implicitly)
    const oldC = oldst.pledges as ConfirmPledge;
    const c = st.pledges as ConfirmPledge;
    const compBallot = compareBallots(oldC.ballot, c.ballot);
    if (compBallot < 0) return true;
    if (compBallot === 0) {
      if (oldC.nPrepared === c.nPrepared) return oldC.nH < c.nH;
      return oldC.nPrepared < c.nPrepared;
    }
    return false;
  }

  if (t === 'prepare') {
    // Lexicographical order between PREPARE statements: (b, p, p', h)
    const oldPrep = oldst.pledges as PreparePledge;
    const prep = st.pledges as PreparePledge;
    let compBallot = compareBallots(oldPrep.ballot, prep.ballot);
    if (compBallot < 0) return true;
    if (compBallot === 0) {
      compBallot = compareOptBallots(oldPrep.prepared, prep.prepared);
      if (compBallot < 0) return true;
      if (compBallot === 0) {
        compBallot = compareOptBallots(oldPrep.preparedPrime, prep.preparedPrime);
        if (compBallot < 0) return true;
        if (compBallot === 0) return oldPrep.nH < prep.nH;
      }
    }
  }
  return false;
}

/** b for PREPARE, (nCommit, b.x) for CONFIRM, c for EXTERNALIZE. */
export function getWorkingBallot(st: Statement): Ballot {
  const pl = st.pledges;
  switch (pl.type) {
    case 'prepare':
      return pl.ballot;
    case 'confirm':
      return ballot(pl.nCommit, pl.ballot.value);
    case 'externalize':
      return pl.commit;
    default:
      throw new Error('getWorkingBallot: not a ballot statement');
  }
}

/** Quorum set hash sent with the statement (commitQuorumSetHash for EXTERNALIZE). */
export function getCompanionQuorumSetHashFromStatement(st: Statement): Hash {
  const pl = st.pledges;
  switch (pl.type) {
    case 'prepare':
    case 'confirm':
    case 'nominate':
      return pl.quorumSetHash;
    case 'externalize':
      return pl.commitQuorumSetHash;
    default:
      throw new Error('unknown statement type');
  }
}

/** All values referenced by a ballot statement (sorted, unique). */
export function getBallotStatementValues(st: Statement): Value[] {
  const values = new Set<Value>();
  const pl = st.pledges;
  switch (pl.type) {
    case 'prepare':
      if (pl.ballot.counter !== 0) values.add(pl.ballot.value);
      if (pl.prepared) values.add(pl.prepared.value);
      if (pl.preparedPrime) values.add(pl.preparedPrime.value);
      break;
    case 'confirm':
      values.add(pl.ballot.value);
      break;
    case 'externalize':
      values.add(pl.commit.value);
      break;
    default:
      throw new Error('getBallotStatementValues: not a ballot statement');
  }
  return [...values].sort();
}

/** Is `ballot` prepared by st? */
export function hasPreparedBallot(b: Ballot, st: Statement): boolean {
  const pl = st.pledges;
  switch (pl.type) {
    case 'prepare':
      return (
        (pl.prepared !== null && areBallotsLessAndCompatible(b, pl.prepared)) ||
        (pl.preparedPrime !== null && areBallotsLessAndCompatible(b, pl.preparedPrime))
      );
    case 'confirm':
      return areBallotsLessAndCompatible(b, ballot(pl.nPrepared, pl.ballot.value));
    case 'externalize':
      return areBallotsCompatible(b, pl.commit);
    default:
      return false;
  }
}

/** Does st (accept) commit `ballot` for every counter in `check`? */
export function commitPredicate(b: Ballot, check: Interval, st: Statement): boolean {
  const pl = st.pledges;
  switch (pl.type) {
    case 'prepare':
      return false;
    case 'confirm':
      if (areBallotsCompatible(b, pl.ballot)) return pl.nCommit <= check[0] && check[1] <= pl.nH;
      return false;
    case 'externalize':
      if (areBallotsCompatible(b, pl.commit)) return pl.commit.counter <= check[0];
      return false;
    default:
      return false;
  }
}

function statementBallotCounter(st: Statement): number {
  const pl = st.pledges;
  switch (pl.type) {
    case 'prepare':
      return pl.ballot.counter;
    case 'confirm':
      return pl.ballot.counter;
    case 'externalize':
      return UINT32_MAX;
    default:
      // Should never be called with NOMINATE.
      throw new Error('statementBallotCounter: nomination statement');
  }
}

/**
 * BallotProtocol::findExtendedInterval: scan boundaries (sorted ascending)
 * from the top for the widest interval satisfying pred. Returns the new
 * candidate (unchanged when nothing matches).
 */
export function findExtendedInterval(
  candidate: Interval,
  boundaries: readonly number[],
  pred: (cur: Interval) => boolean,
): Interval {
  let cand: Interval = [candidate[0], candidate[1]];
  // iterate through interesting boundaries, starting from the top
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const b = boundaries[i];
    let cur: Interval;
    if (cand[0] === 0) {
      // first, find the high bound
      cur = [b, b];
    } else if (b > cand[1]) {
      // invalid
      continue;
    } else {
      cur = [b, cand[1]];
    }

    if (pred(cur)) {
      cand = cur;
    } else if (cand[0] !== 0) {
      // could not extend further
      break;
    }
  }
  return cand;
}

function pledgesEqual(a: Statement['pledges'], b: Statement['pledges']): boolean {
  if (a.type !== b.type) return false;
  const eqB = (x: Ballot | null, y: Ballot | null) =>
    x === y || (x !== null && y !== null && x.counter === y.counter && x.value === y.value);
  switch (a.type) {
    case 'prepare': {
      const p = b as PreparePledge;
      return (
        a.quorumSetHash === p.quorumSetHash &&
        eqB(a.ballot, p.ballot) &&
        eqB(a.prepared, p.prepared) &&
        eqB(a.preparedPrime, p.preparedPrime) &&
        a.nC === p.nC &&
        a.nH === p.nH
      );
    }
    case 'confirm': {
      const c = b as ConfirmPledge;
      return (
        a.quorumSetHash === c.quorumSetHash &&
        eqB(a.ballot, c.ballot) &&
        a.nPrepared === c.nPrepared &&
        a.nCommit === c.nCommit &&
        a.nH === c.nH
      );
    }
    case 'externalize': {
      const e = b as ExternalizePledge;
      return a.commitQuorumSetHash === e.commitQuorumSetHash && eqB(a.commit, e.commit) && a.nH === e.nH;
    }
    case 'nominate': {
      const n = b as typeof a;
      return (
        a.quorumSetHash === n.quorumSetHash &&
        a.votes.length === n.votes.length &&
        a.accepted.length === n.accepted.length &&
        a.votes.every((v, i) => v === n.votes[i]) &&
        a.accepted.every((v, i) => v === n.accepted[i])
      );
    }
  }
}

/** Deep equality of two statements. */
export function statementsEqual(a: Statement, b: Statement): boolean {
  return a.nodeId === b.nodeId && a.slotIndex === b.slotIndex && pledgesEqual(a.pledges, b.pledges);
}

/** Deep equality of two envelopes (statement and signature). */
export function envelopesEqual(a: Envelope, b: Envelope): boolean {
  return a.signature === b.signature && statementsEqual(a.statement, b.statement);
}

// ---------------------------------------------------------------------------

/** Ballot protocol state of one slot. */
export interface BallotInfo {
  phase: BallotPhase;
  current: Ballot | null;
  prepared: Ballot | null;
  preparedPrime: Ballot | null;
  high: Ballot | null;
  commit: Ballot | null;
  valueOverride: Value | null;
  heardFromQuorum: boolean;
}

export class BallotProtocol {
  private heardFromQuorum = false;

  private currentBallot: Ballot | null = null; // b
  private prepared: Ballot | null = null; // p
  private preparedPrime: Ballot | null = null; // p'
  private highBallot: Ballot | null = null; // h
  private commit: Ballot | null = null; // c
  private readonly latestEnvelopes = new Map<NodeId, Envelope>(); // M
  private phase: BallotPhase = 'PREPARE'; // Phi
  private valueOverride: Value | null = null; // z

  private currentMessageLevel = 0; // number of messages triggered in one run

  // The number of times the timer has expired.
  private timerExpCount = 0;

  private lastEnvelope: Envelope | null = null; // last envelope generated by this node
  private lastEnvelopeEmit: Envelope | null = null; // last envelope emitted by this node

  constructor(private readonly slot: Slot) {}

  private get driver() {
    return this.slot.getSCPDriver();
  }

  private localNodeId(): NodeId {
    return this.slot.getLocalNode().getNodeId();
  }

  private isNewerStatementFor(nodeId: NodeId, st: Statement): boolean {
    const oldp = this.latestEnvelopes.get(nodeId);
    return oldp === undefined ? true : isNewerBallotStatement(oldp.statement, st);
  }

  private recordEnvelope(env: Envelope): void {
    this.latestEnvelopes.set(env.statement.nodeId, env);
    this.slot.recordStatement(env.statement);
  }

  /**
   * Process a newly received envelope for this slot. self: true when the
   * node feeds its own statements to trigger more state changes.
   */
  processEnvelope(envelope: Envelope, self: boolean): EnvelopeState {
    const statement = envelope.statement;
    invariant(statement.slotIndex === this.slot.slotIndex, 'envelope for another slot');
    const nodeId = statement.nodeId;

    if (!this.isStatementSane(statement, self)) return EnvelopeState.INVALID;

    if (!this.isNewerStatementFor(nodeId, statement)) return EnvelopeState.INVALID;

    const validationRes = this.statementValidationLevel(statement);

    // If the value is not valid, we just ignore it.
    if (validationRes === ValidationLevel.Invalid) return EnvelopeState.INVALID;

    if (this.phase !== 'EXTERNALIZE') {
      if (validationRes !== ValidationLevel.FullyValidated) this.slot.setFullyValidated(false);

      this.recordEnvelope(envelope);
      this.advanceSlot(statement);
      return EnvelopeState.VALID;
    }

    // note: this handles also our own messages
    // in particular our final EXTERNALIZE message
    if (this.commit!.value === getWorkingBallot(statement).value) {
      this.recordEnvelope(envelope);
      return EnvelopeState.VALID;
    }

    return EnvelopeState.INVALID;
  }

  /** Basic sanity check on a statement (including its quorum set). */
  isStatementSane(st: Statement, self: boolean): boolean {
    const qSet = this.slot.getQuorumSetFromStatement(st);
    let res = qSet !== null && isQuorumSetSane(qSet, false);
    if (!res) return false;

    const pl = st.pledges;
    switch (pl.type) {
      case 'prepare': {
        // self is allowed to have b = 0 (as long as it never gets emitted)
        let isOK = self || pl.ballot.counter > 0;

        isOK =
          isOK &&
          (!pl.preparedPrime || !pl.prepared || areBallotsLessAndIncompatible(pl.preparedPrime, pl.prepared));

        isOK = isOK && (pl.nH === 0 || (pl.prepared !== null && pl.nH <= pl.prepared.counter));

        // c != 0 -> c <= h <= b
        isOK = isOK && (pl.nC === 0 || (pl.nH !== 0 && pl.ballot.counter >= pl.nH && pl.nH >= pl.nC));

        res = isOK;
        break;
      }
      case 'confirm':
        // c <= h <= b
        res = pl.ballot.counter > 0 && pl.nH <= pl.ballot.counter && pl.nCommit <= pl.nH;
        break;
      case 'externalize':
        res = pl.commit.counter > 0 && pl.nH >= pl.commit.counter;
        break;
      default:
        res = false;
    }
    return res;
  }

  /** Abandon the current ballot, move to counter n (or current + 1 when n == 0). */
  abandonBallot(n: number): boolean {
    let res = false;
    let v = this.slot.getLatestCompositeCandidate();

    if (v === null || v === '') {
      if (this.currentBallot) v = this.currentBallot.value;
    }
    if (v !== null && v !== '') {
      res = n === 0 ? this.bumpState(v, true) : this.bumpState(v, n);
    }
    return res;
  }

  /**
   * Bump the ballot. With a boolean: force=false only starts the ballot
   * protocol (no-op once started), force=true moves to counter + 1. With a
   * number: move to that counter.
   */
  bumpState(value: Value, force: boolean): boolean;
  bumpState(value: Value, n: number): boolean;
  bumpState(value: Value, forceOrN: boolean | number): boolean {
    if (typeof forceOrN === 'boolean') {
      if (!forceOrN && this.currentBallot) return false;
      // uint32 arithmetic: counter + 1 wraps to 0 at UINT32_MAX (then no-ops)
      const n = this.currentBallot ? (this.currentBallot.counter + 1) >>> 0 : 1;
      return this.bumpStateToCounter(value, n);
    }
    return this.bumpStateToCounter(value, forceOrN);
  }

  private bumpStateToCounter(value: Value, n: number): boolean {
    if (this.phase !== 'PREPARE' && this.phase !== 'CONFIRM') return false;

    // we use the value that we saw confirmed prepared
    // or that we at least voted to commit to
    const newb = ballot(n, this.valueOverride !== null ? this.valueOverride : value);

    const updated = this.updateCurrentValue(newb);
    if (updated) {
      this.emitCurrentStateStatement();
      this.checkHeardFromQuorum();
    }
    return updated;
  }

  // updates the local state based to the specified ballot
  // (that could be a prepared ballot) enforcing invariants
  private updateCurrentValue(b: Ballot): boolean {
    if (this.phase !== 'PREPARE' && this.phase !== 'CONFIRM') return false;

    let updated = false;
    if (!this.currentBallot) {
      this.bumpToBallot(b, true);
      updated = true;
    } else {
      if (this.commit && !areBallotsCompatible(this.commit, b)) return false;

      const comp = compareBallots(this.currentBallot, b);
      if (comp < 0) {
        this.bumpToBallot(b, true);
        updated = true;
      } else if (comp > 0) {
        // this case may happen if the other nodes are not following the
        // protocol (and we end up with a smaller value). Can't just bump to
        // the value as we may already have statements at counter+1.
        return false;
      }
    }

    this.checkInvariants();
    return updated;
  }

  // lowest level method to update the current ballot (no validation)
  // check: verifies that ballot is greater than old one
  private bumpToBallot(b: Ballot, check: boolean): void {
    // bumpToBallot should be never called once we committed.
    invariant(this.phase !== 'EXTERNALIZE', 'bumpToBallot after externalize');

    if (check) {
      // We should move mCurrentBallot monotonically only
      invariant(!this.currentBallot || compareBallots(b, this.currentBallot) >= 0, 'ballot moved backwards');
    }

    const gotBumped = !this.currentBallot || this.currentBallot.counter !== b.counter;

    if (!this.currentBallot) this.driver.startedBallotProtocol?.(this.slot.slotIndex, copyBallot(b));

    this.currentBallot = copyBallot(b);

    // note: we have to clear some fields (and recompute them based on latest
    // messages)
    // invariant: h.value = b.value
    if (this.highBallot && !areBallotsCompatible(this.currentBallot, this.highBallot)) {
      this.highBallot = null;
      // invariant: c set only when h is set
      this.commit = null;
    }

    if (gotBumped) this.heardFromQuorum = false;
  }

  private startBallotProtocolTimer(): void {
    const timeout = this.driver.computeTimeout(this.currentBallot!.counter, false);
    this.driver.setupTimer(this.slot.slotIndex, TIMER_BALLOT, timeout, () => this.ballotProtocolTimerExpired());
  }

  private stopBallotProtocolTimer(): void {
    this.driver.setupTimer(this.slot.slotIndex, TIMER_BALLOT, 0, null);
  }

  ballotProtocolTimerExpired(): void {
    this.timerExpCount++;
    this.abandonBallot(0);
  }

  // create a statement of the given type using the local state
  private createStatement(type: BallotStatementType): Statement {
    this.checkInvariants();

    const qSetHash = this.slot.getLocalNode().getQuorumSetHash();
    let pledges: Statement['pledges'];
    switch (type) {
      case 'prepare':
        pledges = {
          type: 'prepare',
          quorumSetHash: qSetHash,
          ballot: this.currentBallot ? copyBallot(this.currentBallot) : copyBallot(ZERO_BALLOT),
          prepared: this.prepared ? copyBallot(this.prepared) : null,
          preparedPrime: this.preparedPrime ? copyBallot(this.preparedPrime) : null,
          nC: this.commit ? this.commit.counter : 0,
          nH: this.highBallot ? this.highBallot.counter : 0,
        };
        break;
      case 'confirm':
        pledges = {
          type: 'confirm',
          ballot: copyBallot(this.currentBallot!),
          nPrepared: this.prepared!.counter,
          nCommit: this.commit!.counter,
          nH: this.highBallot!.counter,
          quorumSetHash: qSetHash,
        };
        break;
      case 'externalize':
        pledges = {
          type: 'externalize',
          commit: copyBallot(this.commit!),
          nH: this.highBallot!.counter,
          commitQuorumSetHash: qSetHash,
        };
        break;
    }
    return { nodeId: this.localNodeId(), slotIndex: this.slot.slotIndex, pledges };
  }

  // emits a statement reflecting the nodes' current state
  // and attempts to make progress
  private emitCurrentStateStatement(): void {
    const t: BallotStatementType =
      this.phase === 'PREPARE' ? 'prepare' : this.phase === 'CONFIRM' ? 'confirm' : 'externalize';

    const statement = this.createStatement(t);
    const envelope = this.slot.createEnvelope(statement);

    const canEmit = this.currentBallot !== null;

    // if we generate the same envelope, don't process it again
    // this can occur when updating h in PREPARE phase
    // as statements only keep track of h.n (but h.x could be different)
    const lastEnv = this.latestEnvelopes.get(this.localNodeId());

    if (lastEnv === undefined || !envelopesEqual(lastEnv, envelope)) {
      if (this.slot.processEnvelope(envelope, true) === EnvelopeState.VALID) {
        if (canEmit && (!this.lastEnvelope || isNewerBallotStatement(this.lastEnvelope.statement, envelope.statement))) {
          this.lastEnvelope = envelope;
          // this will no-op if invoked from advanceSlot
          // as advanceSlot consolidates all messages sent
          this.sendLatestEnvelope();
        }
      } else {
        // there is a bug in the application if it queued up
        // a statement for itself that it considers invalid
        throw new Error('moved to a bad state (ballot protocol)');
      }
    }
  }

  // verifies that the internal state is consistent
  private checkInvariants(): void {
    switch (this.phase) {
      case 'PREPARE':
        break;
      case 'CONFIRM':
      case 'EXTERNALIZE':
        invariant(this.currentBallot, 'b set in CONFIRM/EXTERNALIZE');
        invariant(this.prepared, 'p set in CONFIRM/EXTERNALIZE');
        invariant(this.commit, 'c set in CONFIRM/EXTERNALIZE');
        invariant(this.highBallot, 'h set in CONFIRM/EXTERNALIZE');
        break;
    }

    if (this.currentBallot) invariant(this.currentBallot.counter !== 0, 'b.n != 0');
    if (this.prepared && this.preparedPrime) {
      invariant(areBallotsLessAndIncompatible(this.preparedPrime, this.prepared), "p' < p and p' !~ p");
    }
    if (this.highBallot) {
      invariant(this.currentBallot, 'h set implies b set');
      invariant(areBallotsLessAndCompatible(this.highBallot, this.currentBallot), 'h <= b and h ~ b');
    }
    if (this.commit) {
      invariant(this.currentBallot, 'c set implies b set');
      invariant(this.highBallot, 'c set implies h set');
      invariant(areBallotsLessAndCompatible(this.commit, this.highBallot), 'c <= h and c ~ h');
      invariant(areBallotsLessAndCompatible(this.highBallot, this.currentBallot), 'h <= b and h ~ b');
    }
  }

  // computes a list of candidate values that may have been prepared
  // (sorted ascending)
  private getPrepareCandidates(hint: Statement): Ballot[] {
    const hintBallots: Ballot[] = [];
    const hp = hint.pledges;
    switch (hp.type) {
      case 'prepare':
        hintBallots.push(hp.ballot);
        if (hp.prepared) hintBallots.push(hp.prepared);
        if (hp.preparedPrime) hintBallots.push(hp.preparedPrime);
        break;
      case 'confirm':
        hintBallots.push(ballot(hp.nPrepared, hp.ballot.value));
        hintBallots.push(ballot(UINT32_MAX, hp.ballot.value));
        break;
      case 'externalize':
        hintBallots.push(ballot(UINT32_MAX, hp.commit.value));
        break;
      default:
        throw new Error('getPrepareCandidates: nomination hint');
    }

    const candidates: Ballot[] = [];

    // from the highest hint ballot down (the result does not depend on it)
    for (const topVote of sortBallots(hintBallots).reverse()) {
      const val = topVote.value;

      // find candidates that may have been prepared
      for (const e of this.latestEnvelopes.values()) {
        const pl = e.statement.pledges;
        switch (pl.type) {
          case 'prepare':
            if (areBallotsLessAndCompatible(pl.ballot, topVote)) candidates.push(pl.ballot);
            if (pl.prepared && areBallotsLessAndCompatible(pl.prepared, topVote)) candidates.push(pl.prepared);
            if (pl.preparedPrime && areBallotsLessAndCompatible(pl.preparedPrime, topVote)) {
              candidates.push(pl.preparedPrime);
            }
            break;
          case 'confirm':
            if (areBallotsCompatible(topVote, pl.ballot)) {
              candidates.push(topVote);
              if (pl.nPrepared < topVote.counter) candidates.push(ballot(pl.nPrepared, val));
            }
            break;
          case 'externalize':
            if (areBallotsCompatible(topVote, pl.commit)) candidates.push(topVote);
            break;
          default:
            throw new Error('nomination statement in ballot state');
        }
      }
    }

    return sortBallots(candidates);
  }

  // helper to perform step (8) from the paper
  private updateCurrentIfNeeded(h: Ballot): boolean {
    let didWork = false;
    if (!this.currentBallot || compareBallots(this.currentBallot, h) < 0) {
      this.bumpToBallot(h, true);
      didWork = true;
    }
    return didWork;
  }

  // step 1 and 5 from the SCP paper
  private attemptAcceptPrepared(hint: Statement): boolean {
    if (this.phase !== 'PREPARE' && this.phase !== 'CONFIRM') return false;

    const candidates = this.getPrepareCandidates(hint);

    // see if we can accept any of the candidates, starting with the highest
    for (let i = candidates.length - 1; i >= 0; i--) {
      const b = candidates[i];

      if (this.phase === 'CONFIRM') {
        // only consider the ballot if it may help us increase
        // p (note: at this point, p ~ c)
        if (!areBallotsLessAndCompatible(this.prepared!, b)) continue;
        // stellar-core asserts c ~ ballot. A v-blocking set of faulty peers
        // can make us accept commit while p is on another value: skip.
        if (!areBallotsCompatible(this.commit!, b)) continue;
      }

      // if ballot <= p' ballot is neither a candidate for p nor p'
      if (this.preparedPrime && compareBallots(b, this.preparedPrime) <= 0) continue;

      // if ballot is already covered by p, skip
      if (this.prepared && areBallotsLessAndCompatible(b, this.prepared)) continue;
      // otherwise, there is a chance it increases p'

      const accepted = this.federatedAccept(
        // checks if any node is voting for this ballot
        (st) => {
          const pl = st.pledges;
          switch (pl.type) {
            case 'prepare':
              return areBallotsLessAndCompatible(b, pl.ballot);
            case 'confirm':
              return areBallotsCompatible(b, pl.ballot);
            case 'externalize':
              return areBallotsCompatible(b, pl.commit);
            default:
              return false;
          }
        },
        (st) => hasPreparedBallot(b, st),
      );
      if (accepted) return this.setAcceptPrepared(b);
    }

    return false;
  }

  private setAcceptPrepared(b: Ballot): boolean {
    // update our state
    let didWork = this.setPrepared(b);

    // check if we also need to clear 'c'
    if (this.commit && this.highBallot) {
      if (
        (this.prepared && areBallotsLessAndIncompatible(this.highBallot, this.prepared)) ||
        (this.preparedPrime && areBallotsLessAndIncompatible(this.highBallot, this.preparedPrime))
      ) {
        invariant(this.phase === 'PREPARE', 'clearing c only in PREPARE');
        this.commit = null;
        didWork = true;
      }
    }

    if (didWork) {
      this.driver.acceptedBallotPrepared?.(this.slot.slotIndex, copyBallot(b));
      this.emitCurrentStateStatement();
    }

    return didWork;
  }

  // step 2+3+8 from the SCP paper
  private attemptConfirmPrepared(hint: Statement): boolean {
    if (this.phase !== 'PREPARE') return false;

    // check if we could accept this ballot as prepared
    if (!this.prepared) return false;

    const candidates = this.getPrepareCandidates(hint);

    // see if we can accept any of the candidates, starting with the highest
    let newH: Ballot | null = null;
    let cur = candidates.length - 1;
    for (; cur >= 0; cur--) {
      const b = candidates[cur];

      // only consider it if we can potentially raise h
      if (this.highBallot && compareBallots(this.highBallot, b) >= 0) break;

      if (this.federatedRatify((st) => hasPreparedBallot(b, st))) {
        newH = b;
        break;
      }
    }

    let res = false;

    if (newH !== null) {
      let newC: Ballot = ZERO_BALLOT;
      // now, look for newC (left as 0 if no update)
      // step (3) from the paper
      const b = this.currentBallot ? this.currentBallot : ZERO_BALLOT;
      if (
        !this.commit &&
        (!this.prepared || !areBallotsLessAndIncompatible(newH, this.prepared)) &&
        (!this.preparedPrime || !areBallotsLessAndIncompatible(newH, this.preparedPrime))
      ) {
        // continue where we left off (cur is at newH at this point)
        for (; cur >= 0; cur--) {
          const candidate = candidates[cur];
          if (compareBallots(candidate, b) < 0) break;
          // c and h must be compatible
          if (!areBallotsLessAndCompatible(candidate, newH)) continue;
          if (this.federatedRatify((st) => hasPreparedBallot(candidate, st))) {
            newC = candidate;
          } else {
            break;
          }
        }
      }
      res = this.setConfirmPrepared(newC, newH);
    }
    return res;
  }

  // newC, newH : low/high bounds prepared confirmed
  private setConfirmPrepared(newC: Ballot, newH: Ballot): boolean {
    let didWork = false;

    // remember newH's value
    this.valueOverride = newH.value;

    // prepare(<0, y>) can be confirmed (a peer may send prepared = <0, y>),
    // but counter 0 is not a valid h or b: it only sets the value of the
    // next ballot (draft-05 3.6). stellar-core would move b to <0, y> here.
    if (newH.counter === 0) return false;

    // we don't set c/h if we're not on a compatible ballot
    if (!this.currentBallot || areBallotsCompatible(this.currentBallot, newH)) {
      if (!this.highBallot || compareBallots(newH, this.highBallot) > 0) {
        didWork = true;
        this.highBallot = copyBallot(newH);
      }

      if (newC.counter !== 0) {
        invariant(!this.commit, 'c not yet set');
        this.commit = copyBallot(newC);
        didWork = true;
      }

      if (didWork) this.driver.confirmedBallotPrepared?.(this.slot.slotIndex, copyBallot(newH));
    }

    // always perform step (8) with the computed value of h
    didWork = this.updateCurrentIfNeeded(newH) || didWork;

    if (didWork) this.emitCurrentStateStatement();

    return didWork;
  }

  // constructs the set of counters representing the
  // commit ballots compatible with the ballot (sorted ascending)
  private getCommitBoundariesFromStatements(b: Ballot): number[] {
    const res = new Set<number>();
    for (const env of this.latestEnvelopes.values()) {
      const pl = env.statement.pledges;
      switch (pl.type) {
        case 'prepare':
          if (areBallotsCompatible(b, pl.ballot) && pl.nC !== 0) {
            res.add(pl.nC);
            res.add(pl.nH);
          }
          break;
        case 'confirm':
          if (areBallotsCompatible(b, pl.ballot)) {
            res.add(pl.nCommit);
            res.add(pl.nH);
          }
          break;
        case 'externalize':
          if (areBallotsCompatible(b, pl.commit)) {
            res.add(pl.commit.counter);
            res.add(pl.nH);
            res.add(UINT32_MAX);
          }
          break;
        default:
          throw new Error('nomination statement in ballot state');
      }
    }
    return [...res].sort((x, y) => x - y);
  }

  // step (4 and 6)+8 from the SCP paper
  private attemptAcceptCommit(hint: Statement): boolean {
    if (this.phase !== 'PREPARE' && this.phase !== 'CONFIRM') return false;

    // extracts value from hint
    // note: ballot.counter is only used for logging purpose as we're looking at
    // possible value to commit
    let b: Ballot;
    const hp = hint.pledges;
    switch (hp.type) {
      case 'prepare':
        if (hp.nC !== 0) b = ballot(hp.nH, hp.ballot.value);
        else return false;
        break;
      case 'confirm':
        b = ballot(hp.nH, hp.ballot.value);
        break;
      case 'externalize':
        b = ballot(hp.nH, hp.commit.value);
        break;
      default:
        throw new Error('attemptAcceptCommit: nomination hint');
    }

    if (this.phase === 'CONFIRM') {
      if (!areBallotsCompatible(b, this.highBallot!)) return false;
    }

    const pred = (cur: Interval): boolean =>
      this.federatedAccept(
        (st) => {
          const pl = st.pledges;
          switch (pl.type) {
            case 'prepare':
              if (areBallotsCompatible(b, pl.ballot) && pl.nC !== 0) return pl.nC <= cur[0] && cur[1] <= pl.nH;
              return false;
            case 'confirm':
              if (areBallotsCompatible(b, pl.ballot)) return pl.nCommit <= cur[0];
              return false;
            case 'externalize':
              if (areBallotsCompatible(b, pl.commit)) return pl.commit.counter <= cur[0];
              return false;
            default:
              return false;
          }
        },
        (st) => commitPredicate(b, cur, st),
      );

    // build the boundaries to scan
    const boundaries = this.getCommitBoundariesFromStatements(b);
    if (boundaries.length === 0) return false;

    // now, look for the high interval
    const candidate = findExtendedInterval([0, 0], boundaries, pred);

    let res = false;
    if (candidate[0] !== 0) {
      if (this.phase !== 'CONFIRM' || candidate[1] > this.highBallot!.counter) {
        const c = ballot(candidate[0], b.value);
        const h = ballot(candidate[1], b.value);
        res = this.setAcceptCommit(c, h);
      }
    }
    return res;
  }

  // new values for c and h
  private setAcceptCommit(c: Ballot, h: Ballot): boolean {
    let didWork = false;

    // remember h's value
    this.valueOverride = h.value;

    if (
      !this.highBallot ||
      !this.commit ||
      compareBallots(this.highBallot, h) !== 0 ||
      compareBallots(this.commit, c) !== 0
    ) {
      this.commit = copyBallot(c);
      this.highBallot = copyBallot(h);
      didWork = true;
    }

    if (this.phase === 'PREPARE') {
      this.phase = 'CONFIRM';
      if (this.currentBallot && !areBallotsLessAndCompatible(h, this.currentBallot)) this.bumpToBallot(h, false);
      this.preparedPrime = null;
      didWork = true;
    }

    if (didWork) {
      this.updateCurrentIfNeeded(this.highBallot!);
      this.driver.acceptedCommit?.(this.slot.slotIndex, copyBallot(h));
      this.emitCurrentStateStatement();
    }

    return didWork;
  }

  private hasVBlockingSubsetStrictlyAheadOf(n: number): boolean {
    return isVBlockingSt(
      this.slot.getLocalNode().getQuorumSet(),
      this.latestEnvelopes,
      (st) => statementBallotCounter(st) > n,
    );
  }

  // Step 9 from the paper (Feb 2016):
  //
  //   If there is S in M such that the set of senders {v_m | m in S} is
  //   v-blocking and for all m in S, b_m.n > b_v.n, then set b <- <n, z>
  //   where n is the lowest counter for which no such S exists.
  //
  // CONFIRM and EXTERNALIZE statements count too (EXTERNALIZE has an
  // infinite counter).
  private attemptBump(): boolean {
    if (this.phase === 'PREPARE' || this.phase === 'CONFIRM') {
      // First check to see if this condition applies at all. If there
      // is no v-blocking set ahead of the local node, there's nothing
      // to do, return early.
      const localCounter = this.currentBallot ? this.currentBallot.counter : 0;
      if (!this.hasVBlockingSubsetStrictlyAheadOf(localCounter)) return false;

      // Collect all possible counters we might need to advance to.
      const allCounters = new Set<number>();
      for (const e of this.latestEnvelopes.values()) {
        const c = statementBallotCounter(e.statement);
        if (c > localCounter) allCounters.add(c);
      }

      // If we got to here, implicitly there _was_ a v-blocking subset
      // with counters above the local counter; we just need to find a
      // minimal n at which that's no longer true. So check them in
      // order, starting from the smallest.
      for (const n of [...allCounters].sort((x, y) => x - y)) {
        if (!this.hasVBlockingSubsetStrictlyAheadOf(n)) {
          // Move to n.
          return this.abandonBallot(n);
        }
      }
    }
    return false;
  }

  // step 7+8 from the SCP paper
  private attemptConfirmCommit(hint: Statement): boolean {
    if (this.phase !== 'CONFIRM') return false;

    if (!this.highBallot || !this.commit) return false;

    // extracts value from hint
    // note: ballot.counter is only used for logging purpose
    let b: Ballot;
    const hp = hint.pledges;
    switch (hp.type) {
      case 'prepare':
        return false;
      case 'confirm':
        b = ballot(hp.nH, hp.ballot.value);
        break;
      case 'externalize':
        b = ballot(hp.nH, hp.commit.value);
        break;
      default:
        throw new Error('attemptConfirmCommit: nomination hint');
    }

    if (!areBallotsCompatible(b, this.commit)) return false;

    const boundaries = this.getCommitBoundariesFromStatements(b);
    const pred = (cur: Interval): boolean => this.federatedRatify((st) => commitPredicate(b, cur, st));

    const candidate = findExtendedInterval([0, 0], boundaries, pred);

    if (candidate[0] !== 0) {
      const c = ballot(candidate[0], b.value);
      const h = ballot(candidate[1], b.value);
      return this.setConfirmCommit(c, h);
    }
    return false;
  }

  private setConfirmCommit(c: Ballot, h: Ballot): boolean {
    this.commit = copyBallot(c);
    this.highBallot = copyBallot(h);
    this.updateCurrentIfNeeded(this.highBallot);

    this.phase = 'EXTERNALIZE';

    this.emitCurrentStateStatement();

    this.slot.stopNomination();

    this.driver.valueExternalized?.(this.slot.slotIndex, this.commit.value);

    return true;
  }

  // attempts to update p to ballot (updating p' if needed)
  private setPrepared(b: Ballot): boolean {
    let didWork = false;

    // p and p' are the two highest prepared and incompatible ballots
    if (this.prepared) {
      const comp = compareBallots(this.prepared, b);
      if (comp < 0) {
        // as we're replacing p, we see if we should also replace p'
        if (!areBallotsCompatible(this.prepared, b)) this.preparedPrime = copyBallot(this.prepared);
        this.prepared = copyBallot(b);
        didWork = true;
      } else if (comp > 0) {
        // check if we should update only p', this happens
        // either p' was NULL
        // or p' gets replaced by ballot
        //      (p' < ballot and ballot is incompatible with p)
        // note, the later check is here out of paranoia as this function is
        // not called with a value that would not allow us to make progress
        if (
          !this.preparedPrime ||
          (compareBallots(this.preparedPrime, b) < 0 && !areBallotsCompatible(this.prepared, b))
        ) {
          this.preparedPrime = copyBallot(b);
          didWork = true;
        }
      }
    } else {
      this.prepared = copyBallot(b);
      didWork = true;
    }
    return didWork;
  }

  /** Force the state to match one of our own envelopes (restore after restart). */
  setStateFromEnvelope(e: Envelope): void {
    if (this.currentBallot) throw new Error('Cannot set state after starting ballot protocol');

    this.recordEnvelope(e);

    this.lastEnvelope = e;
    this.lastEnvelopeEmit = this.lastEnvelope;

    const pl = e.statement.pledges;
    switch (pl.type) {
      case 'prepare': {
        const b = pl.ballot;
        this.bumpToBallot(b, true);
        if (pl.prepared) this.prepared = copyBallot(pl.prepared);
        if (pl.preparedPrime) this.preparedPrime = copyBallot(pl.preparedPrime);
        if (pl.nH) this.highBallot = ballot(pl.nH, b.value);
        if (pl.nC) this.commit = ballot(pl.nC, b.value);
        this.phase = 'PREPARE';
        break;
      }
      case 'confirm': {
        const v = pl.ballot.value;
        this.bumpToBallot(pl.ballot, true);
        this.prepared = ballot(pl.nPrepared, v);
        this.highBallot = ballot(pl.nH, v);
        this.commit = ballot(pl.nCommit, v);
        this.phase = 'CONFIRM';
        break;
      }
      case 'externalize': {
        const v = pl.commit.value;
        this.bumpToBallot(ballot(UINT32_MAX, v), true);
        this.prepared = ballot(UINT32_MAX, v);
        this.highBallot = ballot(pl.nH, v);
        this.commit = copyBallot(pl.commit);
        this.phase = 'EXTERNALIZE';
        break;
      }
      default:
        throw new Error('setStateFromEnvelope: nomination envelope');
    }
  }

  private sortedLatest(): [NodeId, Envelope][] {
    return [...this.latestEnvelopes].sort((a, b) => compareNodeIds(a[0], b[0]));
  }

  /** Calls f for the latest envelope of every node (self only when fully validated, unless forceSelf). */
  processCurrentState(f: (env: Envelope) => boolean, forceSelf: boolean): boolean {
    const local = this.localNodeId();
    for (const [id, env] of this.sortedLatest()) {
      // only return messages for self if the slot is fully validated
      if (forceSelf || id !== local || this.slot.isFullyValidated()) {
        if (!f(env)) return false;
      }
    }
    return true;
  }

  getLatestMessage(id: NodeId): Envelope | null {
    return this.latestEnvelopes.get(id) ?? null;
  }

  /** Latest envelopes of nodes that agree with the externalized value. */
  getExternalizingState(): Envelope[] {
    const res: Envelope[] = [];
    if (this.phase === 'EXTERNALIZE') {
      const local = this.localNodeId();
      for (const [id, env] of this.sortedLatest()) {
        if (id !== local) {
          // good approximation: statements with the value that externalized
          if (areBallotsCompatible(getWorkingBallot(env.statement), this.commit!)) res.push(env);
        } else if (this.slot.isFullyValidated()) {
          // only return messages for self if the slot is fully validated
          res.push(env);
        }
      }
    }
    return res;
  }

  /** Last envelope emitted by this node, or null. */
  getLastMessageSend(): Envelope | null {
    return this.lastEnvelopeEmit;
  }

  /**
   * BrowserChain extension: run advanceSlot again with every latest ballot
   * statement as the hint, as if they had just been received. The attempt*
   * steps are idempotent; used after the local quorum set changed.
   */
  reevaluate(): void {
    for (const [, env] of this.sortedLatest()) {
      if (this.phase === 'EXTERNALIZE') return;
      this.advanceSlot(env.statement);
    }
  }

  // attempts to make progress using the latest statement as a hint
  // calls into the various attempt* methods, emits message
  // to make progress
  private advanceSlot(hint: Statement): void {
    this.currentMessageLevel++;
    let didWork = false;
    try {
      if (this.currentMessageLevel >= MAX_ADVANCE_SLOT_RECURSION) {
        throw new Error('maximum number of transitions reached in advanceSlot');
      }

      // attempt* methods will queue up messages, causing advanceSlot to be
      // called recursively

      // done in order so that we follow the steps from the white paper in
      // order, allowing the state to be updated properly
      didWork = this.attemptAcceptPrepared(hint) || didWork;
      didWork = this.attemptConfirmPrepared(hint) || didWork;
      didWork = this.attemptAcceptCommit(hint) || didWork;
      didWork = this.attemptConfirmCommit(hint) || didWork;

      // only bump after we're done with everything else
      if (this.currentMessageLevel === 1) {
        for (;;) {
          // attemptBump may invoke advanceSlot recursively
          if (this.attemptBump()) didWork = true;
          else break;
        }
        this.checkHeardFromQuorum();
      }
    } finally {
      this.currentMessageLevel--;
    }

    if (didWork) this.sendLatestEnvelope();
  }

  // the minimum validation level of all values in st
  private statementValidationLevel(st: Statement): ValidationLevel {
    const values = getBallotStatementValues(st);
    // This shouldn't happen
    if (values.length === 0) return ValidationLevel.Invalid;

    let lv: ValidationLevel = ValidationLevel.FullyValidated;
    for (const v of values) {
      if (lv > ValidationLevel.Invalid) {
        const tr = this.driver.validateValue(this.slot.slotIndex, v, false);
        lv = Math.min(tr, lv);
      }
    }
    return lv;
  }

  // send latest envelope if needed
  private sendLatestEnvelope(): void {
    // emit current envelope if needed
    if (this.currentMessageLevel === 0 && this.lastEnvelope && this.slot.isFullyValidated()) {
      if (!this.lastEnvelopeEmit || this.lastEnvelope !== this.lastEnvelopeEmit) {
        this.lastEnvelopeEmit = this.lastEnvelope;
        this.driver.emitEnvelope(this.lastEnvelopeEmit);
      }
    }
  }

  private federatedAccept(voted: StatementPredicate, accepted: StatementPredicate): boolean {
    return this.slot.federatedAccept(voted, accepted, this.latestEnvelopes);
  }

  private federatedRatify(voted: StatementPredicate): boolean {
    return this.slot.federatedRatify(voted, this.latestEnvelopes);
  }

  private checkHeardFromQuorum(): void {
    // this method is safe to call regardless of the transitions of the other
    // nodes on the network:
    // we guarantee that other nodes can only transition to higher counters
    // (messages are ignored upstream)
    // therefore the local node will not flip flop between "seen" and "not seen"
    // for a given counter on the local node
    const cur = this.currentBallot;
    if (cur) {
      if (
        isQuorum(
          this.slot.getLocalNode().getQuorumSet(),
          this.latestEnvelopes,
          (st) => this.slot.getQuorumSetFromStatement(st),
          (st) => (st.pledges.type === 'prepare' ? cur.counter <= st.pledges.ballot.counter : true),
        )
      ) {
        const oldHQ = this.heardFromQuorum;
        this.heardFromQuorum = true;
        if (!oldHQ) {
          // if we transition from not heard -> heard, we start the timer
          this.driver.ballotDidHearFromQuorum?.(this.slot.slotIndex, copyBallot(cur));
          if (this.phase !== 'EXTERNALIZE') this.startBallotProtocolTimer();
        }
        if (this.phase === 'EXTERNALIZE') this.stopBallotProtocolTimer();
      } else {
        this.heardFromQuorum = false;
        this.stopBallotProtocolTimer();
      }
    }
  }

  // ---- status

  getPhase(): BallotPhase {
    return this.phase;
  }

  /** The externalized value, or null before EXTERNALIZE. */
  getExternalizedValue(): Value | null {
    return this.phase === 'EXTERNALIZE' && this.commit ? this.commit.value : null;
  }

  getTimerExpCount(): number {
    return this.timerExpCount;
  }

  getInfo(): BallotInfo {
    const c = (b: Ballot | null) => (b ? copyBallot(b) : null);
    return {
      phase: this.phase,
      current: c(this.currentBallot),
      prepared: c(this.prepared),
      preparedPrime: c(this.preparedPrime),
      high: c(this.highBallot),
      commit: c(this.commit),
      valueOverride: this.valueOverride,
      heardFromQuorum: this.heardFromQuorum,
    };
  }

  /** Latest ballot statement per node. */
  getLatestStatements(): ReadonlyMap<NodeId, Envelope> {
    return this.latestEnvelopes;
  }

  /** One-line state for logs, e.g. "i: 5 | PREPARE | b: (1,ab12) | ...". */
  getLocalState(valueString: (v: Value) => string = (v) => v.slice(0, 8)): string {
    const bs = (b: Ballot | null) => (b ? `(${b.counter},${valueString(b.value)})` : '(<null_ballot>)');
    return (
      `i: ${this.slot.slotIndex} | ${this.phase} | b: ${bs(this.currentBallot)} | p: ${bs(this.prepared)}` +
      ` | p': ${bs(this.preparedPrime)} | h: ${bs(this.highBallot)} | c: ${bs(this.commit)}` +
      ` | M: ${this.latestEnvelopes.size}`
    );
  }
}
