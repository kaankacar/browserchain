// Messages between the page and the node worker (ARCHITECTURE 11), and the
// worker side of the RPC: it runs NodeApi calls and posts results, errors
// and events. Everything here crosses postMessage, so it must be
// structured-clone safe; errors travel as plain SerializedError objects.
//
// page -> worker: init (once, may transfer the WebRTC bridge MessagePort),
//                 call, lifecycle
// worker -> page: ready, result, event, fatal

import type { NodeApi, NodeEvent } from './api';

/** Page lifecycle events forwarded by the main thread. */
export type LifecycleEvent = 'hidden' | 'visible' | 'freeze' | 'resume' | 'pageshow-persisted' | 'pagehide';

export const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = ['hidden', 'visible', 'freeze', 'resume', 'pageshow-persisted', 'pagehide'];

export type TransportMode = 'broadcast' | 'webrtc' | 'both';

export const TRANSPORT_MODES: readonly TransportMode[] = ['broadcast', 'webrtc', 'both'];

export interface InitParams {
  /** Network name (selects the passphrase). */
  network: string;
  /** Identity slot claimed with Web Locks; null in fresh mode. */
  slot: number | null;
  /** Ephemeral identity and memory storage. */
  fresh: boolean;
  /** Display name for the node (overrides the stored one). */
  name?: string;
  transport: TransportMode;
}

/** Sent with 'ready': who the worker runs. */
export interface ReadyInfo {
  nodeId: string;
  name: string;
  network: string;
  slot: number | null;
  storage: 'indexeddb' | 'memory';
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

/** NodeApi methods callable over RPC (subscribe is the event stream). */
export type ApiMethod = Exclude<keyof NodeApi, 'subscribe'>;

export const API_METHODS: readonly ApiMethod[] = [
  'getStatus',
  'getLedgers',
  'getLedger',
  'getTransaction',
  'getTransactions',
  'getAccount',
  'getOrderBook',
  'getAssets',
  'submitTransaction',
  'friendbot',
  'getPeers',
  'getValidators',
  'getQuorumConfig',
  'setQuorumConfig',
  'getScpSlot',
  'getScpEvents',
  'getStats',
  'getForks',
  'getLogs',
  'setValidating',
  'setName',
  'resync',
];

const METHOD_SET: ReadonlySet<string> = new Set(API_METHODS);
const MAX_ARGS = 4;

export type ToWorker =
  | { type: 'init'; params: InitParams; port: MessagePort | null }
  | { type: 'call'; id: number; method: ApiMethod; args: unknown[] }
  | { type: 'lifecycle'; event: LifecycleEvent };

export type FromWorker =
  | { type: 'ready'; info: ReadyInfo }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: SerializedError }
  | { type: 'event'; event: NodeEvent }
  | { type: 'fatal'; error: SerializedError };

// ---------------------------------------------------------------- errors

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error || (typeof err === 'object' && err !== null && typeof (err as Error).message === 'string')) {
    const e = err as Error & { code?: unknown };
    const out: SerializedError = { name: typeof e.name === 'string' && e.name ? e.name : 'Error', message: e.message };
    if (typeof e.code === 'string') out.code = e.code;
    if (typeof e.stack === 'string') out.stack = e.stack.slice(0, 4000);
    return out;
  }
  let message: string;
  try {
    message = typeof err === 'string' ? err : JSON.stringify(err) ?? String(err);
  } catch {
    message = String(err);
  }
  return { name: 'Error', message };
}

/** An error raised in the worker. */
export class RemoteError extends Error {
  readonly code: string | undefined;
  readonly remoteStack: string | undefined;

  constructor(e: SerializedError) {
    super(e.message);
    this.name = e.name || 'Error';
    this.code = e.code;
    this.remoteStack = e.stack;
  }
}

/** A well-formed SerializedError from untrusted data. */
export function toSerializedError(e: unknown): SerializedError {
  const r = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {};
  const out: SerializedError = {
    name: typeof r.name === 'string' && r.name ? r.name : 'Error',
    message: typeof r.message === 'string' ? r.message : 'unknown worker error',
  };
  if (typeof r.code === 'string') out.code = r.code;
  if (typeof r.stack === 'string') out.stack = r.stack;
  return out;
}

export function deserializeError(e: unknown): RemoteError {
  return new RemoteError(toSerializedError(e));
}

// ---------------------------------------------------------------- parsing

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isLifecycleEvent(v: unknown): v is LifecycleEvent {
  return typeof v === 'string' && (LIFECYCLE_EVENTS as readonly string[]).includes(v);
}

function parseInitParams(v: unknown): InitParams | null {
  if (!isRecord(v)) return null;
  if (typeof v.network !== 'string' || v.network.length === 0 || v.network.length > 64) return null;
  const slot = v.slot === null ? null : Number.isSafeInteger(v.slot) && (v.slot as number) >= 0 ? (v.slot as number) : undefined;
  if (slot === undefined) return null;
  if (typeof v.fresh !== 'boolean') return null;
  if (!(TRANSPORT_MODES as readonly unknown[]).includes(v.transport)) return null;
  if (v.name !== undefined && typeof v.name !== 'string') return null;
  const out: InitParams = { network: v.network, slot, fresh: v.fresh, transport: v.transport as TransportMode };
  if (typeof v.name === 'string') out.name = v.name;
  return out;
}

/** Validates a page -> worker message. */
export function parseToWorker(data: unknown): ToWorker | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'init': {
      const params = parseInitParams(data.params);
      if (!params) return null;
      const port = data.port;
      const isPort = isRecord(port) && typeof (port as { postMessage?: unknown }).postMessage === 'function';
      return { type: 'init', params, port: isPort ? (port as unknown as MessagePort) : null };
    }
    case 'call':
      if (!Number.isSafeInteger(data.id) || typeof data.method !== 'string' || !Array.isArray(data.args)) return null;
      return { type: 'call', id: data.id as number, method: data.method as ApiMethod, args: data.args };
    case 'lifecycle':
      return isLifecycleEvent(data.event) ? { type: 'lifecycle', event: data.event } : null;
    default:
      return null;
  }
}

/** Validates a worker -> page message. */
export function parseFromWorker(data: unknown): FromWorker | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'ready':
      return isRecord(data.info) && typeof data.info.nodeId === 'string' ? { type: 'ready', info: data.info as unknown as ReadyInfo } : null;
    case 'result':
      if (!Number.isSafeInteger(data.id)) return null;
      if (data.ok === true) return { type: 'result', id: data.id as number, ok: true, value: data.value };
      return { type: 'result', id: data.id as number, ok: false, error: toSerializedError(data.error) };
    case 'event':
      return isRecord(data.event) && typeof data.event.type === 'string' ? { type: 'event', event: data.event as unknown as NodeEvent } : null;
    case 'fatal':
      return { type: 'fatal', error: toSerializedError(data.error) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- server (worker side)

export interface RpcServerOptions {
  /** Post a message to the page. */
  post(msg: FromWorker): void;
  /** The API to run calls on; waits until the node is ready, rejects when it failed to start. */
  api(): Promise<NodeApi> | NodeApi;
}

/** Runs NodeApi calls for the page and posts results, events and fatal errors. */
export class RpcServer {
  constructor(private readonly opts: RpcServerOptions) {}

  /** Handle a 'call' message. Returns false for other messages. */
  handle(msg: ToWorker): boolean {
    if (msg.type !== 'call') return false;
    void this.run(msg.id, msg.method, msg.args);
    return true;
  }

  private async run(id: number, method: string, args: unknown[]): Promise<void> {
    let value: unknown;
    try {
      if (!METHOD_SET.has(method)) throw new Error(`unknown method: ${method}`);
      if (args.length > MAX_ARGS) throw new Error(`too many arguments for ${method}`);
      const api = await this.opts.api();
      const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
      value = await fn.apply(api, args);
    } catch (err) {
      this.send({ type: 'result', id, ok: false, error: serializeError(err) });
      return;
    }
    try {
      this.opts.post({ type: 'result', id, ok: true, value });
    } catch (err) {
      // e.g. DataCloneError: answer with an error instead of leaving the call hanging
      this.send({ type: 'result', id, ok: false, error: serializeError(new Error(`${method} returned a value that cannot be sent: ${(err as Error)?.message ?? err}`)) });
    }
  }

  event(ev: NodeEvent): void {
    this.send({ type: 'event', event: ev });
  }

  ready(info: ReadyInfo): void {
    this.send({ type: 'ready', info });
  }

  fatal(err: unknown): void {
    this.send({ type: 'fatal', error: serializeError(err) });
  }

  private send(msg: FromWorker): void {
    try {
      this.opts.post(msg);
    } catch {
      // the page is gone, or the value is not cloneable: nothing more to do
    }
  }
}
