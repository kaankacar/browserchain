// Transport wrapper used by the node:
// - it tells the node which peer a `bye` comes from, so a graceful leave can
//   take effect at once (the overlay reports every disconnect the same way);
// - `freeze()` turns the transport into a black hole without telling peers
//   (a crashed or hung process, used by the simulation).

import type { Transport, TransportKind, TransportPeerId, WireMessage } from '../overlay/types';

export class TapTransport implements Transport {
  onPeerUp: ((peer: TransportPeerId) => void) | null = null;
  onPeerDown: ((peer: TransportPeerId) => void) | null = null;
  onMessage: ((peer: TransportPeerId, msg: WireMessage) => void) | null = null;
  private frozen = false;

  /**
   * `onBye(nodeId)` runs before the overlay sees a bye message and
   * `afterMessage()` right after it handled any message.
   */
  constructor(
    readonly inner: Transport,
    private readonly onBye: (nodeId: string) => void,
    private readonly afterMessage: () => void,
  ) {}

  get kind(): TransportKind {
    return this.inner.kind;
  }

  start(): void | Promise<void> {
    this.inner.onPeerUp = (p) => {
      if (!this.frozen) this.onPeerUp?.(p);
    };
    this.inner.onPeerDown = (p) => {
      if (!this.frozen) this.onPeerDown?.(p);
    };
    this.inner.onMessage = (p, m) => {
      if (this.frozen) return;
      const msg = m as Partial<WireMessage> | null;
      if (msg && msg.t === 'bye' && typeof (msg as { nodeId?: unknown }).nodeId === 'string') {
        this.onBye((msg as { nodeId: string }).nodeId);
      }
      try {
        this.onMessage?.(p, m);
      } finally {
        this.afterMessage();
      }
    };
    return this.inner.start();
  }

  stop(): void {
    this.inner.onPeerUp = null;
    this.inner.onPeerDown = null;
    this.inner.onMessage = null;
    this.inner.stop();
  }

  send(peer: TransportPeerId, msg: WireMessage): void {
    if (!this.frozen) this.inner.send(peer, msg);
  }

  broadcast(msg: WireMessage): void {
    if (!this.frozen) this.inner.broadcast(msg);
  }

  peers(): TransportPeerId[] {
    return this.frozen ? [] : this.inner.peers();
  }

  /** The secure channel id of the wrapped transport (hellos on WebRTC links sign it). */
  channelId(peer: TransportPeerId): string | null {
    return this.inner.channelId?.(peer) ?? null;
  }

  /** Drop all traffic in both directions without notifying anyone. */
  freeze(): void {
    this.frozen = true;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }
}
