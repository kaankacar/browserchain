// Ported from stellar-core (Apache-2.0): src/scp/test/SCPTests.cpp ("ballot
// protocol core5", "ballot protocol core3"). Each Catch2 SECTION path is one
// vitest case. Numbers in parenthesis refer to the protocol rules.

import { describe, expect, it } from 'vitest';
import { UINT32_MAX } from './quorum';
import type { Ballot, Envelope, Hash, NodeId, QuorumSet } from './types';
import { hashQuorumSet } from './xdr';
import {
  TestSCP,
  discoverSectionPaths,
  makeConfirm,
  makeExternalize,
  makePrepare,
  nodeId,
  runSectionPath,
  setupValues,
  verifyConfirm,
  verifyExternalize,
  verifyPrepare,
  type SectionBody,
  type SectionFn,
} from './testkit';

type GenEnvelope = (node: NodeId) => Envelope;

const B = (counter: number, value: string): Ballot => ({ counter, value });

function makePrepareGen(
  qSetHash: Hash,
  ballot: Ballot,
  prepared: Ballot | null = null,
  nC = 0,
  nH = 0,
  preparedPrime: Ballot | null = null,
): GenEnvelope {
  return (n) => makePrepare(n, qSetHash, 0, ballot, prepared, nC, nH, preparedPrime);
}

function makeConfirmGen(qSetHash: Hash, prepareCounter: number, b: Ballot, nC: number, nH: number): GenEnvelope {
  return (n) => makeConfirm(n, qSetHash, 0, prepareCounter, b, nC, nH);
}

function makeExternalizeGen(qSetHash: Hash, commit: Ballot, nH: number): GenEnvelope {
  return (n) => makeExternalize(n, qSetHash, 0, commit, nH);
}

// Testing matrix over the timeout parameters (values taken from the Soroban
// network config range in stellar-core: minimum, initial, maximum).
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

const { x: xValue, y: yValue, z: zValue, zz: zzValue, k: kValue } = setupValues('ballot');
void kValue;

const [v0, v1, v2, v3, v4] = [0, 1, 2, 3, 4].map(nodeId);

// ---------------------------------------------------------------------------

const core5: SectionBody = (section) => {
  // we need 5 nodes to avoid sharing various thresholds:
  // v-blocking set size: 2
  // threshold: 4 = 3 + self or 4 others
  const qSet: QuorumSet = { threshold: 4, validators: [v0, v1, v2, v3, v4], innerSets: [] };
  const qSetHash = hashQuorumSet(qSet);

  const scp = new TestSCP(v0, qSet);

  testTimeouts(section, scp, () => {
    scp.storeQuorumSet(qSet);
    const qSetHash0 = scp.scp.getLocalQuorumSetHash();

    expect(xValue < yValue).toBe(true);
    expect(yValue < zValue).toBe(true);
    expect(zValue < zzValue).toBe(true);

    const recvVBlockingChecks = (gen: GenEnvelope, withChecks: boolean) => {
      const e1 = gen(v1);
      const e2 = gen(v2);

      scp.bumpTimerOffset();

      // nothing should happen with first message
      let i = scp.envs.length;
      scp.receiveEnvelope(e1);
      if (withChecks) expect(scp.envs.length).toBe(i);
      i++;
      scp.receiveEnvelope(e2);
      if (withChecks) expect(scp.envs.length).toBe(i);
    };

    const recvVBlocking = (gen: GenEnvelope) => recvVBlockingChecks(gen, true);

    const recvQuorumChecksEx = (gen: GenEnvelope, withChecks: boolean, delayedQuorum: boolean, checkUpcoming: boolean) => {
      const e1 = gen(v1);
      const e2 = gen(v2);
      const e3 = gen(v3);
      const e4 = gen(v4);

      scp.bumpTimerOffset();

      scp.receiveEnvelope(e1);
      scp.receiveEnvelope(e2);
      const i = scp.envs.length + 1;
      scp.receiveEnvelope(e3);
      if (withChecks && !delayedQuorum) expect(scp.envs.length).toBe(i);
      if (checkUpcoming && !delayedQuorum) expect(scp.hasBallotTimerUpcoming()).toBe(true);
      // nothing happens with an extra vote (unless we're in delayedQuorum)
      scp.receiveEnvelope(e4);
      if (withChecks && delayedQuorum) expect(scp.envs.length).toBe(i);
      if (checkUpcoming && delayedQuorum) expect(scp.hasBallotTimerUpcoming()).toBe(true);
    };
    // doesn't check timers
    const recvQuorumChecks = (gen: GenEnvelope, withChecks: boolean, delayedQuorum: boolean) =>
      recvQuorumChecksEx(gen, withChecks, delayedQuorum, false);
    // checks enabled, no delayed quorum
    const recvQuorumEx = (gen: GenEnvelope, checkUpcoming: boolean) => recvQuorumChecksEx(gen, true, false, checkUpcoming);
    // checks enabled, no delayed quorum, no check timers
    const recvQuorum = (gen: GenEnvelope) => recvQuorumEx(gen, false);

    const nodesAllPledgeToCommit = () => {
      const b = B(1, xValue);
      const prepare1 = makePrepare(v1, qSetHash, 0, b);
      const prepare2 = makePrepare(v2, qSetHash, 0, b);
      const prepare3 = makePrepare(v3, qSetHash, 0, b);
      const prepare4 = makePrepare(v4, qSetHash, 0, b);

      expect(scp.bumpState(0, xValue)).toBe(true);
      expect(scp.envs.length).toBe(1);

      verifyPrepare(scp.envs[0], v0, qSetHash0, 0, b);

      scp.receiveEnvelope(prepare1);
      expect(scp.envs.length).toBe(1);
      expect(scp.heardFromQuorumsOf(0).length).toBe(0);

      scp.receiveEnvelope(prepare2);
      expect(scp.envs.length).toBe(1);
      expect(scp.heardFromQuorumsOf(0).length).toBe(0);

      scp.receiveEnvelope(prepare3);
      expect(scp.envs.length).toBe(2);
      expect(scp.heardFromQuorumsOf(0).length).toBe(1);
      expect(scp.heardFromQuorumsOf(0)[0]).toEqual(b);

      // We have a quorum including us

      verifyPrepare(scp.envs[1], v0, qSetHash0, 0, b, b);

      scp.receiveEnvelope(prepare4);
      expect(scp.envs.length).toBe(2);

      const prepared1 = makePrepare(v1, qSetHash, 0, b, b);
      const prepared2 = makePrepare(v2, qSetHash, 0, b, b);
      const prepared3 = makePrepare(v3, qSetHash, 0, b, b);
      const prepared4 = makePrepare(v4, qSetHash, 0, b, b);

      scp.receiveEnvelope(prepared4);
      scp.receiveEnvelope(prepared3);
      expect(scp.envs.length).toBe(2);

      scp.receiveEnvelope(prepared2);
      expect(scp.envs.length).toBe(3);

      // confirms prepared
      verifyPrepare(scp.envs[2], v0, qSetHash0, 0, b, b, b.counter, b.counter);

      // extra statement doesn't do anything
      scp.receiveEnvelope(prepared1);
      expect(scp.envs.length).toBe(3);
    };

    section('bumpState x', () => {
      expect(scp.bumpState(0, xValue)).toBe(true);
      expect(scp.envs.length).toBe(1);

      const expectedBallot = B(1, xValue);

      verifyPrepare(scp.envs[0], v0, qSetHash0, 0, expectedBallot);
    });

    section('start <1,x>', () => {
      // no timer is set
      expect(scp.hasBallotTimer()).toBe(false);

      const aValue = xValue;
      const bValue = zValue;
      const midValue = yValue;
      const bigValue = zzValue;

      const A1 = B(1, aValue);
      const B1 = B(1, bValue);
      const Mid1 = B(1, midValue);
      const Big1 = B(1, bigValue);

      const A2 = B(2, aValue);
      const A3 = B(3, aValue);
      const A4 = B(4, aValue);
      const A5 = B(5, aValue);

      const AInf = B(UINT32_MAX, aValue);
      const BInf = B(UINT32_MAX, bValue);

      const B2 = B(2, bValue);
      const B3 = B(3, bValue);

      const Mid2 = B(2, midValue);
      const Big2 = B(2, bigValue);
      void Mid1;
      void Big1;

      expect(scp.bumpState(0, aValue)).toBe(true);
      expect(scp.envs.length).toBe(1);
      expect(scp.hasBallotTimer()).toBe(false);

      section('prepared A1', () => {
        recvQuorumEx(makePrepareGen(qSetHash, A1), true);

        expect(scp.envs.length).toBe(2);
        verifyPrepare(scp.envs[1], v0, qSetHash0, 0, A1, A1);

        section('bump prepared A2', () => {
          // bump to (2,a)

          scp.bumpTimerOffset();
          expect(scp.bumpState(0, aValue)).toBe(true);
          expect(scp.envs.length).toBe(3);
          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, A2, A1);
          expect(scp.hasBallotTimer()).toBe(false);

          recvQuorumEx(makePrepareGen(qSetHash, A2), true);
          expect(scp.envs.length).toBe(4);
          verifyPrepare(scp.envs[3], v0, qSetHash0, 0, A2, A2);

          section('Confirm prepared A2', () => {
            recvQuorum(makePrepareGen(qSetHash, A2, A2));
            expect(scp.envs.length).toBe(5);
            verifyPrepare(scp.envs[4], v0, qSetHash0, 0, A2, A2, 2, 2);
            expect(scp.hasBallotTimerUpcoming()).toBe(false);

            section('Accept commit', () => {
              section('Quorum A2', () => {
                recvQuorum(makePrepareGen(qSetHash, A2, A2, 2, 2));
                expect(scp.envs.length).toBe(6);
                verifyConfirm(scp.envs[5], v0, qSetHash0, 0, 2, A2, 2, 2);
                expect(scp.hasBallotTimerUpcoming()).toBe(false);

                section('Quorum prepared A3', () => {
                  recvVBlocking(makePrepareGen(qSetHash, A3, A2, 2, 2));
                  expect(scp.envs.length).toBe(7);
                  verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 2, A3, 2, 2);
                  expect(scp.hasBallotTimer()).toBe(false);

                  recvQuorumEx(makePrepareGen(qSetHash, A3, A2, 2, 2), true);
                  expect(scp.envs.length).toBe(8);
                  verifyConfirm(scp.envs[7], v0, qSetHash0, 0, 3, A3, 2, 2);

                  section('Accept more commit A3', () => {
                    recvQuorum(makePrepareGen(qSetHash, A3, A3, 2, 3));
                    expect(scp.envs.length).toBe(9);
                    verifyConfirm(scp.envs[8], v0, qSetHash0, 0, 3, A3, 2, 3);
                    expect(scp.hasBallotTimerUpcoming()).toBe(false);

                    expect(scp.externalizedValues.size).toBe(0);

                    section('Quorum externalize A3', () => {
                      recvQuorum(makeConfirmGen(qSetHash, 3, A3, 2, 3));
                      expect(scp.envs.length).toBe(10);
                      verifyExternalize(scp.envs[9], v0, qSetHash0, 0, A2, 3);
                      expect(scp.hasBallotTimer()).toBe(false);

                      expect(scp.externalizedValues.size).toBe(1);
                      expect(scp.externalizedValues.get(0)).toBe(aValue);
                    });
                  });
                  section('v-blocking accept more A3', () => {
                    section('Confirm A3', () => {
                      recvVBlocking(makeConfirmGen(qSetHash, 3, A3, 2, 3));
                      expect(scp.envs.length).toBe(9);
                      verifyConfirm(scp.envs[8], v0, qSetHash0, 0, 3, A3, 2, 3);
                      expect(scp.hasBallotTimerUpcoming()).toBe(false);
                    });
                    section('Externalize A3', () => {
                      recvVBlocking(makeExternalizeGen(qSetHash, A2, 3));
                      expect(scp.envs.length).toBe(9);
                      verifyConfirm(scp.envs[8], v0, qSetHash0, 0, UINT32_MAX, AInf, 2, UINT32_MAX);
                      expect(scp.hasBallotTimer()).toBe(false);
                    });
                    section('other nodes moved to c=A4 h=A5', () => {
                      section('Confirm A4..5', () => {
                        recvVBlocking(makeConfirmGen(qSetHash, 3, A5, 4, 5));
                        expect(scp.envs.length).toBe(9);
                        verifyConfirm(scp.envs[8], v0, qSetHash0, 0, 3, A5, 4, 5);
                        expect(scp.hasBallotTimer()).toBe(false);
                      });
                      section('Externalize A4..5', () => {
                        recvVBlocking(makeExternalizeGen(qSetHash, A4, 5));
                        expect(scp.envs.length).toBe(9);
                        verifyConfirm(scp.envs[8], v0, qSetHash0, 0, UINT32_MAX, AInf, 4, UINT32_MAX);
                        expect(scp.hasBallotTimer()).toBe(false);
                      });
                    });
                  });
                });
                section('v-blocking prepared A3', () => {
                  recvVBlocking(makePrepareGen(qSetHash, A3, A3, 2, 2));
                  expect(scp.envs.length).toBe(7);
                  verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 3, A3, 2, 2);
                  expect(scp.hasBallotTimer()).toBe(false);
                });
                section('v-blocking prepared A3+B3', () => {
                  recvVBlocking(makePrepareGen(qSetHash, A3, B3, 2, 2, A3));
                  expect(scp.envs.length).toBe(7);
                  verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 3, A3, 2, 2);
                  expect(scp.hasBallotTimer()).toBe(false);
                });
                section('v-blocking confirm A3', () => {
                  recvVBlocking(makeConfirmGen(qSetHash, 3, A3, 2, 2));
                  expect(scp.envs.length).toBe(7);
                  verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 3, A3, 2, 2);
                  expect(scp.hasBallotTimer()).toBe(false);
                });
                section('Hang - does not switch to B in CONFIRM', () => {
                  section('Network EXTERNALIZE', () => {
                    // externalize messages have a counter at infinite
                    recvVBlocking(makeExternalizeGen(qSetHash, B2, 3));
                    expect(scp.envs.length).toBe(7);
                    verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 2, AInf, 2, 2);
                    expect(scp.hasBallotTimer()).toBe(false);

                    // stuck
                    recvQuorumChecks(makeExternalizeGen(qSetHash, B2, 3), false, false);
                    expect(scp.envs.length).toBe(7);
                    expect(scp.externalizedValues.size).toBe(0);
                    // timer scheduled as there is a quorum with (2, *)
                    expect(scp.hasBallotTimerUpcoming()).toBe(true);
                  });
                  section('Network CONFIRMS other ballot', () => {
                    section('at same counter', () => {
                      // nothing should happen here, in particular, node should
                      // not attempt to switch 'p'
                      recvQuorumChecks(makeConfirmGen(qSetHash, 3, B2, 2, 3), false, false);
                      expect(scp.envs.length).toBe(6);
                      expect(scp.externalizedValues.size).toBe(0);
                      expect(scp.hasBallotTimerUpcoming()).toBe(false);
                    });
                    section('at a different counter', () => {
                      recvVBlocking(makeConfirmGen(qSetHash, 3, B3, 3, 3));
                      expect(scp.envs.length).toBe(7);
                      verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 2, A3, 2, 2);
                      expect(scp.hasBallotTimer()).toBe(false);

                      recvQuorumChecks(makeConfirmGen(qSetHash, 3, B3, 3, 3), false, false);
                      expect(scp.envs.length).toBe(7);
                      expect(scp.externalizedValues.size).toBe(0);
                      // timer scheduled as there is a quorum with (3, *)
                      expect(scp.hasBallotTimerUpcoming()).toBe(true);
                    });
                  });
                });
              });
              section('v-blocking', () => {
                section('CONFIRM', () => {
                  section('CONFIRM A2', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 2, A2, 2, 2));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, 2, A2, 2, 2);
                    expect(scp.hasBallotTimerUpcoming()).toBe(false);
                  });
                  section('CONFIRM A3..4', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 4, A4, 3, 4));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, 4, A4, 3, 4);
                    expect(scp.hasBallotTimer()).toBe(false);
                  });
                  section('CONFIRM B2', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 2, B2, 2, 2));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, 2, B2, 2, 2);
                    expect(scp.hasBallotTimerUpcoming()).toBe(false);
                  });
                });
                section('EXTERNALIZE', () => {
                  section('EXTERNALIZE A2', () => {
                    recvVBlocking(makeExternalizeGen(qSetHash, A2, 2));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, UINT32_MAX, AInf, 2, UINT32_MAX);
                    expect(scp.hasBallotTimer()).toBe(false);
                  });
                  section('EXTERNALIZE B2', () => {
                    recvVBlocking(makeExternalizeGen(qSetHash, B2, 2));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, UINT32_MAX, BInf, 2, UINT32_MAX);
                    expect(scp.hasBallotTimer()).toBe(false);
                  });
                });
              });
            });
            section('get conflicting prepared B', () => {
              section('same counter', () => {
                recvVBlocking(makePrepareGen(qSetHash, B2, B2));
                expect(scp.envs.length).toBe(6);
                verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A2, B2, 0, 2, A2);
                expect(scp.hasBallotTimerUpcoming()).toBe(false);

                recvQuorum(makePrepareGen(qSetHash, B2, B2, 2, 2));
                expect(scp.envs.length).toBe(7);
                verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 2, B2, 2, 2);
                expect(scp.hasBallotTimerUpcoming()).toBe(false);
              });
              section('higher counter', () => {
                recvVBlocking(makePrepareGen(qSetHash, B3, B2, 2, 2));
                expect(scp.envs.length).toBe(6);
                verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A3, B2, 0, 2, A2);
                expect(scp.hasBallotTimer()).toBe(false);

                recvQuorumChecksEx(makePrepareGen(qSetHash, B3, B2, 2, 2), true, true, true);
                expect(scp.envs.length).toBe(7);
                verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 3, B3, 2, 2);
              });
              section('higher counter mixed', () => {
                recvVBlocking(makePrepareGen(qSetHash, A3, B3, 0, 2, A2));
                expect(scp.envs.length).toBe(6);
                // h still A2
                // v-blocking
                //     prepared B3 -> p = B3, p'=A2 (1)
                //     counter 3, b = A3 (9) (same value than h)
                // c = 0 (1)
                verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A3, B3, 0, 2, A2);
                recvQuorumEx(makePrepareGen(qSetHash, A3, B3, 0, 2, A2), true);
                // p=B3, p'=A3 (1)
                // computed_h = B3
                // b = computed_h = B3 (8)
                // h = computed_h = B3 (2)
                // c = h = B3 (3)
                expect(scp.envs.length).toBe(7);
                verifyPrepare(scp.envs[6], v0, qSetHash0, 0, B3, B3, 3, 3, A3);
              });
            });
          });
          section('Confirm prepared mixed', () => {
            // a few nodes prepared B2
            recvVBlocking(makePrepareGen(qSetHash, B2, B2, 0, 0, A2));
            expect(scp.envs.length).toBe(5);
            verifyPrepare(scp.envs[4], v0, qSetHash0, 0, A2, B2, 0, 0, A2);
            expect(scp.hasBallotTimerUpcoming()).toBe(false);

            section('mixed A2', () => {
              // causes h=A2
              // but c = 0, as p >!~ h
              scp.bumpTimerOffset();
              scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, A2, A2));

              expect(scp.envs.length).toBe(6);
              verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A2, B2, 0, 2, A2);
              expect(scp.hasBallotTimerUpcoming()).toBe(false);

              scp.bumpTimerOffset();
              scp.receiveEnvelope(makePrepare(v4, qSetHash, 0, A2, A2));

              expect(scp.envs.length).toBe(6);
              expect(scp.hasBallotTimerUpcoming()).toBe(false);
            });
            section('mixed B2', () => {
              // causes h=B2, c=B2
              scp.bumpTimerOffset();
              scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, B2, B2));

              expect(scp.envs.length).toBe(6);
              verifyPrepare(scp.envs[5], v0, qSetHash0, 0, B2, B2, 2, 2, A2);
              expect(scp.hasBallotTimerUpcoming()).toBe(false);

              scp.bumpTimerOffset();
              scp.receiveEnvelope(makePrepare(v4, qSetHash, 0, B2, B2));

              expect(scp.envs.length).toBe(6);
              expect(scp.hasBallotTimerUpcoming()).toBe(false);
            });
          });
        });
        section('switch prepared B1 from A1', () => {
          // (p,p') = (B1, A1) [ from (A1, null) ]
          recvVBlocking(makePrepareGen(qSetHash, B1, B1));
          expect(scp.envs.length).toBe(3);
          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, A1, B1, 0, 0, A1);
          expect(scp.hasBallotTimerUpcoming()).toBe(false);

          // v-blocking with n=2 -> bump n
          recvVBlocking(makePrepareGen(qSetHash, B2));
          expect(scp.envs.length).toBe(4);
          verifyPrepare(scp.envs[3], v0, qSetHash0, 0, A2, B1, 0, 0, A1);

          // move to (p,p') = (B2, A1) [update p from B1 -> B2]
          recvVBlocking(makePrepareGen(qSetHash, B2, B2));
          expect(scp.envs.length).toBe(5);
          verifyPrepare(scp.envs[4], v0, qSetHash0, 0, A2, B2, 0, 0, A1);
          expect(scp.hasBallotTimer()).toBe(false); // no quorum (other nodes on (A,1))

          section('v-blocking switches to previous value of p', () => {
            // v-blocking with n=3 -> bump n
            recvVBlocking(makePrepareGen(qSetHash, B3));
            expect(scp.envs.length).toBe(6);
            verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A3, B2, 0, 0, A1);
            expect(scp.hasBallotTimer()).toBe(false); // no quorum (other nodes on (A,1))

            // vBlocking set says "B1" is prepared - but we already have p=B2
            recvVBlockingChecks(makePrepareGen(qSetHash, B3, B1), false);
            expect(scp.envs.length).toBe(6);
            expect(scp.hasBallotTimer()).toBe(false);
          });
          section("switch p' to Mid2", () => {
            // (p,p') = (B2, Mid2)
            recvVBlocking(makePrepareGen(qSetHash, B2, B2, 0, 0, Mid2));
            expect(scp.envs.length).toBe(6);
            verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A2, B2, 0, 0, Mid2);
            expect(scp.hasBallotTimer()).toBe(false);
          });
          section('switch again Big2', () => {
            // both p and p' get updated
            // (p,p') = (Big2, B2)
            recvVBlocking(makePrepareGen(qSetHash, B2, Big2, 0, 0, B2));
            expect(scp.envs.length).toBe(6);
            verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A2, Big2, 0, 0, B2);
            expect(scp.hasBallotTimer()).toBe(false);
          });
        });
        section('switch prepare B1', () => {
          recvQuorumChecks(makePrepareGen(qSetHash, B1), true, true);
          expect(scp.envs.length).toBe(3);
          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, A1, B1, 0, 0, A1);
          expect(scp.hasBallotTimerUpcoming()).toBe(false);
        });
        section('prepare higher counter (v-blocking)', () => {
          recvVBlocking(makePrepareGen(qSetHash, B2));
          expect(scp.envs.length).toBe(3);
          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, A2, A1);
          expect(scp.hasBallotTimer()).toBe(false);

          // more timeout from vBlocking set
          recvVBlocking(makePrepareGen(qSetHash, B3));
          expect(scp.envs.length).toBe(4);
          verifyPrepare(scp.envs[3], v0, qSetHash0, 0, A3, A1);
          expect(scp.hasBallotTimer()).toBe(false);
        });
      });
      section('prepared B (v-blocking)', () => {
        recvVBlocking(makePrepareGen(qSetHash, B1, B1));
        expect(scp.envs.length).toBe(2);
        verifyPrepare(scp.envs[1], v0, qSetHash0, 0, A1, B1);
        expect(scp.hasBallotTimer()).toBe(false);
      });
      section('prepare B (quorum)', () => {
        recvQuorumChecksEx(makePrepareGen(qSetHash, B1), true, true, true);
        expect(scp.envs.length).toBe(2);
        verifyPrepare(scp.envs[1], v0, qSetHash0, 0, A1, B1);
      });
      section('confirm (v-blocking)', () => {
        section('via CONFIRM', () => {
          scp.bumpTimerOffset();
          scp.receiveEnvelope(makeConfirm(v1, qSetHash, 0, 3, A3, 3, 3));
          scp.receiveEnvelope(makeConfirm(v2, qSetHash, 0, 4, A4, 2, 4));
          expect(scp.envs.length).toBe(2);
          verifyConfirm(scp.envs[1], v0, qSetHash0, 0, 3, A3, 3, 3);
          expect(scp.hasBallotTimer()).toBe(false);
        });
        section('via EXTERNALIZE', () => {
          scp.receiveEnvelope(makeExternalize(v1, qSetHash, 0, A2, 4));
          scp.receiveEnvelope(makeExternalize(v2, qSetHash, 0, A3, 5));
          expect(scp.envs.length).toBe(2);
          verifyConfirm(scp.envs[1], v0, qSetHash0, 0, UINT32_MAX, AInf, 3, UINT32_MAX);
          expect(scp.hasBallotTimer()).toBe(false);
        });
      });
    });

    // this is the same test suite than "start <1,x>" with the exception that
    // some transitions are not possible as x < z - so instead we verify that
    // nothing happens
    section('start <1,z>', () => {
      // no timer is set
      expect(scp.hasBallotTimer()).toBe(false);

      const aValue = zValue;
      const bValue = xValue;

      const A1 = B(1, aValue);
      const B1 = B(1, bValue);

      const A2 = B(2, aValue);
      const A3 = B(3, aValue);
      const A4 = B(4, aValue);
      const A5 = B(5, aValue);

      const AInf = B(UINT32_MAX, aValue);
      const BInf = B(UINT32_MAX, bValue);

      const B2 = B(2, bValue);
      const B3 = B(3, bValue);
      const B4 = B(4, bValue);

      expect(scp.bumpState(0, aValue)).toBe(true);
      expect(scp.envs.length).toBe(1);
      expect(scp.hasBallotTimer()).toBe(false);

      section('prepared A1', () => {
        recvQuorumEx(makePrepareGen(qSetHash, A1), true);

        expect(scp.envs.length).toBe(2);
        verifyPrepare(scp.envs[1], v0, qSetHash0, 0, A1, A1);

        section('bump prepared A2', () => {
          // bump to (2,a)

          scp.bumpTimerOffset();
          expect(scp.bumpState(0, aValue)).toBe(true);
          expect(scp.envs.length).toBe(3);
          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, A2, A1);
          expect(scp.hasBallotTimer()).toBe(false);

          recvQuorumEx(makePrepareGen(qSetHash, A2), true);
          expect(scp.envs.length).toBe(4);
          verifyPrepare(scp.envs[3], v0, qSetHash0, 0, A2, A2);

          section('Confirm prepared A2', () => {
            recvQuorum(makePrepareGen(qSetHash, A2, A2));
            expect(scp.envs.length).toBe(5);
            verifyPrepare(scp.envs[4], v0, qSetHash0, 0, A2, A2, 2, 2);
            expect(scp.hasBallotTimerUpcoming()).toBe(false);

            section('Accept commit', () => {
              section('Quorum A2', () => {
                recvQuorum(makePrepareGen(qSetHash, A2, A2, 2, 2));
                expect(scp.envs.length).toBe(6);
                verifyConfirm(scp.envs[5], v0, qSetHash0, 0, 2, A2, 2, 2);
                expect(scp.hasBallotTimerUpcoming()).toBe(false);

                section('Quorum prepared A3', () => {
                  recvVBlocking(makePrepareGen(qSetHash, A3, A2, 2, 2));
                  expect(scp.envs.length).toBe(7);
                  verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 2, A3, 2, 2);
                  expect(scp.hasBallotTimer()).toBe(false);

                  recvQuorumEx(makePrepareGen(qSetHash, A3, A2, 2, 2), true);
                  expect(scp.envs.length).toBe(8);
                  verifyConfirm(scp.envs[7], v0, qSetHash0, 0, 3, A3, 2, 2);

                  section('Accept more commit A3', () => {
                    recvQuorum(makePrepareGen(qSetHash, A3, A3, 2, 3));
                    expect(scp.envs.length).toBe(9);
                    verifyConfirm(scp.envs[8], v0, qSetHash0, 0, 3, A3, 2, 3);
                    expect(scp.hasBallotTimerUpcoming()).toBe(false);

                    expect(scp.externalizedValues.size).toBe(0);

                    section('Quorum externalize A3', () => {
                      recvQuorum(makeConfirmGen(qSetHash, 3, A3, 2, 3));
                      expect(scp.envs.length).toBe(10);
                      verifyExternalize(scp.envs[9], v0, qSetHash0, 0, A2, 3);
                      expect(scp.hasBallotTimer()).toBe(false);

                      expect(scp.externalizedValues.size).toBe(1);
                      expect(scp.externalizedValues.get(0)).toBe(aValue);
                    });
                  });
                  section('v-blocking accept more A3', () => {
                    section('Confirm A3', () => {
                      recvVBlocking(makeConfirmGen(qSetHash, 3, A3, 2, 3));
                      expect(scp.envs.length).toBe(9);
                      verifyConfirm(scp.envs[8], v0, qSetHash0, 0, 3, A3, 2, 3);
                      expect(scp.hasBallotTimerUpcoming()).toBe(false);
                    });
                    section('Externalize A3', () => {
                      recvVBlocking(makeExternalizeGen(qSetHash, A2, 3));
                      expect(scp.envs.length).toBe(9);
                      verifyConfirm(scp.envs[8], v0, qSetHash0, 0, UINT32_MAX, AInf, 2, UINT32_MAX);
                      expect(scp.hasBallotTimer()).toBe(false);
                    });
                    section('other nodes moved to c=A4 h=A5', () => {
                      section('Confirm A4..5', () => {
                        recvVBlocking(makeConfirmGen(qSetHash, 3, A5, 4, 5));
                        expect(scp.envs.length).toBe(9);
                        verifyConfirm(scp.envs[8], v0, qSetHash0, 0, 3, A5, 4, 5);
                        expect(scp.hasBallotTimer()).toBe(false);
                      });
                      section('Externalize A4..5', () => {
                        recvVBlocking(makeExternalizeGen(qSetHash, A4, 5));
                        expect(scp.envs.length).toBe(9);
                        verifyConfirm(scp.envs[8], v0, qSetHash0, 0, UINT32_MAX, AInf, 4, UINT32_MAX);
                        expect(scp.hasBallotTimer()).toBe(false);
                      });
                    });
                  });
                });
                section('v-blocking prepared A3', () => {
                  recvVBlocking(makePrepareGen(qSetHash, A3, A3, 2, 2));
                  expect(scp.envs.length).toBe(7);
                  verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 3, A3, 2, 2);
                  expect(scp.hasBallotTimer()).toBe(false);
                });
                section('v-blocking prepared A3+B3', () => {
                  recvVBlocking(makePrepareGen(qSetHash, A3, A3, 2, 2, B3));
                  expect(scp.envs.length).toBe(7);
                  verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 3, A3, 2, 2);
                  expect(scp.hasBallotTimer()).toBe(false);
                });
                section('v-blocking confirm A3', () => {
                  recvVBlocking(makeConfirmGen(qSetHash, 3, A3, 2, 2));
                  expect(scp.envs.length).toBe(7);
                  verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 3, A3, 2, 2);
                  expect(scp.hasBallotTimer()).toBe(false);
                });
                section('Hang - does not switch to B in CONFIRM', () => {
                  section('Network EXTERNALIZE', () => {
                    // externalize messages have a counter at infinite
                    recvVBlocking(makeExternalizeGen(qSetHash, B2, 3));
                    expect(scp.envs.length).toBe(7);
                    verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 2, AInf, 2, 2);
                    expect(scp.hasBallotTimer()).toBe(false);

                    // stuck
                    recvQuorumChecks(makeExternalizeGen(qSetHash, B2, 3), false, false);
                    expect(scp.envs.length).toBe(7);
                    expect(scp.externalizedValues.size).toBe(0);
                    // timer scheduled as there is a quorum with (inf, *)
                    expect(scp.hasBallotTimerUpcoming()).toBe(true);
                  });
                  section('Network CONFIRMS other ballot', () => {
                    section('at same counter', () => {
                      // nothing should happen here, in particular, node should
                      // not attempt to switch 'p'
                      recvQuorumChecks(makeConfirmGen(qSetHash, 3, B2, 2, 3), false, false);
                      expect(scp.envs.length).toBe(6);
                      expect(scp.externalizedValues.size).toBe(0);
                      expect(scp.hasBallotTimerUpcoming()).toBe(false);
                    });
                    section('at a different counter', () => {
                      recvVBlocking(makeConfirmGen(qSetHash, 3, B3, 3, 3));
                      expect(scp.envs.length).toBe(7);
                      verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 2, A3, 2, 2);
                      expect(scp.hasBallotTimer()).toBe(false);

                      recvQuorumChecks(makeConfirmGen(qSetHash, 3, B3, 3, 3), false, false);
                      expect(scp.envs.length).toBe(7);
                      expect(scp.externalizedValues.size).toBe(0);
                      // timer scheduled as there is a quorum with (3, *)
                      expect(scp.hasBallotTimerUpcoming()).toBe(true);
                    });
                  });
                });
              });
              section('v-blocking', () => {
                section('CONFIRM', () => {
                  section('CONFIRM A2', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 2, A2, 2, 2));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, 2, A2, 2, 2);
                    expect(scp.hasBallotTimerUpcoming()).toBe(false);
                  });
                  section('CONFIRM A3..4', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 4, A4, 3, 4));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, 4, A4, 3, 4);
                    expect(scp.hasBallotTimer()).toBe(false);
                  });
                  section('CONFIRM B2', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 2, B2, 2, 2));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, 2, B2, 2, 2);
                    expect(scp.hasBallotTimerUpcoming()).toBe(false);
                  });
                });
                section('EXTERNALIZE', () => {
                  section('EXTERNALIZE A2', () => {
                    recvVBlocking(makeExternalizeGen(qSetHash, A2, 2));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, UINT32_MAX, AInf, 2, UINT32_MAX);
                    expect(scp.hasBallotTimer()).toBe(false);
                  });
                  section('EXTERNALIZE B2', () => {
                    // can switch to B2 with externalize (higher counter)
                    recvVBlocking(makeExternalizeGen(qSetHash, B2, 2));
                    expect(scp.envs.length).toBe(6);
                    verifyConfirm(scp.envs[5], v0, qSetHash0, 0, UINT32_MAX, BInf, 2, UINT32_MAX);
                    expect(scp.hasBallotTimer()).toBe(false);
                  });
                });
              });
            });
            section('get conflicting prepared B', () => {
              section('same counter', () => {
                // messages are ignored as B2 < A2
                recvQuorumChecks(makePrepareGen(qSetHash, B2, B2), false, false);
                expect(scp.envs.length).toBe(5);
                expect(scp.hasBallotTimerUpcoming()).toBe(false);
              });
              section('higher counter', () => {
                recvVBlocking(makePrepareGen(qSetHash, B3, B2, 2, 2));
                expect(scp.envs.length).toBe(6);
                // A2 > B2 -> p = A2, p'=B2
                verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A3, A2, 2, 2, B2);
                expect(scp.hasBallotTimer()).toBe(false);

                // node is trying to commit A2=<2,y> but rest
                // of its quorum is trying to commit B2
                // we end up with a delayed quorum
                recvQuorumChecksEx(makePrepareGen(qSetHash, B3, B2, 2, 2), true, true, true);
                expect(scp.envs.length).toBe(7);
                verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 3, B3, 2, 2);
              });
              section('higher counter mixed', () => {
                recvVBlocking(makePrepareGen(qSetHash, A3, B3, 0, 2, A2));
                expect(scp.envs.length).toBe(6);
                // h still A2
                // v-blocking
                //     prepared B3 -> p = B3, p'=A2 (1)
                //     counter 3, b = A3 (9) (same value than h)
                // c = 0 (1)
                verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A3, B3, 0, 2, A2);
                recvQuorumEx(makePrepareGen(qSetHash, A3, B3, 0, 2, A2), true);
                // p=A3, p'=B3 (1)
                // computed_h = B3 (2) z = B - cannot update b
                expect(scp.envs.length).toBe(7);
                verifyPrepare(scp.envs[6], v0, qSetHash0, 0, A3, A3, 0, 2, B3);
                // timeout, bump to B4
                expect(scp.hasBallotTimerUpcoming()).toBe(true);
                const cb = scp.getBallotProtocolTimer().callback!;
                cb();
                // computed_h = B3
                // h = B3 (2)
                // c = 0
                expect(scp.envs.length).toBe(8);
                verifyPrepare(scp.envs[7], v0, qSetHash0, 0, B4, A3, 0, 3, B3);
              });
            });
          });
          section('Confirm prepared mixed', () => {
            // a few nodes prepared B2
            recvVBlocking(makePrepareGen(qSetHash, A2, A2, 0, 0, B2));
            expect(scp.envs.length).toBe(5);
            verifyPrepare(scp.envs[4], v0, qSetHash0, 0, A2, A2, 0, 0, B2);
            expect(scp.hasBallotTimerUpcoming()).toBe(false);

            section('mixed A2', () => {
              // causes h=A2, c=A2
              scp.bumpTimerOffset();
              scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, A2, A2));

              expect(scp.envs.length).toBe(6);
              verifyPrepare(scp.envs[5], v0, qSetHash0, 0, A2, A2, 2, 2, B2);
              expect(scp.hasBallotTimerUpcoming()).toBe(false);

              scp.bumpTimerOffset();
              scp.receiveEnvelope(makePrepare(v4, qSetHash, 0, A2, A2));

              expect(scp.envs.length).toBe(6);
              expect(scp.hasBallotTimerUpcoming()).toBe(false);
            });
            section('mixed B2', () => {
              // causes computed_h=B2 ~ not set as h ~!= b
              // -> noop
              scp.bumpTimerOffset();
              scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, A2, B2));

              expect(scp.envs.length).toBe(5);
              expect(scp.hasBallotTimerUpcoming()).toBe(false);

              scp.bumpTimerOffset();
              scp.receiveEnvelope(makePrepare(v4, qSetHash, 0, B2, B2));

              expect(scp.envs.length).toBe(5);
              expect(scp.hasBallotTimerUpcoming()).toBe(false);
            });
          });
        });
        section('switch prepared B1 from A1', () => {
          // can't switch to B1
          recvQuorumChecks(makePrepareGen(qSetHash, B1, B1), false, false);
          expect(scp.envs.length).toBe(2);
          expect(scp.hasBallotTimerUpcoming()).toBe(false);
        });
        section('switch prepare B1', () => {
          // doesn't switch as B1 < A1
          recvQuorumChecks(makePrepareGen(qSetHash, B1), false, false);
          expect(scp.envs.length).toBe(2);
          expect(scp.hasBallotTimerUpcoming()).toBe(false);
        });
        section('prepare higher counter (v-blocking)', () => {
          recvVBlocking(makePrepareGen(qSetHash, B2));
          expect(scp.envs.length).toBe(3);
          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, A2, A1);
          expect(scp.hasBallotTimer()).toBe(false);

          // more timeout from vBlocking set
          recvVBlocking(makePrepareGen(qSetHash, B3));
          expect(scp.envs.length).toBe(4);
          verifyPrepare(scp.envs[3], v0, qSetHash0, 0, A3, A1);
          expect(scp.hasBallotTimer()).toBe(false);
        });
      });
      section('prepared B (v-blocking)', () => {
        recvVBlocking(makePrepareGen(qSetHash, B1, B1));
        expect(scp.envs.length).toBe(2);
        verifyPrepare(scp.envs[1], v0, qSetHash0, 0, A1, B1);
        expect(scp.hasBallotTimer()).toBe(false);
      });
      section('prepare B (quorum)', () => {
        recvQuorumChecksEx(makePrepareGen(qSetHash, B1), true, true, true);
        expect(scp.envs.length).toBe(2);
        verifyPrepare(scp.envs[1], v0, qSetHash0, 0, A1, B1);
      });
      section('confirm (v-blocking)', () => {
        section('via CONFIRM', () => {
          scp.bumpTimerOffset();
          scp.receiveEnvelope(makeConfirm(v1, qSetHash, 0, 3, A3, 3, 3));
          scp.receiveEnvelope(makeConfirm(v2, qSetHash, 0, 4, A4, 2, 4));
          expect(scp.envs.length).toBe(2);
          verifyConfirm(scp.envs[1], v0, qSetHash0, 0, 3, A3, 3, 3);
          expect(scp.hasBallotTimer()).toBe(false);
        });
        section('via EXTERNALIZE', () => {
          scp.receiveEnvelope(makeExternalize(v1, qSetHash, 0, A2, 4));
          scp.receiveEnvelope(makeExternalize(v2, qSetHash, 0, A3, 5));
          expect(scp.envs.length).toBe(2);
          verifyConfirm(scp.envs[1], v0, qSetHash0, 0, UINT32_MAX, AInf, 3, UINT32_MAX);
          expect(scp.hasBallotTimer()).toBe(false);
        });
      });
    });

    // this is the same test suite than "start <1,x>" but only keeping
    // the transitions that are observable when starting from empty
    section('start from pristine', () => {
      const aValue = xValue;
      const bValue = zValue;

      const A1 = B(1, aValue);
      const B1 = B(1, bValue);

      const A2 = B(2, aValue);
      const A3 = B(3, aValue);
      const A4 = B(4, aValue);

      const AInf = B(UINT32_MAX, aValue);
      const BInf = B(UINT32_MAX, bValue);

      const B2 = B(2, bValue);

      expect(scp.envs.length).toBe(0);

      section('prepared A1', () => {
        recvQuorumChecks(makePrepareGen(qSetHash, A1), false, false);
        expect(scp.envs.length).toBe(0);

        section('bump prepared A2', () => {
          section('Confirm prepared A2', () => {
            recvVBlockingChecks(makePrepareGen(qSetHash, A2, A2), false);
            expect(scp.envs.length).toBe(0);

            section('Quorum A2', () => {
              recvVBlockingChecks(makePrepareGen(qSetHash, A2, A2), false);
              expect(scp.envs.length).toBe(0);
              recvQuorum(makePrepareGen(qSetHash, A2, A2));
              expect(scp.envs.length).toBe(1);
              verifyPrepare(scp.envs[0], v0, qSetHash0, 0, A2, A2, 1, 2);
            });
            section('Quorum B2', () => {
              recvVBlockingChecks(makePrepareGen(qSetHash, B2, B2), false);
              expect(scp.envs.length).toBe(0);
              recvQuorum(makePrepareGen(qSetHash, B2, B2));
              expect(scp.envs.length).toBe(1);
              verifyPrepare(scp.envs[0], v0, qSetHash0, 0, B2, B2, 2, 2, A2);
            });
            section('Accept commit', () => {
              section('Quorum A2', () => {
                recvQuorum(makePrepareGen(qSetHash, A2, A2, 2, 2));
                expect(scp.envs.length).toBe(1);
                verifyConfirm(scp.envs[0], v0, qSetHash0, 0, 2, A2, 2, 2);
              });
              section('Quorum B2', () => {
                recvQuorum(makePrepareGen(qSetHash, B2, B2, 2, 2));
                expect(scp.envs.length).toBe(1);
                verifyConfirm(scp.envs[0], v0, qSetHash0, 0, 2, B2, 2, 2);
              });
              section('v-blocking', () => {
                section('CONFIRM', () => {
                  section('CONFIRM A2', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 2, A2, 2, 2));
                    expect(scp.envs.length).toBe(1);
                    verifyConfirm(scp.envs[0], v0, qSetHash0, 0, 2, A2, 2, 2);
                  });
                  section('CONFIRM A3..4', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 4, A4, 3, 4));
                    expect(scp.envs.length).toBe(1);
                    verifyConfirm(scp.envs[0], v0, qSetHash0, 0, 4, A4, 3, 4);
                  });
                  section('CONFIRM B2', () => {
                    recvVBlocking(makeConfirmGen(qSetHash, 2, B2, 2, 2));
                    expect(scp.envs.length).toBe(1);
                    verifyConfirm(scp.envs[0], v0, qSetHash0, 0, 2, B2, 2, 2);
                  });
                });
                section('EXTERNALIZE', () => {
                  section('EXTERNALIZE A2', () => {
                    recvVBlocking(makeExternalizeGen(qSetHash, A2, 2));
                    expect(scp.envs.length).toBe(1);
                    verifyConfirm(scp.envs[0], v0, qSetHash0, 0, UINT32_MAX, AInf, 2, UINT32_MAX);
                  });
                  section('EXTERNALIZE B2', () => {
                    recvVBlocking(makeExternalizeGen(qSetHash, B2, 2));
                    expect(scp.envs.length).toBe(1);
                    verifyConfirm(scp.envs[0], v0, qSetHash0, 0, UINT32_MAX, BInf, 2, UINT32_MAX);
                  });
                });
              });
            });
          });
          section('Confirm prepared mixed', () => {
            // a few nodes prepared A2
            // causes p=A2
            recvVBlockingChecks(makePrepareGen(qSetHash, A2, A2), false);
            expect(scp.envs.length).toBe(0);

            // a few nodes prepared B2
            // causes p=B2, p'=A2
            recvVBlockingChecks(makePrepareGen(qSetHash, A2, B2, 0, 0, A2), false);
            expect(scp.envs.length).toBe(0);

            section('mixed A2', () => {
              // causes h=A2
              // but c = 0, as p >!~ h
              scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, A2, A2));

              expect(scp.envs.length).toBe(1);
              verifyPrepare(scp.envs[0], v0, qSetHash0, 0, A2, B2, 0, 2, A2);

              scp.receiveEnvelope(makePrepare(v4, qSetHash, 0, A2, A2));

              expect(scp.envs.length).toBe(1);
            });
            section('mixed B2', () => {
              // causes h=B2, c=B2
              scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, B2, B2));

              expect(scp.envs.length).toBe(1);
              verifyPrepare(scp.envs[0], v0, qSetHash0, 0, B2, B2, 2, 2, A2);

              scp.receiveEnvelope(makePrepare(v4, qSetHash, 0, B2, B2));

              expect(scp.envs.length).toBe(1);
            });
          });
        });
        section('switch prepared B1', () => {
          recvVBlockingChecks(makePrepareGen(qSetHash, B1, B1), false);
          expect(scp.envs.length).toBe(0);
        });
      });
      section('prepared B (v-blocking)', () => {
        recvVBlockingChecks(makePrepareGen(qSetHash, B1, B1), false);
        expect(scp.envs.length).toBe(0);
      });
      section('confirm (v-blocking)', () => {
        section('via CONFIRM', () => {
          scp.receiveEnvelope(makeConfirm(v1, qSetHash, 0, 3, A3, 3, 3));
          scp.receiveEnvelope(makeConfirm(v2, qSetHash, 0, 4, A4, 2, 4));
          expect(scp.envs.length).toBe(1);
          verifyConfirm(scp.envs[0], v0, qSetHash0, 0, 3, A3, 3, 3);
        });
        section('via EXTERNALIZE', () => {
          scp.receiveEnvelope(makeExternalize(v1, qSetHash, 0, A2, 4));
          scp.receiveEnvelope(makeExternalize(v2, qSetHash, 0, A3, 5));
          expect(scp.envs.length).toBe(1);
          verifyConfirm(scp.envs[0], v0, qSetHash0, 0, UINT32_MAX, AInf, 3, UINT32_MAX);
        });
      });
    });

    section('normal round (1,x)', () => {
      nodesAllPledgeToCommit();
      expect(scp.envs.length).toBe(3);

      const b = B(1, xValue);

      // bunch of prepare messages with "commit b"
      const preparedC1 = makePrepare(v1, qSetHash, 0, b, b, b.counter, b.counter);
      const preparedC2 = makePrepare(v2, qSetHash, 0, b, b, b.counter, b.counter);
      const preparedC3 = makePrepare(v3, qSetHash, 0, b, b, b.counter, b.counter);
      const preparedC4 = makePrepare(v4, qSetHash, 0, b, b, b.counter, b.counter);
      void preparedC4;

      // those should not trigger anything just yet
      scp.receiveEnvelope(preparedC1);
      scp.receiveEnvelope(preparedC2);
      expect(scp.envs.length).toBe(3);

      // this should cause the node to accept 'commit b' (quorum)
      // and therefore send a "CONFIRM" message
      scp.receiveEnvelope(preparedC3);
      expect(scp.envs.length).toBe(4);

      verifyConfirm(scp.envs[3], v0, qSetHash0, 0, 1, b, b.counter, b.counter);

      // bunch of confirm messages
      const confirm1 = makeConfirm(v1, qSetHash, 0, b.counter, b, b.counter, b.counter);
      const confirm2 = makeConfirm(v2, qSetHash, 0, b.counter, b, b.counter, b.counter);
      const confirm3 = makeConfirm(v3, qSetHash, 0, b.counter, b, b.counter, b.counter);
      const confirm4 = makeConfirm(v4, qSetHash, 0, b.counter, b, b.counter, b.counter);

      // those should not trigger anything just yet
      scp.receiveEnvelope(confirm1);
      scp.receiveEnvelope(confirm2);
      expect(scp.envs.length).toBe(4);

      scp.receiveEnvelope(confirm3);
      // this causes our node to
      // externalize (confirm commit c)
      expect(scp.envs.length).toBe(5);

      // The slot should have externalized the value
      expect(scp.externalizedValues.size).toBe(1);
      expect(scp.externalizedValues.get(0)).toBe(xValue);

      verifyExternalize(scp.envs[4], v0, qSetHash0, 0, b, b.counter);

      // extra vote should not do anything
      scp.receiveEnvelope(confirm4);
      expect(scp.envs.length).toBe(5);
      expect(scp.externalizedValues.size).toBe(1);

      // duplicate should just no-op
      scp.receiveEnvelope(confirm2);
      expect(scp.envs.length).toBe(5);
      expect(scp.externalizedValues.size).toBe(1);

      section('bumpToBallot prevented once committed', () => {
        let b2: Ballot = B(0, '');
        section('bumpToBallot prevented once committed (by value)', () => {
          b2 = B(1, zValue);
        });
        section('bumpToBallot prevented once committed (by counter)', () => {
          b2 = B(2, xValue);
        });
        section('bumpToBallot prevented once committed (by value and counter)', () => {
          b2 = B(2, zValue);
        });

        const confirm1b2 = makeConfirm(v1, qSetHash, 0, b2.counter, b2, b2.counter, b2.counter);
        const confirm2b2 = makeConfirm(v2, qSetHash, 0, b2.counter, b2, b2.counter, b2.counter);
        const confirm3b2 = makeConfirm(v3, qSetHash, 0, b2.counter, b2, b2.counter, b2.counter);
        const confirm4b2 = makeConfirm(v4, qSetHash, 0, b2.counter, b2, b2.counter, b2.counter);

        scp.receiveEnvelope(confirm1b2);
        scp.receiveEnvelope(confirm2b2);
        scp.receiveEnvelope(confirm3b2);
        scp.receiveEnvelope(confirm4b2);
        expect(scp.envs.length).toBe(5);
        expect(scp.externalizedValues.size).toBe(1);
      });
    });

    section('range check', () => {
      nodesAllPledgeToCommit();
      expect(scp.envs.length).toBe(3);

      const b = B(1, xValue);

      // bunch of prepare messages with "commit b"
      const preparedC1 = makePrepare(v1, qSetHash, 0, b, b, b.counter, b.counter);
      const preparedC2 = makePrepare(v2, qSetHash, 0, b, b, b.counter, b.counter);
      const preparedC3 = makePrepare(v3, qSetHash, 0, b, b, b.counter, b.counter);

      // those should not trigger anything just yet
      scp.receiveEnvelope(preparedC1);
      scp.receiveEnvelope(preparedC2);
      expect(scp.envs.length).toBe(3);

      // this should cause the node to accept 'commit b' (quorum)
      // and therefore send a "CONFIRM" message
      scp.receiveEnvelope(preparedC3);
      expect(scp.envs.length).toBe(4);

      verifyConfirm(scp.envs[3], v0, qSetHash0, 0, 1, b, b.counter, b.counter);

      // bunch of confirm messages with different ranges
      const confirm1 = makeConfirm(v1, qSetHash, 0, 4, B(4, xValue), 2, 4);
      const confirm2 = makeConfirm(v2, qSetHash, 0, 6, B(6, xValue), 2, 6);
      const confirm3 = makeConfirm(v3, qSetHash, 0, 5, B(5, xValue), 3, 5);
      const confirm4 = makeConfirm(v4, qSetHash, 0, 6, B(6, xValue), 3, 6);
      void confirm3;

      // this should not trigger anything just yet
      scp.receiveEnvelope(confirm1);

      // v-blocking
      //   * b gets bumped to (4,x)
      //   * p gets bumped to (4,x)
      //   * (c,h) gets bumped to (2,4)
      scp.receiveEnvelope(confirm2);
      expect(scp.envs.length).toBe(5);
      verifyConfirm(scp.envs[4], v0, qSetHash0, 0, 4, B(4, xValue), 2, 4);

      // this causes to externalize
      // range is [3,4]
      scp.receiveEnvelope(confirm4);
      expect(scp.envs.length).toBe(6);

      // The slot should have externalized the value
      expect(scp.externalizedValues.size).toBe(1);
      expect(scp.externalizedValues.get(0)).toBe(xValue);

      verifyExternalize(scp.envs[5], v0, qSetHash0, 0, B(3, xValue), 4);
    });

    section('timeout when h is set -> stay locked on h', () => {
      const bx = B(1, xValue);
      expect(scp.bumpState(0, xValue)).toBe(true);
      expect(scp.envs.length).toBe(1);

      // v-blocking -> prepared
      // quorum -> confirm prepared
      recvQuorum(makePrepareGen(qSetHash, bx, bx));
      expect(scp.envs.length).toBe(3);
      verifyPrepare(scp.envs[2], v0, qSetHash0, 0, bx, bx, bx.counter, bx.counter);

      // now, see if we can timeout and move to a different value
      expect(scp.bumpState(0, yValue)).toBe(true);
      expect(scp.envs.length).toBe(4);
      const newbx = B(2, xValue);
      verifyPrepare(scp.envs[3], v0, qSetHash0, 0, newbx, bx, bx.counter, bx.counter);
    });
    section("timeout when h exists but can't be set -> vote for h", () => {
      // start with (1,y)
      const by = B(1, yValue);
      expect(scp.bumpState(0, yValue)).toBe(true);
      expect(scp.envs.length).toBe(1);

      const bx = B(1, xValue);
      // but quorum goes with (1,x)
      // v-blocking -> prepared
      recvVBlocking(makePrepareGen(qSetHash, bx, bx));
      expect(scp.envs.length).toBe(2);
      verifyPrepare(scp.envs[1], v0, qSetHash0, 0, by, bx);
      // quorum -> confirm prepared (no-op as b > h)
      recvQuorumChecks(makePrepareGen(qSetHash, bx, bx), false, false);
      expect(scp.envs.length).toBe(2);

      expect(scp.bumpState(0, yValue)).toBe(true);
      expect(scp.envs.length).toBe(3);
      const newbx = B(2, xValue);
      // on timeout:
      // * we should move to the quorum's h value
      // * c can't be set yet as b > h
      verifyPrepare(scp.envs[2], v0, qSetHash0, 0, newbx, bx, 0, bx.counter);
    });

    section('timeout from multiple nodes', () => {
      expect(scp.bumpState(0, xValue)).toBe(true);

      const x1 = B(1, xValue);

      expect(scp.envs.length).toBe(1);
      verifyPrepare(scp.envs[0], v0, qSetHash0, 0, x1);

      recvQuorum(makePrepareGen(qSetHash, x1));
      // quorum -> prepared (1,x)
      expect(scp.envs.length).toBe(2);
      verifyPrepare(scp.envs[1], v0, qSetHash0, 0, x1, x1);

      const x2 = B(2, xValue);
      // timeout from local node
      expect(scp.bumpState(0, xValue)).toBe(true);
      // prepares (2,x)
      expect(scp.envs.length).toBe(3);
      verifyPrepare(scp.envs[2], v0, qSetHash0, 0, x2, x1);

      recvQuorum(makePrepareGen(qSetHash, x1, x1));
      // quorum -> set nH=1
      expect(scp.envs.length).toBe(4);
      verifyPrepare(scp.envs[3], v0, qSetHash0, 0, x2, x1, 0, 1);
      expect(scp.envs.length).toBe(4);

      recvVBlocking(makePrepareGen(qSetHash, x2, x2, 1, 1));
      // v-blocking prepared (2,x) -> prepared (2,x)
      expect(scp.envs.length).toBe(5);
      verifyPrepare(scp.envs[4], v0, qSetHash0, 0, x2, x2, 0, 1);

      recvQuorum(makePrepareGen(qSetHash, x2, x2, 1, 1));
      // quorum (including us) confirms (2,x) prepared -> set h=c=x2
      // we also get extra message: a quorum not including us confirms
      // (1,x) prepared
      //  -> we confirm c=h=x1
      expect(scp.envs.length).toBe(7);
      verifyPrepare(scp.envs[5], v0, qSetHash0, 0, x2, x2, 2, 2);
      verifyConfirm(scp.envs[6], v0, qSetHash0, 0, 2, x2, 1, 1);
    });

    section('timeout after prepare, receive old messages to prepare', () => {
      expect(scp.bumpState(0, xValue)).toBe(true);

      const x1 = B(1, xValue);

      expect(scp.envs.length).toBe(1);
      verifyPrepare(scp.envs[0], v0, qSetHash0, 0, x1);

      scp.receiveEnvelope(makePrepare(v1, qSetHash, 0, x1));
      scp.receiveEnvelope(makePrepare(v2, qSetHash, 0, x1));
      scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, x1));

      // quorum -> prepared (1,x)
      expect(scp.envs.length).toBe(2);
      verifyPrepare(scp.envs[1], v0, qSetHash0, 0, x1, x1);

      const x2 = B(2, xValue);
      // timeout from local node
      expect(scp.bumpState(0, xValue)).toBe(true);
      // prepares (2,x)
      expect(scp.envs.length).toBe(3);
      verifyPrepare(scp.envs[2], v0, qSetHash0, 0, x2, x1);

      const x3 = B(3, xValue);
      // timeout again
      expect(scp.bumpState(0, xValue)).toBe(true);
      // prepares (3,x)
      expect(scp.envs.length).toBe(4);
      verifyPrepare(scp.envs[3], v0, qSetHash0, 0, x3, x1);

      // other nodes moved on with x2
      scp.receiveEnvelope(makePrepare(v1, qSetHash, 0, x2, x2, 1, 2));
      scp.receiveEnvelope(makePrepare(v2, qSetHash, 0, x2, x2, 1, 2));
      // v-blocking -> prepared x2
      expect(scp.envs.length).toBe(5);
      verifyPrepare(scp.envs[4], v0, qSetHash0, 0, x3, x2);

      scp.receiveEnvelope(makePrepare(v3, qSetHash, 0, x2, x2, 1, 2));
      // quorum -> set nH=2
      expect(scp.envs.length).toBe(6);
      verifyPrepare(scp.envs[5], v0, qSetHash0, 0, x3, x2, 0, 2);
    });

    section('non validator watching the network', () => {
      const vNV = nodeId('NV');
      const scpNV = new TestSCP(vNV, qSet, false);
      scpNV.storeQuorumSet(qSet);
      const qSetHashNV = scpNV.scp.getLocalQuorumSetHash();

      const b = B(1, xValue);
      expect(scpNV.bumpState(0, xValue)).toBe(true);
      expect(scpNV.envs.length).toBe(0);
      verifyPrepare(scpNV.getCurrentEnvelope(0, vNV), vNV, qSetHashNV, 0, b);
      const ext1 = makeExternalize(v1, qSetHash, 0, b, 1);
      const ext2 = makeExternalize(v2, qSetHash, 0, b, 1);
      const ext3 = makeExternalize(v3, qSetHash, 0, b, 1);
      const ext4 = makeExternalize(v4, qSetHash, 0, b, 1);
      scpNV.receiveEnvelope(ext1);
      scpNV.receiveEnvelope(ext2);
      scpNV.receiveEnvelope(ext3);
      expect(scpNV.envs.length).toBe(0);
      verifyConfirm(scpNV.getCurrentEnvelope(0, vNV), vNV, qSetHashNV, 0, UINT32_MAX, B(UINT32_MAX, xValue), 1, UINT32_MAX);
      scpNV.receiveEnvelope(ext4);
      expect(scpNV.envs.length).toBe(0);
      verifyExternalize(scpNV.getCurrentEnvelope(0, vNV), vNV, qSetHashNV, 0, b, UINT32_MAX);
      expect(scpNV.externalizedValues.get(0)).toBe(xValue);
    });

    section('restore ballot protocol', () => {
      const scp2 = new TestSCP(v0, qSet);
      scp2.storeQuorumSet(qSet);
      const b = B(2, xValue);
      section('prepare', () => {
        expect(scp2.scp.setStateFromEnvelope(0, makePrepare(v0, qSetHash0, 0, b))).toBe(true);
      });
      section('confirm', () => {
        expect(scp2.scp.setStateFromEnvelope(0, makeConfirm(v0, qSetHash0, 0, 2, b, 1, 2))).toBe(true);
      });
      section('externalize', () => {
        expect(scp2.scp.setStateFromEnvelope(0, makeExternalize(v0, qSetHash0, 0, b, 2))).toBe(true);
      });
    });
  });
};

// ---------------------------------------------------------------------------

const core3: SectionBody = (section) => {
  // core3 has an edge case where v-blocking and quorum can be the same
  // v-blocking set size: 2
  // threshold: 2 = 1 + self or 2 others
  const qSet: QuorumSet = { threshold: 2, validators: [v0, v1, v2], innerSets: [] };
  const qSetHash = hashQuorumSet(qSet);

  const scp = new TestSCP(v0, qSet);

  testTimeouts(section, scp, () => {
    scp.storeQuorumSet(qSet);
    const qSetHash0 = scp.scp.getLocalQuorumSetHash();

    expect(xValue < yValue).toBe(true);
    expect(yValue < zValue).toBe(true);

    const recvQuorumChecksEx2 = (
      gen: GenEnvelope,
      withChecks: boolean,
      delayedQuorum: boolean,
      checkUpcoming: boolean,
      minQuorum: boolean,
    ) => {
      const e1 = gen(v1);
      const e2 = gen(v2);

      scp.bumpTimerOffset();

      const i = scp.envs.length + 1;
      scp.receiveEnvelope(e1);
      if (withChecks && !delayedQuorum) expect(scp.envs.length).toBe(i);
      if (checkUpcoming) expect(scp.hasBallotTimerUpcoming()).toBe(true);
      if (!minQuorum) {
        // nothing happens with an extra vote (unless we're in delayedQuorum)
        scp.receiveEnvelope(e2);
        if (withChecks) expect(scp.envs.length).toBe(i);
      }
    };
    const recvQuorumChecksEx = (gen: GenEnvelope, withChecks: boolean, delayedQuorum: boolean, checkUpcoming: boolean) =>
      recvQuorumChecksEx2(gen, withChecks, delayedQuorum, checkUpcoming, false);
    const recvQuorumChecks = (gen: GenEnvelope, withChecks: boolean, delayedQuorum: boolean) =>
      recvQuorumChecksEx(gen, withChecks, delayedQuorum, false);

    // no timer is set
    expect(scp.hasBallotTimer()).toBe(false);

    const aValue = zValue;
    const bValue = xValue;

    const A1 = B(1, aValue);
    const B1 = B(1, bValue);

    const A2 = B(2, aValue);

    const B2 = B(2, bValue);

    section('prepared B1 (quorum votes B1) local aValue', () => {
      expect(scp.bumpState(0, aValue)).toBe(true);
      expect(scp.envs.length).toBe(1);
      expect(scp.hasBallotTimer()).toBe(false);

      scp.bumpTimerOffset();
      recvQuorumChecks(makePrepareGen(qSetHash, B1), true, true);
      expect(scp.envs.length).toBe(2);
      verifyPrepare(scp.envs[1], v0, qSetHash0, 0, A1, B1);
      expect(scp.hasBallotTimerUpcoming()).toBe(true);
      section('quorum prepared B1', () => {
        scp.bumpTimerOffset();
        recvQuorumChecks(makePrepareGen(qSetHash, B1, B1), false, false);
        expect(scp.envs.length).toBe(2);
        // nothing happens:
        // computed_h = B1 (2)
        //    does not actually update h as b > computed_h
        //    also skips (3)
        expect(scp.hasBallotTimerUpcoming()).toBe(false);
        section('quorum bumps to A1', () => {
          scp.bumpTimerOffset();
          recvQuorumChecksEx2(makePrepareGen(qSetHash, A1, B1), false, false, false, true);

          expect(scp.envs.length).toBe(3);
          // still does not set h as b > computed_h
          verifyPrepare(scp.envs[2], v0, qSetHash0, 0, A1, A1, 0, 0, B1);
          expect(scp.hasBallotTimerUpcoming()).toBe(false);

          scp.bumpTimerOffset();
          // quorum commits A1
          recvQuorumChecksEx2(makePrepareGen(qSetHash, A2, A1, 1, 1, B1), false, false, false, true);
          expect(scp.envs.length).toBe(4);
          verifyConfirm(scp.envs[3], v0, qSetHash0, 0, 2, A1, 1, 1);
          expect(scp.hasBallotTimerUpcoming()).toBe(false);
        });
      });
    });
    section('prepared A1 with timeout', () => {
      // starts with bValue (smallest)
      expect(scp.bumpState(0, bValue)).toBe(true);
      expect(scp.envs.length).toBe(1);

      // setup
      recvQuorumChecks(makePrepareGen(qSetHash, A1, A1, 0, 1), false, false);
      expect(scp.envs.length).toBe(2);
      verifyPrepare(scp.envs[1], v0, qSetHash0, 0, A1, A1, 1, 1);

      // now, receive bumped votes
      recvQuorumChecks(makePrepareGen(qSetHash, A2, B2, 0, 1, A1), true, true);
      expect(scp.envs.length).toBe(3);
      // p=B2, p'=A1 (1)
      // computed_h = B2 (2)
      //   does not update h as b < computed_h
      // v-blocking ahead -> b = computed_h = B2 (9)
      // h = B2 (2) (now possible)
      // c = 0 (1)
      verifyPrepare(scp.envs[2], v0, qSetHash0, 0, B2, A2, 0, 2, B2);
    });
    section('node without self - quorum timeout', () => {
      const vNodeNS = nodeId('NodeNS');
      const scpNNS = new TestSCP(vNodeNS, qSet);
      scpNNS.storeQuorumSet(qSet);
      const qSetHashNodeNS = scpNNS.scp.getLocalQuorumSetHash();

      scpNNS.receiveEnvelope(makePrepare(v1, qSetHash, 0, A2, B2, 0, 1, A1));
      scpNNS.receiveEnvelope(makePrepare(v2, qSetHash, 0, A1, A1, 1, 1));

      expect(scpNNS.envs.length).toBe(1);
      verifyPrepare(scpNNS.envs[0], vNodeNS, qSetHashNodeNS, 0, A1, A1, 1, 1);

      scpNNS.receiveEnvelope(makePrepare(v0, qSetHash, 0, A2, B2, 0, 1, A1));

      expect(scpNNS.envs.length).toBe(2);
      verifyPrepare(scpNNS.envs[1], vNodeNS, qSetHashNodeNS, 0, B2, A2, 0, 2, B2);
    });
  });
};

const core5Count = registerSectionTests('ballot protocol core5', core5);
const core3Count = registerSectionTests('ballot protocol core3', core3);

describe('ported case counts', () => {
  it('covers the whole core5 and core3 section trees', () => {
    // 3 timeout settings x leaf sections
    expect(core5Count).toBeGreaterThanOrEqual(3 * 60);
    expect(core3Count).toBe(3 * 3);
  });
});
