// Classic transaction sets (docs/ARCHITECTURE.md 5.4 and 7.4).
// Ported from stellar-core (Apache-2.0): legacy src/herder/TxSetFrame.cpp
// (sortForHash, getContentsHash, sortForApply)

import { xdr } from '@stellar/stellar-sdk/base';
import { compareBytes, fromBase64, fromHex, toBase64, toHex, xorBytes } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import type { DecodedTx } from './tx';
import type { Hash, TxSetInfo } from './types';

interface EnvelopeItem {
  bytes: Uint8Array;
  hash: Uint8Array;
}

function normalizeEnvelope(b64: string): EnvelopeItem {
  const env = xdr.TransactionEnvelope.fromXdr(fromBase64(b64));
  const bytes = env.toXdr();
  return { bytes, hash: sha256(bytes) };
}

/** SHA-256(previousLedgerHash || env_1 || ... || env_n) over the given order. */
export function computeTxSetHash(previousLedgerHash: Hash, envelopes: Uint8Array[]): Hash {
  // No argument spreading: a tx set from a peer may hold tens of thousands of envelopes.
  const prev = fromHex(previousLedgerHash);
  let len = prev.length;
  for (const e of envelopes) len += e.length;
  const buf = new Uint8Array(len);
  buf.set(prev, 0);
  let off = prev.length;
  for (const e of envelopes) {
    buf.set(e, off);
    off += e.length;
  }
  return toHex(sha256(buf));
}

function build(previousLedgerHash: Hash, items: EnvelopeItem[]): TxSetInfo {
  const prev = fromHex(previousLedgerHash);
  if (prev.length !== 32) throw new Error('previousLedgerHash must be 32 bytes');
  const set = new xdr.TransactionSet({
    previousLedgerHash: prev,
    txs: items.map((i) => xdr.TransactionEnvelope.fromXdr(i.bytes)),
  });
  return {
    hash: computeTxSetHash(previousLedgerHash, items.map((i) => i.bytes)),
    previousLedgerHash: toHex(prev),
    txs: items.map((i) => toBase64(i.bytes)),
    xdr: toBase64(set.toXdr()),
  };
}

/**
 * Canonical tx set: envelopes sorted by SHA-256 of their XDR, exact
 * duplicates dropped. Throws on undecodable envelopes.
 */
export function makeTxSet(previousLedgerHash: Hash, envelopes: string[]): TxSetInfo {
  const items = envelopes.map(normalizeEnvelope);
  items.sort((a, b) => compareBytes(a.hash, b.hash));
  const unique = items.filter((it, i) => i === 0 || compareBytes(items[i - 1].hash, it.hash) !== 0);
  return build(previousLedgerHash, unique);
}

/** Decode a tx set from the network, keeping its order. Throws if malformed. */
export function decodeTxSet(xdrB64: string): TxSetInfo {
  const set = xdr.TransactionSet.fromXdr(fromBase64(xdrB64));
  const items = set.txs.map((env) => {
    const bytes = env.toXdr();
    return { bytes, hash: sha256(bytes) };
  });
  return build(toHex(set.previousLedgerHash.value), items);
}

/** Envelope hashes of a tx set in its order. */
export function txSetEnvelopeHashes(txSet: TxSetInfo): Uint8Array[] {
  return txSet.txs.map((t) => sha256(fromBase64(t)));
}

/** True when the hashes are strictly ascending (canonical order, no duplicates). */
export function isCanonicalOrder(hashes: Uint8Array[]): boolean {
  for (let i = 1; i < hashes.length; i++) if (compareBytes(hashes[i - 1], hashes[i]) >= 0) return false;
  return true;
}

/**
 * Apply order (legacy stellar-core sortForApply): group by source account and
 * sort each group by seqNum; batch k holds the k-th transaction of every
 * account; each batch is sorted by (envelope hash XOR tx set hash).
 */
export function sortForApply(txs: DecodedTx[], txSetHash: Hash): DecodedTx[] {
  const byAccount = new Map<string, DecodedTx[]>();
  for (const tx of txs) {
    let q = byAccount.get(tx.sourceId);
    if (!q) {
      q = [];
      byAccount.set(tx.sourceId, q);
    }
    q.push(tx);
  }
  let depth = 0;
  for (const q of byAccount.values()) {
    q.sort((a, b) => (a.seqNum < b.seqNum ? -1 : a.seqNum > b.seqNum ? 1 : compareBytes(a.fullHash, b.fullHash)));
    depth = Math.max(depth, q.length);
  }
  const setHash = fromHex(txSetHash);
  const out: DecodedTx[] = [];
  for (let k = 0; k < depth; k++) {
    const batch: { tx: DecodedTx; key: Uint8Array }[] = [];
    for (const q of byAccount.values()) if (k < q.length) batch.push({ tx: q[k], key: xorBytes(q[k].fullHash, setHash) });
    batch.sort((a, b) => compareBytes(a.key, b.key));
    for (const b of batch) out.push(b.tx);
  }
  return out;
}
