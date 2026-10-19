// Transport between tabs (workers) of one browser over BroadcastChannel.
// Channel: `browserchain:<networkIdHex[0..16]>`. Frames:
//   { from, to?, kind: 'join' | 'here' | 'beat' | 'leave' | 'msg', msg? }
// Presence: 'join' on start (others answer 'here'), 'beat' every 2 s, a peer
// is down after PEER_TIMEOUT_MS without frames, 'leave' on stop. Frames with
// a `to` for another endpoint are ignored.

import type { Clock, TimerHandle } from '../lib/clock';
import { PEER_TIMEOUT_MS } from '../lib/constants';
import type { Logger } from '../lib/log';
import type { Transport, TransportKind, TransportPeerId, WireMessage } from './types';
import { randomId } from './wire';

export type BroadcastFrameKind = 'join' | 'here' | 'beat' | 'leave' | 'msg';

export interface BroadcastFrame {
  from: string;
  to?: string;
  kind: BroadcastFrameKind;
  msg?: WireMessage;
}

/** The subset of BroadcastChannel this transport uses. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface BroadcastChannelTransportOptions {
  /** Network id (hex). The channel name uses its first 16 hex chars. */
  networkId: string;
  clock: Clock;
  logger?: Logger;
  /** Endpoint id. Default: 16 random hex chars. */
  id?: string;
  /** Default 2000 ms. */
  beatIntervalMs?: number;
  /** Default PEER_TIMEOUT_MS. */
  peerTimeoutMs?: number;
  /** Default: `new BroadcastChannel(name)`. */
  channelFactory?: (name: string) => BroadcastChannelLike;
}

const FRAME_KINDS: ReadonlySet<string> = new Set<BroadcastFrameKind>(['join', 'here', 'beat', 'leave', 'msg']);
const MAX_ID_LENGTH = 64;

export function broadcastChannelName(networkIdHex: string): string {
  return `browserchain:${networkIdHex.slice(0, 16)}`;
}

function parseFrame(data: unknown): BroadcastFrame | null {
  if (typeof data !== 'object' || data === null) return null;
  const f = data as Record<string, unknown>;
  if (typeof f.from !== 'string' || f.from.length === 0 || f.from.length > MAX_ID_LENGTH) return null;
  if (typeof f.kind !== 'string' || !FRAME_KINDS.has(f.kind)) return null;
  if (f.to !== undefined && typeof f.to !== 'string') return null;
  if (f.kind === 'msg' && (typeof f.msg !== 'object' || f.msg === null)) return null;
  return f as unknown as BroadcastFrame;
}

export class BroadcastChannelTransport implements Transport {
  readonly kind: TransportKind = 'broadcast';
  readonly id: string;
  readonly channelName: string;
  onPeerUp: ((peer: TransportPeerId) => void) | null = null;
  onPeerDown: ((peer: TransportPeerId) => void) | null = null;
  onMessage: ((peer: TransportPeerId, msg: WireMessage) => void) | null = null;

  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly beatIntervalMs: number;
  private readonly peerTimeoutMs: number;
  private readonly channelFactory: (name: string) => BroadcastChannelLike;
  private channel: BroadcastChannelLike | null = null;
  private timer: TimerHandle | null = null;
  /** Peer id -> last time we heard from it. */
  private readonly lastHeard = new Map<string, number>();

  constructor(opts: BroadcastChannelTransportOptions) {
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.id = opts.id ?? randomId(8);
    this.channelName = broadcastChannelName(opts.networkId);
    this.beatIntervalMs = opts.beatIntervalMs ?? 2000;
    this.peerTimeoutMs = opts.peerTimeoutMs ?? PEER_TIMEOUT_MS;
    this.channelFactory = opts.channelFactory ?? ((name) => new BroadcastChannel(name) as BroadcastChannelLike);
  }

  get running(): boolean {
    return this.channel !== null;
  }

  start(): void {
    if (this.channel) return;
    const ch = this.channelFactory(this.channelName);
    ch.onmessage = (ev: MessageEvent) => this.onFrame(ev.data);
    this.channel = ch;
    this.post({ from: this.id, kind: 'join' });
    this.scheduleBeat();
  }

  /** Sends 'leave' and closes the channel. Forgets peers without onPeerDown. */
  stop(): void {
    const ch = this.channel;
    if (!ch) return;
    this.post({ from: this.id, kind: 'leave' });
    this.channel = null;
    ch.onmessage = null;
    try {
      ch.close();
    } catch {
      // already closed
    }
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.lastHeard.clear();
  }

  send(peer: TransportPeerId, msg: WireMessage): void {
    if (!this.channel || !this.lastHeard.has(peer)) return;
    this.post({ from: this.id, to: peer, kind: 'msg', msg });
  }

  broadcast(msg: WireMessage): void {
    if (!this.channel) return;
    this.post({ from: this.id, kind: 'msg', msg });
  }

  peers(): TransportPeerId[] {
    return [...this.lastHeard.keys()];
  }

  private post(frame: BroadcastFrame): void {
    try {
      this.channel?.postMessage(frame);
    } catch (err) {
      this.logger?.warn(`broadcast post failed: ${(err as Error).message}`);
    }
  }

  private scheduleBeat(): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.channel) return;
      this.post({ from: this.id, kind: 'beat' });
      this.sweep();
      if (this.channel) this.scheduleBeat();
    }, this.beatIntervalMs);
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [peer, at] of [...this.lastHeard]) {
      if (now - at > this.peerTimeoutMs) this.peerDown(peer);
    }
  }

  private onFrame(data: unknown): void {
    if (!this.channel) return;
    const f = parseFrame(data);
    if (!f || f.from === this.id) return;
    if (f.to !== undefined && f.to !== this.id) return;
    if (f.kind === 'leave') {
      if (this.lastHeard.has(f.from)) this.peerDown(f.from);
      return;
    }
    // A join from a known endpoint means it restarted: report a fresh connection.
    if (f.kind === 'join' && this.lastHeard.has(f.from)) this.peerDown(f.from);
    if (!this.channel) return;
    const known = this.lastHeard.has(f.from);
    this.lastHeard.set(f.from, this.clock.now());
    if (!known) this.fire(() => this.onPeerUp?.(f.from));
    if (f.kind === 'join') this.post({ from: this.id, to: f.from, kind: 'here' });
    else if (f.kind === 'msg' && this.channel && this.lastHeard.has(f.from)) {
      const msg = f.msg as WireMessage;
      this.fire(() => this.onMessage?.(f.from, msg));
    }
  }

  private peerDown(peer: string): void {
    if (!this.lastHeard.delete(peer)) return;
    this.fire(() => this.onPeerDown?.(peer));
  }

  private fire(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger?.error(`broadcast transport callback failed: ${(err as Error).message}`);
    }
  }
}
