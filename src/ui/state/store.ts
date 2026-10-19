// Live node state for the UI. One subscription to NodeApi feeds a pure
// reducer; React components read slices through useSyncExternalStore.

import type { Clock } from '../../lib/clock';
import type { LogEntry } from '../../lib/log';
import type {
  ForkInfo,
  LedgerSummary,
  NetworkStats,
  NodeApi,
  NodeEvent,
  NodeStatus,
  PeerView,
  ScpEventView,
  ScpSlotView,
  TxStatus,
  TxSummary,
  ValidatorView,
} from '../../node/api';

export const MAX_LEDGERS = 50;
export const MAX_SCP_EVENTS = 300;
export const MAX_TXS = 60;
export const MAX_LOGS = 300;
export const MAX_FORKS = 50;
export const MAX_TX_STATUSES = 500;

export interface TxStatusInfo {
  hash: string;
  status: TxStatus;
  ledgerSeq?: number;
  resultCode?: string;
  ts: number;
}

export interface NodeState {
  /** Initial load finished. */
  ready: boolean;
  error: string | null;
  status: NodeStatus | null;
  /** Newest first. */
  ledgers: LedgerSummary[];
  /** Newest first (live feed). */
  txs: TxSummary[];
  /** Newest first. */
  scpEvents: ScpEventView[];
  slot: ScpSlotView | null;
  peers: PeerView[];
  validators: ValidatorView[];
  stats: NetworkStats | null;
  /** Newest first. */
  forks: ForkInfo[];
  /** Newest first. */
  logs: LogEntry[];
  txStatus: Record<string, TxStatusInfo>;
  /** Local ms of the latest ledgerClosed event seen by the UI. */
  lastCloseEventAt: number | null;
  /** Number of ledgerClosed events seen. */
  closeCounter: number;
  /** Local ms of the latest resync this UI started (fork reports from before it are about the wiped chain). */
  resyncAt: number | null;
}

export type SnapshotData = Partial<
  Pick<NodeState, 'status' | 'ledgers' | 'txs' | 'scpEvents' | 'slot' | 'peers' | 'validators' | 'stats' | 'forks' | 'logs'>
>;

export type StoreAction =
  | { type: 'event'; event: NodeEvent; now: number }
  | { type: 'snapshot'; data: SnapshotData }
  | { type: 'ready' }
  | { type: 'error'; error: string | null }
  | { type: 'localTx'; hash: string; status: TxStatus; resultCode?: string; now: number }
  | { type: 'resync'; now: number };

export function initialState(): NodeState {
  return {
    ready: false,
    error: null,
    status: null,
    ledgers: [],
    txs: [],
    scpEvents: [],
    slot: null,
    peers: [],
    validators: [],
    stats: null,
    forks: [],
    logs: [],
    txStatus: {},
    lastCloseEventAt: null,
    closeCounter: 0,
    resyncAt: null,
  };
}

function scpKey(e: ScpEventView): string {
  return `${e.ts}|${e.slot}|${e.nodeId}|${e.type}|${e.direction}|${e.summary}`;
}

function logKey(e: LogEntry): string {
  return `${e.ts}|${e.level}|${e.scope}|${e.msg}`;
}

function forkKey(f: ForkInfo): string {
  return `${f.ts}|${f.atSeq}|${f.peer}|${f.theirHash}`;
}

/** Newest-first tx order: ledger desc, then apply index desc. */
export function compareTxNewestFirst(a: TxSummary, b: TxSummary): number {
  return b.ledgerSeq - a.ledgerSeq || b.applyIndex - a.applyIndex;
}

function setTxStatus(map: Record<string, TxStatusInfo>, info: TxStatusInfo): Record<string, TxStatusInfo> {
  const prev = map[info.hash];
  // A final state never goes back to pending.
  if (prev && prev.status !== 'pending' && info.status === 'pending') return map;
  const next = { ...map, [info.hash]: { ...prev, ...info } };
  const keys = Object.keys(next);
  if (keys.length > MAX_TX_STATUSES) {
    keys
      .sort((a, b) => next[a].ts - next[b].ts)
      .slice(0, keys.length - MAX_TX_STATUSES)
      .forEach((k) => delete next[k]);
  }
  return next;
}

/**
 * A rollback drops this node's ledgers from `atSeq` on. Statuses read from
 * them are no longer known: the node re-reports the txs that are on the
 * winning branch or that it can queue again, and nothing for the rest.
 */
function forgetRolledBack(map: Record<string, TxStatusInfo>, atSeq: number): Record<string, TxStatusInfo> {
  let next = map;
  for (const [hash, s] of Object.entries(map)) {
    if (s.ledgerSeq === undefined || s.ledgerSeq < atSeq) continue;
    if (next === map) next = { ...map };
    delete next[hash];
  }
  return next;
}

function mergeLedgers(existing: LedgerSummary[], incoming: LedgerSummary[]): LedgerSummary[] {
  const bySeq = new Map<number, LedgerSummary>();
  for (const l of existing) bySeq.set(l.seq, l);
  for (const l of incoming) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, MAX_LEDGERS);
}

function applyEvent(state: NodeState, ev: NodeEvent, now: number): NodeState {
  switch (ev.type) {
    case 'status':
      return { ...state, status: ev.status };

    case 'ledgerClosed': {
      const l = ev.ledger;
      // A ledger at or below the newest one replaces that branch (rollback after a fork).
      const ledgers = [l, ...state.ledgers.filter((x) => x.seq < l.seq)].slice(0, MAX_LEDGERS);
      const fresh = [...ev.txs].sort(compareTxNewestFirst);
      const txs = [...fresh, ...state.txs.filter((t) => t.ledgerSeq < l.seq)].slice(0, MAX_TXS);
      let txStatus = state.txStatus;
      for (const t of ev.txs) {
        if (txStatus[t.hash]) {
          txStatus = setTxStatus(txStatus, {
            hash: t.hash,
            status: t.successful ? 'applied' : 'failed',
            ledgerSeq: l.seq,
            resultCode: t.resultCode,
            ts: now,
          });
        }
      }
      const status = state.status && state.status.lcl.seq < l.seq ? { ...state.status, lcl: l } : state.status;
      return {
        ...state,
        ledgers,
        txs,
        txStatus,
        status,
        lastCloseEventAt: now,
        closeCounter: state.closeCounter + 1,
      };
    }

    case 'scp': {
      const k = scpKey(ev.event);
      const head = state.scpEvents.slice(0, 40);
      if (head.some((e) => scpKey(e) === k)) return state;
      return { ...state, scpEvents: [ev.event, ...state.scpEvents].slice(0, MAX_SCP_EVENTS) };
    }

    case 'slot': {
      const cur = state.slot;
      if (cur && ev.slot.slot < cur.slot) return state;
      return { ...state, slot: ev.slot };
    }

    case 'peers':
      return { ...state, peers: ev.peers };

    case 'txStatus':
      return {
        ...state,
        txStatus: setTxStatus(state.txStatus, {
          hash: ev.hash,
          status: ev.status,
          ledgerSeq: ev.ledgerSeq,
          resultCode: ev.resultCode,
          ts: now,
        }),
      };

    case 'fork': {
      const k = forkKey(ev.info);
      if (state.forks.some((f) => forkKey(f) === k)) return state;
      const forks = [ev.info, ...state.forks].slice(0, MAX_FORKS);
      if (ev.info.resolution !== 'rolled-back') return { ...state, forks };
      return { ...state, forks, txStatus: forgetRolledBack(state.txStatus, ev.info.atSeq) };
    }

    case 'log': {
      const k = logKey(ev.entry);
      if (state.logs.slice(0, 20).some((e) => logKey(e) === k)) return state;
      return { ...state, logs: [ev.entry, ...state.logs].slice(0, MAX_LOGS) };
    }

    default:
      return state;
  }
}

export function reduce(state: NodeState, action: StoreAction): NodeState {
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event, action.now);
    case 'snapshot': {
      const d = action.data;
      const next: NodeState = { ...state };
      if (d.status !== undefined) next.status = d.status;
      if (d.ledgers) next.ledgers = mergeLedgers(state.ledgers, d.ledgers);
      if (d.txs) {
        const byHash = new Map<string, TxSummary>();
        for (const t of [...state.txs, ...d.txs]) byHash.set(t.hash, t);
        next.txs = [...byHash.values()].sort(compareTxNewestFirst).slice(0, MAX_TXS);
      }
      if (d.scpEvents) {
        const seen = new Set(state.scpEvents.map(scpKey));
        const merged = [...state.scpEvents, ...d.scpEvents.filter((e) => !seen.has(scpKey(e)))];
        next.scpEvents = merged.sort((a, b) => b.ts - a.ts).slice(0, MAX_SCP_EVENTS);
      }
      if (d.slot !== undefined && (!state.slot || !d.slot || d.slot.slot >= state.slot.slot)) next.slot = d.slot;
      if (d.peers) next.peers = d.peers;
      if (d.validators) next.validators = d.validators;
      if (d.stats) next.stats = d.stats;
      if (d.forks) {
        const seen = new Set(state.forks.map(forkKey));
        next.forks = [...state.forks, ...d.forks.filter((f) => !seen.has(forkKey(f)))]
          .sort((a, b) => b.ts - a.ts)
          .slice(0, MAX_FORKS);
      }
      if (d.logs) {
        const seen = new Set(state.logs.map(logKey));
        next.logs = [...state.logs, ...d.logs.filter((e) => !seen.has(logKey(e)))]
          .sort((a, b) => b.ts - a.ts)
          .slice(0, MAX_LOGS);
      }
      return next;
    }
    case 'ready':
      return state.ready ? state : { ...state, ready: true, error: null };
    case 'error':
      return { ...state, error: action.error };
    case 'localTx':
      return {
        ...state,
        txStatus: setTxStatus(state.txStatus, {
          hash: action.hash,
          status: action.status,
          resultCode: action.resultCode,
          ts: action.now,
        }),
      };
    case 'resync':
      return { ...state, resyncAt: action.now };
  }
}

type Listener = () => void;

/** External store: owns the NodeApi subscription and coalesces notifications. */
export class NodeStore {
  private state: NodeState = initialState();
  private listeners = new Set<Listener>();
  private notifyQueued = false;
  private refreshing = { validators: false, stats: false };
  private refreshAgain = { validators: false, stats: false };

  constructor(
    readonly api: NodeApi,
    readonly clock: Clock,
  ) {}

  getState = (): NodeState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  dispatch(action: StoreAction): void {
    const next = reduce(this.state, action);
    if (next === this.state) return;
    this.state = next;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const fn of [...this.listeners]) fn();
    });
  }

  /** Subscribe to the node and load the initial state. Returns a stop function. */
  start(): () => void {
    let stopped = false;
    let loaded = false;
    const queue: NodeEvent[] = [];
    const unsubscribe = this.api.subscribe((ev) => {
      if (stopped) return;
      if (!loaded) queue.push(ev);
      else this.handleEvent(ev);
    });
    this.loadInitial()
      .then((data) => {
        if (stopped) return;
        this.dispatch({ type: 'snapshot', data });
        loaded = true;
        for (const ev of queue.splice(0)) this.handleEvent(ev);
        this.dispatch({ type: 'ready' });
      })
      .catch((err: unknown) => {
        if (stopped) return;
        loaded = true;
        for (const ev of queue.splice(0)) this.handleEvent(ev);
        this.dispatch({ type: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }

  private async loadInitial(): Promise<SnapshotData> {
    const api = this.api;
    const [status, ledgers, txs, scpEvents, slot, peers, validators, stats, forks, logs] = await Promise.all([
      api.getStatus(),
      api.getLedgers({ limit: MAX_LEDGERS }),
      api.getTransactions({ limit: 40 }),
      api.getScpEvents(MAX_SCP_EVENTS),
      api.getScpSlot(),
      api.getPeers(),
      api.getValidators(),
      api.getStats(),
      api.getForks(),
      api.getLogs(MAX_LOGS),
    ]);
    return {
      status,
      ledgers,
      txs,
      scpEvents: [...scpEvents].sort((a, b) => b.ts - a.ts),
      slot,
      peers,
      validators,
      stats,
      forks: [...forks].sort((a, b) => b.ts - a.ts),
      logs: [...logs].sort((a, b) => b.ts - a.ts),
    };
  }

  private handleEvent(ev: NodeEvent): void {
    this.dispatch({ type: 'event', event: ev, now: this.clock.now() });
    if (ev.type === 'ledgerClosed') {
      void this.refresh('stats');
      void this.refresh('validators');
    } else if (ev.type === 'peers') {
      void this.refresh('validators');
    }
  }

  /** Refetch validators or stats; overlapping calls coalesce into one follow-up. */
  async refresh(what: 'validators' | 'stats'): Promise<void> {
    if (this.refreshing[what]) {
      this.refreshAgain[what] = true;
      return;
    }
    this.refreshing[what] = true;
    try {
      do {
        this.refreshAgain[what] = false;
        if (what === 'validators') {
          const validators = await this.api.getValidators();
          this.dispatch({ type: 'snapshot', data: { validators } });
        } else {
          const stats = await this.api.getStats();
          this.dispatch({ type: 'snapshot', data: { stats } });
        }
      } while (this.refreshAgain[what]);
    } catch {
      // keep the last good value
    } finally {
      this.refreshing[what] = false;
    }
  }

  /** Record a submission made by this UI so its status is tracked. */
  trackSubmitted(hash: string): void {
    if (!this.state.txStatus[hash]) this.dispatch({ type: 'localTx', hash, status: 'pending', now: this.clock.now() });
  }

  markRejected(hash: string, resultCode: string): void {
    this.dispatch({ type: 'localTx', hash, status: 'failed', resultCode, now: this.clock.now() });
  }

  /** Call when a resync this UI asked for has started (the node wiped its chain). */
  noteResync(): void {
    this.dispatch({ type: 'resync', now: this.clock.now() });
  }

  /**
   * Look up transactions submitted in an earlier visit (after a reload the
   * store has no status for them). Applied and failed ones get their final
   * status; ones the node has no record of stay unknown.
   */
  async resolveFromHistory(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      if (this.state.txStatus[hash]) continue;
      try {
        const forks = this.state.forks;
        const tx = await this.api.getTransaction(hash);
        if (!tx || this.state.txStatus[hash]) continue;
        // a rollback during the call may have dropped that ledger
        if (this.state.forks.some((f) => f.resolution === 'rolled-back' && f.atSeq <= tx.ledgerSeq && !forks.includes(f))) continue;
        const event: NodeEvent = { type: 'txStatus', hash, status: tx.successful ? 'applied' : 'failed', ledgerSeq: tx.ledgerSeq, resultCode: tx.resultCode };
        this.dispatch({ type: 'event', event, now: this.clock.now() });
      } catch {
        // stays unknown
      }
    }
  }

  /** Resolve when the tx reaches applied / failed / dropped; reject on timeout. */
  waitForTx(hash: string, timeoutMs = 90_000): Promise<TxStatusInfo> {
    return new Promise((resolve, reject) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      let timer: number | null = null;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        unsubscribe?.();
        if (timer !== null) this.clock.clearTimeout(timer);
        fn();
      };
      const check = () => {
        const s = this.state.txStatus[hash];
        if (s && s.status !== 'pending') finish(() => resolve(s));
      };
      unsubscribe = this.subscribe(check);
      timer = this.clock.setTimeout(() => finish(() => reject(new Error('Timed out waiting for the transaction.'))), timeoutMs);
      check();
    });
  }
}
