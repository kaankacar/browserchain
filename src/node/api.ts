// The UI-facing node API (Horizon-like). The node runs in a Web Worker; the
// UI talks to it through a client that implements NodeApi over postMessage.
// Everything here must be structured-clone friendly: no bigint, no class
// instances, no functions. Amounts are 7-decimal strings ("12.5000000").

import type { LogEntry } from '../lib/log';

export type SyncState = 'booting' | 'catching-up' | 'synced' | 'stalled' | 'stopped';
export type ScpPhase = 'NOMINATE' | 'PREPARE' | 'CONFIRM' | 'EXTERNALIZE';

export interface AssetView {
  type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  code: string; // "XLM" for native
  issuer?: string;
}

export interface LedgerSummary {
  seq: number;
  hash: string;
  prevHash: string;
  closeTime: number; // unix seconds
  txCount: number;
  opCount: number;
  failedTxCount: number;
  baseFee: number;
  baseReserve: number;
  totalCoins: string;
  feePool: string;
  protocolVersion: number;
  txSetHash: string;
  stateHash: string;
  /** Node that nominated the winning value (from the signed StellarValue), if known. */
  proposer: string | null;
  /** Local ms when this node closed the ledger. */
  closedAt: number;
  /** Validators seen externalizing it (0 when replayed during catch-up). */
  externalizedBy: number;
}

export interface OperationView {
  index: number;
  type: string;
  sourceAccount: string;
  resultCode: string;
  details: Record<string, string | number | boolean | null>;
}

export interface TxSummary {
  hash: string;
  ledgerSeq: number;
  applyIndex: number;
  sourceAccount: string;
  feeCharged: string; // XLM decimal
  maxFee: string;
  opCount: number;
  successful: boolean;
  resultCode: string;
  memo: { type: string; value: string | null };
  closeTime: number;
  operations: OperationView[];
}

export interface TxDetail extends TxSummary {
  envelopeXdr: string;
  resultXdr: string;
  signatures: { hint: string; signature: string }[];
}

export interface LedgerDetail extends LedgerSummary {
  headerXdr: string;
  /** Header fields for display (all values stringified). */
  header: Record<string, string | number>;
  txs: TxSummary[];
}

export interface BalanceLine {
  asset: AssetView;
  balance: string;
  limit: string | null; // null for native
  buyingLiabilities: string;
  sellingLiabilities: string;
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  clawbackEnabled: boolean;
}

export interface OfferView {
  offerId: string;
  seller: string;
  selling: AssetView;
  buying: AssetView;
  amount: string;
  price: string; // decimal, buying per selling
  priceR: { n: number; d: number };
  passive: boolean;
}

export interface ClaimableBalanceView {
  balanceId: string;
  asset: AssetView;
  amount: string;
  sponsor: string;
  claimants: { destination: string; predicate: unknown }[];
}

export interface AccountView {
  accountId: string;
  sequence: string;
  numSubEntries: number;
  minBalance: string;
  /** Native balance free to spend (balance - minBalance - selling liabilities). */
  availableBalance: string;
  flags: { authRequired: boolean; authRevocable: boolean; authImmutable: boolean; authClawbackEnabled: boolean };
  thresholds: { masterWeight: number; low: number; med: number; high: number };
  signers: { key: string; weight: number }[];
  homeDomain: string;
  /** Native first, then trustlines. */
  balances: BalanceLine[];
  offers: OfferView[];
  data: { name: string; valueBase64: string; valueText: string | null }[];
  claimableBalances: ClaimableBalanceView[];
  lastModifiedLedger: number;
}

export interface OrderBookView {
  selling: AssetView;
  buying: AssetView;
  /**
   * Offers buying `selling` (i.e. selling `buying`), best first. price = buying per selling.
   * amount is in units of `buying` (what these offers sell), as in Horizon.
   */
  bids: { price: string; amount: string; priceR: { n: number; d: number } }[];
  /**
   * Offers selling `selling` for `buying`, best (lowest) first. price = buying per selling.
   * amount is in units of `selling`.
   */
  asks: { price: string; amount: string; priceR: { n: number; d: number } }[];
}

export interface AssetStatView {
  asset: AssetView;
  holders: number;
  supply: string;
  issuerFlags: { authRequired: boolean; authRevocable: boolean; authClawbackEnabled: boolean };
}

export interface QuorumSetView {
  threshold: number;
  validators: string[];
  innerSets: QuorumSetView[];
}

export interface QuorumConfigView {
  mode: 'auto' | 'manual';
  qset: QuorumSetView;
  qsetHash: string;
  /** Result of the local quorum intersection check over known validators. */
  intersection: 'ok' | 'broken' | 'unknown';
  /** Max number of validators in our qset that may fail (0 = none). */
  faultTolerance: number;
}

export type QuorumConfigInput = { mode: 'auto' } | { mode: 'manual'; qset: QuorumSetView };

export interface PeerView {
  nodeId: string;
  name: string;
  transports: string[];
  lclSeq: number;
  lclHash: string;
  state: SyncState;
  validator: boolean;
  lastSeen: number;
  latencyMs: number | null;
  inMyQuorum: boolean;
}

export interface ValidatorView {
  nodeId: string;
  name: string;
  isSelf: boolean;
  active: boolean;
  synced: boolean;
  lastSeen: number;
  lastSlot: number;
  connected: boolean;
  inMyQuorum: boolean;
  qsetHash: string | null;
  qset: QuorumSetView | null;
}

export interface ValueView {
  /** Short id of the value (first 8 hex of its SHA-256). */
  id: string;
  txSetHash: string;
  closeTime: number;
  txCount: number | null;
  proposer: string | null;
}

export interface BallotView {
  counter: number;
  value: ValueView;
}

export interface ScpNodeStateView {
  nodeId: string;
  name: string;
  statement: 'nominate' | 'prepare' | 'confirm' | 'externalize' | 'none';
  ballotCounter: number | null;
  /** Compact text, e.g. "PREPARE b=2 p=1 nC=0 nH=0". */
  summary: string;
}

export interface ScpSlotView {
  slot: number;
  phase: ScpPhase;
  nomination: {
    round: number;
    votes: ValueView[];
    accepted: ValueView[];
    candidates: ValueView[];
    leaders: string[];
  };
  ballot: BallotView | null;
  prepared: BallotView | null;
  preparedPrime: BallotView | null;
  high: BallotView | null;
  commit: BallotView | null;
  heardFromQuorum: boolean;
  nodes: ScpNodeStateView[];
  externalized: ValueView | null;
  startedAt: number; // local ms
  externalizedAt: number | null;
}

export interface ScpEventView {
  ts: number;
  slot: number;
  direction: 'in' | 'out';
  nodeId: string;
  name: string;
  type: 'nominate' | 'prepare' | 'confirm' | 'externalize';
  summary: string;
}

export interface NodeStatus {
  nodeId: string;
  name: string;
  networkName: string;
  networkPassphrase: string;
  networkId: string;
  protocolVersion: number;
  appVersion: number;
  state: SyncState;
  isValidator: boolean;
  lcl: LedgerSummary;
  peers: number;
  validatorsActive: number;
  mempoolSize: number;
  quorum: QuorumConfigView;
  startedAt: number;
  slot: { index: number; phase: ScpPhase; ballotCounter: number | null; round: number } | null;
  /**
   * Catch-up progress. `blocked` is set when peers are ahead but we cannot
   * catch up from them safely (for example they are all unknown validators),
   * so this node does not vote. The user may Resync to trust them.
   */
  catchup: { target: number; current: number; source: string | null; blocked?: string } | null;
}

export interface NetworkStats {
  ledgersClosedHere: number;
  /** Average of the last 20 close intervals (ms). */
  avgCloseIntervalMs: number;
  recentCloseIntervalsMs: number[];
  txPerLedger: number;
  opsPerLedger: number;
  totalAccounts: number;
  totalTrustlines: number;
  totalOffers: number;
  totalClaimableBalances: number;
}

export interface SubmitResult {
  hash: string;
  status: 'PENDING' | 'DUPLICATE' | 'ERROR' | 'TRY_AGAIN_LATER';
  /** e.g. "txBAD_SEQ" when status is ERROR. */
  errorResultCode?: string;
  errorDetail?: string;
}

export interface ForkInfo {
  ts: number;
  atSeq: number;
  ourHash: string;
  theirHash: string;
  peer: string;
  resolution: 'rolled-back' | 'kept-ours' | 'alert-only';
  rolledBackLedgers: number;
  /**
   * Set when we kept our branch only because the validators on the other
   * branch were unknown to us before the fork point: how many of them
   * announce that branch. The user may Resync to join them.
   */
  unknownValidators?: number;
}

export type TxStatus = 'pending' | 'applied' | 'failed' | 'dropped';

export type NodeEvent =
  | { type: 'status'; status: NodeStatus }
  | { type: 'ledgerClosed'; ledger: LedgerSummary; txs: TxSummary[] }
  | { type: 'scp'; event: ScpEventView }
  | { type: 'slot'; slot: ScpSlotView }
  | { type: 'peers'; peers: PeerView[] }
  | { type: 'txStatus'; hash: string; status: TxStatus; ledgerSeq?: number; resultCode?: string }
  | { type: 'fork'; info: ForkInfo }
  | { type: 'log'; entry: LogEntry };

export interface NodeApi {
  getStatus(): Promise<NodeStatus>;
  getLedgers(opts: { limit: number; beforeSeq?: number }): Promise<LedgerSummary[]>;
  getLedger(seq: number): Promise<LedgerDetail | null>;
  getTransaction(hash: string): Promise<TxDetail | null>;
  getTransactions(opts: { limit: number; account?: string; beforeLedger?: number }): Promise<TxSummary[]>;
  getAccount(accountId: string): Promise<AccountView | null>;
  getOrderBook(selling: AssetView, buying: AssetView, limit?: number): Promise<OrderBookView>;
  getAssets(): Promise<AssetStatView[]>;
  /** Base64 TransactionEnvelope. */
  submitTransaction(envelopeXdr: string): Promise<SubmitResult>;
  /** Fund (create or top up) an account with 10,000 XLM. */
  friendbot(accountId: string): Promise<SubmitResult>;
  getPeers(): Promise<PeerView[]>;
  getValidators(): Promise<ValidatorView[]>;
  getQuorumConfig(): Promise<QuorumConfigView>;
  setQuorumConfig(cfg: QuorumConfigInput): Promise<QuorumConfigView>;
  /** Default: the slot currently being decided (LCL + 1). */
  getScpSlot(slot?: number): Promise<ScpSlotView | null>;
  getScpEvents(limit: number): Promise<ScpEventView[]>;
  getStats(): Promise<NetworkStats>;
  getForks(): Promise<ForkInfo[]>;
  getLogs(limit: number): Promise<LogEntry[]>;
  /** Switch between validating and watching (non-validator). */
  setValidating(on: boolean): Promise<void>;
  setName(name: string): Promise<void>;
  /** Wipe the local chain and resync from peers (keeps identity). */
  resync(): Promise<void>;
  subscribe(listener: (ev: NodeEvent) => void): () => void;
}
