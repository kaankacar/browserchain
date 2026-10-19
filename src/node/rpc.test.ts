// Client <-> worker RPC over a Node MessageChannel (no real Worker).

import { Keypair } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { Logger } from '../lib/log';
import type { BroadcastChannelLike } from '../overlay/broadcastTransport';
import type { NodeApi, NodeEvent, NodeStatus } from './api';
import { WorkerNodeClient, type WorkerEndpoint } from './client';
import {
  RemoteError,
  RpcServer,
  deserializeError,
  parseFromWorker,
  parseToWorker,
  serializeError,
  type InitParams,
} from './rpc';
import { WorkerHost, defaultStorage, storageName } from './worker';
import { FallbackStorage } from './fallbackStorage';
import { MemoryStorage } from '../storage/memoryStorage';

const open: MessagePort[] = [];
afterEach(() => {
  for (const p of open.splice(0)) p.close();
});

function channel(): { client: MessagePort; worker: MessagePort } {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  return { client: port1, worker: port2 };
}

/** Wait for real message delivery. */
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await tick();
  }
}

/** An RPC server on the worker end of a channel, answering with `api`. */
function serve(port: MessagePort, api: () => Promise<NodeApi> | NodeApi): RpcServer {
  const server = new RpcServer({ post: (m) => port.postMessage(m), api });
  port.addEventListener('message', (ev) => {
    const msg = parseToWorker(ev.data);
    if (msg) server.handle(msg);
  });
  port.start();
  return server;
}

class CodedError extends Error {
  code = 'txBAD_SEQ';
}

/** A NodeApi stub: only what the tests call. */
function fakeApi(): NodeApi {
  const status = { state: 'synced', lcl: { seq: 7 } } as unknown as NodeStatus;
  return {
    getStatus: async () => status,
    getLedgers: async (o: { limit: number; beforeSeq?: number }) => Array.from({ length: o.limit }, (_, i) => ({ seq: (o.beforeSeq ?? 100) - 1 - i })),
    getAccount: async (id: string) => (id === 'missing' ? null : { accountId: id }),
    setName: async (name: string) => {
      if (!name.trim()) throw new Error('name must not be empty');
    },
    resync: async () => {
      throw new CodedError('bad sequence');
    },
    getStats: async () => ({ fn: () => 1 }),
    getLogs: () => new Promise(() => undefined),
  } as unknown as NodeApi;
}

describe('RPC messages', () => {
  it('serializes errors and validates messages', () => {
    const e = serializeError(new CodedError('boom'));
    expect(e).toMatchObject({ name: 'Error', message: 'boom', code: 'txBAD_SEQ' });
    expect(structuredClone(e)).toEqual(e);
    expect(serializeError('plain')).toEqual({ name: 'Error', message: 'plain' });
    expect(serializeError({ any: 1 })).toEqual({ name: 'Error', message: '{"any":1}' });
    const back = deserializeError(e);
    expect(back).toBeInstanceOf(RemoteError);
    expect(back.message).toBe('boom');
    expect(back.code).toBe('txBAD_SEQ');
    expect(deserializeError(null).message).toBe('unknown worker error');

    const params: InitParams = { network: 'main', slot: 3, fresh: false, transport: 'both', name: 'tab' };
    expect(parseToWorker({ type: 'init', params, port: null })).toEqual({ type: 'init', params, port: null });
    expect(parseToWorker({ type: 'init', params: { ...params, transport: 'carrier-pigeon' }, port: null })).toBeNull();
    expect(parseToWorker({ type: 'init', params: { ...params, slot: -1 }, port: null })).toBeNull();
    expect(parseToWorker({ type: 'init', params: { ...params, network: '' }, port: null })).toBeNull();
    expect(parseToWorker({ type: 'call', id: 1, method: 'getStatus', args: [] })).toMatchObject({ type: 'call', id: 1 });
    expect(parseToWorker({ type: 'call', id: 1.5, method: 'getStatus', args: [] })).toBeNull();
    expect(parseToWorker({ type: 'lifecycle', event: 'resume' })).toEqual({ type: 'lifecycle', event: 'resume' });
    expect(parseToWorker({ type: 'lifecycle', event: 'nap' })).toBeNull();
    expect(parseToWorker('junk')).toBeNull();
    expect(parseFromWorker({ type: 'result', id: 2, ok: false, error: 'x' })).toEqual({ type: 'result', id: 2, ok: false, error: { name: 'Error', message: 'unknown worker error' } });
    expect(parseFromWorker({ type: 'ready', info: {} })).toBeNull();
    expect(parseFromWorker({ type: 'event', event: { type: 'log', entry: {} } })).toMatchObject({ type: 'event' });
    expect(parseFromWorker(null)).toBeNull();
  });
});

describe('WorkerNodeClient with an RPC server', () => {
  it('runs calls, returns values and remote errors, and rejects unknown methods', async () => {
    const ch = channel();
    serve(ch.worker, fakeApi);
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint);
    expect(await client.getStatus()).toMatchObject({ state: 'synced', lcl: { seq: 7 } });
    expect((await client.getLedgers({ limit: 3, beforeSeq: 10 })).map((l) => l.seq)).toEqual([9, 8, 7]);
    expect(await client.getAccount('missing')).toBeNull();
    expect(await client.getAccount('GABC')).toEqual({ accountId: 'GABC' });
    // concurrent calls each get their own answer
    const many = await Promise.all([1, 2, 3, 4, 5].map((n) => client.getLedgers({ limit: n })));
    expect(many.map((r) => r.length)).toEqual([1, 2, 3, 4, 5]);
    await expect(client.setName('  ')).rejects.toThrow('name must not be empty');
    const err = await client.resync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err).toMatchObject({ message: 'bad sequence', code: 'txBAD_SEQ' });
    // a method the API lacks, a value that cannot be cloned
    await expect(client.getPeers()).rejects.toThrow();
    await expect(client.getStats()).rejects.toThrow(/cannot be sent/);
    // the server refuses names outside the NodeApi
    ch.client.postMessage({ type: 'call', id: 999, method: 'constructor', args: [] });
    const answers: unknown[] = [];
    ch.client.addEventListener('message', (ev) => answers.push(ev.data));
    await until(() => answers.length > 0);
    expect(answers[0]).toMatchObject({ type: 'result', id: 999, ok: false, error: { message: 'unknown method: constructor' } });
  });

  it('a call whose arguments cannot be sent fails alone; the client stays alive', async () => {
    const ch = channel();
    serve(ch.worker, fakeApi);
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint);
    const fatal: Error[] = [];
    client.onFatal((e) => fatal.push(e));
    await expect(client.getAccount((() => 'G') as unknown as string)).rejects.toThrow(/getAccount: arguments cannot be sent/);
    expect(client.deathCause).toBeNull();
    expect(fatal).toEqual([]);
    expect(await client.getStatus()).toMatchObject({ state: 'synced' });
  });

  it('times out a call that gets no answer', async () => {
    const ch = channel();
    serve(ch.worker, fakeApi);
    const clock = new VirtualClock();
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint, { clock });
    const pending = client.getLogs(10);
    let settled: unknown = null;
    pending.catch((e: unknown) => (settled = e));
    await tick(20);
    await clock.advance(29_000);
    expect(settled).toBeNull();
    await clock.advance(1_000);
    expect(String(settled)).toMatch(/getLogs timed out after 30 s/);
  });

  it('fans the event stream out to every subscriber', async () => {
    const ch = channel();
    const server = serve(ch.worker, fakeApi);
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint);
    const a: NodeEvent[] = [];
    const b: NodeEvent[] = [];
    const offA = client.subscribe((ev) => a.push(ev));
    client.subscribe((ev) => b.push(ev));
    client.subscribe(() => {
      throw new Error('a broken subscriber');
    });
    const log: NodeEvent = { type: 'log', entry: { ts: 1, level: 'info', scope: 'x', msg: 'hello' } };
    server.event(log);
    server.event({ type: 'txStatus', hash: 'ab', status: 'applied', ledgerSeq: 4 });
    await until(() => b.length === 2);
    expect(a).toEqual(b);
    expect(b[0]).toEqual(log);
    offA();
    server.event(log);
    await until(() => b.length === 3);
    expect(a.length).toBe(2);
  });

  it('rejects pending and later calls when the worker reports a fatal error', async () => {
    const ch = channel();
    let release!: (api: NodeApi) => void;
    const server = serve(ch.worker, () => new Promise<NodeApi>((r) => (release = r)));
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint);
    const fatal: Error[] = [];
    client.onFatal((e) => fatal.push(e));
    const pending = client.getStatus();
    const readyErr = client.ready.catch((e: unknown) => e);
    await tick(10);
    server.fatal(new Error('IndexedDB could not be opened'));
    await expect(pending).rejects.toThrow('getStatus failed: IndexedDB could not be opened');
    expect(String(await readyErr)).toMatch(/IndexedDB could not be opened/);
    expect(fatal.map((e) => e.message)).toEqual(['IndexedDB could not be opened']);
    expect(client.deathCause?.message).toBe('IndexedDB could not be opened');
    await expect(client.getStatus()).rejects.toThrow(/IndexedDB could not be opened/);
    // a late subscriber to onFatal still hears about it
    const late = await new Promise<Error>((r) => client.onFatal(r));
    expect(late.message).toBe('IndexedDB could not be opened');
    release(fakeApi());
  });

  it('notices a closed port, an error before ready, and terminate()', async () => {
    const ch = channel();
    serve(ch.worker, () => new Promise<NodeApi>(() => undefined));
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint);
    const pending = client.getStatus();
    await tick(10);
    ch.worker.close();
    await expect(pending).rejects.toThrow(/connection closed/);
    await expect(client.ready).rejects.toThrow(/connection closed/);

    // a Worker whose script failed to load fires 'error' before 'ready'
    const listeners = new Map<string, (ev: Event) => void>();
    let terminated = 0;
    const fakeWorker: WorkerEndpoint = {
      postMessage: () => undefined,
      addEventListener: (t, l) => listeners.set(t, l),
      removeEventListener: (t) => listeners.delete(t),
      terminate: () => terminated++,
    };
    const c2 = new WorkerNodeClient(fakeWorker);
    const p2 = c2.getAccount('G');
    listeners.get('error')!({ message: 'SyntaxError: bad import', filename: 'worker.js', lineno: 3 } as unknown as Event);
    await expect(p2).rejects.toThrow(/failed to start: SyntaxError: bad import \(worker.js:3\)/);
    expect(listeners.size).toBe(0);
    // a script that could not be fetched: an error event without a message
    const c4 = new WorkerNodeClient(fakeWorker);
    listeners.get('error')!(new Event('error'));
    await expect(c4.ready).rejects.toThrow('node worker failed to start: its script could not be loaded');

    const c3 = new WorkerNodeClient({ ...fakeWorker, addEventListener: () => undefined, removeEventListener: () => undefined });
    const p3 = c3.getStatus();
    c3.terminate('page closed');
    await expect(p3).rejects.toThrow('getStatus failed: page closed');
    expect(terminated).toBe(1);
  });
});

// ---------------------------------------------------------------- the worker host

/** An in-memory BroadcastChannel bus (one tab's worker, no peers). */
class Bus {
  readonly frames: Record<string, unknown>[] = [];
  readonly channels = new Set<BroadcastChannelLike>();
  factory = (): BroadcastChannelLike => {
    const ch: BroadcastChannelLike = {
      onmessage: null,
      postMessage: (m: unknown) => {
        this.frames.push(m as Record<string, unknown>);
        for (const other of this.channels) if (other !== ch) queueMicrotask(() => other.onmessage?.({ data: structuredClone(m) } as MessageEvent));
      },
      close: () => {
        this.channels.delete(ch);
      },
    };
    this.channels.add(ch);
    return ch;
  };
}

describe('WorkerHost over a MessageChannel', () => {
  it('starts a fresh node, answers calls, streams events, takes the bridge port and says bye on pagehide', async () => {
    const ch = channel();
    const clock = new VirtualClock();
    const bus = new Bus();
    const host = new WorkerHost((m) => ch.worker.postMessage(m), { clock, channelFactory: bus.factory, logLevel: 'info' });
    ch.worker.addEventListener('message', (ev) => host.handleMessage(ev.data));
    ch.worker.start();
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint);
    const events: NodeEvent[] = [];
    client.subscribe((ev) => events.push(ev));

    // a call before init waits for the node
    const early = client.getStatus();
    const bridge = new MessageChannel();
    open.push(bridge.port1, bridge.port2);
    const fromBridge: unknown[] = [];
    bridge.port1.addEventListener('message', (ev) => fromBridge.push(ev.data));
    bridge.port1.start();
    client.init({ network: 'rpc-test', slot: null, fresh: true, transport: 'both', name: 'worker-tab' }, bridge.port2);
    const info = await client.ready;
    expect(info).toMatchObject({ name: 'worker-tab', network: 'rpc-test', slot: null, storage: 'memory' });
    expect((await early).state).toBe('booting');
    // the transferred port reached the worker's BridgeTransport
    await until(() => fromBridge.some((m) => (m as { type?: string }).type === 'ready'));
    expect(bus.frames.some((f) => f.kind === 'join')).toBe(true);

    // solo: synced after 4 s, then ledgers close every 5 s
    for (let i = 0; i < 30 && host.currentNode!.ledger.lastClosed().header.ledgerSeq < 3; i++) await clock.advance(1000);
    const status = await client.getStatus();
    expect(status).toMatchObject({ state: 'synced', name: 'worker-tab', networkName: 'rpc-test' });
    const user = Keypair.random().publicKey();
    const fb = await client.friendbot(user);
    expect(fb.status).toBe('PENDING');
    for (let i = 0; i < 20 && !events.some((e) => e.type === 'txStatus' && e.hash === fb.hash && e.status === 'applied'); i++) {
      await clock.advance(500);
      await tick(1);
    }
    await until(() => events.some((e) => e.type === 'txStatus' && e.hash === fb.hash && e.status === 'applied'));
    expect((await client.getTransaction(fb.hash))?.successful).toBe(true);
    expect((await client.getAccount(user))?.balances[0].balance).toBe('10000.0000000');
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['status', 'ledgerClosed', 'scp', 'slot', 'txStatus', 'log']));
    await expect(client.setQuorumConfig({ mode: 'manual', qset: { threshold: 9, validators: [], innerSets: [] } })).rejects.toThrow(/invalid quorum set/);

    // lifecycle: resume re-checks sync, pagehide sends bye at once and stops
    client.lifecycle('resume');
    await until(() => host.currentNode!.state === 'booting');
    const before = bus.frames.length;
    client.lifecycle('pagehide');
    await until(() => host.currentNode!.state === 'stopped');
    // no peers here, so no links to say bye on; the transport still says 'leave'
    expect(bus.frames.slice(before).map((f) => f.kind)).toContain('leave');
    expect(fromBridge.some((m) => (m as { type?: string }).type === 'stopped')).toBe(true);
    expect((await client.getStatus()).state).toBe('stopped');

    // back from the back/forward cache: the same identity starts again
    client.lifecycle('pageshow-persisted');
    await until(() => host.currentNode?.state === 'booting' && host.currentNode.isRunning);
    expect(host.currentNode!.nodeId).toBe(status.nodeId);
    expect((await client.getStatus()).nodeId).toBe(status.nodeId);
    await client.ready;
    client.lifecycle('pagehide');
    await until(() => host.currentNode!.state === 'stopped');
  });

  it('sends the bye synchronously when the page hides, and the peer drops us at once', async () => {
    const clock = new VirtualClock();
    const bus = new Bus();
    const hosts = [0, 1].map(() => new WorkerHost(() => undefined, { clock, channelFactory: bus.factory }));
    hosts.forEach((h, i) => h.handleMessage({ type: 'init', params: { network: 'bye-test', slot: null, fresh: true, transport: 'broadcast', name: `tab${i}` }, port: null }));
    await until(() => hosts.every((h) => h.currentService !== null));
    const [a, b] = hosts.map((h) => h.currentNode!);
    for (let i = 0; i < 40 && !(a.state === 'synced' && b.state === 'synced' && a.getPeers().length === 1); i++) {
      await clock.advance(500);
      await tick(1);
    }
    expect(b.getPeers().map((p) => p.nodeId)).toEqual([a.nodeId]);
    const from = bus.frames.length;
    hosts[0].handleMessage({ type: 'lifecycle', event: 'pagehide' });
    // before anything else runs: the overlay bye, then the transport's leave
    const sent = bus.frames.slice(from);
    const byeAt = sent.findIndex((f) => f.kind === 'msg' && (f.msg as { t?: string }).t === 'bye' && (f.msg as { nodeId?: string }).nodeId === a.nodeId);
    expect(byeAt).toBeGreaterThanOrEqual(0);
    expect(sent.findIndex((f) => f.kind === 'leave')).toBeGreaterThan(byeAt);
    await tick(5);
    expect(b.getPeers()).toEqual([]);
    expect(b.quorum.isGone(a.nodeId)).toBe(true);
    await until(() => a.state === 'stopped');
    hosts[1].handleMessage({ type: 'lifecycle', event: 'pagehide' });
    await until(() => b.state === 'stopped');
  });

  it('restart cycles (pagehide, then back from the bfcache) leave one subscription and one event stream', async () => {
    const ch = channel();
    const clock = new VirtualClock();
    const host = new WorkerHost((m) => ch.worker.postMessage(m), { clock, channelFactory: new Bus().factory });
    ch.worker.addEventListener('message', (ev) => host.handleMessage(ev.data));
    ch.worker.start();
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint);
    const events: NodeEvent[] = [];
    client.subscribe((ev) => events.push(ev));
    client.init({ network: 'cycle-test', slot: null, fresh: true, transport: 'broadcast' });
    await client.ready;
    const nodes = new Set([host.currentNode]);
    for (let i = 0; i < 5; i++) {
      client.lifecycle('pagehide');
      await until(() => host.currentNode!.state === 'stopped');
      client.lifecycle('pageshow-persisted');
      await until(() => host.currentNode?.isRunning === true);
      nodes.add(host.currentNode);
    }
    expect(nodes.size).toBe(6);
    // one log line reaches the page once, not once per node generation
    await tick(20);
    events.length = 0;
    new Logger(host.logSink, 'probe').info('one line');
    await until(() => events.some((e) => e.type === 'log' && e.entry.msg === 'one line'));
    await tick(20);
    expect(events.filter((e) => e.type === 'log' && e.entry.msg === 'one line')).toHaveLength(1);
    client.lifecycle('pagehide');
    await until(() => host.currentNode!.state === 'stopped');
  });

  it('posts fatal when the node cannot start, and picks storage per slot', async () => {
    const ch = channel();
    const broken = new MemoryStorage();
    broken.open = async () => {
      throw new Error('disk on fire');
    };
    const host = new WorkerHost((m) => ch.worker.postMessage(m), { clock: new VirtualClock(), channelFactory: new Bus().factory, storage: () => broken });
    ch.worker.addEventListener('message', (ev) => host.handleMessage(ev.data));
    ch.worker.start();
    const client = new WorkerNodeClient(ch.client as unknown as WorkerEndpoint);
    const pending = client.getStatus();
    client.init({ network: 'rpc-test', slot: 0, fresh: false, transport: 'broadcast' });
    await expect(client.ready).rejects.toThrow('disk on fire');
    await expect(pending).rejects.toThrow('disk on fire');
    // the client stops calling a dead worker; a raw call still gets an answer, not a hang
    const raw: { id?: number; ok?: boolean; error?: { message: string } }[] = [];
    ch.client.addEventListener('message', (ev) => raw.push(ev.data));
    ch.client.postMessage({ type: 'call', id: 77, method: 'getStatus', args: [] });
    await until(() => raw.some((m) => m.id === 77));
    expect(raw.find((m) => m.id === 77)).toMatchObject({ ok: false, error: { message: 'disk on fire' } });

    expect(storageName('main', 3)).toBe('browserchain:main:slot:3');
    expect(defaultStorage({ network: 'main', slot: 3, fresh: false, transport: 'both' }, () => undefined)).toBeInstanceOf(FallbackStorage);
    expect(defaultStorage({ network: 'main', slot: null, fresh: true, transport: 'both' }, () => undefined)).toBeInstanceOf(MemoryStorage);
  });
});
