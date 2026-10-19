// Build and parse xdr.StellarMessage (base64) for the message types the
// herder uses. The overlay itself treats these strings as opaque.

import { xdr } from '@stellar/stellar-sdk/base';
import { fromHex, toHex } from '../lib/bytes';

export { stellarMessageId } from './wire';

export type StellarMessageKind =
  | 'scpMessage'
  | 'transaction'
  | 'txSet'
  | 'getTxSet'
  | 'scpQuorumset'
  | 'getScpQuorumset'
  | 'dontHave';

/** Item types a DONT_HAVE can refer to (stellar-core sends the item type, not the request type). */
export type DontHaveItem = 'txSet' | 'scpQuorumset';

export type ParsedStellarMessage =
  | { kind: 'scpMessage'; envelope: xdr.ScpEnvelope; envelopeXdr: string }
  | { kind: 'transaction'; envelope: xdr.TransactionEnvelope; envelopeXdr: string }
  | { kind: 'txSet'; txSet: xdr.TransactionSet; txSetXdr: string }
  | { kind: 'getTxSet'; hash: string }
  | { kind: 'scpQuorumset'; qset: xdr.ScpQuorumSet; qsetXdr: string }
  | { kind: 'getScpQuorumset'; hash: string }
  | { kind: 'dontHave'; itemType: DontHaveItem; hash: string };

function hash32(hashHex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new Error('expected a 32-byte lowercase hex hash');
  return fromHex(hashHex);
}

function b64(msg: xdr.StellarMessage): string {
  return msg.toXdr('base64');
}

/** SCP_MESSAGE from an xdr.ScpEnvelope or its base64 XDR. */
export function makeScpMessage(envelope: xdr.ScpEnvelope | string): string {
  const env = typeof envelope === 'string' ? xdr.ScpEnvelope.fromXdr(envelope, 'base64') : envelope;
  return b64(xdr.StellarMessage.scpMessage(env));
}

/** TRANSACTION from an xdr.TransactionEnvelope or its base64 XDR. */
export function makeTransactionMessage(envelope: xdr.TransactionEnvelope | string): string {
  const env = typeof envelope === 'string' ? xdr.TransactionEnvelope.fromXdr(envelope, 'base64') : envelope;
  return b64(xdr.StellarMessage.transaction(env));
}

/** TX_SET from an xdr.TransactionSet or its base64 XDR. */
export function makeTxSetMessage(txSet: xdr.TransactionSet | string): string {
  const ts = typeof txSet === 'string' ? xdr.TransactionSet.fromXdr(txSet, 'base64') : txSet;
  return b64(xdr.StellarMessage.txSet(ts));
}

/** GET_TX_SET for a tx set hash (hex). */
export function makeGetTxSetMessage(txSetHashHex: string): string {
  return b64(xdr.StellarMessage.getTxSet(hash32(txSetHashHex)));
}

/** SCP_QUORUMSET from an xdr.ScpQuorumSet or its base64 XDR. */
export function makeScpQuorumSetMessage(qset: xdr.ScpQuorumSet | string): string {
  const q = typeof qset === 'string' ? xdr.ScpQuorumSet.fromXdr(qset, 'base64') : qset;
  return b64(xdr.StellarMessage.scpQuorumset(q));
}

/** GET_SCP_QUORUMSET for a quorum set hash (hex). */
export function makeGetScpQuorumSetMessage(qsetHashHex: string): string {
  return b64(xdr.StellarMessage.getScpQuorumset(hash32(qsetHashHex)));
}

/** DONT_HAVE: the item type we lack (TX_SET or SCP_QUORUMSET) and its hash. */
export function makeDontHaveMessage(itemType: DontHaveItem, hashHex: string): string {
  const type = itemType === 'txSet' ? xdr.MessageType.txSet : xdr.MessageType.scpQuorumset;
  return b64(xdr.StellarMessage.dontHave(new xdr.DontHave({ type, reqHash: hash32(hashHex) })));
}

/** Decode a base64 StellarMessage. Throws if malformed or of an unsupported type. */
export function parseStellarMessage(xdrB64: string): ParsedStellarMessage {
  const msg = xdr.StellarMessage.fromXdr(xdrB64, 'base64');
  switch (msg.type) {
    case 'scpMessage': {
      const envelope = msg.envelope;
      return { kind: 'scpMessage', envelope, envelopeXdr: envelope.toXdr('base64') };
    }
    case 'transaction': {
      const envelope = msg.transaction;
      return { kind: 'transaction', envelope, envelopeXdr: envelope.toXdr('base64') };
    }
    case 'txSet': {
      const txSet = msg.txSet;
      return { kind: 'txSet', txSet, txSetXdr: txSet.toXdr('base64') };
    }
    case 'getTxSet':
      return { kind: 'getTxSet', hash: toHex(msg.txSetHash.toBytes()) };
    case 'scpQuorumset': {
      const qset = msg.qSet;
      return { kind: 'scpQuorumset', qset, qsetXdr: qset.toXdr('base64') };
    }
    case 'getScpQuorumset':
      return { kind: 'getScpQuorumset', hash: toHex(msg.qSetHash.toBytes()) };
    case 'dontHave': {
      const dh = msg.dontHave;
      const t = dh.type.name;
      // stellar-core treats TX_SET and GENERALIZED_TX_SET the same here.
      let itemType: DontHaveItem;
      if (t === 'txSet' || t === 'generalizedTxSet') itemType = 'txSet';
      else if (t === 'scpQuorumset') itemType = 'scpQuorumset';
      else throw new Error(`unsupported DONT_HAVE item type: ${t}`);
      return { kind: 'dontHave', itemType, hash: toHex(dh.reqHash.toBytes()) };
    }
    default:
      throw new Error(`unsupported StellarMessage type: ${msg.type}`);
  }
}

/** Parse, or null if malformed or unsupported. Never throws. */
export function tryParseStellarMessage(xdrB64: string): ParsedStellarMessage | null {
  try {
    return parseStellarMessage(xdrB64);
  } catch {
    return null;
  }
}
