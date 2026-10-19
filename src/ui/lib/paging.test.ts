import { describe, expect, it } from 'vitest';
import type { TxSummary } from '../../node/api';
import { newerLedgerPage, pageOf } from './paging';

const tx = (hash: string, ledgerSeq: number) => ({ hash, ledgerSeq }) as TxSummary;

describe('paging', () => {
  it('keeps short pages and marks the end', () => {
    expect(pageOf([tx('a', 9), tx('b', 8)], 5)).toEqual({ shown: [tx('a', 9), tx('b', 8)], olderBefore: null });
  });
  it('moves a cut ledger to the next page', () => {
    const page = [tx('a', 9), tx('b', 9), tx('c', 8), tx('d', 7)];
    expect(pageOf(page, 4)).toEqual({ shown: [tx('a', 9), tx('b', 9), tx('c', 8)], olderBefore: 8 });
  });
  it('does not loop on one huge ledger', () => {
    const page = [tx('a', 9), tx('b', 9)];
    expect(pageOf(page, 2)).toEqual({ shown: page, olderBefore: 9 });
  });
  it('computes the newer ledger page', () => {
    expect(newerLedgerPage(undefined, 20, 100)).toBeNull();
    expect(newerLedgerPage(50, 20, 100)).toBe(70);
    expect(newerLedgerPage(90, 20, 100)).toBe('latest');
  });
});
