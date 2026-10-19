import { Keypair } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it } from 'vitest';
import { toBase64, toHex, utf8 } from '../lib/bytes';
import { VirtualClock } from '../lib/clock';
import { sha256, sha256Hex } from '../lib/hash';
import { nullLogger } from '../lib/log';
import { BridgeTransport } from './bridgeTransport';
import { Overlay } from './overlay';
import {
  NOSTR_RELAYS,
  TRYSTERO_ACTION,
  TrysteroHost,
  dtlsChannelId,
  trysteroRoomId,
  type JoinRoomFn,
  type RtcConnectionLike,
  type TrysteroActionLike,
  type TrysteroRoomLike,
} from './trysteroHost';
import type { WireMessage } from './types';

const NETWORK_ID = sha256Hex('BrowserChain bridge tests');

type Target = string | string[] | null | undefined;

class FakeAction implements TrysteroActionLike {
  readonly sent: { data: WireMessage; target: Target }[] = [];
  onMessage: ((data: unknown, context: { peerId: string }) => void) | null = null;

  constructor(private readonly room: FakeRoom) {}

  send(data: WireMessage, options?: { target?: string | string[] | null }): Promise<void> {
    this.sent.push({ data, target: options?.target });
    this.room.net?.route(this.room, data, options?.target ?? null);
    return Promise.resolve();
  }
}

/** A fake DTLS certificate per endpoint (its SHA-256 is the fingerprint). */
function certOf(id: string): Uint8Array {
  return utf8(`dtls-cert-${id}`);
}

function sdpWith(cert: Uint8Array): string {
  const fp = toHex(sha256(cert)).toUpperCase().match(/../g)!.join(':');
  return `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${fp}\r\n`;
}

/** The connection `self` holds to `remote`: our SDP, and the certificate the remote proved. */
function fakePc(self: string, remote: string, remoteCert = certOf(remote)): RtcConnectionLike {
  return {
    localDescription: { sdp: sdpWith(certOf(self)) },
    sctp: { transport: { getRemoteCertificates: () => [remoteCert.slice().buffer] } },
  };
}

class FakeRoom implements TrysteroRoomLike {
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  readonly actions = new Map<string, FakeAction>();
  /** Connection per joined peer (room.getPeers). */
  readonly pcs = new Map<string, RtcConnectionLike>();
  left = false;

  constructor(
    readonly config: Record<string, unknown>,
    readonly roomId: string,
    readonly selfId: string,
    readonly net?: FakeTrysteroNet,
  ) {}

  makeAction(namespace: string): FakeAction {
    const a = new FakeAction(this);
    this.actions.set(namespace, a);
    return a;
  }

  leave(): void {
    this.left = true;
    this.net?.leave(this);
  }

  get action(): FakeAction {
    return this.actions.get(TRYSTERO_ACTION)!;
  }

  getPeers(): Record<string, RtcConnectionLike> {
    return Object.fromEntries(this.pcs);
  }

  // Test helpers that play the remote side.
  join(peer: string, pc: RtcConnectionLike = fakePc(this.selfId, peer)): void {
    this.pcs.set(peer, pc);
    this.onPeerJoin?.(peer);
  }

  part(peer: string): void {
    this.pcs.delete(peer);
    this.onPeerLeave?.(peer);
  }

  receive(peer: string, data: unknown): void {
    this.action.onMessage?.(data, { peerId: peer });
  }
}

/** Connects fake rooms with the same room id, like a signalling server plus WebRTC. */
class FakeTrysteroNet {
  readonly rooms: FakeRoom[] = [];

  joinRoom(selfId: string): JoinRoomFn {
    return (config, roomId) => {
      const room = new FakeRoom(config as unknown as Record<string, unknown>, roomId, selfId, this);
      queueMicrotask(() => {
        for (const o of this.rooms) {
          if (o.left || o.roomId !== roomId) continue;
          o.join(selfId);
          room.join(o.selfId);
        }
        this.rooms.push(room);
      });
      return room;
    };
  }

  route(from: FakeRoom, data: WireMessage, target: Target): void {
    for (const o of this.rooms) {
      if (o === from || o.left || o.roomId !== from.roomId) continue;
      const hit = target === null || target === undefined || target === o.selfId || (Array.isArray(target) && target.includes(o.selfId));
      if (!hit) continue;
      const copy = JSON.parse(JSON.stringify(data)) as unknown;
      setTimeout(() => o.receive(from.selfId, copy), 0);
    }
  }

  leave(room: FakeRoom): void {
    for (const o of this.rooms) if (o !== room && !o.left && o.roomId === room.roomId) o.part(room.selfId);
  }
}

async function waitFor(pred: () => boolean, what = 'condition', timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Let queued port messages flow. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1));
}

const ports: MessagePort[] = [];

afterEach(() => {
  for (const p of ports.splice(0)) p.close();
});

function channel(): { main: MessagePort; worker: MessagePort } {
  const ch = new MessageChannel();
  ports.push(ch.port1, ch.port2);
  return { main: ch.port1, worker: ch.port2 };
}

function recordBridge(bridge: BridgeTransport): string[] {
  const log: string[] = [];
  bridge.onPeerUp = (p) => log.push(`up:${p}`);
  bridge.onPeerDown = (p) => log.push(`down:${p}`);
  bridge.onMessage = (p, m) => log.push(`msg:${p}:${m.t === 'bye' ? m.nodeId : m.t}`);
  return log;
}

function setup(opts: { roomConfig?: Record<string, unknown> } = {}) {
  const { main, worker } = channel();
  let room: FakeRoom | null = null;
  const joinRoom: JoinRoomFn = (config, roomId) => {
    room = new FakeRoom(config as unknown as Record<string, unknown>, roomId, 'self');
    return room;
  };
  const host = new TrysteroHost({ networkId: NETWORK_ID, port: main, joinRoom, roomConfig: opts.roomConfig });
  const bridge = new BridgeTransport(worker);
  const log = recordBridge(bridge);
  return { host, bridge, log, room: () => room!, main };
}

const bye = (n: string): WireMessage => ({ t: 'bye', nodeId: n });

describe('TrysteroHost', () => {
  it('joins the network room with the app id and limits', () => {
    const { host, room } = setup({ roomConfig: { password: 'pw', appId: 'ignored' } });
    host.start();
    expect(room().roomId).toBe(trysteroRoomId(NETWORK_ID));
    expect(room().roomId).toBe(`browserchain-${NETWORK_ID.slice(0, 16)}`);
    expect(room().config).toMatchObject({ appId: 'browserchain', password: 'pw', maxReceiveBytes: 8 * 1024 * 1024 });
    // an explicit, shared relay list (Trystero's own pick had a dead relay)
    expect(room().config.relayConfig).toEqual({ urls: [...NOSTR_RELAYS], redundancy: NOSTR_RELAYS.length });
    expect(NOSTR_RELAYS.length).toBeGreaterThanOrEqual(5);
    expect(NOSTR_RELAYS.every((u) => u.startsWith('wss://'))).toBe(true);
    expect(NOSTR_RELAYS).not.toContain('wss://nostr.robosats.org');
    expect([...room().actions.keys()]).toEqual(['m']);
    host.start();
    expect(host.running).toBe(true);
  });
});

describe('DTLS channel ids', () => {
  it('both ends of a connection get the same id; any other connection gets another', () => {
    const ab = dtlsChannelId(fakePc('a', 'b'));
    expect(ab).toMatch(/^[0-9a-f]{64}$/);
    expect(dtlsChannelId(fakePc('b', 'a'))).toBe(ab);
    // a relay with one certificate for both of its connections still sits on two channels
    expect(dtlsChannelId(fakePc('a', 'm'))).not.toBe(dtlsChannelId(fakePc('b', 'm')));
    expect(dtlsChannelId(fakePc('a', 'm'))).not.toBe(ab);
    // a new connection between the same ends (new certificates) is a new channel
    expect(dtlsChannelId(fakePc('a', 'b', certOf('b-again')))).not.toBe(ab);
  });

  it('is null unless the browser tells us both certificates', () => {
    expect(dtlsChannelId(undefined)).toBeNull();
    expect(dtlsChannelId({ localDescription: { sdp: sdpWith(certOf('a')) } })).toBeNull();
    expect(dtlsChannelId({ ...fakePc('a', 'b'), localDescription: null })).toBeNull();
    expect(dtlsChannelId({ ...fakePc('a', 'b'), sctp: { transport: { getRemoteCertificates: () => [] } } })).toBeNull();
    // our SDP must name exactly one sha-256 fingerprint
    const two = { ...fakePc('a', 'b'), localDescription: { sdp: sdpWith(certOf('a')) + sdpWith(certOf('x')).split('\r\n').slice(-2).join('\r\n') } };
    expect(dtlsChannelId(two)).toBeNull();
    const throwing = { ...fakePc('a', 'b'), sctp: { transport: { getRemoteCertificates: (): ArrayBuffer[] => { throw new Error('closed'); } } } };
    expect(dtlsChannelId(throwing)).toBeNull();
  });
});

describe('BridgeTransport <-> TrysteroHost', () => {
  it('relays peers and messages both ways', async () => {
    const { host, bridge, log, room } = setup();
    host.start();
    bridge.start();
    room().join('p1');
    await waitFor(() => log.includes('up:p1'), 'peer up');
    expect(bridge.peers()).toEqual(['p1']);
    expect(host.peers()).toEqual(['p1']);

    room().receive('p1', bye('hello-from-p1'));
    await waitFor(() => log.includes('msg:p1:hello-from-p1'), 'message');

    bridge.send('p1', bye('to-p1'));
    bridge.send('stranger', bye('nobody'));
    bridge.broadcast(bye('to-all'));
    await waitFor(() => room().action.sent.length === 2, 'sends');
    expect(room().action.sent).toEqual([
      { data: bye('to-p1'), target: 'p1' },
      { data: bye('to-all'), target: undefined },
    ]);

    room().part('p1');
    await waitFor(() => log.includes('down:p1'), 'peer down');
    expect(bridge.peers()).toEqual([]);
    expect(log).toEqual(['up:p1', 'msg:p1:hello-from-p1', 'down:p1']);
  });

  it('a worker that starts late sees the queued history and current peers once', async () => {
    const { host, bridge, log, room } = setup();
    host.start();
    room().join('p1');
    room().join('p2');
    room().part('p2');
    room().receive('p1', bye('early'));
    await flush();
    bridge.start();
    await waitFor(() => log.includes('msg:p1:early'), 'queued message');
    await flush();
    expect(log).toEqual(['up:p1', 'up:p2', 'down:p2', 'msg:p1:early']);
    expect(bridge.peers()).toEqual(['p1']);
  });

  it('a stopped worker gets no messages; a restart replays current peers', async () => {
    const { host, bridge, log, room } = setup();
    host.start();
    bridge.start();
    room().join('p1');
    await waitFor(() => log.includes('up:p1'), 'peer up');
    bridge.stop();
    expect(bridge.peers()).toEqual([]);
    await flush();
    room().receive('p1', bye('while-stopped'));
    bridge.send('p1', bye('not-sent'));
    await flush();
    bridge.start();
    await waitFor(() => log.filter((l) => l === 'up:p1').length === 2, 'replayed peer');
    room().receive('p1', bye('after-restart'));
    await waitFor(() => log.includes('msg:p1:after-restart'), 'message after restart');
    expect(log).toEqual(['up:p1', 'up:p1', 'msg:p1:after-restart']);
    expect(room().action.sent).toEqual([]);
  });

  it('stopping the host leaves the room and reports every peer down', async () => {
    const { host, bridge, log, room } = setup();
    host.start();
    bridge.start();
    room().join('p1');
    room().join('p2');
    await waitFor(() => bridge.peers().length === 2, 'two peers');
    await host.stop();
    expect(room().left).toBe(true);
    expect(host.running).toBe(false);
    await waitFor(() => log.includes('down:p1') && log.includes('down:p2'), 'peers down');
    bridge.broadcast(bye('after-stop'));
    await flush();
    expect(room().action.sent).toEqual([]);
    room().join('p3');
    await flush();
    expect(bridge.peers()).toEqual([]);
  });

  it('brings a peer up before its first message even without a join', async () => {
    const { host, bridge, log, room } = setup();
    host.start();
    bridge.start();
    room().receive('p9', bye('surprise'));
    await waitFor(() => log.length === 2, 'events');
    expect(log).toEqual(['up:p9', 'msg:p9:surprise']);
  });

  it('tells the worker the channel of each connection; a replaced connection is a new link', async () => {
    const { host, bridge, log, room } = setup();
    host.start();
    bridge.start();
    room().join('p1');
    await waitFor(() => log.includes('up:p1'), 'peer up');
    const first = dtlsChannelId(fakePc('self', 'p1'));
    expect(bridge.channelId('p1')).toBe(first);
    // Trystero activates the same peer id again on a new connection, without a leave
    room().join('p1', fakePc('self', 'p1', certOf('p1-new')));
    await waitFor(() => log.length === 3, 'down and up');
    expect(log).toEqual(['up:p1', 'down:p1', 'up:p1']);
    const second = dtlsChannelId(fakePc('self', 'p1', certOf('p1-new')));
    expect(second).not.toBe(first);
    expect(bridge.channelId('p1')).toBe(second);
    // the same connection joining again changes nothing
    room().join('p1', fakePc('self', 'p1', certOf('p1-new')));
    await flush();
    expect(log).toEqual(['up:p1', 'down:p1', 'up:p1']);
    // a worker restart learns the channel again
    bridge.stop();
    expect(bridge.channelId('p1')).toBeNull();
    bridge.start();
    await waitFor(() => log.length === 4, 'replayed peer');
    expect(bridge.channelId('p1')).toBe(second);
    room().part('p1');
    await waitFor(() => log.includes('down:p1') && log.length === 5, 'peer down');
    expect(bridge.channelId('p1')).toBeNull();
  });

  it('a peer without a known connection comes up without a channel', async () => {
    const { host, bridge, log, room } = setup();
    host.start();
    bridge.start();
    room().join('p2', {});
    await waitFor(() => log.includes('up:p2'), 'peer up');
    expect(bridge.channelId('p2')).toBeNull();
    // a later activation with a known channel is a new link
    room().join('p2');
    await waitFor(() => log.length === 3, 'down and up');
    expect(bridge.channelId('p2')).toBe(dtlsChannelId(fakePc('self', 'p2')));
  });

  it('ignores malformed frames on both sides', async () => {
    const { host, bridge, log, room, main } = setup();
    host.start();
    bridge.start();
    room().join('p1');
    await waitFor(() => log.includes('up:p1'), 'peer up');
    room().receive('p1', 'just a string');
    room().receive('p1', [1, 2, 3]);
    room().receive('p1', null);
    main.postMessage({ type: 'msg', peer: 5, msg: {} });
    main.postMessage({ type: 'up' });
    main.postMessage({ type: 'up', peer: 'p8', channel: 'not-a-channel-id' });
    main.postMessage({ type: 'nonsense', peer: 'p7' });
    main.postMessage('garbage');
    await flush();
    expect(log).toEqual(['up:p1']);
    // Worker -> main garbage is ignored too.
    const { worker } = { worker: (bridge as unknown as { port: MessagePort }).port };
    worker.postMessage({ type: 'send', peer: 'p1' });
    worker.postMessage({ type: 'broadcast' });
    worker.postMessage({ type: 'what' });
    await flush();
    expect(room().action.sent).toEqual([]);
  });
});

describe('Overlay over the WebRTC bridge', () => {
  function makeNode(net: FakeTrysteroNet, clock: VirtualClock, i: number) {
    const { main, worker } = channel();
    const host = new TrysteroHost({ networkId: NETWORK_ID, port: main, joinRoom: net.joinRoom(`peer-${i}`) });
    const bridge = new BridgeTransport(worker);
    const received: string[] = [];
    const kp = Keypair.fromRawEd25519Seed(sha256(`bridge-node-${i}`));
    const overlay = new Overlay({
      keypair: kp,
      networkId: NETWORK_ID,
      name: `node-${i}`,
      clock,
      logger: nullLogger(clock),
      transports: [bridge],
      handlers: {
        onStellarMessage: (xdr) => {
          received.push(xdr);
        },
        onRequest: (body) => (body.kind === 'scpState' ? { kind: 'scpState', envelopes: [`from-${i}`] } : null),
      },
    });
    return { host, bridge, overlay, received, kp };
  }

  it('binds, floods and answers requests', async () => {
    const net = new FakeTrysteroNet();
    const clock = new VirtualClock();
    const a = makeNode(net, clock, 1);
    const b = makeNode(net, clock, 2);
    a.host.start();
    a.overlay.start();
    b.host.start();
    b.overlay.start();
    await waitFor(() => a.overlay.peers().length === 1 && b.overlay.peers().length === 1, 'overlay binding');
    expect(a.overlay.peers()[0].nodeId).toBe(b.kp.publicKey());
    expect(a.overlay.peers()[0].transports).toEqual(['webrtc']);
    // each side bound the other on a hello made for their DTLS channel
    expect(a.overlay.stats().channelBound).toBe(1);
    expect(b.overlay.stats().channelBound).toBe(1);

    const xdr = toBase64(utf8('over webrtc'));
    a.overlay.floodStellar(xdr);
    await waitFor(() => b.received.length === 1, 'flood');
    expect(b.received).toEqual([xdr]);

    const res = await a.overlay.request(b.kp.publicKey(), { kind: 'scpState', fromSlot: 3 });
    expect(res).toEqual({ kind: 'scpState', envelopes: ['from-2'] });

    b.overlay.stop();
    await waitFor(() => a.overlay.peers().length === 0, 'bye');
    await a.host.stop();
    await b.host.stop();
    a.overlay.stop();
  });
});
