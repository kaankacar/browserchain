// Network-wide constants. Values follow stellar-core where it makes sense.

export const PROTOCOL_VERSION = 23;
/**
 * Bumped when the wire format or ledger rules change incompatibly. Peers
 * accept only an equal version. 2: hellos carry a link nonce and the DTLS
 * channel; the genesis root is locked; friendbot channel policy; DEX cap.
 * 3: the friendbot cap per tx set; a channel transaction bids exactly the
 * base fee. 4: a channel CreateAccount must create a new account and a
 * channel Payment must pay an existing one (checkValid and tx sets).
 */
export const APP_VERSION = 4;

export const DEFAULT_NETWORK_NAME = 'main';

/** The network passphrase. Its SHA-256 is the network ID. */
export function networkPassphrase(networkName: string = DEFAULT_NETWORK_NAME): string {
  return networkName === DEFAULT_NETWORK_NAME
    ? 'BrowserChain Network ; October 2026'
    : `BrowserChain ${networkName} Network ; October 2026`;
}

export const STROOPS_PER_XLM = 10_000_000n;
/** 100 billion XLM, like Stellar's genesis. */
export const TOTAL_COINS = 100_000_000_000n * STROOPS_PER_XLM;

export const GENESIS_LEDGER_SEQ = 1;
export const BASE_FEE = 100; // stroops per operation
export const BASE_RESERVE = 5_000_000; // stroops (0.5 XLM)
export const MAX_TX_SET_SIZE = 1000; // operations per ledger
/**
 * Operations per tx set in transactions that have a DEX operation (a path
 * payment, or an offer that is not a delete), like stellar-core's
 * MAX_DEX_TX_OPERATIONS_IN_TX_SET. They compete for it by fee rate.
 */
export const MAX_DEX_OPS_IN_TX_SET = 200;

/** Target ledger close interval (stellar-core: EXP_LEDGER_TIMESPAN_SECONDS). */
export const LEDGER_TARGET_CLOSE_MS = 5000;
/** Max seconds a nominated close time may be ahead of local time. */
export const MAX_TIME_SLIP_SECONDS = 60;

/** A state snapshot is kept every CHECKPOINT_FREQUENCY ledgers (seq % 64 === 0). */
export const CHECKPOINT_FREQUENCY = 64;

/** SCP slots kept in memory below the last closed ledger. */
export const MAX_SLOTS_TO_REMEMBER = 12;
/** Envelopes for slots further than this above LCL are ignored. */
export const LEDGER_VALIDITY_BRACKET = 100;

export const FRIENDBOT_CHANNELS = 16;
export const FRIENDBOT_AMOUNT = 10_000n * STROOPS_PER_XLM;
/** Each friendbot channel account is funded with this much at genesis. */
export const FRIENDBOT_CHANNEL_BALANCE = 1_000_000_000n * STROOPS_PER_XLM;
/**
 * Transactions per tx set that use a friendbot channel (as the transaction
 * source or an operation source). The channel keys are public, so this caps
 * the drain at 16 x FRIENDBOT_AMOUNT per ledger: emptying the channels takes
 * 100,000 ledgers (about 6 days at the target close time).
 */
export const MAX_FRIENDBOT_TXS_IN_TX_SET = 16;

/** Peer liveness. */
export const STATUS_INTERVAL_MS = 2000;
export const PEER_TIMEOUT_MS = 7000;
/** A validator counts as active (auto quorum) if heard from within this window. */
export const VALIDATOR_ACTIVE_MS = 9000;
