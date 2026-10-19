// Wire-level helpers: validation of untrusted messages, size estimates,
// announcement signatures and flood message ids.

import type { Keypair } from '@stellar/stellar-sdk/base';
import { fromBase64, toHex } from '../lib/bytes';
import { sha256, sha256Hex } from '../lib/hash';
import { signHex, verifyHex } from '../lib/keys';
import { canonicalJson } from './canonicalJson';
import type { NodeAnnouncement, PeerSyncState, RequestBody, ResponseBody, WireMessage } from './types';

/** Messages larger than this (estimated JSON size) are dropped. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_NAME_LENGTH = 64;
export const MAX_REQUEST_ID_LENGTH = 64;
export const MAX_ERROR_LENGTH = 256;
/** Most parts one response may be split into. */
export const MAX_PARTS = 256;

const SYNC_STATES: ReadonlySet<string> = new Set<PeerSyncState>([
  'booting',
  'catching-up',
  'synced',
  'stalled',
  'stopped',
]);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NONCE = /^[0-9a-f]{32}$/;
/** StrKey of an ed25519 public key (G...); the checksum is checked when a signature is verified. */
const NODE_ID = /^G[A-Z2-7]{55}$/;
const ANN_KEYS: ReadonlySet<string> = new Set([
  'nodeId',
  'name',
  'networkId',
  'appVersion',
  'lcl',
  'state',
  'validator',
  'qsetHash',
  'quorumMode',
  'ts',
]);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUint(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

export function isBase64(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length % 4 === 0 && BASE64.test(v);
}

function isStr(v: unknown, maxLen = Infinity): v is string {
  return typeof v === 'string' && v.length <= maxLen;
}

export function isNonce(v: unknown): v is string {
  return typeof v === 'string' && NONCE.test(v);
}

function onlyKeys(o: Obj, allowed: ReadonlySet<string>): boolean {
  for (const k of Object.keys(o)) if (!allowed.has(k)) return false;
  return true;
}

const LCL_KEYS: ReadonlySet<string> = new Set(['seq', 'hash']);

/**
 * Shape check of a NodeAnnouncement (no signature check). Unknown fields are
 * rejected: they would be signed, stored and copied with every peer view.
 */
export function isAnnouncement(a: unknown): a is NodeAnnouncement {
  if (!isObj(a) || !onlyKeys(a, ANN_KEYS)) return false;
  const lcl = a.lcl;
  return (
    typeof a.nodeId === 'string' &&
    NODE_ID.test(a.nodeId) &&
    isStr(a.name, MAX_NAME_LENGTH) &&
    isHex64(a.networkId) &&
    typeof a.appVersion === 'number' &&
    Number.isSafeInteger(a.appVersion) &&
    isObj(lcl) &&
    onlyKeys(lcl, LCL_KEYS) &&
    isUint(lcl.seq) &&
    isHex64(lcl.hash) &&
    typeof a.state === 'string' &&
    SYNC_STATES.has(a.state) &&
    typeof a.validator === 'boolean' &&
    typeof a.qsetHash === 'string' &&
    (a.qsetHash === '' || HEX64.test(a.qsetHash)) &&
    (a.quorumMode === 'auto' || a.quorumMode === 'manual') &&
    typeof a.ts === 'number' &&
    Number.isFinite(a.ts)
  );
}

export function isRequestBody(b: unknown): b is RequestBody {
  if (!isObj(b)) return false;
  switch (b.kind) {
    case 'headers':
    case 'ledgers':
      return isUint(b.from) && isUint(b.to);
    case 'snapshot':
      return isUint(b.atOrBefore);
    case 'scpState':
      return isUint(b.fromSlot);
    case 'branchWeight':
      return isUint(b.afterSeq);
    default:
      return false;
  }
}

export function isResponseBody(b: unknown): b is ResponseBody {
  if (!isObj(b)) return false;
  switch (b.kind) {
    case 'headers':
      return Array.isArray(b.items) && b.items.every((i) => isObj(i) && isUint(i.seq) && isStr(i.headerXdr));
    case 'ledgers':
      return (
        Array.isArray(b.items) &&
        b.items.every((i) => isObj(i) && isUint(i.seq) && isStr(i.headerXdr) && isStr(i.txSetXdr))
      );
    case 'snapshot':
      return isUint(b.seq) && isStr(b.data);
    case 'scpState':
      return Array.isArray(b.envelopes) && b.envelopes.every((e) => isStr(e));
    case 'branchWeight':
      return (
        isUint(b.afterSeq) &&
        typeof b.weight === 'number' &&
        Number.isFinite(b.weight) &&
        isObj(b.lcl) &&
        isUint(b.lcl.seq) &&
        isStr(b.lcl.hash, 64)
      );
    default:
      return false;
  }
}

/** Full shape check of an untrusted wire message. */
export function isWireMessage(m: unknown): m is WireMessage {
  if (!isObj(m)) return false;
  switch (m.t) {
    case 'hello':
      return (
        isAnnouncement(m.ann) &&
        typeof m.sig === 'string' &&
        HEX128.test(m.sig) &&
        isNonce(m.nonce) &&
        (m.peerNonce === undefined || isNonce(m.peerNonce)) &&
        (m.channel === undefined || isHex64(m.channel))
      );
    case 'status':
      return isAnnouncement(m.ann) && typeof m.sig === 'string' && HEX128.test(m.sig);
    case 'stellar':
      return isBase64(m.xdr) && (m.flood === undefined || typeof m.flood === 'boolean');
    case 'req':
      return isStr(m.id, MAX_REQUEST_ID_LENGTH) && m.id.length > 0 && isRequestBody(m.body);
    case 'res':
      return (
        isStr(m.id, MAX_REQUEST_ID_LENGTH) &&
        m.id.length > 0 &&
        (m.body === null || isResponseBody(m.body)) &&
        (m.error === undefined || isStr(m.error, MAX_ERROR_LENGTH))
      );
    case 'part':
      return (
        isStr(m.id, MAX_REQUEST_ID_LENGTH) &&
        m.id.length > 0 &&
        isUint(m.total) &&
        m.total >= 2 &&
        m.total <= MAX_PARTS &&
        isUint(m.index) &&
        m.index < m.total &&
        typeof m.data === 'string'
      );
    case 'bye':
      return isStr(m.nodeId, 64);
    default:
      return false;
  }
}

const MAX_SIZE_DEPTH = 12;

/**
 * Rough JSON size of a value in bytes (strings count one byte per code unit).
 * Stops early once the running total passes `limit`. Returns Infinity for
 * values that cannot be JSON (bigint, functions) or are nested too deep.
 */
export function estimateSize(value: unknown, limit = Infinity): number {
  return sizeOf(value, 0, limit);
}

function sizeOf(v: unknown, depth: number, limit: number): number {
  switch (typeof v) {
    case 'string':
      return v.length + 2;
    case 'number':
      return 8;
    case 'boolean':
      return 5;
    case 'undefined':
      return 0;
    case 'object': {
      if (v === null) return 4;
      if (depth >= MAX_SIZE_DEPTH) return Infinity;
      let total = 2;
      if (Array.isArray(v)) {
        for (const item of v) {
          total += sizeOf(item, depth + 1, limit) + 1;
          if (total > limit) return total;
        }
        return total;
      }
      for (const key of Object.keys(v)) {
        total += key.length + 4 + sizeOf((v as Obj)[key], depth + 1, limit);
        if (total > limit) return total;
      }
      return total;
    }
    default:
      return Infinity;
  }
}

// ---------------------------------------------------------------- announcements

/** The 32-byte digest that announcement signatures cover. */
export function announcementDigest(ann: NodeAnnouncement): Uint8Array {
  return sha256(canonicalJson(ann));
}

/** ed25519 over sha256(canonicalJson(ann)), hex. */
export function signAnnouncement(kp: Keypair, ann: NodeAnnouncement): string {
  return signHex(kp, announcementDigest(ann));
}

/** Never throws. False on a bad signature or a malformed node id. */
export function verifyAnnouncement(ann: NodeAnnouncement, sig: string): boolean {
  try {
    return verifyHex(ann.nodeId, announcementDigest(ann), sig);
  } catch {
    return false;
  }
}

/**
 * Digest a hello signature covers when it answers the receiver's link nonce
 * (`peerNonce`). Its shape differs from an announcement's, so a hello
 * signature never verifies as a status signature and the other way round.
 * `channel` (the sender's channel id, '' when its transport has none) binds
 * the hello to the secure channel it was sent on.
 */
export function helloDigest(ann: NodeAnnouncement, nonce: string, peerNonce: string, channel = ''): Uint8Array {
  return sha256(canonicalJson(channel ? { t: 'hello', ann, nonce, peerNonce, channel } : { t: 'hello', ann, nonce, peerNonce }));
}

export function signHello(kp: Keypair, ann: NodeAnnouncement, nonce: string, peerNonce: string, channel = ''): string {
  return signHex(kp, helloDigest(ann, nonce, peerNonce, channel));
}

/** Never throws. */
export function verifyHello(ann: NodeAnnouncement, nonce: string, peerNonce: string, sig: string, channel = ''): boolean {
  try {
    return verifyHex(ann.nodeId, helloDigest(ann, nonce, peerNonce, channel), sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- misc

/** Flood dedupe id: SHA-256 hex of the decoded XDR bytes. Throws on bad base64. */
export function stellarMessageId(xdrB64: string): string {
  return sha256Hex(fromBase64(xdrB64));
}

/** Random lowercase hex id (not for keys). */
export function randomId(bytes = 8): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}
