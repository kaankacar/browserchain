// Quorum analysis for the UI: fault tolerance of a quorum set and a
// brute-force quorum intersection check over the known validators.
//
// The intersection check follows the idea of stellar-core's
// QuorumIntersectionChecker (src/herder/QuorumIntersectionCheckerImpl.cpp):
// the network enjoys quorum intersection when no two quorums are disjoint.
// Nodes whose quorum set is unknown are treated as dead (never part of a
// quorum), as stellar-core does.

import type { NodeId, QuorumSet } from '../scp/types';

/** Max number of nodes the brute-force check handles (2^16 subsets). */
export const MAX_INTERSECTION_NODES = 16;

export type IntersectionResult = 'ok' | 'broken' | 'unknown';

/**
 * Smallest number of distinct validators whose failure blocks every slice of
 * q (assumes no validator appears twice). 0 when q can never be satisfied.
 */
export function minBlockingSize(q: QuorumSet): number {
  const n = q.validators.length + q.innerSets.length;
  if (q.threshold <= 0) return Infinity;
  if (q.threshold > n) return 0;
  const costs = [...q.validators.map(() => 1), ...q.innerSets.map(minBlockingSize)].sort((a, b) => a - b);
  const need = n - q.threshold + 1;
  let sum = 0;
  for (let i = 0; i < need; i++) sum += costs[i];
  return sum;
}

/** Max number of validators of q that may fail while q stays satisfiable. */
export function faultTolerance(q: QuorumSet): number {
  const b = minBlockingSize(q);
  if (!Number.isFinite(b)) return 0;
  return Math.max(0, b - 1);
}

/** All validators reachable from `root` through the known quorum sets. */
export function transitiveNodes(root: NodeId, qsets: ReadonlyMap<NodeId, QuorumSet | null>): NodeId[] {
  const seen = new Set<NodeId>([root]);
  const queue: NodeId[] = [root];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const q = qsets.get(id);
    if (!q) continue;
    const walk = (s: QuorumSet): void => {
      for (const v of s.validators) {
        if (!seen.has(v)) {
          seen.add(v);
          queue.push(v);
        }
      }
      for (const inner of s.innerSets) walk(inner);
    };
    walk(q);
  }
  return [...seen];
}

type SliceFn = (mask: number) => boolean;

function compileQSet(q: QuorumSet, bit: ReadonlyMap<NodeId, number>): SliceFn {
  const vbits: number[] = [];
  for (const v of q.validators) {
    const b = bit.get(v);
    if (b !== undefined) vbits.push(b);
  }
  const inner = q.innerSets.map((s) => compileQSet(s, bit));
  const threshold = q.threshold;
  return (mask) => {
    if (threshold <= 0) return false;
    let count = 0;
    for (const b of vbits) {
      if (mask & (1 << b)) {
        count++;
        if (count >= threshold) return true;
      }
    }
    for (const f of inner) {
      if (f(mask)) {
        count++;
        if (count >= threshold) return true;
      }
    }
    return false;
  };
}

/**
 * Do all quorums of the network (as far as we know it) intersect?
 * `qsets` maps node ids to their quorum sets (null = unknown). Only the nodes
 * reachable from `root` are considered. 'unknown' when they are more than
 * MAX_INTERSECTION_NODES or `root` has no quorum set.
 */
export function checkQuorumIntersection(
  root: NodeId,
  qsets: ReadonlyMap<NodeId, QuorumSet | null>,
): IntersectionResult {
  if (!qsets.get(root)) return 'unknown';
  const nodes = transitiveNodes(root, qsets).filter((id) => qsets.get(id));
  const n = nodes.length;
  if (n > MAX_INTERSECTION_NODES) return 'unknown';
  if (n === 0) return 'unknown';
  const bit = new Map<NodeId, number>(nodes.map((id, i) => [id, i]));
  const slice = nodes.map((id) => compileQSet(qsets.get(id)!, bit));
  const full = (1 << n) - 1;
  const size = 1 << n;

  // quorum[m]: every member of m has a slice inside m
  const quorum = new Uint8Array(size);
  for (let m = 1; m <= full; m++) {
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      if (m & (1 << i) && !slice[i](m)) ok = false;
    }
    quorum[m] = ok ? 1 : 0;
  }
  // contains[m]: some non-empty subset of m is a quorum
  const contains = new Uint8Array(size);
  for (let m = 1; m <= full; m++) {
    if (quorum[m]) {
      contains[m] = 1;
      continue;
    }
    for (let i = 0; i < n; i++) {
      if (m & (1 << i) && contains[m & ~(1 << i)]) {
        contains[m] = 1;
        break;
      }
    }
  }
  for (let m = 1; m <= full; m++) {
    if (quorum[m] && contains[full & ~m]) return 'broken';
  }
  return 'ok';
}
