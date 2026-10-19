// Overlay module exports. TrysteroHost is deliberately not exported here:
// it pulls in WebRTC code and must only be imported on the main thread,
// directly from './trysteroHost'.

export * from './types';
export {
  Overlay,
  OverlayRequestError,
  AUTHENTICATED_KINDS,
  DEFAULT_RATE_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FLOOD_DEDUPE_CAPACITY,
  INBOUND_HANDLER_TIMEOUT_MS,
  MAX_INBOUND_REQUESTS_PER_PEER,
  MAX_LINKS,
  MAX_PEERS,
  MAX_RESPONSE_BYTES,
  MIN_STATUS_GAP_MS,
  PART_CHARS,
  splitParts,
  type AnnouncementFields,
  type OverlayErrorCode,
  type OverlayOptions,
  type OverlayStats,
  type RateLimit,
} from './overlay';
export {
  MemoryNetwork,
  MemoryTransport,
  defaultLatency,
  type LatencyFn,
  type MemoryNetworkOptions,
  type MemoryNetworkStats,
  type MemoryNodeStats,
} from './memoryNetwork';
export {
  BroadcastChannelTransport,
  broadcastChannelName,
  type BroadcastChannelLike,
  type BroadcastChannelTransportOptions,
  type BroadcastFrame,
  type BroadcastFrameKind,
} from './broadcastTransport';
export { BridgeTransport, type BridgeTransportOptions } from './bridgeTransport';
export {
  parseMainToWorker,
  parseWorkerToMain,
  type MainToWorker,
  type PortLike,
  type WorkerToMain,
} from './bridgeProtocol';
export * from './stellarMessage';
export { canonicalJson } from './canonicalJson';
export {
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  MAX_PARTS,
  announcementDigest,
  estimateSize,
  helloDigest,
  isAnnouncement,
  isNonce,
  isRequestBody,
  isResponseBody,
  isWireMessage,
  signAnnouncement,
  signHello,
  verifyAnnouncement,
  verifyHello,
} from './wire';
export { LruMap, LruSet } from './lru';
