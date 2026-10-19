// Overlay hardening: hello replay protection, DoS bounds (rate limits, peer
// and link caps, inbound handler timeout) and strict wire validation.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { ZERO_HASH, toBase64, utf8 } from '../lib/bytes';
import { VirtualClock } from '../lib/clock';
import { APP_VERSION, PEER_TIMEOUT_MS, STATUS_INTERVAL_MS } from '../lib/constants';
import { sha256, sha256Hex } from '../lib/hash';
import { LogSink, Logger } from '../lib/log';
import { MemoryNetwork, type MemoryTransport } from './memoryNetwork';
import { Overlay, OverlayRequestError, type OverlayOptions } from './overlay';
import type { NodeAnnouncement, OverlayHandlers, PeerInfo, TransportKind, WireMessage } from './types';
import { signAnnouncement } from './wire';

const NONCE = '00'.repeat(16);

const NETWORK_ID = sha256Hex('BrowserChain overlay security tests');

function keypair(i: number): Keypair {
  return Keypair.fromRawEd25519Seed(sha256(`overlay-security-node-${i}`));
}

function xdrOf(n: number): string {
  return toBase64(utf8(`stellar-message-${n}`));
}

interface TestNode {
  name: string;
  kp: Keypair;
  overlay: Overlay;
  transport: MemoryTransport;
  events: string[];
  received: string[];
  /** Frames this node sent. */
  sent: { to: string; msg: WireMessage }[];
  onRequest: OverlayHandlers['onRequest'];
}

class World {
  readonly clock = new VirtualClock(1_790_000_000_000);
  readonly net: MemoryNetwork;
  readonly names = new Map<string, string>();

  constructor(seed = 1) {
    this.net = new MemoryNetwork({ clock: this.clock, seed, latencyMs: () => 10 });
  }

  add(i: number, kind: TransportKind = 'webrtc', overlay: Partial<OverlayOptions> = {}): TestNode {
    const kp = keypair(i);
    const name = `n${i}`;
    this.names.set(kp.publicKey(), name);
    const transport = this.net.createTransport(name, { kind });
    const label = (p: PeerInfo) => this.names.get(p.nodeId) ?? p.nodeId.slice(0, 6);
    const sent: { to: string; msg: WireMessage }[] = [];
    const send = transport.send.bind(transport);
    transport.send = (peer, msg) => {
      sent.push({ to: peer, msg });
      send(peer, msg);
    };
    const node: TestNode = {
      name,
      kp,
      transport,
      events: [],
      received: [],
      sent,
      onRequest: (body) => (body.kind === 'headers' ? { kind: 'headers', items: [{ seq: body.from, headerXdr: 'h' }] } : null),
      overlay: null as unknown as Overlay,
    };
    node.overlay = new Overlay({
      keypair: kp,
      networkId: NETWORK_ID,
      name,
      clock: this.clock,
      logger: new Logger(new LogSink(this.clock, 'debug'), name),
      transports: [transport],
      handlers: {
        onStellarMessage: (xdr) => {
          node.received.push(xdr);
        },
        onRequest: (body, from) => node.onRequest(body, from),
        onPeerConnected: (p) => node.events.push(`connected:${label(p)}`),
        onPeerDisconnected: (p) => node.events.push(`disconnected:${label(p)}`),
      },
      ...overlay,
    });
    return node;
  }

  /** A raw endpoint driven by the test. It records every frame it receives. */
  raw(id: string, kind: TransportKind = 'webrtc'): { t: MemoryTransport; got: { from: string; msg: WireMessage }[] } {
    const t = this.net.createTransport(id, { kind });
    const got: { from: string; msg: WireMessage }[] = [];
    t.onMessage = (from, msg) => got.push({ from, msg });
    t.start();
    return { t, got };
  }

  announcement(kp: Keypair, over: Partial<NodeAnnouncement> = {}): NodeAnnouncement {
    return {
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
  }

  settle(ms = 100): Promise<void> {
    return this.clock.advance(ms);
  }
}

function peerIds(n: TestNode): string[] {
  return n.overlay.peers().map((p) => p.nodeId);
}

/** Node id a link of the overlay is bound to (white-box: the attacker's link). */
function linkNode(n: TestNode, key: string): string | null {
  return (n.overlay as unknown as { links: Map<string, { nodeId: string | null }> }).links.get(key)?.nodeId ?? null;
}

describe('Overlay security: hello replay', () => {
  it('a hello captured on one link and replayed on another does not bind the replaying endpoint', async () => {
    const w = new World();
    const a = w.add(0);
    const x = w.add(1);
    a.overlay.start();
    x.overlay.start();
    // The attacker joins the room: X greets it like any new peer.
    const m = w.raw('mallory');
    await w.settle(200);
    expect(peerIds(a)).toEqual([x.kp.publicKey()]);
    const captured = m.got.filter((g) => g.from === 'n1' && (g.msg.t === 'hello' || g.msg.t === 'status')).map((g) => g.msg);
    expect(captured.length).toBeGreaterThan(0);

    // Replay every frame X sent us to A, then say bye in X's name.
    for (const msg of captured) m.t.send('n0', msg);
    await w.settle(200);
    m.t.send('n0', { t: 'bye', nodeId: x.kp.publicKey() });
    await w.settle(200);
    // X stays connected at A, and Mallory's link is not one of X's links.
    expect(a.events).toEqual(['connected:n1']);
    expect(peerIds(a)).toEqual([x.kp.publicKey()]);
    expect(linkNode(a, '0:mallory')).toBeNull();
    expect(a.overlay.stats().unbound).toBeGreaterThan(0);
  });

  it('a status replayed on an unbound link does not bind it', async () => {
    const w = new World();
    const a = w.add(0);
    const x = w.add(1);
    a.overlay.start();
    x.overlay.start();
    const m = w.raw('mallory');
    await w.settle(STATUS_INTERVAL_MS + 200);
    const status = m.got.find((g) => g.from === 'n1' && g.msg.t === 'status')?.msg;
    expect(status).toBeDefined();
    m.t.send('n0', status!);
    await w.settle(200);
    m.t.send('n0', { t: 'bye', nodeId: x.kp.publicKey() });
    await w.settle(200);
    expect(peerIds(a)).toEqual([x.kp.publicKey()]);
    expect(linkNode(a, '0:mallory')).toBeNull();
  });
});

describe('Overlay security: inbound requests', () => {
  it('a handler that never settles frees its slot after the handler timeout', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    a.overlay.start();
    b.overlay.start();
    await w.settle();
    b.onRequest = () => new Promise(() => undefined);
    const stuck = Array.from({ length: 4 }, (_, i) =>
      a.overlay.request(b.kp.publicKey(), { kind: 'headers', from: i + 1, to: i + 1 }, 1000).catch((e: OverlayRequestError) => e.code),
    );
    await w.settle(1500);
    expect(await Promise.all(stuck)).toEqual(['timeout', 'timeout', 'timeout', 'timeout']);
    b.onRequest = (body) => (body.kind === 'headers' ? { kind: 'headers', items: [] } : null);
    // Within the handler timeout the slots are still taken.
    const early = a.overlay.request(b.kp.publicKey(), { kind: 'headers', from: 9, to: 9 }, 1000).catch((e: OverlayRequestError) => e.message);
    await w.settle(200);
    expect(await early).toMatch(/busy/);
    // After it, they are free again.
    await w.settle(60_000);
    const later = a.overlay
      .request(b.kp.publicKey(), { kind: 'headers', from: 9, to: 9 }, 1000)
      .then((r) => r, (e: Error) => e.message);
    await w.settle(200);
    expect(await later).toEqual({ kind: 'headers', items: [] });
    expect(b.overlay.stats().requestHandlerTimeouts).toBe(4);
  });
});

describe('Overlay security: default bounds', () => {
  it('rate-limits a flooding link by default', async () => {
    const w = new World();
    const a = w.add(0, 'memory');
    a.overlay.start();
    const m = w.raw('mallory', 'memory');
    await w.settle();
    const kp = keypair(9);
    const ann = w.announcement(kp);
    m.t.send('n0', { t: 'hello', ann, sig: signAnnouncement(kp, ann), nonce: NONCE });
    await w.settle();
    expect(peerIds(a)).toEqual([kp.publicKey()]);
    for (let i = 0; i < 5000; i++) m.t.send('n0', { t: 'stellar', xdr: xdrOf(i), flood: true });
    await w.settle();
    expect(a.overlay.stats().rateLimited).toBeGreaterThan(0);
    expect(a.received.length).toBeLessThan(5000);
  });

  it('caps the number of peers per overlay', async () => {
    const w = new World();
    const a = w.add(0, 'memory');
    a.overlay.start();
    const raws = Array.from({ length: 80 }, (_, i) => ({ r: w.raw(`r${i}`, 'memory'), kp: keypair(100 + i) }));
    await w.settle();
    for (const { r, kp } of raws) {
      const ann = w.announcement(kp);
      r.t.send('n0', { t: 'hello', ann, sig: signAnnouncement(kp, ann), nonce: NONCE });
    }
    await w.settle();
    expect(a.overlay.peers().length).toBe(64);
    expect(a.overlay.stats().peersRejected).toBe(16);
  });

  it('rejects announcements with unknown fields', async () => {
    const w = new World();
    const a = w.add(0, 'memory');
    a.overlay.start();
    const m = w.raw('mallory', 'memory');
    await w.settle();
    const kp = keypair(9);
    const ann = { ...w.announcement(kp), junk: 'x'.repeat(1_000_000) } as NodeAnnouncement;
    m.t.send('n0', { t: 'hello', ann, sig: signAnnouncement(kp, ann), nonce: NONCE });
    await w.settle();
    expect(peerIds(a)).toEqual([]);
    expect(a.overlay.stats().invalid).toBe(1);
    // the same hello without the extra field binds
    const clean = w.announcement(kp);
    m.t.send('n0', { t: 'hello', ann: clean, sig: signAnnouncement(kp, clean), nonce: NONCE });
    await w.settle();
    expect(peerIds(a)).toEqual([kp.publicKey()]);
  });
});

describe('Overlay security: nonce handshake on authenticated links', () => {
  function hellos(n: TestNode): WireMessage[] {
    return n.sent.filter((x) => x.msg.t === 'hello').map((x) => x.msg);
  }

  it('binds both ways with two hellos each way; only the second covers a nonce', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    a.overlay.start();
    b.overlay.start();
    await w.settle();
    expect(peerIds(a)).toEqual([b.kp.publicKey()]);
    expect(peerIds(b)).toEqual([a.kp.publicKey()]);
    expect(a.events).toEqual(['connected:n1']);
    for (const n of [a, b]) {
      const h = hellos(n) as Extract<WireMessage, { t: 'hello' }>[];
      expect(h).toHaveLength(2);
      expect(h[0].peerNonce).toBeUndefined();
      expect(h[1].peerNonce).toMatch(/^[0-9a-f]{32}$/);
      expect(h[1].nonce).toBe(h[0].nonce);
    }
    // each side covered the other's nonce
    const ha = hellos(a) as Extract<WireMessage, { t: 'hello' }>[];
    const hb = hellos(b) as Extract<WireMessage, { t: 'hello' }>[];
    expect(ha[1].peerNonce).toBe(hb[0].nonce);
    expect(hb[1].peerNonce).toBe(ha[0].nonce);
    // and nothing else is sent until the first status beacon
    expect(a.sent.every((x) => x.msg.t === 'hello')).toBe(true);
  });

  it('a forged hello that covers the right nonce but has a bad signature does not bind', async () => {
    const w = new World();
    const a = w.add(0);
    a.overlay.start();
    const m = w.raw('mallory');
    await w.settle();
    const mine = m.got.find((g) => g.msg.t === 'hello')!.msg as Extract<WireMessage, { t: 'hello' }>;
    const victim = keypair(7);
    const ann = w.announcement(victim);
    // signed by the wrong key over the right digest shape
    m.t.send('n0', { t: 'hello', ann, sig: signAnnouncement(keypair(8), ann), nonce: NONCE, peerNonce: mine.nonce });
    await w.settle();
    expect(peerIds(a)).toEqual([]);
    expect(a.overlay.stats().badAnnouncements).toBe(1);
  });

  it('binds after the first hellos are lost: a status asks for a fresh hello', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    w.net.setDropRate(1);
    a.overlay.start();
    b.overlay.start();
    await w.settle();
    expect(peerIds(a)).toEqual([]);
    w.net.setDropRate(0);
    await w.settle(STATUS_INTERVAL_MS + 200);
    expect(peerIds(a)).toEqual([b.kp.publicKey()]);
    expect(peerIds(b)).toEqual([a.kp.publicKey()]);
  });

  it('rebinds after a silent period with new nonces', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    a.overlay.start();
    b.overlay.start();
    await w.settle();
    const firstNonces = new Set((hellos(a) as Extract<WireMessage, { t: 'hello' }>[]).map((h) => h.nonce));
    w.net.setDropRate(1);
    await w.settle(PEER_TIMEOUT_MS + 3000);
    expect(peerIds(a)).toEqual([]);
    expect(peerIds(b)).toEqual([]);
    w.net.setDropRate(0);
    await w.settle(STATUS_INTERVAL_MS + 500);
    expect(peerIds(a)).toEqual([b.kp.publicKey()]);
    expect(peerIds(b)).toEqual([a.kp.publicKey()]);
    const later = (hellos(a) as Extract<WireMessage, { t: 'hello' }>[]).map((h) => h.nonce).filter((n) => !firstNonces.has(n));
    expect(later.length).toBeGreaterThan(0);
    expect(a.events).toEqual(['connected:n1', 'disconnected:n1', 'connected:n1']);
  });

  it('a node that restarts binds again, and its bye still drops it at once', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    a.overlay.start();
    b.overlay.start();
    await w.settle();
    b.overlay.stop();
    await w.settle();
    expect(a.events).toEqual(['connected:n1', 'disconnected:n1']);
    b.overlay.start();
    await w.settle();
    expect(peerIds(a)).toEqual([b.kp.publicKey()]);
    expect(peerIds(b)).toEqual([a.kp.publicKey()]);
  });

  it('binds and floods a 6-node mesh under 10% packet loss', async () => {
    const w = new World(7);
    w.net.setLatency((_f, _t, rng) => 5 + Math.floor(rng() * 40));
    w.net.setDropRate(0.1);
    const nodes = Array.from({ length: 6 }, (_, i) => w.add(i));
    for (const n of nodes) n.overlay.start();
    await w.settle(4 * STATUS_INTERVAL_MS);
    for (const n of nodes) expect(n.overlay.peers()).toHaveLength(5);
    w.net.setDropRate(0);
    nodes[0].overlay.floodStellar(xdrOf(42));
    await w.settle(500);
    for (const n of nodes.slice(1)) expect(n.received).toEqual([xdrOf(42)]);
  });

  it('always converges to a full mesh once loss stops (20 seeds, 30% loss, link timeouts)', async () => {
    let drops = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const w = new World(seed);
      w.net.setLatency((_f, _t, rng) => 5 + Math.floor(rng() * 60));
      w.net.setDropRate(0.3);
      const nodes = Array.from({ length: 5 }, (_, i) => w.add(i));
      for (const n of nodes) n.overlay.start();
      await w.settle(15_000);
      w.net.setDropRate(0);
      await w.settle(3 * STATUS_INTERVAL_MS);
      for (const n of nodes) expect(n.overlay.peers().length, `seed ${seed} ${n.name}`).toBe(4);
      drops += nodes.reduce((k, n) => k + n.events.filter((e) => e.startsWith('disconnected')).length, 0);
    }
    // the lossy phase did time links out, so re-binding with new nonces was exercised
    expect(drops).toBeGreaterThan(5);
  });

  it('a bye on one WebRTC link of a node that has other links ends only that link', async () => {
    const clock = new VirtualClock(1_790_000_000_000);
    const local = new MemoryNetwork({ clock, seed: 1, latencyMs: () => 10 });
    const rtc = new MemoryNetwork({ clock, seed: 2, latencyMs: () => 10 });
    const events: string[] = [];
    const mk = (i: number) =>
      new Overlay({
        keypair: keypair(i),
        networkId: NETWORK_ID,
        name: `n${i}`,
        clock,
        logger: new Logger(new LogSink(clock, 'warn'), `n${i}`),
        transports: [local.createTransport(`n${i}`, { kind: 'broadcast' }), rtc.createTransport(`n${i}`, { kind: 'webrtc' })],
        handlers: {
          onStellarMessage: () => undefined,
          onRequest: () => null,
          onPeerDisconnected: (p) => {
            if (i === 0) events.push(`n${i} lost ${p.name}`);
          },
        },
      });
    const a = mk(0);
    const b = mk(1);
    a.start();
    b.start();
    await clock.advance(100);
    expect(a.getPeer(keypair(1).publicKey())?.transports).toEqual(['broadcast', 'webrtc']);
    // B's bye arrives on the WebRTC link only: A keeps B over BroadcastChannel
    rtc.getTransport('n1')!.send('n0', { t: 'bye', nodeId: keypair(1).publicKey() });
    await clock.advance(50);
    expect(a.getPeer(keypair(1).publicKey())?.transports).toEqual(['broadcast']);
    expect(events).toEqual([]);
    // a bye on a same-origin link drops the node at once
    local.getTransport('n1')!.send('n0', { t: 'bye', nodeId: keypair(1).publicKey() });
    await clock.advance(50);
    expect(events).toEqual(['n0 lost n1']);
    // after a restart B binds both links again; a real stop says bye on both, so A drops B at once
    events.length = 0;
    b.stop();
    b.start();
    await clock.advance(200);
    expect(a.getPeer(keypair(1).publicKey())?.transports).toEqual(['broadcast', 'webrtc']);
    events.length = 0;
    b.stop();
    await clock.advance(50);
    expect(events).toEqual(['n0 lost n1']);
  });

  it('binds unprotected when one side has no channel id (a browser that does not expose DTLS certificates)', async () => {
    const w = new World();
    const a = w.add(0);
    const b = w.add(1);
    // B's transport cannot name the channel: its hellos carry none, and it accepts A's
    (b.transport as { channelId?: unknown }).channelId = undefined;
    a.overlay.start();
    b.overlay.start();
    await w.settle();
    expect(peerIds(a)).toEqual([b.kp.publicKey()]);
    expect(peerIds(b)).toEqual([a.kp.publicKey()]);
    const sentByB = b.sent.filter((x) => x.msg.t === 'hello' && x.msg.peerNonce !== undefined).map((x) => x.msg);
    expect(sentByB.length).toBeGreaterThan(0);
    expect(sentByB.every((m) => m.t === 'hello' && m.channel === undefined)).toBe(true);
    expect(a.overlay.stats().channelBound).toBe(0);
    expect(b.overlay.stats().channelBound).toBe(0);
    expect(a.overlay.stats().badAnnouncements + b.overlay.stats().badAnnouncements).toBe(0);
  });

  it('caps transport links', async () => {
    const w = new World();
    const a = w.add(0, 'webrtc', { maxLinks: 3 });
    a.overlay.start();
    for (let i = 0; i < 5; i++) w.raw(`r${i}`);
    await w.settle();
    expect(a.overlay.stats().linksRejected).toBe(2);
    expect((a.overlay as unknown as { links: Map<string, unknown> }).links.size).toBe(3);
  });

  // Before eviction, 128 endpoints that joined and never sent anything held
  // every link slot forever: an honest node that came later never bound.
  it('silent links at the cap do not keep an honest node out', async () => {
    const w = new World();
    const a = w.add(0);
    a.overlay.start();
    const idle = Array.from({ length: 128 }, (_, i) => w.raw(`idle${i}`));
    await w.settle();
    expect(a.overlay.stats().linksRejected).toBe(0);
    const b = w.add(1);
    b.overlay.start();
    await w.settle();
    // fresh idle links keep their slots for one peer timeout...
    expect(peerIds(a)).toEqual([]);
    await w.settle(PEER_TIMEOUT_MS + 3 * STATUS_INTERVAL_MS);
    // ...then a stale one makes room, and B binds both ways
    expect(peerIds(a)).toEqual([b.kp.publicKey()]);
    expect(peerIds(b)).toEqual([a.kp.publicKey()]);
    expect(a.overlay.stats().linksEvicted).toBe(1);
    // the evicted endpoint cannot take a slot back just by sending
    const gone = idle.find((r) => linkNode(a, `0:${r.t.id}`) === null && !(a.overlay as unknown as { links: Map<string, unknown> }).links.has(`0:${r.t.id}`))!;
    expect(gone).toBeDefined();
    const before = a.overlay.stats().linksRejected;
    const kp = keypair(50);
    const ann = w.announcement(kp);
    gone.t.send('n0', { t: 'hello', ann, sig: signAnnouncement(kp, ann), nonce: NONCE });
    await w.settle();
    expect(a.overlay.stats().linksRejected).toBe(before + 1);
    expect(a.overlay.isConnected(kp.publicKey())).toBe(false);
    // bound links are never evicted
    expect(peerIds(a)).toEqual([b.kp.publicKey()]);
  });
});
