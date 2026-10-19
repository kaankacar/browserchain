// The auto-mode fork verdict (ARCHITECTURE 12.3): validators known at the
// fork point vouch for a branch; strictly more vouchers win. Self-reported
// weights, then the hash of the first ledger after the fork point, only
// break a tie in the counts.

import { describe, expect, it } from 'vitest';
import { decideFork, decideForkByVouchers, type BranchInfo } from './fork';

const branch = (weight: number, seq: number, first: string): BranchInfo => ({ weight, lcl: { seq, hash: `${first}${seq}`.padEnd(64, '0') }, first: first.padEnd(64, '0') });

describe('fork verdict by vouchers', () => {
  it('strictly more vouchers win, whatever the weights claim', () => {
    const ours = branch(18, 20, 'b');
    const huge = branch(1_000_000, 64, 'a');
    // three validators (us included) against two: the heavier branch loses
    expect(decideForkByVouchers({ ours: 3, theirs: 2 }, ours, huge)).toBe('ours');
    // nobody known at the fork point vouches for theirs
    expect(decideForkByVouchers({ ours: 1, theirs: 0 }, ours, huge)).toBe('ours');
    // a lighter branch with more vouchers wins
    expect(decideForkByVouchers({ ours: 1, theirs: 2 }, huge, ours)).toBe('theirs');
  });

  it('equal counts: the weights decide, then the lower hash of the first ledger after the fork point', () => {
    const heavy = branch(60, 30, 'f');
    const light = branch(12, 30, 'a');
    expect(decideForkByVouchers({ ours: 2, theirs: 2 }, heavy, light)).toBe('ours');
    expect(decideForkByVouchers({ ours: 2, theirs: 2 }, light, heavy)).toBe('theirs');
    // weights within the tolerance are a tie: the first-ledger hash decides on both sides alike
    const x = branch(30, 30, 'c');
    const y = branch(33, 31, 'd');
    expect(decideForkByVouchers({ ours: 3, theirs: 3 }, x, y)).toBe('ours');
    expect(decideForkByVouchers({ ours: 3, theirs: 3 }, y, x)).toBe('theirs');
  });

  it('without member history (null) the weights decide alone, as before', () => {
    const a = branch(14, 15, 'e');
    const b = branch(3, 4, 'a');
    expect(decideForkByVouchers(null, b, a)).toBe('theirs');
    expect(decideForkByVouchers(null, a, b)).toBe('ours');
    expect(decideForkByVouchers(null, b, a)).toBe(decideFork(b, a));
  });

  it('two sides of a fork with the same counts reach opposite, consistent verdicts', () => {
    for (const [wa, wb] of [
      [24, 27],
      [3, 40],
      [40, 3],
    ]) {
      const left = branch(wa, 20, '1');
      const right = branch(wb, 21, '2');
      const fromLeft = decideForkByVouchers({ ours: 3, theirs: 3 }, left, right);
      const fromRight = decideForkByVouchers({ ours: 3, theirs: 3 }, right, left);
      expect(fromLeft === 'ours' ? 'left' : 'right').toBe(fromRight === 'ours' ? 'right' : 'left');
    }
  });
});
