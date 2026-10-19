// Overlay manager. Binds transport peers to node ids through signed
// hello/status announcements, floods Stellar messages with SHA-256 dedupe,
// runs request/response with timeouts, and tracks liveness and RTT.
//
// One node can be reachable over several transports (links). All links are
// kept; sends use one link (broadcast, then memory, then webrtc/bridge, then
// the most recently heard). Status beacons go over every link, so each link
// proves itself alive. A link silent for peerTimeoutMs is unbound; a node
// with no bound links is disconnected.
//
// Links over untrusted transports (WebRTC) bind only on a fresh hello: each
// side sends a random nonce for the link, and a hello binds only when its
// signature covers the receiver's current nonce. A hello or status captured
// on one link cannot bind another. The hello also signs the transport's id of
// the secure channel under the link (WebRTC: both DTLS certificate
// fingerprints), so a third party that relays a fresh hello from its own
// channel with the node cannot bind it either. A sender whose transport has
// no channel id binds unprotected. BroadcastChannel (same origin) and the
// in-memory test network bind on a plain signed hello. A bye on a WebRTC
// link ends only that link while the node has others.
//
// Bounds: per-link token buckets (messages and bytes), at most maxPeers
// nodes and maxLinks links (an unbound link that waited longer than
// peerTimeoutMs gives its slot to a newcomer), an inbound handler timeout,
// and responses larger than one message sent as parts with a reassembly cap
// and a deadline that grows only with the data received.

import type { Keypair } from '@stellar/stellar-sdk/base';
import { ZERO_HASH } from '../lib/bytes';
import type { Clock, TimerHandle } from '../lib/clock';
import { APP_VERSION, PEER_TIMEOUT_MS, STATUS_INTERVAL_MS } from '../lib/constants';
import type { Logger } from '../lib/log';
import { canonicalJson } from './canonicalJson';
import { LruMap, LruSet } from './lru';
import type {
  IOverlay,
  NodeAnnouncement,
  OverlayHandlers,
  PeerInfo,
  RequestBody,
  ResponseBody,
  Transport,
  TransportKind,
  TransportPeerId,
  WireMessage,
} from './types';
import {
  MAX_ERROR_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  MAX_PARTS,
  estimateSize,
  isAnnouncement,
  isBase64,
  isRequestBody,
  isResponseBody,
  isWireMessage,
  randomId,
  signAnnouncement,
  signHello,
  stellarMessageId,
  verifyAnnouncement,
  verifyHello,
} from './wire';

export type AnnouncementFields = Omit<NodeAnnouncement, 'nodeId' | 'networkId' | 'appVersion' | 'ts'>;

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_INBOUND_REQUESTS_PER_PEER = 4;
export const FLOOD_DEDUPE_CAPACITY = 20_000;
/** Minimum gap between status messages triggered by setAnnouncement. */
export const MIN_STATUS_GAP_MS = 200;
/** An inbound request handler still running after this long is answered with an error; its slot is freed. */
export const INBOUND_HANDLER_TIMEOUT_MS = 30_000;
/** Most nodes bound at once. Hellos from further nodes are ignored. */
export const MAX_PEERS = 64;
/** Most transport links (bound or not) at once. */
export const MAX_LINKS = 128;
/** Largest response accepted or sent, in characters of its JSON (sent in parts above one message). */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Characters of response JSON per part. Small enough for Trystero's 8 MB receive limit after JSON escaping. */
export const PART_CHARS = 2 * 1024 * 1024;
/** Transport kinds whose links must answer a fresh nonce before they bind. */
export const AUTHENTICATED_KINDS: readonly TransportKind[] = ['webrtc', 'bridge'];

export interface RateLimit {
  messagesPerSecond: number;
  burst: number;
  /** Estimated JSON bytes per second. */
  bytesPerSecond: number;
  burstBytes: number;
}

/**
 * Per-link token buckets on inbound messages. A healthy link carries tens of
 * messages per second; responses to our own requests do not count.
 */
export const DEFAULT_RATE_LIMIT: RateLimit = {
  messagesPerSecond: 300,
  burst: 1500,
  bytesPerSecond: 8 * 1024 * 1024,
  burstBytes: 32 * 1024 * 1024,
};

/**
 * Large responses (sent in parts) cost real work to build and send, so a peer
 * may not ask for them without limit: each peer has a budget of one full
 * response, refilled in 16 s, and all peers share two, refilled in 4 s.
 * Requests over budget are answered 'busy'.
 */
const PART_BUDGET_PEER_REFILL_S = 16;
const PART_BUDGET_TOTAL_REFILL_S = 4;

/** Hello replies per link: a burst of 4, then one per second (each may cost a signature). */
const HELLO_REPLY_BURST = 4;
const HELLO_REPLY_PER_SECOND = 1;

/**
 * At the link cap, an unbound link that waited longer than peerTimeoutMs is
 * dropped for a newcomer, and its transport peer is ignored for this long
 * unless the transport reports it up again (a new connection).
 */
export const EVICTED_LINK_IGNORE_MS = 60_000;

export interface OverlayOptions {
  /** Node key (SDK Keypair with secret). Its public key is the node id. */
  keypair: Keypair;
  /** Network id, 64 lowercase hex chars. */
  networkId: string;
  name: string;
  clock: Clock;
  logger: Logger;
  transports: Transport[];
  handlers: OverlayHandlers;
  /** Initial announcement fields. Defaults: lcl {0, zero hash}, 'booting', validator, qsetHash '', 'auto'. */
  announcement?: Partial<Omit<AnnouncementFields, 'name'>>;
  /** Default STATUS_INTERVAL_MS. */
  statusIntervalMs?: number;
  /** Default PEER_TIMEOUT_MS. */
  peerTimeoutMs?: number;
  /** Default request timeout. Default 10 s. */
  requestTimeoutMs?: number;
  /** Drop messages larger than this. Default 4 MB. */
  maxMessageBytes?: number;
  /** Concurrent inbound requests per peer. Default 4. */
  maxInboundRequestsPerPeer?: number;
  /** Flood dedupe LRU size. Default 20,000. */
  dedupeCapacity?: number;
  /** Our app version. Default APP_VERSION. */
  appVersion?: number;
  /** Default: equal to our app version. */
  isCompatibleVersion?: (appVersion: number) => boolean;
  /** Per-link token buckets on inbound messages (fields default to DEFAULT_RATE_LIMIT). null turns them off. */
  rateLimit?: Partial<RateLimit> | null;
  /** Default MAX_PEERS. */
  maxPeers?: number;
  /** Default MAX_LINKS. */
  maxLinks?: number;
  /** Default INBOUND_HANDLER_TIMEOUT_MS. */
  inboundTimeoutMs?: number;
  /** Default MAX_RESPONSE_BYTES. */
  maxResponseBytes?: number;
  /** Default PART_CHARS. */
  partChars?: number;
  /** Default AUTHENTICATED_KINDS. */
  authenticatedKinds?: readonly TransportKind[];
}

export type OverlayErrorCode =
  | 'not-connected'
  | 'bad-request'
  | 'send-failed'
  | 'timeout'
  | 'disconnected'
  | 'stopped'
  | 'remote-error'
  | 'no-data'
  | 'bad-response';

/** Rejection reason of Overlay.request(). */
export class OverlayRequestError extends Error {
  constructor(
    readonly code: OverlayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OverlayRequestError';
  }
}

export interface OverlayStats {
  messagesIn: number;
  messagesOut: number;
  bytesIn: number;
  bytesOut: number;
  /** floodStellar calls. */
  floodsOut: number;
  /** New flooded messages accepted from peers. */
  floodsIn: number;
  floodDuplicates: number;
  /** Malformed messages. */
  invalid: number;
  oversize: number;
  /** Messages (other than hello/status) from links without a verified hello. */
  unbound: number;
  /** Rejected hello/status: bad signature, other network, incompatible version. */
  badAnnouncements: number;
  rateLimited: number;
  requestsOut: number;
  requestsIn: number;
  requestsRejectedBusy: number;
  requestTimeouts: number;
  /** Inbound requests answered with an error because the handler did not settle in time. */
  requestHandlerTimeouts: number;
  unexpectedResponses: number;
  /** Parts of large responses received and sent. */
  partsIn: number;
  partsOut: number;
  /** Hellos of new nodes ignored at the peer cap. */
  peersRejected: number;
  /** Transport links ignored at the link cap. */
  linksRejected: number;
  /** Unbound links dropped at the link cap to make room for a newcomer. */
  linksEvicted: number;
  /** Hellos made for another secure channel (a third party relayed them); also counted in badAnnouncements. */
  channelMismatches: number;
  /** Authenticated links bound by a hello made for their channel. */
  channelBound: number;
}

const TRANSPORT_RANK: Record<TransportKind, number> = { broadcast: 0, memory: 1, webrtc: 2, bridge: 2 };

interface Link {
  key: string;
  transport: Transport;
  tpeer: TransportPeerId;
  rank: number;
  nodeId: string | null;
  lastSeen: number;
  /** We sent our hello or a status on this link. */
  greeted: boolean;
  tokens: number;
  byteTokens: number;
  tokensAt: number;
  /** Binds only on a hello that covers `nonce` (untrusted transport). */
  auth: boolean;
  /** Our id of the secure channel under this link ('' when the transport has none). */
  channel: string;
  /** Our nonce for this link. Renewed whenever the link loses its node. */
  nonce: string;
  /** The remote's nonce, from its latest hello. */
  peerNonce: string | null;
  /** The remote nonce our latest hello covered. */
  coveredPeerNonce: string | null;
  helloTokens: number;
  helloTokensAt: number;
}

interface PeerState {
  nodeId: string;
  ann: NodeAnnouncement;
  links: Link[];
  connectedAt: number;
  lastSeen: number;
  latencyMs: number | null;
  /** Last verified announcement, to skip re-verifying identical copies. */
  verified: { sig: string; canon: string } | null;
  inflight: number;
  /** Budget (characters) for large responses to this peer. */
  partTokens: number;
  partTokensAt: number;
}

interface Pending {
  nodeId: string;
  kind: RequestBody['kind'];
  sentAt: number;
  timeoutMs: number;
  timer: TimerHandle;
  resolve: (body: ResponseBody) => void;
  reject: (err: Error) => void;
  /** Reassembly of a response that arrives in parts. */
  parts: { total: number; got: number; chunks: (string | undefined)[]; chars: number } | null;
}

interface AnnFloor {
  /** Announcements older than this (sender clock) are stale. */
  ts: number;
  /** After a bye, an announcement must be strictly newer. */
  strict: boolean;
  /** After a bye, only a hello may re-bind the node until this local time. */
  statusBlockedUntil: number;
}

function truncateName(name: string): string {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}

function cloneAnn(a: NodeAnnouncement): NodeAnnouncement {
  return { ...a, lcl: { seq: a.lcl.seq, hash: a.lcl.hash } };
}

function errorText(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > MAX_ERROR_LENGTH ? s.slice(0, MAX_ERROR_LENGTH) : s;
}

function zeroStats(): OverlayStats {
  return {
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    floodsOut: 0,
    floodsIn: 0,
    floodDuplicates: 0,
    invalid: 0,
    oversize: 0,
    unbound: 0,
    badAnnouncements: 0,
    rateLimited: 0,
    requestsOut: 0,
    requestsIn: 0,
    requestsRejectedBusy: 0,
    requestTimeouts: 0,
    requestHandlerTimeouts: 0,
    unexpectedResponses: 0,
    partsIn: 0,
    partsOut: 0,
    peersRejected: 0,
    linksRejected: 0,
    linksEvicted: 0,
    channelMismatches: 0,
    channelBound: 0,
  };
}

/** Split text into pieces of at most `size` characters, never inside a surrogate pair. */
export function splitParts(text: string, size: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** Our nonce for a link: 16 random bytes, hex. */
function newNonce(): string {
  return randomId(16);
}

const CHANNEL_ID = /^[0-9a-f]{64}$/;

/** Channel id under a link ('' when unknown). Looks through wrapper transports that expose `inner`. */
function channelOf(t: Transport, peer: TransportPeerId): string {
  let cur: Transport | undefined = t;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (typeof cur.channelId === 'function') {
      try {
        const id = cur.channelId(peer);
        return typeof id === 'string' && CHANNEL_ID.test(id) ? id : '';
      } catch {
        return '';
      }
    }
    cur = (cur as { inner?: Transport }).inner;
  }
  return '';
}

function positive(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
}

export class Overlay implements IOverlay {
  readonly nodeId: string;
  readonly networkId: string;
  private readonly keypair: Keypair;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly transports: Transport[];
  private handlers: OverlayHandlers;
  private readonly appVersion: number;
  private readonly isCompatible: (v: number) => boolean;
  private readonly statusIntervalMs: number;
  private readonly peerTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxInbound: number;
  private readonly rateLimit: RateLimit | null;
  private readonly maxPeers: number;
  private readonly maxLinks: number;
  private readonly inboundTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly partChars: number;
  private readonly authKinds: ReadonlySet<TransportKind>;
  private partTokens = 0;
  private partTokensAt = 0;

  private fields: AnnouncementFields;
  private fieldsVersion = 0;
  private signedCache: { ts: number; version: number; ann: NodeAnnouncement; sig: string } | null = null;
  private lastSignedTs = -Infinity;

  private running = false;
  private generation = 0;
  private beaconTimer: TimerHandle | null = null;
  private sweepTimer: TimerHandle | null = null;
  private statusSoonTimer: TimerHandle | null = null;
  private lastStatusAt = -Infinity;

  private readonly links = new Map<string, Link>();
  /** Link key -> local time until which messages on it do not re-create the link (evicted at the cap). */
  private readonly evicted = new LruMap<string, number>(1024);
  /** Link-ups refused at the cap, retried by the sweep. */
  private readonly rejected = new LruMap<string, { index: number; tpeer: TransportPeerId }>(1024);
  private readonly peersById = new Map<string, PeerState>();
  private readonly pending = new Map<string, Pending>();
  private readonly seen: LruSet<string>;
  private readonly annFloor = new LruMap<string, AnnFloor>(4096);
  private nextRequestId = 0;
  private counters = zeroStats();

  constructor(opts: OverlayOptions) {
    if (!/^[0-9a-f]{64}$/.test(opts.networkId)) {
      throw new Error('Overlay: networkId must be 64 lowercase hex chars');
    }
    this.keypair = opts.keypair;
    this.nodeId = opts.keypair.publicKey();
    this.networkId = opts.networkId;
    this.clock = opts.clock;
    this.log = opts.logger;
    this.transports = [...opts.transports];
    this.handlers = opts.handlers;
    this.appVersion = opts.appVersion ?? APP_VERSION;
    const own = this.appVersion;
    this.isCompatible = opts.isCompatibleVersion ?? ((v) => v === own);
    this.statusIntervalMs = opts.statusIntervalMs ?? STATUS_INTERVAL_MS;
    this.peerTimeoutMs = opts.peerTimeoutMs ?? PEER_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxBytes = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.maxInbound = opts.maxInboundRequestsPerPeer ?? MAX_INBOUND_REQUESTS_PER_PEER;
    this.seen = new LruSet(opts.dedupeCapacity ?? FLOOD_DEDUPE_CAPACITY);
    this.rateLimit = opts.rateLimit === null ? null : { ...DEFAULT_RATE_LIMIT, ...opts.rateLimit };
    this.maxPeers = positive(opts.maxPeers, MAX_PEERS);
    this.maxLinks = positive(opts.maxLinks, MAX_LINKS);
    this.inboundTimeoutMs = positive(opts.inboundTimeoutMs, INBOUND_HANDLER_TIMEOUT_MS);
    this.maxResponseBytes = positive(opts.maxResponseBytes, MAX_RESPONSE_BYTES);
    // a part (data plus its frame) must fit one message
    this.partChars = Math.max(64, Math.min(positive(opts.partChars, PART_CHARS), this.maxBytes - 256));
    this.authKinds = new Set(opts.authenticatedKinds ?? AUTHENTICATED_KINDS);
    this.partTokens = 2 * this.maxResponseBytes;
    this.partTokensAt = this.clock.now();
    this.fields = this.checkFields({
      lcl: { seq: 0, hash: ZERO_HASH },
      state: 'booting',
      validator: true,
      qsetHash: '',
      quorumMode: 'auto',
      ...opts.announcement,
      name: truncateName(opts.name),
    });
  }

  // ------------------------------------------------------------ lifecycle

  get isRunning(): boolean {
    return this.running;
  }

  setHandlers(handlers: OverlayHandlers): void {
    this.handlers = handlers;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // A restart must announce a strictly newer ts (peers saw our bye).
    this.signedCache = null;
    const gen = ++this.generation;
    this.transports.forEach((t, i) => {
      t.onPeerUp = (p) => this.onLinkUp(i, p);
      t.onPeerDown = (p) => this.onLinkDown(i, p);
      t.onMessage = (p, m) => this.onLinkMessage(i, p, m);
      // Adopt peers the transport already knows (it may have started earlier).
      const adopt = (): void => {
        if (!this.running || this.generation !== gen) return;
        for (const p of t.peers()) this.onLinkUp(i, p);
      };
      let r: void | Promise<void>;
      try {
        r = t.start();
      } catch (err) {
        this.log.error(`transport ${t.kind} failed to start: ${errorText(err)}`);
        return;
      }
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).then(adopt, (err: unknown) =>
          this.log.error(`transport ${t.kind} failed to start: ${errorText(err)}`),
        );
      } else {
        adopt();
      }
    });
    this.scheduleBeacon();
    this.scheduleSweep();
    this.log.info(`overlay started (${this.transports.map((t) => t.kind).join(', ') || 'no transports'})`);
  }

  /** Sends bye on every link, stops transports, rejects pending requests, disconnects all peers. */
  stop(): void {
    if (!this.running) return;
    this.sendToAllLinks({ t: 'bye', nodeId: this.nodeId });
    this.running = false;
    this.generation++;
    for (const timer of [this.beaconTimer, this.sweepTimer, this.statusSoonTimer]) {
      if (timer !== null) this.clock.clearTimeout(timer);
    }
    this.beaconTimer = this.sweepTimer = this.statusSoonTimer = null;
    for (const t of this.transports) {
      t.onPeerUp = null;
      t.onPeerDown = null;
      t.onMessage = null;
      try {
        t.stop();
      } catch (err) {
        this.log.warn(`transport ${t.kind} failed to stop: ${errorText(err)}`);
      }
    }
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      this.clock.clearTimeout(p.timer);
      p.reject(new OverlayRequestError('stopped', `${p.kind} request aborted: overlay stopped`));
    }
    const peers = [...this.peersById.values()];
    this.peersById.clear();
    this.links.clear();
    this.evicted.clear();
    this.rejected.clear();
    for (const peer of peers) this.emitDisconnected(peer);
    this.log.info('overlay stopped');
  }

  // ------------------------------------------------------------ announcements

  setAnnouncement(ann: AnnouncementFields): void {
    const next = this.checkFields({
      name: truncateName(ann.name),
      lcl: { seq: ann.lcl.seq, hash: ann.lcl.hash },
      state: ann.state,
      validator: ann.validator,
      qsetHash: ann.qsetHash,
      quorumMode: ann.quorumMode,
    });
    if (canonicalJson(next) === canonicalJson(this.fields)) return;
    this.fields = next;
    this.fieldsVersion++;
    if (this.running) this.statusSoon();
  }

  /** What we announce right now (ts = now, unsigned). */
  currentAnnouncement(): NodeAnnouncement {
    return this.makeAnnouncement(this.clock.now());
  }

  // ------------------------------------------------------------ IOverlay

  floodStellar(xdrB64: string, opts?: { exceptNodeId?: string }): void {
    if (!this.running) return;
    let id: string;
    try {
      if (!isBase64(xdrB64)) throw new Error('not base64');
      id = stellarMessageId(xdrB64);
    } catch {
      this.log.warn('floodStellar: invalid base64, not sent');
      return;
    }
    this.seen.add(id);
    this.counters.floodsOut++;
    this.floodToPeers(xdrB64, opts?.exceptNodeId);
  }

  sendStellar(nodeId: string, xdrB64: string): void {
    if (!this.running) return;
    const peer = this.peersById.get(nodeId);
    if (!peer) return;
    if (!isBase64(xdrB64)) {
      this.log.warn('sendStellar: invalid base64, not sent');
      return;
    }
    const msg: WireMessage = { t: 'stellar', xdr: xdrB64 };
    const size = estimateSize(msg, this.maxBytes);
    if (size > this.maxBytes) {
      this.log.warn(`sendStellar: message too large (${size} bytes), not sent`);
      return;
    }
    this.sendToPeer(peer, msg, size);
  }

  request(nodeId: string, body: RequestBody, timeoutMs = this.requestTimeoutMs): Promise<ResponseBody> {
    if (!this.running) {
      return Promise.reject(new OverlayRequestError('stopped', 'overlay is not running'));
    }
    const peer = this.peersById.get(nodeId);
    if (!peer) {
      return Promise.reject(new OverlayRequestError('not-connected', `peer ${nodeId} is not connected`));
    }
    if (!isRequestBody(body)) {
      return Promise.reject(new OverlayRequestError('bad-request', 'malformed request body'));
    }
    const id = `r${++this.nextRequestId}`;
    this.counters.requestsOut++;
    return new Promise<ResponseBody>((resolve, reject) => {
      const p: Pending = {
        nodeId,
        kind: body.kind,
        sentAt: this.clock.now(),
        timeoutMs,
        timer: 0,
        resolve,
        reject,
        parts: null,
      };
      p.timer = this.armRequestTimer(id, p);
      this.pending.set(id, p);
      const msg: WireMessage = { t: 'req', id, body };
      if (!this.sendToPeer(peer, msg, estimateSize(msg))) {
        this.pending.delete(id);
        this.clock.clearTimeout(p.timer);
        reject(new OverlayRequestError('send-failed', `could not send ${body.kind} request to ${nodeId}`));
      }
    });
  }

  /** (Re)start the timeout of a pending request: a response arriving in parts restarts it with each part. */
  private armRequestTimer(id: string, p: Pending, ms = p.timeoutMs): TimerHandle {
    return this.clock.setTimeout(() => {
      if (this.pending.get(id) !== p) return;
      this.pending.delete(id);
      this.counters.requestTimeouts++;
      const progress = p.parts ? ` (${p.parts.got} of ${p.parts.total} parts)` : '';
      p.reject(new OverlayRequestError('timeout', `${p.kind} request to ${p.nodeId} timed out after ${p.timeoutMs} ms${progress}`));
    }, ms);
  }

  peers(): PeerInfo[] {
    return [...this.peersById.values()]
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
      .map((p) => this.info(p));
  }

  // ------------------------------------------------------------ extras

  getPeer(nodeId: string): PeerInfo | null {
    const p = this.peersById.get(nodeId);
    return p ? this.info(p) : null;
  }

  isConnected(nodeId: string): boolean {
    return this.peersById.has(nodeId);
  }

  stats(): OverlayStats {
    return { ...this.counters };
  }

  // ------------------------------------------------------------ links

  private linkKey(index: number, tpeer: TransportPeerId): string {
    return `${index}:${tpeer}`;
  }

  private onLinkUp(index: number, tpeer: TransportPeerId): void {
    if (!this.running) return;
    const key = this.linkKey(index, tpeer);
    if (this.links.has(key)) return;
    // the transport says the peer is up: a new connection, no longer evicted
    this.evicted.delete(key);
    this.addLink(index, tpeer, key);
  }

  private addLink(index: number, tpeer: TransportPeerId, key: string): void {
    if (this.links.size >= this.maxLinks && !this.evictStaleLink()) {
      this.counters.linksRejected++;
      // the transport reports a peer up only once: retry it from the sweep
      this.rejected.set(key, { index, tpeer });
      this.log.debug(`link cap (${this.maxLinks}) reached; ignored ${this.transports[index].kind}:${tpeer}`);
      return;
    }
    this.rejected.delete(key);
    const transport = this.transports[index];
    const now = this.clock.now();
    const link: Link = {
      key,
      transport,
      tpeer,
      rank: TRANSPORT_RANK[transport.kind] ?? 3,
      nodeId: null,
      lastSeen: now,
      greeted: false,
      tokens: this.rateLimit?.burst ?? 0,
      byteTokens: this.rateLimit?.burstBytes ?? 0,
      tokensAt: now,
      auth: this.authKinds.has(transport.kind),
      channel: this.authKinds.has(transport.kind) ? channelOf(transport, tpeer) : '',
      nonce: newNonce(),
      peerNonce: null,
      coveredPeerNonce: null,
      helloTokens: HELLO_REPLY_BURST,
      helloTokensAt: now,
    };
    this.links.set(key, link);
    this.greet(link);
  }

  /**
   * At the link cap: drop the unbound link that has waited longest, if it
   * waited longer than peerTimeoutMs (a silent or failed handshake must not
   * hold a slot forever). Its transport peer cannot re-create the link by
   * sending for EVICTED_LINK_IGNORE_MS. False when no link qualifies.
   */
  private evictStaleLink(): boolean {
    const now = this.clock.now();
    let oldest: Link | undefined;
    for (const l of this.links.values()) {
      if (l.nodeId !== null || now - l.lastSeen <= this.peerTimeoutMs) continue;
      if (!oldest || l.lastSeen < oldest.lastSeen) oldest = l;
    }
    if (!oldest) return false;
    this.links.delete(oldest.key);
    this.evicted.set(oldest.key, now + EVICTED_LINK_IGNORE_MS);
    this.counters.linksEvicted++;
    this.log.debug(`link cap (${this.maxLinks}) reached; dropped unbound ${oldest.transport.kind}:${oldest.tpeer}`);
    return true;
  }

  /** Link-ups refused at the cap whose transport peer is still up: add them once a stale link can make room. */
  private retryRejected(): void {
    const now = this.clock.now();
    const upByTransport = new Map<number, Set<TransportPeerId>>();
    const isUp = (index: number, tpeer: TransportPeerId): boolean => {
      let up = upByTransport.get(index);
      if (!up) {
        try {
          up = new Set(this.transports[index].peers());
        } catch {
          up = new Set();
        }
        upByTransport.set(index, up);
      }
      return up.has(tpeer);
    };
    for (const [key, r] of [...this.rejected.entries()]) {
      if (this.links.has(key)) {
        this.rejected.delete(key);
        continue;
      }
      if (!isUp(r.index, r.tpeer)) {
        this.rejected.delete(key);
        continue;
      }
      const until = this.evicted.peek(key);
      if (until !== undefined && now < until) continue;
      if (this.links.size >= this.maxLinks && !this.hasStaleLink(now)) return;
      this.evicted.delete(key);
      this.addLink(r.index, r.tpeer, key);
    }
  }

  private hasStaleLink(now: number): boolean {
    for (const l of this.links.values()) if (l.nodeId === null && now - l.lastSeen > this.peerTimeoutMs) return true;
    return false;
  }

  private onLinkDown(index: number, tpeer: TransportPeerId): void {
    const key = this.linkKey(index, tpeer);
    this.evicted.delete(key);
    this.rejected.delete(key);
    const link = this.links.get(key);
    if (!link) return;
    this.links.delete(key);
    this.unbindLink(link, 'link down');
  }

  private greet(link: Link): void {
    this.sendOnLink(link, this.helloFor(link));
    link.greeted = true;
  }

  /**
   * Our hello for a link. On an authenticated link that knows the remote's
   * nonce, the signature covers it (the remote may bind us on it).
   */
  private helloFor(link: Link): WireMessage {
    const plain = this.signedAnnouncement();
    if (!link.auth || link.peerNonce === null) return { t: 'hello', ann: plain.ann, sig: plain.sig, nonce: link.nonce };
    link.coveredPeerNonce = link.peerNonce;
    const hello: Extract<WireMessage, { t: 'hello' }> = {
      t: 'hello',
      ann: plain.ann,
      sig: signHello(this.keypair, plain.ann, link.nonce, link.peerNonce, link.channel),
      nonce: link.nonce,
      peerNonce: link.peerNonce,
    };
    if (link.channel) hello.channel = link.channel;
    return hello;
  }

  /** Send our hello on an authenticated link, at most HELLO_REPLY_* per link (each may cost a signature). */
  private answerHello(link: Link): void {
    const now = this.clock.now();
    link.helloTokens = Math.min(HELLO_REPLY_BURST, link.helloTokens + ((now - link.helloTokensAt) * HELLO_REPLY_PER_SECOND) / 1000);
    link.helloTokensAt = now;
    if (link.helloTokens < 1) return;
    link.helloTokens -= 1;
    this.greet(link);
  }

  private bindLink(link: Link, peer: PeerState): void {
    link.nodeId = peer.nodeId;
    peer.links.push(link);
  }

  /** The link lost its node: a new binding needs a hello that covers a new nonce. */
  private forgetNode(link: Link): void {
    link.nodeId = null;
    if (link.auth) link.nonce = newNonce();
  }

  private unbindLink(link: Link, reason: string): void {
    const nodeId = link.nodeId;
    if (nodeId === null) return;
    this.forgetNode(link);
    const peer = this.peersById.get(nodeId);
    if (!peer) return;
    peer.links = peer.links.filter((l) => l !== link);
    if (peer.links.length === 0) this.dropPeer(peer, reason);
  }

  private preferredLink(peer: PeerState): Link | undefined {
    let best: Link | undefined;
    for (const l of peer.links) {
      if (!best || l.rank < best.rank || (l.rank === best.rank && l.lastSeen > best.lastSeen)) best = l;
    }
    return best;
  }

  private dropPeer(peer: PeerState, reason: string): void {
    if (this.peersById.get(peer.nodeId) !== peer) return;
    this.peersById.delete(peer.nodeId);
    for (const l of peer.links) this.forgetNode(l);
    peer.links = [];
    for (const [id, p] of [...this.pending]) {
      if (p.nodeId !== peer.nodeId) continue;
      this.pending.delete(id);
      this.clock.clearTimeout(p.timer);
      p.reject(new OverlayRequestError('disconnected', `${p.kind} request failed: peer ${peer.nodeId} disconnected`));
    }
    this.log.info(`peer ${peer.ann.name || peer.nodeId.slice(0, 8)} disconnected (${reason})`);
    this.emitDisconnected(peer);
  }

  // ------------------------------------------------------------ sending

  private sendOnLink(link: Link, msg: WireMessage, size?: number): boolean {
    try {
      link.transport.send(link.tpeer, msg);
    } catch (err) {
      this.log.debug(`send on ${link.transport.kind} failed: ${errorText(err)}`);
      return false;
    }
    this.counters.messagesOut++;
    this.counters.bytesOut += size ?? 0;
    return true;
  }

  private sendToPeer(peer: PeerState, msg: WireMessage, size?: number): boolean {
    const link = this.preferredLink(peer);
    return link ? this.sendOnLink(link, msg, size) : false;
  }

  private floodToPeers(xdrB64: string, exceptNodeId: string | undefined): void {
    const msg: WireMessage = { t: 'stellar', xdr: xdrB64, flood: true };
    const size = estimateSize(msg, this.maxBytes);
    if (size > this.maxBytes) {
      this.log.warn(`flood: message too large (${size} bytes), not sent`);
      return;
    }
    // Group recipients by the transport of their preferred link.
    const groups = new Map<Transport, Link[]>();
    for (const peer of [...this.peersById.values()]) {
      if (peer.nodeId === exceptNodeId) continue;
      const link = this.preferredLink(peer);
      if (!link) continue;
      const g = groups.get(link.transport);
      if (g) g.push(link);
      else groups.set(link.transport, [link]);
    }
    for (const [t, links] of groups) {
      // Every BroadcastChannel endpoint receives every frame, even targeted
      // ones, so one broadcast is far cheaper than one send per peer. The
      // excluded sender may get a copy back; dedupe drops it.
      if (t.kind === 'broadcast' && links.length >= 2) this.broadcastOn(t, msg, size);
      else for (const l of links) this.sendOnLink(l, msg, size);
    }
  }

  private broadcastOn(t: Transport, msg: WireMessage, size?: number): boolean {
    try {
      t.broadcast(msg);
    } catch (err) {
      this.log.debug(`broadcast on ${t.kind} failed: ${errorText(err)}`);
      return false;
    }
    this.counters.messagesOut++;
    this.counters.bytesOut += size ?? 0;
    return true;
  }

  private makeAnnouncement(ts: number): NodeAnnouncement {
    const f = this.fields;
    return {
      nodeId: this.nodeId,
      name: f.name,
      networkId: this.networkId,
      appVersion: this.appVersion,
      lcl: { seq: f.lcl.seq, hash: f.lcl.hash },
      state: f.state,
      validator: f.validator,
      qsetHash: f.qsetHash,
      quorumMode: f.quorumMode,
      ts,
    };
  }

  /**
   * Signed hello/status. Announcement ts strictly increases with every new
   * content and every restart, so peers can always tell newer from older,
   * even within one millisecond of virtual time.
   */
  private signedAnnouncement(): { ann: NodeAnnouncement; sig: string } {
    const now = this.clock.now();
    let c = this.signedCache;
    if (!c || c.version !== this.fieldsVersion || c.ts < now) {
      const ts = Math.max(now, this.lastSignedTs + 1);
      const ann = this.makeAnnouncement(ts);
      c = { ts, version: this.fieldsVersion, ann, sig: signAnnouncement(this.keypair, ann) };
      this.signedCache = c;
      this.lastSignedTs = ts;
    }
    return { ann: cloneAnn(c.ann), sig: c.sig };
  }

  private statusMessage(): WireMessage {
    return { t: 'status', ...this.signedAnnouncement() };
  }

  private sendStatusToAll(): void {
    this.lastStatusAt = this.clock.now();
    this.sendToAllLinks(this.statusMessage());
    for (const link of this.links.values()) link.greeted = true;
  }

  /** Same message on every link, bound or not; one broadcast per BroadcastChannel transport. */
  private sendToAllLinks(msg: WireMessage): void {
    const size = estimateSize(msg);
    const viaBroadcast = new Set<Transport>();
    for (const link of [...this.links.values()]) {
      if (link.transport.kind !== 'broadcast') {
        this.sendOnLink(link, msg, size);
      } else if (!viaBroadcast.has(link.transport)) {
        viaBroadcast.add(link.transport);
        this.broadcastOn(link.transport, msg, size);
      }
    }
  }

  /** Status after an announcement change, at most one per MIN_STATUS_GAP_MS. */
  private statusSoon(): void {
    if (this.statusSoonTimer !== null) return;
    const wait = this.lastStatusAt + MIN_STATUS_GAP_MS - this.clock.now();
    if (wait <= 0) {
      this.sendStatusToAll();
      return;
    }
    this.statusSoonTimer = this.clock.setTimeout(() => {
      this.statusSoonTimer = null;
      if (this.running) this.sendStatusToAll();
    }, wait);
  }

  private scheduleBeacon(): void {
    this.beaconTimer = this.clock.setTimeout(() => {
      this.beaconTimer = null;
      if (!this.running) return;
      this.sendStatusToAll();
      this.scheduleBeacon();
    }, this.statusIntervalMs);
  }

  private scheduleSweep(): void {
    const every = Math.max(50, Math.min(this.statusIntervalMs, Math.floor(this.peerTimeoutMs / 4)));
    this.sweepTimer = this.clock.setTimeout(() => {
      this.sweepTimer = null;
      if (!this.running) return;
      this.sweep();
      this.scheduleSweep();
    }, every);
  }

  /** Unbind links silent for longer than peerTimeoutMs; retry link-ups refused at the cap. */
  private sweep(): void {
    const now = this.clock.now();
    for (const peer of [...this.peersById.values()]) {
      for (const link of [...peer.links]) {
        if (now - link.lastSeen > this.peerTimeoutMs) this.unbindLink(link, 'timeout');
      }
    }
    if (this.rejected.size > 0) this.retryRejected();
  }

  // ------------------------------------------------------------ receiving

  private onLinkMessage(index: number, tpeer: TransportPeerId, raw: unknown): void {
    if (!this.running) return;
    const key = this.linkKey(index, tpeer);
    let link = this.links.get(key);
    if (!link) {
      // A link evicted at the cap stays out until its transport reports it up again.
      const until = this.evicted.peek(key);
      if (until !== undefined) {
        if (this.clock.now() < until) {
          this.counters.linksRejected++;
          return;
        }
        this.evicted.delete(key);
      }
      // Transports report peers up before their messages; be lenient anyway.
      this.addLink(index, tpeer, key);
      link = this.links.get(key);
      if (!link) return;
    }
    const size = estimateSize(raw, this.maxBytes);
    if (size > this.maxBytes) {
      this.counters.oversize++;
      this.log.debug(`dropped oversize message from ${link.transport.kind}:${tpeer}`);
      return;
    }
    // Rate limits come before the costlier checks; answers to our own requests do not count.
    if (this.rateLimit && !this.isSolicited(link, raw) && !this.takeTokens(link, size)) {
      this.counters.rateLimited++;
      return;
    }
    if (!isWireMessage(raw)) {
      this.counters.invalid++;
      this.log.debug(`dropped malformed message from ${link.transport.kind}:${tpeer}`);
      return;
    }
    this.counters.messagesIn++;
    this.counters.bytesIn += size;
    const msg = raw;
    if (msg.t === 'hello' || msg.t === 'status') {
      this.onAnnouncement(link, msg);
      return;
    }
    const peer = link.nodeId !== null ? this.peersById.get(link.nodeId) : undefined;
    if (!peer) {
      this.counters.unbound++;
      return;
    }
    const now = this.clock.now();
    link.lastSeen = now;
    peer.lastSeen = now;
    switch (msg.t) {
      case 'stellar':
        this.onStellar(peer, msg.xdr, msg.flood === true);
        return;
      case 'req':
        this.onRequest(link, peer, msg.id, msg.body);
        return;
      case 'res':
        this.onResponse(peer, msg.id, msg.body, msg.error);
        return;
      case 'part':
        this.onPart(peer, msg.id, msg.index, msg.total, msg.data);
        return;
      case 'bye':
        if (msg.nodeId !== peer.nodeId) return;
        if (link.auth && peer.links.length > 1) {
          // A WebRTC link can be a third party relaying the node's hellos: its
          // bye ends only this link. The node says bye on every link it has.
          this.unbindLink(link, 'bye');
          return;
        }
        this.annFloor.set(peer.nodeId, {
          ts: peer.ann.ts,
          strict: true,
          statusBlockedUntil: now + this.peerTimeoutMs,
        });
        this.dropPeer(peer, 'bye');
        return;
    }
  }

  /** A response or part for one of our requests to the node this link is bound to. */
  private isSolicited(link: Link, raw: unknown): boolean {
    if (link.nodeId === null || typeof raw !== 'object' || raw === null) return false;
    const m = raw as { t?: unknown; id?: unknown };
    if (m.t !== 'res' && m.t !== 'part') return false;
    return typeof m.id === 'string' && this.pending.get(m.id)?.nodeId === link.nodeId;
  }

  private takeTokens(link: Link, size: number): boolean {
    const rl = this.rateLimit;
    if (!rl) return true;
    const now = this.clock.now();
    const dt = Math.max(0, now - link.tokensAt);
    link.tokens = Math.min(rl.burst, link.tokens + (dt * rl.messagesPerSecond) / 1000);
    link.byteTokens = Math.min(rl.burstBytes, link.byteTokens + (dt * rl.bytesPerSecond) / 1000);
    link.tokensAt = now;
    if (link.tokens < 1 || link.byteTokens < size) return false;
    link.tokens -= 1;
    link.byteTokens -= size;
    return true;
  }

  private onAnnouncement(link: Link, msg: Extract<WireMessage, { t: 'hello' | 'status' }>): void {
    const ann = msg.ann;
    if (ann.nodeId === this.nodeId) return;
    if (ann.networkId !== this.networkId) {
      this.counters.badAnnouncements++;
      this.log.debug(`ignored ${msg.t} from another network (${ann.networkId.slice(0, 8)})`);
      return;
    }
    if (!this.isCompatible(ann.appVersion)) {
      this.counters.badAnnouncements++;
      this.log.debug(`ignored ${msg.t} with incompatible app version ${ann.appVersion}`);
      return;
    }
    if (link.nodeId !== null && link.nodeId !== ann.nodeId) {
      this.counters.badAnnouncements++;
      this.log.warn(`link bound to ${link.nodeId.slice(0, 8)} announced another node id; ignored`);
      return;
    }
    let peer = this.peersById.get(ann.nodeId);
    if (!peer && this.peersById.size >= this.maxPeers) {
      this.counters.peersRejected++;
      return;
    }
    const now = this.clock.now();
    const bound = link.nodeId === ann.nodeId;
    // Untrusted link: only a hello whose signature covers our current nonce binds it.
    let proven = false;
    let channelBound = false;
    if (link.auth) {
      if (msg.t === 'hello') {
        link.peerNonce = msg.nonce;
        if (msg.peerNonce !== link.nonce) {
          // The remote lacks our current nonce, or replays an old hello: answer, never bind on it.
          if (bound) this.touch(link);
          this.answerHello(link);
          return;
        }
        // The hello must be made for this channel. A sender without a channel
        // id (its transport has none) still binds, unprotected.
        const theirs = msg.channel ?? '';
        if (link.channel !== '' && theirs !== '' && theirs !== link.channel) {
          this.counters.badAnnouncements++;
          this.counters.channelMismatches++;
          this.log.warn(`rejected hello made for another channel (claims ${ann.nodeId.slice(0, 8)}; relayed by a third party?)`);
          return;
        }
        if (!verifyHello(ann, msg.nonce, msg.peerNonce, msg.sig, theirs)) {
          this.counters.badAnnouncements++;
          this.log.warn(`rejected hello with a bad signature (claims ${ann.nodeId.slice(0, 8)})`);
          return;
        }
        proven = true;
        channelBound = theirs !== '' && theirs === link.channel;
      } else if (!bound) {
        // A status cannot bind this link, but its sender thinks it is bound to
        // us. A new nonce voids its old proof, so our hello gets a fresh one.
        link.nonce = newNonce();
        this.answerHello(link);
        return;
      }
    }
    const floor = this.annFloor.peek(ann.nodeId);
    if (floor && !proven) {
      const stale = ann.ts < floor.ts || (floor.strict && ann.ts <= floor.ts);
      const blocked = !bound && msg.t === 'status' && now < floor.statusBlockedUntil;
      if (stale || blocked) {
        if (bound) this.touch(link);
        return;
      }
    }
    let canon: string | null = null;
    if (!proven) {
      canon = canonicalJson(ann);
      const known = peer?.verified?.sig === msg.sig && peer.verified.canon === canon;
      if (!known && !verifyAnnouncement(ann, msg.sig)) {
        this.counters.badAnnouncements++;
        this.log.warn(`rejected ${msg.t} with a bad signature (claims ${ann.nodeId.slice(0, 8)})`);
        return;
      }
    }
    this.annFloor.set(ann.nodeId, { ts: floor ? Math.max(floor.ts, ann.ts) : ann.ts, strict: false, statusBlockedUntil: 0 });
    const isNew = !peer;
    if (!peer) {
      peer = {
        nodeId: ann.nodeId,
        ann: cloneAnn(ann),
        links: [],
        connectedAt: now,
        lastSeen: now,
        latencyMs: null,
        verified: null,
        inflight: 0,
        partTokens: this.maxResponseBytes,
        partTokensAt: now,
      };
      this.peersById.set(peer.nodeId, peer);
    }
    if (canon !== null) peer.verified = { sig: msg.sig, canon };
    const newer = !isNew && ann.ts > peer.ann.ts;
    if (newer) peer.ann = cloneAnn(ann);
    link.lastSeen = now;
    peer.lastSeen = now;
    if (!bound) {
      this.bindLink(link, peer);
      if (channelBound) this.counters.channelBound++;
      if (!link.auth && !link.greeted) this.greet(link);
    } else if (msg.t === 'hello' && !link.auth) {
      // The peer re-created its side of a link we kept: it lacks our announcement.
      this.sendOnLink(link, this.statusMessage());
    }
    // The remote binds us only on a hello that covers its current nonce.
    if (proven && link.coveredPeerNonce !== link.peerNonce) this.answerHello(link);
    if (isNew) {
      this.log.info(`peer ${ann.name || ann.nodeId.slice(0, 8)} connected via ${link.transport.kind}${channelBound ? ' (hello bound to the channel)' : ''}`);
      this.emit('onPeerConnected', peer);
    } else if (newer) {
      this.emit('onPeerStatus', peer);
    }
  }

  private touch(link: Link): void {
    const now = this.clock.now();
    link.lastSeen = now;
    const peer = link.nodeId !== null ? this.peersById.get(link.nodeId) : undefined;
    if (peer) peer.lastSeen = now;
  }

  private onStellar(peer: PeerState, xdrB64: string, flood: boolean): void {
    if (flood) {
      let id: string;
      try {
        id = stellarMessageId(xdrB64);
      } catch {
        this.counters.invalid++;
        return;
      }
      if (this.seen.touch(id)) {
        this.counters.floodDuplicates++;
        return;
      }
      this.seen.add(id);
      this.counters.floodsIn++;
    }
    let keep = true;
    try {
      // A handler may return false to stop the re-flood (e.g. invalid content).
      const r = this.handlers.onStellarMessage(xdrB64, this.info(peer)) as unknown;
      if (r === false) keep = false;
    } catch (err) {
      this.log.error(`onStellarMessage failed: ${errorText(err)}`);
    }
    if (flood && keep && this.running) this.floodToPeers(xdrB64, peer.nodeId);
  }

  private onRequest(link: Link, peer: PeerState, id: string, body: RequestBody): void {
    this.counters.requestsIn++;
    if (peer.inflight >= this.maxInbound) {
      this.counters.requestsRejectedBusy++;
      this.reply(link, peer.nodeId, id, null, 'busy');
      return;
    }
    peer.inflight++;
    const nodeId = peer.nodeId;
    let settled = false;
    // A handler that never settles must not hold the peer's slot forever.
    const timer = this.clock.setTimeout(() => {
      if (settled) return;
      this.counters.requestHandlerTimeouts++;
      this.log.warn(`${body.kind} request from ${nodeId.slice(0, 8)} not answered within ${this.inboundTimeoutMs} ms`);
      done(null, 'handler timeout');
    }, this.inboundTimeoutMs);
    const done = (res: ResponseBody | null, error?: string): void => {
      if (settled) return;
      settled = true;
      this.clock.clearTimeout(timer);
      peer.inflight--;
      this.reply(link, nodeId, id, res, error);
    };
    let result: ReturnType<OverlayHandlers['onRequest']>;
    try {
      result = this.handlers.onRequest(body, this.info(peer));
    } catch (err) {
      done(null, errorText(err));
      return;
    }
    Promise.resolve(result).then(
      (res) => done(res ?? null),
      (err: unknown) => done(null, errorText(err)),
    );
  }

  private reply(link: Link, nodeId: string, id: string, body: ResponseBody | null, error?: string): void {
    if (!this.running) return;
    const peer = this.peersById.get(nodeId);
    if (!peer) return;
    let res: WireMessage;
    if (error !== undefined) {
      res = { t: 'res', id, body: null, error: error.slice(0, MAX_ERROR_LENGTH) };
    } else if (body !== null && !isResponseBody(body)) {
      this.log.error(`request handler returned a malformed ${String((body as { kind?: unknown }).kind)} response`);
      res = { t: 'res', id, body: null, error: 'internal error: malformed response' };
    } else {
      res = { t: 'res', id, body };
    }
    let size = estimateSize(res, this.maxBytes);
    const sameLink = link.nodeId === nodeId && this.links.get(link.key) === link;
    const send = (m: WireMessage, n: number): boolean => (sameLink ? this.sendOnLink(link, m, n) : this.sendToPeer(peer, m, n));
    if (size > this.maxBytes && res.t === 'res' && res.body !== null) {
      // Too large for one message: send the body's JSON in parts, within the budgets.
      const estimate = estimateSize(res.body);
      if (estimate <= this.maxResponseBytes && !this.takePartBudget(peer, estimate)) {
        this.counters.requestsRejectedBusy++;
        send({ t: 'res', id, body: null, error: 'busy: large responses are rate limited' }, 64);
        return;
      }
      const text = estimate <= this.maxResponseBytes ? JSON.stringify(res.body) : '';
      if (estimate <= this.maxResponseBytes && text.length <= this.maxResponseBytes) {
        const parts = splitParts(text, Math.min(this.partChars, Math.ceil(text.length / 2)));
        if (parts.length <= MAX_PARTS) {
          parts.forEach((data, index) => {
            const part: WireMessage = { t: 'part', id, index, total: parts.length, data };
            if (send(part, data.length + 64)) this.counters.partsOut++;
          });
          return;
        }
      }
      this.log.warn(`response to ${nodeId.slice(0, 8)} too large (${Math.max(estimate, text.length)} bytes)`);
      res = { t: 'res', id, body: null, error: 'response too large' };
      size = estimateSize(res);
    } else if (size > this.maxBytes) {
      res = { t: 'res', id, body: null, error: 'response too large' };
      size = estimateSize(res);
    }
    send(res, size);
  }

  /** Take `chars` from the peer's and the shared budget for large responses, if both have enough. */
  private takePartBudget(peer: PeerState, chars: number): boolean {
    const now = this.clock.now();
    const cap = this.maxResponseBytes;
    peer.partTokens = Math.min(cap, peer.partTokens + (Math.max(0, now - peer.partTokensAt) * cap) / (PART_BUDGET_PEER_REFILL_S * 1000));
    peer.partTokensAt = now;
    this.partTokens = Math.min(2 * cap, this.partTokens + (Math.max(0, now - this.partTokensAt) * cap) / (PART_BUDGET_TOTAL_REFILL_S * 1000));
    this.partTokensAt = now;
    if (peer.partTokens < chars || this.partTokens < chars) return false;
    peer.partTokens -= chars;
    this.partTokens -= chars;
    return true;
  }

  /** One part of a response to our request. The request resolves when all parts are in. */
  private onPart(peer: PeerState, id: string, index: number, total: number, data: string): void {
    const p = this.pending.get(id);
    if (!p || p.nodeId !== peer.nodeId) {
      this.counters.unexpectedResponses++;
      return;
    }
    this.counters.partsIn++;
    const st = (p.parts ??= { total, got: 0, chunks: new Array<string | undefined>(total), chars: 0 });
    if (total !== st.total) {
      this.failPending(id, p, 'bad-response', `${p.kind} response parts disagree on their count`);
      return;
    }
    if (st.chunks[index] !== undefined) return;
    st.chars += data.length;
    if (st.chars > this.maxResponseBytes) {
      this.failPending(id, p, 'bad-response', `${p.kind} response is larger than ${this.maxResponseBytes} bytes`);
      return;
    }
    st.chunks[index] = data;
    st.got++;
    this.clock.clearTimeout(p.timer);
    if (st.got < st.total) {
      // Each part restarts the timer, but only data buys more time: the whole
      // response must arrive within two timeouts plus one per partChars
      // received, so a peer cannot hold a request open with tiny parts.
      const deadline = p.sentAt + p.timeoutMs * (2 + st.chars / this.partChars);
      p.timer = this.armRequestTimer(id, p, Math.max(0, Math.min(p.timeoutMs, deadline - this.clock.now())));
      return;
    }
    this.pending.delete(id);
    const text = st.chunks.join('');
    st.chunks = [];
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      p.reject(new OverlayRequestError('bad-response', `${p.kind} response parts do not form JSON`));
      return;
    }
    if (!isResponseBody(body)) {
      p.reject(new OverlayRequestError('bad-response', `malformed ${p.kind} response`));
      return;
    }
    this.onResponse(peer, id, body, undefined, p);
  }

  private failPending(id: string, p: Pending, code: OverlayErrorCode, message: string): void {
    if (this.pending.get(id) === p) this.pending.delete(id);
    this.clock.clearTimeout(p.timer);
    p.reject(new OverlayRequestError(code, message));
  }

  private onResponse(
    peer: PeerState,
    id: string,
    body: ResponseBody | null,
    error: string | undefined,
    reassembled?: Pending,
  ): void {
    const p = reassembled ?? this.pending.get(id);
    if (!p || p.nodeId !== peer.nodeId) {
      this.counters.unexpectedResponses++;
      return;
    }
    this.pending.delete(id);
    this.clock.clearTimeout(p.timer);
    const rtt = Math.max(0, this.clock.now() - p.sentAt);
    peer.latencyMs = peer.latencyMs === null ? rtt : Math.round(peer.latencyMs * 0.7 + rtt * 0.3);
    if (error !== undefined) {
      p.reject(new OverlayRequestError('remote-error', `${p.kind} request failed: ${error}`));
    } else if (body === null) {
      p.reject(new OverlayRequestError('no-data', `peer ${peer.nodeId} has no data for ${p.kind}`));
    } else if (body.kind !== p.kind) {
      p.reject(new OverlayRequestError('bad-response', `expected ${p.kind} response, got ${body.kind}`));
    } else {
      p.resolve(body);
    }
  }

  // ------------------------------------------------------------ handlers

  private info(p: PeerState): PeerInfo {
    const kinds: TransportKind[] = [];
    for (const l of [...p.links].sort((a, b) => a.rank - b.rank)) {
      if (!kinds.includes(l.transport.kind)) kinds.push(l.transport.kind);
    }
    return {
      nodeId: p.nodeId,
      name: p.ann.name,
      transports: kinds,
      ann: cloneAnn(p.ann),
      connectedAt: p.connectedAt,
      lastSeen: p.lastSeen,
      latencyMs: p.latencyMs,
    };
  }

  private emit(name: 'onPeerConnected' | 'onPeerStatus', peer: PeerState): void {
    const fn = this.handlers[name];
    if (!fn) return;
    try {
      fn.call(this.handlers, this.info(peer));
    } catch (err) {
      this.log.error(`${name} failed: ${errorText(err)}`);
    }
  }

  private emitDisconnected(peer: PeerState): void {
    const fn = this.handlers.onPeerDisconnected;
    if (!fn) return;
    try {
      fn.call(this.handlers, this.info(peer));
    } catch (err) {
      this.log.error(`onPeerDisconnected failed: ${errorText(err)}`);
    }
  }

  private checkFields(f: AnnouncementFields): AnnouncementFields {
    const probe = { ...f, nodeId: this.nodeId, networkId: this.networkId, appVersion: this.appVersion, ts: 0 };
    if (!isAnnouncement(probe)) {
      throw new TypeError(
        'Overlay: invalid announcement fields (lcl.hash: 64 lowercase hex, qsetHash: "" or 64 lowercase hex, ' +
          'state: a PeerSyncState, quorumMode: auto|manual)',
      );
    }
    return { ...f, lcl: { seq: f.lcl.seq, hash: f.lcl.hash } };
  }
}
