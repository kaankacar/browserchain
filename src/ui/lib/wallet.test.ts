import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import {
  createKey,
  isKeyListChange,
  importKey,
  loadKeys,
  nextDefaultName,
  removeKey,
  renameKey,
  saveKeys,
  updateKeys,
  upsertKey,
  walletStorageKey,
  type KeyValueStore,
} from './wallet';

class MemStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

class BrokenStore implements KeyValueStore {
  getItem(): string | null {
    throw new Error('denied');
  }
  setItem(): void {
    throw new Error('quota');
  }
  removeItem(): void {
    throw new Error('denied');
  }
}

describe('wallet keys', () => {
  it('creates and imports keys', () => {
    const k = createKey(' Main ', 5);
    expect(k.name).toBe('Main');
    expect(Keypair.fromSecret(k.secret).publicKey()).toBe(k.publicKey);
    expect(k.createdAt).toBe(5);
    const secret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(9)).secret();
    const imported = importKey(` ${secret} `, '', 7);
    expect(imported.name).toBe('Imported');
    expect(imported.secret).toBe(secret);
    expect(() => importKey('SNOTVALID', 'x', 1)).toThrow(/secret key/);
  });

  it('stores keys per network and survives junk', () => {
    const store = new MemStore();
    const a = createKey('A', 1);
    const b = createKey('B', 2);
    expect(saveKeys(store, 'main', [a, b])).toBe(true);
    expect(loadKeys(store, 'main')).toEqual([a, b]);
    expect(loadKeys(store, 'other')).toEqual([]);
    expect(store.data.has(walletStorageKey('main'))).toBe(true);
    store.setItem(walletStorageKey('main'), JSON.stringify([a, { name: 'bad', publicKey: 'G', secret: 'S' }, 42]));
    expect(loadKeys(store, 'main')).toEqual([a]);
    store.setItem(walletStorageKey('main'), '{not json');
    expect(loadKeys(store, 'main')).toEqual([]);
    saveKeys(store, 'main', []);
    expect(store.data.has(walletStorageKey('main'))).toBe(false);
  });

  it('never throws when storage is blocked', () => {
    const broken = new BrokenStore();
    expect(loadKeys(broken, 'main')).toEqual([]);
    expect(saveKeys(broken, 'main', [createKey('A', 1)])).toBe(false);
    expect(loadKeys(null, 'main')).toEqual([]);
    expect(saveKeys(null, 'main', [])).toBe(false);
  });

  it('upserts, renames and removes', () => {
    const a = createKey('A', 1);
    const b = createKey('B', 2);
    let keys = upsertKey([], a);
    keys = upsertKey(keys, b);
    keys = upsertKey(keys, { ...a, name: 'A2' });
    expect(keys.map((k) => k.name)).toEqual(['A2', 'B']);
    keys = renameKey(keys, b.publicKey, ' Bee ');
    expect(keys[1].name).toBe('Bee');
    keys = renameKey(keys, b.publicKey, '   ');
    expect(keys[1].name).toBe('Bee');
    keys = removeKey(keys, a.publicKey);
    expect(keys.map((k) => k.publicKey)).toEqual([b.publicKey]);
  });

  it('keeps keys that another tab added (shared list)', () => {
    // Two tabs of one browser share the store. Each loaded the list when it was empty.
    const store = new MemStore();
    let tab1 = loadKeys(store, 'main');
    let tab2 = loadKeys(store, 'main');
    const a = createKey('Account 1', 1);
    const b = createKey('Account 2', 2);
    tab1 = updateKeys(store, 'main', tab1, (ks) => upsertKey(ks, a));
    // tab2 still holds the stale empty copy: its change must not drop a
    tab2 = updateKeys(store, 'main', tab2, (ks) => upsertKey(ks, b));
    expect(tab2.map((k) => k.name)).toEqual(['Account 1', 'Account 2']);
    expect(loadKeys(store, 'main')).toEqual([a, b]);
    // renames and removals also start from the saved list
    tab1 = updateKeys(store, 'main', tab1, (ks) => renameKey(ks, b.publicKey, 'Bob'));
    expect(tab1.map((k) => k.name)).toEqual(['Account 1', 'Bob']);
    updateKeys(store, 'main', [], (ks) => removeKey(ks, a.publicKey));
    expect(loadKeys(store, 'main').map((k) => k.name)).toEqual(['Bob']);
  });

  it('updates the in-memory copy when storage cannot be read', () => {
    const a = createKey('A', 1);
    expect(updateKeys(new BrokenStore(), 'main', [a], (ks) => ks)).toEqual([a]);
    expect(updateKeys(null, 'main', [a], (ks) => removeKey(ks, a.publicKey))).toEqual([]);
    const corrupt = new MemStore();
    corrupt.setItem(walletStorageKey('main'), '{not json');
    const b = createKey('B', 2);
    expect(updateKeys(corrupt, 'main', [a], (ks) => upsertKey(ks, b))).toEqual([a, b]);
    expect(loadKeys(corrupt, 'main')).toEqual([a, b]);
  });

  it('tells which storage events touch the key list', () => {
    expect(isKeyListChange(walletStorageKey('main'), 'main')).toBe(true);
    expect(isKeyListChange(null, 'main')).toBe(true);
    expect(isKeyListChange(walletStorageKey('other'), 'main')).toBe(false);
    expect(isKeyListChange('browserchain:wallet:selected:main', 'main')).toBe(false);
  });

  it('suggests free default names', () => {
    expect(nextDefaultName([])).toBe('Account 1');
    const keys = [createKey('Account 2', 1)];
    expect(nextDefaultName(keys)).toBe('Account 3');
    expect(nextDefaultName([createKey('Account 1', 1)])).toBe('Account 2');
  });
});
