// Worker side of the WebRTC bridge: a Transport backed by a MessagePort whose
// other end is held by TrysteroHost on the main thread. Must not import
// trysteroHost.ts (that would pull WebRTC code into the worker).

import type { Logger } from '../lib/log';
import { parseMainToWorker, type PortLike, type WorkerToMain } from './bridgeProtocol';
import type { Transport, TransportKind, TransportPeerId, WireMessage } from './types';

export interface BridgeTransportOptions {
  /** Reported transport kind. Default 'webrtc' (what the bridge carries). */
  kind?: TransportKind;
  logger?: Logger;
}

export class BridgeTransport implements Transport {
  readonly kind: TransportKind;
  onPeerUp: ((peer: TransportPeerId) => void) | null = null;
  onPeerDown: ((peer: TransportPeerId) => void) | null = null;
  onMessage: ((peer: TransportPeerId, msg: WireMessage) => void) | null = null;

  private readonly logger: Logger | undefined;
  private readonly known = new Set<string>();
  /** Peer -> channel id of its current connection (from the host's 'up'). */
  private readonly channels = new Map<string, string>();
  private started = false;
  private readonly listener = (ev: MessageEvent): void => this.onPortMessage(ev.data);

  constructor(
    private readonly port: PortLike,
    opts: BridgeTransportOptions = {},
  ) {
    this.kind = opts.kind ?? 'webrtc';
    this.logger = opts.logger;
  }

  get running(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.port.addEventListener('message', this.listener);
    this.port.start?.();
    this.post({ type: 'ready' });
  }

  /** Forgets peers without calling onPeerDown. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.port.removeEventListener('message', this.listener);
    this.post({ type: 'stopped' });
    this.known.clear();
    this.channels.clear();
  }

  send(peer: TransportPeerId, msg: WireMessage): void {
    if (!this.started || !this.known.has(peer)) return;
    this.post({ type: 'send', peer, msg });
  }

  broadcast(msg: WireMessage): void {
    if (!this.started) return;
    this.post({ type: 'broadcast', msg });
  }

  peers(): TransportPeerId[] {
    return [...this.known];
  }

  /** DTLS channel id of the peer's connection, as the host computed it; null when unknown. */
  channelId(peer: TransportPeerId): string | null {
    return this.channels.get(peer) ?? null;
  }

  private post(m: WorkerToMain): void {
    try {
      this.port.postMessage(m);
    } catch (err) {
      this.logger?.warn(`bridge post failed: ${(err as Error).message}`);
    }
  }

  private onPortMessage(data: unknown): void {
    if (!this.started) return;
    const m = parseMainToWorker(data);
    if (!m) return;
    switch (m.type) {
      case 'up':
        this.peerUp(m.peer, m.channel);
        return;
      case 'down':
        this.channels.delete(m.peer);
        if (this.known.delete(m.peer)) this.fire(() => this.onPeerDown?.(m.peer));
        return;
      case 'msg':
        this.peerUp(m.peer);
        if (this.started && this.known.has(m.peer)) this.fire(() => this.onMessage?.(m.peer, m.msg));
        return;
    }
  }

  private peerUp(peer: string, channel?: string): void {
    if (this.known.has(peer)) {
      // Same peer id on another channel: a new connection replaced the old one.
      if (channel === undefined || channel === this.channels.get(peer)) return;
      this.known.delete(peer);
      this.channels.delete(peer);
      this.fire(() => this.onPeerDown?.(peer));
      if (!this.started) return;
    }
    this.known.add(peer);
    if (channel !== undefined) this.channels.set(peer, channel);
    this.fire(() => this.onPeerUp?.(peer));
  }

  private fire(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger?.error(`bridge transport callback failed: ${(err as Error).message}`);
    }
  }
}
