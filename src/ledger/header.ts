// LedgerHeader codec and hash (docs/ARCHITECTURE.md 5.5).

import { xdr } from '@stellar/stellar-sdk/base';
import { fromBase64, fromHex, toBase64, toHex } from '../lib/bytes';
import { sha256Hex } from '../lib/hash';
import type { Hash, LedgerHeader } from './types';
import { stellarValueFromXdr, stellarValueToXdr } from './value';

function hash32(hex: Hash, what: string): Uint8Array {
  const b = fromHex(hex);
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
}

export function ledgerHeaderToXdr(h: LedgerHeader): xdr.LedgerHeader {
  return new xdr.LedgerHeader({
    ledgerVersion: h.ledgerVersion,
    previousLedgerHash: hash32(h.previousLedgerHash, 'previousLedgerHash'),
    scpValue: stellarValueToXdr(h.scpValue),
    txSetResultHash: hash32(h.txSetResultHash, 'txSetResultHash'),
    bucketListHash: hash32(h.bucketListHash, 'bucketListHash'),
    ledgerSeq: h.ledgerSeq,
    totalCoins: xdr.Int64(h.totalCoins),
    feePool: xdr.Int64(h.feePool),
    inflationSeq: h.inflationSeq,
    idPool: xdr.Uint64(h.idPool),
    baseFee: h.baseFee,
    baseReserve: h.baseReserve,
    maxTxSetSize: h.maxTxSetSize,
    skipList: h.skipList.map((s, i) => hash32(s, `skipList[${i}]`)),
    ext: xdr.LedgerHeaderExt.v0(),
  });
}

export function ledgerHeaderFromXdr(x: xdr.LedgerHeader): LedgerHeader {
  const skip = x.skipList.map((s) => toHex(s.value));
  if (skip.length !== 4) throw new Error('skipList must have 4 entries');
  return {
    ledgerVersion: x.ledgerVersion,
    previousLedgerHash: toHex(x.previousLedgerHash.value),
    scpValue: stellarValueFromXdr(x.scpValue),
    txSetResultHash: toHex(x.txSetResultHash.value),
    bucketListHash: toHex(x.bucketListHash.value),
    ledgerSeq: x.ledgerSeq,
    totalCoins: x.totalCoins,
    feePool: x.feePool,
    inflationSeq: x.inflationSeq,
    idPool: x.idPool,
    baseFee: x.baseFee,
    baseReserve: x.baseReserve,
    maxTxSetSize: x.maxTxSetSize,
    skipList: skip as LedgerHeader['skipList'],
  };
}

/** Base64 of xdr.LedgerHeader. */
export function encodeLedgerHeader(h: LedgerHeader): string {
  return toBase64(ledgerHeaderToXdr(h).toXdr());
}

/** Decode base64 xdr.LedgerHeader. Throws if malformed. */
export function decodeLedgerHeader(b64: string): LedgerHeader {
  return ledgerHeaderFromXdr(xdr.LedgerHeader.fromXdr(fromBase64(b64)));
}

/** Ledger hash = SHA-256 of the header XDR. */
export function hashLedgerHeader(h: LedgerHeader): Hash {
  return sha256Hex(ledgerHeaderToXdr(h).toXdr());
}

/** Hash of an already encoded header (base64). */
export function hashLedgerHeaderXdr(b64: string): Hash {
  return sha256Hex(fromBase64(b64));
}
