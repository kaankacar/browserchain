// Ported from stellar-core (Apache-2.0): src/scp/SCPDriver.cpp (hashHelper,
// computeHashNode, computeValueHash) with HerderSCPDriver::getHashOf
// (SHA-256 over the concatenated XDR parts).

import { StrKey } from '@stellar/stellar-sdk/base';
import { concatBytes, fromHex, readUint64BE, writeUint32BE, writeUint64BE } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import type { NodeId, Value } from './types';

// values used to switch hash function between priority and neighborhood checks
export const HASH_N = 1;
export const HASH_P = 2;
export const HASH_K = 3;

// ---------------------------------------------------------------------------
// Minimal XDR encoders for the hashed parts.

export function xdrUint64(v: number | bigint): Uint8Array {
  return writeUint64BE(BigInt(v));
}

export function xdrUint32(v: number): Uint8Array {
  return writeUint32BE(v >>> 0);
}

export function xdrInt32(v: number): Uint8Array {
  return writeUint32BE(v | 0);
}

/** Variable-length opaque: uint32 length, bytes, zero padding to 4 bytes. */
export function xdrVarOpaque(bytes: Uint8Array): Uint8Array {
  const pad = (4 - (bytes.length % 4)) % 4;
  const out = new Uint8Array(4 + bytes.length + pad);
  out.set(writeUint32BE(bytes.length), 0);
  out.set(bytes, 4);
  return out;
}

const RAW_KEY_CACHE_LIMIT = 4096;
const rawKeyCache = new Map<NodeId, Uint8Array>();

/** Raw 32-byte ed25519 key of a G... node id (cached). Throws on a bad StrKey. */
export function nodeIdRawKey(nodeId: NodeId): Uint8Array {
  let raw = rawKeyCache.get(nodeId);
  if (raw === undefined) {
    raw = new Uint8Array(StrKey.decodeEd25519PublicKey(nodeId));
    if (rawKeyCache.size >= RAW_KEY_CACHE_LIMIT) rawKeyCache.clear();
    rawKeyCache.set(nodeId, raw);
  }
  return raw;
}

/** XDR PublicKey (PUBLIC_KEY_TYPE_ED25519 = 0, then 32 bytes). */
export function xdrNodeId(nodeId: NodeId): Uint8Array {
  return concatBytes(xdrInt32(0), nodeIdRawKey(nodeId));
}

/** XDR of an SCP Value (opaque<>) given as lowercase hex. */
export function xdrValue(value: Value): Uint8Array {
  return xdrVarOpaque(fromHex(value));
}

// ---------------------------------------------------------------------------

/** SCPDriver::hashHelper: SHA-256(slotIndex || prev || extra...), first 8 bytes big-endian. */
export function hashHelper(slotIndex: number, prev: Value, extra: Uint8Array[]): bigint {
  const t = sha256(concatBytes(xdrUint64(slotIndex), xdrValue(prev), ...extra));
  return readUint64BE(t, 0);
}

/** Gi(isPriority ? P : N, prev, round, nodeId): used for leader selection. */
export function computeHashNode(
  slotIndex: number,
  prev: Value,
  isPriority: boolean,
  roundNumber: number,
  nodeId: NodeId,
): bigint {
  return hashHelper(slotIndex, prev, [xdrUint32(isPriority ? HASH_P : HASH_N), xdrInt32(roundNumber), xdrNodeId(nodeId)]);
}

/** Gi(K, prev, round, value): used to order values taken from leaders. */
export function computeValueHash(slotIndex: number, prev: Value, roundNumber: number, value: Value): bigint {
  return hashHelper(slotIndex, prev, [xdrUint32(HASH_K), xdrInt32(roundNumber), xdrValue(value)]);
}
