// Classify explorer search input: account id, tx hash or ledger number.

import { StrKey, extractBaseAddress } from '@stellar/stellar-sdk/base';

export type SearchTarget =
  | { kind: 'account'; id: string }
  | { kind: 'tx'; hash: string }
  | { kind: 'ledger'; seq: number }
  | { kind: 'invalid'; reason: string };

export function classifySearch(raw: string): SearchTarget {
  const q = raw.trim();
  if (!q) return { kind: 'invalid', reason: 'Type an account (G…), a transaction hash or a ledger number.' };

  const num = q.replace(/^#/, '').replace(/,/g, '');
  if (/^\d+$/.test(num)) {
    const seq = Number(num);
    if (seq >= 1 && seq <= 0xffffffff) return { kind: 'ledger', seq };
    return { kind: 'invalid', reason: 'Ledger numbers start at 1.' };
  }

  if (/^[0-9a-fA-F]{64}$/.test(q)) return { kind: 'tx', hash: q.toLowerCase() };

  const upper = q.toUpperCase();
  if (upper.startsWith('G')) {
    if (StrKey.isValidEd25519PublicKey(upper)) return { kind: 'account', id: upper };
    return { kind: 'invalid', reason: 'That account id is not valid (bad length or checksum).' };
  }
  if (upper.startsWith('M')) {
    if (StrKey.isValidMed25519PublicKey(upper)) return { kind: 'account', id: extractBaseAddress(upper) };
    return { kind: 'invalid', reason: 'That muxed account id is not valid.' };
  }
  if (upper.startsWith('S') && StrKey.isValidEd25519SecretSeed(upper)) {
    return { kind: 'invalid', reason: 'That is a secret key. Never paste secret keys into a search box.' };
  }
  if (/^[0-9a-fA-F]+$/.test(q)) return { kind: 'invalid', reason: 'A transaction hash has 64 hex characters.' };
  return { kind: 'invalid', reason: 'Not an account, transaction hash or ledger number.' };
}
