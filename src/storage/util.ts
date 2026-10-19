// Helpers shared by the Storage implementations.

import type { StoredLedger, StoredTx } from './types';

export function requireSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError(`invalid ledger seq: ${seq}`);
}

/** Checks the fields used as keys. Txs must belong to the ledger they are stored with. */
export function validateLedgerAndTxs(ledger: StoredLedger, txs: StoredTx[]): void {
  requireSeq(ledger.seq);
  for (const tx of txs) {
    if (typeof tx.hash !== 'string' || tx.hash.length === 0) {
      throw new TypeError('StoredTx.hash must be a non-empty string');
    }
    if (tx.ledgerSeq !== ledger.seq) {
      throw new TypeError(`tx ${tx.hash} has ledgerSeq ${tx.ledgerSeq}, expected ${ledger.seq}`);
    }
    if (!Number.isSafeInteger(tx.applyIndex) || tx.applyIndex < 0) {
      throw new TypeError(`tx ${tx.hash} has an invalid applyIndex`);
    }
  }
}

/** Unique, string-only account list of a tx. */
export function txAccounts(tx: StoredTx): string[] {
  if (!Array.isArray(tx.accounts)) return [];
  return [...new Set(tx.accounts.filter((a): a is string => typeof a === 'string' && a.length > 0))];
}

/** Newest first: ledgerSeq desc, applyIndex desc, then hash desc (IndexedDB 'prev' order). */
export function compareTxsNewestFirst(a: StoredTx, b: StoredTx): number {
  if (a.ledgerSeq !== b.ledgerSeq) return b.ledgerSeq - a.ledgerSeq;
  if (a.applyIndex !== b.applyIndex) return b.applyIndex - a.applyIndex;
  return a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0;
}

/** Oldest first within a ledger: applyIndex asc, then hash asc. */
export function compareTxsApplyOrder(a: StoredTx, b: StoredTx): number {
  return -compareTxsNewestFirst(a, b) || 0;
}
