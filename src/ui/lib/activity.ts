// The wallet activity list: transactions the wallet sent, per network. Every
// tab of this browser shares one list in localStorage. A tab never replaces
// the saved list with its own copy: lists merge by tx hash, so entries that
// other tabs added stay. "Clear" saves a time mark; entries sent before it
// stay cleared in every tab.

import type { KeyValueStore } from './wallet';

export interface ActivityItem {
  hash: string;
  label: string;
  account: string;
  /** Local ms when it was sent. */
  ts: number;
  /** Set when the node refused the transaction at submit time. */
  error?: { code: string; detail?: string };
}

export interface ActivityLog {
  /** Newest first, at most MAX_ACTIVITY, one entry per tx hash. */
  items: ActivityItem[];
  /** Entries with ts < clearedAt were cleared (0: never cleared). */
  clearedAt: number;
}

export const MAX_ACTIVITY = 60;
export const EMPTY_ACTIVITY: ActivityLog = { items: [], clearedAt: 0 };

export function activityStorageKey(network: string): string {
  return `browserchain:wallet:activity:${network}`;
}

/** True when a 'storage' event (from another tab) may have changed the activity of `network`. */
export function isActivityChange(eventKey: string | null, network: string): boolean {
  // a null key means the whole storage was cleared
  return eventKey === null || eventKey === activityStorageKey(network);
}

function itemOf(v: unknown): ActivityItem | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (typeof a.hash !== 'string' || !a.hash || typeof a.label !== 'string' || typeof a.account !== 'string') return null;
  const item: ActivityItem = { hash: a.hash, label: a.label, account: a.account, ts: typeof a.ts === 'number' && Number.isFinite(a.ts) ? a.ts : 0 };
  const e = a.error as Record<string, unknown> | null | undefined;
  if (e && typeof e === 'object' && typeof e.code === 'string') {
    item.error = typeof e.detail === 'string' ? { code: e.code, detail: e.detail } : { code: e.code };
  }
  return item;
}

/** Newest first; the hash breaks ties so that every tab gets the same order. */
function newestFirst(a: ActivityItem, b: ActivityItem): number {
  return b.ts - a.ts || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
}

/** Of two entries for one tx, keep the newer one (a resubmission moves it up). */
function preferred(a: ActivityItem, b: ActivityItem): ActivityItem {
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
  if (!a.error !== !b.error) return a.error ? b : a;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}

/**
 * Merge activity logs by tx hash. The result does not depend on the order
 * of the logs, so tabs that merge each other's lists agree on one list.
 */
export function mergeActivity(...logs: ActivityLog[]): ActivityLog {
  const clearedAt = Math.max(0, ...logs.map((l) => l.clearedAt));
  const byHash = new Map<string, ActivityItem>();
  for (const log of logs) {
    for (const it of log.items) {
      if (it.ts < clearedAt) continue;
      const prev = byHash.get(it.hash);
      byHash.set(it.hash, prev ? preferred(prev, it) : it);
    }
  }
  return { items: [...byHash.values()].sort(newestFirst).slice(0, MAX_ACTIVITY), clearedAt };
}

/** The log with `item` added (or moved to the top when its tx is listed). */
export function addActivity(log: ActivityLog, item: ActivityItem): ActivityLog {
  return mergeActivity({ items: [item, ...log.items.filter((x) => x.hash !== item.hash)], clearedAt: log.clearedAt });
}

/** The log after "Clear" at local time `now`: every listed entry is cleared. */
export function clearActivity(log: ActivityLog, now: number): ActivityLog {
  const newest = log.items.reduce((m, it) => Math.max(m, it.ts), 0);
  return { items: [], clearedAt: Math.max(log.clearedAt, now, newest + 1) };
}

export function sameActivity(a: ActivityLog, b: ActivityLog): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The saved log, or null when it cannot be read (blocked storage, corrupt data). */
export function readActivity(store: KeyValueStore | null, network: string): ActivityLog | null {
  if (!store) return null;
  try {
    const raw = store.getItem(activityStorageKey(network));
    if (!raw) return EMPTY_ACTIVITY;
    const parsed: unknown = JSON.parse(raw);
    // older builds saved a plain array
    const obj = (Array.isArray(parsed) ? { items: parsed, clearedAt: 0 } : parsed) as { items?: unknown; clearedAt?: unknown } | null;
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) return null;
    const clearedAt = typeof obj.clearedAt === 'number' && Number.isFinite(obj.clearedAt) ? obj.clearedAt : 0;
    const items = obj.items.map(itemOf).filter((x): x is ActivityItem => x !== null);
    return mergeActivity({ items, clearedAt });
  } catch {
    return null;
  }
}

/** Save the log. Returns false when storage is unavailable or full. */
export function saveActivity(store: KeyValueStore | null, network: string, log: ActivityLog): boolean {
  if (!store) return false;
  try {
    store.setItem(activityStorageKey(network), JSON.stringify(log));
    return true;
  } catch {
    return false;
  }
}

/**
 * Change the shared log in one step: merge the saved log with this tab's
 * copy (it may hold entries the saved one misses), apply `change`, save.
 * Returns the new log.
 */
export function updateActivity(
  store: KeyValueStore | null,
  network: string,
  mine: ActivityLog,
  change: (log: ActivityLog) => ActivityLog,
): ActivityLog {
  const saved = readActivity(store, network);
  const next = mergeActivity(change(saved ? mergeActivity(saved, mine) : mine));
  if (!saved || !sameActivity(next, saved)) saveActivity(store, network, next);
  return next;
}

/**
 * Another tab saved the log: merge it with this tab's copy. When this tab
 * holds entries the saved log misses (both tabs saved at the same time),
 * save the merged log back, so every tab ends with the same list.
 * Returns the merged log and the entries that are new to this tab, or null
 * when the saved log cannot be read.
 */
export function syncActivity(
  store: KeyValueStore | null,
  network: string,
  mine: ActivityLog,
): { log: ActivityLog; added: ActivityItem[] } | null {
  const saved = readActivity(store, network);
  if (!saved) return null;
  const log = mergeActivity(saved, mine);
  if (!sameActivity(log, saved)) saveActivity(store, network, log);
  const known = new Set(mine.items.map((a) => a.hash));
  return { log, added: log.items.filter((a) => !known.has(a.hash)) };
}
