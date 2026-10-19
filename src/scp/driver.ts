// The SCP driver: everything SCP needs from its host (the herder).
// Port of the classic stellar-core SCPDriver (src/scp/SCPDriver.h), minus
// newer features (parallel tx set download, empty tx set values, upgrade
// stripping, nomination timeout limits).

import type { Ballot, Envelope, Hash, NodeId, QuorumSet, Value, ValidationLevel } from './types';

export interface SCPDriver {
  /** Fill env.signature over the statement (see ./xdr.ts statementSignaturePayload). */
  signEnvelope(env: Envelope): void;

  /** Quorum set by hash, or null if unknown (the statement is then ignored). */
  getQSet(hash: Hash): QuorumSet | null;

  /** Flood a locally generated envelope to the network. */
  emitEnvelope(env: Envelope): void;

  /** Check a value. Nomination validation may be stricter than ballot validation. */
  validateValue(slotIndex: number, value: Value, nomination: boolean): ValidationLevel;

  /** Turn a not-fully-valid value into one we would vote for, or null. */
  extractValidValue(slotIndex: number, value: Value): Value | null;

  /** Composite value from the confirmed candidates (given sorted ascending). */
  combineCandidates(slotIndex: number, candidates: Value[]): Value | null;

  /**
   * Nomination hashes, used for leader selection and value ordering. Returns
   * a uint64 as bigint. Default implementations live in ./hash.ts.
   */
  computeHashNode(slotIndex: number, prev: Value, isPriority: boolean, roundNumber: number, nodeId: NodeId): bigint;
  computeValueHash(slotIndex: number, prev: Value, roundNumber: number, value: Value): bigint;

  /** Timeout in ms for a nomination round or ballot counter. */
  computeTimeout(roundNumber: number, isNomination: boolean): number;

  /** Start (cb non-null) or cancel (cb null) a timer. One timer per (slot, timerId). */
  setupTimer(slotIndex: number, timerId: number, timeoutMs: number, cb: (() => void) | null): void;
  stopTimer(slotIndex: number, timerId: number): void;

  /** Optional override of the node weight (0..2^64-1) used by nomination. */
  getNodeWeight?(nodeId: NodeId, qset: QuorumSet, isLocalNode: boolean): bigint;

  // Notifications (all optional).
  valueExternalized?(slotIndex: number, value: Value): void;
  nominatingValue?(slotIndex: number, value: Value): void;
  updatedCandidateValue?(slotIndex: number, value: Value): void;
  startedBallotProtocol?(slotIndex: number, ballot: Ballot): void;
  acceptedBallotPrepared?(slotIndex: number, ballot: Ballot): void;
  confirmedBallotPrepared?(slotIndex: number, ballot: Ballot): void;
  acceptedCommit?(slotIndex: number, ballot: Ballot): void;
  ballotDidHearFromQuorum?(slotIndex: number, ballot: Ballot): void;

  // Debug helpers (optional).
  getValueString?(value: Value): string;
  toShortString?(nodeId: NodeId): string;
}
