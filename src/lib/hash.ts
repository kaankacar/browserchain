import { hash } from '@stellar/stellar-sdk/base';
import { toHex, utf8 } from './bytes';

/** Synchronous SHA-256. Strings are hashed as UTF-8. */
export function sha256(data: Uint8Array | string): Uint8Array {
  return hash(typeof data === 'string' ? utf8(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256(data));
}

/** Network ID = SHA-256 of the network passphrase, as in stellar-core. */
export function networkIdOf(passphrase: string): Uint8Array {
  return sha256(passphrase);
}
