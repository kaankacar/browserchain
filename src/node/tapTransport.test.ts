import { describe, expect, it } from 'vitest';
import type { Transport, TransportKind, TransportPeerId, WireMessage } from '../overlay/types';
import { TapTransport } from './tapTransport';

/** A bare transport; `channels` gives the secure channel id per peer when set. */
function inner(channels?: Record<string, string>): Transport {
  const t: Transport = {
    kind: 'webrtc' as TransportKind,
    start: () => undefined,
    stop: () => undefined,
    send: (_p: TransportPeerId, _m: WireMessage) => undefined,
    broadcast: (_m: WireMessage) => undefined,
    peers: () => [],
    onPeerUp: null,
    onPeerDown: null,
    onMessage: null,
  };
  if (channels) t.channelId = (peer) => channels[peer] ?? null;
  return t;
}

describe('TapTransport', () => {
  it('forwards the channel id of the wrapped transport', () => {
    const id = 'ab'.repeat(32);
    const tap = new TapTransport(inner({ p1: id }), () => undefined, () => undefined);
    expect(typeof tap.channelId).toBe('function');
    expect(tap.channelId?.('p1')).toBe(id);
    expect(tap.channelId?.('p2')).toBeNull();
  });

  it('reports null when the wrapped transport has no channel ids', () => {
    const tap = new TapTransport(inner(), () => undefined, () => undefined);
    expect(typeof tap.channelId).toBe('function');
    expect(tap.channelId!('p1')).toBeNull();
  });
});
