import { describe, expect, it } from 'vitest';
import type { QuorumSetView } from '../../node/api';
import {
  autoThreshold,
  canonicalQset,
  checkIntersection,
  describeQset,
  faultTolerance,
  isSliceSatisfied,
  maxQuorumWithin,
  minBlockingSize,
  qsetValidators,
  validateQset,
} from './quorum';

const q = (threshold: number, validators: string[], innerSets: QuorumSetView[] = []): QuorumSetView => ({ threshold, validators, innerSets });

describe('quorum set helpers', () => {
  it('computes auto thresholds like the herder (ceil 2n/3)', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(autoThreshold)).toEqual([1, 2, 2, 3, 4, 4, 5]);
    expect(autoThreshold(0)).toBe(1);
  });

  it('checks slices, including nested sets', () => {
    const nested = q(2, ['A'], [q(2, ['B', 'C', 'D'])]);
    expect(isSliceSatisfied(nested, new Set(['A', 'B', 'C']))).toBe(true);
    expect(isSliceSatisfied(nested, new Set(['A', 'B']))).toBe(false);
    expect(isSliceSatisfied(nested, new Set(['B', 'C', 'D']))).toBe(false);
  });

  it('lists validators uniquely', () => {
    expect(qsetValidators(q(1, ['A', 'B'], [q(1, ['B', 'C'])]))).toEqual(['A', 'B', 'C']);
  });

  it('computes v-blocking size and fault tolerance', () => {
    expect(minBlockingSize(q(3, ['A', 'B', 'C', 'D']))).toBe(2);
    expect(faultTolerance(q(3, ['A', 'B', 'C', 'D']))).toBe(1);
    expect(faultTolerance(q(4, ['A', 'B', 'C', 'D']))).toBe(0);
    expect(faultTolerance(q(1, ['A', 'B', 'C']))).toBe(2);
    // 2 of {A, {2 of B,C,D}} needs both entries, so A alone blocks it.
    const nested = q(2, ['A'], [q(2, ['B', 'C', 'D'])]);
    expect(minBlockingSize(nested)).toBe(1);
    expect(faultTolerance(nested)).toBe(0);
    const wide = q(2, [], [q(2, ['A', 'B', 'C']), q(2, ['D', 'E', 'F']), q(2, ['G', 'H', 'I'])]);
    expect(minBlockingSize(wide)).toBe(4);
    expect(faultTolerance(wide)).toBe(3);
    expect(faultTolerance(q(5, ['A', 'B']))).toBe(0);
  });

  it('validates sets', () => {
    expect(validateQset(q(2, ['A', 'B', 'C']))).toEqual([]);
    expect(validateQset(q(0, ['A']))[0]).toMatch(/at least 1/);
    expect(validateQset(q(3, ['A', 'B']))[0]).toMatch(/above/);
    expect(validateQset(q(1, []))[0]).toMatch(/add at least one/);
    expect(validateQset(q(1, ['A'], [q(1, ['A'])]))).toContain('A validator appears more than once.');
    const deep = q(1, [], [q(1, [], [q(1, [], [q(1, [], [q(1, ['Z'])])])])]);
    expect(validateQset(deep).some((e) => /nest/.test(e))).toBe(true);
  });

  it('describes and canonicalizes', () => {
    expect(describeQset(q(2, ['A', 'B'], [q(1, ['C'])]))).toBe('2 of 3');
    expect(canonicalQset(q(1, ['B', 'A']))).toEqual(q(1, ['A', 'B']));
  });
});

describe('quorum intersection', () => {
  const all = ['A', 'B', 'C', 'D'];
  it('finds the largest quorum inside a set', () => {
    const qsets = new Map(all.map((v) => [v, q(3, all)]));
    expect([...maxQuorumWithin(new Set(all), qsets)].sort()).toEqual(all);
    expect(maxQuorumWithin(new Set(['A', 'B']), qsets).size).toBe(0);
  });

  it('accepts a 3-of-4 network', () => {
    const qsets = new Map(all.map((v) => [v, q(3, all)]));
    expect(checkIntersection(qsets)).toBe('ok');
  });

  it('flags a 2-of-4 network (two disjoint quorums)', () => {
    const qsets = new Map(all.map((v) => [v, q(2, all)]));
    expect(checkIntersection(qsets)).toBe('broken');
  });

  it('flags a node that trusts only itself', () => {
    const qsets = new Map(all.map((v) => [v, q(3, all)]));
    qsets.set('A', q(1, ['A']));
    expect(checkIntersection(qsets)).toBe('broken');
  });

  it('accepts a tiered network with an organization structure', () => {
    const orgs = [q(2, ['A1', 'A2', 'A3']), q(2, ['B1', 'B2', 'B3']), q(2, ['C1', 'C2', 'C3'])];
    const top = q(2, [], orgs);
    const ids = orgs.flatMap((o) => o.validators);
    const qsets = new Map(ids.map((id) => [id, top]));
    expect(checkIntersection(qsets)).toBe('ok');
  });

  it('gives up on very large networks', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `N${i}`);
    const qsets = new Map(ids.map((id) => [id, q(14, ids)]));
    expect(checkIntersection(qsets)).toBe('unknown');
    expect(checkIntersection(new Map())).toBe('unknown');
  });
});
