// StellarValue codec and signatures (docs/ARCHITECTURE.md 5.2).
// The SCP Value is the lowercase hex of xdr.StellarValue.

import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk/base';
import { concatBytes, fromHex, toHex, writeUint32BE, writeUint64BE } from '../lib/bytes';
import { signHex, verifyHex } from '../lib/keys';
import type { Hash, StellarValueInfo } from './types';

const ENVELOPE_TYPE_SCPVALUE = 4;

function hash32(hex: Hash, what: string): Uint8Array {
  const b = fromHex(hex);
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
}

/** StellarValueInfo -> xdr.StellarValue. */
export function stellarValueToXdr(v: StellarValueInfo): xdr.StellarValue {
  if (!Number.isSafeInteger(v.closeTime) || v.closeTime < 0) throw new Error('invalid closeTime');
  const ext = v.signature
    ? xdr.StellarValueExt.stellarValueSigned(
        new xdr.LedgerCloseValueSignature({
          nodeId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(v.signature.nodeId)),
          signature: fromHex(v.signature.signature),
        }),
      )
    : xdr.StellarValueExt.stellarValueBasic();
  return new xdr.StellarValue({
    txSetHash: hash32(v.txSetHash, 'txSetHash'),
    closeTime: BigInt(v.closeTime),
    upgrades: v.upgrades.map((u) => fromHex(u)),
    ext,
  });
}

/** xdr.StellarValue -> StellarValueInfo. */
export function stellarValueFromXdr(x: xdr.StellarValue): StellarValueInfo {
  const ext = x.ext;
  let signature: StellarValueInfo['signature'] = null;
  switch (ext.type) {
    case 'stellarValueBasic':
      break;
    case 'stellarValueSigned': {
      const s = ext.lcValueSignature;
      signature = { nodeId: StrKey.encodeEd25519PublicKey(s.nodeId.ed25519.value), signature: toHex(s.signature.value) };
      break;
    }
    default:
      // Newer XDR knows more arms (STELLAR_VALUE_EMPTY_TX_SET). The old XDR
      // could not decode them, so they stay malformed here.
      throw new Error(`StellarValue: unsupported ext ${ext.type}`);
  }
  const closeTime = x.closeTime;
  if (closeTime > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('closeTime out of range');
  return {
    txSetHash: toHex(x.txSetHash.value),
    closeTime: Number(closeTime),
    upgrades: x.upgrades.map((u) => toHex(u.value)),
    signature,
  };
}

/** SCP value encoding: lowercase hex of the StellarValue XDR. */
export function encodeStellarValue(v: StellarValueInfo): string {
  return toHex(stellarValueToXdr(v).toXdr());
}

/** Decode an SCP value. Throws if malformed. */
export function decodeStellarValue(hex: string): StellarValueInfo {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) throw new Error('StellarValue: invalid hex');
  return stellarValueFromXdr(xdr.StellarValue.fromXdr(fromHex(hex)));
}

/** networkId(32) || int32BE(ENVELOPE_TYPE_SCPVALUE) || txSetHash(32) || uint64BE(closeTime). */
export function stellarValueSignaturePayload(networkId: Uint8Array, txSetHash: Hash, closeTime: number): Uint8Array {
  if (networkId.length !== 32) throw new Error('networkId must be 32 bytes');
  return concatBytes(
    networkId,
    writeUint32BE(ENVELOPE_TYPE_SCPVALUE),
    fromHex(txSetHash),
    writeUint64BE(BigInt(closeTime)),
  );
}

/** Sign (txSetHash, closeTime) with a node key. */
export function signStellarValue(
  networkId: Uint8Array,
  kp: Keypair,
  txSetHash: Hash,
  closeTime: number,
): { nodeId: string; signature: string } {
  const payload = stellarValueSignaturePayload(networkId, txSetHash, closeTime);
  return { nodeId: kp.publicKey(), signature: signHex(kp, payload) };
}

/** A signed STELLAR_VALUE_SIGNED value with no upgrades. */
export function makeSignedStellarValue(
  networkId: Uint8Array,
  kp: Keypair,
  txSetHash: Hash,
  closeTime: number,
): StellarValueInfo {
  return { txSetHash, closeTime, upgrades: [], signature: signStellarValue(networkId, kp, txSetHash, closeTime) };
}

/** True when the value is signed and the signature is valid. Never throws. */
export function verifyStellarValueSignature(networkId: Uint8Array, v: StellarValueInfo): boolean {
  if (!v.signature) return false;
  try {
    const payload = stellarValueSignaturePayload(networkId, v.txSetHash, v.closeTime);
    return verifyHex(v.signature.nodeId, payload, v.signature.signature);
  } catch {
    return false;
  }
}
