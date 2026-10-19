// Persistence interface. IndexedDB in browsers, in-memory in tests.

export interface StoredLedger {
  seq: number;
  hash: string;
  headerXdr: string; // base64 xdr.LedgerHeader
  txSetXdr: string; // base64 xdr.TransactionSet
  resultSetXdr: string; // base64 xdr.TransactionResultSet
  closeTime: number; // unix seconds
  txCount: number;
  opCount: number;
  failedTxCount: number;
  /** Local metadata (not consensus data). */
  closedAt: number; // local ms when this node closed it
  /** Distinct validators seen externalizing this slot (incl. self), 0 if replayed. */
  externalizedBy: number;
}

export interface StoredTx {
  hash: string;
  ledgerSeq: number;
  applyIndex: number;
  envelopeXdr: string;
  resultXdr: string;
  sourceAccount: string;
  feeCharged: string; // stroops, decimal
  maxFee: string;
  successful: boolean;
  resultCode: string;
  closeTime: number;
  /** All accounts touched; used for per-account history. */
  accounts: string[];
  /** JSON of TxApplyResult.operations and memo, for fast UI rendering. */
  summaryJson: string;
}

export interface Storage {
  open(): Promise<void>;
  close(): Promise<void>;

  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;

  /** Store a closed ledger and its txs atomically. Replaces an existing ledger with the same seq. */
  putLedger(ledger: StoredLedger, txs: StoredTx[]): Promise<void>;
  getLedger(seq: number): Promise<StoredLedger | undefined>;
  /** Inclusive range, ascending. Missing seqs are skipped. */
  getLedgers(from: number, to: number): Promise<StoredLedger[]>;
  /** Newest first, seq < beforeSeq when given. */
  getLatestLedgers(limit: number, beforeSeq?: number): Promise<StoredLedger[]>;
  /** Highest stored ledger seq, or 0. */
  getMaxLedgerSeq(): Promise<number>;

  getTx(hash: string): Promise<StoredTx | undefined>;
  getTxsByLedger(seq: number): Promise<StoredTx[]>;
  /** Newest first. */
  getTxsByAccount(accountId: string, limit: number, beforeLedgerSeq?: number): Promise<StoredTx[]>;
  /** Newest first. */
  getLatestTxs(limit: number, beforeLedgerSeq?: number): Promise<StoredTx[]>;

  /** data = JSON of LedgerSnapshot. */
  putSnapshot(seq: number, data: string): Promise<void>;
  getSnapshot(seq: number): Promise<string | undefined>;
  getLatestSnapshotAtOrBefore(seq: number): Promise<{ seq: number; data: string } | undefined>;
  listSnapshotSeqs(): Promise<number[]>;

  /** Delete ledgers, txs and snapshots with seq > `seq` (rollback). */
  truncateAfter(seq: number): Promise<void>;
  /** Delete everything except meta. */
  clearChain(): Promise<void>;
}
