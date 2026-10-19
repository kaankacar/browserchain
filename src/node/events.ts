// Events of the Node class. A NodeService maps them to NodeApi events
// (see views.ts for the view builders).

import type { LogEntry } from '../lib/log';
import type { LedgerCloseResult } from '../ledger/types';
import type { PeerInfo } from '../overlay/types';
import type { QuorumSet } from '../scp/types';
import type { StoredLedger, StoredTx } from '../storage/types';
import type { ScpEnvelopeEvent, TxStatusEvent } from '../herder/types';
import type { QuorumMode } from '../herder/quorumManager';
import type { ForkInfo, SyncState } from './api';

export type NodeEvents = {
  /** Lifecycle state changed. */
  state: { state: SyncState; previous: SyncState };
  /**
   * A ledger was closed and persisted. source 'consensus': SCP externalized
   * it here; 'catchup': replayed from a peer (externalizedBy is 0).
   */
  ledgerClosed: {
    result: LedgerCloseResult;
    stored: StoredLedger;
    txs: StoredTx[];
    source: 'consensus' | 'catchup';
  };
  /** An SCP envelope was received (signature checked) or emitted. */
  scpEnvelope: ScpEnvelopeEvent;
  /** SCP state of a slot changed (use Node.getScpSlot to build the view). */
  slot: { slot: number };
  /** Connected peers changed (connect, disconnect, or a newer status). */
  peers: { peers: PeerInfo[] };
  txStatus: TxStatusEvent;
  fork: ForkInfo;
  /** The local quorum set changed. */
  quorum: { qset: QuorumSet; hash: string; mode: QuorumMode; reason: string };
  /** Catch-up progress; null when catch-up ended. `blocked`: why this node waits without voting. */
  catchup: { target: number; current: number; source: string | null; blocked?: string } | null;
  /** The ledger was replaced (rollback, resync, snapshot): cached views are stale. */
  ledgerReset: { lclSeq: number; reason: string };
  log: LogEntry;
};
