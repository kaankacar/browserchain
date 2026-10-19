// Quorum set helpers for display, the manual editor and the mock node.

import type { QuorumSetView } from '../../node/api';

/** stellar-core MAXIMUM_QUORUM_NESTING_LEVEL. */
export const MAX_QSET_NESTING = 4;

export function qsetEntryCount(q: QuorumSetView): number {
  return q.validators.length + q.innerSets.length;
}

/** All validators in the set, nested ones included, unique, in first-seen order. */
export function qsetValidators(q: QuorumSetView): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (s: QuorumSetView) => {
    for (const v of s.validators) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    for (const inner of s.innerSets) walk(inner);
  };
  walk(q);
  return out;
}

/** True when `available` contains a slice of q. */
export function isSliceSatisfied(q: QuorumSetView, available: ReadonlySet<string>): boolean {
  let count = 0;
  for (const v of q.validators) if (available.has(v)) count++;
  for (const inner of q.innerSets) if (isSliceSatisfied(inner, available)) count++;
  return count >= q.threshold;
}

/**
 * Smallest number of validator failures that makes q unsatisfiable (the
 * smallest v-blocking set), assuming no validator appears twice.
 */
export function minBlockingSize(q: QuorumSetView): number {
  const n = qsetEntryCount(q);
  if (q.threshold <= 0) return Infinity;
  if (q.threshold > n) return 0;
  const costs = [...q.validators.map(() => 1), ...q.innerSets.map(minBlockingSize)].sort((a, b) => a - b);
  const need = n - q.threshold + 1;
  let sum = 0;
  for (let i = 0; i < need; i++) sum += costs[i];
  return sum;
}

/** Max validators of this set that may fail while the set stays satisfiable. */
export function faultTolerance(q: QuorumSetView): number {
  const b = minBlockingSize(q);
  if (!Number.isFinite(b)) return qsetValidators(q).length;
  return Math.max(0, b - 1);
}

/** Problems with a quorum set, empty when it is sane. */
export function validateQset(q: QuorumSetView, depth = 0): string[] {
  const errors: string[] = [];
  const n = qsetEntryCount(q);
  const where = depth === 0 ? 'Top level' : `Inner set (level ${depth + 1})`;
  if (depth >= MAX_QSET_NESTING) errors.push(`Sets can nest at most ${MAX_QSET_NESTING} levels.`);
  if (n === 0) errors.push(`${where}: add at least one validator or inner set.`);
  if (!Number.isInteger(q.threshold) || q.threshold < 1) errors.push(`${where}: threshold must be at least 1.`);
  else if (q.threshold > n) errors.push(`${where}: threshold ${q.threshold} is above its ${n} entries.`);
  for (const inner of q.innerSets) errors.push(...validateQset(inner, depth + 1));
  if (depth === 0) {
    const all: string[] = [];
    const walk = (s: QuorumSetView) => {
      all.push(...s.validators);
      s.innerSets.forEach(walk);
    };
    walk(q);
    const dup = all.filter((v, i) => all.indexOf(v) !== i);
    if (dup.length) errors.push('A validator appears more than once.');
  }
  return errors;
}

/** Simple majority-style threshold used by auto mode: max(1, ceil(2n/3)). */
export function autoThreshold(n: number): number {
  return Math.max(1, Math.ceil((2 * n) / 3));
}

/** Short text: "3 of 4" (+ inner sets). */
export function describeQset(q: QuorumSetView): string {
  const n = qsetEntryCount(q);
  return `${q.threshold} of ${n}`;
}

export function cloneQset(q: QuorumSetView): QuorumSetView {
  return { threshold: q.threshold, validators: [...q.validators], innerSets: q.innerSets.map(cloneQset) };
}

/** Canonical JSON for hashing/comparison (validators sorted, inner sets sorted). */
export function canonicalQset(q: QuorumSetView): QuorumSetView {
  const inner = q.innerSets.map(canonicalQset);
  inner.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return { threshold: q.threshold, validators: [...q.validators].sort(), innerSets: inner };
}

/** Largest subset of `set` in which every member has a slice. */
export function maxQuorumWithin(set: ReadonlySet<string>, qsets: ReadonlyMap<string, QuorumSetView>): Set<string> {
  const cur = new Set(set);
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of [...cur]) {
      const q = qsets.get(v);
      if (!q || !isSliceSatisfied(q, cur)) {
        cur.delete(v);
        changed = true;
      }
    }
  }
  return cur;
}

/**
 * Quorum intersection by brute force: the network is "broken" when two
 * disjoint quorums exist. Nodes without a known qset cannot be in a quorum.
 * Every split {A, B} with node 0 in A is tested, which finds any disjoint
 * pair. Returns 'unknown' above `maxNodes` (2^n subsets).
 */
export function checkIntersection(
  qsets: ReadonlyMap<string, QuorumSetView>,
  maxNodes = 14,
): 'ok' | 'broken' | 'unknown' {
  const nodes = [...qsets.keys()].sort();
  const n = nodes.length;
  if (n === 0) return 'unknown';
  if (n > maxNodes) return 'unknown';
  const total = 1 << n;
  for (let mask = 1; mask < total - 1; mask++) {
    // Only test each split once: require the lowest node to be in the first half.
    if ((mask & 1) === 0) continue;
    const a = new Set<string>();
    const b = new Set<string>();
    for (let i = 0; i < n; i++) (mask & (1 << i) ? a : b).add(nodes[i]);
    if (maxQuorumWithin(a, qsets).size > 0 && maxQuorumWithin(b, qsets).size > 0) return 'broken';
  }
  return 'ok';
}
