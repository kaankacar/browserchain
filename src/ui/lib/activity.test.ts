import { describe, expect, it } from 'vitest';
import {
  activityStorageKey,
  addActivity,
  clearActivity,
  EMPTY_ACTIVITY,
  isActivityChange,
  MAX_ACTIVITY,
  mergeActivity,
  readActivity,
  saveActivity,
  syncActivity,
  updateActivity,
  type ActivityItem,
  type ActivityLog,
} from './activity';
import type { KeyValueStore } from './wallet';

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

const hash = (n: number) => n.toString(16).padStart(64, '0');
const item = (n: number, ts: number, extra: Partial<ActivityItem> = {}): ActivityItem => ({ hash: hash(n), label: `tx ${n}`, account: 'GACCOUNT', ts, ...extra });
const hashes = (log: ActivityLog) => log.items.map((a) => a.hash);

describe('wallet activity shared by tabs', () => {
  it('a tab with a stale copy keeps the entries another tab saved (merge by tx hash)', () => {
    // Two tabs of one browser loaded the list while it was empty.
    const store = new MemStore();
    let tab1 = readActivity(store, 'main')!;
    let tab2 = readActivity(store, 'main')!;
    expect(tab1).toEqual(EMPTY_ACTIVITY);
    tab1 = updateActivity(store, 'main', tab1, (log) => addActivity(log, item(1, 100)));
    // tab2 still holds the empty copy: its entry must not replace tab1's
    tab2 = updateActivity(store, 'main', tab2, (log) => addActivity(log, item(2, 200)));
    expect(hashes(tab2)).toEqual([hash(2), hash(1)]);
    expect(hashes(readActivity(store, 'main')!)).toEqual([hash(2), hash(1)]);
    // tab1 hears the storage event and shows tab2's entry
    const synced = syncActivity(store, 'main', tab1)!;
    expect(hashes(synced.log)).toEqual([hash(2), hash(1)]);
    expect(synced.added.map((a) => a.hash)).toEqual([hash(2)]);
    tab1 = synced.log;
    expect(tab1).toEqual(tab2);
  });

  it('two tabs that save at the same moment end with the same full list', () => {
    // Both read the empty list, then each saves only its own entry (the
    // second write wins in storage), then each gets the other's event.
    const store = new MemStore();
    const tab1 = addActivity(EMPTY_ACTIVITY, item(1, 100));
    const tab2 = addActivity(EMPTY_ACTIVITY, item(2, 101));
    saveActivity(store, 'main', tab1);
    saveActivity(store, 'main', tab2);
    expect(hashes(readActivity(store, 'main')!)).toEqual([hash(2)]);
    // tab1 holds an entry the saved list misses: it saves the merged list back
    const s1 = syncActivity(store, 'main', tab1)!;
    expect(hashes(s1.log)).toEqual([hash(2), hash(1)]);
    expect(hashes(readActivity(store, 'main')!)).toEqual([hash(2), hash(1)]);
    // tab2 now only learns tab1's entry; nothing more to save
    const before = store.getItem(activityStorageKey('main'));
    const s2 = syncActivity(store, 'main', tab2)!;
    expect(s2.log).toEqual(s1.log);
    expect(s2.added.map((a) => a.hash)).toEqual([hash(1)]);
    expect(store.getItem(activityStorageKey('main'))).toBe(before);
  });

  it('clear empties every tab, and cleared entries never come back', () => {
    const store = new MemStore();
    let tab1 = updateActivity(store, 'main', EMPTY_ACTIVITY, (log) => addActivity(log, item(1, 100)));
    tab1 = updateActivity(store, 'main', tab1, (log) => addActivity(log, item(2, 200)));
    let tab2 = syncActivity(store, 'main', EMPTY_ACTIVITY)!.log;
    expect(hashes(tab2)).toEqual([hash(2), hash(1)]);

    tab1 = updateActivity(store, 'main', tab1, (log) => clearActivity(log, 150));
    expect(tab1.items).toEqual([]);
    // tab2 still holds both entries: syncing must not save them back
    const s2 = syncActivity(store, 'main', tab2)!;
    expect(s2.log.items).toEqual([]);
    expect(s2.added).toEqual([]);
    expect(readActivity(store, 'main')!.items).toEqual([]);
    tab2 = s2.log;
    // an entry sent after the clear shows in both tabs
    tab2 = updateActivity(store, 'main', tab2, (log) => addActivity(log, item(3, 300)));
    expect(hashes(syncActivity(store, 'main', tab1)!.log)).toEqual([hash(3)]);
    // a tab that missed the clear and adds an entry does not restore the cleared ones
    const stale = updateActivity(store, 'main', { items: [item(1, 100), item(2, 200)], clearedAt: 0 }, (log) => addActivity(log, item(4, 400)));
    expect(hashes(stale)).toEqual([hash(4), hash(3)]);
  });

  it('keeps one entry per tx: a resubmission moves it to the top', () => {
    let log = addActivity(EMPTY_ACTIVITY, item(1, 100));
    log = addActivity(log, item(2, 200));
    log = addActivity(log, item(1, 300, { label: 'again' }));
    expect(log.items.map((a) => [a.hash, a.label])).toEqual([
      [hash(1), 'again'],
      [hash(2), 'tx 2'],
    ]);
    // another tab still has the old entry for tx 1: the newer one wins there too
    expect(mergeActivity({ items: [item(1, 100), item(2, 200)], clearedAt: 0 }, log)).toEqual(log);
  });

  it('merges in any order to the same capped list', () => {
    const a: ActivityLog = { items: Array.from({ length: 40 }, (_, i) => item(i, 1000 + 2 * i)), clearedAt: 0 };
    const b: ActivityLog = { items: Array.from({ length: 40 }, (_, i) => item(100 + i, 1001 + 2 * i, { error: { code: 'txBAD_SEQ' } })), clearedAt: 0 };
    const c: ActivityLog = { items: [item(5, 5000, { label: 'moved' })], clearedAt: 1010 };
    const m1 = mergeActivity(a, b, c);
    expect(m1).toEqual(mergeActivity(c, b, a));
    expect(m1).toEqual(mergeActivity(b, mergeActivity(c, a)));
    expect(m1.items).toHaveLength(MAX_ACTIVITY);
    expect(m1.items[0].label).toBe('moved');
    expect(m1.items.every((x) => x.ts >= 1010)).toBe(true);
    for (let i = 1; i < m1.items.length; i++) expect(m1.items[i - 1].ts).toBeGreaterThanOrEqual(m1.items[i].ts);
  });

  it('reads lists saved by older builds and survives junk', () => {
    const store = new MemStore();
    const key = activityStorageKey('main');
    store.setItem(key, JSON.stringify([item(1, 100), { hash: 7 }, null, item(2, 200, { error: { code: 'txBAD_SEQ', detail: 'seq' } })]));
    expect(readActivity(store, 'main')).toEqual({ items: [item(2, 200, { error: { code: 'txBAD_SEQ', detail: 'seq' } }), item(1, 100)], clearedAt: 0 });
    expect(readActivity(store, 'other')).toEqual(EMPTY_ACTIVITY);
    store.setItem(key, '{not json');
    expect(readActivity(store, 'main')).toBeNull();
    // a corrupt saved list is replaced by this tab's copy
    const next = updateActivity(store, 'main', { items: [item(3, 300)], clearedAt: 0 }, (log) => addActivity(log, item(4, 400)));
    expect(hashes(next)).toEqual([hash(4), hash(3)]);
    expect(readActivity(store, 'main')).toEqual(next);
  });

  it('never throws when storage is blocked', () => {
    const broken = new BrokenStore();
    expect(readActivity(broken, 'main')).toBeNull();
    expect(readActivity(null, 'main')).toBeNull();
    expect(saveActivity(broken, 'main', EMPTY_ACTIVITY)).toBe(false);
    expect(syncActivity(broken, 'main', EMPTY_ACTIVITY)).toBeNull();
    const mine = addActivity(EMPTY_ACTIVITY, item(1, 100));
    expect(hashes(updateActivity(broken, 'main', mine, (log) => addActivity(log, item(2, 200))))).toEqual([hash(2), hash(1)]);
    expect(updateActivity(null, 'main', mine, (log) => clearActivity(log, 150)).items).toEqual([]);
  });

  it('tells which storage events touch the activity list', () => {
    expect(isActivityChange(activityStorageKey('main'), 'main')).toBe(true);
    expect(isActivityChange(null, 'main')).toBe(true);
    expect(isActivityChange(activityStorageKey('other'), 'main')).toBe(false);
    expect(isActivityChange('browserchain:wallet:main', 'main')).toBe(false);
  });
});
