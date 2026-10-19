// Ported from stellar-core (Apache-2.0): src/scp/NominationProtocol.cpp
//
// Left out (newer stellar-core features): upgrade stripping after too many
// timeouts, the delayed-emit test timer, JSON info and quorum-state reporting.
// "Structurally valid" checks map to FullyValidated (classic behavior).

import { compareNodeIds, forAllNodes, getNodeWeight as defaultNodeWeight, isQuorumSetSane, normalizeQSet } from './quorum';
import type { Slot } from './slot';
import { EnvelopeState, TIMER_NOMINATION, ValidationLevel } from './types';
import type { Envelope, NodeId, NominatePledge, QuorumSet, Statement, Value } from './types';

const sortValues = (values: Iterable<Value>): Value[] => [...values].sort();

// returns { res: p is a subset of v, notEqual: p and v differ }
// (p and v are expected to be sorted)
function isSubsetHelper(p: readonly Value[], v: readonly Value[]): { res: boolean; notEqual: boolean } {
  if (p.length <= v.length) {
    const vs = new Set(v);
    const res = p.every((x) => vs.has(x));
    return { res, notEqual: res ? p.length !== v.length : true };
  }
  return { res: false, notEqual: true };
}

/** NominationProtocol::isNewerStatement: true only if one of the sets grew. */
export function isNewerNomination(oldst: NominatePledge, st: NominatePledge): boolean {
  let res = false;
  const a = isSubsetHelper(oldst.votes, st.votes);
  if (a.res) {
    let grows = a.notEqual;
    const b = isSubsetHelper(oldst.accepted, st.accepted);
    if (b.res) {
      grows = grows || b.notEqual;
      res = grows; //  true only if one of the sets grew
    }
  }
  return res;
}

function isStrictlySorted(values: readonly Value[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i - 1] < values[i])) return false;
  }
  return true;
}

// Votes and accepted values of a statement as sets, so that the federated
// voting predicates are O(1): with Array.includes, one peer nomination with
// n values cost O(n^2) (20,000 values took seconds). Statements are never
// modified once received or created.
const valueSets = new WeakMap<NominatePledge, { votes: ReadonlySet<Value>; accepted: ReadonlySet<Value> }>();

function setsOf(nom: NominatePledge): { votes: ReadonlySet<Value>; accepted: ReadonlySet<Value> } {
  let s = valueSets.get(nom);
  if (s === undefined) {
    s = { votes: new Set(nom.votes), accepted: new Set(nom.accepted) };
    valueSets.set(nom, s);
  }
  return s;
}

// returns true if v is in the accepted list from the statement
function acceptPredicate(v: Value, st: Statement): boolean {
  return setsOf(st.pledges as NominatePledge).accepted.has(v);
}

// returns true if v is in the voted list from the statement
function votePredicate(v: Value, st: Statement): boolean {
  return setsOf(st.pledges as NominatePledge).votes.has(v);
}

/** All values of a nomination: votes, then accepted values not in votes. */
export function getNominationStatementValues(st: Statement): Value[] {
  const nom = st.pledges as NominatePledge;
  const res = [...nom.votes];
  const votes = setsOf(nom).votes;
  // NB: "accepted" should be a subset of "votes", so this should no-op
  for (const a of nom.accepted) {
    if (!votes.has(a)) res.push(a);
  }
  return res;
}

/** Nomination state of one slot. */
export interface NominationInfo {
  started: boolean;
  roundNumber: number;
  votes: Value[];
  accepted: Value[];
  candidates: Value[];
  roundLeaders: NodeId[];
  latestCompositeCandidate: Value | null;
}

export class NominationProtocol {
  private roundNumber = 0;

  private readonly votes = new Set<Value>(); // X
  private readonly accepted = new Set<Value>(); // Y
  private readonly candidates = new Set<Value>(); // Z
  private readonly latestNominations = new Map<NodeId, Envelope>(); // N

  private lastEnvelope: Envelope | null = null; // last envelope emitted by this node

  // nodes from quorum set that have the highest priority this round
  private readonly roundLeaders = new Set<NodeId>();

  // true if 'nominate' was called
  private nominationStarted = false;

  // the latest (if any) candidate value
  private latestCompositeCandidate: Value | null = null;

  // the value from the previous slot
  private previousValue: Value = '';

  // the value given to the latest nominate() call (our own value)
  private value: Value | null = null;

  // The number of times the timer has expired
  private timerExpCount = 0;

  constructor(private readonly slot: Slot) {}

  private get driver() {
    return this.slot.getSCPDriver();
  }

  private isNewerStatementFor(nodeId: NodeId, st: NominatePledge): boolean {
    const oldp = this.latestNominations.get(nodeId);
    return oldp === undefined ? true : isNewerNomination(oldp.statement.pledges as NominatePledge, st);
  }

  private validateValue(v: Value): ValidationLevel {
    return this.driver.validateValue(this.slot.slotIndex, v, true);
  }

  private extractValidValue(value: Value): Value | null {
    return this.driver.extractValidValue(this.slot.slotIndex, value);
  }

  // Sorted, non-empty votes/accepted. Also requires a known, sane quorum set
  // (stellar-core leaves that to the herder; ARCHITECTURE asks SCP to check).
  private isSane(st: Statement): boolean {
    const nom = st.pledges as NominatePledge;
    let res = nom.votes.length + nom.accepted.length !== 0;
    res = res && isStrictlySorted(nom.votes);
    res = res && isStrictlySorted(nom.accepted);
    if (res) {
      const qSet = this.slot.getQuorumSetFromStatement(st);
      res = qSet !== null && isQuorumSetSane(qSet, false);
    }
    return res;
  }

  // only called after a call to isNewerStatement so safe to replace the
  // latest nomination
  private recordEnvelope(env: Envelope): void {
    this.latestNominations.set(env.statement.nodeId, env);
    this.slot.recordStatement(env.statement);
  }

  private emitNomination(): void {
    const local = this.slot.getLocalNode();
    const st: Statement = {
      nodeId: local.getNodeId(),
      slotIndex: this.slot.slotIndex,
      pledges: {
        type: 'nominate',
        quorumSetHash: local.getQuorumSetHash(),
        votes: sortValues(this.votes),
        accepted: sortValues(this.accepted),
      },
    };

    const envelope = this.slot.createEnvelope(st);

    if (this.slot.processEnvelope(envelope, true) === EnvelopeState.VALID) {
      if (
        !this.lastEnvelope ||
        isNewerNomination(this.lastEnvelope.statement.pledges as NominatePledge, envelope.statement.pledges as NominatePledge)
      ) {
        this.lastEnvelope = envelope;
        if (this.slot.isFullyValidated()) this.driver.emitEnvelope(envelope);
      }
    } else {
      // there is a bug in the application if it queued up
      // a statement for itself that it considers invalid
      throw new Error('moved to a bad state (nomination)');
    }
  }

  private nodeWeight(nodeId: NodeId, qset: QuorumSet, isLocalNode: boolean): bigint {
    const d = this.driver;
    return d.getNodeWeight ? d.getNodeWeight(nodeId, qset, isLocalNode) : defaultNodeWeight(nodeId, qset, isLocalNode);
  }

  // updates the set of nodes that have priority over the others
  private updateRoundLeaders(): void {
    const localID = this.slot.getLocalNode().getNodeId();
    const myQSet = normalizeQSet(this.slot.getLocalNode().getQuorumSet(), localID); // excludes self

    // Count potential leaders: only include nodes with non-zero weight,
    // as nodes with weight 0 can never be elected as round leaders.
    let maxLeaderCount = 0;
    if (this.nodeWeight(localID, myQSet, true) > 0n) ++maxLeaderCount;
    forAllNodes(myQSet, (cur) => {
      if (this.nodeWeight(cur, myQSet, false) > 0n) ++maxLeaderCount;
      return true;
    });

    // Cap the number of iterations to prevent infinite loops if something has
    // gone wrong
    let iterationsRemaining = 1000;
    while (this.roundLeaders.size < maxLeaderCount) {
      // initialize priority with value derived from self
      const newRoundLeaders = new Set<NodeId>();

      newRoundLeaders.add(localID);
      let topPriority = this.getNodePriority(localID, myQSet);

      forAllNodes(myQSet, (cur) => {
        const w = this.getNodePriority(cur, myQSet);
        if (w > topPriority) {
          topPriority = w;
          newRoundLeaders.clear();
        }
        if (w === topPriority && w > 0n) newRoundLeaders.add(cur);
        return true;
      });

      if (topPriority === 0n) {
        // No one had priority, so all nodes would choose themselves
        // resulting in a timeout. Clear newRoundLeaders, allowing the
        // algorithm to fast timeout and try again.
        newRoundLeaders.clear();
      }

      // expand roundLeaders with the newly computed leaders
      const oldSize = this.roundLeaders.size;
      for (const l of newRoundLeaders) this.roundLeaders.add(l);
      if (oldSize !== this.roundLeaders.size) return;

      // fast timeout (would no op)
      this.roundNumber++;

      --iterationsRemaining;
      if (iterationsRemaining <= 0) throw new Error('updateRoundLeaders appears to be stuck in an infinite loop');
    }
  }

  // computes Gi(isPriority?P:N, prevValue, roundNumber, nodeID) from the paper
  private hashNode(isPriority: boolean, nodeId: NodeId): bigint {
    return this.driver.computeHashNode(this.slot.slotIndex, this.previousValue, isPriority, this.roundNumber, nodeId);
  }

  // computes Gi(K, prevValue, roundNumber, value)
  private hashValue(value: Value): bigint {
    return this.driver.computeValueHash(this.slot.slotIndex, this.previousValue, this.roundNumber, value);
  }

  private getNodePriority(nodeId: NodeId, qset: QuorumSet): bigint {
    const w = this.nodeWeight(nodeId, qset, nodeId === this.slot.getLocalNode().getNodeId());

    // if w > 0; w is inclusive here as
    // 0 <= hashNode <= UINT64_MAX
    if (w > 0n && this.hashNode(false, nodeId) <= w) return this.hashNode(true, nodeId);
    return 0n;
  }

  // returns the highest value that we don't have yet, that we should
  // vote for, extracted from a nomination.
  // returns null if no new value was found
  private getNewValueFromNomination(nom: NominatePledge): Value | null {
    // pick the highest value we don't have from the leader
    // sorted using hashValue.
    let newVote: Value | null = null;
    let newHash = 0n;
    let foundValidValue = false;

    const pickValue = (value: Value) => {
      let valueToNominate: Value | null;
      const vl = this.validateValue(value);
      if (vl >= ValidationLevel.FullyValidated) valueToNominate = value;
      else valueToNominate = this.extractValidValue(value);

      if (valueToNominate !== null) {
        foundValidValue = true;
        if (!this.votes.has(valueToNominate)) {
          const curHash = this.hashValue(valueToNominate);
          if (curHash >= newHash) {
            newHash = curHash;
            newVote = valueToNominate;
          }
        }
      }
    };

    for (const val of nom.accepted) pickValue(val);

    // Move on to votes if we have not found a valid accepted value
    if (!foundValidValue) {
      for (const val of nom.votes) pickValue(val);
    }

    return newVote;
  }

  processEnvelope(envelope: Envelope): EnvelopeState {
    const st = envelope.statement;
    const nom = st.pledges as NominatePledge;

    if (!this.isNewerStatementFor(st.nodeId, nom)) return EnvelopeState.INVALID;

    if (!this.isSane(st)) return EnvelopeState.INVALID;

    this.recordEnvelope(envelope);

    // Ensure node doesn't vote on future slots
    if (this.nominationStarted) {
      // tracks if we should emit a new nomination message
      // attempts to promote some of the votes to accepted
      let modified = this.promoteVotesToAccepted(nom.votes);

      // attempts to promote accepted values to candidates
      const newCandidates = this.promoteAcceptedToCandidates();

      // only take round leader votes if we're still looking for
      // candidates
      if (this.candidates.size === 0 && this.roundLeaders.has(st.nodeId)) {
        const newVote = this.getNewValueFromNomination(nom);
        if (newVote !== null) {
          this.votes.add(newVote);
          modified = true;
          this.driver.nominatingValue?.(this.slot.slotIndex, newVote);
        }
      }

      if (modified) this.emitNomination();

      if (newCandidates) this.updateCompositeCandidate();
    }
    return EnvelopeState.VALID;
  }

  // part of processEnvelope: federated accept of the given votes
  private promoteVotesToAccepted(votes: readonly Value[]): boolean {
    let modified = false;
    for (const v of votes) {
      if (this.accepted.has(v)) continue; // v is already accepted

      if (
        this.slot.federatedAccept(
          (s) => votePredicate(v, s),
          (s) => acceptPredicate(v, s),
          this.latestNominations,
        )
      ) {
        const vl = this.validateValue(v);
        if (vl >= ValidationLevel.FullyValidated) {
          this.accepted.add(v);
          this.votes.add(v);
          modified = true;
        } else {
          // the value made it pretty far:
          // see if we can vote for a variation that
          // we consider valid
          const toVote = this.extractValidValue(v);
          if (toVote !== null && !this.votes.has(toVote)) {
            this.votes.add(toVote);
            modified = true;
          }
        }
      }
    }
    return modified;
  }

  // part of processEnvelope: federated ratify of the accepted values
  private promoteAcceptedToCandidates(): boolean {
    let newCandidates = false;
    for (const a of sortValues(this.accepted)) {
      if (this.candidates.has(a)) continue;
      if (this.slot.federatedRatify((s) => acceptPredicate(a, s), this.latestNominations)) {
        this.candidates.add(a);
        newCandidates = true;
        // Stop the timer, as there's no need to continue nominating,
        // per the whitepaper:
        // "As soon as `v` has a candidate value, however, it must cease
        // voting to nominate `x` for any new values `x`"
        this.driver.stopTimer(this.slot.slotIndex, TIMER_NOMINATION);
      }
    }
    return newCandidates;
  }

  private updateCompositeCandidate(): void {
    const composite = this.driver.combineCandidates(this.slot.slotIndex, sortValues(this.candidates));
    if (composite !== null) {
      this.latestCompositeCandidate = composite;
      this.driver.updatedCandidateValue?.(this.slot.slotIndex, composite);
      this.slot.bumpState(composite, false);
    }
  }

  /**
   * BrowserChain extension, used after the local quorum set changed. Round
   * leaders come from the quorum set, so they are computed again for the
   * current round. (stellar-core never changes the set inside a slot, so its
   * leader set only grows. Here departed leaders would stay and could block
   * nomination for good.) Then the accept / ratify steps run over the latest
   * nominations as if they had just been received, and the new leaders are
   * echoed right away.
   */
  reevaluate(): void {
    if (this.roundNumber > 0) {
      this.roundLeaders.clear();
      this.updateRoundLeaders();
    }
    if (!this.nominationStarted) return;
    const values = new Set<Value>();
    for (const env of this.latestNominations.values()) {
      for (const v of (env.statement.pledges as NominatePledge).votes) values.add(v);
    }
    let modified = this.promoteVotesToAccepted(sortValues(values));
    const newCandidates = this.promoteAcceptedToCandidates();
    if (this.candidates.size === 0 && this.value !== null) modified = this.voteForLeaders(this.value) || modified;
    if (modified) this.emitNomination();
    if (newCandidates) this.updateCompositeCandidate();
  }

  // NominationProtocol::nominate: take a new value from every round leader,
  // and vote for our own value if we lead and have no votes yet
  private voteForLeaders(value: Value): boolean {
    let updated = false;

    // add a few more values from other leaders
    for (const leader of [...this.roundLeaders].sort(compareNodeIds)) {
      const env = this.latestNominations.get(leader);
      if (env) {
        const lnmV = this.getNewValueFromNomination(env.statement.pledges as NominatePledge);
        if (lnmV !== null) {
          this.votes.add(lnmV);
          updated = true;
          this.driver.nominatingValue?.(this.slot.slotIndex, lnmV);
        }
      }
    }

    // Check if we are a leader for this round
    if (this.roundLeaders.has(this.slot.getLocalNode().getNodeId())) {
      // Add our value if we haven't added any votes yet.
      // (Upgrade stripping after too many timeouts is left out.)
      if (this.votes.size === 0) {
        if (!this.votes.has(value)) {
          this.votes.add(value);
          updated = true;
          this.driver.nominatingValue?.(this.slot.slotIndex, value);
        }
      }
    }
    return updated;
  }

  // attempts to nominate a value for consensus
  nominate(value: Value, previousValue: Value, timedout: boolean): boolean {
    // No need to continue nominating, as per the whitepaper:
    // "As soon as `v` has a candidate value, however, it must cease
    // voting to nominate `x` for any new values `x`"
    if (this.candidates.size > 0) return false;

    if (timedout) this.timerExpCount++;

    if (timedout && !this.nominationStarted) return false;

    // BrowserChain (restart): votes held before the first nominate() come only
    // from setStateFromEnvelope. The statements recorded since then were never
    // evaluated (processEnvelope waits for nomination to start), and the
    // restored votes may already hold every value the leaders offer: nothing
    // new is voted or emitted, and the slot can stall for good. So run the
    // accept / ratify steps over them once, as if they had just arrived.
    const restored = !this.nominationStarted && this.votes.size > 0;

    this.nominationStarted = true;

    this.previousValue = previousValue;
    this.value = value;

    this.roundNumber++;
    this.updateRoundLeaders();

    const timeout = this.driver.computeTimeout(this.roundNumber, true);

    let updated = false;
    let newCandidates = false;
    if (restored) {
      const values = new Set<Value>();
      for (const env of this.latestNominations.values()) {
        for (const v of (env.statement.pledges as NominatePledge).votes) values.add(v);
      }
      updated = this.promoteVotesToAccepted(sortValues(values));
      newCandidates = this.promoteAcceptedToCandidates();
    }

    if (this.candidates.size === 0) {
      updated = this.voteForLeaders(value) || updated;

      // BrowserChain: our latest nomination can carry an older quorum set, for
      // example a restored one when the set changed before this slot's
      // nomination started. Peers take a new set only from a strictly newer
      // statement, so when nothing else is new, vote our own value to announce it.
      if (!updated && this.lastNominationHasOldQSet() && !this.votes.has(value)) {
        if (this.validateValue(value) >= ValidationLevel.FullyValidated) {
          this.votes.add(value);
          updated = true;
          this.driver.nominatingValue?.(this.slot.slotIndex, value);
        }
      }

      this.driver.setupTimer(this.slot.slotIndex, TIMER_NOMINATION, timeout, () =>
        this.slot.nominate(value, previousValue, true),
      );
    }

    if (updated) this.emitNomination();

    if (newCandidates) this.updateCompositeCandidate();

    return updated;
  }

  // true if our latest nomination carries another quorum set than our current one
  private lastNominationHasOldQSet(): boolean {
    const last = this.lastEnvelope;
    if (last === null) return false;
    return (last.statement.pledges as NominatePledge).quorumSetHash !== this.slot.getLocalNode().getQuorumSetHash();
  }

  // stops the nomination protocol
  stopNomination(): void {
    this.nominationStarted = false;
  }

  /**
   * BrowserChain extension (not in stellar-core): vote for `value` even when
   * we are not a round leader and emit the resulting newer nomination. Peers
   * only take a node's new quorum set from a strictly newer statement, so this
   * lets a changed local quorum set reach them while nomination is stuck.
   * Nomination votes do not affect safety. Returns false (and does nothing)
   * when nomination has not started, a candidate exists, the value is already
   * voted for or it is not fully valid.
   */
  addVote(value: Value): boolean {
    if (!this.nominationStarted || this.candidates.size > 0) return false;
    if (this.votes.has(value)) return false;
    if (this.validateValue(value) < ValidationLevel.FullyValidated) return false;
    this.votes.add(value);
    this.driver.nominatingValue?.(this.slot.slotIndex, value);
    this.emitNomination();
    return true;
  }

  /** The current round leaders, in node id order. */
  getLeaders(): NodeId[] {
    return [...this.roundLeaders].sort(compareNodeIds);
  }

  getLatestCompositeCandidate(): Value | null {
    return this.latestCompositeCandidate;
  }

  getLastMessageSend(): Envelope | null {
    return this.lastEnvelope;
  }

  /** Force the state to match one of our own nominations (restore after restart). */
  setStateFromEnvelope(e: Envelope): void {
    if (this.nominationStarted) throw new Error('Cannot set state after nomination is started');
    this.recordEnvelope(e);
    const nom = e.statement.pledges as NominatePledge;
    for (const a of nom.accepted) this.accepted.add(a);
    for (const v of nom.votes) this.votes.add(v);
    this.lastEnvelope = e;
  }

  /** Calls f for the latest nomination of every node (self only when fully validated, unless forceSelf). */
  processCurrentState(f: (env: Envelope) => boolean, forceSelf: boolean): boolean {
    const local = this.slot.getLocalNode().getNodeId();
    const entries = [...this.latestNominations].sort((a, b) => compareNodeIds(a[0], b[0]));
    for (const [id, env] of entries) {
      // only return messages for self if the slot is fully validated
      if (forceSelf || id !== local || this.slot.isFullyValidated()) {
        if (!f(env)) return false;
      }
    }
    return true;
  }

  getLatestMessage(id: NodeId): Envelope | null {
    return this.latestNominations.get(id) ?? null;
  }

  /** Latest nomination per node. */
  getLatestStatements(): ReadonlyMap<NodeId, Envelope> {
    return this.latestNominations;
  }

  isStarted(): boolean {
    return this.nominationStarted;
  }

  getRoundNumber(): number {
    return this.roundNumber;
  }

  getTimerExpCount(): number {
    return this.timerExpCount;
  }

  getInfo(): NominationInfo {
    return {
      started: this.nominationStarted,
      roundNumber: this.roundNumber,
      votes: sortValues(this.votes),
      accepted: sortValues(this.accepted),
      candidates: sortValues(this.candidates),
      roundLeaders: this.getLeaders(),
      latestCompositeCandidate: this.latestCompositeCandidate,
    };
  }
}
