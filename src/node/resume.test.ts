// A paused validator (frozen tab, sleeping laptop) must re-check sync and
// catch up before it votes again, and rejoin without a fork.

import { describe, expect, it } from 'vitest';
import type { Clock, TimerHandle } from '../lib/clock';
import { seededRng } from '../lib/random';
import type { Transport, TransportKind, TransportPeerId, WireMessage } from '../overlay/types';
import { qsetNodes } from '../scp/quorum';
import { SimNode, Simulation } from '../sim/simulation';
import { Node } from './node';
import { GapCheckTransport, GapClock } from './service';

/** A clock whose timers do not run while paused; on resume they run late, in due order. */
class PausableClock implements Clock {
  private paused = false;
  private nextId = 1;
  private readonly live = new Map<number, TimerHandle>();
  private deferred: { id: number; cb: () => void }[] = [];

  constructor(private readonly inner: Clock) {}

  now(): number {
    return this.inner.now();
  }

  setTimeout(cb: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.live.set(
      id,
      this.inner.setTimeout(() => {
        this.live.delete(id);
        if (this.paused) this.deferred.push({ id, cb });
        else cb();
      }, ms),
    );
    return id;
  }

  clearTimeout(id: TimerHandle): void {
    const h = this.live.get(id);
    if (h !== undefined) this.inner.clearTimeout(h);
    this.live.delete(id);
    this.deferred = this.deferred.filter((d) => d.id !== id);
  }

  pause(): void {
    this.paused = true;
  }

  /** Every timer that came due during the pause runs now, each in its own task. */
  resume(): void {
    this.paused = false;
    for (const d of this.deferred.splice(0)) {
      this.live.set(
        d.id,
        this.inner.setTimeout(() => {
          this.live.delete(d.id);
          d.cb();
        }, 0),
      );
    }
  }
}

/** Holds inbound traffic while paused (a frozen worker reads no messages). */
class PausableTransport implements Transport {
  onPeerUp: ((peer: TransportPeerId) => void) | null = null;
  onPeerDown: ((peer: TransportPeerId) => void) | null = null;
  onMessage: ((peer: TransportPeerId, msg: WireMessage) => void) | null = null;
  private paused = false;
  private held: (() => void)[] = [];

  constructor(private readonly inner: Transport) {}

  get kind(): TransportKind {
    return this.inner.kind;
  }

  start(): void | Promise<void> {
    this.inner.onPeerUp = (p) => this.deliver(() => this.onPeerUp?.(p));
    this.inner.onPeerDown = (p) => this.deliver(() => this.onPeerDown?.(p));
    this.inner.onMessage = (p, m) => this.deliver(() => this.onMessage?.(p, m));
    return this.inner.start();
  }

  stop(): void {
    this.inner.onPeerUp = this.inner.onPeerDown = this.inner.onMessage = null;
    this.inner.stop();
  }

  send(peer: TransportPeerId, msg: WireMessage): void {
    this.inner.send(peer, msg);
  }

  broadcast(msg: WireMessage): void {
    this.inner.broadcast(msg);
  }

  peers(): TransportPeerId[] {
    return this.inner.peers();
  }

  private deliver(fn: () => void): void {
    if (this.paused) this.held.push(fn);
    else fn();
  }

  pause(): void {
    this.paused = true;
  }

  /** Deliver what arrived during the pause, after `clock`'s already queued tasks. */
  resume(clock: Clock): void {
    this.paused = false;
    const held = this.held.splice(0);
    clock.setTimeout(() => {
      for (const fn of held) fn();
    }, 0);
  }
}

interface Pausable {
  sn: SimNode;
  node: Node;
  clock: PausableClock;
  transport: PausableTransport;
  /** Our SCP envelopes: when, for which slot, and our LCL at that moment. */
  out: { at: number; slot: number; lcl: number }[];
}

/** A validator like the simulation's, with a pausable clock and transport. */
async function addPausable(sim: Simulation, name: string, gapHook: boolean): Promise<Pausable> {
  const sn = new SimNode(sim.options.seed, { name });
  sim.nodes.push(sn);
  const clock = new PausableClock(sim.clock);
  const gap = new GapClock(clock);
  const transport = new PausableTransport(sim.net.createTransport(name));
  const node = new Node({
    // as in the worker: inbound traffic checks for a pause first
    transports: [gapHook ? new GapCheckTransport(transport, gap) : transport],
    storage: sn.storage,
    clock: gap,
    logSink: sim.logSink,
    networkName: sim.networkName,
    secret: sn.secret,
    name,
    rng: seededRng(sim.options.seed * 1000 + 7),
  });
  if (gapHook) gap.onGap = (ms) => node.onResume(`timers ran ${Math.round(ms / 1000)} s late`);
  sn.node = node;
  sn.generation = 1;
  const out: Pausable['out'] = [];
  node.events.on('scpEnvelope', (e) => {
    if (e.direction === 'out') out.push({ at: sim.clock.now(), slot: e.slot, lcl: node.ledger.lastClosed().header.ledgerSeq });
  });
  node.events.on('ledgerClosed', (e) => {
    const seq = e.stored.seq;
    for (const k of [...sn.chain.keys()]) if (k >= seq) sn.chain.delete(k);
    sn.chain.set(seq, e.stored.hash);
    sn.closes.push({ seq, hash: e.stored.hash, source: e.source, at: sim.clock.now(), externalizedBy: e.stored.externalizedBy });
  });
  node.events.on('ledgerReset', (e) => {
    for (const k of [...sn.chain.keys()]) if (k > e.lclSeq) sn.chain.delete(k);
    sn.chain.set(e.lclSeq, node.ledger.lastClosed().hash);
  });
  node.events.on('fork', (f) => sn.forks.push(f));
  node.events.on('state', (e) => sn.states.push({ state: e.state, at: sim.clock.now() }));
  await node.start();
  sn.chain.set(1, node.ledger.lastClosed().hash);
  return { sn, node, clock, transport, out };
}

async function pauseScenario(seed: number, gapHook: boolean, messagesFirst = false) {
  const sim = new Simulation({ seed, latency: [10, 40] });
  const [a, b] = await sim.addNodes([{ name: 'a' }, { name: 'b' }]);
  const c = await addPausable(sim, 'c', gapHook);
  expect(await sim.runUntil(() => sim.nodes.every((n) => n.state === 'synced' && n.lcl >= 6), 90_000)).toBe(true);
  expect(qsetNodes(a.node!.herder.scp.getLocalQuorumSet())).toContain(c.sn.nodeId);
  expect(qsetNodes(c.node.herder.scp.getLocalQuorumSet())).toHaveLength(3);

  // freeze c for 40 s: a and b drop it from their quorum sets and go on
  const pausedLcl = c.sn.lcl;
  c.clock.pause();
  c.transport.pause();
  await sim.run(40_000);
  expect(a.lcl).toBeGreaterThan(pausedLcl + 4);
  expect(qsetNodes(a.node!.herder.scp.getLocalQuorumSet())).not.toContain(c.sn.nodeId);
  expect(c.sn.lcl).toBe(pausedLcl);

  const networkLcl = Math.max(a.lcl, b.lcl);
  const resumedAt = sim.clock.now();
  const outBefore = c.out.length;
  if (messagesFirst) {
    c.transport.resume(sim.clock);
    c.clock.resume();
  } else {
    c.clock.resume();
    c.transport.resume(sim.clock);
  }
  await sim.runUntil(() => c.node.state === 'synced' && c.sn.lcl >= a.lcl - 1, 60_000);
  await sim.run(30_000);
  return { sim, a, b, c, pausedLcl, networkLcl, resumedAt, outAfter: c.out.slice(outBefore) };
}

type Scenario = Awaited<ReturnType<typeof pauseScenario>>;

/** Caught up before voting, then back in consensus, with one chain everywhere. */
function expectCleanRejoin({ sim, a, b, c, pausedLcl, networkLcl, resumedAt, outAfter }: Scenario): void {
  // it caught up from peers instead of closing the stale slot by itself
  const after = c.sn.closes.filter((x) => x.at >= resumedAt);
  expect(after.filter((x) => x.source === 'catchup').length).toBeGreaterThanOrEqual(networkLcl - pausedLcl - 1);
  expect(after.filter((x) => x.source === 'consensus' && x.seq < networkLcl)).toEqual([]);
  // no statement for a slot decided while it slept, and none before its LCL was
  // within one ledger of the network (then SCP may finish that last slot)
  expect(outAfter.length).toBeGreaterThan(0);
  for (const o of outAfter) {
    expect(o.slot).toBeGreaterThanOrEqual(networkLcl);
    expect(o.lcl).toBeGreaterThanOrEqual(networkLcl - 1);
  }
  // safe and live: one chain everywhere, no fork, back in everyone's quorum
  expect(sim.conflicts()).toEqual([]);
  expect(sim.historyConflicts()).toEqual([]);
  for (const n of [a, b, c.sn]) expect(n.forks).toEqual([]);
  expect(c.node.state).toBe('synced');
  expect(Math.abs(c.sn.lcl - a.lcl)).toBeLessThanOrEqual(1);
  expect(c.sn.lcl).toBeGreaterThan(networkLcl + 2);
  expect(qsetNodes(a.node!.herder.scp.getLocalQuorumSet())).toContain(c.sn.nodeId);
  expect(c.sn.consensusCloses().some((x) => x.at > resumedAt)).toBe(true);
}

describe('Node.onResume after a pause', () => {
  it('stops voting, catches up first, then rejoins without a fork (late timers run first)', async () => {
    for (const seed of [71, 73, 75]) {
      const s = await pauseScenario(seed, true);
      // the first late timer told the node to re-check sync
      expect(s.c.sn.states.some((x) => x.at === s.resumedAt && x.state === 'booting')).toBe(true);
      expectCleanRejoin(s);
      await s.sim.shutdown();
    }
  });

  it('is just as safe when the held messages are read before the late timers', async () => {
    for (const seed of [72, 74, 76]) {
      const s = await pauseScenario(seed, true, true);
      expect(s.c.sn.states.some((x) => x.at === s.resumedAt && x.state === 'booting')).toBe(true);
      expectCleanRejoin(s);
      await s.sim.shutdown();
    }
  });

  it('control: without the re-check, the woken node votes on stale state and forks', async () => {
    const { sim, c, pausedLcl, networkLcl, outAfter } = await pauseScenario(71, false);
    // late timers dropped every peer from its quorum set, so it decided the old slot alone
    expect(outAfter.some((o) => o.slot <= networkLcl - 1 && o.lcl === pausedLcl)).toBe(true);
    expect(sim.historyConflicts().length).toBeGreaterThan(0);
    expect(c.sn.forks.map((f) => f.resolution)).toContain('rolled-back');
    await sim.shutdown();
  });
});
