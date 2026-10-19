// Local wallet keys, stored in localStorage per network. This is a play-money
// test network: secrets are kept unencrypted in this browser.

import { Keypair, StrKey } from '@stellar/stellar-sdk/base';

export interface WalletKey {
  name: string;
  publicKey: string;
  secret: string;
  createdAt: number;
}

/** The subset of the Web Storage API we use (easy to fake in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function walletStorageKey(network: string): string {
  return `browserchain:wallet:${network}`;
}

function isWalletKey(v: unknown): v is WalletKey {
  if (!v || typeof v !== 'object') return false;
  const k = v as Record<string, unknown>;
  return (
    typeof k.name === 'string' &&
    typeof k.publicKey === 'string' &&
    typeof k.secret === 'string' &&
    StrKey.isValidEd25519PublicKey(k.publicKey) &&
    StrKey.isValidEd25519SecretSeed(k.secret)
  );
}

/** Saved keys, or null when they cannot be read (blocked storage, corrupt data). */
function readKeys(store: KeyValueStore | null, network: string): WalletKey[] | null {
  if (!store) return null;
  try {
    const raw = store.getItem(walletStorageKey(network));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isWalletKey).map((k) => ({
      name: k.name,
      publicKey: k.publicKey,
      secret: k.secret,
      createdAt: typeof k.createdAt === 'number' ? k.createdAt : 0,
    }));
  } catch {
    return null;
  }
}

/** Load keys; ignores corrupt entries and storage errors. */
export function loadKeys(store: KeyValueStore | null, network: string): WalletKey[] {
  return readKeys(store, network) ?? [];
}

/**
 * Change the saved keys in one step. Every tab of this browser shares the
 * list, so the change applies to the latest saved list, not to this tab's
 * copy (which may miss keys another tab added). `fallback` is used when
 * storage cannot be read. Returns the new list.
 */
export function updateKeys(
  store: KeyValueStore | null,
  network: string,
  fallback: WalletKey[],
  change: (keys: WalletKey[]) => WalletKey[],
): WalletKey[] {
  const next = change(readKeys(store, network) ?? fallback);
  saveKeys(store, network, next);
  return next;
}

/** True when a 'storage' event (from another tab) may have changed the keys of `network`. */
export function isKeyListChange(eventKey: string | null, network: string): boolean {
  // a null key means the whole storage was cleared
  return eventKey === null || eventKey === walletStorageKey(network);
}

/** Save keys. Returns false when storage is unavailable or full. */
export function saveKeys(store: KeyValueStore | null, network: string, keys: WalletKey[]): boolean {
  if (!store) return false;
  try {
    if (keys.length === 0) store.removeItem(walletStorageKey(network));
    else store.setItem(walletStorageKey(network), JSON.stringify(keys));
    return true;
  } catch {
    return false;
  }
}

export function createKey(name: string, now: number): WalletKey {
  const kp = Keypair.random();
  return { name: name.trim() || 'Account', publicKey: kp.publicKey(), secret: kp.secret(), createdAt: now };
}

export function importKey(secret: string, name: string, now: number): WalletKey {
  const s = secret.trim();
  if (!StrKey.isValidEd25519SecretSeed(s)) throw new Error('That is not a valid secret key (S…).');
  const kp = Keypair.fromSecret(s);
  return { name: name.trim() || 'Imported', publicKey: kp.publicKey(), secret: s, createdAt: now };
}

/** Insert or replace (same public key keeps its position). */
export function upsertKey(keys: WalletKey[], key: WalletKey): WalletKey[] {
  const i = keys.findIndex((k) => k.publicKey === key.publicKey);
  if (i < 0) return [...keys, key];
  const next = [...keys];
  next[i] = key;
  return next;
}

export function removeKey(keys: WalletKey[], publicKey: string): WalletKey[] {
  return keys.filter((k) => k.publicKey !== publicKey);
}

export function renameKey(keys: WalletKey[], publicKey: string, name: string): WalletKey[] {
  return keys.map((k) => (k.publicKey === publicKey ? { ...k, name: name.trim() || k.name } : k));
}

/** "Account 3" style default name that is not taken yet. */
export function nextDefaultName(keys: WalletKey[], base = 'Account'): string {
  const taken = new Set(keys.map((k) => k.name));
  for (let i = keys.length + 1; ; i++) {
    const name = `${base} ${i}`;
    if (!taken.has(name)) return name;
  }
}

/** localStorage when it works, else null (private mode, blocked storage). */
export function browserStore(): KeyValueStore | null {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = 'browserchain:probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/** Read a small JSON preference; never throws. */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // preferences are best effort
  }
}
