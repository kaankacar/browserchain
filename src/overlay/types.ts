// Overlay (peer-to-peer) types. All wire messages are JSON-serializable
// objects. Consensus traffic travels as base64 xdr.StellarMessage (real
// Stellar overlay XDR) inside { t: 'stellar' } frames.

export type TransportKind = 'broadcast' | 'webrtc' | 'memory' | 'bridge';

/** Transport-level peer id (unique per remote endpoint of one transport). */
export type TransportPeerId = string;

export interface LclRef {
  seq: number;
  hash: string;
}

export type PeerSyncState = 'booting' | 'catching-up' | 'synced' | 'stalled' | 'stopped';

/** Fields every node announces about itself (signed in hello/status). */
export interface NodeAnnouncement {
  nodeId: string; // G...
  name: string;
  networkId: string; // hex
  appVersion: number;
  lcl: LclRef;
  state: PeerSyncState;
  validator: boolean;
  qsetHash: string;
  quorumMode: 'auto' | 'manual';
  ts: number; // ms, sender clock
}

export type RequestBody =
  /** Ledger headers [from, to] inclusive, ascending. */
  | { kind: 'headers'; from: number; to: number }
  /** Headers + tx sets [from, to] inclusive, ascending (for replay). */
  | { kind: 'ledgers'; from: number; to: number }
  /** Latest state snapshot with seq <= atOrBefore. */
  | { kind: 'snapshot'; atOrBefore: number }
  /** Latest SCP envelopes the peer has for slots >= fromSlot. */
  | { kind: 'scpState'; fromSlot: number }
  /** Fork resolution: sum of externalizedBy over the peer's ledgers with seq > afterSeq. */
  | { kind: 'branchWeight'; afterSeq: number };

export type ResponseBody =
  | { kind: 'headers'; items: { seq: number; headerXdr: string }[] }
  | { kind: 'ledgers'; items: { seq: number; headerXdr: string; txSetXdr: string }[] }
  | { kind: 'snapshot'; seq: number; data: string /* JSON LedgerSnapshot */ }
  | { kind: 'scpState'; envelopes: string[] /* base64 xdr.ScpEnvelope */ }
  | { kind: 'branchWeight'; afterSeq: number; weight: number; lcl: LclRef };

export type WireMessage =
  /**
   * nonce: the sender's random nonce for this link (32 hex). peerNonce: the
   * receiver's nonce. With peerNonce, sig covers the hello digest (ann, nonce,
   * peerNonce, channel), which proves the hello is fresh on this link; without
   * it, sig is the plain announcement signature. channel: the sender's id of
   * the secure channel under the link (Transport.channelId, 64 hex), absent
   * when its transport has none. A hello made for another channel (relayed by
   * a third party) does not bind.
   */
  | { t: 'hello'; ann: NodeAnnouncement; sig: string; nonce: string; peerNonce?: string; channel?: string }
  | { t: 'status'; ann: NodeAnnouncement; sig: string }
  /** flood=true: receivers re-broadcast it once (dedupe by hash of xdr). */
  | { t: 'stellar'; xdr: string; flood?: boolean }
  | { t: 'req'; id: string; body: RequestBody }
  | { t: 'res'; id: string; body: ResponseBody | null; error?: string }
  /** One piece of a response too large for one message: data of all parts, in index order, is JSON of the ResponseBody. */
  | { t: 'part'; id: string; index: number; total: number; data: string }
  | { t: 'bye'; nodeId: string };

/** A raw transport. Delivers WireMessage objects between endpoints. */
export interface Transport {
  readonly kind: TransportKind;
  start(): void | Promise<void>;
  stop(): void;
  send(peer: TransportPeerId, msg: WireMessage): void;
  broadcast(msg: WireMessage): void;
  peers(): TransportPeerId[];
  onPeerUp: ((peer: TransportPeerId) => void) | null;
  onPeerDown: ((peer: TransportPeerId) => void) | null;
  onMessage: ((peer: TransportPeerId, msg: WireMessage) => void) | null;
  /**
   * Optional. Id of the secure channel to a peer (64 lowercase hex), the same
   * at both ends and different for every other channel (WebRTC: a hash of
   * both DTLS certificate fingerprints). Null when unknown. Hellos on
   * authenticated links sign it. A wrapper transport forwards it, or exposes
   * the wrapped transport as `inner`.
   */
  channelId?(peer: TransportPeerId): string | null;
}

/** A peer known to the overlay, keyed by node id (after a verified hello). */
export interface PeerInfo {
  nodeId: string;
  name: string;
  transports: TransportKind[];
  ann: NodeAnnouncement;
  connectedAt: number;
  lastSeen: number;
  latencyMs: number | null;
}

export interface OverlayHandlers {
  /**
   * A Stellar message (base64 xdr.StellarMessage) arrived and passed dedupe.
   * Return false to stop the overlay from re-flooding it.
   */
  onStellarMessage(xdrB64: string, from: PeerInfo): void | boolean;
  /** Answer a request; return null if we do not have the data. */
  onRequest(body: RequestBody, from: PeerInfo): Promise<ResponseBody | null> | ResponseBody | null;
  onPeerConnected?(peer: PeerInfo): void;
  onPeerDisconnected?(peer: PeerInfo): void;
  /** A peer sent a newer signed status. */
  onPeerStatus?(peer: PeerInfo): void;
}

export interface IOverlay {
  start(): void;
  stop(): void;
  /** Flood to all peers (except one). Deduped by SHA-256 of the xdr. */
  floodStellar(xdrB64: string, opts?: { exceptNodeId?: string }): void;
  /** Send to one peer by node id. No-op if not connected. */
  sendStellar(nodeId: string, xdrB64: string): void;
  /** Request/response with timeout. Rejects on timeout, error or null response. */
  request(nodeId: string, body: RequestBody, timeoutMs?: number): Promise<ResponseBody>;
  peers(): PeerInfo[];
  /** Update what we announce; sent with the next status beacon (and immediately if changed). */
  setAnnouncement(ann: Omit<NodeAnnouncement, 'nodeId' | 'networkId' | 'appVersion' | 'ts'>): void;
}
