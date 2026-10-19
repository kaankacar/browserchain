// Ported from stellar-core (Apache-2.0): src/scp/test/QuorumSetTests.cpp ("sane
// quorum set") and src/scp/test/SCPTests.cpp ("vblocking and quorum", "v
// blocking distance"), plus nested and transitive quorum cases.

import { StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { compareBytes, fromHex } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import { seededRng } from '../lib/random';
import {
  MAXIMUM_QUORUM_NESTING_LEVEL,
  checkQuorumSetSanity,
  compareNodeIds,
  findClosestVBlocking,
  findClosestVBlockingSt,
  forAllNodes,
  isQuorum,
  isQuorumSetSane,
  isQuorumSlice,
  isVBlocking,
  isVBlockingSt,
  normalizeQSet,
  qSetCompare,
  qsetNodes,
  singletonQSet,
  sortNodeIds,
} from './quorum';
import { makeNominate, makePrepare, nodeId } from './testkit';
import type { Envelope, Hash, NodeId, QuorumSet } from './types';
import { hashQuorumSet } from './xdr';

const Q = (threshold: number, validators: NodeId[], innerSets: QuorumSet[] = []): QuorumSet => ({
  threshold,
  validators,
  innerSets,
});

// Public keys from seeds without key derivation (fast; any 32 bytes is a valid StrKey).
const makePublicKey = (i: number): NodeId => StrKey.encodeEd25519PublicKey(sha256(`NODE_SEED_${i}`));

describe('node id order', () => {
  it('matches the raw public key byte order (stellar-core PublicKey order)', () => {
    const rng = seededRng(7);
    const keys: NodeId[] = [];
    for (let i = 0; i < 300; i++) {
      const raw = new Uint8Array(32);
      for (let j = 0; j < 32; j++) raw[j] = Math.floor(rng() * 256);
      // force common prefixes now and then
      if (i % 3 === 0) raw.fill(0, 0, 10);
      keys.push(StrKey.encodeEd25519PublicKey(raw));
    }
    const byBytes = [...keys].sort((a, b) =>
      compareBytes(StrKey.decodeEd25519PublicKey(a), StrKey.decodeEd25519PublicKey(b)),
    );
    expect(sortNodeIds(keys)).toEqual(byBytes);
    // plain string order differs (base32 digits 2-7 sort before A-Z in ASCII)
    expect([...keys].sort()).not.toEqual(byBytes);
    expect(compareNodeIds(keys[0], keys[0])).toBe(0);
  });
});

describe('sane quorum set (QuorumSetTests.cpp)', () => {
  const keys: NodeId[] = [];
  for (let i = 0; i < 1001; i++) keys.push(makePublicKey(i));
  keys.sort(compareNodeIds);

  const makeSingleton = (key: NodeId): QuorumSet => Q(1, [key]);

  const check = (qSetCheck: QuorumSet, expected: boolean, expectedSelfQSet: QuorumSet) => {
    // first, without normalization
    expect(isQuorumSetSane(qSetCheck, false)).toBe(expected);

    // secondary test: normalize the set (as the local node does)
    const normalizedQSet = normalizeQSet(qSetCheck);
    expect(isQuorumSetSane(qSetCheck, false)).toBe(expected);
    expect(normalizedQSet).toEqual(expectedSelfQSet);
  };

  it('{ t: 0 }', () => {
    const qSet = Q(0, []);
    check(qSet, false, qSet);
  });

  const validOneNode = makeSingleton(keys[0]);

  it('{ t: 0, v0 }', () => {
    const qSet = { ...validOneNode, threshold: 0 };
    check(qSet, false, qSet);
  });

  it('{ t: 2, v0 }', () => {
    const qSet = { ...validOneNode, threshold: 2 };
    check(qSet, false, qSet);
  });

  it('{ t: 1, v0 }', () => {
    check(validOneNode, true, validOneNode);
  });

  it('{ t: 1, v0, { t: 1, v1 } -> { t:1, v0, v1 }', () => {
    const qSet = Q(1, [keys[0]], [Q(1, [keys[1]])]);
    const qSelfSet = Q(1, [keys[0], keys[1]]);
    check(qSet, true, qSelfSet);
  });

  it('{ t: 1, v0, { t: 1, v1 }, { t: 2, v2 } } -> { t:1, v0, v2, { t: 2, v1 } }', () => {
    const qSet = Q(1, [keys[0]], [Q(2, [keys[1]]), Q(1, [keys[2]])]);
    const qSelfSet = Q(1, [keys[0], keys[2]], [Q(2, [keys[1]])]);
    check(qSet, false, qSelfSet);
  });

  const validMultipleNodes = Q(1, [keys[0]], [Q(1, [keys[1]]), Q(1, [keys[2], keys[3]])]);
  const validMultipleNodesNormalized = Q(1, [keys[0], keys[1]], [Q(1, [keys[2], keys[3]])]);

  it('{ t: 1, v0, { t: 1, v1 }, { t: 1, v2, v3 } } -> { t:1, v0, v1, { t: 1, v2, v3 } }', () => {
    check(validMultipleNodes, true, validMultipleNodesNormalized);
  });

  it('{ t: 1, { t: 1, v0, { t: 1, v1 }, { t: 1, v2, v3 } } } -> { t:1, v0, v1, { t: 1, v2, v3 } }', () => {
    const containingSet = Q(1, [], [validMultipleNodes]);
    check(containingSet, true, validMultipleNodesNormalized);
  });

  it('{ t: 1, v0, { t: 1, v1, { t: 1, v2 , {t: 1, v3} } } } -> { t: 1, v0, { t: 1, v1, { t:1, v2, v3} } }', () => {
    const qSet3 = makeSingleton(keys[3]);
    const qSet2 = Q(1, [keys[2]], [qSet3]);
    const qSet1 = Q(1, [keys[1]], [qSet2]);
    const qSet = Q(1, [keys[0]], [qSet1]);

    // normalized: v3 gets moved next to v2
    const qSelfSet = Q(1, [keys[0]], [Q(1, [keys[1]], [Q(1, [keys[2], keys[3]])])]);
    check(qSet, true, qSelfSet);
  });

  const testNestingLevel = (nestingLevel: number, expected: boolean) => {
    // build { t: 1, k0, { t: 1, k1, { ... { t: 1, k_n } } } }
    let qSet: QuorumSet = makeSingleton(keys[nestingLevel]);
    for (let i = nestingLevel - 1; i >= 0; i--) qSet = Q(1, [keys[i]], [qSet]);

    // normalized: the last singleton merges into its parent
    let qSelfSet: QuorumSet = Q(1, [keys[nestingLevel - 1], keys[nestingLevel]]);
    for (let i = nestingLevel - 2; i >= 0; i--) qSelfSet = Q(1, [keys[i]], [qSelfSet]);

    check(qSet, expected, qSelfSet);
  };

  it('{ t: 1, v0, { t: 1, v1, { .. t: 1, v_{MAXIMUM_QUORUM_NESTING_LEVEL + 1} }..} -> too deep', () => {
    testNestingLevel(MAXIMUM_QUORUM_NESTING_LEVEL + 1, false);
    expect(checkQuorumSetSanity(Q(1, [keys[0]], [Q(1, [keys[1]], [Q(1, [keys[2]], [Q(1, [keys[3]], [Q(1, [keys[4]], [Q(1, [keys[5]])])])])])]))).toBe(
      'Maximum quorum nesting level exceeded',
    );
  });

  it('{ t: 1, v0, { t: 1, v1, { .. t: 1, v_MAXIMUM_QUORUM_NESTING_LEVEL }..}', () => {
    testNestingLevel(MAXIMUM_QUORUM_NESTING_LEVEL, true);
  });

  it('{ t: 1, v0..v999 } -> { t: 1, v0..v999 }', () => {
    const qSet = Q(1, keys.slice(0, 1000));
    check(qSet, true, qSet);
  });

  it('{ t: 1, v0..v1000 } -> too big', () => {
    const qSet = Q(1, keys.slice(0, 1001));
    check(qSet, false, qSet);
    expect(checkQuorumSetSanity(qSet)).toBe('Total number of nodes in a quorum must be within 1 and 1000');
  });

  it('{ t: 1, v0, { t: 1, v1..v100 }, { t: 1, v101..v200} ... { t: 1, v901..v1000} -> too big', () => {
    const inner: QuorumSet[] = [];
    for (let i = 0; i < 10; i++) inner.push(Q(1, keys.slice(i * 100 + 1, (i + 1) * 100 + 1)));
    const qSet = Q(1, [keys[0]], inner);
    check(qSet, false, qSet);
  });

  it('duplicates, thresholds and extra checks', () => {
    expect(checkQuorumSetSanity(Q(1, [keys[0], keys[0]]))).toBe('Duplicate node found in quorum configuration');
    expect(checkQuorumSetSanity(Q(1, [keys[0]], [Q(1, [keys[0]])]))).toBe('Duplicate node found in quorum configuration');
    expect(checkQuorumSetSanity(Q(3, [keys[0], keys[1]]))).toBe('Threshold exceeds total number of entries');
    expect(checkQuorumSetSanity(Q(1, [keys[0]], [Q(0, [keys[1]])]))).toBe('Threshold must be greater than 0');
    // 1 of 3 is below the v-blocking size (3 - 1 + 1 = 3)
    expect(isQuorumSetSane(Q(1, [keys[0], keys[1], keys[2]]), false)).toBe(true);
    expect(checkQuorumSetSanity(Q(1, [keys[0], keys[1], keys[2]]), true)).toBe(
      'Threshold is lower than the v-blocking size (< 51%).',
    );
    expect(isQuorumSetSane(Q(2, [keys[0], keys[1], keys[2]]), true)).toBe(true);
    // malformed shapes never pass
    expect(isQuorumSetSane({ threshold: 1.5, validators: [keys[0]], innerSets: [] })).toBe(false);
    expect(isQuorumSetSane({ threshold: 1, validators: 'x', innerSets: [] } as unknown as QuorumSet)).toBe(false);
  });
});

describe('normalizeQSet', () => {
  const k = [0, 1, 2, 3, 4, 5].map(makePublicKey);
  const sorted = sortNodeIds(k);

  it('sorts validators and inner sets, never mutates its input', () => {
    const input = Q(2, [sorted[3], sorted[0]], [Q(2, [sorted[5], sorted[4]]), Q(2, [sorted[2], sorted[1]])]);
    const copy = JSON.parse(JSON.stringify(input));
    const out = normalizeQSet(input);
    expect(out).toEqual(Q(2, [sorted[0], sorted[3]], [Q(2, [sorted[1], sorted[2]]), Q(2, [sorted[4], sorted[5]])]));
    expect(input).toEqual(copy);
    // inner sets ordered by validators, then inner sets, then threshold
    expect(qSetCompare(Q(1, [sorted[0]]), Q(1, [sorted[1]]))).toBe(-1);
    expect(qSetCompare(Q(2, [sorted[0]]), Q(1, [sorted[0]]))).toBe(1);
    expect(qSetCompare(Q(1, [sorted[0]]), Q(1, [sorted[0]], [Q(1, [sorted[1]])]))).toBe(-1);
  });

  it('removes a node and lowers the thresholds (used for leader election)', () => {
    const qSet = Q(3, [k[0], k[1], k[2]], [Q(2, [k[0], k[3], k[4]])]);
    expect(normalizeQSet(qSet, k[0])).toEqual(normalizeQSet(Q(2, [k[1], k[2]], [Q(1, [k[3], k[4]])])));
    // inner set reduced to a singleton is merged
    const q2 = Q(2, [k[1]], [Q(2, [k[0], k[2]])]);
    expect(normalizeQSet(q2, k[0])).toEqual(normalizeQSet(Q(2, [k[1], k[2]])));
  });

  it('hash depends only on the content once normalized', () => {
    const a = Q(2, [k[2], k[0], k[1]]);
    const b = Q(2, [k[1], k[2], k[0]]);
    expect(hashQuorumSet(a)).not.toBe(hashQuorumSet(b));
    expect(hashQuorumSet(normalizeQSet(a))).toBe(hashQuorumSet(normalizeQSet(b)));
  });
});

describe('vblocking and quorum (SCPTests.cpp)', () => {
  it('flat 3 of 4', () => {
    const [v0, v1, v2, v3] = [0, 1, 2, 3].map(nodeId);
    const qSet = Q(3, [v0, v1, v2, v3]);

    const nodeSet: NodeId[] = [v0];

    expect(isQuorumSlice(qSet, nodeSet)).toBe(false);
    expect(isVBlocking(qSet, nodeSet)).toBe(false);

    nodeSet.push(v2);

    expect(isQuorumSlice(qSet, nodeSet)).toBe(false);
    expect(isVBlocking(qSet, nodeSet)).toBe(true);

    nodeSet.push(v3);
    expect(isQuorumSlice(qSet, nodeSet)).toBe(true);
    expect(isVBlocking(qSet, nodeSet)).toBe(true);

    nodeSet.push(v1);
    expect(isQuorumSlice(qSet, nodeSet)).toBe(true);
    expect(isVBlocking(qSet, nodeSet)).toBe(true);
  });
});

describe('v blocking distance (SCPTests.cpp)', () => {
  it('findClosestVBlocking sizes', () => {
    const [v0, v1, v2, v3, v4, v5, v6, v7] = [0, 1, 2, 3, 4, 5, 6, 7].map(nodeId);
    const qSet = Q(2, [v0, v1, v2]);

    const check = (qSetCheck: QuorumSet, s: Set<NodeId>, expected: number) => {
      const r = findClosestVBlocking(qSetCheck, s, null);
      expect(r.length).toBe(expected);
    };

    const good = new Set<NodeId>([v0]);

    // already v-blocking
    check(qSet, good, 0);

    good.add(v1);
    // either v0 or v1
    check(qSet, good, 1);

    good.add(v2);
    // any 2 of v0..v2
    check(qSet, good, 2);

    const qSubSet1 = Q(1, [v3, v4, v5]);
    qSet.innerSets.push(qSubSet1);

    good.add(v3);
    // any 3 of v0..v3
    check(qSet, good, 3);

    good.add(v4);
    // v0..v2
    check(qSet, good, 3);

    qSet.threshold = 1;
    // v0..v4
    check(qSet, good, 5);

    good.add(v5);
    // v0..v5
    check(qSet, good, 6);

    const qSubSet2 = Q(2, [v6, v7]);

    qSet.innerSets.push(qSubSet2);
    // v0..v5
    check(qSet, good, 6);

    good.add(v6);
    // v0..v5
    check(qSet, good, 6);

    good.add(v7);
    // v0..v5 and one of 6,7
    check(qSet, good, 7);

    qSet.threshold = 4;
    // v6, v7
    check(qSet, good, 2);

    qSet.threshold = 3;
    // v0..v2
    check(qSet, good, 3);

    qSet.threshold = 2;
    // v0..v2 and one of v6,v7
    check(qSet, good, 4);
  });

  it('excluded node is skipped', () => {
    const [v0, v1, v2] = [0, 1, 2].map(nodeId);
    const qSet = Q(2, [v0, v1, v2]);
    const all = new Set([v0, v1, v2]);
    // v0 is skipped altogether (neither agreeing nor failed): blocking
    // needs 2 failures among v1, v2
    expect(findClosestVBlocking(qSet, all, v0)).toEqual([v1, v2]);
    // with v0 counted as agreeing, any 2 of the 3 will do
    expect(findClosestVBlocking(qSet, all, null).length).toBe(2);
    // v1 already failed: one more failure (v2; v0 is skipped)
    expect(findClosestVBlocking(qSet, new Set([v0, v2]), v0)).toEqual([v2]);
  });
});

describe('nested quorum sets', () => {
  // three organizations of 3 nodes, inner threshold 2, top threshold 2 of 3
  const ids = Array.from({ length: 9 }, (_, i) => nodeId(`org${i}`));
  const orgs = [ids.slice(0, 3), ids.slice(3, 6), ids.slice(6, 9)];
  const qSet = Q(2, [], orgs.map((o) => Q(2, o)));

  it('slice needs 2 nodes in 2 organizations', () => {
    expect(isQuorumSetSane(qSet, true)).toBe(true);
    expect(isQuorumSlice(qSet, [orgs[0][0], orgs[0][1]])).toBe(false);
    expect(isQuorumSlice(qSet, [orgs[0][0], orgs[0][1], orgs[1][0]])).toBe(false);
    expect(isQuorumSlice(qSet, [orgs[0][0], orgs[0][1], orgs[1][0], orgs[1][2]])).toBe(true);
    expect(isQuorumSlice(qSet, [orgs[0][0], orgs[1][1], orgs[2][2]])).toBe(false);
  });

  it('v-blocking needs 2 nodes in 2 organizations', () => {
    // an organization is blocked by 2 of its 3 nodes; 2 blocked orgs block the top
    expect(isVBlocking(qSet, [orgs[0][0], orgs[0][1]])).toBe(false);
    expect(isVBlocking(qSet, [orgs[0][0], orgs[0][1], orgs[1][0]])).toBe(false);
    expect(isVBlocking(qSet, [orgs[0][0], orgs[0][1], orgs[1][0], orgs[1][1]])).toBe(true);
    expect(isVBlocking(qSet, [orgs[0][0], orgs[1][0], orgs[2][0]])).toBe(false);
  });

  it('closest v-blocking set uses the cheapest organizations', () => {
    // everyone agrees: need to take out 2 nodes in each of 2 organizations
    expect(findClosestVBlocking(qSet, new Set(ids), null).length).toBe(4);
    // org 0 already lost 2 nodes: blocked; need one more org (2 nodes)
    const s = new Set(ids.filter((n) => n !== orgs[0][0] && n !== orgs[0][1]));
    expect(findClosestVBlocking(qSet, s, null).length).toBe(2);
  });

  it('weights: fraction of slices', () => {
    expect(qsetNodes(qSet).length).toBe(9);
    let visited = 0;
    forAllNodes(qSet, () => {
      visited++;
      return visited < 4;
    });
    expect(visited).toBe(4);
  });

  it('threshold 0 sets are never a slice (uint32 semantics)', () => {
    expect(isQuorumSlice(Q(0, [ids[0]]), [ids[0]])).toBe(false);
    expect(isVBlocking(Q(0, [ids[0]]), [ids[0]])).toBe(false);
  });
});

describe('isQuorum with transitive quorum sets', () => {
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(nodeId);
  const qsets = new Map<Hash, QuorumSet>();
  const reg = (q: QuorumSet): Hash => {
    const h = hashQuorumSet(q);
    qsets.set(h, q);
    return h;
  };
  const qfun = (st: Envelope['statement']) => {
    if (st.pledges.type === 'externalize') return singletonQSet(st.nodeId);
    return qsets.get(st.pledges.quorumSetHash) ?? null;
  };
  const ballot = { counter: 1, value: 'aa' };

  const local = Q(2, [a, b, c]);
  const qa = reg(Q(2, [a, b]));
  const qb = reg(Q(2, [b, d])); // B needs D
  const qc = reg(Q(1, [c]));
  const qd = reg(Q(1, [d]));

  it('a member whose own slice is missing breaks the quorum', () => {
    const envs = new Map<NodeId, Envelope>([
      [a, makePrepare(a, qa, 1, ballot)],
      [b, makePrepare(b, qb, 1, ballot)],
      [c, makePrepare(c, qc, 1, ballot)],
    ]);
    // B drops out (no D), then A (needs B): only C remains
    expect(isQuorum(local, envs, qfun)).toBe(false);

    envs.set(d, makePrepare(d, qd, 1, ballot));
    expect(isQuorum(local, envs, qfun)).toBe(true);

    // filters apply before the transitive check
    expect(isQuorum(local, envs, qfun, (st) => st.nodeId !== d)).toBe(false);
    expect(isQuorum(local, envs, qfun, (st) => st.nodeId !== c)).toBe(true);
  });

  it('unknown quorum sets count as missing slices', () => {
    const unknown = '00'.repeat(32);
    const envs = new Map<NodeId, Envelope>([
      [a, makePrepare(a, unknown, 1, ballot)],
      [b, makePrepare(b, qb, 1, ballot)],
      [c, makePrepare(c, qc, 1, ballot)],
      [d, makePrepare(d, qd, 1, ballot)],
    ]);
    expect(isQuorum(local, envs, qfun)).toBe(true); // B and C satisfy local {2: A,B,C}
    expect(isQuorum(local, envs, qfun, (st) => st.nodeId !== b)).toBe(false);
  });

  it('isVBlockingSt / findClosestVBlockingSt use only the local set', () => {
    const envs = new Map<NodeId, Envelope>([
      [a, makeNominate(a, qa, 1, ['aa'], [])],
      [b, makeNominate(b, qb, 1, ['bb'], ['bb'])],
    ]);
    expect(isVBlockingSt(local, envs)).toBe(true); // 2 of 3 with t=2 block
    expect(isVBlockingSt(local, envs, (st) => st.pledges.type === 'nominate' && st.pledges.accepted.length > 0)).toBe(
      false,
    );
    expect(findClosestVBlockingSt(local, envs).length).toBe(1);
  });
});

describe('hex value order', () => {
  it('lowercase hex string order equals byte order', () => {
    const rng = seededRng(3);
    const vals: string[] = [];
    for (let i = 0; i < 200; i++) {
      const len = 1 + Math.floor(rng() * 6);
      let s = '';
      for (let j = 0; j < len; j++) s += Math.floor(rng() * 256).toString(16).padStart(2, '0');
      vals.push(s);
    }
    const byBytes = [...vals].sort((x, y) => compareBytes(fromHex(x), fromHex(y)));
    expect([...vals].sort()).toEqual(byBytes);
  });
});
