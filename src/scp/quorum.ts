// Ported from stellar-core (Apache-2.0): src/scp/QuorumSetUtils.cpp, src/scp/LocalNode.cpp,
// and SCPDriver::getNodeWeight from src/scp/SCPDriver.cpp.
//
// Quorum set utilities: sanity checks, normalization, slice / v-blocking /
// quorum tests, closest v-blocking set and the classic nomination weight.

import type { Envelope, NodeId, QuorumSet, Statement } from './types';

/** level = 0 when there is no nesting. */
export const MAXIMUM_QUORUM_NESTING_LEVEL = 4;

export const UINT32_MAX = 0xffffffff;
export const UINT64_MAX = (1n << 64n) - 1n;

export type NodeSet = ReadonlySet<NodeId> | readonly NodeId[];
export type StatementFilter = (st: Statement) => boolean;
export type QSetLookup = (st: Statement) => QuorumSet | null;

function asSet(nodes: NodeSet): ReadonlySet<NodeId> {
  return nodes instanceof Set ? nodes : new Set(nodes as readonly NodeId[]);
}

// ---------------------------------------------------------------------------
// Node id ordering

// Rank of a StrKey base32 digit (A-Z = 0..25, 2-7 = 26..31). Other characters
// sort after all digits, by code unit.
function b32Rank(c: number): number {
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 50 && c <= 55) return c - 24;
  return 32 + c;
}

/**
 * Total order on node ids that matches stellar-core's PublicKey order (raw
 * key bytes) for valid G... StrKeys: base32 is big-endian, so comparing digit
 * values compares the encoded bytes (version byte, then the key).
 */
export function compareNodeIds(a: NodeId, b: NodeId): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = b32Rank(a.charCodeAt(i));
    const y = b32Rank(b.charCodeAt(i));
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function sortNodeIds(ids: Iterable<NodeId>): NodeId[] {
  return [...ids].sort(compareNodeIds);
}

// ---------------------------------------------------------------------------
// QuorumSetUtils

export function cloneQSet(q: QuorumSet): QuorumSet {
  return { threshold: q.threshold, validators: [...q.validators], innerSets: q.innerSets.map(cloneQSet) };
}

/** Structural equality (same order). */
export function qsetEquals(a: QuorumSet, b: QuorumSet): boolean {
  if (a.threshold !== b.threshold) return false;
  if (a.validators.length !== b.validators.length || a.innerSets.length !== b.innerSets.length) return false;
  for (let i = 0; i < a.validators.length; i++) if (a.validators[i] !== b.validators[i]) return false;
  for (let i = 0; i < a.innerSets.length; i++) if (!qsetEquals(a.innerSets[i], b.innerSets[i])) return false;
  return true;
}

/**
 * QuorumSetSanityChecker. Returns null when the set is sane, else the error.
 * extraChecks also requires each threshold to be at least the v-blocking size.
 */
export function checkQuorumSetSanity(qSet: QuorumSet, extraChecks = false): string | null {
  const knownNodes = new Set<NodeId>();
  let count = 0;

  const checkSanity = (q: QuorumSet, depth: number): string | null => {
    if (depth > MAXIMUM_QUORUM_NESTING_LEVEL) return 'Maximum quorum nesting level exceeded';
    if (
      q === null ||
      typeof q !== 'object' ||
      !Array.isArray(q.validators) ||
      !Array.isArray(q.innerSets) ||
      !Number.isInteger(q.threshold) ||
      q.threshold > UINT32_MAX
    ) {
      return 'Malformed quorum set';
    }
    if (q.threshold < 1) return 'Threshold must be greater than 0';

    const v = q.validators;
    const i = q.innerSets;
    const totEntries = v.length + i.length;
    const vBlockingSize = totEntries - q.threshold + 1;
    count += v.length;

    if (q.threshold > totEntries) return 'Threshold exceeds total number of entries';

    // threshold is within the proper range
    if (extraChecks && q.threshold < vBlockingSize) {
      return 'Threshold is lower than the v-blocking size (< 51%).';
    }

    for (const n of v) {
      if (typeof n !== 'string') return 'Malformed quorum set';
      if (knownNodes.has(n)) return 'Duplicate node found in quorum configuration';
      knownNodes.add(n);
    }

    for (const iSet of i) {
      const err = checkSanity(iSet, depth + 1);
      if (err !== null) return err;
    }
    return null;
  };

  const err = checkSanity(qSet, 0);
  if (err !== null) return err;
  if (count < 1 || count > 1000) return 'Total number of nodes in a quorum must be within 1 and 1000';
  return null;
}

export function isQuorumSetSane(qSet: QuorumSet, extraChecks = false): boolean {
  return checkQuorumSetSanity(qSet, extraChecks) === null;
}

// normalizeQSetSimplify: removes idToRemove (lowering thresholds), merges
// singleton inner sets into the validator list and unwraps { t: 1, { inner } }.
function normalizeQSetSimplify(qSet: QuorumSet, idToRemove: NodeId | null): void {
  if (idToRemove !== null) {
    const before = qSet.validators.length;
    qSet.validators = qSet.validators.filter((n) => n !== idToRemove);
    // uint32 arithmetic, as in stellar-core
    qSet.threshold = (qSet.threshold - (before - qSet.validators.length)) >>> 0;
  }

  const inner = qSet.innerSets;
  let idx = 0;
  while (idx < inner.length) {
    const it = inner[idx];
    normalizeQSetSimplify(it, idToRemove);
    // merge singleton inner sets into validator list
    if (it.threshold === 1 && it.validators.length === 1 && it.innerSets.length === 0) {
      qSet.validators.push(it.validators[0]);
      inner.splice(idx, 1);
    } else {
      idx++;
    }
  }

  // simplify quorum set if needed
  if (qSet.threshold === 1 && qSet.validators.length === 0 && qSet.innerSets.length === 1) {
    const t = qSet.innerSets[qSet.innerSets.length - 1];
    qSet.threshold = t.threshold;
    qSet.validators = t.validators;
    qSet.innerSets = t.innerSets;
  }
}

function lexCompare<T>(a: readonly T[], b: readonly T[], cmp: (x: T, y: T) => number): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** qSetCompareInt: validators, then inner sets, then threshold. */
export function qSetCompare(l: QuorumSet, r: QuorumSet): number {
  let res = lexCompare(l.validators, r.validators, compareNodeIds);
  if (res !== 0) return res;
  res = lexCompare(l.innerSets, r.innerSets, qSetCompare);
  if (res !== 0) return res;
  return l.threshold < r.threshold ? -1 : l.threshold === r.threshold ? 0 : 1;
}

function normalizeQuorumSetReorder(qset: QuorumSet): void {
  qset.validators.sort(compareNodeIds);
  for (const qs of qset.innerSets) normalizeQuorumSetReorder(qs);
  // now, we can reorder the inner sets
  qset.innerSets.sort(qSetCompare);
}

/**
 * normalizeQSet. Unlike stellar-core (which edits in place) this returns a
 * normalized deep copy, optionally without idToRemove.
 */
export function normalizeQSet(qSet: QuorumSet, idToRemove: NodeId | null = null): QuorumSet {
  const q = cloneQSet(qSet);
  normalizeQSetSimplify(q, idToRemove);
  normalizeQuorumSetReorder(q);
  return q;
}

// ---------------------------------------------------------------------------
// LocalNode statics

/** LocalNode::buildSingletonQSet: { t: 1, [nodeId] }. */
export function singletonQSet(nodeId: NodeId): QuorumSet {
  return { threshold: 1, validators: [nodeId], innerSets: [] };
}

/** LocalNode::forAllNodes: runs proc over all nodes, stops when proc returns false. */
export function forAllNodes(qset: QuorumSet, proc: (n: NodeId) => boolean): boolean {
  for (const n of qset.validators) {
    if (!proc(n)) return false;
  }
  for (const q of qset.innerSets) {
    if (!forAllNodes(q, proc)) return false;
  }
  return true;
}

/** All distinct nodes of a quorum set, in first-seen order. */
export function qsetNodes(qset: QuorumSet): NodeId[] {
  const out = new Set<NodeId>();
  forAllNodes(qset, (n) => {
    out.add(n);
    return true;
  });
  return [...out];
}

function isQuorumSliceInternal(qset: QuorumSet, nodeSet: ReadonlySet<NodeId>): boolean {
  // uint32 counter, as in stellar-core (a threshold of 0 never matches)
  let thresholdLeft = qset.threshold >>> 0;
  for (const validator of qset.validators) {
    if (nodeSet.has(validator)) {
      thresholdLeft = (thresholdLeft - 1) >>> 0;
      if (thresholdLeft === 0) return true;
    }
  }
  for (const inner of qset.innerSets) {
    if (isQuorumSliceInternal(inner, nodeSet)) {
      thresholdLeft = (thresholdLeft - 1) >>> 0;
      if (thresholdLeft === 0) return true;
    }
  }
  return false;
}

/** LocalNode::isQuorumSlice: does nodeSet satisfy qSet? */
export function isQuorumSlice(qSet: QuorumSet, nodeSet: NodeSet): boolean {
  return isQuorumSliceInternal(qSet, asSet(nodeSet));
}

function isVBlockingInternal(qset: QuorumSet, nodeSet: ReadonlySet<NodeId>): boolean {
  // There is no v-blocking set for {\empty}
  if (qset.threshold === 0) return false;

  let leftTillBlock = 1 + qset.validators.length + qset.innerSets.length - qset.threshold;

  for (const validator of qset.validators) {
    if (nodeSet.has(validator)) {
      leftTillBlock--;
      if (leftTillBlock <= 0) return true;
    }
  }
  for (const inner of qset.innerSets) {
    if (isVBlockingInternal(inner, nodeSet)) {
      leftTillBlock--;
      if (leftTillBlock <= 0) return true;
    }
  }
  return false;
}

/** LocalNode::isVBlocking: does nodeSet intersect every slice of qSet? */
export function isVBlocking(qSet: QuorumSet, nodeSet: NodeSet): boolean {
  return isVBlockingInternal(qSet, asSet(nodeSet));
}

/** LocalNode::isVBlocking over latest envelopes: is the filtered set of senders v-blocking? */
export function isVBlockingSt(
  qSet: QuorumSet,
  map: ReadonlyMap<NodeId, Envelope>,
  filter: StatementFilter = () => true,
): boolean {
  const pNodes = new Set<NodeId>();
  for (const [id, env] of map) {
    if (filter(env.statement)) pNodes.add(id);
  }
  return isVBlockingInternal(qSet, pNodes);
}

/**
 * LocalNode::isQuorum: do the filtered senders contain a quorum for qSet?
 * Each member must have a slice (from qfun of its own statement) inside the set.
 */
export function isQuorum(
  qSet: QuorumSet,
  map: ReadonlyMap<NodeId, Envelope>,
  qfun: QSetLookup,
  filter: StatementFilter = () => true,
): boolean {
  let pNodes: NodeId[] = [];
  for (const [id, env] of map) {
    if (filter(env.statement)) pNodes.push(id);
  }

  let count: number;
  do {
    count = pNodes.length;
    const current = new Set(pNodes);
    pNodes = pNodes.filter((nodeId) => {
      const q = qfun(map.get(nodeId)!.statement);
      return q !== null ? isQuorumSliceInternal(q, current) : false;
    });
  } while (count !== pNodes.length);

  return isQuorumSliceInternal(qSet, new Set(pNodes));
}

/**
 * LocalNode::findClosestVBlocking: the smallest set of nodes from `nodes`
 * (nodes that agree but can fail) whose failure would make the rest unable to
 * block qset. Empty when the nodes outside `nodes` are already v-blocking.
 */
export function findClosestVBlocking(
  qset: QuorumSet,
  nodes: ReadonlySet<NodeId>,
  excluded: NodeId | null = null,
): NodeId[] {
  let leftTillBlock = 1 + qset.validators.length + qset.innerSets.length - qset.threshold;

  let res: NodeId[] = [];

  // first, compute how many top level items need to be blocked
  for (const validator of qset.validators) {
    if (excluded === null || validator !== excluded) {
      if (!nodes.has(validator)) {
        leftTillBlock--;
        if (leftTillBlock === 0) {
          // already blocked
          return [];
        }
      } else {
        // save this for later
        res.push(validator);
      }
    }
  }

  const resInternals: NodeId[][] = [];
  for (const inner of qset.innerSets) {
    const v = findClosestVBlocking(inner, nodes, excluded);
    if (v.length === 0) {
      leftTillBlock--;
      if (leftTillBlock === 0) {
        // already blocked
        return [];
      }
    } else {
      resInternals.push(v);
    }
  }
  // multiset ordered by size (stable for equal sizes)
  resInternals.sort((a, b) => a.length - b.length);

  // use the top level validators to get closer
  if (res.length > leftTillBlock) res = res.slice(0, Math.max(0, leftTillBlock));
  leftTillBlock -= res.length;

  // use subsets to get closer, using the smallest ones first
  let k = 0;
  while (leftTillBlock !== 0 && k < resInternals.length) {
    res.push(...resInternals[k]);
    leftTillBlock--;
    k++;
  }
  return res;
}

/** findClosestVBlocking over latest envelopes (nodes = filtered senders). */
export function findClosestVBlockingSt(
  qset: QuorumSet,
  map: ReadonlyMap<NodeId, Envelope>,
  filter: StatementFilter = () => true,
  excluded: NodeId | null = null,
): NodeId[] {
  const s = new Set<NodeId>();
  for (const [id, env] of map) {
    if (filter(env.statement)) s.add(id);
  }
  return findClosestVBlocking(qset, s, excluded);
}

// ---------------------------------------------------------------------------
// Nomination weight (SCPDriver::getNodeWeight)

// m * threshold / total rounded up (bigDivideUnsigned with ROUND_UP).
function computeWeight(m: bigint, total: bigint, threshold: bigint): bigint {
  const t = threshold > total ? total : threshold;
  if (total === 0n) return 0n;
  return (m * t + total - 1n) / total;
}

/**
 * The weight of nodeId within qset, normalized to 0..UINT64_MAX: the
 * fraction of quorum slices that contain it. The local node is in all of its
 * slices. A repeated validator only counts its first occurrence.
 */
export function getNodeWeight(nodeId: NodeId, qset: QuorumSet, isLocalNode: boolean): bigint {
  if (isLocalNode) {
    // local node is in all quorum sets
    return UINT64_MAX;
  }

  const n = BigInt(qset.threshold);
  const d = BigInt(qset.innerSets.length + qset.validators.length);

  for (const qsetNode of qset.validators) {
    if (qsetNode === nodeId) return computeWeight(UINT64_MAX, d, n);
  }

  for (const q of qset.innerSets) {
    const leafW = getNodeWeight(nodeId, q, isLocalNode);
    if (leafW > 0n) return computeWeight(leafW, d, n);
  }

  return 0n;
}
