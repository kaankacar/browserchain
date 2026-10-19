// Ledger key strings (docs/ARCHITECTURE.md 5.1).

import type { Asset, CreditAsset, LedgerEntry, LedgerKey } from './types';

export type EntryKind = LedgerEntry['kind'];

export function accountKey(accountId: string): LedgerKey {
  return `A:${accountId}`;
}

export function trustlineKey(accountId: string, asset: CreditAsset): LedgerKey {
  return `T:${accountId}:${asset.code}:${asset.issuer}`;
}

export function offerKey(offerId: bigint): LedgerKey {
  return `O:${offerId.toString()}`;
}

export function dataKey(accountId: string, name: string): LedgerKey {
  return `D:${accountId}:${name}`;
}

export function claimableBalanceKey(balanceIdHex: string): LedgerKey {
  return `C:${balanceIdHex}`;
}

export function entryKey(e: LedgerEntry): LedgerKey {
  switch (e.kind) {
    case 'account':
      return accountKey(e.accountId);
    case 'trustline':
      return trustlineKey(e.accountId, e.asset);
    case 'offer':
      return offerKey(e.offerId);
    case 'data':
      return dataKey(e.accountId, e.name);
    case 'claimableBalance':
      return claimableBalanceKey(e.balanceId);
  }
}

export function keyKind(key: LedgerKey): EntryKind {
  switch (key.charCodeAt(0)) {
    case 65 /* A */:
      return 'account';
    case 84 /* T */:
      return 'trustline';
    case 79 /* O */:
      return 'offer';
    case 68 /* D */:
      return 'data';
    case 67 /* C */:
      return 'claimableBalance';
    default:
      throw new Error(`unknown ledger key: ${key}`);
  }
}

/** The account that owns a sub-entry (trustline, offer, data), or null. */
export function entryOwner(e: LedgerEntry): string | null {
  switch (e.kind) {
    case 'trustline':
    case 'data':
      return e.accountId;
    case 'offer':
      return e.sellerId;
    default:
      return null;
  }
}

/** Key of an (selling, buying) offer pair, used to index the order book. */
export function offerPairKey(selling: Asset, buying: Asset): string {
  const s = selling.type === 'native' ? 'native' : `${selling.code}:${selling.issuer}`;
  const b = buying.type === 'native' ? 'native' : `${buying.code}:${buying.issuer}`;
  return `${s}|${b}`;
}
