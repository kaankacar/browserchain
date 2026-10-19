// Wallet state: local keys per network, submissions and their live status.
// Transactions are built and signed here, in the UI, then submitted to the node.

import type { xdr } from '@stellar/stellar-sdk/base';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SubmitResult } from '../../node/api';
import {
  addActivity as addToLog,
  clearActivity as clearLog,
  EMPTY_ACTIVITY,
  isActivityChange,
  readActivity,
  syncActivity,
  updateActivity,
  type ActivityItem,
  type ActivityLog,
} from '../lib/activity';
import { humanizeCode } from '../lib/format';
import { baseSequenceFor, buildTx, signTx, txHashHex, type MemoInput } from '../lib/txbuild';
import { browserStore, isKeyListChange, loadKeys, readPref, removeKey, renameKey, updateKeys, upsertKey, writePref, type WalletKey } from '../lib/wallet';
import { useClock, useNodeState, useStore } from './NodeProvider';
import type { TxStatusInfo } from './store';
import { useToast } from './toast';

export type { ActivityItem } from '../lib/activity';

export interface SubmitOutcome {
  hash: string;
  status: SubmitResult['status'];
  ok: boolean;
  message?: string;
}

export interface SubmitRequest {
  key: WalletKey;
  ops: xdr.Operation[];
  label: string;
  memo?: MemoInput;
  feePerOp?: number;
  /** More wallet keys that must sign (op sources). */
  extraSigners?: WalletKey[];
}

interface WalletContextValue {
  network: string | null;
  passphrase: string | null;
  storageOk: boolean;
  keys: WalletKey[];
  selected: WalletKey | null;
  select: (publicKey: string) => void;
  /** Save a key; selects it unless select is false. */
  addKey: (k: WalletKey, select?: boolean) => void;
  removeKey: (publicKey: string) => void;
  renameKey: (publicKey: string, name: string) => void;
  activity: ActivityItem[];
  clearActivity: () => void;
  submit: (req: SubmitRequest) => Promise<SubmitOutcome>;
  fund: (publicKey: string, label?: string) => Promise<SubmitOutcome>;
  waitFor: (hash: string, timeoutMs?: number) => Promise<TxStatusInfo>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const v = useContext(WalletContext);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const clock = useClock();
  const toast = useToast();
  const network = useNodeState((s) => s.status?.networkName ?? null);
  const passphrase = useNodeState((s) => s.status?.networkPassphrase ?? null);
  const [kv] = useState(browserStore);
  const [keys, setKeys] = useState<WalletKey[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  // This tab's copy of the activity list that every tab shares (see lib/activity).
  const activityRef = useRef<ActivityLog>(EMPTY_ACTIVITY);
  const lastUsedSeq = useRef(new Map<string, string>());
  // Latest keys for callbacks that run after awaits (the issue wizard adds keys mid-flow).
  const keysRef = useRef<WalletKey[]>([]);
  const notified = useRef(new Set<string>());
  const loadedFor = useRef<string | null>(null);

  const showActivity = useCallback((log: ActivityLog) => {
    activityRef.current = log;
    setActivity(log.items);
  }, []);

  /** Entries this tab did not send (earlier visits, other tabs): no toasts, and look up their status. */
  const adoptForeign = useCallback(
    (items: ActivityItem[]) => {
      for (const a of items) notified.current.add(a.hash);
      void store.resolveFromHistory(items.filter((a) => !a.error).map((a) => a.hash));
    },
    [store],
  );

  // Load per-network keys, selection and activity once the network is known.
  useEffect(() => {
    if (!network || loadedFor.current === network) return;
    loadedFor.current = network;
    const loaded = loadKeys(kv, network);
    keysRef.current = loaded;
    setKeys(loaded);
    const sel = readPref<string | null>(`browserchain:wallet:selected:${network}`, null);
    setSelectedId(sel && loaded.some((k) => k.publicKey === sel) ? sel : (loaded[0]?.publicKey ?? null));
    const log = readActivity(kv, network) ?? EMPTY_ACTIVITY;
    adoptForeign(log.items);
    showActivity(log);
  }, [network, kv, adoptForeign, showActivity]);

  // Other tabs of this browser share the key list and the activity list: show their changes.
  useEffect(() => {
    if (!network || !kv || typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (loadedFor.current !== network) return;
      if (isKeyListChange(e.key, network)) {
        const loaded = loadKeys(kv, network);
        keysRef.current = loaded;
        setKeys(loaded);
      }
      if (isActivityChange(e.key, network)) {
        const synced = syncActivity(kv, network, activityRef.current);
        if (!synced) return;
        adoptForeign(synced.added);
        showActivity(synced.log);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [network, kv, adoptForeign, showActivity]);

  /** Apply a change to the shared activity list (merged with what other tabs saved). */
  const changeActivity = useCallback(
    (change: (log: ActivityLog) => ActivityLog) => {
      const mine = activityRef.current;
      showActivity(network && loadedFor.current === network ? updateActivity(kv, network, mine, change) : change(mine));
    },
    [kv, network, showActivity],
  );

  /** Apply a change to the latest saved list (another tab may have added keys). */
  const changeKeys = useCallback(
    (change: (keys: WalletKey[]) => WalletKey[]): WalletKey[] => {
      const next = network ? updateKeys(kv, network, keysRef.current, change) : change(keysRef.current);
      keysRef.current = next;
      setKeys(next);
      return next;
    },
    [kv, network],
  );

  useEffect(() => {
    if (network && loadedFor.current === network) writePref(`browserchain:wallet:selected:${network}`, selectedId);
  }, [selectedId, network]);

  // Toast when one of our submissions reaches a final state.
  useEffect(() => {
    const check = () => {
      const st = store.getState().txStatus;
      for (const a of activity) {
        if (notified.current.has(a.hash)) continue;
        const s = st[a.hash];
        if (!s || s.status === 'pending') continue;
        notified.current.add(a.hash);
        if (s.status === 'applied') {
          toast({ tone: 'ok', title: `${a.label} applied`, body: s.ledgerSeq ? `Included in ledger #${s.ledgerSeq.toLocaleString('en-US')}` : undefined, href: `#/tx/${a.hash}` });
        } else if (s.status === 'failed') {
          toast({ tone: 'bad', title: `${a.label} failed`, body: s.resultCode ? humanizeCode(s.resultCode) : undefined, href: a.error ? undefined : `#/tx/${a.hash}` });
        } else {
          toast({ tone: 'warn', title: `${a.label} dropped`, body: 'The node dropped it from the queue. Try again.' });
        }
      }
    };
    check();
    return store.subscribe(check);
  }, [store, toast, activity]);

  const addActivity = useCallback((item: ActivityItem) => changeActivity((log) => addToLog(log, item)), [changeActivity]);

  const submit = useCallback(
    async (req: SubmitRequest): Promise<SubmitOutcome> => {
      if (!passphrase) throw new Error('Not connected to a node yet.');
      const pk = req.key.publicKey;
      const account = await store.api.getAccount(pk);
      if (!account) throw new Error('This account does not exist yet. Fund it with friendbot first.');
      const seq = baseSequenceFor(account.sequence, lastUsedSeq.current.get(pk) ?? null);
      const tx = buildTx({ source: pk, sequence: seq, networkPassphrase: passphrase, memo: req.memo, feePerOp: req.feePerOp }, req.ops);
      const envelope = signTx(tx, req.key.secret, ...(req.extraSigners ?? []).map((k) => k.secret));
      const hash = txHashHex(tx);
      const res = await store.api.submitTransaction(envelope);
      const now = clock.now();
      if (res.status === 'PENDING' || res.status === 'DUPLICATE') {
        lastUsedSeq.current.set(pk, (BigInt(seq) + 1n).toString());
        const h = res.hash || hash;
        store.trackSubmitted(h);
        addActivity({ hash: h, label: req.label, account: pk, ts: now });
        return { hash: h, status: res.status, ok: true };
      }
      const code = res.errorResultCode ?? res.status;
      if (code === 'txBAD_SEQ') lastUsedSeq.current.delete(pk);
      notified.current.add(hash);
      store.markRejected(hash, code);
      addActivity({ hash, label: req.label, account: pk, ts: now, error: { code, detail: res.errorDetail } });
      const message = `${humanizeCode(code)}${res.errorDetail ? ` (${res.errorDetail})` : ''}`;
      toast({ tone: 'bad', title: `${req.label} rejected`, body: message });
      return { hash, status: res.status, ok: false, message };
    },
    [passphrase, store, clock, addActivity, toast],
  );

  const fund = useCallback(
    async (publicKey: string, label = 'Friendbot funding'): Promise<SubmitOutcome> => {
      const res = await store.api.friendbot(publicKey);
      const now = clock.now();
      if (res.status === 'PENDING') {
        store.trackSubmitted(res.hash);
        addActivity({ hash: res.hash, label, account: publicKey, ts: now });
        return { hash: res.hash, status: res.status, ok: true };
      }
      if (res.status === 'DUPLICATE') {
        toast({ tone: 'info', title: 'Already funding', body: 'Friendbot is funding this account in the next ledger.' });
        return { hash: res.hash, status: res.status, ok: true };
      }
      const message = res.errorDetail ?? humanizeCode(res.errorResultCode ?? res.status);
      toast({ tone: 'bad', title: 'Friendbot failed', body: message });
      return { hash: res.hash, status: res.status, ok: false, message };
    },
    [store, clock, addActivity, toast],
  );

  const selected = useMemo(() => keys.find((k) => k.publicKey === selectedId) ?? keys[0] ?? null, [keys, selectedId]);

  const value = useMemo<WalletContextValue>(
    () => ({
      network,
      passphrase,
      storageOk: kv !== null,
      keys,
      selected,
      select: setSelectedId,
      addKey: (k, select = true) => {
        changeKeys((ks) => upsertKey(ks, k));
        if (select) setSelectedId(k.publicKey);
      },
      removeKey: (pk) => {
        const next = changeKeys((ks) => removeKey(ks, pk));
        if (selectedId === pk) setSelectedId(next[0]?.publicKey ?? null);
      },
      renameKey: (pk, name) => {
        changeKeys((ks) => renameKey(ks, pk, name));
      },
      activity,
      clearActivity: () => changeActivity((log) => clearLog(log, clock.now())),
      submit,
      fund,
      waitFor: (hash, timeoutMs) => store.waitForTx(hash, timeoutMs),
    }),
    [network, passphrase, kv, keys, selected, selectedId, activity, submit, fund, changeKeys, changeActivity, clock, store],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
