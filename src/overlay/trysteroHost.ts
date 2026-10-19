// Main-thread side of the WebRTC bridge. Joins the Trystero room (Nostr
// strategy) `browserchain-<networkIdHex[0..16]>` with appId `browserchain` and
// relays frames to BridgeTransport in the worker through a MessagePort.
// Main thread only: worker code must never import this file.

import { joinRoom as trysteroJoinRoom, type JoinRoomConfig } from 'trystero';
import { toHex } from '../lib/bytes';
import { sha256, sha256Hex } from '../lib/hash';
import type { Logger } from '../lib/log';
import { parseWorkerToMain, type MainToWorker, type PortLike } from './bridgeProtocol';
import type { WireMessage } from './types';

/** The parts of an RTCPeerConnection the host reads to name its DTLS channel. */
export interface RtcConnectionLike {
  localDescription?: { sdp?: string } | null;
  sctp?: { transport?: { getRemoteCertificates?(): ArrayBuffer[] } | null } | null;
}

/** The sha-256 certificate fingerprint in our own SDP (lowercase hex, no colons); null unless there is exactly one. */
function localFingerprint(sdp: string | undefined): string | null {
  if (!sdp) return null;
  const found = new Set<string>();
  for (const m of sdp.matchAll(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)\s*$/gim)) found.add(m[1].replace(/:/g, '').toLowerCase());
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Channel id of a WebRTC connection: SHA-256 over both DTLS certificate
 * fingerprints, sorted, so both ends get the same id and any other
 * connection gets another. Ours comes from our own SDP; the remote one from
 * the certificate the remote proved in the DTLS handshake (its SDP is
 * written by the remote, so it is not used). Null when the browser does not
 * expose both (the overlay then binds the link without channel protection).
 */
export function dtlsChannelId(pc: RtcConnectionLike | null | undefined): string | null {
  try {
    const local = localFingerprint(pc?.localDescription?.sdp);
    const certs = pc?.sctp?.transport?.getRemoteCertificates?.();
    if (!local || !certs || certs.length === 0) return null;
    const remote = toHex(sha256(new Uint8Array(certs[0])));
    return sha256Hex([local, remote].sort().join('|'));
  } catch {
    return null;
  }
}

/** The subset of a Trystero action the host uses. */
export interface TrysteroActionLike {
  send(data: WireMessage, options?: { target?: string | string[] | null }): Promise<void> | void;
  onMessage: ((data: unknown, context: { peerId: string }) => void) | null;
}

/** The subset of a Trystero room the host uses. */
export interface TrysteroRoomLike {
  makeAction(namespace: string): TrysteroActionLike;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  leave(): Promise<void> | void;
  /** The connection of each active peer (Trystero's room.getPeers). */
  getPeers?(): Record<string, RtcConnectionLike>;
}

export type JoinRoomFn = (config: JoinRoomConfig, roomId: string) => TrysteroRoomLike;

export interface TrysteroHostOptions {
  /** Network id (hex). The room id uses its first 16 hex chars. */
  networkId: string;
  /** Main-thread end of the MessageChannel shared with the worker. */
  port: PortLike;
  /** Injected for tests. Default: trystero's joinRoom (Nostr). */
  joinRoom?: JoinRoomFn;
  /** Default 'browserchain'. */
  appId?: string;
  /** Extra Trystero config (rtcConfig, password, ...). relayConfig replaces the NOSTR_RELAYS default. */
  roomConfig?: Partial<JoinRoomConfig>;
  logger?: Logger;
  /** Trystero receive limit per message. Default 8 MB. */
  maxReceiveBytes?: number;
}

export const TRYSTERO_APP_ID = 'browserchain';
export const TRYSTERO_ACTION = 'm';

/**
 * Nostr relays for signalling. Every node must use the same list: peers only
 * meet on a relay they share, and Trystero connects to all of them, so the
 * list length is the redundancy. Picked on 2026-10-16 with anonymous probes
 * (connect, subscribe, publish an ephemeral event, receive it back), passed
 * three runs in a row. Trystero's own pick for appId 'browserchain' had a dead
 * relay (nostr.robosats.org, HTTP 502) and one that drops ephemeral events
 * (nos.lol).
 */
export const NOSTR_RELAYS: readonly string[] = [
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://offchain.pub',
  'wss://relay.layer.systems',
  'wss://relay.kaleidoswap.com',
  'wss://relay.piazza.today',
];

export function trysteroRoomId(networkIdHex: string): string {
  return `browserchain-${networkIdHex.slice(0, 16)}`;
}

export class TrysteroHost {
  readonly roomId: string;
  private readonly port: PortLike;
  private readonly joinRoomFn: JoinRoomFn;
  private readonly config: JoinRoomConfig;
  private readonly logger: Logger | undefined;
  private room: TrysteroRoomLike | null = null;
  private action: TrysteroActionLike | null = null;
  private readonly peerSet = new Set<string>();
  /** Peer -> DTLS channel id of its current connection. */
  private readonly channels = new Map<string, string>();
  /** False after the worker says 'stopped'; incoming frames are then dropped. */
  private workerListening = true;
  private readonly listener = (ev: MessageEvent): void => this.onPortMessage(ev.data);

  constructor(opts: TrysteroHostOptions) {
    this.roomId = trysteroRoomId(opts.networkId);
    this.port = opts.port;
    this.joinRoomFn = opts.joinRoom ?? (trysteroJoinRoom as unknown as JoinRoomFn);
    this.logger = opts.logger;
    this.config = {
      maxReceiveBytes: opts.maxReceiveBytes ?? 8 * 1024 * 1024,
      relayConfig: { urls: [...NOSTR_RELAYS], redundancy: NOSTR_RELAYS.length },
      ...opts.roomConfig,
      appId: opts.appId ?? TRYSTERO_APP_ID,
    };
  }

  get running(): boolean {
    return this.room !== null;
  }

  start(): void {
    if (this.room) return;
    this.port.addEventListener('message', this.listener);
    this.port.start?.();
    const room = this.joinRoomFn(this.config, this.roomId);
    const action = room.makeAction(TRYSTERO_ACTION);
    this.room = room;
    this.action = action;
    room.onPeerJoin = (peer) => this.peerJoined(peer);
    room.onPeerLeave = (peer) => this.peerLeft(peer);
    action.onMessage = (data, ctx) => this.fromPeer(ctx.peerId, data);
    this.logger?.info(`joined trystero room ${this.roomId}`);
  }

  /** Leaves the room and tells the worker every peer is down. */
  async stop(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.room = null;
    if (this.action) this.action.onMessage = null;
    this.action = null;
    room.onPeerJoin = null;
    room.onPeerLeave = null;
    this.port.removeEventListener('message', this.listener);
    for (const peer of this.peerSet) this.post({ type: 'down', peer });
    this.peerSet.clear();
    this.channels.clear();
    try {
      await room.leave();
    } catch (err) {
      this.logger?.warn(`trystero leave failed: ${(err as Error).message}`);
    }
  }

  peers(): string[] {
    return [...this.peerSet];
  }

  private post(m: MainToWorker): void {
    try {
      this.port.postMessage(m);
    } catch (err) {
      this.logger?.warn(`bridge post failed: ${(err as Error).message}`);
    }
  }

  private peerJoined(peer: string): void {
    if (!this.room || typeof peer !== 'string') return;
    const channel = this.channelOf(peer);
    if (this.peerSet.has(peer)) {
      // Trystero replaces the connection of a peer id that connects again,
      // without a leave. A new channel is a new link for the worker.
      if (channel === null || channel === this.channels.get(peer)) return;
      this.channels.set(peer, channel);
      this.post({ type: 'down', peer });
      this.post({ type: 'up', peer, channel });
      return;
    }
    this.peerSet.add(peer);
    if (channel !== null) this.channels.set(peer, channel);
    this.post(this.upFrame(peer));
  }

  private upFrame(peer: string): MainToWorker {
    const channel = this.channels.get(peer);
    return channel === undefined ? { type: 'up', peer } : { type: 'up', peer, channel };
  }

  private channelOf(peer: string): string | null {
    try {
      return dtlsChannelId(this.room?.getPeers?.()[peer]);
    } catch {
      return null;
    }
  }

  private peerLeft(peer: string): void {
    if (!this.peerSet.delete(peer)) return;
    this.channels.delete(peer);
    this.post({ type: 'down', peer });
  }

  private fromPeer(peer: string, data: unknown): void {
    if (!this.room || typeof peer !== 'string') return;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    if (!this.peerSet.has(peer)) this.peerJoined(peer);
    if (!this.workerListening) return;
    this.post({ type: 'msg', peer, msg: data as WireMessage });
  }

  private onPortMessage(data: unknown): void {
    const m = parseWorkerToMain(data);
    if (!m || !this.action) return;
    switch (m.type) {
      case 'send':
        if (this.peerSet.has(m.peer)) this.sendToPeers(m.msg, m.peer);
        return;
      case 'broadcast':
        if (this.peerSet.size > 0) this.sendToPeers(m.msg, null);
        return;
      case 'ready':
        this.workerListening = true;
        for (const peer of this.peerSet) this.post(this.upFrame(peer));
        return;
      case 'stopped':
        this.workerListening = false;
        return;
    }
  }

  private sendToPeers(msg: WireMessage, target: string | null): void {
    const action = this.action;
    if (!action) return;
    try {
      const r = target === null ? action.send(msg) : action.send(msg, { target });
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err: unknown) => this.logger?.debug(`trystero send failed: ${String(err)}`));
      }
    } catch (err) {
      this.logger?.debug(`trystero send failed: ${(err as Error).message}`);
    }
  }
}
