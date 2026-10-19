// In-memory network for tests and the simulation. Delivery runs through the
// injected Clock with per-link latency drawn from a seeded RNG, so a run on a
// VirtualClock is reproducible.
//
// Link model:
// - A link between two started transports is up unless a partition or
//   disconnect() separates them. Each up transition starts a new link epoch.
// - Abrupt cuts (partition, disconnect) bump the epoch: messages in flight on
//   the old epoch are lost, like a dropped connection.
// - stop() is graceful: messages the stopping transport already sent still
//   arrive, and peers see it go down after the last of them.
// - Peer up/down notifications are delivered through the clock, never
//   synchronously inside partition()/start()/stop().

import type { Clock } from '../lib/clock';
import { sha256Hex } from '../lib/hash';
import { seededRng, type Rng } from '../lib/random';
import type { Transport, TransportKind, TransportPeerId, WireMessage } from './types';

export type LatencyFn = (from: string, to: string, rng: Rng) => number;

export interface MemoryNetworkOptions {
  clock: Clock;
  /** Seed for the default RNG (latency and drops). Default 1. */
  seed?: number;
  /** Custom RNG; overrides `seed`. */
  rng?: Rng;
  /** One-way latency per message in ms. Default: uniform 5..25 ms. */
  latencyMs?: LatencyFn;
  /** Probability (0..1) that a message is lost. Default 0. */
  dropRate?: number;
  /** Keep per-link FIFO order even when latency varies. Default true. */
  fifo?: boolean;
}

export interface MemoryNodeStats {
  sent: number;
  received: number;
  dropped: number;
  bytesSent: number;
  bytesReceived: number;
}

export interface MemoryNetworkStats {
  /** Messages put on a live link (before random drops). */
  sent: number;
  delivered: number;
  /** Lost to the drop rate, cuts, stopped receivers or unknown peers. */
  dropped: number;
  bytesSent: number;
  bytesDelivered: number;
  peerUps: number;
  peerDowns: number;
  callbackErrors: number;
  perNode: Record<string, MemoryNodeStats>;
}

/** Default latency: uniform 5..25 ms. */
export const defaultLatency: LatencyFn = (_from, _to, rng) => 5 + Math.floor(rng() * 21);

interface NodeRec {
  id: string;
  transport: MemoryTransport;
  online: boolean;
  connected: boolean;
  session: number;
  stats: MemoryNodeStats;
}

interface LinkRec {
  up: boolean;
  epoch: number;
}

interface InFlight {
  from: string;
  to: string;
  epoch: number;
  toSession: number;
  payload: WireMessage;
  bytes: number;
}

const SEP = '\u0000';

function pairKey(a: string, b: string): string {
  return a < b ? `${a}${SEP}${b}` : `${b}${SEP}${a}`;
}

function dirKey(from: string, to: string): string {
  return `${from}${SEP}>${to}`;
}

function zeroStats(): MemoryNodeStats {
  return { sent: 0, received: 0, dropped: 0, bytesSent: 0, bytesReceived: 0 };
}

function jsonSize(msg: WireMessage): number {
  // Throws on values that real transports (JSON over WebRTC) cannot carry.
  return JSON.stringify(msg).length;
}

export class MemoryNetwork {
  readonly clock: Clock;
  private readonly rng: Rng;
  private latency: LatencyFn;
  private dropRate: number;
  private readonly fifo: boolean;
  private readonly nodes = new Map<string, NodeRec>();
  private readonly links = new Map<string, LinkRec>();
  private readonly lastArrival = new Map<string, number>();
  private groups: Map<string, number> | null = null;
  private counters = {
    sent: 0,
    delivered: 0,
    dropped: 0,
    bytesSent: 0,
    bytesDelivered: 0,
    peerUps: 0,
    peerDowns: 0,
    callbackErrors: 0,
  };

  constructor(opts: MemoryNetworkOptions) {
    this.clock = opts.clock;
    this.rng = opts.rng ?? seededRng(opts.seed ?? 1);
    this.latency = opts.latencyMs ?? defaultLatency;
    this.dropRate = clampRate(opts.dropRate ?? 0);
    this.fifo = opts.fifo ?? true;
  }

  /** Create an endpoint. Ids must be unique; use the node name or index. */
  createTransport(id: string, opts: { kind?: TransportKind } = {}): MemoryTransport {
    if (!id) throw new Error('MemoryNetwork: empty transport id');
    if (this.nodes.has(id)) throw new Error(`MemoryNetwork: duplicate transport id ${id}`);
    const transport = new MemoryTransport(this, id, opts.kind ?? 'memory');
    this.nodes.set(id, { id, transport, online: false, connected: true, session: 0, stats: zeroStats() });
    return transport;
  }

  /** Stop and forget an endpoint. Its id can be reused afterwards. */
  removeTransport(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.transport.stop();
    this.nodes.delete(id);
  }

  getTransport(id: string): MemoryTransport | undefined {
    return this.nodes.get(id)?.transport;
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }

  setLatency(fn: LatencyFn): void {
    this.latency = fn;
  }

  setDropRate(rate: number): void {
    this.dropRate = clampRate(rate);
  }

  /**
   * Split the network. Two endpoints can talk only if they are in the same
   * group. Endpoints not listed in any group form one extra group together.
   */
  partition(groups: string[][]): void {
    const m = new Map<string, number>();
    groups.forEach((g, i) => g.forEach((id) => m.set(id, i)));
    this.groups = m;
    this.update();
  }

  /** Remove all partitions. */
  heal(): void {
    this.groups = null;
    this.update();
  }

  /** Cut every link of one endpoint (abrupt: in-flight messages are lost). */
  disconnect(id: string): void {
    const node = this.requireNode(id);
    if (!node.connected) return;
    node.connected = false;
    this.update();
  }

  reconnect(id: string): void {
    const node = this.requireNode(id);
    if (node.connected) return;
    node.connected = true;
    this.update();
  }

  /** Whether the link between a and b is up right now. */
  isLinked(a: string, b: string): boolean {
    return a !== b && (this.links.get(pairKey(a, b))?.up ?? false);
  }

  stats(): MemoryNetworkStats {
    const perNode: Record<string, MemoryNodeStats> = {};
    for (const n of this.nodes.values()) perNode[n.id] = { ...n.stats };
    return { ...this.counters, perNode };
  }

  resetStats(): void {
    for (const k of Object.keys(this.counters) as (keyof typeof this.counters)[]) this.counters[k] = 0;
    for (const n of this.nodes.values()) n.stats = zeroStats();
  }

  // ------------------------------------------------------------ internals used by MemoryTransport

  /** @internal */
  _attach(id: string): void {
    const node = this.requireNode(id);
    node.online = true;
    node.session++;
    this.update();
  }

  /** @internal Graceful stop: keep the link epoch so sent messages still arrive. */
  _detach(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.online = false;
    node.session++;
    const now = this.clock.now();
    for (const other of this.sortedIds()) {
      if (other === id) continue;
      const link = this.links.get(pairKey(id, other));
      if (!link || !link.up) continue;
      link.up = false;
      const drainAt = Math.max(now, this.lastArrival.get(dirKey(id, other)) ?? now);
      this.wake(other, id, drainAt - now);
    }
  }

  /** @internal */
  _linkState(a: string, b: string): LinkRec | undefined {
    return this.links.get(pairKey(a, b));
  }

  /** @internal */
  _transmit(from: string, to: string, msg: WireMessage, size?: number): void {
    const src = this.nodes.get(from);
    const link = this.links.get(pairKey(from, to));
    const dest = this.nodes.get(to);
    if (!src) return;
    if (!link || !link.up || !dest) {
      this.countDrop(src);
      return;
    }
    const bytes = size ?? jsonSize(msg);
    this.counters.sent++;
    this.counters.bytesSent += bytes;
    src.stats.sent++;
    src.stats.bytesSent += bytes;
    if (this.dropRate > 0 && this.rng() < this.dropRate) {
      this.countDrop(src);
      return;
    }
    const payload = structuredClone(msg);
    const now = this.clock.now();
    const lat = this.latency(from, to, this.rng);
    let at = now + (Number.isFinite(lat) ? Math.max(0, lat) : 0);
    const key = dirKey(from, to);
    const last = this.lastArrival.get(key) ?? -Infinity;
    if (this.fifo && at < last) at = last;
    if (at > last) this.lastArrival.set(key, at);
    const flight: InFlight = { from, to, epoch: link.epoch, toSession: dest.session, payload, bytes };
    this.clock.setTimeout(() => this.deliver(flight), at - now);
  }

  /** @internal */
  _countLocalDrop(from: string): void {
    const src = this.nodes.get(from);
    if (src) this.countDrop(src);
  }

  /** @internal */
  _notePeerChange(up: boolean): void {
    if (up) this.counters.peerUps++;
    else this.counters.peerDowns++;
  }

  /** @internal */
  _noteCallbackError(err: unknown): void {
    this.counters.callbackErrors++;
    console.error('MemoryNetwork: transport callback failed', err);
  }

  // ------------------------------------------------------------ private

  private deliver(f: InFlight): void {
    const dest = this.nodes.get(f.to);
    const link = this.links.get(pairKey(f.from, f.to));
    if (!dest || !dest.online || dest.session !== f.toSession || !link || link.epoch !== f.epoch) {
      this.counters.dropped++;
      if (dest) dest.stats.dropped++;
      return;
    }
    const t = dest.transport;
    if (!t._hasPeer(f.from)) {
      // The up notice is still queued; apply it first if the link is live.
      if (link.up) t._reconcile(f.from);
      if (!t._hasPeer(f.from)) {
        this.counters.dropped++;
        dest.stats.dropped++;
        return;
      }
    }
    this.counters.delivered++;
    this.counters.bytesDelivered += f.bytes;
    dest.stats.received++;
    dest.stats.bytesReceived += f.bytes;
    t._deliver(f.from, f.payload);
  }

  private update(): void {
    const ids = this.sortedIds();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const want = this.canTalk(a, b);
        const key = pairKey(a, b);
        let link = this.links.get(key);
        if (!link) {
          if (!want) continue;
          link = { up: false, epoch: 0 };
          this.links.set(key, link);
        }
        if (want === link.up) continue;
        link.up = want;
        link.epoch++;
        this.lastArrival.delete(dirKey(a, b));
        this.lastArrival.delete(dirKey(b, a));
        this.wake(a, b, 0);
        this.wake(b, a, 0);
      }
    }
  }

  private canTalk(a: string, b: string): boolean {
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (!na || !nb || !na.online || !nb.online || !na.connected || !nb.connected) return false;
    if (!this.groups) return true;
    return (this.groups.get(a) ?? -1) === (this.groups.get(b) ?? -1);
  }

  private wake(target: string, peer: string, delayMs: number): void {
    this.clock.setTimeout(() => this.nodes.get(target)?.transport._reconcile(peer), Math.max(0, delayMs));
  }

  private countDrop(src: NodeRec): void {
    this.counters.dropped++;
    src.stats.dropped++;
  }

  private requireNode(id: string): NodeRec {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`MemoryNetwork: unknown transport ${id}`);
    return node;
  }

  private sortedIds(): string[] {
    return [...this.nodes.keys()].sort();
  }
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}

/** One endpoint of a MemoryNetwork. */
export class MemoryTransport implements Transport {
  readonly kind: TransportKind;
  readonly id: string;
  onPeerUp: ((peer: TransportPeerId) => void) | null = null;
  onPeerDown: ((peer: TransportPeerId) => void) | null = null;
  onMessage: ((peer: TransportPeerId, msg: WireMessage) => void) | null = null;

  /** Peer id -> link epoch this endpoint has seen. */
  private readonly view = new Map<string, number>();
  private started = false;

  constructor(
    private readonly net: MemoryNetwork,
    id: string,
    kind: TransportKind,
  ) {
    this.id = id;
    this.kind = kind;
  }

  get running(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.net._attach(this.id);
  }

  /** Forgets peers without calling onPeerDown. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.view.clear();
    this.net._detach(this.id);
  }

  send(peer: TransportPeerId, msg: WireMessage): void {
    if (!this.started || !this.view.has(peer)) {
      this.net._countLocalDrop(this.id);
      return;
    }
    this.net._transmit(this.id, peer, msg);
  }

  broadcast(msg: WireMessage): void {
    if (!this.started) return;
    const size = jsonSize(msg);
    for (const peer of [...this.view.keys()].sort()) this.net._transmit(this.id, peer, msg, size);
  }

  peers(): TransportPeerId[] {
    return [...this.view.keys()];
  }

  /** Channel id of the link to `peer`: the same at both ends, new after every link reset. */
  channelId(peer: TransportPeerId): string | null {
    const epoch = this.view.get(peer);
    return epoch === undefined ? null : sha256Hex(`memory-channel${SEP}${pairKey(this.id, peer)}${SEP}${epoch}`);
  }

  /** @internal */
  _hasPeer(peer: string): boolean {
    return this.view.has(peer);
  }

  /** @internal Bring this endpoint's view of `peer` in line with the link state. */
  _reconcile(peer: string): void {
    if (!this.started) return;
    const link = this.net._linkState(this.id, peer);
    const seen = this.view.get(peer);
    if (!link || !link.up) {
      if (seen !== undefined) {
        this.view.delete(peer);
        this.fireDown(peer);
      }
      return;
    }
    if (seen === link.epoch) return;
    if (seen !== undefined) {
      // The link was reset since we last saw it: report down, then up.
      this.view.delete(peer);
      this.fireDown(peer);
      if (!this.started) return;
    }
    this.view.set(peer, link.epoch);
    this.net._notePeerChange(true);
    try {
      this.onPeerUp?.(peer);
    } catch (err) {
      this.net._noteCallbackError(err);
    }
  }

  /** @internal */
  _deliver(from: string, msg: WireMessage): void {
    try {
      this.onMessage?.(from, msg);
    } catch (err) {
      this.net._noteCallbackError(err);
    }
  }

  private fireDown(peer: string): void {
    this.net._notePeerChange(false);
    try {
      this.onPeerDown?.(peer);
    } catch (err) {
      this.net._noteCallbackError(err);
    }
  }
}
