import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { ZERO_HASH, toBase64, utf8 } from '../lib/bytes';
import { VirtualClock } from '../lib/clock';
import { APP_VERSION, PEER_TIMEOUT_MS, STATUS_INTERVAL_MS } from '../lib/constants';
import { sha256, sha256Hex } from '../lib/hash';
import { LogSink, Logger } from '../lib/log';
import { MemoryNetwork, type MemoryTransport } from './memoryNetwork';
import { Overlay, OverlayRequestError, type OverlayOptions } from './overlay';
import type {
  NodeAnnouncement,
  OverlayHandlers,
  PeerInfo,
  RequestBody,
  ResponseBody,
  Transport,
  TransportKind,
  WireMessage,
} from './types';
import { signAnnouncement } from './wire';

const NETWORK_ID = sha256Hex('BrowserChain overlay tests');
const LATENCY = 10;

function keypair(i: number): Keypair {
  return Keypair.fromRawEd25519Seed(sha256(`overlay-test-node-${i}`));
}

function xdrOf(n: number | string, pad = 0): string {
  return toBase64(utf8(`stellar-message-${n}${'.'.repeat(pad)}`));
}

type RequestHandler = OverlayHandlers['onRequest'];

interface TestNode {
  name: string;
  kp: Keypair;
  overlay: Overlay;
  transports: MemoryTransport[];
  received: { xdr: string; from: string }[];
  events: string[];
  logs: LogSink;
  /** Replaceable request handler. */
  onRequest: RequestHandler;
  /** Return value of onStellarMessage. */
  stellarResult: boolean | undefined;
  /** Frames sent, per transport index. */
  sent: { via: number; to: string; msg: WireMessage }[];
}

interface AddOpts {
  /** Indexes of the networks to join (default [0]). */
  nets?: number[];
  kinds?: TransportKind[];
  overlay?: Partial<OverlayOptions>;
}

const headersHandler: RequestHandler = (body) =>
  body.kind === 'headers'
    ? { kind: 'headers', items: [{ seq: body.from, headerXdr: `hdr-${body.from}` }] }
    : null;

class World {
  readonly clock = new VirtualClock(1_790_000_000_000);
  readonly nets: MemoryNetwork[];
  readonly nodes: TestNode[] = [];
  private readonly names = new Map<string, string>();

  constructor(networks = 1, seed = 1) {
    this.nets = Array.from(
      { length: networks },
      (_, i) => new MemoryNetwork({ clock: this.clock, seed: seed + i, latencyMs: () => LATENCY }),
    );
  }

  add(i: number, opts: AddOpts = {}): TestNode {
    const kp = keypair(i);
    const name = `n${i}`;
    this.names.set(kp.publicKey(), name);
    const nets = opts.nets ?? [0];
    const transports = nets.map((n, k) => this.nets[n].createTransport(name, { kind: opts.kinds?.[k] }));
    const logs = new LogSink(this.clock, 'debug');
    const node: TestNode = {
      name,
      kp,
      transports,
      received: [],
      events: [],
      logs,
      onRequest: headersHandler,
      stellarResult: undefined,
      sent: [],
      overlay: null as unknown as Overlay,
    };
    transports.forEach((t, via) => {
      const send = t.send.bind(t);
      t.send = (peer, msg) => {
        node.sent.push({ via, to: peer, msg });
        send(peer, msg);
      };
    });
    const label = (p: PeerInfo) => this.names.get(p.nodeId) ?? p.nodeId.slice(0, 6);
    node.overlay = new Overlay({
      keypair: kp,
      networkId: NETWORK_ID,
      name,
      clock: this.clock,
      logger: new Logger(logs, name),
      transports,
      handlers: {
        onStellarMessage: (xdr, from) => {
          node.received.push({ xdr, from: label(from) });
          return node.stellarResult as undefined;
        },
        onRequest: (body, from) => node.onRequest(body, from),
        onPeerConnected: (p) => node.events.push(`connected:${label(p)}`),
        onPeerDisconnected: (p) => node.events.push(`disconnected:${label(p)}`),
        onPeerStatus: (p) => node.events.push(`status:${label(p)}:${p.ann.lcl.seq}`),
      },
      ...opts.overlay,
    });
    this.nodes.push(node);
    return node;
  }

  startAll(): void {
    for (const n of this.nodes) n.overlay.start();
  }

  /** A raw endpoint driven by the test (not an overlay). */
  raw(id: string, net = 0): { t: MemoryTransport; got: { from: string; msg: WireMessage }[] } {
    const t = this.nets[net].createTransport(id);
    const got: { from: string; msg: WireMessage }[] = [];
    t.onMessage = (from, msg) => got.push({ from, msg });
    t.start();
    return { t, got };
  }

  announce(kp: Keypair, over: Partial<NodeAnnouncement> = {}, t: 'hello' | 'status' = 'hello'): WireMessage {
    const ann: NodeAnnouncement = {
      nodeId: kp.publicKey(),
      name: 'raw',
      networkId: NETWORK_ID,
      appVersion: APP_VERSION,
      lcl: { seq: 1, hash: ZERO_HASH },
      state: 'synced',
      validator: true,
      qsetHash: '',
      quorumMode: 'auto',
      ts: this.clock.now(),
      ...over,
    };
    const sig = signAnnouncement(kp, ann);
    return t === 'hello' ? { t, ann, sig, nonce: '00'.repeat(16) } : { t, ann, sig };
  }

  settle(ms = 50): Promise<void> {
    return this.clock.advance(ms);
  }
}

/** Peer names, sorted (peers() itself is sorted by node id). */
function peerNames(w: World, n: TestNode): string[] {
  return n.overlay
    .peers()
    .map((p) => w.nodes.find((x) => x.kp.publicKey() === p.nodeId)?.name ?? 'raw')
    .sort();
}

function stellarSent(n: TestNode, via?: number): number {
  return n.sent.filter((s) => s.msg.t === 'stellar' && (via === undefined || s.via === via)).length;
}

async function expectRejects(p: Promise<unknown>, code: string, text?: RegExp): Promise<OverlayRequestError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(OverlayRequestError);
    expect((err as OverlayRequestError).code).toBe(code);
    if (text) expect((err as Error).message).toMatch(text);
    return err as OverlayRequestError;
  }
  throw new Error('expected a rejection');
}

describe('Overlay: binding', () => {
  it('binds two nodes after hello', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    w.startAll();
    await w.settle();
    const peers = a.overlay.peers();
    expect(peers).toHaveLength(1);
    expect(peers[0].nodeId).toBe(b.kp.publicKey());
    expect(peers[0].name).toBe('n1');
    expect(peers[0].transports).toEqual(['memory']);
    expect(peers[0].ann.networkId).toBe(NETWORK_ID);
    expect(peers[0].latencyMs).toBeNull();
    expect(a.events).toEqual(['connected:n1']);
    expect(b.events).toEqual(['connected:n0']);
    expect(a.overlay.isConnected(b.kp.publicKey())).toBe(true);
    expect(a.overlay.getPeer(b.kp.publicKey())?.name).toBe('n1');
    // A normal link-up costs one hello each way and nothing more.
    expect(a.sent.map((s) => s.msg.t)).toEqual(['hello']);
    expect(b.sent.map((s) => s.msg.t)).toEqual(['hello']);
  });

  it('answers a repeated hello on a bound link with a status', async () => {
    const w = new World();
    const a = w.add(0);
    a.overlay.start();
    const raw = w.raw('raw');
    await w.settle();
    const kp = keypair(55);
    raw.t.send('n0', w.announce(kp));
    await w.settle();
    expect(raw.got.map((g) => g.msg.t)).toEqual(['hello']);
    await w.settle(10);
    raw.t.send('n0', w.announce(kp));
    await w.settle();
    expect(raw.got.map((g) => g.msg.t)).toEqual(['hello', 'status']);
    const status = raw.got[1].msg as { ann: NodeAnnouncement };
    expect(status.ann.nodeId).toBe(a.kp.publicKey());
  });

  it('builds a full mesh of 6 nodes', async () => {
    const w = new World();
    for (let i = 0; i < 6; i++) w.add(i);
    w.startAll();
    await w.settle();
    for (const n of w.nodes) {
      expect(n.overlay.peers()).toHaveLength(5);
      expect(n.events.filter((e) => e.startsWith('connected'))).toHaveLength(5);
    }
  });

  it('rejects bad signatures, other networks, other versions and our own id', async () => {
    const w = new World();
    const a = w.add(0);
    a.overlay.start();
    const raw = w.raw('raw');
    await w.settle();
    const evil = keypair(99);
    const tampered = w.announce(evil) as { ann: NodeAnnouncement };
    tampered.ann.name = 'tampered';
    raw.t.send('n0', tampered as WireMessage);
    raw.t.send('n0', w.announce(evil, { networkId: sha256Hex('another network') }));
    raw.t.send('n0', w.announce(evil, { appVersion: APP_VERSION + 1 }));
    raw.t.send('n0', w.announce(a.kp));
    raw.t.send('n0', { t: 'hello', ann: { nodeId: 'x' }, sig: 'zz' } as unknown as WireMessage);
    raw.t.send('n0', w.announce(evil, { lcl: { seq: 1, hash: 'ABC' } }));
    await w.settle();
    expect(a.overlay.peers()).toEqual([]);
    expect(a.overlay.stats().badAnnouncements).toBe(3);
    expect(a.overlay.stats().invalid).toBe(2);
    // Messages from an unbound link are dropped.
    raw.t.send('n0', { t: 'stellar', xdr: xdrOf(1), flood: true });
    raw.t.send('n0', { t: 'req', id: 'q1', body: { kind: 'headers', from: 1, to: 1 } });
    await w.settle();
    expect(a.received).toEqual([]);
    expect(a.overlay.stats().unbound).toBe(2);
    // A valid hello binds.
    raw.t.send('n0', w.announce(evil));
    await w.settle();
    expect(a.overlay.peers().map((p) => p.nodeId)).toEqual([evil.publicKey()]);
    expect(raw.got.some((g) => g.msg.t === 'hello')).toBe(true);
  });

  it('keeps a link bound to its first node id', async () => {
    const w = new World();
    const a = w.add(0);
    a.overlay.start();
    const raw = w.raw('raw');
    await w.settle();
    raw.t.send('n0', w.announce(keypair(50)));
    await w.settle();
    raw.t.send('n0', w.announce(keypair(51)));
    await w.settle();
    expect(a.overlay.peers().map((p) => p.nodeId)).toEqual([keypair(50).publicKey()]);
    expect(a.overlay.stats().badAnnouncements).toBe(1);
  });

  it('binds through a status when the hello was lost', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    w.nets[0].setDropRate(1);
    w.startAll();
    await w.settle();
    expect(a.overlay.peers()).toEqual([]);
    w.nets[0].setDropRate(0);
    await w.settle(STATUS_INTERVAL_MS + 50);
    expect(peerNames(w, a)).toEqual(['n1']);
    expect(peerNames(w, b)).toEqual(['n0']);
  });

  it('adopts peers of transports that start asynchronously', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    const t = b.transports[0];
    const start = t.start.bind(t);
    (t as Transport).start = async () => {
      await Promise.resolve();
      start();
    };
    w.startAll();
    await w.settle();
    expect(peerNames(w, a)).toEqual(['n1']);
    expect(peerNames(w, b)).toEqual(['n0']);
  });

  it('adopts peers that transports found before the overlay started', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    a.transports[0].start();
    b.transports[0].start();
    await w.settle();
    expect(a.transports[0].peers()).toEqual(['n1']);
    w.startAll();
    await w.settle();
    expect(peerNames(w, a)).toEqual(['n1']);
    expect(peerNames(w, b)).toEqual(['n0']);
  });

  it('binds and floods a 6-node mesh under 10% packet loss', async () => {
    const w = new World(1, 7);
    w.nets[0].setLatency((_f, _t, rng) => 5 + Math.floor(rng() * 40));
    w.nets[0].setDropRate(0.1);
    for (let i = 0; i < 6; i++) w.add(i);
    w.startAll();
    await w.settle(STATUS_INTERVAL_MS * 3);
    for (const n of w.nodes) expect(n.overlay.peers()).toHaveLength(5);
    for (let k = 0; k < 30; k++) w.nodes[k % 6].overlay.floodStellar(xdrOf(`lossy${k}`));
    await w.settle(500);
    for (const [i, n] of w.nodes.entries()) {
      const want = Array.from({ length: 30 }, (_, k) => k)
        .filter((k) => k % 6 !== i)
        .map((k) => xdrOf(`lossy${k}`))
        .sort();
      expect(n.received.map((r) => r.xdr).sort()).toEqual(want);
    }
  });

  it('validates announcement fields', () => {
    const w = new World();
    const a = w.add(0);
    expect(() =>
      a.overlay.setAnnouncement({
        name: 'n0',
        lcl: { seq: 1, hash: 'ABCDEF' },
        state: 'synced',
        validator: true,
        qsetHash: '',
        quorumMode: 'auto',
      }),
    ).toThrow(TypeError);
    expect(
      () =>
        new Overlay({
          keypair: keypair(1),
          networkId: 'not-hex',
          name: 'x',
          clock: w.clock,
          logger: new Logger(new LogSink(w.clock), 'x'),
          transports: [],
          handlers: { onStellarMessage: () => undefined, onRequest: () => null },
        }),
    ).toThrow(/networkId/);
    const long = 'x'.repeat(100);
    a.overlay.setAnnouncement({ name: long, lcl: { seq: 2, hash: ZERO_HASH }, state: 'synced', validator: false, qsetHash: ZERO_HASH, quorumMode: 'manual' });
    expect(a.overlay.currentAnnouncement().name).toHaveLength(64);
  });
});

describe('Overlay: flooding', () => {
  it('reaches every node exactly once', async () => {
    const w = new World();
    for (let i = 0; i < 5; i++) w.add(i);
    w.startAll();
    await w.settle();
    const [a, ...others] = w.nodes;
    a.overlay.floodStellar(xdrOf('x'));
    await w.settle(100);
    expect(a.received).toEqual([]);
    for (const n of others) {
      expect(n.received).toEqual([{ xdr: xdrOf('x'), from: 'n0' }]);
      expect(n.overlay.stats().floodDuplicates).toBe(3);
      expect(stellarSent(n)).toBe(3);
    }
    expect(a.overlay.stats().floodDuplicates).toBe(0);
    expect(stellarSent(a)).toBe(4);
  });

  it('re-floods to everyone except the sender', async () => {
    // Line: n0 -net0- n1 -net1- n2
    const w = new World(2);
    const a = w.add(0, { nets: [0] });
    const b = w.add(1, { nets: [0, 1] });
    const c = w.add(2, { nets: [1] });
    w.startAll();
    await w.settle();
    a.overlay.floodStellar(xdrOf('line'));
    await w.settle(100);
    expect(b.received).toEqual([{ xdr: xdrOf('line'), from: 'n0' }]);
    expect(c.received).toEqual([{ xdr: xdrOf('line'), from: 'n1' }]);
    expect(stellarSent(b, 0)).toBe(0);
    expect(stellarSent(b, 1)).toBe(1);
    expect(a.overlay.stats().floodDuplicates).toBe(0);
  });

  it('a handler can stop the re-flood by returning false', async () => {
    const w = new World(2);
    const a = w.add(0, { nets: [0] });
    const b = w.add(1, { nets: [0, 1] });
    const c = w.add(2, { nets: [1] });
    b.stellarResult = false;
    w.startAll();
    await w.settle();
    a.overlay.floodStellar(xdrOf('bad'));
    await w.settle(100);
    expect(b.received).toHaveLength(1);
    expect(c.received).toEqual([]);
  });

  it('exceptNodeId skips one peer', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    const c = w.add(2);
    w.startAll();
    await w.settle();
    a.overlay.floodStellar(xdrOf('except'), { exceptNodeId: b.kp.publicKey() });
    await w.settle(100);
    expect(c.received).toEqual([{ xdr: xdrOf('except'), from: 'n0' }]);
    expect(b.received).toEqual([{ xdr: xdrOf('except'), from: 'n2' }]);
  });

  it('drops repeats of a message already seen', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    w.startAll();
    await w.settle();
    a.overlay.floodStellar(xdrOf('again'));
    await w.settle();
    a.overlay.floodStellar(xdrOf('again'));
    await w.settle();
    expect(b.received).toHaveLength(1);
    expect(b.overlay.stats().floodDuplicates).toBe(1);
    // b already knows it, so its own flood of it is not delivered back to b.
    b.overlay.floodStellar(xdrOf('again'));
    await w.settle();
    expect(a.received).toEqual([]);
  });

  it('dedupe memory is bounded (LRU)', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1, { overlay: { dedupeCapacity: 2 } });
    w.startAll();
    await w.settle();
    for (const n of [1, 2, 3, 1]) {
      a.overlay.floodStellar(xdrOf(n));
      await w.settle();
    }
    expect(b.received.map((r) => r.xdr)).toEqual([xdrOf(1), xdrOf(2), xdrOf(3), xdrOf(1)]);
  });

  it('sendStellar goes to one peer, is not deduped and not re-flooded', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    const c = w.add(2);
    w.startAll();
    await w.settle();
    a.overlay.sendStellar(b.kp.publicKey(), xdrOf('direct'));
    a.overlay.sendStellar(b.kp.publicKey(), xdrOf('direct'));
    a.overlay.sendStellar('GUNKNOWN', xdrOf('direct'));
    await w.settle(100);
    expect(b.received).toEqual([
      { xdr: xdrOf('direct'), from: 'n0' },
      { xdr: xdrOf('direct'), from: 'n0' },
    ]);
    expect(c.received).toEqual([]);
  });

  it('does not send invalid or oversize payloads', async () => {
    const w = new World();
    const a = w.add(0, { overlay: { maxMessageBytes: 1000 } });
    const b = w.add(1, { overlay: { maxMessageBytes: 1000 } });
    w.startAll();
    await w.settle();
    a.overlay.floodStellar('not base64!');
    a.overlay.floodStellar(xdrOf('big', 2000));
    a.overlay.sendStellar(b.kp.publicKey(), xdrOf('big2', 2000));
    await w.settle();
    expect(b.received).toEqual([]);
    expect(stellarSent(a)).toBe(0);
  });

  it('drops oversize and malformed inbound messages', async () => {
    const w = new World();
    const a = w.add(0, { overlay: { maxMessageBytes: 1000 } });
    a.overlay.start();
    const raw = w.raw('raw');
    await w.settle();
    raw.t.send('n0', w.announce(keypair(60)));
    await w.settle();
    raw.t.send('n0', { t: 'stellar', xdr: xdrOf('big', 2000), flood: true });
    raw.t.send('n0', { t: 'stellar', xdr: '***', flood: true } as WireMessage);
    raw.t.send('n0', { t: 'nope' } as unknown as WireMessage);
    raw.t.send('n0', { t: 'req', id: 'q', body: { kind: 'headers', from: -1, to: 2 } } as WireMessage);
    await w.settle();
    expect(a.received).toEqual([]);
    expect(a.overlay.stats().oversize).toBe(1);
    expect(a.overlay.stats().invalid).toBe(3);
  });
});

describe('Overlay: requests', () => {
  async function pair(opts: AddOpts = {}) {
    const w = new World();
    const a = w.add(0, opts);
    const b = w.add(1, opts);
    w.startAll();
    await w.settle();
    return { w, a, b, bId: b.kp.publicKey() };
  }

  it('answers sync and async handlers', async () => {
    const { w, a, b, bId } = await pair();
    const res = await Promise.all([
      a.overlay.request(bId, { kind: 'headers', from: 3, to: 4 }),
      (async () => {
        await w.settle();
        return null;
      })(),
    ]);
    expect(res[0]).toEqual({ kind: 'headers', items: [{ seq: 3, headerXdr: 'hdr-3' }] });
    b.onRequest = async (body) => ({ kind: 'snapshot', seq: 64, data: `{"for":${(body as { atOrBefore: number }).atOrBefore}}` });
    const p = a.overlay.request(bId, { kind: 'snapshot', atOrBefore: 70 });
    await w.settle();
    expect(await p).toEqual({ kind: 'snapshot', seq: 64, data: '{"for":70}' });
  });

  it('passes the requesting peer to the handler', async () => {
    const { w, a, b, bId } = await pair();
    let from: PeerInfo | null = null;
    b.onRequest = (body, peer) => {
      from = peer;
      return { kind: 'branchWeight', afterSeq: 1, weight: 7, lcl: { seq: 9, hash: ZERO_HASH } };
    };
    const p = a.overlay.request(bId, { kind: 'branchWeight', afterSeq: 1 });
    await w.settle();
    await p;
    expect(from!.nodeId).toBe(a.kp.publicKey());
    expect(from!.name).toBe('n0');
  });

  it('rejects on null, thrown errors, mismatched kinds and malformed bodies', async () => {
    const { w, a, b, bId } = await pair();
    const check = async (body: RequestBody, code: string, text?: RegExp) => {
      const outcome = expectRejects(a.overlay.request(bId, body), code, text);
      await w.settle();
      await outcome;
    };
    b.onRequest = () => null;
    await check({ kind: 'scpState', fromSlot: 1 }, 'no-data');

    b.onRequest = () => {
      throw new Error('disk on fire');
    };
    await check({ kind: 'scpState', fromSlot: 1 }, 'remote-error', /disk on fire/);

    b.onRequest = async () => {
      throw new Error('async failure');
    };
    await check({ kind: 'scpState', fromSlot: 1 }, 'remote-error', /async failure/);

    b.onRequest = () => ({ kind: 'scpState', envelopes: [] });
    await check({ kind: 'headers', from: 1, to: 2 }, 'bad-response', /expected headers/);

    b.onRequest = () => ({ kind: 'headers', items: 'nope' }) as unknown as ResponseBody;
    await check({ kind: 'headers', from: 1, to: 2 }, 'remote-error', /malformed/);
  });

  it('rejects requests it cannot send', async () => {
    const { w, a } = await pair();
    await expectRejects(a.overlay.request('GUNKNOWN', { kind: 'scpState', fromSlot: 1 }), 'not-connected');
    await expectRejects(
      a.overlay.request(w.nodes[1].kp.publicKey(), { kind: 'headers', from: 1.5, to: 2 } as RequestBody),
      'bad-request',
    );
  });

  it('times out and ignores a late response', async () => {
    const { w, a, b, bId } = await pair();
    let release: (v: ResponseBody) => void = () => undefined;
    b.onRequest = () => new Promise<ResponseBody>((r) => (release = r));
    const p = a.overlay.request(bId, { kind: 'scpState', fromSlot: 1 }, 500);
    const outcome = expectRejects(p, 'timeout', /timed out/);
    await w.settle(600);
    await outcome;
    release({ kind: 'scpState', envelopes: [] });
    await w.settle();
    expect(a.overlay.stats().requestTimeouts).toBe(1);
    expect(a.overlay.stats().unexpectedResponses).toBe(1);
  });

  it('limits concurrent inbound requests per peer', async () => {
    const { w, a, b, bId } = await pair();
    const releases: (() => void)[] = [];
    b.onRequest = () =>
      new Promise<ResponseBody>((r) => releases.push(() => r({ kind: 'scpState', envelopes: [] })));
    const ps = Array.from({ length: 5 }, () => a.overlay.request(bId, { kind: 'scpState', fromSlot: 1 }));
    const fifth = expectRejects(ps[4], 'remote-error', /busy/);
    await w.settle();
    await fifth;
    expect(releases).toHaveLength(4);
    expect(b.overlay.stats().requestsRejectedBusy).toBe(1);
    releases[0]();
    await w.settle();
    await expect(ps[0]).resolves.toEqual({ kind: 'scpState', envelopes: [] });
    const sixth = a.overlay.request(bId, { kind: 'scpState', fromSlot: 2 });
    await w.settle();
    expect(releases).toHaveLength(5);
    releases[4]();
    await w.settle();
    await expect(sixth).resolves.toEqual({ kind: 'scpState', envelopes: [] });
    for (const r of releases.slice(1, 4)) r();
    await w.settle();
    await Promise.all(ps.slice(0, 4));
  });

  it('tracks round-trip time', async () => {
    const { w, a, bId } = await pair();
    const p = a.overlay.request(bId, { kind: 'headers', from: 1, to: 1 });
    await w.settle();
    await p;
    expect(a.overlay.getPeer(bId)!.latencyMs).toBe(2 * LATENCY);
  });

  it('ignores responses from another node with the same id', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    w.startAll();
    const raw = w.raw('raw');
    await w.settle();
    raw.t.send('n0', w.announce(keypair(70)));
    await w.settle();
    let release: (v: ResponseBody) => void = () => undefined;
    b.onRequest = () => new Promise<ResponseBody>((r) => (release = r));
    const p = a.overlay.request(b.kp.publicKey(), { kind: 'scpState', fromSlot: 1 });
    await w.settle();
    const req = a.sent.find((s) => s.msg.t === 'req')!.msg as { id: string };
    raw.t.send('n0', { t: 'res', id: req.id, body: { kind: 'scpState', envelopes: ['forged'] } });
    await w.settle();
    expect(a.overlay.stats().unexpectedResponses).toBe(1);
    release({ kind: 'scpState', envelopes: ['real'] });
    await w.settle();
    await expect(p).resolves.toEqual({ kind: 'scpState', envelopes: ['real'] });
  });

  it('sends a response larger than one message in parts, and refuses one above the response cap', async () => {
    const { w, a, b, bId } = await pair({ overlay: { maxMessageBytes: 2000, maxResponseBytes: 8000 } });
    b.onRequest = () => ({ kind: 'snapshot', seq: 1, data: 'x'.repeat(5000) });
    const ok = a.overlay.request(bId, { kind: 'snapshot', atOrBefore: 1 });
    await w.settle();
    await expect(ok).resolves.toEqual({ kind: 'snapshot', seq: 1, data: 'x'.repeat(5000) });
    expect(b.sent.filter((s) => s.msg.t === 'part').length).toBeGreaterThan(2);
    b.onRequest = () => ({ kind: 'snapshot', seq: 1, data: 'x'.repeat(9000) });
    const outcome = expectRejects(a.overlay.request(bId, { kind: 'snapshot', atOrBefore: 1 }), 'remote-error', /too large/);
    await w.settle();
    await outcome;
  });
});

describe('Overlay: liveness', () => {
  it('drops silent peers after the timeout and rebinds when they come back', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    w.startAll();
    await w.settle();
    w.nets[0].setDropRate(1);
    await w.settle(PEER_TIMEOUT_MS - 500);
    expect(a.overlay.peers()).toHaveLength(1);
    await w.settle(2500);
    expect(a.overlay.peers()).toEqual([]);
    expect(b.overlay.peers()).toEqual([]);
    expect(a.events).toEqual(['connected:n1', 'disconnected:n1']);
    w.nets[0].setDropRate(0);
    await w.settle(STATUS_INTERVAL_MS + 100);
    expect(peerNames(w, a)).toEqual(['n1']);
    expect(peerNames(w, b)).toEqual(['n0']);
    expect(a.events.at(-1)).toBe('connected:n1');
  });

  it('keeps peers that send status beacons', async () => {
    const w = new World();
    const a = w.add(0);
    w.add(1);
    w.startAll();
    await w.settle(PEER_TIMEOUT_MS * 4);
    expect(a.overlay.peers()).toHaveLength(1);
    expect(a.events.filter((e) => e.startsWith('disconnected'))).toEqual([]);
    // One status event per beacon.
    expect(a.events.filter((e) => e.startsWith('status')).length).toBeGreaterThanOrEqual(12);
  });

  it('a bye drops the node at once', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    w.startAll();
    await w.settle();
    b.onRequest = () => new Promise<ResponseBody>(() => undefined);
    const outcome = expectRejects(a.overlay.request(b.kp.publicKey(), { kind: 'scpState', fromSlot: 1 }), 'disconnected');
    await w.settle(5);
    b.overlay.stop();
    await w.settle();
    await outcome;
    expect(a.overlay.peers()).toEqual([]);
    expect(a.events).toEqual(['connected:n1', 'disconnected:n1']);
    expect(a.logs.recent().some((e) => e.msg.includes('disconnected (bye)'))).toBe(true);
  });

  it('after a bye only a fresh hello re-binds the node', async () => {
    const w = new World();
    const a = w.add(0);
    a.overlay.start();
    const raw = w.raw('raw');
    const kp = keypair(80);
    await w.settle();
    const oldHello = w.announce(kp);
    raw.t.send('n0', oldHello);
    await w.settle();
    expect(a.overlay.peers()).toHaveLength(1);
    raw.t.send('n0', { t: 'bye', nodeId: keypair(81).publicKey() });
    await w.settle();
    expect(a.overlay.peers()).toHaveLength(1);
    raw.t.send('n0', { t: 'bye', nodeId: kp.publicKey() });
    await w.settle();
    expect(a.overlay.peers()).toEqual([]);
    // Replayed and in-flight announcements do not resurrect it.
    raw.t.send('n0', oldHello);
    raw.t.send('n0', w.announce(kp, {}, 'status'));
    await w.settle();
    expect(a.overlay.peers()).toEqual([]);
    raw.t.send('n0', w.announce(kp, {}, 'hello'));
    await w.settle();
    expect(a.overlay.peers()).toHaveLength(1);
  });

  it('stop rejects pending requests and disconnects everyone; start reconnects', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    const c = w.add(2);
    w.startAll();
    await w.settle();
    b.onRequest = () => new Promise<ResponseBody>(() => undefined);
    const p = a.overlay.request(b.kp.publicKey(), { kind: 'scpState', fromSlot: 1 });
    const outcome = expectRejects(p, 'stopped');
    a.overlay.stop();
    await outcome;
    expect(a.overlay.peers()).toEqual([]);
    expect(a.events.filter((e) => e.startsWith('disconnected')).sort()).toEqual(['disconnected:n1', 'disconnected:n2']);
    await expectRejects(a.overlay.request(b.kp.publicKey(), { kind: 'scpState', fromSlot: 1 }), 'stopped');
    await w.settle();
    expect(peerNames(w, b)).toEqual(['n2']);
    expect(peerNames(w, c)).toEqual(['n1']);
    a.overlay.start();
    await w.settle();
    expect(peerNames(w, a)).toEqual(['n1', 'n2']);
    expect(peerNames(w, b)).toEqual(['n0', 'n2']);
  });
});

describe('Overlay: several transports', () => {
  it('binds both links to one node, prefers broadcast, and survives losing one', async () => {
    const w = new World(2);
    const kinds: TransportKind[] = ['memory', 'broadcast'];
    const a = w.add(0, { nets: [0, 1], kinds });
    const b = w.add(1, { nets: [0, 1], kinds });
    w.startAll();
    await w.settle();
    const bId = b.kp.publicKey();
    expect(a.overlay.peers()).toHaveLength(1);
    expect(a.overlay.getPeer(bId)!.transports).toEqual(['broadcast', 'memory']);
    expect(a.events).toEqual(['connected:n1']);

    a.overlay.floodStellar(xdrOf('pref'));
    await w.settle();
    expect(b.received).toEqual([{ xdr: xdrOf('pref'), from: 'n0' }]);
    expect(stellarSent(a, 1)).toBe(1);
    expect(stellarSent(a, 0)).toBe(0);

    // The same message arriving over both links is delivered once.
    const raw0 = w.raw('raw', 0);
    const raw1 = w.raw('raw', 1);
    await w.settle();
    const kp = keypair(90);
    raw0.t.send('n1', w.announce(kp));
    raw1.t.send('n1', w.announce(kp));
    await w.settle();
    raw0.t.send('n1', { t: 'stellar', xdr: xdrOf('twice'), flood: true });
    raw1.t.send('n1', { t: 'stellar', xdr: xdrOf('twice'), flood: true });
    await w.settle();
    expect(b.received.filter((r) => r.xdr === xdrOf('twice'))).toHaveLength(1);

    w.nets[1].disconnect('n1');
    await w.settle();
    expect(a.overlay.getPeer(bId)!.transports).toEqual(['memory']);
    expect(a.events).toEqual(['connected:n1']);
    a.overlay.floodStellar(xdrOf('fallback'));
    await w.settle();
    expect(b.received.at(-1)).toEqual({ xdr: xdrOf('fallback'), from: 'n0' });
    expect(stellarSent(a, 0)).toBe(1);

    w.nets[0].disconnect('n1');
    await w.settle();
    expect(a.overlay.isConnected(bId)).toBe(false);
    expect(a.events).toEqual(['connected:n1', 'disconnected:n1']);

    w.nets[0].reconnect('n1');
    w.nets[1].reconnect('n1');
    await w.settle();
    expect(a.overlay.getPeer(bId)!.transports).toEqual(['broadcast', 'memory']);
  });
});

describe('Overlay: announcements', () => {
  it('sends a status when the announcement changes', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    w.startAll();
    await w.settle();
    a.overlay.setAnnouncement({
      name: 'n0',
      lcl: { seq: 5, hash: sha256Hex('ledger 5') },
      state: 'synced',
      validator: true,
      qsetHash: sha256Hex('qset'),
      quorumMode: 'auto',
    });
    await w.settle(20);
    expect(b.events).toContain('status:n0:5');
    const peer = b.overlay.getPeer(a.kp.publicKey())!;
    expect(peer.ann.lcl).toEqual({ seq: 5, hash: sha256Hex('ledger 5') });
    expect(peer.ann.state).toBe('synced');
    expect(peer.ann.qsetHash).toBe(sha256Hex('qset'));
  });

  it('a change in the same millisecond as a hello still reaches the new peer', async () => {
    const w = new World();
    const a = w.add(0);
    w.add(1);
    a.overlay.start();
    w.nodes[1].overlay.start();
    await w.settle(1000);
    const c = w.add(2);
    // Right after a greets c (same virtual ms), a's LCL changes.
    const t = a.transports[0];
    const send = t.send.bind(t);
    let changed = false;
    t.send = (peer, msg) => {
      send(peer, msg);
      if (!changed && peer === 'n2' && msg.t === 'hello') {
        changed = true;
        a.overlay.setAnnouncement({
          name: 'n0',
          lcl: { seq: 42, hash: ZERO_HASH },
          state: 'synced',
          validator: true,
          qsetHash: '',
          quorumMode: 'auto',
        });
      }
    };
    c.overlay.start();
    await w.settle(50);
    expect(changed).toBe(true);
    expect(c.overlay.getPeer(a.kp.publicKey())!.ann.lcl.seq).toBe(42);
  });

  it('a restart announces a strictly newer ts', async () => {
    const w = new World();
    const a = w.add(0);
    w.add(1);
    w.startAll();
    await w.settle(STATUS_INTERVAL_MS - 50);
    await w.settle(50); // exactly at the beacon
    const lastStatus = a.sent.filter((s) => s.msg.t === 'status').at(-1)!.msg as { ann: NodeAnnouncement };
    expect(lastStatus.ann.ts).toBe(w.clock.now());
    const before = a.sent.length;
    a.overlay.stop();
    a.overlay.start();
    await w.settle(0);
    const hello = a.sent.slice(before).find((s) => s.msg.t === 'hello')!.msg as { ann: NodeAnnouncement };
    expect(hello.ann.ts).toBeGreaterThan(lastStatus.ann.ts);
  });

  it('rate-limits change-triggered statuses and skips no-op changes', async () => {
    const w = new World();
    const a = w.add(0);
    w.add(1);
    w.startAll();
    await w.settle();
    const before = a.sent.filter((s) => s.msg.t === 'status').length;
    const fields = { name: 'n0', state: 'synced' as const, validator: true, qsetHash: '', quorumMode: 'auto' as const };
    for (let seq = 1; seq <= 10; seq++) a.overlay.setAnnouncement({ ...fields, lcl: { seq, hash: ZERO_HASH } });
    a.overlay.setAnnouncement({ ...fields, lcl: { seq: 10, hash: ZERO_HASH } });
    await w.settle(300);
    const statuses = a.sent.filter((s) => s.msg.t === 'status').slice(before);
    expect(statuses.length).toBeLessThanOrEqual(2);
    const last = statuses.at(-1)!.msg as { ann: NodeAnnouncement };
    expect(last.ann.lcl.seq).toBe(10);
  });
});

describe('Overlay: rate limiting', () => {
  it('drops inbound messages over the token bucket', async () => {
    const w = new World();
    const a = w.add(0, { overlay: { rateLimit: { messagesPerSecond: 10, burst: 5 } } });
    a.overlay.start();
    const raw = w.raw('raw');
    await w.settle();
    raw.t.send('n0', w.announce(keypair(95)));
    await w.settle(1000);
    for (let i = 0; i < 20; i++) raw.t.send('n0', { t: 'stellar', xdr: xdrOf(`rl${i}`), flood: true });
    await w.settle();
    expect(a.received).toHaveLength(5);
    expect(a.overlay.stats().rateLimited).toBe(15);
  });
});

describe('Overlay: determinism', () => {
  it('two runs with the same seed give the same traffic', async () => {
    const run = async () => {
      const w = new World(1, 42);
      w.nets[0].setLatency((_f, _t, rng) => 5 + Math.floor(rng() * 30));
      for (let i = 0; i < 4; i++) w.add(i);
      w.startAll();
      await w.settle(100);
      for (let i = 0; i < 10; i++) {
        w.nodes[i % 4].overlay.floodStellar(xdrOf(`d${i}`));
        await w.settle(7);
      }
      await w.settle(STATUS_INTERVAL_MS * 2);
      return w.nodes.map((n) => [n.received.map((r) => `${r.from}:${r.xdr}`).join('|'), JSON.stringify(n.overlay.stats())]);
    };
    expect(await run()).toEqual(await run());
  });
});
