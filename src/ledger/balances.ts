// Balances, reserves, liabilities and trustline authorization.
// Ported from stellar-core (Apache-2.0): src/transactions/TransactionUtils.cpp,
// src/transactions/SponsorshipUtils.cpp, src/ledger/TrustLineWrapper.cpp

import { trustlineKey } from './keys';
import { INT64_MAX, UINT32_MAX, addBalanceChecked } from './math';
import type { LedgerTxn } from './state';
import {
  AUTH_CLAWBACK_ENABLED_FLAG,
  AUTH_IMMUTABLE_FLAG,
  AUTH_REQUIRED_FLAG,
  AUTH_REVOCABLE_FLAG,
  TL_AUTHORIZED_FLAG,
  TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG,
  TL_CLAWBACK_ENABLED_FLAG,
  type AccountEntry,
  type CreditAsset,
  type LedgerHeader,
  type TrustLineEntry,
} from './types';

/** ACCOUNT_SUBENTRY_LIMIT in stellar-core. */
export const ACCOUNT_SUBENTRY_LIMIT = 1000;
/** Max signers per account (Signer signers<MAX_SIGNERS>). */
export const MAX_SIGNERS = 20;

export const TRUSTLINE_AUTH_FLAGS = TL_AUTHORIZED_FLAG | TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG;
export const MASK_TRUSTLINE_FLAGS =
  TL_AUTHORIZED_FLAG | TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG | TL_CLAWBACK_ENABLED_FLAG;
export const MASK_ACCOUNT_FLAGS =
  AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG | AUTH_IMMUTABLE_FLAG | AUTH_CLAWBACK_ENABLED_FLAG;

type ReserveHeader = Pick<LedgerHeader, 'baseReserve'>;

// ---------------------------------------------------------------- reserves

/** getMinBalance: (2 + numSubEntries + numSponsoring - numSponsored) * baseReserve. */
export function minBalance(header: ReserveHeader, acc: Readonly<AccountEntry>): bigint {
  const eff = 2n + BigInt(acc.numSubEntries) + BigInt(acc.numSponsoring) - BigInt(acc.numSponsored);
  if (eff < 0n) throw new Error('unexpected account state');
  return eff * BigInt(header.baseReserve);
}

/** Native balance free to spend: balance - minBalance - selling liabilities. */
export function accountAvailableBalance(header: ReserveHeader, acc: Readonly<AccountEntry>): bigint {
  return acc.balance - minBalance(header, acc) - acc.sellingLiabilities;
}

// ---------------------------------------------------------------- flags

export function isAuthorized(tl: Readonly<TrustLineEntry>): boolean {
  return (tl.flags & TL_AUTHORIZED_FLAG) !== 0;
}

export function isAuthorizedToMaintainLiabilitiesFlags(flags: number): boolean {
  return (flags & TRUSTLINE_AUTH_FLAGS) !== 0;
}

export function isAuthorizedToMaintainLiabilities(tl: Readonly<TrustLineEntry>): boolean {
  return isAuthorizedToMaintainLiabilitiesFlags(tl.flags);
}

export function isClawbackEnabledOnTrustline(tl: Readonly<TrustLineEntry>): boolean {
  return (tl.flags & TL_CLAWBACK_ENABLED_FLAG) !== 0;
}

export function isAuthRequired(acc: Readonly<AccountEntry>): boolean {
  return (acc.flags & AUTH_REQUIRED_FLAG) !== 0;
}

export function isAuthRevocable(acc: Readonly<AccountEntry>): boolean {
  return (acc.flags & AUTH_REVOCABLE_FLAG) !== 0;
}

export function isImmutableAuth(acc: Readonly<AccountEntry>): boolean {
  return (acc.flags & AUTH_IMMUTABLE_FLAG) !== 0;
}

export function isClawbackEnabledOnAccount(acc: Readonly<AccountEntry>): boolean {
  return (acc.flags & AUTH_CLAWBACK_ENABLED_FLAG) !== 0;
}

/** trustLineFlagMaskCheckIsValid (protocol 17+). */
export function trustLineFlagMaskCheckIsValid(flags: number): boolean {
  return (flags & ~MASK_TRUSTLINE_FLAGS) === 0;
}

/** trustLineFlagAuthIsValid: AUTHORIZED and AUTHORIZED_TO_MAINTAIN_LIABILITIES are exclusive. */
export function trustLineFlagAuthIsValid(flags: number): boolean {
  return (flags & TRUSTLINE_AUTH_FLAGS) !== TRUSTLINE_AUTH_FLAGS;
}

export function trustLineFlagIsValid(flags: number): boolean {
  return trustLineFlagMaskCheckIsValid(flags) && trustLineFlagAuthIsValid(flags);
}

/** accountFlagMaskCheckIsValid (protocol 17+). */
export function accountFlagMaskCheckIsValid(flags: number): boolean {
  return (flags & ~MASK_ACCOUNT_FLAGS) === 0;
}

/** accountFlagClawbackIsValid: clawback requires revocable. */
export function accountFlagClawbackIsValid(flags: number): boolean {
  return !((flags & AUTH_CLAWBACK_ENABLED_FLAG) !== 0 && (flags & AUTH_REVOCABLE_FLAG) === 0);
}

// checkAuthorization: from protocol 10 an unauthorized trustline here is a bug.
function checkAuthorization(tl: Readonly<TrustLineEntry>): void {
  if (!isAuthorizedToMaintainLiabilities(tl)) throw new Error('Invalid authorization');
}

// ---------------------------------------------------------------- balances

export type BalanceEntry = AccountEntry | TrustLineEntry;

/** getAvailableBalance for an account or trustline. */
export function getAvailableBalance(header: ReserveHeader, e: Readonly<BalanceEntry>): bigint {
  if (e.kind === 'account') return accountAvailableBalance(header, e);
  checkAuthorization(e);
  return e.balance - e.sellingLiabilities;
}

/** getMaxAmountReceive for an account or trustline. */
export function getMaxAmountReceive(header: ReserveHeader, e: Readonly<BalanceEntry>): bigint {
  if (e.kind === 'account') return INT64_MAX - (e.balance + e.buyingLiabilities);
  if (!isAuthorizedToMaintainLiabilities(e)) return 0n;
  return e.limit - e.balance - e.buyingLiabilities;
}

/** getMinimumLimit: balance + buying liabilities. */
export function getMinimumLimit(tl: Readonly<TrustLineEntry>): bigint {
  return tl.balance + tl.buyingLiabilities;
}

/** addBalance with reserve and liability checks. Mutates `e` on success. */
export function addBalance(header: ReserveHeader, e: BalanceEntry, delta: bigint): boolean {
  if (delta === 0n) return true;
  if (e.kind === 'account') {
    const next = addBalanceChecked(e.balance, delta);
    if (next === null) return false;
    if (delta < 0n && next - minBalance(header, e) < e.sellingLiabilities) return false;
    if (next > INT64_MAX - e.buyingLiabilities) return false;
    e.balance = next;
    return true;
  }
  checkAuthorization(e);
  return addBalanceSkipAuthorization(e, delta);
}

/** addBalanceSkipAuthorization (trustlines only; used by clawback). */
export function addBalanceSkipAuthorization(tl: TrustLineEntry, delta: bigint): boolean {
  const next = addBalanceChecked(tl.balance, delta, tl.limit);
  if (next === null) return false;
  if (next < tl.sellingLiabilities) return false;
  if (next > tl.limit - tl.buyingLiabilities) return false;
  tl.balance = next;
  return true;
}

/** addBuyingLiabilities. Mutates `e` on success. */
export function addBuyingLiabilities(header: ReserveHeader, e: BalanceEntry, delta: bigint): boolean {
  if (delta === 0n) return true;
  if (e.kind === 'account') {
    const next = addBalanceChecked(e.buyingLiabilities, delta, INT64_MAX - e.balance);
    if (next === null) return false;
    e.buyingLiabilities = next;
    return true;
  }
  checkAuthorization(e);
  const next = addBalanceChecked(e.buyingLiabilities, delta, e.limit - e.balance);
  if (next === null) return false;
  e.buyingLiabilities = next;
  return true;
}

/** addSellingLiabilities. Mutates `e` on success. */
export function addSellingLiabilities(header: ReserveHeader, e: BalanceEntry, delta: bigint): boolean {
  if (delta === 0n) return true;
  if (e.kind === 'account') {
    const maxLiabilities = e.balance - minBalance(header, e);
    if (maxLiabilities < 0n) return false;
    const next = addBalanceChecked(e.sellingLiabilities, delta, maxLiabilities);
    if (next === null) return false;
    e.sellingLiabilities = next;
    return true;
  }
  checkAuthorization(e);
  const next = addBalanceChecked(e.sellingLiabilities, delta, e.balance);
  if (next === null) return false;
  e.sellingLiabilities = next;
  return true;
}

// ---------------------------------------------------------------- trustline wrapper

/**
 * TrustLineWrapper: an account's balance line for a credit asset. The issuer
 * has an implicit, unlimited, always-authorized line.
 */
export interface TrustLineHandle {
  readonly isIssuer: boolean;
  /** The trustline entry (null for the issuer). Mutable when loaded with loadTrustLine. */
  readonly entry: TrustLineEntry | null;
  balance(): bigint;
  buyingLiabilities(): bigint;
  sellingLiabilities(): bigint;
  addBalance(header: ReserveHeader, delta: bigint): boolean;
  addBuyingLiabilities(header: ReserveHeader, delta: bigint): boolean;
  addSellingLiabilities(header: ReserveHeader, delta: bigint): boolean;
  isAuthorized(): boolean;
  isAuthorizedToMaintainLiabilities(): boolean;
  isClawbackEnabled(): boolean;
  availableBalance(header: ReserveHeader): bigint;
  maxAmountReceive(header: ReserveHeader): bigint;
}

const issuerHandle: TrustLineHandle = {
  isIssuer: true,
  entry: null,
  balance: () => INT64_MAX,
  buyingLiabilities: () => 0n,
  sellingLiabilities: () => 0n,
  addBalance: () => true,
  addBuyingLiabilities: () => true,
  addSellingLiabilities: () => true,
  isAuthorized: () => true,
  isAuthorizedToMaintainLiabilities: () => true,
  isClawbackEnabled: () => false,
  availableBalance: () => INT64_MAX,
  maxAmountReceive: () => INT64_MAX,
};

function lineHandle(tl: TrustLineEntry): TrustLineHandle {
  return {
    isIssuer: false,
    entry: tl,
    balance: () => tl.balance,
    buyingLiabilities: () => tl.buyingLiabilities,
    sellingLiabilities: () => tl.sellingLiabilities,
    addBalance: (h, d) => addBalance(h, tl, d),
    addBuyingLiabilities: (h, d) => addBuyingLiabilities(h, tl, d),
    addSellingLiabilities: (h, d) => addSellingLiabilities(h, tl, d),
    isAuthorized: () => isAuthorized(tl),
    isAuthorizedToMaintainLiabilities: () => isAuthorizedToMaintainLiabilities(tl),
    isClawbackEnabled: () => isClawbackEnabledOnTrustline(tl),
    availableBalance: (h) => getAvailableBalance(h, tl),
    maxAmountReceive: (h) => getMaxAmountReceive(h, tl),
  };
}

/** Load (and record) an account's line for `asset`; null if it has no trustline. */
export function loadTrustLine(ltx: LedgerTxn, accountId: string, asset: CreditAsset): TrustLineHandle | null {
  if (accountId === asset.issuer) return issuerHandle;
  const tl = ltx.load(trustlineKey(accountId, asset)) as TrustLineEntry | undefined;
  return tl ? lineHandle(tl) : null;
}

/** Read-only variant of loadTrustLine (ConstTrustLineWrapper). Do not call mutators. */
export function getTrustLine(ltx: LedgerTxn, accountId: string, asset: CreditAsset): TrustLineHandle | null {
  if (accountId === asset.issuer) return issuerHandle;
  const tl = ltx.get(trustlineKey(accountId, asset)) as TrustLineEntry | undefined;
  return tl ? lineHandle(tl) : null;
}

// ---------------------------------------------------------------- sub-entries and sponsorship

export type SponsorshipResult = 'SUCCESS' | 'LOW_RESERVE' | 'TOO_MANY_SUBENTRIES' | 'TOO_MANY_SPONSORING';

/**
 * createEntryWithPossibleSponsorship / createSignerWithPossibleSponsorship
 * for a sub-entry without a sponsorship sandwich: checks the sub-entry limit
 * and the reserve, then counts the sub-entry. `mult` is 1 for trustlines,
 * offers, data entries and signers.
 */
export function createSubentry(header: ReserveHeader, acc: AccountEntry, mult = 1): SponsorshipResult {
  if (acc.numSubEntries > ACCOUNT_SUBENTRY_LIMIT - mult) return 'TOO_MANY_SUBENTRIES';
  if (acc.numSponsoring + acc.numSubEntries + mult > UINT32_MAX) return 'TOO_MANY_SUBENTRIES';
  if (getAvailableBalance(header, acc) < BigInt(mult) * BigInt(header.baseReserve)) return 'LOW_RESERVE';
  acc.numSubEntries += mult;
  return 'SUCCESS';
}

/** removeEntryWithPossibleSponsorship for an unsponsored sub-entry. */
export function removeSubentry(acc: AccountEntry, mult = 1): void {
  if (acc.numSubEntries < mult) throw new Error('invalid account state');
  acc.numSubEntries -= mult;
}

/**
 * The account pays the reserve of an entry that is not its sub-entry
 * (a claimable balance: mult = number of claimants).
 */
export function establishSponsorship(header: ReserveHeader, sponsor: AccountEntry, mult: number): SponsorshipResult {
  if (getAvailableBalance(header, sponsor) < BigInt(mult) * BigInt(header.baseReserve)) return 'LOW_RESERVE';
  if (sponsor.numSponsoring > UINT32_MAX - mult) return 'TOO_MANY_SPONSORING';
  if (sponsor.numSponsoring + sponsor.numSubEntries + mult > UINT32_MAX) return 'TOO_MANY_SPONSORING';
  sponsor.numSponsoring += mult;
  return 'SUCCESS';
}

export function removeSponsorship(sponsor: AccountEntry, mult: number): void {
  if (sponsor.numSponsoring < mult) throw new Error('insufficient numSponsoring');
  sponsor.numSponsoring -= mult;
}
