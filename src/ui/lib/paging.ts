import type { TxSummary } from '../../node/api';

/**
 * Transactions are paged by ledger (beforeLedger). When a page is full, its
 * last ledger may be cut in half, so drop that ledger and let the next page
 * (beforeLedger = its seq + 1) show it whole. Returns the rows to show and the
 * beforeLedger of the next older page (null at the end).
 */
export function pageOf(txs: TxSummary[], limit: number): { shown: TxSummary[]; olderBefore: number | null } {
  if (txs.length < limit) return { shown: txs, olderBefore: null };
  const lastSeq = txs[txs.length - 1].ledgerSeq;
  const trimmed = txs.filter((t) => t.ledgerSeq !== lastSeq);
  if (trimmed.length === 0) return { shown: txs, olderBefore: lastSeq };
  return { shown: trimmed, olderBefore: lastSeq + 1 };
}

/** "Newer" target for ledger pages: null on the first page. */
export function newerLedgerPage(before: number | undefined, pageSize: number, newest: number): number | null | 'latest' {
  if (!before) return null;
  return before + pageSize > newest ? 'latest' : before + pageSize;
}
