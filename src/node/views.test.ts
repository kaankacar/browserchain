import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { TestLedger } from '../ledger/testkit';
import { encodeStellarValue, makeSignedStellarValue } from '../ledger/value';
import { MemoryNetwork } from '../overlay/memoryNetwork';
import type { WireMessage } from '../overlay/types';
import type { SlotInfo, Statement } from '../scp/types';
import { toStoredLedger, toStoredTxs } from '../history/chainStore';
import { valueId } from '../herder/values';
import { createsAccount, buildFriendbotTx, friendbotChannel } from './friendbot';
import { ScopedClock } from './scopedClock';
import { TapTransport } from './tapTransport';
import {
  ledgerSummaryFromHeader,
  ledgerSummaryOf,
  qsetFromView,
  qsetViewOf,
  scpEventViewOf,
  scpSlotViewOf,
  statementSummary,
  txSummaryOf,
  valueViewOf,
} from './views';

describe('views', () => {
  it('summarizes ledgers and transactions', () => {
    const tl = new TestLedger();
    const user = Keypair.random();
    const r = tl.fund([user]);
    const stored = toStoredLedger(r, 3, 42);
    const s = ledgerSummaryOf(stored);
    expect(s).toMatchObject({
      seq: 2,
      hash: r.hash,
      prevHash: r.header.previousLedgerHash,
      txCount: 1,
      opCount: 1,
      baseFee: 100,
      totalCoins: '100000000000.0000000',
      txSetHash: r.txSet.hash,
      stateHash: r.header.bucketListHash,
      proposer: tl.node.publicKey(),
      closedAt: 42,
      externalizedBy: 3,
    });
    expect(ledgerSummaryFromHeader(r.header, r.hash)).toMatchObject({ seq: 2, txCount: 0, externalizedBy: 0 });
    const tx = txSummaryOf(toStoredTxs(r)[0]);
    expect(tx).toMatchObject({ ledgerSeq: 2, applyIndex: 0, successful: true, resultCode: 'txSUCCESS', feeCharged: '0.0000100', opCount: 1 });
    expect(tx.operations[0].type).toBe('createAccount');
    expect(txSummaryOf({ ...toStoredTxs(r)[0], summaryJson: 'nope' }).operations).toEqual([]);
  });

  it('describes values, statements and SCP slots', () => {
    const tl = new TestLedger();
    const kp = Keypair.random();
    const v = encodeStellarValue(makeSignedStellarValue(tl.lm.networkId, kp, 'ab'.repeat(32), 1234));
    expect(valueViewOf(v, 3)).toEqual({ id: valueId(v), txSetHash: 'ab'.repeat(32), closeTime: 1234, txCount: 3, proposer: kp.publicKey() });
    expect(valueViewOf('zz')).toMatchObject({ txSetHash: '', proposer: null });
    const node = kp.publicKey();
    const prepare: Statement = {
      nodeId: node,
      slotIndex: 9,
      pledges: { type: 'prepare', quorumSetHash: '0'.repeat(64), ballot: { counter: 2, value: v }, prepared: { counter: 1, value: v }, preparedPrime: null, nC: 0, nH: 0 },
    };
    expect(statementSummary(prepare)).toBe("PREPARE b=2 p=1 p'=- nC=0 nH=0");
    expect(
      statementSummary({ ...prepare, pledges: { type: 'confirm', ballot: { counter: 3, value: v }, nPrepared: 3, nCommit: 1, nH: 3, quorumSetHash: '' } }),
    ).toBe('CONFIRM b=3 nP=3 nC=1 nH=3');
    expect(statementSummary({ ...prepare, pledges: { type: 'externalize', commit: { counter: 1, value: v }, nH: 1, commitQuorumSetHash: '' } })).toBe(
      'EXTERNALIZE c=1 nH=1',
    );
    const nominate: Statement = { ...prepare, pledges: { type: 'nominate', quorumSetHash: '', votes: [v], accepted: [] } };
    expect(statementSummary(nominate)).toBe('NOMINATE votes=1 accepted=0');
    expect(scpEventViewOf({ direction: 'in', ts: 5, slot: 9, nodeId: node, name: 'n', type: 'prepare', envelope: { statement: prepare, signature: '' }, via: null })).toEqual({
      ts: 5,
      slot: 9,
      direction: 'in',
      nodeId: node,
      name: 'n',
      type: 'prepare',
      summary: "PREPARE b=2 p=1 p'=- nC=0 nH=0",
    });
    const info: SlotInfo = {
      slotIndex: 9,
      fullyValidated: true,
      nomination: { started: true, roundNumber: 2, votes: [v], accepted: [v], candidates: [], roundLeaders: [node], latestCompositeCandidate: null },
      ballot: { phase: 'PREPARE', current: null, prepared: null, preparedPrime: null, high: null, commit: null, valueOverride: null, heardFromQuorum: false },
      latestStatements: [{ nodeId: node, nomination: nominate, ballot: null }],
      externalizedValue: null,
    };
    const view = scpSlotViewOf({ info, name: () => 'me', txCount: () => 0, startedAt: 7, externalizedAt: null });
    expect(view).toMatchObject({ slot: 9, phase: 'NOMINATE', ballot: null, heardFromQuorum: false, startedAt: 7, externalized: null });
    expect(view.nomination.round).toBe(2);
    expect(view.nomination.votes[0].txCount).toBe(0);
    expect(view.nodes).toEqual([{ nodeId: node, name: 'me', statement: 'nominate', ballotCounter: null, summary: 'NOMINATE votes=1 accepted=0' }]);
    const balloting = scpSlotViewOf({
      info: { ...info, ballot: { ...info.ballot, phase: 'CONFIRM', current: { counter: 4, value: v } }, latestStatements: [{ nodeId: node, nomination: nominate, ballot: prepare }] },
      name: () => 'me',
      txCount: () => null,
      startedAt: null,
      externalizedAt: null,
    });
    expect(balloting.phase).toBe('CONFIRM');
    expect(balloting.ballot?.counter).toBe(4);
    expect(balloting.nodes[0]).toMatchObject({ statement: 'prepare', ballotCounter: 2 });
    expect(scpSlotViewOf({ info: { ...info, externalizedValue: v }, name: () => '', txCount: () => null, startedAt: 1, externalizedAt: 2 }).phase).toBe('EXTERNALIZE');
  });

  it('converts quorum sets both ways', () => {
    const q = { threshold: 2, validators: ['A', 'B'], innerSets: [{ threshold: 1, validators: ['C'], innerSets: [] }] };
    expect(qsetFromView(qsetViewOf(q))).toEqual(q);
  });
});

describe('friendbot helpers', () => {
  it('builds a signed create or payment from a channel and recognizes creates', () => {
    const tl = new TestLedger();
    const dest = Keypair.random().publicKey();
    const ch = tl.channels[0];
    const seq = tl.seqOf(ch.publicKey()) + 1n;
    const create = buildFriendbotTx({ passphrase: tl.passphrase, channel: ch, seqNum: seq, destination: dest, create: true });
    expect(createsAccount(create, dest)).toBe(true);
    expect(createsAccount(create, Keypair.random().publicKey())).toBe(false);
    expect(createsAccount('garbage', dest)).toBe(false);
    expect(tl.lm.checkValid(create).ok).toBe(true);
    const pay = buildFriendbotTx({ passphrase: tl.passphrase, channel: ch, seqNum: seq + 1n, destination: dest, create: false });
    expect(createsAccount(pay, dest)).toBe(false);
    expect(() => buildFriendbotTx({ passphrase: tl.passphrase, channel: ch, seqNum: seq, destination: 'G', create: true })).toThrow();
    const r = tl.close([create, pay]);
    expect(r.results.map((x) => x.resultCode)).toEqual(['txSUCCESS', 'txSUCCESS']);
    const channels = new Set(Array.from({ length: 64 }, (_, i) => friendbotChannel('GABC', i)));
    expect([...channels].every((c) => c >= 0 && c < 16)).toBe(true);
    expect(channels.size).toBeGreaterThan(8);
  });
});

describe('ScopedClock and TapTransport', () => {
  it('cancels every timer of a scope at once', async () => {
    const clock = new VirtualClock();
    const scope = new ScopedClock(clock);
    const fired: number[] = [];
    scope.setTimeout(() => fired.push(1), 10);
    const h = scope.setTimeout(() => fired.push(2), 20);
    scope.setTimeout(() => fired.push(3), 30);
    scope.clearTimeout(h);
    await clock.advance(15);
    expect(scope.pending()).toBe(1);
    scope.dispose();
    expect(scope.isDisposed).toBe(true);
    expect(scope.setTimeout(() => fired.push(4), 1)).toBe(-1);
    await clock.advance(100);
    expect(fired).toEqual([1]);
    expect(clock.pending()).toBe(0);
  });

  it('reports byes before the overlay sees them and can freeze silently', async () => {
    const clock = new VirtualClock();
    const net = new MemoryNetwork({ clock, latencyMs: () => 5 });
    const events: string[] = [];
    const tap = new TapTransport(net.createTransport('a'), (id) => events.push(`bye:${id}`), () => events.push('after'));
    const b = net.createTransport('b');
    tap.onPeerUp = (p) => events.push(`up:${p}`);
    tap.onMessage = (p, m) => events.push(`msg:${p}:${m.t}`);
    tap.start();
    b.start();
    await clock.advance(20);
    expect(tap.kind).toBe('memory');
    expect(tap.peers()).toEqual(['b']);
    b.send('a', { t: 'bye', nodeId: 'GXYZ' } as WireMessage);
    await clock.advance(20);
    expect(events).toEqual(['up:b', 'bye:GXYZ', 'msg:b:bye', 'after']);
    tap.freeze();
    expect(tap.isFrozen).toBe(true);
    b.send('a', { t: 'bye', nodeId: 'GXYZ' } as WireMessage);
    await clock.advance(20);
    expect(events.length).toBe(4);
    expect(tap.peers()).toEqual([]);
    tap.stop();
  });
});
