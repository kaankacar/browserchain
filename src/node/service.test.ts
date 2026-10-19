import { Account, Asset, Claimant, Keypair, Memo, Operation, TransactionBuilder, type xdr } from '@stellar/stellar-sdk/base';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toBase64, toHex, utf8 } from '../lib/bytes';
import { VirtualClock } from '../lib/clock';
import { PEER_TIMEOUT_MS } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { Simulation, type SimNode } from '../sim/simulation';
import type { AssetView, NodeEvent } from './api';
import { nullLogger } from '../lib/log';
import { MemoryNetwork } from '../overlay/memoryNetwork';
import { Overlay } from '../overlay/overlay';
import { GapCheckTransport, GapClock, NodeService, assetFromView, priceString, signaturesOf, type NodeServiceOptions } from './service';

// ---------------------------------------------------------------- helpers

/** Plain data only: no bigint, function, symbol or class instance anywhere. */
function assertPlain(v: unknown, path = '$'): void {
  if (v === null || v === undefined) return;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(v as number)) throw new Error(`${path} is not a finite number`);
    return;
  }
  if (t !== 'object') throw new Error(`${path} is a ${t}`);
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertPlain(x, `${path}[${i}]`));
    return;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is a ${proto?.constructor?.name} instance`);
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) assertPlain(x, `${path}.${k}`);
}

/** What the RPC does with every value: it must arrive unchanged. */
function cloned<T>(v: T): T {
  assertPlain(v);
  const c = structuredClone(v);
  expect(c).toEqual(v);
  return c;
}

const kp = (label: string) => Keypair.fromRawEd25519Seed(sha256(`service-test|${label}`));

interface Net {
  sim: Simulation;
  nodes: SimNode[];
  svc: NodeService;
  events: { ev: NodeEvent; at: number }[];
  passphrase: string;
}

async function network(seed: number, opts: Partial<NodeServiceOptions> = {}): Promise<Net> {
  const sim = new Simulation({ seed });
  const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
  expect(await sim.waitForLedger(3, 60_000)).toBe(true);
  const svc = new NodeService(nodes[0].node!, { clock: sim.clock, ...opts });
  const events: Net['events'] = [];
  svc.subscribe((ev) => events.push({ ev, at: sim.clock.now() }));
  return { sim, nodes, svc, events, passphrase: nodes[0].node!.passphrase };
}

function lastTxStatus(net: Net, hash: string): string | undefined {
  let s: string | undefined;
  for (const { ev } of net.events) if (ev.type === 'txStatus' && ev.hash === hash) s = ev.status;
  return s;
}

async function waitApplied(net: Net, hashes: string[], maxMs = 60_000): Promise<void> {
  const ok = await net.sim.runUntil(() => hashes.every((h) => lastTxStatus(net, h) === 'applied'), maxMs);
  if (!ok) throw new Error(`not applied: ${hashes.map((h) => `${h.slice(0, 8)}=${lastTxStatus(net, h)}`).join(', ')}`);
}

async function signedTx(net: Net, from: Keypair, ops: xdr.Operation[], memo?: Memo): Promise<string> {
  const acc = await net.svc.getAccount(from.publicKey());
  if (!acc) throw new Error(`no account ${from.publicKey()}`);
  const b = new TransactionBuilder(new Account(from.publicKey(), acc.sequence), { fee: '100', networkPassphrase: net.passphrase, memo });
  for (const op of ops) b.addOperation(op);
  const tx = b.setTimeout(0).build();
  tx.sign(from);
  return tx.toEnvelope().toXdr('base64');
}

async function submit(net: Net, from: Keypair, ops: xdr.Operation[], memo?: Memo): Promise<string> {
  const r = await net.svc.submitTransaction(await signedTx(net, from, ops, memo));
  expect(r.status, `${r.errorResultCode} ${r.errorDetail}`).toBe('PENDING');
  return r.hash;
}

async function fund(net: Net, ...keys: Keypair[]): Promise<void> {
  const hashes: string[] = [];
  for (const k of keys) {
    const r = await net.svc.friendbot(k.publicKey());
    expect(r.status, `${r.errorResultCode} ${r.errorDetail}`).toBe('PENDING');
    hashes.push(r.hash);
  }
  await waitApplied(net, hashes);
}

const XLM: AssetView = { type: 'native', code: 'XLM' };

// ---------------------------------------------------------------- rich state, read-only tests

describe('NodeService over a running network', () => {
  let net: Net;
  const issuer = kp('issuer');
  const u1 = kp('u1');
  const u2 = kp('u2');
  const usd = new Asset('USD', issuer.publicKey());
  const USD: AssetView = { type: 'credit_alphanum4', code: 'USD', issuer: issuer.publicKey() };
  let paymentHash = '';
  let paymentSeq = 0;

  beforeAll(async () => {
    net = await network(61);
    await fund(net, issuer, u1, u2);
    await waitApplied(net, [
      await submit(net, u1, [Operation.changeTrust({ asset: usd }), Operation.manageData({ name: 'nick', value: 'alice' })]),
      await submit(net, u2, [Operation.changeTrust({ asset: usd })]),
    ]);
    await waitApplied(net, [
      await submit(net, issuer, [
        Operation.payment({ destination: u1.publicKey(), asset: usd, amount: '1000' }),
        Operation.payment({ destination: u2.publicKey(), asset: usd, amount: '1000' }),
      ]),
    ]);
    // asks (USD for XLM) at 2 (two offers) and 3; bids (XLM for USD) at 1.6 and 1.25 XLM per USD
    await waitApplied(net, [
      await submit(net, u1, [
        Operation.manageSellOffer({ selling: usd, buying: Asset.native(), amount: '100', price: '2' }),
        Operation.manageSellOffer({ selling: usd, buying: Asset.native(), amount: '50', price: '2' }),
        Operation.manageSellOffer({ selling: usd, buying: Asset.native(), amount: '30', price: '3' }),
      ]),
      await submit(net, u2, [
        Operation.manageSellOffer({ selling: Asset.native(), buying: usd, amount: '150', price: '0.8' }),
        Operation.manageSellOffer({ selling: Asset.native(), buying: usd, amount: '40', price: '0.625' }),
        Operation.createClaimableBalance({
          asset: Asset.native(),
          amount: '5',
          claimants: [new Claimant(u1.publicKey(), Claimant.predicateUnconditional()), new Claimant(u2.publicKey(), Claimant.predicateBeforeRelativeTime('3600'))],
        }),
      ]),
    ]);
    // a payment through submitTransaction, then its 'applied' event
    paymentHash = await submit(net, u1, [Operation.payment({ destination: u2.publicKey(), asset: Asset.native(), amount: '12.5' })], Memo.text('lunch'));
    await waitApplied(net, [paymentHash]);
    const ev = net.events.find((e) => e.ev.type === 'txStatus' && e.ev.hash === paymentHash && e.ev.status === 'applied')!.ev;
    paymentSeq = (ev as Extract<NodeEvent, { type: 'txStatus' }>).ledgerSeq!;
  }, 120_000);

  afterAll(async () => {
    await net.sim.shutdown();
  });

  it('answers every NodeApi method with plain, cloneable data', async () => {
    const svc = net.svc;
    const status = cloned(await svc.getStatus());
    expect(status).toMatchObject({ state: 'synced', name: 'a', peers: 2, networkName: 'sim' });
    expect(cloned(await svc.getLedgers({ limit: 5 }))).toHaveLength(5);
    expect(cloned(await svc.getLedger(status.lcl.seq))?.seq).toBe(status.lcl.seq);
    expect(cloned(await svc.getTransaction(paymentHash))?.hash).toBe(paymentHash);
    expect(cloned(await svc.getTransactions({ limit: 10 })).length).toBeGreaterThan(5);
    expect(cloned(await svc.getTransactions({ limit: 10, account: u1.publicKey() })).length).toBeGreaterThan(2);
    expect(cloned(await svc.getAccount(u1.publicKey()))?.accountId).toBe(u1.publicKey());
    expect(cloned(await svc.getAccount(u2.publicKey()))?.claimableBalances).toHaveLength(1);
    expect(cloned(await svc.getOrderBook(USD, XLM)).asks.length).toBe(2);
    expect(cloned(await svc.getAssets()).length).toBe(1);
    expect(cloned(await svc.getPeers()).length).toBe(2);
    expect(cloned(await svc.getValidators()).length).toBe(3);
    expect(cloned(await svc.getQuorumConfig()).mode).toBe('auto');
    expect(cloned(await svc.getScpSlot(status.lcl.seq))?.phase).toBe('EXTERNALIZE');
    expect(await svc.getScpSlot(1)).toBeNull();
    const scp = cloned(await svc.getScpEvents(20));
    expect(scp.length).toBe(20);
    expect(scp[0].ts).toBeGreaterThanOrEqual(scp[19].ts);
    expect(await svc.getScpEvents(0)).toEqual([]);
    const stats = cloned(await svc.getStats());
    expect(stats).toMatchObject({ totalAccounts: 1 + 16 + 3, totalTrustlines: 2, totalOffers: 5, totalClaimableBalances: 1 });
    expect(stats.ledgersClosedHere).toBeGreaterThan(5);
    expect(stats.avgCloseIntervalMs).toBeGreaterThan(4000);
    expect(stats.recentCloseIntervalsMs.length).toBeGreaterThan(3);
    expect(stats.txPerLedger).toBeGreaterThan(0);
    expect(cloned(await svc.getForks())).toEqual([]);
    const logs = cloned(await svc.getLogs(50));
    expect(logs.length).toBeLessThanOrEqual(50);
    expect(await svc.getLogs(0)).toEqual([]);
    expect(cloned(await svc.friendbot('GBAD'))).toMatchObject({ status: 'ERROR', errorResultCode: 'txMALFORMED' });
    expect(cloned(await svc.submitTransaction('not xdr'))).toMatchObject({ status: 'ERROR' });
    expect(cloned(await svc.submitTransaction(''))).toMatchObject({ status: 'ERROR', errorResultCode: 'txMALFORMED' });
    // the stored envelope again: a duplicate
    const dup = await svc.submitTransaction((await svc.getTransaction(paymentHash))!.envelopeXdr);
    expect(cloned(dup)).toMatchObject({ hash: paymentHash, status: 'DUPLICATE' });
    // events seen so far are plain as well
    for (const { ev } of net.events) cloned(ev);
    const types = new Set(net.events.map((e) => e.ev.type));
    for (const t of ['status', 'ledgerClosed', 'scp', 'slot', 'peers', 'txStatus'] as const) expect(types.has(t), t).toBe(true);
    // the default slot (LCL+1) is null until it opens
    const node = net.nodes[0].node!;
    expect(await net.sim.runUntil(() => node.getScpSlot() !== null, 10_000)).toBe(true);
    const open = cloned(await svc.getScpSlot())!;
    expect(open.slot).toBe(node.ledger.lastClosed().header.ledgerSeq + 1);
  });

  it('shows a friendbot-funded account with balances, liabilities, offers, data and claimable balances', async () => {
    const svc = net.svc;
    expect(await svc.getAccount(kp('nobody').publicKey())).toBeNull();
    expect(await svc.getAccount('GBAD')).toBeNull();
    const a1 = (await svc.getAccount(u1.publicKey()))!;
    expect(a1.signers).toEqual([{ key: u1.publicKey(), weight: 1 }]);
    expect(a1.thresholds).toEqual({ masterWeight: 1, low: 0, med: 0, high: 0 });
    expect(a1.flags).toEqual({ authRequired: false, authRevocable: false, authImmutable: false, authClawbackEnabled: false });
    // 1 trust line + 1 data entry + 3 offers
    expect(a1.numSubEntries).toBe(5);
    expect(a1.minBalance).toBe('3.5000000');
    // 10,000 - 12.5 paid - 6 operations * 100 stroops in fees
    expect(a1.balances.map((b) => [b.asset.code, b.balance, b.limit])).toEqual([
      ['XLM', '9987.4999400', null],
      ['USD', '1000.0000000', '922337203685.4775807'],
    ]);
    // selling 180 USD; buying 2*150 + 3*30 = 390 XLM
    expect(a1.balances[1]).toMatchObject({ sellingLiabilities: '180.0000000', authorized: true, authorizedToMaintainLiabilities: true, clawbackEnabled: false });
    expect(a1.balances[0].buyingLiabilities).toBe('390.0000000');
    expect(a1.availableBalance).toBe('9983.9999400');
    expect(a1.offers.map((o) => [o.amount, o.price, o.priceR, o.passive, o.selling.code, o.buying.code])).toEqual([
      ['100.0000000', '2', { n: 2, d: 1 }, false, 'USD', 'XLM'],
      ['50.0000000', '2', { n: 2, d: 1 }, false, 'USD', 'XLM'],
      ['30.0000000', '3', { n: 3, d: 1 }, false, 'USD', 'XLM'],
    ]);
    expect(a1.data).toEqual([{ name: 'nick', valueBase64: toBase64(utf8('alice')), valueText: 'alice' }]);
    expect(Number(a1.sequence)).toBeGreaterThan(0);
    expect(a1.lastModifiedLedger).toBe(paymentSeq);
    // u1 is a claimant, u2 the sponsor (and a claimant before a deadline)
    const cb1 = a1.claimableBalances;
    const cb2 = (await svc.getAccount(u2.publicKey()))!.claimableBalances;
    expect(cb1).toHaveLength(1);
    expect(cb2).toEqual(cb1);
    expect(cb1[0]).toMatchObject({ asset: XLM, amount: '5.0000000', sponsor: u2.publicKey() });
    expect(cb1[0].balanceId).toMatch(/^[0-9a-f]{64}$/);
    expect(cb1[0].claimants[0]).toEqual({ destination: u1.publicKey(), predicate: { type: 'unconditional' } });
    expect(cb1[0].claimants[1].predicate).toMatchObject({ type: 'beforeAbsoluteTime', time: expect.stringMatching(/^\d+$/) });
  });

  it('finds a payment by hash after its applied event, with signatures and ledger', async () => {
    const svc = net.svc;
    const tx = (await svc.getTransaction(paymentHash.toUpperCase()))!;
    expect(tx).toMatchObject({ hash: paymentHash, ledgerSeq: paymentSeq, successful: true, resultCode: 'txSUCCESS', sourceAccount: u1.publicKey(), opCount: 1 });
    expect(tx.memo).toEqual({ type: 'text', value: 'lunch' });
    expect(tx.feeCharged).toBe('0.0000100');
    expect(tx.operations[0]).toMatchObject({ type: 'payment', resultCode: 'PAYMENT_SUCCESS' });
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0].hint).toBe(toHex(u1.rawPublicKey().subarray(28)));
    expect(tx.signatures[0].signature).toMatch(/^[0-9a-f]{128}$/);
    expect(tx.resultXdr.length).toBeGreaterThan(10);
    expect(signaturesOf('garbage')).toEqual([]);
    expect(await svc.getTransaction('ab'.repeat(32))).toBeNull();
    expect(await svc.getTransaction('nope')).toBeNull();
    const ledger = (await svc.getLedger(paymentSeq))!;
    expect(ledger.txs.map((t) => t.hash)).toContain(paymentHash);
    expect(ledger.txCount).toBe(ledger.txs.length);
    expect(ledger.header).toMatchObject({ ledgerSeq: String(paymentSeq), scpValueType: 'STELLAR_VALUE_SIGNED', baseFee: '100', totalCoins: '100000000000.0000000' });
    expect(Object.values(ledger.header).every((v) => typeof v === 'string')).toBe(true);
    expect(ledger.header.previousLedgerHash).toBe(ledger.prevHash);
    expect(ledger.header.bucketListHash).toBe(ledger.stateHash);
    expect(ledger.headerXdr.length).toBeGreaterThan(100);
    expect(await svc.getLedger(ledger.seq + 1000)).toBeNull();
    expect(await svc.getLedger(0)).toBeNull();
    const genesis = (await svc.getLedger(1))!;
    expect(genesis).toMatchObject({ seq: 1, txs: [], proposer: null });
    expect(genesis.header.scpValueType).toBe('STELLAR_VALUE_BASIC');
    const mine = await svc.getTransactions({ limit: 50, account: u2.publicKey() });
    expect(mine[0].hash).toBe(paymentHash);
    expect(await svc.getTransactions({ limit: 5, account: 'GBAD' })).toEqual([]);
    const older = await svc.getTransactions({ limit: 50, beforeLedger: paymentSeq });
    expect(older.every((t) => t.ledgerSeq < paymentSeq)).toBe(true);
  });

  it('builds the order book from price levels: asks in selling units, bids in buying units', async () => {
    const svc = net.svc;
    const book = await svc.getOrderBook(USD, XLM);
    expect(book.selling).toEqual(USD);
    expect(book.buying).toEqual(XLM);
    expect(book.asks).toEqual([
      { price: '2', amount: '150.0000000', priceR: { n: 2, d: 1 } },
      { price: '3', amount: '30.0000000', priceR: { n: 3, d: 1 } },
    ]);
    // bids: XLM offered for USD, best (highest XLM per USD) first
    expect(book.bids).toEqual([
      { price: '1.6', amount: '40.0000000', priceR: { n: 8, d: 5 } },
      { price: '1.25', amount: '150.0000000', priceR: { n: 5, d: 4 } },
    ]);
    const mirror = await svc.getOrderBook(XLM, USD, 1);
    expect(mirror.asks).toEqual([{ price: '0.625', amount: '40.0000000', priceR: { n: 5, d: 8 } }]);
    expect(mirror.bids).toEqual([{ price: '0.5', amount: '150.0000000', priceR: { n: 1, d: 2 } }]);
    await expect(svc.getOrderBook({ type: 'credit_alphanum4', code: 'USD', issuer: 'GBAD' }, XLM)).rejects.toThrow(/invalid asset/);
    expect((await svc.getOrderBook({ type: 'credit_alphanum4', code: 'EUR', issuer: issuer.publicKey() }, XLM)).asks).toEqual([]);
  });

  it('reports asset holders, supply and issuer flags', async () => {
    const assets = await net.svc.getAssets();
    expect(assets).toEqual([
      {
        asset: USD,
        holders: 2,
        supply: '2000.0000000',
        issuerFlags: { authRequired: false, authRevocable: false, authClawbackEnabled: false },
      },
    ]);
  });

  it('pages ledgers newest first down to genesis', async () => {
    const svc = net.svc;
    const lcl = (await svc.getStatus()).lcl.seq;
    const all: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await svc.getLedgers({ limit: 7, beforeSeq: before });
      if (page.length === 0) break;
      expect(page.length).toBeLessThanOrEqual(7);
      for (let i = 1; i < page.length; i++) expect(page[i].seq).toBe(page[i - 1].seq - 1);
      for (let i = 1; i < page.length; i++) expect(page[i - 1].prevHash).toBe(page[i].hash);
      all.push(...page.map((l) => l.seq));
      before = page[page.length - 1].seq;
    }
    expect(all).toEqual(Array.from({ length: lcl }, (_, i) => lcl - i));
    expect(await svc.getLedgers({ limit: 0 })).toEqual([]);
    expect((await svc.getLedgers({ limit: 10_000 })).length).toBe(Math.min(lcl, 200));
    expect(await svc.getLedgers({ limit: 5, beforeSeq: 1 })).toEqual([]);
    const top = await svc.getLedgers({ limit: 3, beforeSeq: lcl + 50 });
    expect(top[0].seq).toBe(lcl);
    // the summaries match what ledgerClosed events said
    const closed = net.events.filter((e) => e.ev.type === 'ledgerClosed').map((e) => (e.ev as Extract<NodeEvent, { type: 'ledgerClosed' }>).ledger);
    const last = closed[closed.length - 1];
    // externalizedBy may rise after the close, as late CONFIRMs arrive
    const { externalizedBy: _x, ...fixed } = last;
    const [again] = await svc.getLedgers({ limit: 1, beforeSeq: last.seq + 1 });
    expect(again).toMatchObject(fixed);
    expect(again.externalizedBy).toBeGreaterThanOrEqual(last.externalizedBy);
  });
});

// ---------------------------------------------------------------- mutating calls

describe('NodeService settings', () => {
  it('switches quorum config manual and auto, toggles validating and resyncs', async () => {
    const net = await network(62);
    const [a, b, c] = net.nodes;
    const svc = net.svc;
    const manual = await svc.setQuorumConfig({ mode: 'manual', qset: { threshold: 2, validators: [a.nodeId, b.nodeId, c.nodeId], innerSets: [] } });
    expect(cloned(manual)).toMatchObject({ mode: 'manual', qset: { threshold: 2 }, faultTolerance: 1 });
    expect((await svc.getQuorumConfig()).mode).toBe('manual');
    await expect(svc.setQuorumConfig({ mode: 'manual', qset: { threshold: 5, validators: [a.nodeId], innerSets: [] } })).rejects.toThrow(/invalid quorum set/);
    await expect(svc.setQuorumConfig({ mode: 'manual', qset: { threshold: 1 } as never })).rejects.toThrow(/validators/);
    await expect(svc.setQuorumConfig({ mode: 'other' } as never)).rejects.toThrow(/auto/);
    expect(await net.sim.waitForLedger(a.lcl + 2, 30_000)).toBe(true);
    const auto = await svc.setQuorumConfig({ mode: 'auto' });
    expect(auto.mode).toBe('auto');
    expect(auto.qset.validators.sort()).toEqual([a.nodeId, b.nodeId, c.nodeId].sort());

    await svc.setValidating(false);
    expect((await svc.getStatus()).isValidator).toBe(false);
    await svc.setValidating(true);
    expect((await svc.getStatus()).isValidator).toBe(true);
    await svc.setName('alpha');
    expect((await svc.getStatus()).name).toBe('alpha');
    await expect(svc.setName('  ')).rejects.toThrow();

    // resync: the ledger is replaced, the service follows node.ledger
    const user = kp('resync-user');
    await fund(net, user);
    const before = (await svc.getAccount(user.publicKey()))!.balances[0].balance;
    await svc.resync();
    expect((await svc.getStatus()).lcl.seq).toBe(1);
    expect(await svc.getAccount(user.publicKey())).toBeNull();
    expect(await net.sim.runUntil(() => a.state === 'synced' && a.lcl >= b.lcl - 1, 60_000)).toBe(true);
    expect((await svc.getAccount(user.publicKey()))!.balances[0].balance).toBe(before);
    expect((await svc.getStats()).totalAccounts).toBe(1 + 16 + 1);
    expect(net.sim.conflicts()).toEqual([]);
    await net.sim.shutdown();
  });
});

describe('NodeService settings and status', () => {
  it('delivers the new status before a settings call resolves', async () => {
    const net = await network(65);
    const svc = net.svc;
    const last = () => {
      const ev = net.events.filter((e) => e.ev.type === 'status').pop()?.ev as Extract<NodeEvent, { type: 'status' }> | undefined;
      return ev?.status;
    };
    // same set, only the mode changes: the node raises no event of its own
    const qset = (await svc.getQuorumConfig()).qset;
    expect((await svc.setQuorumConfig({ mode: 'manual', qset })).mode).toBe('manual');
    expect(last()?.quorum.mode).toBe('manual');
    await svc.setQuorumConfig({ mode: 'auto' });
    expect(last()?.quorum.mode).toBe('auto');
    await svc.setName('renamed');
    expect(last()?.name).toBe('renamed');
    await svc.setValidating(false);
    expect(last()?.isValidator).toBe(false);
    await svc.setValidating(true);
    expect(last()?.isValidator).toBe(true);
    await net.sim.shutdown();
  });
});

// ---------------------------------------------------------------- events

describe('NodeService events', () => {
  it('coalesces status, slot and peers events and delivers the rest one by one', async () => {
    const net = await network(63);
    const node = net.nodes[0].node!;
    const direct = { ledgerClosed: 0, txStatus: 0, log: 0, scpEnvelope: 0 };
    node.events.on('ledgerClosed', () => direct.ledgerClosed++);
    node.events.on('txStatus', () => direct.txStatus++);
    node.events.on('log', () => direct.log++);
    node.events.on('scpEnvelope', () => direct.scpEnvelope++);
    const from = net.events.length;
    const t0 = net.sim.clock.now();
    // traffic: funding and a peer that leaves and comes back
    const users = Array.from({ length: 4 }, (_, i) => kp(`events-${i}`));
    for (const u of users) await net.svc.friendbot(u.publicKey());
    await net.sim.run(12_000);
    await net.sim.stopNode(net.nodes[2]);
    await net.sim.run(6_000);
    await net.sim.restartNode(net.nodes[2]);
    await net.sim.run(12_000);
    const span = net.sim.clock.now() - t0;
    const seen = net.events.slice(from);
    const of = (type: NodeEvent['type']) => seen.filter((e) => e.ev.type === type);
    const gaps = (xs: { at: number }[]) => xs.slice(1).map((x, i) => x.at - xs[i].at);
    // coalesced: never closer than the window, so at most span / window + 1
    expect(of('status').length).toBeGreaterThan(5);
    expect(of('status').length).toBeLessThanOrEqual(Math.floor(span / 500) + 1);
    expect(Math.min(...gaps(of('status')))).toBeGreaterThanOrEqual(500);
    expect(of('slot').length).toBeGreaterThan(5);
    expect(Math.min(...gaps(of('slot')))).toBeGreaterThanOrEqual(250);
    expect(of('peers').length).toBeGreaterThan(1);
    expect(Math.min(...gaps(of('peers')))).toBeGreaterThanOrEqual(1000);
    // slot events carry the newest slot
    for (const { ev } of of('slot')) expect((ev as Extract<NodeEvent, { type: 'slot' }>).slot.slot).toBeGreaterThan(1);
    // always delivered
    expect(of('ledgerClosed').length).toBe(direct.ledgerClosed);
    expect(of('txStatus').length).toBe(direct.txStatus);
    expect(of('log').length).toBe(direct.log);
    expect(of('scp').length).toBe(direct.scpEnvelope);
    expect(direct.ledgerClosed).toBeGreaterThan(4);
    expect(of('txStatus').filter((e) => (e.ev as { status: string }).status === 'applied').length).toBeGreaterThanOrEqual(users.length);
    // the last status after a quiet period is current
    await net.sim.run(1000);
    const last = net.events.filter((e) => e.ev.type === 'status').pop()!.ev as Extract<NodeEvent, { type: 'status' }>;
    expect(last.status.lcl.seq).toBeGreaterThanOrEqual(node.ledger.lastClosed().header.ledgerSeq - 1);
    // unsubscribed listeners and a throwing listener do not get in the way
    const extra: NodeEvent[] = [];
    const off = net.svc.subscribe((ev) => extra.push(ev));
    net.svc.subscribe(() => {
      throw new Error('broken listener');
    });
    await net.sim.run(6000);
    expect(extra.length).toBeGreaterThan(0);
    off();
    const n = extra.length;
    await net.sim.run(6000);
    expect(extra.length).toBe(n);
    net.svc.dispose();
    const after = net.events.length;
    await net.sim.run(6000);
    expect(net.events.length).toBe(after);
    await net.sim.shutdown();
  });

  it('maps page lifecycle events to sync re-checks', async () => {
    const net = await network(64);
    const node = net.nodes[0].node!;
    const spy = vi.spyOn(node, 'onResume');
    const flush = vi.spyOn(node.chain, 'flush');
    const svc = net.svc;
    svc.lifecycle('hidden');
    await net.sim.run(3000);
    svc.lifecycle('visible');
    expect(spy).not.toHaveBeenCalled();
    svc.lifecycle('hidden');
    await net.sim.run(PEER_TIMEOUT_MS + 1000);
    svc.lifecycle('visible');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/visible again after 8 s/);
    svc.lifecycle('visible');
    expect(spy).toHaveBeenCalledTimes(1);
    svc.lifecycle('freeze');
    expect(flush).toHaveBeenCalled();
    svc.lifecycle('resume');
    svc.lifecycle('pageshow-persisted');
    expect(spy).toHaveBeenCalledTimes(3);
    svc.lifecycle('pagehide');
    expect(spy).toHaveBeenCalledTimes(3);
    // a resume re-check: booting, then synced again without a fork
    expect(node.state).toBe('booting');
    expect(await net.sim.runUntil(() => node.state === 'synced', 20_000)).toBe(true);
    expect(await net.sim.waitForLedger(net.nodes[1].lcl + 2, 30_000)).toBe(true);
    expect(net.sim.conflicts()).toEqual([]);
    await net.sim.shutdown();
  });
});

// ---------------------------------------------------------------- helpers without a network

describe('service helpers', () => {
  it('formats prices and parses asset views', () => {
    expect(priceString({ n: 2, d: 1 })).toBe('2');
    expect(priceString({ n: 1, d: 3 })).toBe('0.3333333');
    expect(priceString({ n: 5, d: 4 })).toBe('1.25');
    expect(priceString({ n: 1, d: 2_000_000_000 })).toBe('5.000000e-10');
    expect(Number(priceString({ n: 1, d: 2_000_000_000 }))).toBeGreaterThan(0);
    expect(priceString({ n: 2_147_483_647, d: 1 })).toBe('2147483647');
    expect(priceString({ n: 1, d: 0 })).toBe('0');
    const issuer = kp('issuer').publicKey();
    expect(assetFromView({ type: 'native', code: 'XLM' })).toEqual({ type: 'native' });
    expect(assetFromView({ type: 'credit_alphanum4', code: 'LONGER', issuer })).toEqual({ type: 'credit_alphanum12', code: 'LONGER', issuer });
    expect(() => assetFromView({ type: 'credit_alphanum4', code: 'U$D', issuer })).toThrow();
    expect(() => assetFromView(null as never)).toThrow(/invalid asset/);
  });

  it('GapClock reports a pause once, before the late timers run', async () => {
    const inner = new VirtualClock();
    let paused = false;
    const deferred: (() => void)[] = [];
    // an inner clock that holds timers while "paused" (a frozen tab)
    const holding = {
      now: () => inner.now(),
      setTimeout: (cb: () => void, ms: number) => inner.setTimeout(() => (paused ? deferred.push(cb) : cb()), ms),
      clearTimeout: (h: number) => inner.clearTimeout(h),
    };
    const gap = new GapClock(holding, 7000);
    const seen: string[] = [];
    gap.onGap = (ms) => seen.push(`gap ${Math.round(ms / 1000)}`);
    gap.setTimeout(() => seen.push('t1'), 1000);
    gap.setTimeout(() => seen.push('t2'), 2000);
    await inner.advance(500);
    paused = true;
    await inner.advance(30_000);
    paused = false;
    for (const cb of deferred.splice(0)) cb();
    expect(seen).toEqual(['gap 30', 't1', 't2']);
    // a timer late by less than the threshold is not a gap
    gap.setTimeout(() => seen.push('t3'), 100);
    paused = true;
    await inner.advance(5000);
    paused = false;
    for (const cb of deferred.splice(0)) cb();
    expect(seen).toEqual(['gap 30', 't1', 't2', 't3']);
    expect(gap.now()).toBe(inner.now());
    const h = gap.setTimeout(() => seen.push('never'), 10);
    gap.clearTimeout(h);
    await inner.advance(100);
    expect(seen).not.toContain('never');
    // poll (a message arrives): no timer ran for longer than the threshold
    gap.poll();
    expect(seen).toHaveLength(4);
    await inner.advance(9000);
    gap.poll();
    expect(seen[4]).toBe('gap 9');
    gap.poll();
    expect(seen).toHaveLength(5);
    // the late timers of that pause do not report it again
    paused = true;
    gap.setTimeout(() => seen.push('t5'), 0);
    await inner.advance(10);
    paused = false;
    for (const cb of deferred.splice(0)) cb();
    expect(seen.slice(5)).toEqual(['t5']);
  });
});

describe('GapCheckTransport', () => {
  it('forwards the channel id, so worker links still sign their DTLS channel', async () => {
    const clock = new VirtualClock(1_790_000_000_000);
    const net = new MemoryNetwork({ clock, seed: 4, latencyMs: () => 10 });
    const gap = new GapClock(clock);
    const mk = (i: number) => {
      const inner = net.createTransport(`n${i}`, { kind: 'webrtc' });
      const t = new GapCheckTransport(inner, gap);
      const overlay = new Overlay({
        keypair: Keypair.fromRawEd25519Seed(sha256(`gap-check-${i}`)),
        networkId: toHex(sha256('gap check transport')),
        name: `n${i}`,
        clock,
        logger: nullLogger(clock),
        transports: [t],
        handlers: { onStellarMessage: () => undefined, onRequest: () => null },
      });
      return { inner, t, overlay };
    };
    const a = mk(0);
    const b = mk(1);
    a.overlay.start();
    b.overlay.start();
    await clock.advance(200);
    expect(a.t.channelId('n1')).toMatch(/^[0-9a-f]{64}$/);
    expect(a.t.channelId('n1')).toBe(a.inner.channelId('n1'));
    expect(a.t.channelId('n1')).toBe(b.t.channelId('n0'));
    expect(a.overlay.peers()).toHaveLength(1);
    expect(a.overlay.stats().channelBound).toBe(1);
    expect(b.overlay.stats().channelBound).toBe(1);
  });
});
