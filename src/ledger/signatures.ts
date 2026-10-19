// Signature checking with account signers and thresholds.
// Ported from stellar-core (Apache-2.0): src/transactions/SignatureChecker.cpp,
// src/transactions/SignatureUtils.cpp

import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { concatBytes, equalBytes, toHex } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import type { AccountEntry, Signer } from './types';
import type { DecodedSignature } from './tx';

export type ThresholdLevel = 'LOW' | 'MEDIUM' | 'HIGH';

type SignerType = 'ed25519' | 'preAuthTx' | 'hashX';

interface ParsedSigner {
  type: SignerType;
  raw: Uint8Array;
  key: string;
  weight: number;
}

const parsedKeys = new Map<string, { type: SignerType; raw: Uint8Array } | null>();

/** StrKey signer -> (type, raw 32 bytes). Null for unknown or malformed keys. */
export function parseSignerKey(key: string): { type: SignerType; raw: Uint8Array } | null {
  const cached = parsedKeys.get(key);
  if (cached !== undefined) return cached;
  let res: { type: SignerType; raw: Uint8Array } | null = null;
  try {
    switch (key[0]) {
      case 'G':
        res = { type: 'ed25519', raw: new Uint8Array(StrKey.decodeEd25519PublicKey(key)) };
        break;
      case 'T':
        res = { type: 'preAuthTx', raw: new Uint8Array(StrKey.decodePreAuthTx(key)) };
        break;
      case 'X':
        res = { type: 'hashX', raw: new Uint8Array(StrKey.decodeSha256Hash(key)) };
        break;
      default:
        res = null;
    }
  } catch {
    res = null;
  }
  if (parsedKeys.size > 10_000) parsedKeys.clear();
  parsedKeys.set(key, res);
  return res;
}

// Verified (pubkey, signature, hash) triples. A pure function cache, like
// stellar-core's signature verification cache.
const verifyCache = new Map<string, boolean>();
const VERIFY_CACHE_SIZE = 20_000;

function verifyEd25519(pub: Uint8Array, sig: Uint8Array, data: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  const cacheKey = toHex(sha256(concatBytes(pub, sig, data)));
  const hit = verifyCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    ok = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(pub)).verify(data, sig);
  } catch {
    ok = false;
  }
  if (verifyCache.size >= VERIFY_CACHE_SIZE) {
    const first = verifyCache.keys().next().value;
    if (first !== undefined) verifyCache.delete(first);
  }
  verifyCache.set(cacheKey, ok);
  return ok;
}

/** doesHintMatch: the hint is the last 4 bytes of the key. */
function hintMatches(key: Uint8Array, hint: Uint8Array): boolean {
  if (hint.length !== 4 || key.length < 4) return false;
  for (let i = 0; i < 4; i++) if (key[key.length - 4 + i] !== hint[i]) return false;
  return true;
}

export class SignatureChecker {
  private readonly used: boolean[];

  constructor(
    private readonly contentsHash: Uint8Array,
    private readonly signatures: DecodedSignature[],
  ) {
    this.used = signatures.map(() => false);
  }

  /** SignatureChecker::checkSignature: true when the signers' matched weight reaches `neededWeight`. */
  checkSignature(signersIn: Signer[], neededWeight: number): boolean {
    const byType: Record<SignerType, ParsedSigner[]> = { ed25519: [], preAuthTx: [], hashX: [] };
    for (const s of signersIn) {
      const p = parseSignerKey(s.key);
      if (p) byType[p.type].push({ ...p, key: s.key, weight: s.weight });
    }

    let totalWeight = 0;
    const cap = (w: number) => (w > 255 ? 255 : w);

    for (const s of byType.preAuthTx) {
      if (equalBytes(s.raw, this.contentsHash)) {
        totalWeight += cap(s.weight);
        if (totalWeight >= neededWeight) return true;
      }
    }

    const verifyAll = (signers: ParsedSigner[], verify: (sig: DecodedSignature, s: ParsedSigner) => boolean) => {
      for (let i = 0; i < this.signatures.length; i++) {
        const sig = this.signatures[i];
        for (let j = 0; j < signers.length; j++) {
          const s = signers[j];
          if (verify(sig, s)) {
            this.used[i] = true;
            totalWeight += cap(s.weight);
            if (totalWeight >= neededWeight) return true;
            signers.splice(j, 1);
            break;
          }
        }
      }
      return false;
    };

    if (
      verifyAll(
        byType.hashX,
        (sig, s) => hintMatches(s.raw, sig.hint) && equalBytes(s.raw, sha256(sig.signature)),
      )
    ) {
      return true;
    }
    if (
      verifyAll(
        byType.ed25519,
        (sig, s) => hintMatches(s.raw, sig.hint) && verifyEd25519(s.raw, sig.signature, this.contentsHash),
      )
    ) {
      return true;
    }
    return false;
  }

  /** Every signature was used by some successful or failed check. */
  checkAllSignaturesUsed(): boolean {
    return this.used.every(Boolean);
  }
}

/** Signers of an account: the master key (if its weight > 0) then the account signers. */
export function accountSigners(acc: Readonly<AccountEntry>): Signer[] {
  const out: Signer[] = [];
  if (acc.thresholds.master > 0) out.push({ key: acc.accountId, weight: acc.thresholds.master });
  for (const s of acc.signers) out.push(s);
  return out;
}

export function neededThreshold(acc: Readonly<AccountEntry>, level: ThresholdLevel): number {
  switch (level) {
    case 'LOW':
      return acc.thresholds.low;
    case 'MEDIUM':
      return acc.thresholds.med;
    case 'HIGH':
      return acc.thresholds.high;
  }
}

/** TransactionFrame::checkSignature */
export function checkAccountSignature(checker: SignatureChecker, acc: Readonly<AccountEntry>, neededWeight: number): boolean {
  return checker.checkSignature(accountSigners(acc), neededWeight);
}

/** TransactionFrame::checkSignatureNoAccount: a signature by the account key itself. */
export function checkSignatureNoAccount(checker: SignatureChecker, accountId: string): boolean {
  return checker.checkSignature([{ key: accountId, weight: 1 }], 0);
}
