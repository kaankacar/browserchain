// Transaction envelope decoding (docs/ARCHITECTURE.md 7.2).
// Ported from stellar-core (Apache-2.0): src/transactions/TransactionFrame.cpp

import { xdr } from '@stellar/stellar-sdk/base';
import { fromBase64, toBase64, toHex } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import { muxedToAccountId, muxedToAddress, u8 } from './xdrutil';

export interface DecodedSignature {
  hint: Uint8Array;
  signature: Uint8Array;
}

export interface DecodedOp {
  index: number;
  /** OperationType name, e.g. "payment", "manageSellOffer". */
  type: string;
  /** True when the operation sets its own source account. */
  explicitSource: boolean;
  /** Source account of the operation (G...): its own or the transaction's. */
  sourceId: string;
  /** M... or G... as written in the operation (or the transaction source). */
  sourceAddress: string;
  body: xdr.OperationBody;
}

export type EnvelopeKind = 'tx' | 'txV0' | 'txFeeBump';

export interface DecodedTx {
  envelope: xdr.TransactionEnvelope;
  /** Normalized base64 of the envelope XDR. */
  envelopeXdr: string;
  envelopeBytes: Uint8Array;
  /** SHA-256 of the envelope XDR (stellar-core getFullHash). */
  fullHash: Uint8Array;
  fullHashHex: string;
  /** Transaction hash: SHA-256 of the TransactionSignaturePayload (getContentsHash). */
  hash: Uint8Array;
  hashHex: string;
  kind: EnvelopeKind;
  /** Source account (G...). For fee bumps: the fee source. */
  sourceId: string;
  sourceAddress: string;
  /** Fee bid in stroops. */
  fee: bigint;
  seqNum: bigint;
  timeBounds: { minTime: bigint; maxTime: bigint } | null;
  ledgerBounds: { minLedger: number; maxLedger: number } | null;
  /** PreconditionsV2.minSeqNum (relaxed sequence check), or null. */
  minSeqNum: bigint | null;
  /** minSeqAge, minSeqLedgerGap or extraSigners present (not supported). */
  unsupportedPreconditions: boolean;
  /** Transaction ext version (1 = Soroban data). */
  extV: number;
  memo: xdr.Memo;
  ops: DecodedOp[];
  signatures: DecodedSignature[];
}

function decodeOps(operations: xdr.Operation[], txSourceId: string, txSourceAddress: string): DecodedOp[] {
  return operations.map((op, index) => {
    const src = op.sourceAccount;
    return {
      index,
      type: op.body.type,
      explicitSource: src != null,
      sourceId: src != null ? muxedToAccountId(src) : txSourceId,
      sourceAddress: src != null ? muxedToAddress(src) : txSourceAddress,
      body: op.body,
    };
  });
}

function decodeSignatures(sigs: xdr.DecoratedSignature[]): DecodedSignature[] {
  return sigs.map((s) => ({ hint: u8(s.hint.value), signature: u8(s.signature.value) }));
}

function payloadHash(networkId: Uint8Array, tagged: xdr.TransactionSignaturePayloadTaggedTransaction): Uint8Array {
  const payload = new xdr.TransactionSignaturePayload({ networkId, taggedTransaction: tagged });
  return sha256(payload.toXdr());
}

/** Transaction ext version: 0, or 1 when it carries Soroban data. */
function txExtVersion(ext: xdr.TransactionExt): number {
  return ext.type === 'sorobanData' ? 1 : 0;
}

/** TransactionV0 as the equivalent v1 Transaction (for hashing). */
function v0ToV1(t: xdr.TransactionV0): xdr.Transaction {
  const tb = t.timeBounds;
  return new xdr.Transaction({
    sourceAccount: xdr.MuxedAccount.keyTypeEd25519(t.sourceAccountEd25519),
    fee: t.fee,
    seqNum: t.seqNum,
    cond: tb ? xdr.Preconditions.precondTime(tb) : xdr.Preconditions.precondNone(),
    memo: t.memo,
    operations: t.operations,
    ext: xdr.TransactionExt.v0(),
  });
}

type Preconds = Pick<DecodedTx, 'timeBounds' | 'ledgerBounds' | 'minSeqNum' | 'unsupportedPreconditions'>;

function preconditions(cond: xdr.Preconditions): Preconds {
  const tbOf = (tb: xdr.TimeBounds | null | undefined) => (tb ? { minTime: tb.minTime, maxTime: tb.maxTime } : null);
  switch (cond.type) {
    case 'precondTime':
      return { timeBounds: tbOf(cond.timeBounds), ledgerBounds: null, minSeqNum: null, unsupportedPreconditions: false };
    case 'precondV2': {
      const v2 = cond.v2;
      const lb = v2.ledgerBounds;
      const minSeq = v2.minSeqNum;
      return {
        timeBounds: tbOf(v2.timeBounds),
        ledgerBounds: lb ? { minLedger: lb.minLedger, maxLedger: lb.maxLedger } : null,
        minSeqNum: minSeq ?? null,
        unsupportedPreconditions: v2.minSeqAge !== 0n || v2.minSeqLedgerGap !== 0 || v2.extraSigners.length > 0,
      };
    }
    default:
      return { timeBounds: null, ledgerBounds: null, minSeqNum: null, unsupportedPreconditions: false };
  }
}

/** Parse an envelope (base64 or XDR object). Throws if the XDR is malformed. */
export function decodeTransaction(envelope: string | xdr.TransactionEnvelope, networkId: Uint8Array): DecodedTx {
  const env = typeof envelope === 'string' ? xdr.TransactionEnvelope.fromXdr(fromBase64(envelope)) : envelope;
  const envelopeBytes = env.toXdr();
  const fullHash = sha256(envelopeBytes);
  const base = {
    envelope: env,
    envelopeXdr: toBase64(envelopeBytes),
    envelopeBytes,
    fullHash,
    fullHashHex: toHex(fullHash),
  };

  switch (env.type) {
    case 'envelopeTypeTx': {
      const v1 = env.v1;
      const t = v1.tx;
      const hash = payloadHash(networkId, xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(t));
      const sourceId = muxedToAccountId(t.sourceAccount);
      const sourceAddress = muxedToAddress(t.sourceAccount);
      return {
        ...base,
        hash,
        hashHex: toHex(hash),
        kind: 'tx',
        sourceId,
        sourceAddress,
        fee: BigInt(t.fee),
        seqNum: t.seqNum,
        ...preconditions(t.cond),
        extV: txExtVersion(t.ext),
        memo: t.memo,
        ops: decodeOps(t.operations, sourceId, sourceAddress),
        signatures: decodeSignatures(v1.signatures),
      };
    }
    case 'envelopeTypeTxV0': {
      const v0 = env.v0;
      const t = v0.tx;
      const v1 = v0ToV1(t);
      const hash = payloadHash(networkId, xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(v1));
      const sourceId = muxedToAccountId(v1.sourceAccount);
      const tb = t.timeBounds;
      return {
        ...base,
        hash,
        hashHex: toHex(hash),
        kind: 'txV0',
        sourceId,
        sourceAddress: sourceId,
        fee: BigInt(t.fee),
        seqNum: t.seqNum,
        timeBounds: tb ? { minTime: tb.minTime, maxTime: tb.maxTime } : null,
        ledgerBounds: null,
        minSeqNum: null,
        unsupportedPreconditions: false,
        extV: 0,
        memo: t.memo,
        ops: decodeOps(t.operations, sourceId, sourceId),
        signatures: decodeSignatures(v0.signatures),
      };
    }
    case 'envelopeTypeTxFeeBump': {
      const fb = env.feeBump;
      const t = fb.tx;
      const hash = payloadHash(networkId, xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTxFeeBump(t));
      const sourceId = muxedToAccountId(t.feeSource);
      const inner = t.innerTx.v1.tx;
      const innerSource = muxedToAccountId(inner.sourceAccount);
      return {
        ...base,
        hash,
        hashHex: toHex(hash),
        kind: 'txFeeBump',
        sourceId,
        sourceAddress: muxedToAddress(t.feeSource),
        fee: t.fee,
        seqNum: inner.seqNum,
        ...preconditions(inner.cond),
        extV: txExtVersion(inner.ext),
        memo: inner.memo,
        ops: decodeOps(inner.operations, innerSource, muxedToAddress(inner.sourceAccount)),
        signatures: decodeSignatures(fb.signatures),
      };
    }
    default:
      throw new Error('unknown envelope type');
  }
}

/** Decode, returning null instead of throwing. */
export function tryDecodeTransaction(envelope: string, networkId: Uint8Array): DecodedTx | null {
  try {
    return decodeTransaction(envelope, networkId);
  } catch {
    return null;
  }
}

/** Ledger sequence number a new account starts with: ledgerSeq << 32. */
export function startingSequenceNumber(ledgerSeq: number): bigint {
  if (ledgerSeq > 0x7fffffff) throw new Error('overflowed getStartingSequenceNumber');
  return BigInt(ledgerSeq) << 32n;
}
