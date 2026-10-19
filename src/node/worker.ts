// Node worker entry (ARCHITECTURE 11): runs one validator (Node + NodeService)
// for the page and answers its RPC calls.
//
// page -> worker: 'init' once (params, and the WebRTC bridge port unless the
// transport is 'broadcast'), then 'call' and 'lifecycle' messages.
// worker -> page: 'ready', 'result', 'event' and 'fatal'.

import { toHex } from '../lib/bytes';
import { RealClock, type Clock } from '../lib/clock';
import { networkPassphrase } from '../lib/constants';
import { networkIdOf } from '../lib/hash';
import { LogSink, Logger, type LogLevel } from '../lib/log';
import { BridgeTransport } from '../overlay/bridgeTransport';
import { BroadcastChannelTransport, type BroadcastChannelLike } from '../overlay/broadcastTransport';
import type { Transport } from '../overlay/types';
import { IdbStorage } from '../storage/idbStorage';
import { MemoryStorage } from '../storage/memoryStorage';
import type { Storage } from '../storage/types';
import { FallbackStorage } from './fallbackStorage';
import { Node, type NodeOptions } from './node';
import { RpcServer, parseToWorker, type FromWorker, type InitParams, type LifecycleEvent, type ReadyInfo } from './rpc';
import { GapCheckTransport, GapClock, NodeService } from './service';

/** IndexedDB database of one identity slot. */
export function storageName(network: string, slot: number): string {
  return `browserchain:${network}:slot:${slot}`;
}

/** IndexedDB for a slot (behind FallbackStorage), or memory in fresh mode. */
export function defaultStorage(params: InitParams, onFallback: (reason: string, err: unknown) => void): Storage {
  if (params.fresh || params.slot === null) return new MemoryStorage();
  return new FallbackStorage(new IdbStorage(storageName(params.network, params.slot)), onFallback);
}

export interface WorkerHostOptions {
  /** Default RealClock. */
  clock?: Clock;
  /** Storage for the init params. Default: defaultStorage. */
  storage?: (params: InitParams, onFallback: (reason: string, err: unknown) => void) => Storage;
  /** BroadcastChannel factory (tests). */
  channelFactory?: (name: string) => BroadcastChannelLike;
  logLevel?: LogLevel;
  /** Extra node options (tests). */
  nodeOptions?: Partial<Pick<NodeOptions, 'tuning' | 'herderTuning' | 'overlay' | 'secret'>>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The worker's state machine: init, RPC, lifecycle and node restarts. */
export class WorkerHost {
  readonly clock: GapClock;
  readonly logSink: LogSink;
  private readonly log: Logger;
  private readonly server: RpcServer;
  private params: InitParams | null = null;
  private port: MessagePort | null = null;
  private storage: Storage | null = null;
  private node: Node | null = null;
  private service: NodeService | null = null;
  private unsubscribe: (() => void) | null = null;
  private starting: Promise<NodeService> | null = null;
  /** Why the last start failed (calls then fail with it). */
  private failure: unknown = null;
  private stopping: Promise<void> | null = null;
  private initialized!: () => void;
  private readonly initPromise = new Promise<void>((resolve) => {
    this.initialized = resolve;
  });

  constructor(
    post: (msg: FromWorker) => void,
    private readonly opts: WorkerHostOptions = {},
  ) {
    this.clock = new GapClock(opts.clock ?? new RealClock());
    // timers far behind: the worker was paused; the node re-checks sync before any of them runs
    this.clock.onGap = (lateMs) => this.node?.onResume(`timers ran ${Math.round(lateMs / 1000)} s late`);
    this.logSink = new LogSink(this.clock, opts.logLevel ?? 'info');
    this.log = new Logger(this.logSink, 'worker');
    this.server = new RpcServer({ post, api: () => this.current() });
  }

  /** The running node (null before init). */
  get currentNode(): Node | null {
    return this.node;
  }

  get currentService(): NodeService | null {
    return this.service;
  }

  private current(): Promise<NodeService> {
    if (this.service) return Promise.resolve(this.service);
    if (this.starting) return this.starting;
    if (this.failure !== null) return Promise.reject(this.failure);
    // before 'init': wait for it (init sets `starting` before resolving)
    return this.initPromise.then(() => this.current());
  }

  handleMessage(data: unknown): void {
    const msg = parseToWorker(data);
    if (!msg) return;
    switch (msg.type) {
      case 'call':
        this.server.handle(msg);
        return;
      case 'init':
        void this.init(msg.params, msg.port);
        return;
      case 'lifecycle':
        this.lifecycle(msg.event);
        return;
    }
  }

  private async init(params: InitParams, port: MessagePort | null): Promise<void> {
    if (this.params) {
      this.log.warn('init received twice; ignored');
      return;
    }
    this.params = params;
    this.port = port;
    const make = this.opts.storage ?? defaultStorage;
    this.storage = make(params, (reason, err) =>
      // ChainStore and the node keep working on memory: say so once, loudly
      this.log.error(`${reason} (${errText(err)}): new data is kept in memory only and is lost when this tab closes`),
    );
    const start = this.startNode();
    this.starting = start;
    this.initialized();
    try {
      await start;
      this.server.ready(this.readyInfo());
    } catch (err) {
      this.failure = err;
      this.log.error(`node failed to start: ${errText(err)}`);
      this.server.fatal(err);
    } finally {
      if (this.starting === start) this.starting = null;
    }
  }

  private readyInfo(): ReadyInfo {
    const node = this.node!;
    const params = this.params!;
    const memory = !(this.storage instanceof FallbackStorage) || this.storage.inMemory;
    return { nodeId: node.nodeId, name: node.name, network: params.network, slot: params.fresh ? null : params.slot, storage: memory ? 'memory' : 'indexeddb' };
  }

  private async startNode(): Promise<NodeService> {
    const params = this.params!;
    const networkId = toHex(networkIdOf(networkPassphrase(params.network)));
    const transports: Transport[] = [];
    if (params.transport !== 'webrtc') {
      transports.push(
        new BroadcastChannelTransport({ networkId, clock: this.clock, logger: this.log.child('broadcast'), channelFactory: this.opts.channelFactory }),
      );
    }
    if (params.transport !== 'broadcast' && this.port) {
      transports.push(new BridgeTransport(this.port, { logger: this.log.child('bridge') }));
    }
    const node = new Node({
      ...this.opts.nodeOptions,
      // inbound traffic after a freeze triggers the sync re-check before it is handled
      transports: transports.map((t) => new GapCheckTransport(t, this.clock)),
      storage: this.storage!,
      clock: this.clock,
      logSink: this.logSink,
      networkName: params.network,
      name: params.name?.trim() || undefined,
    });
    this.node = node;
    await node.start();
    const service = new NodeService(node, { clock: this.clock });
    this.unsubscribe = service.subscribe((ev) => this.server.event(ev));
    this.service = service;
    return service;
  }

  private lifecycle(event: LifecycleEvent): void {
    switch (event) {
      case 'pagehide':
        this.stopNode();
        return;
      case 'pageshow-persisted':
        // back from the back/forward cache: pagehide stopped the node
        if (this.stopping || (this.node && !this.node.isRunning && this.node.state === 'stopped')) void this.restart();
        else this.service?.lifecycle(event);
        return;
      default:
        this.service?.lifecycle(event);
    }
  }

  /** Bye first (Node.stop sends it synchronously, before any await), then stop and flush. */
  private stopNode(): void {
    const node = this.node;
    if (!node || this.stopping || !node.isRunning) return;
    this.stopping = node
      .stop()
      .catch((err: unknown) => this.log.warn(`stop failed: ${errText(err)}`))
      .finally(() => {
        this.stopping = null;
      });
  }

  /** Start a new node on the same storage (same identity) after a stop. */
  private async restart(): Promise<void> {
    if (this.starting) return;
    const start = (async () => {
      if (this.stopping) await this.stopping;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.service?.dispose();
      this.service = null;
      return this.startNode();
    })();
    this.starting = start;
    try {
      await start;
      this.failure = null;
      this.log.info('node restarted after the page came back');
    } catch (err) {
      this.failure = err;
      this.log.error(`node restart failed: ${errText(err)}`);
      this.server.fatal(err);
    } finally {
      if (this.starting === start) this.starting = null;
    }
  }
}

/** The parts of a worker global scope the host uses. */
export interface WorkerScopeLike {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (ev: Event) => void): void;
}

export function startWorkerHost(scope: WorkerScopeLike, opts?: WorkerHostOptions): WorkerHost {
  const host = new WorkerHost((msg) => scope.postMessage(msg), opts);
  scope.addEventListener('message', (ev) => host.handleMessage((ev as MessageEvent).data));
  // an uncaught error does not stop a worker; keep it visible in the node log
  const log = new Logger(host.logSink, 'worker');
  scope.addEventListener('error', (ev) => log.error(`uncaught error: ${(ev as ErrorEvent).message ?? ev}`));
  scope.addEventListener('unhandledrejection', (ev) => log.error(`unhandled rejection: ${errText((ev as PromiseRejectionEvent).reason)}`));
  return host;
}

// Only inside a real worker (tests import this module in Node).
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  startWorkerHost(self as unknown as WorkerScopeLike);
}
