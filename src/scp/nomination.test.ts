// Ported from stellar-core (Apache-2.0): src/scp/test/SCPTests.cpp
// ("nomination tests core5", "Proper handling of non-current ledger value",
// "incoming PREPARE with non-tx-set-invalid value is dropped") and
// src/scp/test/SCPUnitTests.cpp (nomination weight, updateRoundLeaders with
// zero weight nodes).

import { describe, expect, it } from 'vitest';
import { getNodeWeight, UINT64_MAX } from './quorum';
import { EnvelopeState, TIMER_NOMINATION, ValidationLevel } from './types';
import type { NodeId, QuorumSet, Value } from './types';
import { hashQuorumSet } from './xdr';
import {
  TestSCP,
  discoverSectionPaths,
  makeNominate,
  makePrepare,
  nodeId,
  runSectionPath,
  setupValues,
  verifyNominate,
  verifyPrepare,
  type SectionBody,
  type SectionFn,
} from './testkit';

const { x: xValue, y: yValue, z: zValue, zz: zzValue, k: kValue } = setupValues('nomination');

const [v0, v1, v2, v3, v4, v5] = [0, 1, 2, 3, 4, 5].map(nodeId);

function testTimeouts(section: SectionFn, scp: TestSCP, f: () => void): void {
  section('minimum values', () => {
    scp.initialNominationTimeoutMs = 750;
    scp.incrementNominationTimeoutMs = 750;
    scp.initialBallotTimeoutMs = 750;
    scp.incrementBallotTimeoutMs = 750;
    f();
  });
  section('initial values', () => {
    scp.initialNominationTimeoutMs = 1000;
    scp.incrementNominationTimeoutMs = 1000;
    scp.initialBallotTimeoutMs = 1000;
    scp.incrementBallotTimeoutMs = 1000;
    f();
  });
  section('maximum values', () => {
    scp.initialNominationTimeoutMs = 2500;
    scp.incrementNominationTimeoutMs = 2000;
    scp.initialBallotTimeoutMs = 2500;
    scp.incrementBallotTimeoutMs = 2000;
    f();
  });
}

function registerSectionTests(name: string, body: SectionBody): number {
  const paths = discoverSectionPaths(body);
  describe(name, () => {
    for (const path of paths) {
      it(path.join(' > ') || '(root)', () => runSectionPath(body, path));
    }
  });
  return paths.length;
}

const checkLeaders = (scp: TestSCP, expectedLeaders: NodeId[]) => {
  expect(new Set(scp.getNominationLeaders(0))).toEqual(new Set(expectedLeaders));
};

const nominationCore5: SectionBody = (section) => {
  // we need 5 nodes to avoid sharing various thresholds:
  // v-blocking set size: 2
  // threshold: 4 = 3 + self or 4 others
  const qSet: QuorumSet = { threshold: 4, validators: [v0, v1, v2, v3, v4], innerSets: [] };
  const qSetHash = hashQuorumSet(qSet);

  expect(xValue < yValue).toBe(true);
  expect(yValue < zValue).toBe(true);

  section('nomination - v0 is top', () => {
    const scp = new TestSCP(v0, qSet);

    testTimeouts(section, scp, () => {
      const qSetHash0 = scp.scp.getLocalQuorumSetHash();
      scp.storeQuorumSet(qSet);

      section('v0 starts to nominates xValue', () => {
        expect(scp.nominate(0, xValue, false)).toBe(true);

        checkLeaders(scp, [v0]);

        section('others nominate what v0 says (x) -> prepare x', () => {
          const votes: Value[] = [xValue];
          const accepted: Value[] = [];

          expect(scp.envs.length).toBe(1);
          verifyNominate(scp.envs[0], v0, qSetHash0, 0, votes, accepted);

          const nom1 = makeNominate(v1, qSetHash, 0, votes, accepted);
          const nom2 = makeNominate(v2, qSetHash, 0, votes, accepted);
          const nom3 = makeNominate(v3, qSetHash, 0, votes, accepted);
          const nom4 = makeNominate(v4, qSetHash, 0, votes, accepted);

          // nothing happens yet
          scp.receiveEnvelope(nom1);
          scp.receiveEnvelope(nom2);
          expect(scp.envs.length).toBe(1);

          // this causes 'x' to be accepted (quorum)
          scp.receiveEnvelope(nom3);
          expect(scp.envs.length).toBe(2);

          scp.expectedCandidates.add(xValue);
          scp.compositeValue = xValue;

          accepted.push(xValue);
          verifyNominate(scp.envs[1], v0, qSetHash0, 0, votes, accepted);

          // extra message doesn't do anything
          scp.receiveEnvelope(nom4);
          expect(scp.envs.length).toBe(2);

          const acc1 = makeNominate(v1, qSetHash, 0, votes, accepted);
          const acc2 = makeNominate(v2, qSetHash, 0, votes, accepted);
          const acc3 = makeNominate(v3, qSetHash, 0, votes, accepted);
          const acc4 = makeNominate(v4, qSetHash, 0, votes, accepted);

          // nothing happens yet
          scp.receiveEnvelope(acc1);
          scp.receiveEnvelope(acc2);
          expect(scp.envs.length).toBe(2);

          scp.compositeValue = xValue;
          // this causes the node to send a prepare message (quorum)
          scp.receiveEnvelope(acc3);
          expect(scp.envs.length).toBe(3);

          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, { counter: 1, value: xValue });

          scp.receiveEnvelope(acc4);
          expect(scp.envs.length).toBe(3);

          const votes2 = [...votes, yValue];

          section('nominate x -> accept x -> prepare (x) ; others accepted y -> update latest to (z=x+y)', () => {
            const acc1_2 = makeNominate(v1, qSetHash, 0, votes2, votes2);
            const acc2_2 = makeNominate(v2, qSetHash, 0, votes2, votes2);
            const acc3_2 = makeNominate(v3, qSetHash, 0, votes2, votes2);
            const acc4_2 = makeNominate(v4, qSetHash, 0, votes2, votes2);

            scp.receiveEnvelope(acc1_2);
            expect(scp.envs.length).toBe(3);

            // v-blocking
            scp.receiveEnvelope(acc2_2);
            expect(scp.envs.length).toBe(4);
            verifyNominate(scp.envs[3], v0, qSetHash0, 0, votes2, votes2);

            scp.expectedCandidates.add(yValue);
            scp.compositeValue = kValue;
            // this updates the composite value to use next time
            // but does not prepare it
            scp.receiveEnvelope(acc3_2);
            expect(scp.envs.length).toBe(4);

            expect(scp.getLatestCompositeCandidate(0)).toBe(kValue);

            scp.receiveEnvelope(acc4_2);
            expect(scp.envs.length).toBe(4);
          });
          section('nomination - restored state', () => {
            const scp2 = new TestSCP(v0, qSet);
            scp2.storeQuorumSet(qSet);

            // at this point
            // votes = { x }
            // accepted = { x }

            // tests if nomination proceeds like normal
            // nominates x
            const nominationRestore = () => {
              // restores from the previous state
              scp2.scp.setStateFromEnvelope(0, makeNominate(v0, qSetHash0, 0, votes, accepted));
              // tries to start nomination with yValue, but picks
              // xValue since it was already in the votes
              expect(scp2.nominate(0, yValue, false)).toBe(false);

              checkLeaders(scp2, [v0]);

              expect(scp2.envs.length).toBe(0);

              // other nodes vote for 'x'
              scp2.receiveEnvelope(nom1);
              scp2.receiveEnvelope(nom2);
              expect(scp2.envs.length).toBe(0);
              // 'x' is accepted (quorum)
              // but because the restored state already included
              // 'x' in the accepted set, no new message is
              // emitted
              scp2.receiveEnvelope(nom3);

              scp2.expectedCandidates.add(xValue);
              scp2.compositeValue = xValue;

              // other nodes not emit 'x' as accepted
              scp2.receiveEnvelope(acc1);
              scp2.receiveEnvelope(acc2);
              expect(scp2.envs.length).toBe(0);

              scp2.compositeValue = xValue;
              // this causes the node to update its composite
              // value to x
              scp2.receiveEnvelope(acc3);
            };

            section('ballot protocol not started', () => {
              nominationRestore();
              // nomination ended up starting the ballot protocol
              expect(scp2.envs.length).toBe(1);

              verifyPrepare(scp2.envs[0], v0, qSetHash0, 0, { counter: 1, value: xValue });
            });
            section('ballot protocol started (on value k)', () => {
              scp2.scp.setStateFromEnvelope(0, makePrepare(v0, qSetHash0, 0, { counter: 1, value: kValue }));
              nominationRestore();
              // nomination didn't do anything (already working on k)
              expect(scp2.envs.length).toBe(0);
            });
          });
        });
        section('receive more messages, then v0 switches to a different leader', () => {
          const nom1 = makeNominate(v1, qSetHash, 0, [kValue], []);
          const nom2 = makeNominate(v2, qSetHash, 0, [yValue], []);

          // nothing more happens
          scp.receiveEnvelope(nom1);
          scp.receiveEnvelope(nom2);
          expect(scp.envs.length).toBe(1);

          // switch leader to v1
          scp.priorityLookup = (n) => (n === v1 ? 1000n : 1n);
          expect(scp.nominate(0, xValue, true)).toBe(true);
          expect(scp.envs.length).toBe(2);

          const votesXK = [xValue, kValue].sort();

          verifyNominate(scp.envs[1], v0, qSetHash0, 0, votesXK, []);
        });
        section('select accepted value from leader', () => {
          expect(xValue < yValue).toBe(true);
          expect(yValue < zValue).toBe(true);
          expect(scp.envs.length).toBe(1);

          // Update round leader to v1
          scp.priorityLookup = (n) => (n === v1 ? 1000n : 1n);

          const nom1 = makeNominate(v1, qSetHash, 0, [yValue, zValue], [yValue]);

          section('receive accepted before timeout', () => {
            // nothing more happens, v0 is leader
            scp.receiveEnvelope(nom1);
            expect(scp.envs.length).toBe(1);

            // Update round leaders, vote for accepted value (y)
            expect(scp.nominate(0, xValue, true)).toBe(true);
            expect(scp.envs.length).toBe(2);
          });
          section('receive accepted after timeout', () => {
            expect(scp.nominate(0, xValue, true)).toBe(false);
            expect(scp.envs.length).toBe(1);

            // Vote for accepted value (y)
            scp.receiveEnvelope(nom1);
            expect(scp.envs.length).toBe(2);
          });

          const votesXY = [xValue, yValue];

          verifyNominate(scp.envs[1], v0, qSetHash0, 0, votesXY, []);

          const nom2 = makeNominate(v1, qSetHash, 0, [yValue, zValue, zzValue], [yValue]);
          scp.receiveEnvelope(nom2);
          // Nothing happens, as v0 already voted for the accepted
          // value (y)
          expect(scp.envs.length).toBe(2);
          verifyNominate(scp.envs[1], v0, qSetHash0, 0, votesXY, []);
        });
      });
      section("self nominates 'x', others nominate y -> prepare y", () => {
        const myVotes: Value[] = [xValue];
        const accepted: Value[] = [];

        scp.expectedCandidates.add(xValue);
        scp.compositeValue = xValue;
        expect(scp.nominate(0, xValue, false)).toBe(true);

        expect(scp.envs.length).toBe(1);
        verifyNominate(scp.envs[0], v0, qSetHash0, 0, myVotes, accepted);

        const votes: Value[] = [yValue];

        const acceptedY = [...accepted, yValue];

        section('others only vote for y', () => {
          const nom1 = makeNominate(v1, qSetHash, 0, votes, accepted);
          const nom2 = makeNominate(v2, qSetHash, 0, votes, accepted);
          const nom3 = makeNominate(v3, qSetHash, 0, votes, accepted);
          const nom4 = makeNominate(v4, qSetHash, 0, votes, accepted);

          // nothing happens yet
          scp.receiveEnvelope(nom1);
          scp.receiveEnvelope(nom2);
          scp.receiveEnvelope(nom3);
          expect(scp.envs.length).toBe(1);

          // 'y' is accepted (quorum)
          scp.receiveEnvelope(nom4);
          expect(scp.envs.length).toBe(2);
          myVotes.push(yValue);
          verifyNominate(scp.envs[1], v0, qSetHash0, 0, myVotes, acceptedY);
        });
        section('others accepted y', () => {
          const acc1 = makeNominate(v1, qSetHash, 0, votes, acceptedY);
          const acc2 = makeNominate(v2, qSetHash, 0, votes, acceptedY);
          const acc3 = makeNominate(v3, qSetHash, 0, votes, acceptedY);
          const acc4 = makeNominate(v4, qSetHash, 0, votes, acceptedY);

          scp.receiveEnvelope(acc1);
          expect(scp.envs.length).toBe(1);

          // this causes 'y' to be accepted (v-blocking)
          scp.receiveEnvelope(acc2);
          expect(scp.envs.length).toBe(2);

          myVotes.push(yValue);
          verifyNominate(scp.envs[1], v0, qSetHash0, 0, myVotes, acceptedY);

          scp.expectedCandidates.clear();
          scp.expectedCandidates.add(yValue);
          scp.compositeValue = yValue;
          // this causes the node to send a prepare message (quorum)
          scp.receiveEnvelope(acc3);
          expect(scp.envs.length).toBe(3);

          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, { counter: 1, value: yValue });

          scp.receiveEnvelope(acc4);
          expect(scp.envs.length).toBe(3);
        });
      });
    });
  });

  section('v1 is top node', () => {
    const scp = new TestSCP(v0, qSet);

    testTimeouts(section, scp, () => {
      const qSetHash0 = scp.scp.getLocalQuorumSetHash();
      scp.storeQuorumSet(qSet);

      scp.priorityLookup = (n) => (n === v1 ? 1000n : 1n);

      const votesX = [xValue];
      const votesY = [yValue];
      const votesXY = [xValue, yValue];
      const votesXK = [xValue, kValue].sort();
      const emptyV: Value[] = [];

      const valuesHash = [xValue, yValue, kValue].sort();

      scp.hashValueCalculator = (v) => {
        const pos = valuesHash.indexOf(v);
        if (pos < 0) throw new Error('unexpected value');
        return BigInt(1 + pos);
      };

      let nom1 = makeNominate(v1, qSetHash, 0, votesXY, emptyV);
      let nom2 = makeNominate(v2, qSetHash, 0, votesXK, emptyV);

      section('value from v1 is a candidate, self should not introduce new value on timeout', () => {
        expect(scp.nominate(0, xValue, false)).toBe(false);
        checkLeaders(scp, [v1]);

        expect(scp.envs.length).toBe(0);
        nom1 = makeNominate(v1, qSetHash, 0, votesX, emptyV);
        nom2 = makeNominate(v2, qSetHash, 0, votesX, emptyV);
        const nom3 = makeNominate(v3, qSetHash, 0, votesX, emptyV);

        // Receive `x` from v1, vote for it
        scp.receiveEnvelope(nom1);
        expect(scp.envs.length).toBe(1);
        verifyNominate(scp.envs[0], v0, qSetHash0, 0, votesX, emptyV);

        scp.receiveEnvelope(nom2);
        scp.receiveEnvelope(nom3);
        expect(scp.envs.length).toBe(2);
        verifyNominate(scp.envs[1], v0, qSetHash0, 0, votesX, votesX);

        const acc1 = makeNominate(v1, qSetHash, 0, votesX, votesX);
        const acc2 = makeNominate(v2, qSetHash, 0, votesX, votesX);
        const acc3 = makeNominate(v3, qSetHash, 0, votesX, votesX);

        scp.receiveEnvelope(acc1);
        scp.receiveEnvelope(acc2);
        expect(scp.envs.length).toBe(2);

        // Receive accept from quorum, ratify and generate a candidate
        // value
        expect(scp.timers.has(TIMER_NOMINATION)).toBe(true);
        scp.compositeValue = xValue;
        scp.expectedCandidates.add(xValue);
        scp.receiveEnvelope(acc3);
        expect(scp.envs.length).toBe(3);
        // Timer is cancelled
        expect(scp.timers.has(TIMER_NOMINATION)).toBe(false);

        // v0 is the new leader, but we already have a candidate
        scp.priorityLookup = (n) => (n === v0 ? 1000n : 1n);
        expect(scp.nominate(0, kValue, true)).toBe(false);
      });
      section('nomination waits for v1', () => {
        expect(scp.nominate(0, xValue, false)).toBe(false);

        checkLeaders(scp, [v1]);

        expect(scp.envs.length).toBe(0);

        const nom4 = makeNominate(v4, qSetHash, 0, votesXK, emptyV);

        // nothing happens with non top nodes
        scp.receiveEnvelope(nom2);
        // (note: don't receive anything from node3 - we want to pick
        // another dead node)
        expect(scp.envs.length).toBe(0);

        // v1 is leader -> nominate the first value from its message
        // that's "y"
        scp.receiveEnvelope(nom1);
        expect(scp.envs.length).toBe(1);
        verifyNominate(scp.envs[0], v0, qSetHash0, 0, votesY, emptyV);

        scp.receiveEnvelope(nom4);
        expect(scp.envs.length).toBe(1);

        // "timeout -> pick another value from v1"
        scp.expectedCandidates.add(xValue);
        scp.compositeValue = xValue;

        // allows to pick another leader,
        // pick another dead node v3 as to force picking up
        // a new value from v1
        scp.priorityLookup = (n) => (n === v3 ? 1000n : 1n);

        // note: value passed in here should be ignored
        expect(scp.nominate(0, kValue, true)).toBe(true);
        // picks up 'x' from v1 (as we already have 'y')
        // which also happens to causes 'x' to be accepted
        expect(scp.envs.length).toBe(2);
        verifyNominate(scp.envs[1], v0, qSetHash0, 0, votesXY, votesX);
      });
      section('v1 dead, timeout', () => {
        expect(scp.nominate(0, xValue, false)).toBe(false);

        expect(scp.envs.length).toBe(0);

        scp.receiveEnvelope(nom2);
        expect(scp.envs.length).toBe(0);

        checkLeaders(scp, [v1]);

        section('v0 is new top node', () => {
          scp.priorityLookup = (n) => (n === v0 ? 1000n : 1n);

          expect(scp.nominate(0, xValue, true)).toBe(true);
          checkLeaders(scp, [v0, v1]);

          expect(scp.envs.length).toBe(1);
          verifyNominate(scp.envs[0], v0, qSetHash0, 0, votesX, emptyV);
        });
        section('v2 is new top node', () => {
          scp.priorityLookup = (n) => (n === v2 ? 1000n : 1n);

          expect(scp.nominate(0, xValue, true)).toBe(true);
          checkLeaders(scp, [v1, v2]);

          expect(scp.envs.length).toBe(1);
          // v2 votes for XK, but nomination only picks the highest value
          const v2Top = [xValue > kValue ? xValue : kValue];
          verifyNominate(scp.envs[0], v0, qSetHash0, 0, v2Top, emptyV);
        });
        section('v3 is new top node', () => {
          scp.priorityLookup = (n) => (n === v3 ? 1000n : 1n);
          // nothing happens, we don't have any message for v3
          expect(scp.nominate(0, xValue, true)).toBe(false);
          checkLeaders(scp, [v1, v3]);

          expect(scp.envs.length).toBe(0);
        });
      });
    });
  });
};

const nominationCount = registerSectionTests('nomination tests core5', nominationCore5);

describe('nomination: ported case count', () => {
  it('covers the whole nomination section tree', () => {
    // 3 timeout settings x (8 leaves for "v0 is top" + 5 for "v1 is top")
    expect(nominationCount).toBe(3 * 13);
  });
});

// ---------------------------------------------------------------------------

describe('validation levels (SCPTests.cpp)', () => {
  const qSet: QuorumSet = { threshold: 2, validators: [v0, v1, v2], innerSets: [] };
  const qSetHash = hashQuorumSet(qSet);

  it('Proper handling of non-current ledger value: do not emit a MaybeValid ballot', () => {
    const scp = new TestSCP(v0, qSet);
    scp.storeQuorumSet(qSet);
    // validateValue reports xValue is not for the current ledger.
    scp.validateValueOverride = () => ValidationLevel.MaybeValid;

    expect(scp.bumpState(0, xValue)).toBe(true);
    // Do not emit a ballot with a MaybeValid value
    expect(scp.envs.length).toBe(0);
    expect(scp.scp.isSlotFullyValidated(0)).toBe(false);
  });

  it('incoming PREPARE with an invalid value is dropped', () => {
    const scp = new TestSCP(v0, qSet);
    scp.storeQuorumSet(qSet);
    scp.validateValueOverride = (_s, v) => (v === xValue ? ValidationLevel.Invalid : ValidationLevel.FullyValidated);

    const xB1 = { counter: 1, value: xValue };
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 0, xB1))).toBe(EnvelopeState.INVALID);
    // Envelope was not recorded
    expect(scp.scp.getLatestMessage(v1)).toBe(null);
    // No local emit triggered.
    expect(scp.envs.length).toBe(0);
  });

  it('incoming PREPARE with an invalid prepared value is dropped', () => {
    const scp = new TestSCP(v0, qSet);
    scp.storeQuorumSet(qSet);
    expect(scp.bumpState(0, yValue)).toBe(true);
    scp.validateValueOverride = (_s, v) => (v === xValue ? ValidationLevel.Invalid : ValidationLevel.FullyValidated);
    const yB1 = { counter: 1, value: yValue };
    const xB1 = { counter: 1, value: xValue };
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 0, yB1, xB1))).toBe(EnvelopeState.INVALID);
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 0, yB1, yB1))).toBe(EnvelopeState.VALID);
  });

  it('a MaybeValid peer value marks the slot not fully validated (watcher behavior)', () => {
    const scp = new TestSCP(v0, qSet);
    scp.storeQuorumSet(qSet);
    expect(scp.scp.isSlotFullyValidated(0)).toBe(false); // slot does not exist yet
    scp.validateValueOverride = (_s, v) => (v === xValue ? ValidationLevel.MaybeValid : ValidationLevel.FullyValidated);
    const xB1 = { counter: 1, value: xValue };
    expect(scp.receiveEnvelope(makePrepare(v1, qSetHash, 0, xB1))).toBe(EnvelopeState.VALID);
    expect(scp.scp.isSlotFullyValidated(0)).toBe(false);
    // the node still follows the protocol locally but never emits
    expect(scp.bumpState(0, yValue)).toBe(true);
    expect(scp.envs.length).toBe(0);
    expect(scp.scp.getLatestMessagesSend(0)).toEqual([]);
  });

  it('nomination of an invalid value from a leader is ignored', () => {
    const scp = new TestSCP(v0, qSet);
    scp.storeQuorumSet(qSet);
    scp.priorityLookup = (n) => (n === v1 ? 1000n : 1n);
    scp.validateValueOverride = (_s, v, nomination) =>
      v === xValue && nomination ? ValidationLevel.Invalid : ValidationLevel.FullyValidated;
    expect(scp.nominate(0, yValue, false)).toBe(false);
    // the leader only votes for an invalid value -> nothing to echo
    scp.receiveEnvelope(makeNominate(v1, qSetHash, 0, [xValue], []));
    expect(scp.envs.length).toBe(0);
    // a valid value from the leader is echoed; with t=2 our vote and v1's
    // vote form a quorum, so z is accepted right away
    scp.receiveEnvelope(makeNominate(v1, qSetHash, 0, [xValue, zValue], []));
    expect(scp.envs.length).toBe(1);
    verifyNominate(scp.envs[0], v0, scp.scp.getLocalQuorumSetHash(), 0, [zValue], [zValue]);
  });

  it('extractValidValue is used when a leader value is not fully valid', () => {
    const scp = new TestSCP(v0, qSet);
    scp.storeQuorumSet(qSet);
    scp.priorityLookup = (n) => (n === v1 ? 1000n : 1n);
    scp.validateValueOverride = (_s, v) => (v === xValue ? ValidationLevel.MaybeValid : ValidationLevel.FullyValidated);
    scp.extractValidValue = (_s, v) => (v === xValue ? zzValue : null);
    expect(scp.nominate(0, yValue, false)).toBe(false);
    scp.receiveEnvelope(makeNominate(v1, qSetHash, 0, [xValue], []));
    expect(scp.envs.length).toBe(1);
    verifyNominate(scp.envs[0], v0, scp.scp.getLocalQuorumSetHash(), 0, [zzValue], []);
  });
});

// ---------------------------------------------------------------------------

describe('nomination weight (SCPUnitTests.cpp)', () => {
  const isNear = (r: bigint, target: number) => Math.abs(Number(r) / Number(UINT64_MAX) - target) < 0.01;

  it('fraction of slices containing the node', () => {
    const qSet: QuorumSet = { threshold: 3, validators: [v0, v1, v2, v3], innerSets: [] };

    let result = getNodeWeight(v2, qSet, false);
    expect(isNear(result, 0.75)).toBe(true);

    result = getNodeWeight(v4, qSet, false);
    expect(result).toBe(0n);

    const iQSet: QuorumSet = { threshold: 1, validators: [v4, v5], innerSets: [] };
    qSet.innerSets.push(iQSet);

    result = getNodeWeight(v4, qSet, false);
    expect(isNear(result, 0.6 * 0.5)).toBe(true);

    // local node is in all its slices
    expect(getNodeWeight(v4, qSet, true)).toBe(UINT64_MAX);
  });

  it('weights are rounded up (bigDivide ROUND_UP)', () => {
    const qSet: QuorumSet = { threshold: 2, validators: [v1, v2, v3], innerSets: [] };
    // ceil(UINT64_MAX * 2 / 3)
    expect(getNodeWeight(v1, qSet, false)).toBe((UINT64_MAX * 2n + 2n) / 3n);
    const all: QuorumSet = { threshold: 3, validators: [v1, v2, v3], innerSets: [] };
    expect(getNodeWeight(v1, all, false)).toBe(UINT64_MAX);
  });

  it('updateRoundLeaders handles zero weight nodes', () => {
    const qSet: QuorumSet = { threshold: 2, validators: [v0, v1, v2], innerSets: [] };

    const runScenario = (zeroWeightNodes: Set<NodeId>): NodeId[] => {
      const scp = new TestSCP(v0, qSet);
      scp.storeQuorumSet(qSet);
      (scp as TestSCP & { getNodeWeight: (n: NodeId, q: QuorumSet, l: boolean) => bigint }).getNodeWeight = (
        n,
        q,
        isLocal,
      ) => (zeroWeightNodes.has(n) ? 0n : getNodeWeight(n, q, isLocal));
      // the default test priorities never change: every node gets the same
      // priority so each round adds the remaining nodes until all
      // non-zero-weight nodes are leaders.
      scp.priorityLookup = () => 7n;
      for (let i = 0; i < 20; i++) scp.nominate(0, xValue, i > 0);
      return scp.getNominationLeaders(0);
    };

    // non-local zero-weight validator is excluded from round leaders
    let leaders = runScenario(new Set([v2]));
    expect(new Set(leaders)).toEqual(new Set([v0, v1]));

    // local zero-weight validator is excluded from round leaders
    leaders = runScenario(new Set([v0]));
    expect(new Set(leaders)).toEqual(new Set([v1, v2]));
  });
});
