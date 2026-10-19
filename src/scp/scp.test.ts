// Tests of the SCP class API (ARCHITECTURE section 6) and its extras.

import { describe, expect, it } from 'vitest';
import { UINT32_MAX } from './quorum';
import { SCP, isWellFormedEnvelope, statementToStr } from './scp';
import {
  TestSCP,
  makeConfirm,
  makeExternalize,
  makeNominate,
  makePrepare,
  nodeId,
  setupValues,
  verifyNominate,
  verifyPrepare,
} from './testkit';
import { EnvelopeState, TIMER_BALLOT, TIMER_NOMINATION } from './types';
import type { Ballot, Envelope, QuorumSet, Value } from './types';
import { hashQuorumSet } from './xdr';

const { x: xValue, y: yValue, z: zValue, k: kValue } = setupValues('scp-api');
const [v0, v1, v2, v3, v4] = [0, 1, 2, 3, 4].map(nodeId);
const B = (counter: number, value: Value): Ballot => ({ counter, value });

const qSet: QuorumSet = { threshold: 4, validators: [v0, v1, v2, v3, v4], innerSets: [] };
const qSetHash = hashQuorumSet(qSet);

/** A TestSCP that also records driver notifications. */
class RecordingSCP extends TestSCP {
  readonly events: string[] = [];
  readonly stoppedTimers: string[] = [];
  startedBallotProtocol(slot: number, b: Ballot) {
    this.events.push(`started ${slot} ${b.counter}`);
  }
  acceptedBallotPrepared(slot: number, b: Ballot) {
    this.events.push(`acceptedPrepared ${slot} ${b.counter}`);
  }
  confirmedBallotPrepared(slot: number, b: Ballot) {
    this.events.push(`confirmedPrepared ${slot} ${b.counter}`);
  }
  acceptedCommit(slot: number, b: Ballot) {
    this.events.push(`acceptedCommit ${slot} ${b.counter}`);
  }
  nominatingValue(slot: number, v: Value) {
    this.events.push(`nominating ${slot} ${v === xValue ? 'x' : v}`);
  }
  updatedCandidateValue(slot: number, v: Value) {
    this.events.push(`candidate ${slot} ${v === xValue ? 'x' : v}`);
  }
  valueExternalized(slot: number, v: Value) {
    super.valueExternalized(slot, v);
    this.events.push(`externalized ${slot}`);
  }
  stopTimer(slot: number, timerId: number) {
    super.stopTimer(slot, timerId);
    this.stoppedTimers.push(`${slot}:${timerId}`);
  }
}

function newScp(): RecordingSCP {
  const scp = new RecordingSCP(v0, qSet);
  scp.storeQuorumSet(qSet);
  return scp;
}

/** Drive slot 0 to EXTERNALIZE on (1, x) like the "normal round" test. */
function normalRound(scp: TestSCP, slot = 0): void {
  const b = B(1, xValue);
  scp.scp.getSlot(slot, true)!.bumpState(xValue, true);
  for (const n of [v1, v2, v3]) scp.receiveEnvelope(makePrepare(n, qSetHash, slot, b));
  for (const n of [v1, v2, v3]) scp.receiveEnvelope(makePrepare(n, qSetHash, slot, b, b));
  for (const n of [v1, v2, v3]) scp.receiveEnvelope(makePrepare(n, qSetHash, slot, b, b, 1, 1));
  for (const n of [v1, v2, v3]) scp.receiveEnvelope(makeConfirm(n, qSetHash, slot, 1, b, 1, 1));
}

describe('SCP API', () => {
  it('normalizes and validates the local quorum set', () => {
    const scp = newScp();
    const local = scp.scp.getLocalQuorumSet();
    expect(new Set(local.validators)).toEqual(new Set(qSet.validators));
    expect(scp.scp.getLocalQuorumSetHash()).toBe(hashQuorumSet(local));
    // returns a copy
    local.validators.length = 0;
    expect(scp.scp.getLocalQuorumSet().validators.length).toBe(5);
    expect(scp.scp.getLocalNodeId()).toBe(v0);
    expect(scp.scp.isValidator()).toBe(true);
    expect(() => new SCP(scp, v0, true, { threshold: 3, validators: [v0], innerSets: [] })).toThrow(
      'invalid local quorum set',
    );
    expect(() => scp.scp.updateLocalQuorumSet({ threshold: 0, validators: [v0], innerSets: [] })).toThrow();
  });

  it('getSlotInfo, state queries and notifications after a normal round', () => {
    const scp = newScp();
    expect(scp.scp.getSlotInfo(0)).toBe(null);
    normalRound(scp);

    expect(scp.externalizedValues.get(0)).toBe(xValue);
    expect(scp.scp.getExternalizedValue(0)).toBe(xValue);
    expect(scp.events).toEqual([
      'started 0 1',
      'acceptedPrepared 0 1',
      'confirmedPrepared 0 1',
      'acceptedCommit 0 1',
      // a quorum of CONFIRM statements also votes prepare (infinity, x)
      `acceptedPrepared 0 ${UINT32_MAX}`,
      'externalized 0',
    ]);
    expect(scp.heardFromQuorumsOf(0)).toEqual([B(1, xValue)]);

    const info = scp.scp.getSlotInfo(0)!;
    expect(info.slotIndex).toBe(0);
    expect(info.fullyValidated).toBe(true);
    expect(info.externalizedValue).toBe(xValue);
    expect(info.ballot).toEqual({
      phase: 'EXTERNALIZE',
      current: B(1, xValue),
      prepared: B(UINT32_MAX, xValue),
      preparedPrime: null,
      high: B(1, xValue),
      commit: B(1, xValue),
      valueOverride: xValue,
      heardFromQuorum: true,
    });
    expect(info.nomination.started).toBe(false);
    expect(info.latestStatements.map((s) => s.nodeId)).toEqual(scp.scp.getEntireCurrentState(0).map((e) => e.statement.nodeId));
    expect(info.latestStatements.find((s) => s.nodeId === v0)!.ballot!.pledges.type).toBe('externalize');
    expect(info.latestStatements.find((s) => s.nodeId === v4)).toBeUndefined();

    // latest envelope of every node; ours too since the slot is fully validated
    const current = scp.scp.getCurrentState(0);
    expect(current.length).toBe(4);
    expect(current.map((e) => e.statement.pledges.type).sort()).toEqual(['confirm', 'confirm', 'confirm', 'externalize']);
    // envelopes that agree with the externalized value
    expect(scp.scp.getExternalizingState(0).length).toBe(4);
    // what we sent last: the EXTERNALIZE
    const sent = scp.scp.getLatestMessagesSend(0);
    expect(sent.length).toBe(1);
    expect(sent[0]).toBe(scp.envs[scp.envs.length - 1]);
    expect(sent[0].statement.pledges.type).toBe('externalize');

    expect(scp.scp.getKnownSlots()).toEqual([0]);
    expect(scp.scp.isSlotFullyValidated(0)).toBe(true);
    expect(scp.scp.isSlotFullyValidated(1)).toBe(false);
    expect(scp.scp.gotVBlocking(0)).toBe(true);
    expect(scp.scp.getCumulativeStatementCount()).toBeGreaterThan(10);
    expect(scp.scp.getLatestMessage(v1)!.statement.pledges.type).toBe('confirm');
  });

  it('gotVBlocking turns on with a v-blocking set of senders', () => {
    const scp = newScp();
    scp.receiveEnvelope(makePrepare(v1, qSetHash, 3, B(1, xValue)));
    expect(scp.scp.gotVBlocking(3)).toBe(false);
    scp.receiveEnvelope(makePrepare(v2, qSetHash, 3, B(1, xValue)));
    expect(scp.scp.gotVBlocking(3)).toBe(true);
  });

  it('purgeSlots forgets old slots and stops their timers', () => {
    const scp = newScp();
    for (let s = 1; s <= 6; s++) scp.receiveEnvelope(makePrepare(v1, qSetHash, s, B(1, xValue)));
    expect(scp.scp.getKnownSlots()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scp.scp.getHighestKnownSlotIndex()).toBe(6);
    scp.scp.purgeSlots(4, 2);
    expect(scp.scp.getKnownSlots()).toEqual([2, 4, 5, 6]);
    expect(scp.stoppedTimers).toEqual(
      expect.arrayContaining([`1:${TIMER_NOMINATION}`, `1:${TIMER_BALLOT}`, `3:${TIMER_NOMINATION}`, `3:${TIMER_BALLOT}`]),
    );
    expect(scp.stoppedTimers).not.toContain(`2:${TIMER_NOMINATION}`);
    scp.scp.purgeSlotsOutsideRange(null, 4, null);
    expect(scp.scp.getKnownSlots()).toEqual([2, 4]);
    expect(scp.scp.empty()).toBe(false);
  });

  it('watcher mode: setValidator(false) keeps processing but never emits', () => {
    const scp = newScp();
    expect(scp.scp.nominate(1, xValue, kValue)).toBe(true);
    expect(scp.envs.length).toBe(1);

    scp.scp.setValidator(false);
    expect(scp.scp.isValidator()).toBe(false);
    expect(scp.scp.isSlotFullyValidated(1)).toBe(false);
    // no more nominations, existing slot stops emitting
    expect(scp.scp.nominate(2, xValue, kValue)).toBe(false);
    for (const n of [v1, v2, v3]) scp.receiveEnvelope(makeNominate(n, qSetHash, 1, [xValue], []));
    expect(scp.envs.length).toBe(1);
    expect(scp.scp.getLatestMessagesSend(1)).toEqual([]);
    // but the protocol state still advances (x accepted)
    expect(scp.scp.getSlotInfo(1)!.nomination.accepted).toEqual([xValue]);
    // new slots follow the network silently
    normalRound(scp, 5);
    expect(scp.externalizedValues.get(5)).toBe(xValue);
    expect(scp.envs.length).toBe(1);

    scp.scp.setValidator(true);
    expect(scp.scp.nominate(7, yValue, kValue)).toBe(true);
    expect(scp.envs.length).toBe(2);
    expect(scp.envs[1].statement.slotIndex).toBe(7);
  });

  it('a node created as watcher never nominates', () => {
    const w = new TestSCP(v0, qSet, false);
    expect(w.scp.isValidator()).toBe(false);
    expect(w.scp.nominate(1, xValue, kValue)).toBe(false);
    expect(w.envs.length).toBe(0);
  });

  it('updateLocalQuorumSet: new hash is used by the next statement', () => {
    const scp = newScp();
    expect(scp.scp.nominate(1, xValue, kValue)).toBe(true);
    const oldHash = scp.scp.getLocalQuorumSetHash();
    expect(scp.envs[0].statement.pledges.type === 'nominate' && scp.envs[0].statement.pledges.quorumSetHash).toBe(oldHash);

    const newQ: QuorumSet = { threshold: 3, validators: [v4, v3, v2, v1, v0], innerSets: [] };
    scp.scp.updateLocalQuorumSet(newQ);
    scp.storeQuorumSet(scp.scp.getLocalQuorumSet());
    const newHash = scp.scp.getLocalQuorumSetHash();
    expect(newHash).not.toBe(oldHash);
    expect(newHash).toBe(hashQuorumSet(scp.scp.getLocalQuorumSet()));

    // v1 echoes a value from us -> we accept nothing yet, but the next
    // statement we emit (a new vote from the leader) carries the new hash
    scp.priorityLookup = (n) => (n === v1 ? 1000n : 1n);
    scp.receiveEnvelope(makeNominate(v1, qSetHash, 1, [yValue], []));
    expect(scp.nominate(1, xValue, true)).toBe(true);
    const last = scp.envs[scp.envs.length - 1].statement.pledges;
    expect(last.type === 'nominate' && last.quorumSetHash).toBe(newHash);
  });

  it('updateLocalQuorumSet re-evaluates open slots against statements already held', () => {
    // x is voted by v1, v2 (and us): not a quorum for t=4, but a quorum for t=3
    const scp = newScp();
    expect(scp.scp.nominate(1, xValue, kValue)).toBe(true);
    const q3 = scp.storeQuorumSet({ threshold: 3, validators: [v0, v1, v2, v3, v4], innerSets: [] });
    scp.receiveEnvelope(makeNominate(v1, q3, 1, [xValue], []));
    scp.receiveEnvelope(makeNominate(v2, q3, 1, [xValue], []));
    expect(scp.envs.length).toBe(1);
    expect(scp.scp.getSlotInfo(1)!.nomination.accepted).toEqual([]);

    scp.scp.updateLocalQuorumSet({ threshold: 3, validators: [v0, v1, v2, v3, v4], innerSets: [] });
    scp.storeQuorumSet(scp.scp.getLocalQuorumSet());
    // our own latest statement still carries the old set (t=4): no quorum
    // yet. Announcing the new set with a newer statement completes it.
    expect(scp.scp.refreshNomination(1, zValue)).toBe(true);
    const info = scp.scp.getSlotInfo(1)!;
    expect(info.nomination.accepted).toEqual([xValue]);
    const last = scp.envs[scp.envs.length - 1];
    verifyNominate(last, v0, scp.scp.getLocalQuorumSetHash(), 1, [xValue, zValue], [xValue]);
  });

  it('updateLocalQuorumSet recomputes round leaders from the new set (departed leaders)', () => {
    const scp = newScp();
    // leader of round r is order[(r - 1) % 5] (priorities depend on the round)
    const order = [v3, v4, v2, v1, v0];
    scp.computeHashNode = (_s, _p, isPriority, round, n) =>
      isPriority ? (order.indexOf(n) === (round - 1) % 5 ? 1000n : 1n) : 0n;
    scp.scp.nominate(1, xValue, kValue);
    scp.timers.get(TIMER_NOMINATION)!.callback!();
    scp.timers.get(TIMER_NOMINATION)!.callback!();
    expect(scp.scp.getSlotInfo(1)!.nomination.roundNumber).toBe(3);
    expect(new Set(scp.scp.getNominationLeaders(1))).toEqual(new Set([v2, v3, v4]));
    expect(scp.envs.length).toBe(0); // not a leader: no vote yet

    // v3 and v4 leave
    scp.scp.updateLocalQuorumSet({ threshold: 2, validators: [v0, v1, v2], innerSets: [] });
    scp.storeQuorumSet(scp.scp.getLocalQuorumSet());
    expect(scp.scp.getNominationLeaders(1)).toEqual([v2]); // round 3 leader within the new set

    // the next rounds add the other members, so we become a leader and vote
    scp.timers.get(TIMER_NOMINATION)!.callback!();
    expect(new Set(scp.scp.getNominationLeaders(1))).toEqual(new Set([v1, v2]));
    scp.timers.get(TIMER_NOMINATION)!.callback!();
    expect(new Set(scp.scp.getNominationLeaders(1))).toEqual(new Set([v0, v1, v2]));
    expect(scp.envs.length).toBe(1);
    verifyNominate(scp.envs[0], v0, scp.scp.getLocalQuorumSetHash(), 1, [xValue], []);
  });

  it('updateLocalQuorumSet echoes a new round leader right away', () => {
    const scp = newScp();
    // round 1: v3 > v1 > others; round 2: v4 > v1 > others
    const prio: Record<number, Value[]> = { 1: [v3, v1], 2: [v4, v1] };
    scp.computeHashNode = (_s, _p, isPriority, round, n) => {
      if (!isPriority) return 0n;
      const i = (prio[round] ?? []).indexOf(n);
      return i < 0 ? 1n : BigInt(100 - i);
    };
    scp.scp.nominate(1, xValue, kValue);
    scp.timers.get(TIMER_NOMINATION)!.callback!();
    expect(new Set(scp.scp.getNominationLeaders(1))).toEqual(new Set([v3, v4]));
    // v1 is not a leader yet: its vote is not echoed
    scp.receiveEnvelope(makeNominate(v1, qSetHash, 1, [yValue], []));
    expect(scp.envs.length).toBe(0);

    // v3 and v4 leave: v1 leads round 2 within the new set, y is echoed now
    scp.scp.updateLocalQuorumSet({ threshold: 2, validators: [v0, v1, v2], innerSets: [] });
    expect(scp.scp.getNominationLeaders(1)).toEqual([v1]);
    expect(scp.envs.length).toBe(1);
    verifyNominate(scp.envs[0], v0, scp.scp.getLocalQuorumSetHash(), 1, [yValue], []);
    expect(scp.scp.getSlotInfo(1)!.nomination.roundNumber).toBe(2);
  });

  it('refreshNomination is a no-op unless nominating without a candidate', () => {
    const scp = newScp();
    expect(scp.scp.refreshNomination(1, yValue)).toBe(false); // no slot
    scp.receiveEnvelope(makeNominate(v1, qSetHash, 1, [xValue], []));
    expect(scp.scp.refreshNomination(1, yValue)).toBe(false); // nomination not started
    expect(scp.scp.nominate(1, xValue, kValue)).toBe(true);
    expect(scp.scp.refreshNomination(1, xValue)).toBe(false); // already voted
    expect(scp.scp.refreshNomination(1, yValue)).toBe(true);
    verifyNominate(scp.envs[scp.envs.length - 1], v0, scp.scp.getLocalQuorumSetHash(), 1, [xValue, yValue], []);
  });

  it('abandonBallot bumps the counter; a no-op before the ballot protocol or at UINT32_MAX', () => {
    const scp = newScp();
    expect(scp.scp.abandonBallot(0)).toBe(false);
    expect(scp.bumpState(0, xValue)).toBe(true);
    expect(scp.scp.abandonBallot(0)).toBe(true);
    verifyPrepare(scp.envs[scp.envs.length - 1], v0, scp.scp.getLocalQuorumSetHash(), 0, B(2, xValue));

    // accept commit from v-blocking EXTERNALIZE -> b = (UINT32_MAX, x)
    const scp2 = newScp();
    scp2.receiveEnvelope(makeExternalize(v1, qSetHash, 0, B(1, xValue), 1));
    scp2.receiveEnvelope(makeExternalize(v2, qSetHash, 0, B(1, xValue), 1));
    expect(scp2.scp.getSlotInfo(0)!.ballot.current).toEqual(B(UINT32_MAX, xValue));
    const n = scp2.envs.length;
    expect(scp2.scp.abandonBallot(0)).toBe(false); // counter would wrap: ignored
    expect(scp2.envs.length).toBe(n);
  });

  it('ballot timer: starts when heard from a quorum, expiry bumps the counter', () => {
    const scp = newScp();
    scp.bumpState(0, xValue);
    expect(scp.hasBallotTimer()).toBe(false);
    for (const n of [v1, v2, v3]) scp.receiveEnvelope(makePrepare(n, qSetHash, 0, B(1, xValue)));
    expect(scp.hasBallotTimer()).toBe(true);
    expect(scp.getBallotProtocolTimer().absoluteTimeout).toBe(1000); // computeTimeout(1)
    scp.getBallotProtocolTimer().callback!();
    verifyPrepare(scp.envs[scp.envs.length - 1], v0, scp.scp.getLocalQuorumSetHash(), 0, B(2, xValue), B(1, xValue));
  });

  it('nomination timer re-nominates on timeout (round number grows)', () => {
    const scp = newScp();
    // leader of round r is v[(r - 1) % 5] (TestSCP priorities ignore the round)
    const order = [v0, v1, v2, v3, v4];
    scp.computeHashNode = (_s, _p, isPriority, round, n) =>
      isPriority ? (order.indexOf(n) === (round - 1) % 5 ? 1000n : 1n) : 0n;
    scp.scp.nominate(1, xValue, kValue);
    expect(scp.scp.getSlotInfo(1)!.nomination.roundNumber).toBe(1);
    const t = scp.timers.get(TIMER_NOMINATION)!;
    expect(t.absoluteTimeout).toBe(1000);
    t.callback!();
    expect(scp.scp.getSlotInfo(1)!.nomination.roundNumber).toBe(2);
    expect(new Set(scp.scp.getNominationLeaders(1))).toEqual(new Set([v0, v1]));
    expect(scp.timers.get(TIMER_NOMINATION)!.absoluteTimeout).toBe(2000);
    // stopNomination: later timeouts do nothing
    scp.scp.stopNomination(1);
    scp.timers.get(TIMER_NOMINATION)!.callback!();
    expect(scp.scp.getSlotInfo(1)!.nomination.roundNumber).toBe(2);
    expect(scp.scp.getSlotInfo(1)!.nomination.started).toBe(false);
  });

  it('nomination notifications and composite candidate', () => {
    const scp = newScp();
    scp.scp.nominate(1, xValue, kValue);
    scp.expectedCandidates.add(xValue);
    scp.compositeValue = xValue;
    for (const n of [v1, v2, v3]) scp.receiveEnvelope(makeNominate(n, qSetHash, 1, [xValue], [xValue]));
    expect(scp.events).toEqual(['nominating 1 x', 'candidate 1 x', 'started 1 1']);
    const info = scp.scp.getSlotInfo(1)!;
    expect(info.nomination.candidates).toEqual([xValue]);
    expect(info.nomination.latestCompositeCandidate).toBe(xValue);
    expect(info.nomination.roundLeaders).toEqual([v0]);
    expect(scp.scp.getNominationLeaders(1)).toEqual([v0]);
    // the nomination timer was stopped when the candidate appeared
    expect(scp.timers.has(TIMER_NOMINATION)).toBe(false);
    expect(scp.scp.getLatestMessagesSend(1).map((e) => e.statement.pledges.type)).toEqual(['nominate', 'prepare']);
  });
});

describe('local quorum sets resolve without the driver cache', () => {
  it('our own current and previous sets are found by hash', () => {
    const scp = newScp();
    scp.quorumSets.clear(); // the driver knows no quorum set at all
    expect(scp.scp.nominate(1, xValue, kValue)).toBe(true);
    const oldHash = scp.scp.getLocalQuorumSetHash();
    scp.scp.updateLocalQuorumSet({ threshold: 3, validators: [v0, v1, v2, v3, v4], innerSets: [] });
    expect(scp.bumpState(1, xValue)).toBe(true);
    const info = scp.scp.getSlotInfo(1)!;
    const own = info.latestStatements.find((s) => s.nodeId === v0)!;
    expect(own.nomination!.pledges.type === 'nominate' && own.nomination!.pledges.quorumSetHash).toBe(oldHash);
    expect(own.ballot!.pledges.type === 'prepare' && own.ballot!.pledges.quorumSetHash).toBe(
      scp.scp.getLocalQuorumSetHash(),
    );
    // peers' sets still come from the driver only
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 1, B(1, xValue)))).toBe(EnvelopeState.INVALID);
    // returned statements are copies
    (own.ballot!.pledges as { nH: number }).nH = 99;
    expect(scp.scp.getSlotInfo(1)!.latestStatements.find((s) => s.nodeId === v0)!.ballot).not.toEqual(own.ballot);
  });
});

describe('envelope checks', () => {
  const good = makePrepare(v1, qSetHash, 1, B(1, xValue));

  it('rejects malformed envelopes', () => {
    const scp = newScp();
    const bad = (mut: (e: Envelope) => void) => {
      const e = structuredClone(good);
      mut(e);
      expect(isWellFormedEnvelope(e)).toBe(false);
      expect(scp.receiveEnvelope(e)).toBe(EnvelopeState.INVALID);
    };
    expect(isWellFormedEnvelope(good)).toBe(true);
    bad((e) => (e.statement.slotIndex = -1));
    bad((e) => (e.statement.slotIndex = 1.5));
    bad((e) => ((e.statement.pledges as { ballot: Ballot }).ballot.counter = UINT32_MAX + 1));
    bad((e) => ((e.statement.pledges as { ballot: Ballot }).ballot.value = xValue.toUpperCase()));
    bad((e) => ((e.statement.pledges as { ballot: Ballot }).ballot.value = 'abc'));
    bad((e) => ((e.statement.pledges as { quorumSetHash: string }).quorumSetHash = 'ab'));
    bad((e) => ((e.statement.pledges as { type: string }).type = 'bogus'));
    bad((e) => ((e.statement as { nodeId: unknown }).nodeId = 7));
    bad((e) => (e.statement.nodeId = 'GABC'));
    bad((e) => (e.statement.nodeId = v1.slice(0, -1) + (v1.endsWith('A') ? 'B' : 'A'))); // bad checksum
    bad((e) => ((e.statement.pledges as { prepared: unknown }).prepared = { counter: 1 }));
    expect(isWellFormedEnvelope(null as unknown as Envelope)).toBe(false);
    expect(scp.scp.getKnownSlots()).toEqual([]);
  });

  it('rejects statements with an unknown or insane quorum set', () => {
    const scp = newScp();
    const unknown = 'ee'.repeat(32);
    expect(scp.receiveEnvelope(makePrepare(v1, unknown, 1, B(1, xValue)))).toBe(EnvelopeState.INVALID);
    expect(scp.receiveEnvelope(makeNominate(v1, unknown, 1, [xValue], []))).toBe(EnvelopeState.INVALID);
    expect(scp.receiveEnvelope(makeConfirm(v1, unknown, 1, 1, B(1, xValue), 1, 1))).toBe(EnvelopeState.INVALID);
    // EXTERNALIZE uses the singleton set of the sender: no lookup needed
    expect(scp.receiveEnvelope(makeExternalize(v1, unknown, 1, B(1, xValue), 1))).toBe(EnvelopeState.VALID);
    const insane = scp.storeQuorumSet({ threshold: 2, validators: [v1], innerSets: [] });
    expect(scp.receiveEnvelope(makePrepare(v2, insane, 1, B(1, xValue)))).toBe(EnvelopeState.INVALID);
    expect(scp.receiveEnvelope(makeNominate(v2, insane, 1, [xValue], []))).toBe(EnvelopeState.INVALID);
  });

  it('rejects malformed statements (isStatementSane / nomination isSane)', () => {
    const scp = newScp();
    // b.counter = 0 from a peer
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 1, B(0, xValue)))).toBe(EnvelopeState.INVALID);
    // p' must be below p and incompatible
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 1, B(2, yValue), B(1, xValue), 0, 0, B(2, yValue)))).toBe(
      EnvelopeState.INVALID,
    );
    // nH > p.counter
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 1, B(3, xValue), B(1, xValue), 0, 2))).toBe(EnvelopeState.INVALID);
    // c != 0 needs c <= h <= b
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 1, B(3, xValue), B(3, xValue), 3, 2))).toBe(EnvelopeState.INVALID);
    // CONFIRM: c <= h <= b
    expect(scp.receiveEnvelope(makeConfirm(v1, qSetHash, 1, 3, B(3, xValue), 2, 4))).toBe(EnvelopeState.INVALID);
    // EXTERNALIZE: h >= c
    expect(scp.receiveEnvelope(makeExternalize(v1, qSetHash, 1, B(3, xValue), 2))).toBe(EnvelopeState.INVALID);
    // nominations: non-empty, strictly sorted
    expect(scp.receiveEnvelope(makeNominate(v1, qSetHash, 1, [], []))).toBe(EnvelopeState.INVALID);
    const unsorted = makeNominate(v1, qSetHash, 1, [xValue, yValue], []);
    (unsorted.statement.pledges as { votes: Value[] }).votes.reverse();
    expect(scp.receiveEnvelope(unsorted)).toBe(EnvelopeState.INVALID);
    const dup = makeNominate(v1, qSetHash, 1, [xValue], []);
    (dup.statement.pledges as { votes: Value[] }).votes.push(xValue);
    expect(scp.receiveEnvelope(dup)).toBe(EnvelopeState.INVALID);
    expect(scp.scp.getLatestMessage(v1)).toBe(null);
  });

  it('statements out of order: only newer statements are taken', () => {
    const scp = newScp();
    const p2 = makePrepare(v1, qSetHash, 1, B(2, xValue));
    const p1 = makePrepare(v1, qSetHash, 1, B(1, xValue));
    expect(scp.receiveEnvelope(p2)).toBe(EnvelopeState.VALID);
    expect(scp.receiveEnvelope(p1)).toBe(EnvelopeState.INVALID);
    expect(scp.receiveEnvelope(p2)).toBe(EnvelopeState.INVALID); // duplicate
    const c = makeConfirm(v1, qSetHash, 1, 2, B(2, xValue), 1, 2);
    expect(scp.receiveEnvelope(c)).toBe(EnvelopeState.VALID);
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 1, B(5, xValue)))).toBe(EnvelopeState.INVALID);
    expect(scp.scp.isNewerNominationOrBallotSt(p1.statement, p2.statement)).toBe(true);
    expect(scp.scp.isNewerNominationOrBallotSt(c.statement, p2.statement)).toBe(false);

    const n1 = makeNominate(v1, qSetHash, 1, [xValue, yValue], []);
    const n0 = makeNominate(v1, qSetHash, 1, [xValue], []);
    expect(scp.receiveEnvelope(n1)).toBe(EnvelopeState.VALID);
    expect(scp.receiveEnvelope(n0)).toBe(EnvelopeState.INVALID); // subset
    expect(scp.receiveEnvelope(makeNominate(v1, qSetHash, 1, [zValue], []))).toBe(EnvelopeState.INVALID); // not a superset
    expect(scp.receiveEnvelope(makeNominate(v1, qSetHash, 1, [xValue, yValue], [xValue]))).toBe(EnvelopeState.VALID);
  });

  it('statementToStr renders like SCP::envToStr', () => {
    const scp = newScp();
    const s = statementToStr(makePrepare(v1, qSetHash, 3, B(2, xValue), B(1, xValue), 0, 1).statement);
    expect(s).toContain('|  i: 3 | PREPARE | D: ' + qSetHash.slice(0, 6));
    expect(s).toContain(`b: (2,${xValue.slice(0, 8)}) | p: (1,${xValue.slice(0, 8)}) | p': (<null_ballot>) | c.n: 0 | h.n: 1`);
    expect(scp.scp.envToStr(makeNominate(v1, qSetHash, 3, [xValue], []))).toContain(`NOMINATE | D: ${qSetHash.slice(0, 6)} | X: {'${xValue.slice(0, 8)}'} | Y: {}`);
    expect(scp.scp.envToStr(makeConfirm(v1, qSetHash, 3, 2, B(2, xValue), 1, 2))).toContain('CONFIRM');
    expect(scp.scp.envToStr(makeExternalize(v1, qSetHash, 3, B(2, xValue), 2))).toContain('EXTERNALIZE');
    expect(scp.scp.ballotToStr(null)).toBe('(<null_ballot>)');
  });
});

describe('restore state from envelopes (setStateFromEnvelope)', () => {
  it('nomination and ballot state come back and are reported as sent', () => {
    const scp = newScp();
    const h0 = scp.scp.getLocalQuorumSetHash();
    expect(scp.scp.setStateFromEnvelope(2, makeNominate(v0, h0, 2, [xValue], [xValue]))).toBe(true);
    expect(scp.scp.setStateFromEnvelope(2, makePrepare(v0, h0, 2, B(3, xValue), B(2, xValue), 1, 2))).toBe(true);
    // envelopes of other nodes or slots are refused
    expect(scp.scp.setStateFromEnvelope(2, makePrepare(v1, qSetHash, 2, B(1, xValue)))).toBe(false);
    expect(scp.scp.setStateFromEnvelope(2, makePrepare(v0, h0, 9, B(1, xValue)))).toBe(false);

    const info = scp.scp.getSlotInfo(2)!;
    expect(info.nomination.votes).toEqual([xValue]);
    expect(info.nomination.accepted).toEqual([xValue]);
    expect(info.ballot.current).toEqual(B(3, xValue));
    expect(info.ballot.prepared).toEqual(B(2, xValue));
    expect(info.ballot.high).toEqual(B(2, xValue));
    expect(info.ballot.commit).toEqual(B(1, xValue));
    expect(scp.scp.getLatestMessagesSend(2).map((e) => e.statement.pledges.type)).toEqual(['nominate', 'prepare']);
    // restoring the ballot protocol twice is refused
    expect(() => scp.scp.setStateFromEnvelope(2, makePrepare(v0, h0, 2, B(4, xValue)))).toThrow();

    // the restored node finishes the slot with its peers
    for (const n of [v1, v2, v3]) scp.receiveEnvelope(makeConfirm(n, qSetHash, 2, 3, B(3, xValue), 1, 3));
    expect(scp.externalizedValues.get(2)).toBe(xValue);
  });

  it('restored votes: statements received before nominate() are evaluated when nomination starts', () => {
    // A restart while nominating: we voted x and lost nothing else. The
    // herder feeds the peers' state before the first trigger. The leaders
    // offer only x, which we already vote, so nominate() votes nothing new.
    // Before the fix nothing was emitted, x was never accepted and the slot
    // stalled for good (no peer sends a newer nomination).
    const scp = newScp();
    const order = [v1, v2, v3, v4, v0];
    scp.computeHashNode = (_s, _p, isPriority, round, n) =>
      isPriority ? (order.indexOf(n) === (round - 1) % 5 ? 1000n : 1n) : 0n;
    scp.expectedCandidates = new Set([xValue]);
    scp.compositeValue = xValue;
    const h0 = scp.scp.getLocalQuorumSetHash();
    expect(scp.scp.setStateFromEnvelope(1, makeNominate(v0, h0, 1, [xValue], []))).toBe(true);
    for (const n of [v1, v2, v3]) scp.receiveEnvelope(makeNominate(n, qSetHash, 1, [xValue], [xValue]));
    scp.receiveEnvelope(makeNominate(v4, qSetHash, 1, [xValue], [])); // restarted, too
    expect(scp.envs.length).toBe(0);

    scp.scp.nominate(1, yValue, kValue);
    // {v1, v2} accepted x (v-blocking): we accept x, then {v0..v3} confirm it
    const info = scp.scp.getSlotInfo(1)!;
    expect(info.nomination.votes).toEqual([xValue]);
    expect(info.nomination.accepted).toEqual([xValue]);
    expect(info.nomination.candidates).toEqual([xValue]);
    expect(info.ballot.current).toEqual(B(1, xValue));
    expect(scp.envs.map((e) => e.statement.pledges.type)).toEqual(['prepare', 'nominate']);
    verifyNominate(scp.envs[1], v0, h0, 1, [xValue], [xValue]);
    verifyPrepare(scp.envs[0], v0, h0, 1, B(1, xValue));
    // a candidate exists: no nomination timer
    expect(scp.timers.get(TIMER_NOMINATION)).toBeUndefined();
  });

  it('restored nomination with an older quorum set: nominate() announces the current set', () => {
    // A restart while nominating, then v3 and v4 leave before the first
    // trigger: abandonBallot and refreshNomination do nothing yet. The
    // leaders offer only x, which we already vote. Before the fix nominate()
    // emitted nothing: our latest nomination kept the old set (4 of 5), so
    // the survivors could never form a quorum with us.
    const scp = newScp();
    scp.expectedCandidates = new Set([xValue]);
    scp.compositeValue = xValue;
    const h0 = scp.scp.getLocalQuorumSetHash();
    expect(scp.scp.setStateFromEnvelope(1, makeNominate(v0, h0, 1, [xValue], []))).toBe(true);
    scp.scp.updateLocalQuorumSet({ threshold: 3, validators: [v0, v1, v2], innerSets: [] });
    const h1 = scp.storeQuorumSet(scp.scp.getLocalQuorumSet());
    expect(scp.scp.abandonBallot(1)).toBe(false);
    expect(scp.scp.refreshNomination(1, zValue)).toBe(false);
    for (const n of [v1, v2]) scp.receiveEnvelope(makeNominate(n, h1, 1, [xValue], []));
    expect(scp.envs.length).toBe(0);

    scp.scp.nominate(1, yValue, kValue);
    // our own value makes the statement newer; it carries the current set,
    // so {v0, v1, v2} is a quorum for x
    expect(scp.envs.length).toBe(1);
    verifyNominate(scp.envs[0], v0, h1, 1, [xValue, yValue], [xValue]);
    for (const n of [v1, v2]) scp.receiveEnvelope(makeNominate(n, h1, 1, [xValue], [xValue]));
    expect(scp.scp.getSlotInfo(1)!.nomination.candidates).toEqual([xValue]);
    expect(scp.scp.getSlotInfo(1)!.ballot.current).toEqual(B(1, xValue));
  });

  it('a first nominate() without restored votes behaves as before', () => {
    // the same kind of early statements, nothing restored: as in stellar-core,
    // only the leader's best value is voted and only our own votes are
    // re-checked, so z (accepted by a v-blocking set) is not accepted yet
    const scp = newScp();
    scp.computeHashNode = (_s, _p, isPriority, _round, n) => (isPriority ? (n === v1 ? 1000n : 1n) : 0n);
    scp.hashValueCalculator = (v) => (v === xValue ? 2n : 1n);
    scp.expectedCandidates = new Set([xValue]);
    scp.compositeValue = xValue;
    for (const n of [v1, v2, v3]) scp.receiveEnvelope(makeNominate(n, qSetHash, 1, [xValue, zValue], [xValue, zValue]));
    scp.scp.nominate(1, yValue, kValue);
    const info = scp.scp.getSlotInfo(1)!;
    expect(info.nomination.votes).toEqual([xValue]);
    expect(info.nomination.accepted).toEqual([xValue]);
    expect(info.nomination.candidates).toEqual([xValue]);
  });
});
