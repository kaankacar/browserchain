// Ported from stellar-core (Apache-2.0): src/scp/Slot.cpp
//
// The Slot keeps the SCP state (nomination + ballot protocol) of one slot
// index. Left out: the statement history and JSON dumps (only a count is kept).

import type { SCPDriver } from './driver';
import { BallotProtocol, getBallotStatementValues, getCompanionQuorumSetHashFromStatement, isNewerBallotStatement } from './ballot';
import type { LocalNode } from './localNode';
import { getNominationStatementValues, isNewerNomination, NominationProtocol } from './nomination';
import { compareNodeIds, forAllNodes, isQuorum, isVBlocking, isVBlockingSt, singletonQSet } from './quorum';
import type { SCP } from './scp';
import { EnvelopeState } from './types';
import type { Envelope, Hash, NodeId, NominatePledge, QuorumSet, SlotInfo, Statement, Value } from './types';

export type StatementPredicate = (st: Statement) => boolean;

export class Slot {
  readonly ballotProtocol: BallotProtocol;
  readonly nominationProtocol: NominationProtocol;

  // number of statements recorded for this slot (stellar-core keeps them all)
  private statementCount = 0;

  // true if the Slot was fully validated
  private fullyValidated: boolean;

  // true if we heard from a v-blocking set
  private gotVBlockingFlag = false;

  constructor(
    readonly slotIndex: number,
    private readonly scp: SCP,
  ) {
    this.ballotProtocol = new BallotProtocol(this);
    this.nominationProtocol = new NominationProtocol(this);
    this.fullyValidated = scp.getLocalNode().isValidator();
  }

  getSCP(): SCP {
    return this.scp;
  }

  getSCPDriver(): SCPDriver {
    return this.scp.getDriver();
  }

  getLocalNode(): LocalNode {
    return this.scp.getLocalNode();
  }

  getLatestCompositeCandidate(): Value | null {
    return this.nominationProtocol.getLatestCompositeCandidate();
  }

  /** The latest envelopes this slot emitted (only when fully validated). */
  getLatestMessagesSend(): Envelope[] {
    const res: Envelope[] = [];
    if (this.fullyValidated) {
      const n = this.nominationProtocol.getLastMessageSend();
      if (n) res.push(n);
      const b = this.ballotProtocol.getLastMessageSend();
      if (b) res.push(b);
    }
    return res;
  }

  /** Forces the state to match one of our own envelopes (rebuild after a restart). */
  setStateFromEnvelope(env: Envelope): boolean {
    const st = env.statement;
    if (st.nodeId === this.scp.getLocalNodeId() && st.slotIndex === this.slotIndex) {
      const prev = this.getLatestMessage(st.nodeId) !== null;

      if (st.pledges.type === 'nominate') this.nominationProtocol.setStateFromEnvelope(env);
      else this.ballotProtocol.setStateFromEnvelope(env);

      if (!prev) this.maybeSetGotVBlocking();
      return true;
    }
    return false;
  }

  /** Calls f for all latest messages (nominations first). f returns false to stop. */
  processCurrentState(f: (env: Envelope) => boolean, forceSelf: boolean): void {
    if (this.nominationProtocol.processCurrentState(f, forceSelf)) {
      this.ballotProtocol.processCurrentState(f, forceSelf);
    }
  }

  /** The latest message from a node (ballot first, then nomination), or null. */
  getLatestMessage(id: NodeId): Envelope | null {
    return this.ballotProtocol.getLatestMessage(id) ?? this.nominationProtocol.getLatestMessage(id);
  }

  /** True if newSt replaces oldSt (same kind: nomination or ballot). */
  isNewerNominationOrBallotSt(oldSt: Statement, newSt: Statement): boolean {
    const oldNomination = oldSt.pledges.type === 'nominate';
    const newNomination = newSt.pledges.type === 'nominate';
    if (oldNomination !== newNomination) return false;
    if (oldNomination) {
      return isNewerNomination(oldSt.pledges as NominatePledge, newSt.pledges as NominatePledge);
    }
    return isNewerBallotStatement(oldSt, newSt);
  }

  getExternalizingState(): Envelope[] {
    return this.ballotProtocol.getExternalizingState();
  }

  // records the statement in the historical record for this slot
  recordStatement(_st: Statement): void {
    this.statementCount++;
  }

  /**
   * Process a newly received envelope for this slot. self: true when the
   * node records its own messages (potentially triggering more transitions).
   */
  processEnvelope(envelope: Envelope, self: boolean): EnvelopeState {
    const st = envelope.statement;
    const prev = this.getLatestMessage(st.nodeId) !== null;

    let res: EnvelopeState;
    if (st.pledges.type === 'nominate') res = this.nominationProtocol.processEnvelope(envelope);
    else res = this.ballotProtocol.processEnvelope(envelope, self);

    if (!prev && res === EnvelopeState.VALID) this.maybeSetGotVBlocking();
    return res;
  }

  abandonBallot(): boolean {
    return this.ballotProtocol.abandonBallot(0);
  }

  /**
   * Bumps the ballot based on the local state and the value passed in. With
   * force, always bumps; otherwise only starts the ballot protocol.
   */
  bumpState(value: Value, force: boolean): boolean {
    return this.ballotProtocol.bumpState(value, force);
  }

  // attempts to nominate a value for consensus
  nominate(value: Value, previousValue: Value, timedout: boolean): boolean {
    return this.nominationProtocol.nominate(value, previousValue, timedout);
  }

  stopNomination(): void {
    this.nominationProtocol.stopNomination();
  }

  getNominationLeaders(): NodeId[] {
    return this.nominationProtocol.getLeaders();
  }

  isFullyValidated(): boolean {
    return this.fullyValidated;
  }

  setFullyValidated(fullyValidated: boolean): void {
    this.fullyValidated = fullyValidated;
  }

  getStatementCount(): number {
    return this.statementCount;
  }

  gotVBlocking(): boolean {
    return this.gotVBlockingFlag;
  }

  /** Hash of the quorum set sent with the statement (commit qset hash for EXTERNALIZE). */
  static getCompanionQuorumSetHashFromStatement(st: Statement): Hash {
    return getCompanionQuorumSetHashFromStatement(st);
  }

  /** The values associated with the statement. */
  static getStatementValues(st: Statement): Value[] {
    return st.pledges.type === 'nominate' ? getNominationStatementValues(st) : getBallotStatementValues(st);
  }

  /**
   * The quorum set to use for the statement's node (singleton for
   * EXTERNALIZE), or null if unknown. Our own recent local sets resolve
   * without the driver; everything else comes from driver.getQSet.
   */
  getQuorumSetFromStatement(st: Statement): QuorumSet | null {
    if (st.pledges.type === 'externalize') return singletonQSet(st.nodeId);
    const hash = st.pledges.quorumSetHash;
    return this.getLocalNode().getQuorumSetByHash(hash) ?? this.getSCPDriver().getQSet(hash);
  }

  /** Wraps a statement in a signed envelope from the local node. */
  createEnvelope(statement: Statement): Envelope {
    const envelope: Envelope = {
      statement: { ...statement, nodeId: this.scp.getLocalNodeId(), slotIndex: this.slotIndex },
      signature: '',
    };
    this.getSCPDriver().signEnvelope(envelope);
    return envelope;
  }

  // ** federated agreement helper functions

  /** True if the statement defined by voted and accepted should be accepted. */
  federatedAccept(voted: StatementPredicate, accepted: StatementPredicate, envs: ReadonlyMap<NodeId, Envelope>): boolean {
    const qSet = this.getLocalNode().getQuorumSet();

    // Checks if the nodes that claimed to accept the statement form a
    // v-blocking set
    if (isVBlockingSt(qSet, envs, accepted)) return true;

    // Checks if the set of nodes that accepted or voted for it form a quorum
    const ratifyFilter = (st: Statement) => accepted(st) || voted(st);

    return isQuorum(qSet, envs, (st) => this.getQuorumSetFromStatement(st), ratifyFilter);
  }

  /** True if the statement defined by voted is ratified. */
  federatedRatify(voted: StatementPredicate, envs: ReadonlyMap<NodeId, Envelope>): boolean {
    return isQuorum(this.getLocalNode().getQuorumSet(), envs, (st) => this.getQuorumSetFromStatement(st), voted);
  }

  /** All latest envelopes, including our own even if not fully validated. */
  getEntireCurrentState(): Envelope[] {
    const res: Envelope[] = [];
    this.processCurrentState((e) => {
      res.push(e);
      return true;
    }, true);
    return res;
  }

  /**
   * BrowserChain extension: re-run the protocol steps over the statements we
   * already have (after a local quorum set change).
   */
  reevaluate(): void {
    this.nominationProtocol.reevaluate();
    this.ballotProtocol.reevaluate();
    this.maybeSetGotVBlocking();
  }

  private maybeSetGotVBlocking(): void {
    // was already set
    if (this.gotVBlockingFlag) return;

    const nodes: NodeId[] = [];
    const qSet = this.getLocalNode().getQuorumSet();

    forAllNodes(qSet, (id) => {
      if (this.getLatestMessage(id) !== null) nodes.push(id);
      return true;
    });

    this.gotVBlockingFlag = isVBlocking(qSet, nodes);
  }

  /** Read-only view for monitoring and the UI. */
  getInfo(): SlotInfo {
    const nomInfo = this.nominationProtocol.getInfo();
    const ballotInfo = this.ballotProtocol.getInfo();

    const noms = this.nominationProtocol.getLatestStatements();
    const ballots = this.ballotProtocol.getLatestStatements();
    const ids = new Set<NodeId>([...noms.keys(), ...ballots.keys()]);
    // copies: callers must not be able to change protocol state
    const copy = (e: Envelope | undefined): Statement | null => (e ? structuredClone(e.statement) : null);
    const latestStatements = [...ids].sort(compareNodeIds).map((nodeId) => ({
      nodeId,
      nomination: copy(noms.get(nodeId)),
      ballot: copy(ballots.get(nodeId)),
    }));

    return {
      slotIndex: this.slotIndex,
      fullyValidated: this.fullyValidated,
      nomination: nomInfo,
      ballot: ballotInfo,
      latestStatements,
      externalizedValue: this.ballotProtocol.getExternalizedValue(),
    };
  }
}
