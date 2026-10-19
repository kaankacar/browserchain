// Main-thread boot (ARCHITECTURE 11): claims an identity slot with Web Locks,
// starts the node worker, bridges WebRTC (Trystero) into it, forwards page
// lifecycle events, and exposes the client as window.__browserchain.
//
// URL parameters: ?network=<name> (default DEFAULT_NETWORK_NAME), ?fresh=1
// (ephemeral identity, memory storage), ?transport=broadcast|webrtc|both
// (default both), ?name=<display name>. main.tsx handles ?mock=1.

import { toHex } from '../lib/bytes';
import { RealClock } from '../lib/clock';
import { DEFAULT_NETWORK_NAME, networkPassphrase } from '../lib/constants';
import { networkIdOf } from '../lib/hash';
import type { PortLike, WorkerToMain } from '../overlay/bridgeProtocol';
import { WorkerNodeClient } from './client';
import { TRANSPORT_MODES, type InitParams, type LifecycleEvent, type ReadyInfo, type TransportMode } from './rpc';

/** Identity slots per network and browser profile (one per open tab). */
export const IDENTITY_SLOTS = 64;
export const READY_TIMEOUT_MS = 60_000;
const MAX_PARAM_LENGTH = 64;

export interface BootParams {
  network: string;
  fresh: boolean;
  transport: TransportMode;
  name?: string;
}

/** Boot parameters from the page URL's query string. */
export function parseBootParams(search: string): BootParams {
  const q = new URLSearchParams(search);
  const network = (q.get('network') ?? '').trim().slice(0, MAX_PARAM_LENGTH) || DEFAULT_NETWORK_NAME;
  const freshParam = (q.get('fresh') ?? '').trim().toLowerCase();
  const transportParam = (q.get('transport') ?? '').trim().toLowerCase();
  const transport = (TRANSPORT_MODES as readonly string[]).includes(transportParam) ? (transportParam as TransportMode) : 'both';
  const out: BootParams = { network, fresh: freshParam === '1' || freshParam === 'true', transport };
  const name = (q.get('name') ?? '').trim().slice(0, MAX_PARAM_LENGTH);
  if (name) out.name = name;
  return out;
}

// ---------------------------------------------------------------- identity slots

/** The part of navigator.locks the boot uses. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

export interface SlotClaim {
  slot: number;
  /** Give the slot back (a page keeps it until it closes). */
  release(): void;
}

export function slotLockName(network: string, slot: number): string {
  return `browserchain:${network}:slot:${slot}`;
}

/**
 * Claim the first free identity slot 0..count-1: each tab of one browser is a
 * distinct validator with a persistent key. The lock is held until release()
 * or until the tab closes. Null when every slot is taken.
 */
export async function claimIdentitySlot(locks: LockManagerLike, network: string, count = IDENTITY_SLOTS): Promise<SlotClaim | null> {
  for (let i = 0; i < count; i++) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const got = await new Promise<boolean>((resolve, reject) => {
      locks
        .request(slotLockName(network, i), { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          resolve(true);
          return held;
        })
        .catch(reject);
    });
    if (got) return { slot: i, release };
  }
  return null;
}

// ---------------------------------------------------------------- WebRTC bridge

/**
 * The page end of the bridge MessagePort, given to TrysteroHost. inject()
 * hands the host a frame as if the worker had sent it: on pagehide the page
 * sends our bye to WebRTC peers itself, because the worker may never get to
 * run again.
 */
export class BridgePort implements PortLike {
  private readonly listeners = new Set<(ev: MessageEvent) => void>();

  constructor(private readonly port: PortLike) {
    port.addEventListener('message', (ev) => this.dispatch(ev));
  }

  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }

  addEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  start(): void {
    this.port.start?.();
  }

  inject(frame: WorkerToMain): void {
    this.dispatch(new MessageEvent('message', { data: frame }));
  }

  private dispatch(ev: MessageEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (err) {
        console.error('bridge listener failed', err);
      }
    }
  }
}

/** What the boot needs from TrysteroHost. */
interface TrysteroHostLike {
  readonly running: boolean;
  start(): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------- boot

/** A boot step failed. `step` says which one, for the error screen. */
export class BootError extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step} failed: ${detail}`);
    this.name = 'BootError';
  }
}

export interface BootOptions {
  /** Default window.location.search. */
  search?: string;
  readyTimeoutMs?: number;
}

export interface BootResult {
  client: WorkerNodeClient;
  params: InitParams;
  info: ReadyInfo;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function networkIdHex(network: string): string {
  return toHex(networkIdOf(networkPassphrase(network)));
}

/** The part of navigator.storage the boot uses. */
export interface StorageManagerLike {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

export type PersistenceResult = 'already-persisted' | 'granted' | 'denied' | 'unsupported' | 'failed';

function mb(n: number | undefined): string {
  return n === undefined ? '?' : `${Math.round(n / (1024 * 1024))} MB`;
}

/**
 * Ask the browser not to evict our IndexedDB, and log the result with the
 * storage estimate. Best effort: a refusal changes nothing, but the chain of
 * a best-effort origin may be evicted under storage pressure.
 */
export async function requestPersistence(
  storage: StorageManagerLike | undefined = typeof navigator === 'undefined' ? undefined : navigator.storage,
  log: Pick<Console, 'info' | 'warn'> = console,
): Promise<PersistenceResult> {
  let result: PersistenceResult;
  try {
    if (!storage || typeof storage.persist !== 'function') result = 'unsupported';
    else if (typeof storage.persisted === 'function' && (await storage.persisted())) result = 'already-persisted';
    else result = (await storage.persist()) ? 'granted' : 'denied';
  } catch {
    result = 'failed';
  }
  let usage = '';
  try {
    const e = typeof storage?.estimate === 'function' ? await storage.estimate() : null;
    if (e) usage = `; using ${mb(e.usage)} of ${mb(e.quota)}`;
  } catch {
    // no estimate here
  }
  if (result === 'granted' || result === 'already-persisted') log.info(`BrowserChain: persistent storage ${result}${usage}`);
  else log.warn(`BrowserChain: persistent storage ${result}: the browser may evict the local chain under storage pressure${usage}`);
  return result;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  const clock = new RealClock();
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clock.clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clock.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function forwardLifecycle(client: WorkerNodeClient, bridge: BridgePort | null, host: TrysteroHostLike | null): void {
  const send = (ev: LifecycleEvent) => client.lifecycle(ev);
  document.addEventListener('visibilitychange', () => send(document.visibilityState === 'hidden' ? 'hidden' : 'visible'));
  // Page Lifecycle API (Chromium): the page and its workers are frozen and resumed
  document.addEventListener('freeze', () => send('freeze'));
  document.addEventListener('resume', () => send('resume'));
  window.addEventListener('pageshow', (ev) => {
    if (!(ev as PageTransitionEvent).persisted) return;
    // back from the back/forward cache: pagehide left the room and stopped the node
    if (host && !host.running) {
      try {
        host.start();
      } catch (err) {
        console.warn('rejoining the WebRTC room failed', err);
      }
    }
    send('pageshow-persisted');
  });
  window.addEventListener('pagehide', () => {
    // the worker sends bye on every link, then stops the node
    send('pagehide');
    const nodeId = client.info?.nodeId;
    if (host?.running && bridge && nodeId) bridge.inject({ type: 'broadcast', msg: { t: 'bye', nodeId } });
    void host?.stop();
  });
}

/**
 * Start the validator for this tab and return its client once the node runs
 * (state 'booting'). Throws BootError when a step fails.
 */
export async function bootNode(opts: BootOptions = {}): Promise<BootResult> {
  const p = parseBootParams(opts.search ?? window.location.search);

  // 1. identity slot (fresh mode without Web Locks or when all slots are taken)
  let slot: number | null = null;
  let fresh = p.fresh;
  if (!fresh) {
    const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
    if (!locks || typeof locks.request !== 'function') {
      console.warn('BrowserChain: Web Locks are not available; using a fresh in-memory identity');
      fresh = true;
    } else {
      try {
        const claim = await claimIdentitySlot(locks, p.network);
        if (claim) slot = claim.slot;
        else {
          console.warn(`BrowserChain: all ${IDENTITY_SLOTS} identity slots are in use; using a fresh in-memory identity`);
          fresh = true;
        }
      } catch (err) {
        console.warn('BrowserChain: claiming an identity slot failed; using a fresh in-memory identity', err);
        fresh = true;
      }
    }
  }
  const params: InitParams = { network: p.network, slot: fresh ? null : slot, fresh, transport: p.transport };
  if (p.name) params.name = p.name;
  if (!fresh) void requestPersistence();

  // 2. the worker
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'browserchain-node' });
  } catch (err) {
    throw new BootError('Starting the node worker', errText(err));
  }
  const client = new WorkerNodeClient(worker);
  // handy for power users and e2e tests: await __browserchain.getStatus()
  (window as unknown as { __browserchain?: WorkerNodeClient }).__browserchain = client;

  // 3. WebRTC needs RTCPeerConnection, which workers lack: Trystero runs here
  let bridge: BridgePort | null = null;
  let host: TrysteroHostLike | null = null;
  let workerPort: MessagePort | null = null;
  if (params.transport !== 'broadcast') {
    const channel = new MessageChannel();
    bridge = new BridgePort(channel.port1);
    workerPort = channel.port2;
    try {
      const { TrysteroHost } = await import('../overlay/trysteroHost');
      const h = new TrysteroHost({ networkId: networkIdHex(params.network), port: bridge });
      h.start();
      host = h;
    } catch (err) {
      console.warn('BrowserChain: WebRTC is not available; only tabs of this browser are reachable', err);
    }
  }

  // 4. start the node
  client.init(params, workerPort);
  forwardLifecycle(client, bridge, host);
  try {
    const info = await withTimeout(client.ready, opts.readyTimeoutMs ?? READY_TIMEOUT_MS, `no answer within ${Math.round((opts.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)} s`);
    return { client, params, info };
  } catch (err) {
    client.terminate(errText(err));
    void host?.stop();
    throw new BootError('Starting the validator', errText(err));
  }
}
