// WorkerNodeClient: the NodeApi on the page, backed by the node worker
// (ARCHITECTURE 11). Each call is one 'call' message with an id, answered by
// one 'result' (30 s timeout). The worker posts one event stream, fanned out
// here to every subscriber. When the worker dies, pending and later calls
// fail at once.

import { RealClock, type Clock, type TimerHandle } from '../lib/clock';
import type { LogEntry } from '../lib/log';
import type {
  AccountView,
  AssetStatView,
  AssetView,
  ForkInfo,
  LedgerDetail,
  LedgerSummary,
  NetworkStats,
  NodeApi,
  NodeEvent,
  NodeStatus,
  OrderBookView,
  PeerView,
  QuorumConfigInput,
  QuorumConfigView,
  ScpEventView,
  ScpSlotView,
  SubmitResult,
  TxDetail,
  TxSummary,
  ValidatorView,
} from './api';
import {
  deserializeError,
  parseFromWorker,
  type ApiMethod,
  type InitParams,
  type LifecycleEvent,
  type ReadyInfo,
  type ToWorker,
} from './rpc';

export const CALL_TIMEOUT_MS = 30_000;

/** A Worker, or one end of a MessageChannel (tests). */
export interface WorkerEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
  /** MessagePort: start delivery. */
  start?(): void;
  /** Worker: kill it. */
  terminate?(): void;
}

export interface WorkerNodeClientOptions {
  /** Per-call timeout. Default 30 s. */
  timeoutMs?: number;
  clock?: Clock;
}

interface Pending {
  method: ApiMethod;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: TimerHandle;
}

export class WorkerNodeClient implements NodeApi {
  /** Resolves when the worker's node has started; rejects if it dies first. */
  readonly ready: Promise<ReadyInfo>;
  private resolveReady!: (info: ReadyInfo) => void;
  private rejectReady!: (err: Error) => void;
  private readyInfo: ReadyInfo | null = null;
  private deadWith: Error | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(ev: NodeEvent) => void>();
  private readonly fatalListeners = new Set<(err: Error) => void>();
  private readonly timeoutMs: number;
  private readonly clock: Clock;

  private readonly onMessage = (ev: Event): void => this.handle((ev as MessageEvent).data);
  private readonly onError = (ev: Event): void => {
    const e = ev as ErrorEvent;
    const where = e.filename ? ` (${e.filename}:${e.lineno})` : '';
    // a script that cannot be fetched or parsed gives an error event without a message
    const msg = e.message ? `${e.message}${where}` : 'its script could not be loaded';
    // Before 'ready' the worker could not even load. Later, an uncaught error
    // does not stop a worker; it says 'fatal' when it cannot go on.
    if (!this.readyInfo) this.die(new Error(`node worker failed to start: ${msg}`));
    else console.error(`node worker error: ${msg}`);
  };
  private readonly onMessageError = (): void => {
    console.error('node worker sent a message that could not be read');
  };
  private readonly onClose = (): void => this.die(new Error('node worker connection closed'));

  constructor(
    private readonly endpoint: WorkerEndpoint,
    opts: WorkerNodeClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;
    this.clock = opts.clock ?? new RealClock();
    this.ready = new Promise<ReadyInfo>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // nobody may be waiting when the worker dies
    this.ready.catch(() => undefined);
    endpoint.addEventListener('message', this.onMessage);
    endpoint.addEventListener('error', this.onError);
    endpoint.addEventListener('messageerror', this.onMessageError);
    endpoint.addEventListener('close', this.onClose);
    endpoint.start?.();
  }

  /** What the worker runs, once ready. */
  get info(): ReadyInfo | null {
    return this.readyInfo;
  }

  /** The error the worker died with, or null while it is alive. */
  get deathCause(): Error | null {
    return this.deadWith;
  }

  /** Start the node in the worker. `port` (the WebRTC bridge) is transferred. */
  init(params: InitParams, port?: MessagePort | null): void {
    const msg: ToWorker = { type: 'init', params, port: port ?? null };
    this.post(msg, port ? [port] : []);
  }

  /** Forward a page lifecycle event. */
  lifecycle(event: LifecycleEvent): void {
    this.post({ type: 'lifecycle', event });
  }

  /** Called once when the worker dies (fatal error, failed start, terminate). */
  onFatal(cb: (err: Error) => void): () => void {
    if (this.deadWith) {
      const err = this.deadWith;
      queueMicrotask(() => cb(err));
      return () => undefined;
    }
    this.fatalListeners.add(cb);
    return () => {
      this.fatalListeners.delete(cb);
    };
  }

  /** Kill the worker; pending calls fail. */
  terminate(reason = 'node worker terminated'): void {
    try {
      this.endpoint.terminate?.();
    } catch {
      // already gone
    }
    this.die(new Error(reason));
  }

  // ------------------------------------------------------------ messages

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    if (this.deadWith) return;
    try {
      this.endpoint.postMessage(msg, transfer);
    } catch (err) {
      this.die(new Error(`cannot reach the node worker: ${(err as Error)?.message ?? err}`));
    }
  }

  private handle(data: unknown): void {
    if (this.deadWith) return;
    const msg = parseFromWorker(data);
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        if (this.readyInfo) return;
        this.readyInfo = msg.info;
        this.resolveReady(msg.info);
        return;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        this.clock.clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(deserializeError(msg.error));
        return;
      }
      case 'event':
        for (const fn of [...this.listeners]) {
          try {
            fn(msg.event);
          } catch (err) {
            console.error('node event listener failed', err);
          }
        }
        return;
      case 'fatal':
        this.die(deserializeError(msg.error));
        return;
    }
  }

  private die(err: Error): void {
    if (this.deadWith) return;
    this.deadWith = err;
    this.endpoint.removeEventListener('message', this.onMessage);
    this.endpoint.removeEventListener('error', this.onError);
    this.endpoint.removeEventListener('messageerror', this.onMessageError);
    this.endpoint.removeEventListener('close', this.onClose);
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      this.clock.clearTimeout(p.timer);
      p.reject(new Error(`${p.method} failed: ${err.message}`));
    }
    this.rejectReady(err);
    for (const cb of [...this.fatalListeners]) {
      try {
        cb(err);
      } catch (e) {
        console.error('onFatal callback failed', e);
      }
    }
    this.fatalListeners.clear();
  }

  private call<T>(method: ApiMethod, args: unknown[]): Promise<T> {
    if (this.deadWith) return Promise.reject(new Error(`${method} failed: ${this.deadWith.message}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method} timed out after ${Math.round(this.timeoutMs / 1000)} s`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      const msg: ToWorker = { type: 'call', id, method, args };
      try {
        this.endpoint.postMessage(msg, []);
      } catch (err) {
        // postMessage throws for a value that cannot be cloned (DataCloneError):
        // this call fails, the worker is fine
        this.pending.delete(id);
        this.clock.clearTimeout(timer);
        reject(new Error(`${method}: arguments cannot be sent to the node worker (${(err as Error)?.message ?? err})`));
      }
    });
  }

  // ------------------------------------------------------------ NodeApi

  subscribe(listener: (ev: NodeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): Promise<NodeStatus> {
    return this.call('getStatus', []);
  }

  getLedgers(opts: { limit: number; beforeSeq?: number }): Promise<LedgerSummary[]> {
    return this.call('getLedgers', [opts]);
  }

  getLedger(seq: number): Promise<LedgerDetail | null> {
    return this.call('getLedger', [seq]);
  }

  getTransaction(hash: string): Promise<TxDetail | null> {
    return this.call('getTransaction', [hash]);
  }

  getTransactions(opts: { limit: number; account?: string; beforeLedger?: number }): Promise<TxSummary[]> {
    return this.call('getTransactions', [opts]);
  }

  getAccount(accountId: string): Promise<AccountView | null> {
    return this.call('getAccount', [accountId]);
  }

  getOrderBook(selling: AssetView, buying: AssetView, limit?: number): Promise<OrderBookView> {
    return this.call('getOrderBook', limit === undefined ? [selling, buying] : [selling, buying, limit]);
  }

  getAssets(): Promise<AssetStatView[]> {
    return this.call('getAssets', []);
  }

  submitTransaction(envelopeXdr: string): Promise<SubmitResult> {
    return this.call('submitTransaction', [envelopeXdr]);
  }

  friendbot(accountId: string): Promise<SubmitResult> {
    return this.call('friendbot', [accountId]);
  }

  getPeers(): Promise<PeerView[]> {
    return this.call('getPeers', []);
  }

  getValidators(): Promise<ValidatorView[]> {
    return this.call('getValidators', []);
  }

  getQuorumConfig(): Promise<QuorumConfigView> {
    return this.call('getQuorumConfig', []);
  }

  setQuorumConfig(cfg: QuorumConfigInput): Promise<QuorumConfigView> {
    return this.call('setQuorumConfig', [cfg]);
  }

  getScpSlot(slot?: number): Promise<ScpSlotView | null> {
    return this.call('getScpSlot', slot === undefined ? [] : [slot]);
  }

  getScpEvents(limit: number): Promise<ScpEventView[]> {
    return this.call('getScpEvents', [limit]);
  }

  getStats(): Promise<NetworkStats> {
    return this.call('getStats', []);
  }

  getForks(): Promise<ForkInfo[]> {
    return this.call('getForks', []);
  }

  getLogs(limit: number): Promise<LogEntry[]> {
    return this.call('getLogs', [limit]);
  }

  setValidating(on: boolean): Promise<void> {
    return this.call('setValidating', [on]);
  }

  setName(name: string): Promise<void> {
    return this.call('setName', [name]);
  }

  resync(): Promise<void> {
    return this.call('resync', []);
  }
}
