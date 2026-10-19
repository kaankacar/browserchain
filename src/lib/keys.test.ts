import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex, utf8 } from './bytes';
import { sha256 } from './hash';
import { signHex, verifyHex } from './keys';

// Order of the ed25519 base point (L).
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** 32-byte little-endian encoding of a scalar. */
function scalarLE(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function scalarFromLE(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

const kp = Keypair.fromRawEd25519Seed(sha256('keys-test-signer'));
const msg = utf8('BrowserChain signature test');

// The small-order points of edwards25519 (canonical encodings), plus two
// non-canonical encodings of the identity. A verifier that accepts any of
// them as a public key accepts the forgery R = identity, S = 0 for every
// message: [8]S·B = [8]R + [8]k·A holds because every term is zero.
const SMALL_ORDER_KEYS = [
  '0100000000000000000000000000000000000000000000000000000000000000', // identity
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // order 2
  '0000000000000000000000000000000000000000000000000000000000000000', // order 4
  '0000000000000000000000000000000000000000000000000000000000000080', // order 4
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', // order 8
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // identity, y = p + 1
  '0100000000000000000000000000000000000000000000000000000000000080', // identity, x = -0
];
const IDENTITY = fromHex(SMALL_ORDER_KEYS[0]);

describe('ed25519 sign and verify (@noble/ed25519, strict RFC 8032)', () => {
  it('accepts a valid signature', () => {
    const sig = signHex(kp, msg);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyHex(kp.publicKey(), msg, sig)).toBe(true);
    // RFC 8032 signatures are deterministic
    expect(signHex(kp, msg)).toBe(sig);
  });

  it('rejects a tampered message and a signature from another key', () => {
    const sig = signHex(kp, msg);
    const tampered = msg.slice();
    tampered[0] ^= 1;
    expect(verifyHex(kp.publicKey(), tampered, sig)).toBe(false);
    expect(verifyHex(kp.publicKey(), concatBytes(msg, new Uint8Array([0])), sig)).toBe(false);
    const other = Keypair.fromRawEd25519Seed(sha256('keys-test-other'));
    expect(verifyHex(other.publicKey(), msg, sig)).toBe(false);
  });

  it('rejects a non-canonical S (S + L, same value mod L)', () => {
    const sig = fromHex(signHex(kp, msg));
    const s = scalarFromLE(sig.subarray(32));
    expect(s < L).toBe(true);
    for (const bad of [s + L, s + 2n * L, s | (1n << 255n)]) {
      const forged = concatBytes(sig.subarray(0, 32), scalarLE(bad));
      expect(verifyHex(kp.publicKey(), msg, toHex(forged))).toBe(false);
    }
  });

  it('rejects small-order public keys (the R = identity, S = 0 forgery)', () => {
    const forgery = toHex(concatBytes(IDENTITY, new Uint8Array(32)));
    for (const hex of SMALL_ORDER_KEYS) {
      const key = StrKey.encodeEd25519PublicKey(fromHex(hex));
      expect(verifyHex(key, msg, forgery), hex).toBe(false);
      expect(verifyHex(key, utf8('any other message'), forgery), hex).toBe(false);
    }
  });

  it('verifyHex never throws and returns false for malformed input', () => {
    const sig = signHex(kp, msg);
    expect(verifyHex('GBAD', msg, sig)).toBe(false);
    expect(verifyHex(kp.secret(), msg, sig)).toBe(false);
    expect(verifyHex(kp.publicKey(), msg, 'zz'.repeat(64))).toBe(false);
    expect(verifyHex(kp.publicKey(), msg, sig.slice(2))).toBe(false);
    expect(verifyHex(kp.publicKey(), msg, `${sig}00`)).toBe(false);
    expect(verifyHex(kp.publicKey(), msg, '')).toBe(false);
    expect(verifyHex(kp.publicKey(), msg, sig.toUpperCase())).toBe(true);
    // wrong types from untrusted callers: the SDK's Keypair.verify throws a TypeError for them
    expect(verifyHex(kp.publicKey(), 'not bytes' as unknown as Uint8Array, sig)).toBe(false);
    expect(verifyHex(kp.publicKey(), Array.from(msg) as unknown as Uint8Array, sig)).toBe(false);
    expect(verifyHex(kp.publicKey(), msg, null as unknown as string)).toBe(false);
    expect(verifyHex(undefined as unknown as string, msg, sig)).toBe(false);
  });
});
