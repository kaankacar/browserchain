// Deterministic genesis ledger (docs/ARCHITECTURE.md 4).

import { Keypair } from '@stellar/stellar-sdk/base';
import { ZERO_HASH } from '../lib/bytes';
import {
  BASE_FEE,
  BASE_RESERVE,
  FRIENDBOT_CHANNELS,
  FRIENDBOT_CHANNEL_BALANCE,
  GENESIS_LEDGER_SEQ,
  MAX_TX_SET_SIZE,
  PROTOCOL_VERSION,
  TOTAL_COINS,
} from '../lib/constants';
import { sha256 } from '../lib/hash';
import { computeStateHash } from './entries';
import { newAccountEntry } from './ops/createAccount';
import type { AccountEntry, LedgerHeader } from './types';

export interface GenesisOptions {
  /**
   * Tests only: keep the root account's master key (weight 1), so a test can
   * fund accounts from it. A network never sets it: its root is locked.
   */
  unlockRoot?: boolean;
}

/** Root account key: Keypair.master(passphrase). */
export function rootKeypair(passphrase: string): Keypair {
  return Keypair.master(passphrase);
}

/** Friendbot channel keys: fromRawEd25519Seed(sha256(`${passphrase}|friendbot|${i}`)), i = 0..15. */
export function friendbotKeypairs(passphrase: string): Keypair[] {
  const out: Keypair[] = [];
  for (let i = 0; i < FRIENDBOT_CHANNELS; i++) {
    out.push(Keypair.fromRawEd25519Seed(sha256(`${passphrase}|friendbot|${i}`)));
  }
  return out;
}

const channelIdCache = new Map<string, ReadonlySet<string>>();

/** Account ids (G...) of the friendbot channels of a network. Memoized. */
export function friendbotChannelIds(passphrase: string): ReadonlySet<string> {
  let ids = channelIdCache.get(passphrase);
  if (!ids) {
    ids = new Set(friendbotKeypairs(passphrase).map((k) => k.publicKey()));
    if (channelIdCache.size >= 64) channelIdCache.clear();
    channelIdCache.set(passphrase, ids);
  }
  return ids;
}

/**
 * Genesis entries: the root account and the friendbot channel accounts. The
 * root key is public (derived from the passphrase), so the root is locked the
 * Stellar way: master weight 0 and no signers, so nothing it signs counts.
 */
export function genesisEntries(passphrase: string, opts: GenesisOptions = {}): AccountEntry[] {
  const channels = BigInt(FRIENDBOT_CHANNELS) * FRIENDBOT_CHANNEL_BALANCE;
  const root = newAccountEntry(rootKeypair(passphrase).publicKey(), TOTAL_COINS - channels, 0n, GENESIS_LEDGER_SEQ);
  if (!opts.unlockRoot) root.thresholds = { ...root.thresholds, master: 0 };
  const entries: AccountEntry[] = [root];
  for (const kp of friendbotKeypairs(passphrase)) {
    entries.push(newAccountEntry(kp.publicKey(), FRIENDBOT_CHANNEL_BALANCE, 0n, GENESIS_LEDGER_SEQ));
  }
  return entries;
}

/** Genesis header (ledger 1). */
export function genesisHeader(passphrase: string, opts: GenesisOptions = {}): LedgerHeader {
  return {
    ledgerVersion: PROTOCOL_VERSION,
    previousLedgerHash: ZERO_HASH,
    scpValue: { txSetHash: ZERO_HASH, closeTime: 0, upgrades: [], signature: null },
    txSetResultHash: ZERO_HASH,
    bucketListHash: computeStateHash(genesisEntries(passphrase, opts)),
    ledgerSeq: GENESIS_LEDGER_SEQ,
    totalCoins: TOTAL_COINS,
    feePool: 0n,
    inflationSeq: 0,
    idPool: 0n,
    baseFee: BASE_FEE,
    baseReserve: BASE_RESERVE,
    maxTxSetSize: MAX_TX_SET_SIZE,
    skipList: [ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH],
  };
}
