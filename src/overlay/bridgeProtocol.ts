// MessagePort protocol between TrysteroHost (main thread) and BridgeTransport
// (worker). WebRTC is not available in workers, so the main thread owns the
// Trystero room and relays frames through a MessagePort.
//
// main -> worker: { type: 'up' | 'down', peer }, { type: 'msg', peer, msg }
//                 ('up' may carry `channel`: the DTLS channel id of the peer's
//                 connection; an 'up' with another channel is a new connection)
// worker -> main: { type: 'send', peer, msg }, { type: 'broadcast', msg },
//                 { type: 'ready' }   (worker started; host replays 'up' for current peers)
//                 { type: 'stopped' } (worker stopped; host stops relaying 'msg')

import type { WireMessage } from './types';

export type MainToWorker =
  | { type: 'up'; peer: string; channel?: string }
  | { type: 'down'; peer: string }
  | { type: 'msg'; peer: string; msg: WireMessage };

const CHANNEL_ID = /^[0-9a-f]{64}$/;

export type WorkerToMain =
  | { type: 'send'; peer: string; msg: WireMessage }
  | { type: 'broadcast'; msg: WireMessage }
  | { type: 'ready' }
  | { type: 'stopped' };

/** The subset of MessagePort the bridge uses (DOM and Node ports both fit). */
export interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  start?(): void;
}

const MAX_PEER_ID_LENGTH = 128;

function isPeerId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PEER_ID_LENGTH;
}

function isMsgObject(v: unknown): v is WireMessage {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseMainToWorker(data: unknown): MainToWorker | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case 'up':
      if (!isPeerId(m.peer)) return null;
      if (m.channel === undefined) return { type: 'up', peer: m.peer };
      return typeof m.channel === 'string' && CHANNEL_ID.test(m.channel) ? { type: 'up', peer: m.peer, channel: m.channel } : null;
    case 'down':
      return isPeerId(m.peer) ? { type: m.type, peer: m.peer } : null;
    case 'msg':
      return isPeerId(m.peer) && isMsgObject(m.msg) ? { type: 'msg', peer: m.peer, msg: m.msg } : null;
    default:
      return null;
  }
}

export function parseWorkerToMain(data: unknown): WorkerToMain | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case 'send':
      return isPeerId(m.peer) && isMsgObject(m.msg) ? { type: 'send', peer: m.peer, msg: m.msg } : null;
    case 'broadcast':
      return isMsgObject(m.msg) ? { type: 'broadcast', msg: m.msg } : null;
    case 'ready':
    case 'stopped':
      return { type: m.type };
    default:
      return null;
  }
}
