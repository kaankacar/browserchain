import { Keypair } from '@stellar/stellar-sdk/base';
import { fromHex, toHex } from './bytes';

/** Sign bytes with a keypair; returns hex signature (64 bytes). */
export function signHex(kp: Keypair, data: Uint8Array): string {
  return toHex(kp.sign(data));
}

/**
 * Verify a hex signature for a G... public key. Never throws: malformed input
 * (bad key, bad hex, wrong length, data that is not bytes) gives false.
 * Verification is strict RFC 8032 (@noble/ed25519 with zip215: false).
 */
export function verifyHex(publicKey: string, data: Uint8Array, sigHex: string): boolean {
  try {
    if (!(data instanceof Uint8Array) || typeof sigHex !== 'string') return false;
    const sig = fromHex(sigHex);
    if (sig.length !== 64) return false;
    return Keypair.fromPublicKey(publicKey).verify(data, sig);
  } catch {
    return false;
  }
}

export function shortKey(key: string, n = 4): string {
  return key.length <= 2 * n + 1 ? key : `${key.slice(0, n)}…${key.slice(-n)}`;
}
