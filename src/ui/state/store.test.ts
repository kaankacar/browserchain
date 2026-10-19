import { Keypair } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it } from 'vitest';
import { VirtualClock } from '../../lib/clock';
import type { LedgerSummary, NodeApi, NodeEvent, ScpEventView, ScpSlotView, TxDetail, TxSummary } from '../../node/api';
import { createMockNode, type MockNode } from '../mock/mockNode';
import { MAX_LEDGERS, MAX_SCP_EVENTS, NodeStore, initialState, reduce, type NodeState } from './store';

function ledger(seq: number): LedgerSummary {
  return {
    seq,
    hash: seq.toString(16).padStart(64, '0'),
    prevHash: (seq - 1).toString(16).padStart(64, '0'),
    closeTime: 1000 + seq * 5,
    txCount: 1,
    opCount: 1,
    failedTxCount: 0,
    baseFee: 100,
    baseReserve: 5000000,
    totalCoins: '100000000000.0000000',
    feePool: '0.0000000',
    protocolVersion: 23,
    txSetHash: 'a'.repeat(64),
    stateHash: 'b'.repeat(64),
    proposer: null,
    closedAt: seq * 5000,
    externalizedBy: 4,
  };
}

function tx(hash: string, ledgerSeq: number, applyIndex = 0, successful = true): TxSummary {
  return {
    hash,
    ledgerSeq,
    applyIndex,
    sourceAccount: 'GA',
    feeCharged: '0.0000100',
    maxFee: '0.0000100',
    opCount: 1,
    successful,
    resultCode: successful ? 'txSUCCESS' : 'txFAILED',
    memo: { type: 'none', value: null },
    closeTime: 0,
    operations: [],
  };
}

function scp(ts: number, summary = 'NOMINATE'): ScpEventView {
  return { ts, slot: 5, direction: 'in', nodeId: 'GX', name: 'x', type: 'nominate', summary };
}

const ev = (state: NodeState, event: NodeEvent, now = 1) => reduce(state, { type: 'event', event, now });

describe('store reducer', () => {
  it('keeps the newest 50 ledgers and replaces a rolled-back branch', () => {
    let s = initialState();
    for (let i = 1; i <= 60; i++) s = ev(s, { type: 'ledgerClosed', ledger: ledger(i), txs: [] }, i);
    expect(s.ledgers).toHaveLength(MAX_LEDGERS);
    expect(s.ledgers[0].seq).toBe(60);
    expect(s.closeCounter).toBe(60);
    expect(s.lastCloseEventAt).toBe(60);
    const replaced = { ...ledger(58), hash: 'f'.repeat(64) };
    s = ev(s, { type: 'ledgerClosed', ledger: replaced, txs: [] });
    expect(s.ledgers[0]).toEqual(replaced);
    expect(s.ledgers[1].seq).toBe(57);
  });

  it('orders the tx feed newest first and drops txs of replaced ledgers', () => {
    let s = initialState();
    s = ev(s, { type: 'ledgerClosed', ledger: ledger(3), txs: [tx('a', 3, 0), tx('b', 3, 1)] });
    s = ev(s, { type: 'ledgerClosed', ledger: ledger(4), txs: [tx('c', 4, 0)] });
    expect(s.txs.map((t) => t.hash)).toEqual(['c', 'b', 'a']);
    s = ev(s, { type: 'ledgerClosed', ledger: ledger(4), txs: [tx('d', 4, 0)] });
    expect(s.txs.map((t) => t.hash)).toEqual(['d', 'b', 'a']);
  });

  it('tracks tx status and never moves a final state back to pending', () => {
    let s = initialState();
    s = reduce(s, { type: 'localTx', hash: 'h', status: 'pending', now: 1 });
    s = ev(s, { type: 'txStatus', hash: 'h', status: 'applied', ledgerSeq: 9, resultCode: 'txSUCCESS' }, 2);
    s = ev(s, { type: 'txStatus', hash: 'h', status: 'pending' }, 3);
    expect(s.txStatus.h).toMatchObject({ status: 'applied', ledgerSeq: 9, resultCode: 'txSUCCESS' });
    // A tracked tx is also resolved by the ledger that includes it.
    s = reduce(s, { type: 'localTx', hash: 'k', status: 'pending', now: 4 });
    s = ev(s, { type: 'ledgerClosed', ledger: ledger(10), txs: [tx('k', 10, 0, false)] }, 5);
    expect(s.txStatus.k).toMatchObject({ status: 'failed', ledgerSeq: 10, resultCode: 'txFAILED' });
  });

  it('forgets statuses from ledgers a rollback dropped', () => {
    // The node emits 'fork' (rolled-back) first, then replays the winning
    // branch. A tx that was only on the dropped ledgers gets no new event
    // (its re-queue fails), so it must not stay "applied".
    let s = initialState();
    s = reduce(s, { type: 'localTx', hash: 'gone', status: 'pending', now: 1 });
    s = reduce(s, { type: 'localTx', hash: 'kept', status: 'pending', now: 1 });
    s = reduce(s, { type: 'localTx', hash: 'early', status: 'pending', now: 1 });
    s = reduce(s, { type: 'localTx', hash: 'rejected', status: 'failed', resultCode: 'txBAD_SEQ', now: 1 });
    s = ev(s, { type: 'ledgerClosed', ledger: ledger(2), txs: [tx('early', 2)] });
    s = ev(s, { type: 'ledgerClosed', ledger: ledger(5), txs: [tx('gone', 5), tx('kept', 5, 1)] });
    expect(s.txStatus.gone).toMatchObject({ status: 'applied', ledgerSeq: 5 });
    s = ev(s, { type: 'fork', info: { ts: 9, atSeq: 3, ourHash: 'a', theirHash: 'b', peer: 'GP', resolution: 'rolled-back', rolledBackLedgers: 3 } });
    // replay of the winning branch: 'kept' is in it, 'gone' is not
    s = ev(s, { type: 'ledgerClosed', ledger: { ...ledger(3), hash: 'c'.repeat(64) }, txs: [] });
    s = ev(s, { type: 'txStatus', hash: 'kept', status: 'applied', ledgerSeq: 4, resultCode: 'txSUCCESS' });
    expect(s.txStatus.gone).toBeUndefined();
    expect(s.txStatus.kept).toMatchObject({ status: 'applied', ledgerSeq: 4 });
    // statuses from before the fork point, and rejections, stay
    expect(s.txStatus.early).toMatchObject({ status: 'applied', ledgerSeq: 2 });
    expect(s.txStatus.rejected).toMatchObject({ status: 'failed', resultCode: 'txBAD_SEQ' });
    // a re-queued tx can be pending again, then applied on the new branch
    s = ev(s, { type: 'txStatus', hash: 'gone', status: 'pending' });
    expect(s.txStatus.gone).toMatchObject({ status: 'pending' });
    // other fork reports change no status
    const before = s.txStatus;
    s = ev(s, { type: 'fork', info: { ts: 10, atSeq: 1, ourHash: 'a', theirHash: 'b', peer: 'GQ', resolution: 'kept-ours', rolledBackLedgers: 0 } });
    expect(s.txStatus).toBe(before);
  });

  it('dedupes and caps SCP events, logs and forks', () => {
    let s = initialState();
    s = ev(s, { type: 'scp', event: scp(1) });
    s = ev(s, { type: 'scp', event: scp(1) });
    expect(s.scpEvents).toHaveLength(1);
    for (let i = 2; i < 400; i++) s = ev(s, { type: 'scp', event: scp(i) });
    expect(s.scpEvents).toHaveLength(MAX_SCP_EVENTS);
    expect(s.scpEvents[0].ts).toBe(399);
    const entry = { ts: 1, level: 'info' as const, scope: 'x', msg: 'hi' };
    s = ev(s, { type: 'log', entry });
    s = ev(s, { type: 'log', entry });
    expect(s.logs).toHaveLength(1);
    const fork = { ts: 1, atSeq: 3, ourHash: 'a', theirHash: 'b', peer: 'GP', resolution: 'kept-ours' as const, rolledBackLedgers: 0 };
    s = ev(s, { type: 'fork', info: fork });
    s = ev(s, { type: 'fork', info: fork });
    expect(s.forks).toHaveLength(1);
  });

  it('ignores slot views for older slots and returns the same state for no-ops', () => {
    const slot = (n: number) => ({ slot: n }) as ScpSlotView;
    let s = ev(initialState(), { type: 'slot', slot: slot(10) });
    const same = ev(s, { type: 'slot', slot: slot(9) });
    expect(same).toBe(s);
    s = ev(s, { type: 'slot', slot: slot(11) });
    expect(s.slot?.slot).toBe(11);
  });

  it('merges snapshots with live data', () => {
    let s = initialState();
    s = ev(s, { type: 'ledgerClosed', ledger: ledger(20), txs: [tx('z', 20)] });
    s = ev(s, { type: 'scp', event: scp(50, 'live') });
    s = reduce(s, {
      type: 'snapshot',
      data: { ledgers: [ledger(19), ledger(20), ledger(18)], txs: [tx('y', 19), tx('z', 20)], scpEvents: [scp(50, 'live'), scp(40, 'old')] },
    });
    expect(s.ledgers.map((l) => l.seq)).toEqual([20, 19, 18]);
    expect(s.txs.map((t) => t.hash)).toEqual(['z', 'y']);
    expect(s.scpEvents.map((e) => e.summary)).toEqual(['live', 'old']);
    expect(reduce(s, { type: 'ready' }).ready).toBe(true);
  });

  it('remembers when this UI last started a resync', () => {
    // fork reports from before it are about the wiped chain
    let s = initialState();
    expect(s.resyncAt).toBeNull();
    s = reduce(s, { type: 'resync', now: 5_000 });
    expect(s.resyncAt).toBe(5_000);
    s = reduce(s, { type: 'resync', now: 9_000 });
    expect(s.resyncAt).toBe(9_000);
  });
});

describe('NodeStore with the mock node', () => {
  const live: MockNode[] = [];
  afterEach(() => live.splice(0).forEach((n) => n.stop()));

  it('loads, follows events and resolves submitted transactions', async () => {
    const clock = new VirtualClock();
    const node = createMockNode({ clock, seed: 7, bootMs: 0, historyLedgers: 8, churn: false, forks: false });
    live.push(node);
    const store = new NodeStore(node, clock);
    let notifications = 0;
    store.subscribe(() => notifications++);
    const stop = store.start();
    await clock.runUntil(() => store.getState().ready, 1000);
    const s0 = store.getState();
    expect(s0.status?.lcl.seq).toBe(9);
    expect(s0.ledgers[0].seq).toBe(9);
    expect(s0.validators.length).toBe(5);
    expect(s0.stats).not.toBeNull();
    await clock.advance(11_000);
    const s1 = store.getState();
    expect(s1.ledgers[0].seq).toBeGreaterThan(9);
    expect(s1.status?.lcl.seq).toBe(s1.ledgers[0].seq);
    expect(s1.scpEvents.length).toBeGreaterThan(20);
    expect(s1.slot?.slot).toBe(s1.ledgers[0].seq + 1);
    expect(notifications).toBeGreaterThan(5);

    const kp = Keypair.random();
    const r = await node.friendbot(kp.publicKey());
    store.trackSubmitted(r.hash);
    const done = store.waitForTx(r.hash, 30_000);
    await clock.advance(12_000);
    await expect(done).resolves.toMatchObject({ status: 'applied' });

    const never = expect(store.waitForTx('0'.repeat(64), 1000)).rejects.toThrow(/Timed out/);
    await clock.advance(1500);
    await never;
    stop();
    const before = store.getState();
    await clock.advance(6000);
    expect(store.getState()).toBe(before);
  });

  it('finds the status of submissions from an earlier visit (after a reload)', async () => {
    const clock = new VirtualClock();
    const node = createMockNode({ clock, seed: 9, bootMs: 0, historyLedgers: 4, churn: false, forks: false });
    live.push(node);
    const first = new NodeStore(node, clock);
    const stopFirst = first.start();
    await clock.runUntil(() => first.getState().ready, 1000);
    const r = await node.friendbot(Keypair.random().publicKey());
    first.trackSubmitted(r.hash);
    const done = first.waitForTx(r.hash, 30_000);
    await clock.advance(12_000);
    const applied = await done;
    stopFirst();

    // a reloaded page: a new store knows nothing about the earlier submissions
    const store = new NodeStore(node, clock);
    const stop = store.start();
    await clock.runUntil(() => store.getState().ready, 1000);
    const unknown = 'f'.repeat(64);
    expect(store.getState().txStatus[r.hash]).toBeUndefined();
    await store.resolveFromHistory([r.hash, unknown]);
    expect(store.getState().txStatus[r.hash]).toMatchObject({ status: 'applied', ledgerSeq: applied.ledgerSeq });
    expect(store.getState().txStatus[unknown]).toBeUndefined();
    stop();
  });

  it('drops a history answer when a rollback dropped its ledger during the call', async () => {
    let answer: (tx: TxDetail | null) => void = () => {};
    const api = { getTransaction: () => new Promise<TxDetail | null>((resolve) => (answer = resolve)) } as unknown as NodeApi;
    const store = new NodeStore(api, new VirtualClock());
    const done = store.resolveFromHistory(['h']);
    store.dispatch({
      type: 'event',
      event: { type: 'fork', info: { ts: 1, atSeq: 3, ourHash: 'a', theirHash: 'b', peer: 'GP', resolution: 'rolled-back', rolledBackLedgers: 4 } },
      now: 1,
    });
    answer({ ...tx('h', 5), envelopeXdr: '', resultXdr: '', signatures: [] });
    await done;
    expect(store.getState().txStatus.h).toBeUndefined();
  });

  it('notes a resync this UI started at the time of its clock', async () => {
    const clock = new VirtualClock();
    const store = new NodeStore({} as NodeApi, clock);
    await clock.advance(1_234);
    store.noteResync();
    expect(store.getState().resyncAt).toBe(clock.now());
  });
});
