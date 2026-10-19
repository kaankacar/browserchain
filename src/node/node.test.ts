import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { FRIENDBOT_AMOUNT } from '../lib/constants';
import { LogSink } from '../lib/log';
import { MemoryNetwork } from '../overlay/memoryNetwork';
import { qsetNodes } from '../scp/quorum';
import { MemoryStorage } from '../storage/memoryStorage';
import { Simulation } from '../sim/simulation';
import type { NodeEvents } from './events';
import { META_IDENTITY, META_MEMBERS, META_NAME, META_QUORUM, META_VALIDATING, Node } from './node';

function solo(storage = new MemoryStorage(), extra: Partial<ConstructorParameters<typeof Node>[0]> = {}) {
  const clock = new VirtualClock();
  const net = new MemoryNetwork({ clock });
  const node = new Node({
    transports: [net.createTransport('solo')],
    storage,
    clock,
    networkName: 'node-test',
    logSink: new LogSink(clock, 'warn'),
    ...extra,
  });
  return { clock, net, node, storage };
}

function collect<K extends keyof NodeEvents>(node: Node, name: K): NodeEvents[K][] {
  const out: NodeEvents[K][] = [];
  node.events.on(name, (e) => out.push(e));
  return out;
}

describe('Node identity and settings', () => {
  it('creates an identity once and keeps it in storage meta', async () => {
    const storage = new MemoryStorage();
    const a = solo(storage);
    await a.node.start();
    const id = a.node.nodeId;
    expect(StrKey.isValidEd25519PublicKey(id)).toBe(true);
    expect(a.node.name).toBe(`node-${id.slice(1, 5)}`);
    expect(await storage.getMeta<string>(META_IDENTITY)).toMatch(/^S/);
    await a.node.stop();
    const b = solo(storage);
    await b.node.start();
    expect(b.node.nodeId).toBe(id);
    expect(b.node.name).toBe(`node-${id.slice(1, 5)}`);
    await b.node.stop();
  });

  it('takes the secret and name from the options', async () => {
    const kp = Keypair.random();
    const { node, storage } = solo(undefined, { secret: kp.secret(), name: 'alpha' });
    await node.start();
    expect(node.nodeId).toBe(kp.publicKey());
    expect(node.name).toBe('alpha');
    expect(await storage.getMeta(META_NAME)).toBe('alpha');
    await node.stop();
  });

  it('persists name, validating flag and quorum mode across restarts', async () => {
    const storage = new MemoryStorage();
    const a = solo(storage);
    await a.node.start();
    await a.node.setName('  renamed  ');
    expect(a.node.name).toBe('renamed');
    expect(a.node.overlay.currentAnnouncement().name).toBe('renamed');
    await a.node.setValidating(false);
    expect(a.node.overlay.currentAnnouncement().validator).toBe(false);
    const other = Keypair.random().publicKey();
    const cfg = await a.node.setQuorumConfig({ mode: 'manual', qset: { threshold: 1, validators: [a.node.nodeId, other], innerSets: [] } });
    expect(cfg.mode).toBe('manual');
    expect(cfg.faultTolerance).toBe(1);
    await expect(a.node.setQuorumConfig({ mode: 'manual', qset: { threshold: 3, validators: [other], innerSets: [] } })).rejects.toThrow(/invalid quorum set/);
    await expect(a.node.setName('   ')).rejects.toThrow();
    expect(await storage.getMeta(META_VALIDATING)).toBe(false);
    expect((await storage.getMeta<{ mode: string }>(META_QUORUM))?.mode).toBe('manual');
    await a.node.stop();
    const b = solo(storage);
    await b.node.start();
    expect(b.node.name).toBe('renamed');
    expect(b.node.isValidating()).toBe(false);
    expect(b.node.getQuorumConfig().mode).toBe('manual');
    expect(qsetNodes(b.node.herder.scp.getLocalQuorumSet()).sort()).toEqual([b.node.nodeId, other].sort());
    await b.node.setQuorumConfig({ mode: 'auto' });
    expect(b.node.getQuorumConfig().qset.validators).toEqual([b.node.nodeId]);
    await b.node.stop();
  });

  it('refuses a second start and reports stopped after stop', async () => {
    const { node, storage } = solo();
    await node.start();
    await expect(node.start()).rejects.toThrow(/already started/);
    await node.stop();
    expect(node.state).toBe('stopped');
    expect(node.isRunning).toBe(false);
    await expect(storage.getMeta('x')).rejects.toThrow(/not open/);
    expect((await node.submitTransaction('AAAA')).status).toBe('ERROR');
  });
});

describe('Node as a solo validator', () => {
  it('boots, syncs alone after 4 s and closes ledgers with events and views', async () => {
    const { node, clock } = solo();
    const states = collect(node, 'state');
    const closed = collect(node, 'ledgerClosed');
    const scp = collect(node, 'scpEnvelope');
    await node.start();
    expect(node.state).toBe('booting');
    await clock.advance(3_900);
    expect(node.state).toBe('booting');
    await clock.advance(200);
    expect(node.state).toBe('synced');
    await clock.advance(16_000);
    expect(closed.length).toBe(4);
    expect(closed.every((c) => c.source === 'consensus' && c.stored.externalizedBy === 1)).toBe(true);
    expect(closed[0].stored.seq).toBe(2);
    expect(states.map((s) => s.state)).toEqual(['synced']);
    expect(scp.every((e) => e.direction === 'out')).toBe(true);
    const status = node.getStatus();
    expect(status).toMatchObject({ state: 'synced', name: node.name, peers: 0, validatorsActive: 1, mempoolSize: 0, catchup: null });
    expect(status.lcl.seq).toBe(5);
    expect(status.lcl.externalizedBy).toBe(1);
    expect(status.quorum).toMatchObject({ mode: 'auto', intersection: 'ok', faultTolerance: 0 });
    expect(status.lcl.proposer).toBe(node.nodeId);
    const last = node.getScpSlot(5);
    expect(last?.phase).toBe('EXTERNALIZE');
    expect(last?.externalized?.proposer).toBe(node.nodeId);
    expect(node.getScpEvents(3).length).toBe(3);
    expect(node.getCloseIntervals().every((ms) => ms >= 4_900 && ms <= 5_100)).toBe(true);
    expect(node.getValidators()).toHaveLength(1);
    expect(node.getValidators()[0]).toMatchObject({ isSelf: true, active: true, inMyQuorum: true });
    await node.stop();
  });

  it('submits transactions and runs friendbot (create, then top up)', async () => {
    const { node, clock } = solo();
    const tx = collect(node, 'txStatus');
    await node.start();
    await clock.advance(4_500);
    const user = Keypair.random().publicKey();
    expect((await node.friendbot('GBAD')).errorResultCode).toBe('txMALFORMED');
    const r1 = await node.friendbot(user);
    expect(r1.status).toBe('PENDING');
    // a second request before the first is applied pays after the create
    const r2 = await node.friendbot(user);
    expect(r2.status).toBe('PENDING');
    await clock.advance(6_000);
    expect(node.ledger.getAccount(user)?.balance).toBe(2n * FRIENDBOT_AMOUNT);
    expect(tx.filter((e) => e.status === 'applied').map((e) => e.hash).sort()).toEqual([r1.hash, r2.hash].sort());
    const stored = await node.storage.getTx(r1.hash);
    expect(stored?.successful).toBe(true);
    const dup = await node.submitTransaction(stored!.envelopeXdr);
    expect(dup.status).toBe('DUPLICATE');
    await node.stop();
  });

  it('reloads its chain from storage after a restart', async () => {
    const storage = new MemoryStorage();
    const a = solo(storage);
    await a.node.start();
    await a.clock.advance(30_000);
    const lcl = a.node.ledger.lastClosed();
    await a.node.stop();
    const b = solo(storage);
    await b.node.start();
    expect(b.node.ledger.lastClosed().hash).toBe(lcl.hash);
    await b.clock.advance(10_000);
    expect(b.node.ledger.lastClosed().header.ledgerSeq).toBeGreaterThan(lcl.header.ledgerSeq);
    await b.node.stop();
  });
});

describe('Node in a network', () => {
  it('a watcher follows the chain without emitting, and joins when it starts validating', async () => {
    const sim = new Simulation({ seed: 21 });
    const vals = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    const w = await sim.addNode({ name: 'w', validating: false });
    const out = collect(w.node!, 'scpEnvelope');
    expect(await sim.waitForLedger(8, 60_000)).toBe(true);
    expect(w.consensusCloses().length).toBeGreaterThan(3);
    expect(out.filter((e) => e.direction === 'out')).toEqual([]);
    for (const v of vals) expect(qsetNodes(v.node!.herder.scp.getLocalQuorumSet())).not.toContain(w.nodeId);
    expect(w.node!.getPeers().every((p) => p.inMyQuorum)).toBe(true);
    await w.node!.setValidating(true);
    expect(await sim.waitForLedger(w.lcl + 4, 60_000)).toBe(true);
    expect(out.some((e) => e.direction === 'out')).toBe(true);
    for (const v of vals) expect(qsetNodes(v.node!.herder.scp.getLocalQuorumSet())).toContain(w.nodeId);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('a watcher keeps its quorum set up to date and never shrinks it to itself', async () => {
    const sim = new Simulation({ seed: 25 });
    const w = await sim.addNode({ name: 'w', validating: false });
    const [a] = await sim.addNodes([{ name: 'a' }]);
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    const later = await sim.addNodes([{ name: 'b' }, { name: 'c' }]);
    expect(await sim.waitForLedger(a.lcl + 4, 60_000)).toBe(true);
    const members = () => qsetNodes(w.node!.herder.scp.getLocalQuorumSet()).sort();
    expect(members()).toEqual([a.nodeId, later[0].nodeId, later[1].nodeId].sort());
    for (const v of [a, ...later]) await sim.stopNode(v);
    await sim.run(20_000);
    expect(members()).not.toEqual([w.nodeId]);
    for (const v of [a, ...later]) await sim.restartNode(v);
    const at = Math.max(a.lcl, w.lcl);
    expect(await sim.runUntil(() => w.lcl >= at + 3, 60_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('resync wipes the chain and catches up from peers, keeping the identity', async () => {
    const sim = new Simulation({ seed: 22 });
    const [a, b, c] = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(10, 60_000)).toBe(true);
    const resets = collect(c.node!, 'ledgerReset');
    await c.node!.resync();
    expect(c.node!.ledger.lastClosed().header.ledgerSeq).toBe(1);
    expect(resets.map((r) => r.reason)).toEqual(['resync']);
    expect(await sim.runUntil(() => c.state === 'synced' && c.lcl >= a.lcl - 1, 30_000)).toBe(true);
    expect(c.node!.nodeId).toBe(c.nodeId);
    expect(c.closes.filter((x) => x.source === 'catchup').length).toBeGreaterThan(5);
    expect(await sim.waitForLedger(a.lcl + 2, 30_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    expect(b.forks).toEqual([]);
    await sim.shutdown();
  });

  it('reports stalled when its manual quorum cannot be reached, and recovers', async () => {
    const probe = new Simulation({ seed: 23 });
    const idA = (await probe.addNode({ name: 'A' })).nodeId;
    const idB = (await probe.addNode({ name: 'B' })).nodeId;
    await probe.shutdown();
    const sim = new Simulation({ seed: 23 });
    const quorum = { mode: 'manual' as const, qset: { threshold: 2, validators: [idA, idB], innerSets: [] } };
    const [a, b] = await sim.addNodes([{ name: 'A', quorum }, { name: 'B', quorum }]);
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    const states = collect(a.node!, 'state');
    sim.crashNode(b);
    expect(await sim.runUntil(() => a.state === 'stalled', 30_000)).toBe(true);
    expect(a.node!.getStatus().state).toBe('stalled');
    await sim.restartNode(b);
    expect(await sim.runUntil(() => a.state === 'synced' && b.state === 'synced' && a.lcl === b.lcl, 90_000)).toBe(true);
    expect(states.map((s) => s.state)).toContain('stalled');
    expect(await sim.waitForLedger(a.lcl + 2, 60_000)).toBe(true);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('restores its own SCP statements after a quick restart in the middle of a slot', async () => {
    const sim = new Simulation({ seed: 26, latency: [40, 120] });
    const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    const b = nodes[1];
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    // stop b while it is balloting
    const balloting = () => {
      const s = b.node!.getScpSlot();
      return s !== null && s.ballot !== null && s.phase !== 'EXTERNALIZE';
    };
    expect(await sim.runUntil(balloting, 60_000, 5)).toBe(true);
    const before = b.node!.getScpSlot()!;
    await sim.run(0);
    const saved = await b.storage.getMeta<{ slot: number; envelopes: string[] }>('scpState');
    expect(saved?.slot).toBe(before.slot);
    await sim.stopNode(b);
    await sim.startNode(b);
    expect(b.lcl).toBe(before.slot - 1);
    const after = b.node!.getScpSlot(before.slot)!;
    expect(after.ballot?.value.id).toBe(before.ballot!.value.id);
    expect(after.ballot!.counter).toBeGreaterThanOrEqual(before.ballot!.counter);
    expect(await sim.waitForLedger(before.slot + 3, 60_000)).toBe(true);
    expect(sim.historyConflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('keeps a member book across restarts (statuses and SCP confirmations); a resync clears it', async () => {
    const sim = new Simulation({ seed: 27 });
    const [a, b, c] = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(6, 60_000)).toBe(true);
    // b and c were seen at genesis, before any ledger closed
    expect([a.node!.quorum.memberSince(b.nodeId), a.node!.quorum.memberSince(c.nodeId)]).toEqual([1, 1]);
    // b and c confirmed the value a closed for its last ledger
    expect(a.node!.herder.confirmersOf(a.lcl).sort()).toEqual([b.nodeId, c.nodeId].sort());
    expect(a.node!.herder.confirmersOf(a.lcl + 5)).toEqual([]);
    // a validator that joins later is a member since it joined
    const d = await sim.addNode({ name: 'd' });
    const joinedAt = a.lcl;
    expect(await sim.waitForLedger(joinedAt + 3, 60_000)).toBe(true);
    expect(a.node!.quorum.memberSince(d.nodeId)).toBeGreaterThanOrEqual(joinedAt - 1);
    // the book survives a restart
    await sim.stopNode(a);
    await sim.restartNode(a);
    const saved = await a.storage.getMeta<{ nodeId: string; since: number }[]>(META_MEMBERS);
    expect(saved?.map((m) => m.nodeId).sort()).toEqual([b.nodeId, c.nodeId, d.nodeId].sort());
    expect(a.node!.quorum.memberSince(b.nodeId)).toBe(1);
    expect(a.node!.quorum.memberSince(d.nodeId)).toBeGreaterThanOrEqual(joinedAt - 1);
    expect(await sim.runUntil(() => a.state === 'synced' && a.lcl >= b.lcl - 1, 60_000)).toBe(true);
    // a resync starts the chain over, and the book with it
    let done = false;
    void c.node!.resync().then(() => {
      done = true;
    });
    expect(await sim.runUntil(() => done, 30_000)).toBe(true);
    expect((await c.storage.getMeta<unknown[]>(META_MEMBERS))?.length).toBe(0);
    const resyncedAt = b.lcl;
    expect(await sim.runUntil(() => c.state === 'synced' && c.lcl >= b.lcl - 1, 60_000)).toBe(true);
    expect(c.node!.quorum.memberSince(a.nodeId)).toBeGreaterThanOrEqual(resyncedAt - 1);
    expect(await sim.waitForLedger(b.lcl + 2, 60_000)).toBe(true);
    expect(sim.conflicts()).toEqual([]);
    await sim.shutdown();
  });

  it('emits peer events and builds peer and validator views', async () => {
    const sim = new Simulation({ seed: 24 });
    const [a] = await sim.addNodes([{ name: 'a' }]);
    const peersEv = collect(a.node!, 'peers');
    await sim.addNodes([{ name: 'b' }, { name: 'c' }]);
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    expect(peersEv.length).toBeGreaterThan(0);
    const peers = a.node!.getPeers();
    expect(peers.map((p) => p.name).sort()).toEqual(['b', 'c']);
    expect(peers.every((p) => p.state === 'synced' && p.validator && p.inMyQuorum && p.transports[0] === 'memory')).toBe(true);
    const vals = a.node!.getValidators();
    expect(vals.length).toBe(3);
    expect(vals.every((v) => v.active && v.inMyQuorum)).toBe(true);
    expect(vals.filter((v) => !v.isSelf).every((v) => v.qset !== null && v.qset.validators.length === 3)).toBe(true);
    expect(a.node!.getQuorumConfig()).toMatchObject({ intersection: 'ok', faultTolerance: 1 });
    await sim.shutdown();
  });
});
