// SCP value and envelope helpers with pure-function caches.
//
// Verifying an ed25519 signature costs about 0.8 ms in pure JS, and SCP asks
// for the same values and envelopes many times. The caches key on the full
// input (network id + bytes), so sharing them between nodes in one process
// (the simulation) is safe.

import { fromBase64, toHex } from '../lib/bytes';
import { sha256Hex } from '../lib/hash';
import { decodeStellarValue, verifyStellarValueSignature } from '../ledger/value';
import { tryDecodeTransaction } from '../ledger/tx';
import type { StellarValueInfo, TxSetInfo } from '../ledger/types';
import { getBallotStatementValues } from '../scp/ballot';
import { getNominationStatementValues } from '../scp/nomination';
import type { Envelope, Statement, Value } from '../scp/types';
import { verifyEnvelope } from '../scp/xdr';
import { Lru } from './lru';

const decoded = new Lru<string, StellarValueInfo | null>(8192);
const valueSigs = new Lru<string, boolean>(8192);
const envelopeSigs = new Lru<string, boolean>(32768);

/** Decoded StellarValue, or null if malformed. The result is shared: do not modify it. */
export function decodeValue(value: Value): StellarValueInfo | null {
  const hit = decoded.get(value);
  if (hit !== undefined) return hit;
  let info: StellarValueInfo | null;
  try {
    info = decodeStellarValue(value);
  } catch {
    info = null;
  }
  decoded.set(value, info);
  return info;
}

/** True when the value is STELLAR_VALUE_SIGNED and the signature checks out. */
export function verifyValueSignature(networkId: Uint8Array, value: Value, info: StellarValueInfo): boolean {
  if (!info.signature) return false;
  const key = `${toHex(networkId)}|${value}`;
  const hit = valueSigs.get(key);
  if (hit !== undefined) return hit;
  const ok = verifyStellarValueSignature(networkId, info);
  valueSigs.set(key, ok);
  return ok;
}

/** Envelope signature check; `key` identifies the exact envelope bytes. */
export function verifyEnvelopeCached(networkId: Uint8Array, env: Envelope, key: string): boolean {
  const k = `${toHex(networkId)}|${key}`;
  const hit = envelopeSigs.get(k);
  if (hit !== undefined) return hit;
  const ok = verifyEnvelope(env, networkId);
  envelopeSigs.set(k, ok);
  return ok;
}

/** Stable id of an envelope: SHA-256 hex of its XDR bytes. */
export function envelopeKeyFromBase64(b64: string): string {
  return sha256Hex(fromBase64(b64));
}

/** Short id of a value for logs and views: first 8 hex chars of its SHA-256. */
export function valueId(value: Value): string {
  return sha256Hex(value).slice(0, 8);
}

/** Values referenced by a statement (the ones SCP validates). */
export function statementValues(st: Statement): Value[] {
  return st.pledges.type === 'nominate' ? getNominationStatementValues(st) : getBallotStatementValues(st);
}

/** Size facts about a tx set, used by combineCandidates and the views. */
export interface TxSetStats {
  txCount: number;
  opCount: number;
  totalFees: bigint;
}

/** Counts operations and fee bids. Undecodable envelopes count as 0. */
export function txSetStats(txSet: TxSetInfo, networkId: Uint8Array): TxSetStats {
  let opCount = 0;
  let totalFees = 0n;
  for (const env of txSet.txs) {
    const tx = tryDecodeTransaction(env, networkId);
    if (!tx) continue;
    opCount += tx.ops.length;
    totalFees += tx.fee;
  }
  return { txCount: txSet.txs.length, opCount, totalFees };
}

/** One-line description of a value for logs: "txset 1a2b3c4d @1790000005". */
export function describeValue(value: Value): string {
  const info = decodeValue(value);
  if (!info) return `[bad ${value.slice(0, 8)}]`;
  return `${info.txSetHash.slice(0, 8)}@${info.closeTime}`;
}
