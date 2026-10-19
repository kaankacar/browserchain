// Hostile and unusual statement shapes. SCP must never throw on a peer
// statement, whatever its shape (the herder catches exceptions, but a throw
// in the middle of a transition leaves the slot half updated).

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../lib/hash';
import { getNominationStatementValues } from './nomination';
import { TestSCP, makeConfirm, makeNominate, makePrepare, nodeId, setupValues, verifyPrepare } from './testkit';
import type { Ballot, QuorumSet, Value } from './types';
import { hashQuorumSet } from './xdr';

const { x: xValue, y: yValue } = setupValues('hostile');
const [v0, v1, v2, v3, v4] = [0, 1, 2, 3, 4].map(nodeId);
const B = (counter: number, value: Value): Ballot => ({ counter, value });

const qSet: QuorumSet = { threshold: 4, validators: [v0, v1, v2, v3, v4], innerSets: [] };
const qSetHash = hashQuorumSet(qSet);

function newScp(): TestSCP {
  const scp = new TestSCP(v0, qSet);
  scp.storeQuorumSet(qSet);
  return scp;
}

describe('prepared ballots with counter 0 (draft-05 3.6: valid, "<0, y>")', () => {
  it('confirming prepare(<0, y>) sets the next ballot value only; b is never (0, y)', () => {
    // v0 has no ballot yet. v1, v2 accepted prepare (1, y); v3 is slow.
    const scp = newScp();
    scp.receiveEnvelope(makePrepare(v1, qSetHash, 0, B(1, yValue), B(1, yValue)));
    scp.receiveEnvelope(makePrepare(v2, qSetHash, 0, B(1, yValue), B(1, yValue)));
    // {v1, v2} is v-blocking: v0 accepts (1, y), but {v0, v1, v2} is no quorum
    expect(scp.scp.getSlotInfo(0)!.ballot.prepared).toEqual(B(1, yValue));
    expect(scp.scp.getSlotInfo(0)!.ballot.current).toBeNull();

    // one Byzantine node: prepared <0, y> completes a quorum for prepare(<0, y>) only
    expect(() => scp.receiveEnvelope(makePrepare(v4, qSetHash, 0, B(1, yValue), B(0, yValue)))).not.toThrow();
    let info = scp.scp.getSlotInfo(0)!.ballot;
    expect(info.current).toBeNull();
    expect(info.high).toBeNull();
    expect(info.valueOverride).toBe(yValue);
    expect(scp.envs.length).toBe(0);

    // the slot still works: the next ballot uses y, and v3 completes (1, y)
    expect(scp.bumpState(0, xValue)).toBe(true);
    const own = scp.scp.getLocalQuorumSetHash();
    verifyPrepare(scp.envs[0], v0, own, 0, B(1, yValue), B(1, yValue));
    scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, B(1, yValue), B(1, yValue)));
    info = scp.scp.getSlotInfo(0)!.ballot;
    expect(info.high).toEqual(B(1, yValue));
    expect(info.commit).toEqual(B(1, yValue));
    verifyPrepare(scp.envs[scp.envs.length - 1], v0, own, 0, B(1, yValue), B(1, yValue), 1, 1);
  });
});

describe('a v-blocking set of faulty peers', () => {
  it('forces accept-commit while p is on another value: no throw, the commit still completes', () => {
    // x < y. Faulty v2, v4 (v-blocking for t=4 of 5) first claim prepared (4, y), then CONFIRM x.
    const scp = newScp();
    for (const n of [v2, v4]) scp.receiveEnvelope(makePrepare(n, qSetHash, 0, B(4, yValue), B(4, yValue)));
    expect(scp.scp.getSlotInfo(0)!.ballot.prepared).toEqual(B(4, yValue));
    for (const n of [v2, v4]) scp.receiveEnvelope(makeConfirm(n, qSetHash, 0, 4, B(4, xValue), 2, 4));
    let info = scp.scp.getSlotInfo(0)!.ballot;
    expect(info.phase).toBe('CONFIRM');
    expect(info.commit).toEqual(B(2, xValue));
    expect(info.prepared).toEqual(B(4, yValue)); // stellar-core assumes p ~ c here

    // a statement with candidates on y above p: stellar-core asserts c ~ candidate
    expect(() => scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, B(5, yValue), B(4, yValue)))).not.toThrow();
    info = scp.scp.getSlotInfo(0)!.ballot;
    expect(info.phase).toBe('CONFIRM');
    expect(info.commit).toEqual(B(2, xValue));

    // honest v1, v3 confirm x: a quorum ratifies commit x
    for (const n of [v1, v3]) scp.receiveEnvelope(makeConfirm(n, qSetHash, 0, 4, B(4, xValue), 2, 4));
    expect(scp.scp.getExternalizedValue(0)).toBe(xValue);
  });

  it('a candidate on p above p is skipped in CONFIRM, not accepted (that would clear c)', () => {
    // Same start, then v1, v3 claim prepared (5, y): v-blocking, so (5, y)
    // could be accepted. stellar-core asserts c ~ candidate; with the assert
    // compiled out it accepts (5, y), raises p over h and clears c in
    // CONFIRM ('clearing c only in PREPARE' here, a null c in stellar-core).
    const scp = newScp();
    for (const n of [v2, v4]) scp.receiveEnvelope(makePrepare(n, qSetHash, 0, B(4, yValue), B(4, yValue)));
    for (const n of [v2, v4]) scp.receiveEnvelope(makeConfirm(n, qSetHash, 0, 4, B(4, xValue), 2, 4));
    expect(() => {
      for (const n of [v1, v3]) scp.receiveEnvelope(makePrepare(n, qSetHash, 0, B(5, yValue), B(5, yValue)));
    }).not.toThrow();
    const info = scp.scp.getSlotInfo(0)!.ballot;
    expect(info.phase).toBe('CONFIRM');
    expect(info.commit).toEqual(B(2, xValue));
    expect(info.prepared).toEqual(B(4, yValue));

    scp.receiveEnvelope(makeConfirm(v1, qSetHash, 0, 4, B(4, xValue), 2, 4));
    expect(scp.scp.getExternalizedValue(0)).toBe(xValue);
  });
});

describe('nominations with many values (CPU bound)', () => {
  it('a peer nomination with 20,000 values is processed in linear time', () => {
    const scp = newScp();
    scp.scp.nominate(1, xValue, yValue);
    const big = Array.from({ length: 20_000 }, (_, i) => sha256Hex(`many-${i}`)).sort();
    for (const n of [v2, v3]) scp.receiveEnvelope(makeNominate(n, qSetHash, 1, big.slice(0, 3), []));
    const env = makeNominate(v1, qSetHash, 1, big, big.slice(0, 10_000));
    const t0 = performance.now();
    scp.receiveEnvelope(env);
    scp.receiveEnvelope(makeNominate(v4, qSetHash, 1, big, []));
    expect(getNominationStatementValues(env.statement).length).toBe(20_000);
    // O(n^2) before (Array.includes per value and peer): more than 5 s here
    expect(performance.now() - t0).toBeLessThan(1_000);
    // the values voted by a quorum ({v1..v4}) are accepted; v1 alone is not v-blocking
    expect(scp.scp.getSlotInfo(1)!.nomination.accepted).toEqual(big.slice(0, 3));
  });
});
