// Core SCP types. These mirror Stellar-SCP.x, but use plain TS values:
// - NodeId: StrKey public key ("G...").
// - Hash: lowercase hex SHA-256.
// - Value: lowercase hex of the opaque value bytes. String order of equal or
//   different length lowercase hex strings equals byte order of the values,
//   so values can be compared with < and used as Map/Set keys.
// Wire conversion to/from the SDK xdr.ScpEnvelope lives in ./xdr.ts.

export type NodeId = string;
export type Hash = string;
export type Value = string;

export interface QuorumSet {
  threshold: number;
  validators: NodeId[];
  innerSets: QuorumSet[];
}

export interface Ballot {
  counter: number; // uint32
  value: Value;
}

export interface NominatePledge {
  type: 'nominate';
  quorumSetHash: Hash;
  votes: Value[]; // sorted, unique
  accepted: Value[]; // sorted, unique
}

export interface PreparePledge {
  type: 'prepare';
  quorumSetHash: Hash;
  ballot: Ballot;
  prepared: Ballot | null;
  preparedPrime: Ballot | null;
  nC: number;
  nH: number;
}

export interface ConfirmPledge {
  type: 'confirm';
  ballot: Ballot;
  nPrepared: number;
  nCommit: number;
  nH: number;
  quorumSetHash: Hash;
}

export interface ExternalizePledge {
  type: 'externalize';
  commit: Ballot;
  nH: number;
  commitQuorumSetHash: Hash;
}

export type Pledges = NominatePledge | PreparePledge | ConfirmPledge | ExternalizePledge;
export type StatementType = Pledges['type'];

export interface Statement {
  nodeId: NodeId;
  slotIndex: number; // uint64 on the wire; ledger sequence numbers fit in a JS number
  pledges: Pledges;
}

export interface Envelope {
  statement: Statement;
  signature: string; // hex, 64 bytes
}

export enum EnvelopeState {
  INVALID = 0,
  VALID = 1,
}

/** Result of SCPDriver.validateValue (classic stellar-core levels). */
export enum ValidationLevel {
  Invalid = 0,
  /** Cannot be fully checked now (e.g. value is for a slot other than LCL+1). */
  MaybeValid = 1,
  FullyValidated = 2,
}

export type BallotPhase = 'PREPARE' | 'CONFIRM' | 'EXTERNALIZE';

export const TIMER_NOMINATION = 0;
export const TIMER_BALLOT = 1;

/** Read-only view of a slot, for monitoring and the UI. */
export interface SlotInfo {
  slotIndex: number;
  fullyValidated: boolean;
  nomination: {
    started: boolean;
    roundNumber: number;
    votes: Value[];
    accepted: Value[];
    candidates: Value[];
    roundLeaders: NodeId[];
    latestCompositeCandidate: Value | null;
  };
  ballot: {
    phase: BallotPhase;
    current: Ballot | null; // b
    prepared: Ballot | null; // p
    preparedPrime: Ballot | null; // p'
    high: Ballot | null; // h
    commit: Ballot | null; // c
    valueOverride: Value | null; // z
    heardFromQuorum: boolean;
  };
  /** Latest statement per node (nomination and ballot), newest wins. */
  latestStatements: { nodeId: NodeId; nomination: Statement | null; ballot: Statement | null }[];
  externalizedValue: Value | null;
}
