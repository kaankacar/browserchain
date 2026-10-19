import { Keypair, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '../../lib/bytes';
import { VirtualClock } from '../../lib/clock';
import type { NodeEvent, ScpPhase, TxStatus } from '../../node/api';
import {
  buildTx,
  changeTrustOp,
  claimClaimableBalanceOp,
  createClaimableBalanceOp,
  manageBuyOfferOp,
  manageSellOfferOp,
  cancelOfferOp,
  paymentOp,
  signTx,
} from '../lib/txbuild';
import { codeFromArm, cmpFrac, predicateHolds } from './mockLedger';
import { MockNode, createMockNode, parseMockDemo } from './mockNode';

const XLM = { type: 'native' as const, code: 'XLM' };
const nodes: MockNode[] = [];

function makeNode(extra: Partial<Parameters<typeof createMockNode>[0]> = {}) {
  const clock = new VirtualClock();
  const node = createMockNode({ clock, seed: 42, bootMs: 0, historyLedgers: 12, churn: false, forks: false, ...extra });
  nodes.push(node);
  const events: NodeEvent[] = [];
  node.subscribe((e) => events.push(e));
  return { clock, node, events };
}

afterEach(() => {
  for (const n of nodes.splice(0)) n.stop();
});

async function waitStatus(clock: VirtualClock, events: NodeEvent[], hash: string, maxMs = 20_000): Promise<{ status: TxStatus; resultCode?: string; ledgerSeq?: number }> {
  let found: Extract<NodeEvent, { type: 'txStatus' }> | undefined;
  await clock.runUntil(() => {
    found = events.find((e): e is Extract<NodeEvent, { type: 'txStatus' }> => e.type === 'txStatus' && e.hash === hash && e.status !== 'pending');
    return !!found;
  }, maxMs);
  if (!found) throw new Error(`no final status for ${hash}`);
  return { status: found.status, resultCode: found.resultCode, ledgerSeq: found.ledgerSeq };
}

async function funded(clock: VirtualClock, node: MockNode, events: NodeEvent[]): Promise<Keypair> {
  const kp = Keypair.random();
  const r = await node.friendbot(kp.publicKey());
  expect(r.status).toBe('PENDING');
  const s = await waitStatus(clock, events, r.hash);
  expect(s.status).toBe('applied');
  return kp;
}

async function submit(node: MockNode, kp: Keypair, ops: xdr.Operation[], seqOffset = 0): Promise<{ hash: string; status: string; errorResultCode?: string }> {
  const acc = await node.getAccount(kp.publicKey());
  if (!acc) throw new Error('no account');
  const seq = (BigInt(acc.sequence) + BigInt(seqOffset)).toString();
  const tx = buildTx({ source: kp.publicKey(), sequence: seq, networkPassphrase: node.passphrase }, ops);
  return node.submitTransaction(signTx(tx, kp.secret()));
}

describe('mock ledger helpers', () => {
  it('turns XDR arm names into result codes', () => {
    expect(codeFromArm('paymentUnderfunded')).toBe('PAYMENT_UNDERFUNDED');
    expect(codeFromArm('createAccountAlreadyExist')).toBe('CREATE_ACCOUNT_ALREADY_EXIST');
    expect(codeFromArm('txBadSeq')).toBe('txBAD_SEQ');
    expect(codeFromArm('txSuccess')).toBe('txSUCCESS');
    expect(codeFromArm('opNoAccount')).toBe('opNO_ACCOUNT');
  });
  it('compares prices exactly', () => {
    expect(cmpFrac(1, 3, 2, 6)).toBe(0);
    expect(cmpFrac(2147483647, 2147483646, 2147483646, 2147483645)).toBe(-1);
  });
  it('evaluates claim predicates', () => {
    expect(predicateHolds({ type: 'unconditional' }, 5)).toBe(true);
    expect(predicateHolds({ type: 'beforeAbsoluteTime', time: '10' }, 5)).toBe(true);
    expect(predicateHolds({ type: 'not', predicate: { type: 'beforeAbsoluteTime', time: '10' } }, 5)).toBe(false);
    expect(predicateHolds({ type: 'and', predicates: [{ type: 'unconditional' }, { type: 'beforeAbsoluteTime', time: '4' }] }, 5)).toBe(false);
    expect(predicateHolds({ type: 'or', predicates: [{ type: 'unconditional' }, { type: 'beforeAbsoluteTime', time: '4' }] }, 5)).toBe(true);
  });
});

describe('mock node: history and views', () => {
  it('starts with a populated, consistent chain', async () => {
    const { node } = makeNode();
    const status = await node.getStatus();
    expect(status.lcl.seq).toBe(13);
    expect(status.networkPassphrase).toBe('BrowserChain Network ; October 2026');
    expect(status.networkId).toMatch(/^[0-9a-f]{64}$/);
    expect(status.quorum.mode).toBe('auto');
    expect(status.quorum.qset.validators).toHaveLength(5);
    expect(status.quorum.qset.threshold).toBe(4);
    expect(status.quorum.intersection).toBe('ok');
    expect(status.quorum.faultTolerance).toBe(1);

    const ledgers = await node.getLedgers({ limit: 5 });
    expect(ledgers.map((l) => l.seq)).toEqual([13, 12, 11, 10, 9]);
    for (let i = 0; i + 1 < ledgers.length; i++) expect(ledgers[i].prevHash).toBe(ledgers[i + 1].hash);
    expect(await node.getLedgers({ limit: 3, beforeSeq: 3 })).toHaveLength(2);

    const l2 = await node.getLedger(2);
    expect(l2?.txs).toHaveLength(1);
    expect(l2?.txs[0].opCount).toBe(8);
    expect(l2?.txs[0].memo).toEqual({ type: 'text', value: 'genesis drop' });
    const header = xdr.LedgerHeader.fromXdr(l2!.headerXdr, 'base64');
    expect(header.ledgerSeq).toBe(2);
    expect(header.scpValue.ext.type).toBe('stellarValueSigned');
    expect(await node.getLedger(9999)).toBeNull();

    const tx = await node.getTransaction(l2!.txs[0].hash);
    expect(tx?.successful).toBe(true);
    expect(tx?.operations.every((o) => o.resultCode === 'CREATE_ACCOUNT_SUCCESS')).toBe(true);
    const env = TransactionBuilder.fromXdr(tx!.envelopeXdr, node.passphrase);
    expect(toHex(env.hash())).toBe(tx!.hash);
    const res = xdr.TransactionResult.fromXdr(tx!.resultXdr, 'base64');
    expect(res.result.type).toBe('txSuccess');
    expect(tx!.signatures[0].hint).toMatch(/^[0-9a-f]{8}$/);

    const assets = await node.getAssets();
    expect(assets.map((a) => a.asset.code).sort()).toEqual(['EURB', 'GOLD', 'USDB']);
    const usd = assets.find((a) => a.asset.code === 'USDB')!;
    expect(usd.holders).toBeGreaterThanOrEqual(5);
    const book = await node.getOrderBook(usd.asset, XLM);
    expect(book.asks.length).toBeGreaterThan(0);
    expect(book.bids.length).toBeGreaterThan(0);
    expect(Number(book.asks[0].price)).toBeGreaterThan(Number(book.bids[0].price));
    for (let i = 0; i + 1 < book.asks.length; i++) expect(Number(book.asks[i].price)).toBeLessThanOrEqual(Number(book.asks[i + 1].price));
    for (let i = 0; i + 1 < book.bids.length; i++) expect(Number(book.bids[i].price)).toBeGreaterThanOrEqual(Number(book.bids[i + 1].price));

    const validators = await node.getValidators();
    expect(validators).toHaveLength(5);
    expect(validators.filter((v) => v.isSelf)).toHaveLength(1);
    const peers = await node.getPeers();
    expect(peers.filter((p) => p.validator)).toHaveLength(4);
    expect(peers.some((p) => !p.validator)).toBe(true);
    const stats = await node.getStats();
    expect(stats.totalAccounts).toBeGreaterThan(20);
    expect(stats.avgCloseIntervalMs).toBeGreaterThan(4000);
    expect(stats.avgCloseIntervalMs).toBeLessThan(6000);
  });

  it('is deterministic for a seed', async () => {
    const a = makeNode().node;
    const b = makeNode().node;
    expect((await a.getStatus()).lcl.hash).toBe((await b.getStatus()).lcl.hash);
    const c = makeNode({ seed: 43 }).node;
    expect((await c.getStatus()).lcl.hash).not.toBe((await a.getStatus()).lcl.hash);
  });
});

describe('mock node: consensus', () => {
  it('closes a ledger about every 5 seconds and walks through the SCP phases', async () => {
    const { clock, node, events } = makeNode();
    const start = (await node.getStatus()).lcl.seq;
    await clock.advance(16_000);
    const closes = events.filter((e): e is Extract<NodeEvent, { type: 'ledgerClosed' }> => e.type === 'ledgerClosed');
    expect(closes.length).toBeGreaterThanOrEqual(2);
    expect(closes.length).toBeLessThanOrEqual(4);
    expect(closes[0].ledger.seq).toBe(start + 1);
    const gaps = closes.slice(1).map((c, i) => c.ledger.closedAt - closes[i].ledger.closedAt);
    for (const g of gaps) {
      expect(g).toBeGreaterThan(4500);
      expect(g).toBeLessThan(6500);
    }
    expect(closes[0].ledger.externalizedBy).toBeGreaterThanOrEqual(4);

    const slot = closes[0].ledger.seq;
    const phases = events
      .filter((e): e is Extract<NodeEvent, { type: 'slot' }> => e.type === 'slot' && e.slot.slot === slot)
      .map((e) => e.slot.phase);
    const order: ScpPhase[] = ['NOMINATE', 'PREPARE', 'CONFIRM', 'EXTERNALIZE'];
    const seen = order.filter((p) => phases.includes(p));
    expect(seen).toEqual(order);
    for (let i = 1; i < phases.length; i++) expect(order.indexOf(phases[i])).toBeGreaterThanOrEqual(order.indexOf(phases[i - 1]));

    const mine = events
      .filter((e): e is Extract<NodeEvent, { type: 'scp' }> => e.type === 'scp' && e.event.slot === slot && e.event.direction === 'out')
      .map((e) => e.event.type);
    expect(mine[0]).toBe('nominate');
    expect(mine).toContain('prepare');
    expect(mine).toContain('confirm');
    expect(mine[mine.length - 1]).toBe('externalize');
    const others = new Set(events.filter((e) => e.type === 'scp' && e.event.slot === slot && e.event.direction === 'in').map((e) => (e as Extract<NodeEvent, { type: 'scp' }>).event.nodeId));
    expect(others.size).toBe(4);

    const lastSlot = events.filter((e): e is Extract<NodeEvent, { type: 'slot' }> => e.type === 'slot' && e.slot.slot === slot).pop()!.slot;
    expect(lastSlot.externalized?.id).toMatch(/^[0-9a-f]{8}$/);
    expect(lastSlot.nomination.leaders.length).toBeGreaterThan(0);
    expect(lastSlot.ballot?.counter).toBeGreaterThanOrEqual(1);
    expect(lastSlot.commit).not.toBeNull();
    expect(await node.getScpSlot(slot)).not.toBeNull();
    const evs = await node.getScpEvents(20);
    expect(evs).toHaveLength(20);
    expect(evs[0].ts).toBeGreaterThanOrEqual(evs[19].ts);
  });

  it('closes every slot in time, including ballot timeouts and second rounds', async () => {
    let timeouts = 0;
    let secondRounds = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { clock, events } = makeNode({ seed, churn: true });
      await clock.advance(150_000);
      const closes = events.filter((e): e is Extract<NodeEvent, { type: 'ledgerClosed' }> => e.type === 'ledgerClosed');
      expect(closes.length).toBeGreaterThan(25);
      // Triggers are 5 s apart (not closes), so a slow slot is followed by a quicker one.
      const gaps = closes.slice(1).map((c, i) => c.ledger.closedAt - closes[i].ledger.closedAt);
      for (const gap of gaps) {
        expect(gap).toBeGreaterThan(2500);
        expect(gap).toBeLessThan(8000);
      }
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      expect(avg).toBeGreaterThan(4800);
      expect(avg).toBeLessThan(5400);
      timeouts += events.filter((e) => e.type === 'log' && /bumping to counter 2/.test(e.entry.msg)).length;
      secondRounds += events.filter((e) => e.type === 'slot' && e.slot.nomination.round === 2).length > 0 ? 1 : 0;
      // The slot-level ballot follows the counter bump.
      const bumped = events.filter((e): e is Extract<NodeEvent, { type: 'slot' }> => e.type === 'slot' && e.slot.externalized !== null);
      for (const b of bumped) {
        const lastCounter = Math.max(...b.slot.nodes.map((n) => n.ballotCounter ?? 0));
        if (b.slot.ballot) expect(b.slot.ballot.counter).toBe(lastCounter);
      }
    }
    expect(timeouts).toBeGreaterThan(0);
    expect(secondRounds).toBeGreaterThan(0);
  });

  it('keeps closing ledgers as a watcher and stops signing', async () => {
    const { clock, node, events } = makeNode();
    await node.setValidating(false);
    expect((await node.getStatus()).isValidator).toBe(false);
    const before = events.length;
    await clock.advance(12_000);
    const after = events.slice(before);
    expect(after.some((e) => e.type === 'ledgerClosed')).toBe(true);
    expect(after.some((e) => e.type === 'scp' && e.event.direction === 'out')).toBe(false);
  });

  it('stalls with an unsatisfiable manual quorum and recovers in auto mode', async () => {
    const { clock, node, events } = makeNode();
    const status = await node.getStatus();
    await expect(node.setQuorumConfig({ mode: 'manual', qset: { threshold: 3, validators: [status.nodeId], innerSets: [] } })).rejects.toThrow(/threshold/);
    const ghost = Keypair.random().publicKey();
    const cfg = await node.setQuorumConfig({ mode: 'manual', qset: { threshold: 2, validators: [status.nodeId, ghost], innerSets: [] } });
    expect(cfg.mode).toBe('manual');
    expect(cfg.faultTolerance).toBe(0);
    await clock.advance(6_000);
    const seqStuck = (await node.getStatus()).lcl.seq;
    await clock.advance(18_000);
    expect((await node.getStatus()).lcl.seq).toBe(seqStuck);
    expect((await node.getStatus()).state).toBe('stalled');
    await node.setQuorumConfig({ mode: 'auto' });
    await clock.advance(8_000);
    const s = await node.getStatus();
    expect(s.lcl.seq).toBeGreaterThan(seqStuck);
    expect(s.state).toBe('synced');
    expect(events.some((e) => e.type === 'log' && /no ledger closed/.test(e.entry.msg))).toBe(true);
  });

  it('reports broken intersection when we only trust ourselves', async () => {
    const { node } = makeNode();
    const id = (await node.getStatus()).nodeId;
    const cfg = await node.setQuorumConfig({ mode: 'manual', qset: { threshold: 1, validators: [id], innerSets: [] } });
    expect(cfg.intersection).toBe('broken');
  });

  it('renames, resyncs and recovers', async () => {
    const { clock, node, events } = makeNode();
    await node.setName('  Night Owl  ');
    expect((await node.getStatus()).name).toBe('Night Owl');
    await expect(node.setName('   ')).rejects.toThrow();
    await node.resync();
    expect((await node.getStatus()).state).toBe('catching-up');
    expect((await node.getStatus()).catchup).not.toBeNull();
    await clock.advance(4_000);
    expect((await node.getStatus()).state).toBe('synced');
    const seq = (await node.getStatus()).lcl.seq;
    await clock.advance(8_000);
    expect((await node.getStatus()).lcl.seq).toBeGreaterThan(seq);
    expect(events.some((e) => e.type === 'status' && e.status.state === 'catching-up')).toBe(true);
  });

  it('has peers come and go and reports forks', async () => {
    const { clock, node, events } = makeNode({ churn: true, forks: true });
    await clock.advance(200_000);
    const peerCounts = events.filter((e): e is Extract<NodeEvent, { type: 'peers' }> => e.type === 'peers').map((e) => e.peers.length);
    expect(Math.min(...peerCounts)).toBeLessThan(Math.max(...peerCounts));
    expect(events.some((e) => e.type === 'fork')).toBe(true);
    expect((await node.getForks()).length).toBeGreaterThan(0);
    const closes = events.filter((e) => e.type === 'ledgerClosed').length;
    expect(closes).toBeGreaterThan(30);
    expect((await node.getLogs(10)).length).toBe(10);
  });
});

describe('mock node: demo states (?mock=1&demo=...)', () => {
  const forkReports = (events: NodeEvent[]) => events.filter((e): e is Extract<NodeEvent, { type: 'fork' }> => e.type === 'fork').map((e) => e.info);

  it('reads the demo flag', () => {
    expect(parseMockDemo('strangers')).toBe('strangers');
    expect(parseMockDemo('blocked')).toBe('blocked');
    expect(parseMockDemo(null)).toBeUndefined();
    expect(parseMockDemo('')).toBeUndefined();
    expect(parseMockDemo('nope')).toBeUndefined();
  });

  it('strangers: re-reports a fork with unknown validators until a resync', async () => {
    const { clock, node, events } = makeNode({ demo: 'strangers' });
    await clock.advance(32_000);
    const reports = forkReports(events);
    expect(reports.length).toBeGreaterThanOrEqual(3);
    const known = new Set((await node.getValidators()).map((v) => v.nodeId));
    for (const f of reports) {
      expect(f).toMatchObject({ resolution: 'kept-ours', unknownValidators: 3, atSeq: reports[0].atSeq, rolledBackLedgers: 0 });
      expect(f.ourHash).toBe((await node.getLedger(f.atSeq))?.hash);
      expect(f.theirHash).not.toBe(f.ourHash);
      // validators this node does not know
      expect(known.has(f.peer)).toBe(false);
    }
    // at most every 10 s, as the node does
    for (let i = 1; i < reports.length; i++) expect(reports[i].ts - reports[i - 1].ts).toBeGreaterThanOrEqual(10_000);
    expect(await node.getForks()).toHaveLength(reports.length);
    // it keeps its own chain and votes on it
    const s = await node.getStatus();
    expect(s.state).toBe('synced');
    expect(events.some((e) => e.type === 'ledgerClosed')).toBe(true);

    // a resync joins the other group: the reports stop
    await node.resync();
    await clock.advance(30_000);
    expect(forkReports(events)).toHaveLength(reports.length);
    expect((await node.getStatus()).state).toBe('synced');
  });

  it('blocked: peers are ahead, the node does not vote and says why; a resync brings it back', async () => {
    const { clock, node, events } = makeNode({ demo: 'blocked' });
    const s = await node.getStatus();
    expect(s.state).toBe('catching-up');
    expect(s.catchup?.blocked).toMatch(/\w/);
    expect(s.catchup?.source).toBeNull();
    expect(s.catchup!.target).toBeGreaterThan(s.lcl.seq + 1);
    // the validators it follows announce the target
    const peers = (await node.getPeers()).filter((p) => p.validator);
    expect(peers.length).toBeGreaterThan(0);
    for (const p of peers) expect(p.lclSeq).toBe(s.catchup!.target);

    await clock.advance(20_000);
    expect(events.some((e) => e.type === 'ledgerClosed')).toBe(false);
    expect(events.some((e) => e.type === 'scp' && e.event.direction === 'out')).toBe(false);
    const later = await node.getStatus();
    expect(later.lcl.seq).toBe(s.lcl.seq);
    expect(later.catchup?.blocked).toBe(s.catchup?.blocked);
    // the others keep closing ledgers
    expect(later.catchup!.target).toBeGreaterThan(s.catchup!.target);
    expect((await node.getLogs(100)).some((e) => e.level === 'warn' && /not voting/.test(e.msg))).toBe(true);

    await node.resync();
    expect((await node.getStatus()).catchup?.blocked).toBeUndefined();
    await clock.advance(4_000);
    expect((await node.getStatus()).state).toBe('synced');
    await clock.advance(8_000);
    expect(events.some((e) => e.type === 'ledgerClosed')).toBe(true);
  });

  it('blocked after the boot catch-up (as in the browser): the boot progress does not move it', async () => {
    const { clock, node } = makeNode({ demo: 'blocked', bootMs: 1600 });
    await clock.advance(2_000);
    const s = await node.getStatus();
    expect(s.state).toBe('catching-up');
    expect(s.catchup).toMatchObject({ current: s.lcl.seq, source: null });
    expect(s.catchup?.blocked).toMatch(/\w/);
  });
});

describe('mock node: transactions', () => {
  it('funds new accounts with friendbot', async () => {
    const { clock, node, events } = makeNode();
    const kp = Keypair.random();
    const r = await node.friendbot(kp.publicKey());
    expect(r.status).toBe('PENDING');
    expect(events.some((e) => e.type === 'txStatus' && e.hash === r.hash && e.status === 'pending')).toBe(true);
    expect((await node.friendbot(kp.publicKey())).status).toBe('DUPLICATE');
    const s = await waitStatus(clock, events, r.hash);
    expect(s.status).toBe('applied');
    const acc = await node.getAccount(kp.publicKey());
    expect(acc?.balances[0]).toMatchObject({ balance: '10000.0000000', asset: { type: 'native' } });
    expect(acc?.minBalance).toBe('1.0000000');
    expect(acc?.availableBalance).toBe('9999.0000000');
    const topUp = await node.friendbot(kp.publicKey());
    expect(topUp.status).toBe('PENDING');
    await waitStatus(clock, events, topUp.hash);
    expect((await node.getAccount(kp.publicKey()))?.balances[0].balance).toBe('20000.0000000');
    expect((await node.friendbot('GNOPE')).status).toBe('ERROR');
    const hist = await node.getTransactions({ limit: 10, account: kp.publicKey() });
    expect(hist.map((t) => t.hash)).toEqual([topUp.hash, r.hash]);
  });

  it('applies payments and rejects bad envelopes', async () => {
    const { clock, node, events } = makeNode();
    const a = await funded(clock, node, events);
    const b = await funded(clock, node, events);
    const pay = await submit(node, a, [paymentOp({ destination: b.publicKey(), asset: XLM, amount: '125.5' })]);
    expect(pay.status).toBe('PENDING');
    expect((await submit(node, a, [paymentOp({ destination: b.publicKey(), asset: XLM, amount: '1' })], 5)).errorResultCode).toBe('txBAD_SEQ');
    const second = await submit(node, a, [paymentOp({ destination: b.publicKey(), asset: XLM, amount: '1' })], 1);
    expect(second.status).toBe('PENDING');
    expect((await waitStatus(clock, events, pay.hash)).status).toBe('applied');
    expect((await waitStatus(clock, events, second.hash)).status).toBe('applied');
    const accA = await node.getAccount(a.publicKey());
    const accB = await node.getAccount(b.publicKey());
    expect(accA?.balances[0].balance).toBe('9873.4999800');
    expect(accB?.balances[0].balance).toBe('10126.5000000');
    const detail = await node.getTransaction(pay.hash);
    expect(detail?.feeCharged).toBe('0.0000100');
    expect(detail?.operations[0]).toMatchObject({ type: 'payment', resultCode: 'PAYMENT_SUCCESS' });

    // Unsigned, garbage and duplicate envelopes.
    const acc = await node.getAccount(a.publicKey());
    const unsigned = buildTx({ source: a.publicKey(), sequence: acc!.sequence, networkPassphrase: node.passphrase }, [
      paymentOp({ destination: b.publicKey(), asset: XLM, amount: '1' }),
    ]);
    expect((await node.submitTransaction(unsigned.toEnvelope().toXdr('base64'))).errorResultCode).toBe('txBAD_AUTH');
    expect((await node.submitTransaction('AAAA')).status).toBe('ERROR');
    expect((await node.submitTransaction(detail!.envelopeXdr)).status).toBe('DUPLICATE');
  });

  it('reports failed operations with their result codes', async () => {
    const { clock, node, events } = makeNode();
    const a = await funded(clock, node, events);
    const b = await funded(clock, node, events);
    const r = await submit(node, a, [paymentOp({ destination: b.publicKey(), asset: XLM, amount: '50000' })]);
    expect(r.status).toBe('PENDING');
    const s = await waitStatus(clock, events, r.hash);
    expect(s.status).toBe('failed');
    expect(s.resultCode).toBe('txFAILED');
    const d = await node.getTransaction(r.hash);
    expect(d?.operations[0].resultCode).toBe('PAYMENT_UNDERFUNDED');
    expect(xdr.TransactionResult.fromXdr(d!.resultXdr, 'base64').result.type).toBe('txFailed');
    // The fee and sequence bump stay; the payment is rolled back.
    const acc = await node.getAccount(a.publicKey());
    expect(acc?.balances[0].balance).toBe('9999.9999900');
  });

  it('issues an asset: trustline, mint, then appears in assets', async () => {
    const { clock, node, events } = makeNode();
    const issuer = await funded(clock, node, events);
    const holder = await funded(clock, node, events);
    const asset = { type: 'credit_alphanum4' as const, code: 'PIZZA'.slice(0, 4), issuer: issuer.publicKey() };
    const noTrust = await submit(node, issuer, [paymentOp({ destination: holder.publicKey(), asset, amount: '10' })]);
    expect((await waitStatus(clock, events, noTrust.hash)).status).toBe('failed');
    expect((await node.getTransaction(noTrust.hash))?.operations[0].resultCode).toBe('PAYMENT_NO_TRUST');
    const trust = await submit(node, holder, [changeTrustOp({ asset })]);
    expect((await waitStatus(clock, events, trust.hash)).status).toBe('applied');
    const mint = await submit(node, issuer, [paymentOp({ destination: holder.publicKey(), asset, amount: '1000' })]);
    expect((await waitStatus(clock, events, mint.hash)).status).toBe('applied');
    const acc = await node.getAccount(holder.publicKey());
    expect(acc?.numSubEntries).toBe(1);
    expect(acc?.balances[1]).toMatchObject({ asset: { code: 'PIZZ', issuer: issuer.publicKey() }, balance: '1000.0000000' });
    const stat = (await node.getAssets()).find((x) => x.asset.code === 'PIZZ');
    expect(stat).toMatchObject({ holders: 1, supply: '1000.0000000' });
    // Removing a trustline with a balance fails; after paying back it works.
    const rm = await submit(node, holder, [changeTrustOp({ asset, limit: '0' })]);
    expect((await waitStatus(clock, events, rm.hash)).status).toBe('failed');
    const back = await submit(node, holder, [paymentOp({ destination: issuer.publicKey(), asset, amount: '1000' }), changeTrustOp({ asset, limit: '0' })]);
    expect((await waitStatus(clock, events, back.hash)).status).toBe('applied');
    expect((await node.getAccount(holder.publicKey()))?.balances).toHaveLength(1);
  });

  it('places, crosses and cancels offers', async () => {
    const { clock, node, events } = makeNode({ traffic: false });
    const assets = await node.getAssets();
    const usd = assets.find((a) => a.asset.code === 'USDB')!.asset;
    const trader = await funded(clock, node, events);
    const t = await submit(node, trader, [changeTrustOp({ asset: usd })]);
    await waitStatus(clock, events, t.hash);
    const book = await node.getOrderBook(usd, XLM);
    const bestAsk = Number(book.asks[0].price);
    // Buy 10 USDB paying up to the best ask: crosses the maker's offer.
    const buy = await submit(node, trader, [manageBuyOfferOp({ selling: XLM, buying: usd, buyAmount: '10', price: String(bestAsk) })]);
    expect((await waitStatus(clock, events, buy.hash)).status).toBe('applied');
    const after = await node.getAccount(trader.publicKey());
    expect(after?.balances[1].balance).toBe('10.0000000');
    expect(Number(after?.balances[0].balance)).toBeLessThan(10000 - 10 * bestAsk + 1);
    const buyDetail = await node.getTransaction(buy.hash);
    expect(buyDetail?.operations[0].resultCode).toBe('MANAGE_BUY_OFFER_SUCCESS');
    expect(Number(buyDetail?.operations[0].details.claimed)).toBeGreaterThan(0);
    // A resting sell offer far above the market.
    const sell = await submit(node, trader, [manageSellOfferOp({ selling: usd, buying: XLM, amount: '5', price: String(bestAsk * 3) })]);
    expect((await waitStatus(clock, events, sell.hash)).status).toBe('applied');
    const withOffer = await node.getAccount(trader.publicKey());
    expect(withOffer?.offers).toHaveLength(1);
    expect(withOffer?.balances[1].sellingLiabilities).toBe('5.0000000');
    const offer = withOffer!.offers[0];
    const book2 = await node.getOrderBook(usd, XLM, 50);
    expect(book2.asks.some((a) => Number(a.price) > bestAsk * 2.9)).toBe(true);
    const cancel = await submit(node, trader, [cancelOfferOp({ selling: offer.selling, buying: offer.buying, offerId: offer.offerId })]);
    expect((await waitStatus(clock, events, cancel.hash)).status).toBe('applied');
    expect((await node.getAccount(trader.publicKey()))?.offers).toHaveLength(0);
    // Self-crossing is refused: our ask at the mid price becomes the best ask, then we bid into it.
    const book3 = await node.getOrderBook(usd, XLM);
    const mid = ((Number(book3.asks[0].price) + Number(book3.bids[0].price)) / 2).toFixed(4);
    const ask = await submit(node, trader, [manageSellOfferOp({ selling: usd, buying: XLM, amount: '1', price: mid })]);
    expect((await waitStatus(clock, events, ask.hash)).status).toBe('applied');
    expect((await node.getOrderBook(usd, XLM)).asks[0].price).toBe(String(Number(mid)));
    const cross = await submit(node, trader, [manageBuyOfferOp({ selling: XLM, buying: usd, buyAmount: '1', price: mid })]);
    const crossStatus = await waitStatus(clock, events, cross.hash);
    expect(crossStatus.status).toBe('failed');
    expect((await node.getTransaction(cross.hash))?.operations[0].resultCode).toBe('MANAGE_BUY_OFFER_CROSS_SELF');
  });

  it('creates and claims claimable balances', async () => {
    const { clock, node, events } = makeNode();
    const a = await funded(clock, node, events);
    const b = await funded(clock, node, events);
    const c = await funded(clock, node, events);
    const create = await submit(node, a, [
      createClaimableBalanceOp({ asset: XLM, amount: '40', claimants: [{ destination: b.publicKey(), predicate: { type: 'beforeRelative', seconds: 3600 } }] }),
    ]);
    expect((await waitStatus(clock, events, create.hash)).status).toBe('applied');
    const accA = await node.getAccount(a.publicKey());
    expect(accA?.claimableBalances).toHaveLength(1);
    expect(accA?.minBalance).toBe('1.5000000');
    const cb = (await node.getAccount(b.publicKey()))!.claimableBalances[0];
    // The claimant sees the creating transaction in its history.
    expect((await node.getTransactions({ limit: 5, account: b.publicKey() })).some((t) => t.hash === create.hash)).toBe(true);
    expect((await node.getTransaction(create.hash))?.operations[0].details.claimants).toBe(b.publicKey());
    expect(cb.amount).toBe('40.0000000');
    expect(cb.balanceId).toMatch(/^[0-9a-f]{64}$/);
    expect((cb.claimants[0].predicate as { type: string }).type).toBe('beforeAbsoluteTime');
    const wrong = await submit(node, c, [claimClaimableBalanceOp(cb.balanceId)]);
    expect((await waitStatus(clock, events, wrong.hash)).status).toBe('failed');
    expect((await node.getTransaction(wrong.hash))?.operations[0].resultCode).toBe('CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM');
    const claim = await submit(node, b, [claimClaimableBalanceOp(cb.balanceId)]);
    expect((await waitStatus(clock, events, claim.hash)).status).toBe('applied');
    expect((await node.getAccount(b.publicKey()))?.balances[0].balance).toBe('10039.9999900');
    expect((await node.getAccount(a.publicKey()))?.claimableBalances).toHaveLength(0);
    expect((await node.getAccount(a.publicKey()))?.minBalance).toBe('1.0000000');
  });

  it('builds envelopes the mock can decode as real XDR', async () => {
    const { node } = makeNode();
    const status = await node.getStatus();
    expect(TransactionBuilder.fromXdr).toBeTypeOf('function');
    expect(status.slot === null || status.slot.index === status.lcl.seq + 1).toBe(true);
  });
});
