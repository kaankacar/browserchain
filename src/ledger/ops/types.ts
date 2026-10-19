// Shared types for operation implementations.

import type { OpResult } from '../results';
import type { ThresholdLevel } from '../signatures';
import type { LedgerTxn } from '../state';
import type { DecodedOp, DecodedTx } from '../tx';

export interface OpEnv {
  /** The parent transaction. */
  tx: DecodedTx;
  /** The operation (index, type, body, source). */
  op: DecodedOp;
  /** Source account of the operation (G...). */
  sourceId: string;
  /** Protocol version of the ledger. */
  ledgerVersion: number;
}

export interface ApplyEnv extends OpEnv {
  /**
   * Operation-level transaction. `ltx.header` is the header of the ledger
   * being closed (ledgerSeq = new sequence, scpValue.closeTime = close time).
   * Rolled back by the caller when the result is not a success.
   */
  ltx: LedgerTxn;
  ledgerSeq: number;
  /** Close time of the ledger being closed (unix seconds). */
  closeTime: bigint;
}

export interface OpFrame {
  /** getThresholdLevel */
  threshold(env: OpEnv): ThresholdLevel;
  /** doCheckValid: null when well formed, else the failure result. */
  checkValid(env: OpEnv): OpResult | null;
  /** doApply */
  apply(env: ApplyEnv): OpResult;
}
