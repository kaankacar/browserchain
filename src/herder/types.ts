// Types shared inside the herder module and with the node.

import type { ILedgerManager, LedgerCloseResult } from '../ledger/types';
import type { PeerInfo, RequestBody, ResponseBody } from '../overlay/types';
import type { Envelope, QuorumSet, StatementType } from '../scp/types';

export type TxStatus = 'pending' | 'applied' | 'failed' | 'dropped';

/** What the herder needs from the overlay. IOverlay satisfies it. */
export interface HerderNet {
  floodStellar(xdrB64: string, opts?: { exceptNodeId?: string }): void;
  sendStellar(nodeId: string, xdrB64: string): void;
  request(nodeId: string, body: RequestBody, timeoutMs?: number): Promise<ResponseBody>;
  peers(): PeerInfo[];
}

/** How a ledger got closed. */
export interface CloseMeta {
  /** 'consensus': SCP externalized it here; 'catchup': replayed from a peer. */
  source: 'consensus' | 'catchup';
  /** Distinct validators seen with CONFIRM or EXTERNALIZE for the slot (0 when replayed). */
  externalizedBy: number;
}

/** Callbacks from the herder to its owner (the node). */
export interface HerderHost {
  /** The current ledger manager (it may be replaced after a rollback). */
  ledger(): ILedgerManager;
  /** A ledger was closed through consensus. The host persists it and calls Herder.afterLedgerClosed. */
  ledgerClosed(result: LedgerCloseResult, meta: CloseMeta): void;
  /** SCP traffic shows that the network is ahead of us. */
  behind(info: { slot: number; nodes: string[] }): void;
  /** SCP externalized a value for a slot we closed with another value (a fork). */
  externalizedMismatch(slot: number, value: string): void;
  /** Display name of a node. */
  nodeName(nodeId: string): string;
}

export interface ScpEnvelopeEvent {
  direction: 'in' | 'out';
  ts: number;
  slot: number;
  /** Node that signed the statement. */
  nodeId: string;
  name: string;
  type: StatementType;
  envelope: Envelope;
  /** Peer the envelope arrived from (direction 'in'), else null. */
  via: string | null;
}

export interface TxStatusEvent {
  hash: string;
  status: TxStatus;
  ledgerSeq?: number;
  resultCode?: string;
}

export type HerderEvents = {
  /** An SCP envelope was received (signature checked) or emitted. */
  envelope: ScpEnvelopeEvent;
  /** SCP state of a slot changed. */
  slot: { slot: number };
  txStatus: TxStatusEvent;
  /** The local quorum set changed. */
  quorum: { qset: QuorumSet; hash: string; reason: string };
  /** SCP externalized a value (the ledger closes right after). */
  externalized: { slot: number; value: string };
};
