// Ledger types shared by the ledger, herder, history and node modules.
// Amounts are int64 stroops as bigint. Hashes are lowercase hex.
// Transaction envelopes, tx sets, headers and results travel as base64 XDR
// (real Stellar XDR types from @stellar/stellar-sdk/base).

export type Hash = string;

// ---------------------------------------------------------------- assets

export type CreditAssetType = 'credit_alphanum4' | 'credit_alphanum12';

export interface NativeAsset {
  type: 'native';
}

export interface CreditAsset {
  type: CreditAssetType;
  code: string;
  issuer: string; // G...
}

export type Asset = NativeAsset | CreditAsset;

// ---------------------------------------------------------------- entries

/** Account flags (AccountFlags in Stellar-ledger-entries.x). */
export const AUTH_REQUIRED_FLAG = 0x1;
export const AUTH_REVOCABLE_FLAG = 0x2;
export const AUTH_IMMUTABLE_FLAG = 0x4;
export const AUTH_CLAWBACK_ENABLED_FLAG = 0x8;

/** Trustline flags. */
export const TL_AUTHORIZED_FLAG = 0x1;
export const TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG = 0x2;
export const TL_CLAWBACK_ENABLED_FLAG = 0x4;

/** Offer flags. */
export const OFFER_PASSIVE_FLAG = 0x1;

/** Claimable balance flags. */
export const CB_CLAWBACK_ENABLED_FLAG = 0x1;

export interface Signer {
  /** StrKey: G... (ed25519), T... (pre-auth tx), X... (sha256 hash). */
  key: string;
  weight: number;
}

export interface AccountEntry {
  kind: 'account';
  accountId: string;
  balance: bigint;
  seqNum: bigint;
  numSubEntries: number;
  /** Reserve-carrying entries this account sponsors (used for claimable balances). */
  numSponsoring: number;
  numSponsored: number;
  inflationDest: string | null;
  flags: number;
  homeDomain: string;
  thresholds: { master: number; low: number; med: number; high: number };
  /** Sorted by key. */
  signers: Signer[];
  buyingLiabilities: bigint;
  sellingLiabilities: bigint;
  /** Ledger and close time of the last sequence number change (CAP-21 seqLedger/seqTime). */
  seqLedger: number;
  seqTime: bigint;
  lastModifiedLedgerSeq: number;
}

export interface TrustLineEntry {
  kind: 'trustline';
  accountId: string;
  asset: CreditAsset;
  balance: bigint;
  limit: bigint;
  flags: number;
  buyingLiabilities: bigint;
  sellingLiabilities: bigint;
  lastModifiedLedgerSeq: number;
}

export interface Price {
  n: number; // int32
  d: number; // int32
}

export interface OfferEntry {
  kind: 'offer';
  sellerId: string;
  offerId: bigint;
  selling: Asset;
  buying: Asset;
  /** Amount of `selling` offered. */
  amount: bigint;
  /** Price of 1 unit of selling in terms of buying (buying = selling * n / d). */
  price: Price;
  flags: number;
  lastModifiedLedgerSeq: number;
}

export interface DataEntry {
  kind: 'data';
  accountId: string;
  name: string;
  /** Base64 of the raw value bytes (max 64 bytes). */
  value: string;
  lastModifiedLedgerSeq: number;
}

export type ClaimPredicate =
  | { type: 'unconditional' }
  | { type: 'and'; predicates: [ClaimPredicate, ClaimPredicate] }
  | { type: 'or'; predicates: [ClaimPredicate, ClaimPredicate] }
  | { type: 'not'; predicate: ClaimPredicate }
  /** Unix seconds. Relative predicates are converted to absolute at creation. */
  | { type: 'beforeAbsoluteTime'; time: bigint };

export interface Claimant {
  destination: string;
  predicate: ClaimPredicate;
}

export interface ClaimableBalanceEntry {
  kind: 'claimableBalance';
  /** Hex of the 32-byte hash in ClaimableBalanceID (type V0). */
  balanceId: string;
  claimants: Claimant[];
  asset: Asset;
  amount: bigint;
  flags: number;
  /** Creator; pays the reserve (numSponsoring += claimants.length). */
  sponsor: string;
  lastModifiedLedgerSeq: number;
}

export type LedgerEntry = AccountEntry | TrustLineEntry | OfferEntry | DataEntry | ClaimableBalanceEntry;

/**
 * Ledger keys are strings:
 *   account:          `A:${accountId}`
 *   trustline:        `T:${accountId}:${code}:${issuer}`
 *   offer:            `O:${offerId}`            (decimal)
 *   data:             `D:${accountId}:${name}`
 *   claimable balance `C:${balanceIdHex}`
 */
export type LedgerKey = string;

// ---------------------------------------------------------------- values and headers

/** Decoded StellarValue (Stellar-ledger.x). Encoded hex of its XDR is the SCP Value. */
export interface StellarValueInfo {
  txSetHash: Hash;
  closeTime: number; // unix seconds (TimePoint)
  upgrades: string[]; // hex of each UpgradeType (always empty in this network)
  /** STELLAR_VALUE_SIGNED (nodeId + hex signature) or null for STELLAR_VALUE_BASIC. */
  signature: { nodeId: string; signature: string } | null;
}

/** Decoded LedgerHeader (Stellar-ledger.x). Its hash is SHA-256 of the XDR. */
export interface LedgerHeader {
  ledgerVersion: number;
  previousLedgerHash: Hash;
  scpValue: StellarValueInfo;
  txSetResultHash: Hash;
  /** SHA-256 of the full ledger state (see ledger/state hashing). Stellar uses the BucketList hash here. */
  bucketListHash: Hash;
  ledgerSeq: number;
  totalCoins: bigint;
  feePool: bigint;
  inflationSeq: number;
  idPool: bigint;
  baseFee: number;
  baseReserve: number;
  maxTxSetSize: number;
  skipList: [Hash, Hash, Hash, Hash];
}

// ---------------------------------------------------------------- tx sets and results

/** A classic xdr.TransactionSet in canonical order. */
export interface TxSetInfo {
  hash: Hash;
  previousLedgerHash: Hash;
  /** Base64 TransactionEnvelope XDR, sorted by SHA-256 of the envelope XDR. */
  txs: string[];
  /** Base64 of xdr.TransactionSet. */
  xdr: string;
}

export interface OperationSummary {
  index: number;
  /** XDR operation type name, e.g. "payment", "manageSellOffer". */
  type: string;
  sourceAccount: string;
  /** Result code name, e.g. "PAYMENT_SUCCESS", "opNO_ACCOUNT". */
  resultCode: string;
  /** Human-oriented details, amounts as 7-decimal strings, assets as "XLM" or "CODE:ISSUER". */
  details: Record<string, string | number | boolean | null>;
}

export interface TxApplyResult {
  hash: Hash;
  applyIndex: number;
  envelopeXdr: string;
  /** Base64 xdr.TransactionResult. */
  resultXdr: string;
  sourceAccount: string;
  feeCharged: bigint;
  maxFee: bigint;
  successful: boolean;
  /** e.g. "txSUCCESS", "txFAILED", "txBAD_SEQ". */
  resultCode: string;
  memo: { type: 'none' | 'text' | 'id' | 'hash' | 'return'; value: string | null };
  operations: OperationSummary[];
  /** Every account touched (sources, destinations, counterparties): for history indexes. */
  accounts: string[];
}

export interface LedgerCloseResult {
  header: LedgerHeader;
  hash: Hash;
  headerXdr: string; // base64
  txSet: TxSetInfo;
  results: TxApplyResult[];
  /** Base64 xdr.TransactionResultSet (its SHA-256 is header.txSetResultHash). */
  resultSetXdr: string;
  /** Keys created, updated or deleted by this ledger. */
  changedKeys: LedgerKey[];
}

// ---------------------------------------------------------------- validation

export interface TxCheckOptions {
  /** Validate as if the source account's seqNum were this (mempool chains). */
  seqNumOverride?: bigint;
  /** Fees already promised by queued txs of the same source (reduces available balance). */
  pendingFees?: bigint;
  /** Close time to check time bounds against. Default: LCL close time. */
  closeTime?: number;
  /** Ledger seq to check ledger bounds against. Default: LCL + 1. */
  ledgerSeq?: number;
}

export interface TxCheckResult {
  ok: boolean;
  hash: Hash; // '' if the envelope could not be decoded
  sourceAccount: string;
  seqNum: bigint;
  /** Max fee bid of the transaction. */
  fee: bigint;
  opCount: number;
  /** On failure: tx result code name, e.g. "txBAD_SEQ", "txBAD_AUTH", "txMALFORMED". */
  code?: string;
  detail?: string;
}

// ---------------------------------------------------------------- snapshots

/** JSON-safe serialized ledger entry (bigint -> decimal string). */
export type SerializedEntry = Record<string, unknown>;

export interface LedgerSnapshot {
  version: 1;
  networkPassphrase: string;
  seq: number;
  hash: Hash;
  headerXdr: string;
  entries: SerializedEntry[];
}

// ---------------------------------------------------------------- the manager

export interface ILedgerManager {
  readonly networkPassphrase: string;
  readonly networkId: Uint8Array;

  /** Last closed ledger (LCL). */
  lastClosed(): { header: LedgerHeader; hash: Hash; headerXdr: string };

  // Queries (return copies; callers may not mutate state).
  getEntry(key: LedgerKey): LedgerEntry | undefined;
  getAccount(accountId: string): AccountEntry | undefined;
  getTrustLines(accountId: string): TrustLineEntry[];
  getOffersByAccount(accountId: string): OfferEntry[];
  getDataEntries(accountId: string): DataEntry[];
  getClaimableBalances(filter: { claimant?: string; sponsor?: string }): ClaimableBalanceEntry[];
  /** Offers selling `selling` for `buying`, best (lowest) price first, then lowest offerId. */
  getOrderBook(selling: Asset, buying: Asset, limit?: number): OfferEntry[];
  allEntries(): LedgerEntry[];
  entryCount(): number;
  /** (2 + numSubEntries + numSponsoring - numSponsored) * baseReserve. */
  minBalance(account: AccountEntry): bigint;

  // Transactions.
  /** Mempool admission check against the LCL state. Never throws. */
  checkValid(envelopeXdr: string, opts?: TxCheckOptions): TxCheckResult;
  /** Build a canonical tx set (sorted, hashed). Does not validate. */
  makeTxSet(previousLedgerHash: Hash, envelopes: string[]): TxSetInfo;
  /** Decode and re-hash a tx set received from the network. Throws if malformed. */
  decodeTxSet(xdrB64: string): TxSetInfo;
  /** Full validity of a tx set for LCL+1 (prev hash, seq chains, fees, size, sigs). */
  checkTxSetValid(txSet: TxSetInfo, closeTime: number): { valid: boolean; reason?: string };
  /** From candidate envelopes, keep a valid subset for LCL+1 (highest fee rate first, <= maxTxSetSize ops). */
  trimInvalid(envelopes: string[], closeTime: number): { valid: string[]; invalid: string[] };
  /** Apply a tx set with the externalized value. Advances LCL. Deterministic. */
  closeLedger(txSet: TxSetInfo, value: StellarValueInfo): LedgerCloseResult;

  // State.
  stateHash(): Hash;
  snapshot(): LedgerSnapshot;
}
