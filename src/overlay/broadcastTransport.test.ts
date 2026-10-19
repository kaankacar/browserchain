import { Keypair } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it } from 'vitest';
import { toBase64, utf8 } from '../lib/bytes';
import { VirtualClock } from '../lib/clock';
import { sha256, sha256Hex } from '../lib/hash';
import { nullLogger } from '../lib/log';
import { BroadcastChannelTransport, broadcastChannelName } from './broadcastTransport';
import { Overlay } from './overlay';
import type { WireMessage } from './types';

let counter = 0;
/** A fresh network id per test, so parallel test files never share a channel. */
function freshNetwork(): string {
  return sha256Hex(`bc-test-${process.pid}-${++counter}-${Math.random()}`);
}

async function waitFor(pred: () => boolean, what = 'condition', timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

interface Endpoint {
  t: BroadcastChannelTransport;
  log: string[];
  msgs: { from: string; msg: WireMessage }[];
}

function endpoint(networkId: string, id: string, clock = new VirtualClock()): Endpoint {
  const t = new BroadcastChannelTransport({ networkId, clock, id, beatIntervalMs: 100, peerTimeoutMs: 300 });
  const ep: Endpoint = { t, log: [], msgs: [] };
  t.onPeerUp = (p) => ep.log.push(`up:${p}`);
  t.onPeerDown = (p) => ep.log.push(`down:${p}`);
  t.onMessage = (from, msg) => {
    ep.msgs.push({ from, msg });
    ep.log.push(`msg:${from}:${msg.t === 'bye' ? msg.nodeId : msg.t}`);
  };
  cleanup.push(() => t.stop());
  return ep;
}

/** A raw channel on the same name, to play misbehaving endpoints. */
function rawChannel(networkId: string): BroadcastChannel {
  const ch = new BroadcastChannel(broadcastChannelName(networkId));
  cleanup.push(() => ch.close());
  return ch;
}

const bye = (n: string): WireMessage => ({ t: 'bye', nodeId: n });

describe('BroadcastChannelTransport', () => {
  it('uses the network channel name and a random id by default', () => {
    const net = freshNetwork();
    const t = new BroadcastChannelTransport({ networkId: net, clock: new VirtualClock() });
    expect(t.channelName).toBe(`browserchain:${net.slice(0, 16)}`);
    expect(t.id).toMatch(/^[0-9a-f]{16}$/);
    expect(t.kind).toBe('broadcast');
  });

  it('discovers peers with join and here', async () => {
    const net = freshNetwork();
    const a = endpoint(net, 'a');
    const b = endpoint(net, 'b');
    a.t.start();
    b.t.start();
    await waitFor(() => a.t.peers().includes('b') && b.t.peers().includes('a'), 'discovery');
    expect(a.log).toEqual(['up:b']);
    expect(b.log).toEqual(['up:a']);
  });

  it('send reaches only the target; broadcast reaches everyone', async () => {
    const net = freshNetwork();
    const a = endpoint(net, 'a');
    const b = endpoint(net, 'b');
    const c = endpoint(net, 'c');
    for (const e of [a, b, c]) e.t.start();
    await waitFor(() => a.t.peers().length === 2 && b.t.peers().length === 2 && c.t.peers().length === 2, 'mesh');
    a.t.send('b', bye('only-b'));
    a.t.send('nobody', bye('unknown-peer'));
    a.t.broadcast(bye('everyone'));
    await waitFor(() => c.log.includes('msg:a:everyone') && b.log.includes('msg:a:everyone'), 'broadcast');
    expect(b.msgs.map((m) => (m.msg as { nodeId: string }).nodeId)).toEqual(['only-b', 'everyone']);
    expect(c.msgs.map((m) => (m.msg as { nodeId: string }).nodeId)).toEqual(['everyone']);
  });

  it('reports a peer down when it leaves', async () => {
    const net = freshNetwork();
    const a = endpoint(net, 'a');
    const b = endpoint(net, 'b');
    a.t.start();
    b.t.start();
    await waitFor(() => a.t.peers().includes('b'), 'discovery');
    b.t.send('a', bye('last'));
    b.t.stop();
    await waitFor(() => a.log.includes('down:b'), 'leave');
    expect(a.log).toEqual(['up:b', 'msg:b:last', 'down:b']);
    expect(b.t.peers()).toEqual([]);
  });

  it('times out silent peers and keeps beating ones', async () => {
    const net = freshNetwork();
    const clock = new VirtualClock();
    const a = endpoint(net, 'a', clock);
    const b = endpoint(net, 'b', clock);
    a.t.start();
    b.t.start();
    const ghost = rawChannel(net);
    ghost.postMessage({ from: 'ghost', kind: 'join' });
    await waitFor(() => a.t.peers().includes('ghost') && a.t.peers().includes('b'), 'peers');
    // Advance in small steps so b's beats reach a between sweeps.
    for (let i = 0; i < 10; i++) {
      await clock.advance(60);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(a.log).toContain('down:ghost');
    expect(a.t.peers()).toEqual(['b']);
    // A late frame brings the ghost back.
    ghost.postMessage({ from: 'ghost', kind: 'beat' });
    await waitFor(() => a.t.peers().includes('ghost'), 'ghost back');
  });

  it('treats a second join from a known endpoint as a restart', async () => {
    const net = freshNetwork();
    const a = endpoint(net, 'a');
    a.t.start();
    const raw = rawChannel(net);
    raw.postMessage({ from: 'x', kind: 'join' });
    await waitFor(() => a.t.peers().includes('x'), 'first join');
    raw.postMessage({ from: 'x', kind: 'beat' });
    raw.postMessage({ from: 'x', kind: 'join' });
    await waitFor(() => a.log.length === 3, 'restart');
    expect(a.log).toEqual(['up:x', 'down:x', 'up:x']);
  });

  it('separates networks', async () => {
    const a = endpoint(freshNetwork(), 'a');
    const b = endpoint(freshNetwork(), 'b');
    const c = endpoint(freshNetwork(), 'c');
    a.t.start();
    b.t.start();
    c.t.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(a.t.peers()).toEqual([]);
    expect(b.t.peers()).toEqual([]);
  });

  it('ignores malformed frames and frames for other endpoints', async () => {
    const net = freshNetwork();
    const a = endpoint(net, 'a');
    a.t.start();
    const raw = rawChannel(net);
    raw.postMessage(null);
    raw.postMessage('text');
    raw.postMessage({ from: 5, kind: 'join' });
    raw.postMessage({ from: 'x', kind: 'bogus' });
    raw.postMessage({ from: 'x', kind: 'msg' });
    raw.postMessage({ from: 'x', kind: 'msg', msg: 'not-an-object' });
    raw.postMessage({ from: 'y', to: 'someone-else', kind: 'msg', msg: bye('not-for-a') });
    raw.postMessage({ from: 'a', kind: 'beat' });
    raw.postMessage({ from: 'z', kind: 'beat' });
    await waitFor(() => a.t.peers().includes('z'), 'valid frame');
    expect(a.log).toEqual(['up:z']);
  });
});

describe('Overlay over BroadcastChannel', () => {
  it('binds, floods, answers requests and says bye', async () => {
    const net = freshNetwork();
    const clock = new VirtualClock();
    const make = (i: number) => {
      const t = new BroadcastChannelTransport({ networkId: net, clock, id: `ep${i}` });
      const received: string[] = [];
      const kp = Keypair.fromRawEd25519Seed(sha256(`bc-node-${i}`));
      const overlay = new Overlay({
        keypair: kp,
        networkId: net,
        name: `tab-${i}`,
        clock,
        logger: nullLogger(clock),
        transports: [t],
        handlers: {
          onStellarMessage: (xdr) => {
            received.push(xdr);
          },
          onRequest: (body) =>
            body.kind === 'branchWeight' ? { kind: 'branchWeight', afterSeq: body.afterSeq, weight: i, lcl: { seq: 1, hash: '00' } } : null,
        },
      });
      cleanup.push(() => overlay.stop());
      return { overlay, received, kp };
    };
    const a = make(1);
    const b = make(2);
    a.overlay.start();
    b.overlay.start();
    await waitFor(() => a.overlay.peers().length === 1 && b.overlay.peers().length === 1, 'binding');
    expect(a.overlay.peers()[0].transports).toEqual(['broadcast']);
    expect(a.overlay.peers()[0].name).toBe('tab-2');

    const xdr = toBase64(utf8('between tabs'));
    b.overlay.floodStellar(xdr);
    await waitFor(() => a.received.length === 1, 'flood');

    const res = await a.overlay.request(b.kp.publicKey(), { kind: 'branchWeight', afterSeq: 4 });
    expect(res).toEqual({ kind: 'branchWeight', afterSeq: 4, weight: 2, lcl: { seq: 1, hash: '00' } });

    b.overlay.stop();
    await waitFor(() => a.overlay.peers().length === 0, 'bye');
  });

  it('floods to four tabs with one broadcast per hop, each delivered once', async () => {
    const net = freshNetwork();
    const clock = new VirtualClock();
    const tabs = [1, 2, 3, 4].map((i) => {
      const t = new BroadcastChannelTransport({ networkId: net, clock, id: `tab${i}` });
      const counts = { send: 0, broadcast: 0 };
      const send = t.send.bind(t);
      const broadcast = t.broadcast.bind(t);
      t.send = (peer, msg) => {
        if (msg.t === 'stellar') counts.send++;
        send(peer, msg);
      };
      t.broadcast = (msg) => {
        if (msg.t === 'stellar') counts.broadcast++;
        broadcast(msg);
      };
      const received: string[] = [];
      const overlay = new Overlay({
        keypair: Keypair.fromRawEd25519Seed(sha256(`bc-flood-${i}`)),
        networkId: net,
        name: `tab-${i}`,
        clock,
        logger: nullLogger(clock),
        transports: [t],
        handlers: {
          onStellarMessage: (xdr) => {
            received.push(xdr);
          },
          onRequest: () => null,
        },
      });
      cleanup.push(() => overlay.stop());
      overlay.start();
      return { overlay, received, counts };
    });
    await waitFor(() => tabs.every((t) => t.overlay.peers().length === 3), 'mesh of 4');
    const xdr = toBase64(utf8('to all tabs'));
    tabs[0].overlay.floodStellar(xdr);
    await waitFor(() => tabs.slice(1).every((t) => t.received.length === 1), 'flood');
    await new Promise((r) => setTimeout(r, 20));
    expect(tabs[0].received).toEqual([]);
    for (const t of tabs.slice(1)) expect(t.received).toEqual([xdr]);
    // The origin and each re-flooding tab broadcast once instead of sending per peer.
    for (const t of tabs) expect(t.counts).toEqual({ send: 0, broadcast: 1 });
  });
});
