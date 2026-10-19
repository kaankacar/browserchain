// NodeService (ARCHITECTURE 11): the UI-facing NodeApi over a running Node.
// Ledger, transaction and history queries read Storage (through the node's
// ChainStore for recent ledgers); account, order book, asset and stat queries
// read the current ledger. Node events become NodeEvents: status, slot and
// peers are coalesced (a settings change pushes a status at once), everything
// else is delivered as it happens. Every value returned is structured-clone
// safe: no bigint, class instances or functions; amounts are 7-decimal strings.
// Also here: page lifecycle handling and pause detection (GapClock).

import { StrKey, xdr } from '@stellar/stellar-sdk/base';
import { formatAmount } from '../lib/amount';
import { fromBase64, toHex } from '../lib/bytes';
import type { Clock, TimerHandle } from '../lib/clock';
import { PEER_TIMEOUT_MS } from '../lib/constants';
import type { LogEntry } from '../lib/log';
import { creditAsset } from '../ledger/asset';
import { accountAvailableBalance, isAuthorized, isAuthorizedToMaintainLiabilities, isClawbackEnabledOnTrustline } from '../ledger/balances';
import { priceLevels, type PriceLevel } from '../ledger/dex/quote';
import { decodeLedgerHeader } from '../ledger/header';
import type { LedgerManager } from '../ledger/manager';
import {
  AUTH_CLAWBACK_ENABLED_FLAG,
  AUTH_IMMUTABLE_FLAG,
  AUTH_REQUIRED_FLAG,
  AUTH_REVOCABLE_FLAG,
  OFFER_PASSIVE_FLAG,
  type Asset,
  type ClaimPredicate,
  type ClaimableBalanceEntry,
  type CreditAsset,
  type LedgerHeader,
  type OfferEntry,
  type Price,
} from '../ledger/types';
import type { Transport, TransportKind, TransportPeerId, WireMessage } from '../overlay/types';
import type { StoredLedger, StoredTx } from '../storage/types';
import type { TxStatusEvent } from '../herder/types';
import type {
  AccountView,
  AssetStatView,
  AssetView,
  ClaimableBalanceView,
  ForkInfo,
  LedgerDetail,
  LedgerSummary,
  NetworkStats,
  NodeApi,
  NodeEvent,
  NodeStatus,
  OfferView,
  OrderBookView,
  PeerView,
  QuorumConfigInput,
  QuorumConfigView,
  QuorumSetView,
  ScpEventView,
  ScpSlotView,
  SubmitResult,
  TxDetail,
  TxSummary,
  ValidatorView,
} from './api';
import type { Node } from './node';
import type { LifecycleEvent } from './rpc';
import { ledgerSummaryOf, scpEventViewOf, txSummaryOf } from './views';

/** Largest page a list query returns. */
export const MAX_PAGE = 200;
/** Offers read per side of an order book before grouping them into price levels. */
const BOOK_DEPTH = 2000;

export interface NodeServiceOptions {
  /** Clock for event coalescing and lifecycle gaps (the node's clock). */
  clock: Clock;
  /** Minimum gap between 'status' events. Default 500 ms. */
  statusEveryMs?: number;
  /** Minimum gap between 'slot' events. Default 250 ms. */
  slotEveryMs?: number;
  /** Minimum gap between 'peers' events. Default 1000 ms. */
  peersEveryMs?: number;
  /** Hidden for longer than this: re-check sync on 'visible'. Default PEER_TIMEOUT_MS. */
  resumeGapMs?: number;
}

// ---------------------------------------------------------------- coalescing

/**
 * At most one delivery per window. The first request in a quiet period is
 * delivered on the next tick; later ones within the window collapse into one
 * delivery at its end. `fire` reads the latest state, so nothing is lost.
 */
class Coalescer {
  private last = -Infinity;
  private timer: TimerHandle | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly everyMs: number,
    private readonly fire: () => void,
  ) {}

  request(): void {
    if (this.timer !== null) return;
    const wait = Math.max(0, this.last + this.everyMs - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.last = this.clock.now();
      this.fire();
    }, wait);
  }

  /** Deliver now (a user action): the next delivery waits a full window again. */
  now(): void {
    this.cancel();
    this.last = this.clock.now();
    this.fire();
  }

  cancel(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------- pause detection

/**
 * A Clock that notices when the process was paused (frozen tab, sleeping
 * machine): a timer runs much later than asked, or (poll) no timer ran for
 * too long when a message arrives. `onGap` runs once per pause, before the
 * first late callback or message, so the node can stop voting before any
 * stale timer or stale message acts (a stale quorum check would drop every
 * peer and leave the node a quorum of its own).
 */
export class GapClock implements Clock {
  /** Called with the length of the pause. */
  onGap: ((lateMs: number) => void) | null = null;
  private handledAt = -Infinity;
  private lastRunAt = -Infinity;

  constructor(
    private readonly inner: Clock,
    readonly thresholdMs: number = PEER_TIMEOUT_MS,
  ) {}

  now(): number {
    return this.inner.now();
  }

  setTimeout(cb: () => void, ms: number): TimerHandle {
    const due = this.inner.now() + Math.max(0, ms);
    return this.inner.setTimeout(() => {
      const now = this.inner.now();
      // timers due before the last detection belong to the pause already handled
      if (now - due > this.thresholdMs && due > this.handledAt) this.fire(now, now - due);
      this.lastRunAt = now;
      cb();
    }, ms);
  }

  clearTimeout(handle: TimerHandle): void {
    this.inner.clearTimeout(handle);
  }

  /** Call before handling input that does not come from a timer (a message). */
  poll(): void {
    if (this.lastRunAt === -Infinity) return;
    const now = this.inner.now();
    // a running node has timers every second; none for this long means a pause
    if (now - this.lastRunAt > this.thresholdMs) this.fire(now, now - this.lastRunAt);
  }

  private fire(now: number, lateMs: number): void {
    this.handledAt = now;
    this.lastRunAt = now;
    try {
      this.onGap?.(lateMs);
    } catch {
      // the timer callback or message must still run
    }
  }
}

/** Transport wrapper: inbound traffic first asks the GapClock whether we were paused. */
export class GapCheckTransport implements Transport {
  onPeerUp: ((peer: TransportPeerId) => void) | null = null;
  onPeerDown: ((peer: TransportPeerId) => void) | null = null;
  onMessage: ((peer: TransportPeerId, msg: WireMessage) => void) | null = null;

  constructor(
    readonly inner: Transport,
    private readonly gap: GapClock,
  ) {}

  get kind(): TransportKind {
    return this.inner.kind;
  }

  start(): void | Promise<void> {
    this.inner.onPeerUp = (p) => {
      this.gap.poll();
      this.onPeerUp?.(p);
    };
    this.inner.onPeerDown = (p) => {
      this.gap.poll();
      this.onPeerDown?.(p);
    };
    this.inner.onMessage = (p, m) => {
      this.gap.poll();
      this.onMessage?.(p, m);
    };
    return this.inner.start();
  }

  stop(): void {
    this.inner.onPeerUp = null;
    this.inner.onPeerDown = null;
    this.inner.onMessage = null;
    this.inner.stop();
  }

  send(peer: TransportPeerId, msg: WireMessage): void {
    this.inner.send(peer, msg);
  }

  broadcast(msg: WireMessage): void {
    this.inner.broadcast(msg);
  }

  peers(): TransportPeerId[] {
    return this.inner.peers();
  }

  channelId(peer: TransportPeerId): string | null {
    return this.inner.channelId?.(peer) ?? null;
  }
}

// ---------------------------------------------------------------- view helpers

function pageSize(limit: unknown, fallback = 20): number {
  const n = Math.floor(Number(limit ?? fallback));
  if (!Number.isFinite(n)) return Math.min(MAX_PAGE, fallback);
  return Math.max(0, Math.min(MAX_PAGE, n));
}

/** Size of a "most recent N" query (SCP events, logs): 0..1000. */
function recentLimit(limit: unknown): number {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : 0;
}

function optionalSeq(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : undefined;
}

function assetViewOf(a: Asset): AssetView {
  return a.type === 'native' ? { type: 'native', code: 'XLM' } : { type: a.type, code: a.code, issuer: a.issuer };
}

/** Ledger asset from an AssetView (the type follows the code length). Throws when invalid. */
export function assetFromView(a: AssetView): Asset {
  if (a && typeof a === 'object' && a.type === 'native') return { type: 'native' };
  if (a && typeof a === 'object' && typeof a.code === 'string' && typeof a.issuer === 'string' && StrKey.isValidEd25519PublicKey(a.issuer)) {
    return creditAsset(a.code, a.issuer);
  }
  throw new Error(`invalid asset: ${JSON.stringify(a)}`);
}

/** n/d as a decimal string: 7 decimals with trailing zeros trimmed, more digits for tiny prices. */
export function priceString(p: Price): string {
  if (p.d === 0) return '0';
  const v = p.n / p.d;
  const fixed = v.toFixed(7);
  if (Number(fixed) === 0 && v > 0) return v.toPrecision(7);
  return fixed.replace(/\.?0+$/, '') || '0';
}

function predicateJson(p: ClaimPredicate): unknown {
  switch (p.type) {
    case 'unconditional':
      return { type: 'unconditional' };
    case 'and':
    case 'or':
      return { type: p.type, predicates: [predicateJson(p.predicates[0]), predicateJson(p.predicates[1])] };
    case 'not':
      return { type: 'not', predicate: predicateJson(p.predicate) };
    case 'beforeAbsoluteTime':
      return { type: 'beforeAbsoluteTime', time: p.time.toString() };
  }
}

function claimableView(c: ClaimableBalanceEntry): ClaimableBalanceView {
  return {
    balanceId: c.balanceId,
    asset: assetViewOf(c.asset),
    amount: formatAmount(c.amount),
    sponsor: c.sponsor,
    claimants: c.claimants.map((x) => ({ destination: x.destination, predicate: predicateJson(x.predicate) })),
  };
}

function offerView(o: OfferEntry): OfferView {
  return {
    offerId: o.offerId.toString(),
    seller: o.sellerId,
    selling: assetViewOf(o.selling),
    buying: assetViewOf(o.buying),
    amount: formatAmount(o.amount),
    price: priceString(o.price),
    priceR: { n: o.price.n, d: o.price.d },
    passive: (o.flags & OFFER_PASSIVE_FLAG) !== 0,
  };
}

function levelView(l: PriceLevel): { price: string; amount: string; priceR: { n: number; d: number } } {
  return { price: priceString(l.price), amount: formatAmount(l.amount), priceR: { n: l.price.n, d: l.price.d } };
}

/** Printable text of a data value, or null for binary data. */
function dataText(valueBase64: string): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(valueBase64));
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u001f\u007f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/** Header fields for display (LedgerDetail.header): every value a string, as api.ts says. */
function headerFields(h: LedgerHeader): Record<string, string> {
  const sig = h.scpValue.signature;
  return {
    ledgerVersion: String(h.ledgerVersion),
    ledgerSeq: String(h.ledgerSeq),
    previousLedgerHash: h.previousLedgerHash,
    txSetHash: h.scpValue.txSetHash,
    closeTime: String(h.scpValue.closeTime),
    scpValueType: sig ? 'STELLAR_VALUE_SIGNED' : 'STELLAR_VALUE_BASIC',
    proposer: sig?.nodeId ?? '',
    valueSignature: sig?.signature ?? '',
    upgrades: String(h.scpValue.upgrades.length),
    txSetResultHash: h.txSetResultHash,
    bucketListHash: h.bucketListHash,
    totalCoins: formatAmount(h.totalCoins),
    feePool: formatAmount(h.feePool),
    inflationSeq: String(h.inflationSeq),
    idPool: h.idPool.toString(),
    baseFee: String(h.baseFee),
    baseReserve: String(h.baseReserve),
    maxTxSetSize: String(h.maxTxSetSize),
    skipList: h.skipList.join(' '),
  };
}

/** Hint and signature (hex) of every signature of a base64 TransactionEnvelope. */
export function signaturesOf(envelopeXdr: string): { hint: string; signature: string }[] {
  try {
    const env = xdr.TransactionEnvelope.fromXdr(fromBase64(envelopeXdr));
    let sigs: xdr.DecoratedSignature[];
    switch (env.type) {
      case 'envelopeTypeTx':
        sigs = env.v1.signatures;
        break;
      case 'envelopeTypeTxV0':
        sigs = env.v0.signatures;
        break;
      case 'envelopeTypeTxFeeBump':
        sigs = env.feeBump.signatures;
        break;
      default:
        return [];
    }
    return sigs.map((s) => ({ hint: toHex(s.hint.toBytes()), signature: toHex(s.signature.toBytes()) }));
  } catch {
    return [];
  }
}

function txStatusEventOf(e: TxStatusEvent): NodeEvent {
  const ev: Extract<NodeEvent, { type: 'txStatus' }> = { type: 'txStatus', hash: e.hash, status: e.status };
  if (e.ledgerSeq !== undefined) ev.ledgerSeq = e.ledgerSeq;
  if (e.resultCode !== undefined) ev.resultCode = e.resultCode;
  return ev;
}

function plainSubmitResult(r: SubmitResult): SubmitResult {
  const out: SubmitResult = { hash: r.hash, status: r.status };
  if (r.errorResultCode !== undefined) out.errorResultCode = r.errorResultCode;
  if (r.errorDetail !== undefined) out.errorDetail = r.errorDetail;
  return out;
}

function checkQsetView(q: QuorumSetView, depth = 0): void {
  if (depth > 4) throw new Error('quorum set is nested too deeply');
  if (!q || typeof q !== 'object') throw new Error('quorum set must be an object');
  if (!Number.isSafeInteger(q.threshold)) throw new Error('quorum set threshold must be an integer');
  if (!Array.isArray(q.validators) || !q.validators.every((v) => typeof v === 'string')) {
    throw new Error('quorum set validators must be node ids');
  }
  if (!Array.isArray(q.innerSets)) throw new Error('quorum set innerSets must be a list');
  for (const inner of q.innerSets) checkQsetView(inner, depth + 1);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function byApplyIndex(a: StoredTx, b: StoredTx): number {
  return a.applyIndex - b.applyIndex;
}

interface LedgerScan {
  accounts: number;
  trustlines: number;
  offers: number;
  claimableBalances: number;
  assets: AssetStatView[];
}

// ---------------------------------------------------------------- the service

export class NodeService implements NodeApi {
  readonly node: Node;
  private readonly clock: Clock;
  private readonly resumeGapMs: number;
  private readonly listeners = new Set<(ev: NodeEvent) => void>();
  private readonly offs: (() => void)[] = [];
  private readonly statusOut: Coalescer;
  private readonly slotOut: Coalescer;
  private readonly peersOut: Coalescer;
  /** Highest slot with a change since the last 'slot' event. */
  private slotWanted = 0;
  private scanCache: { ledger: LedgerManager; hash: string; scan: LedgerScan } | null = null;
  private hiddenAt: number | null = null;
  private disposed = false;

  constructor(node: Node, opts: NodeServiceOptions) {
    this.node = node;
    this.clock = opts.clock;
    this.resumeGapMs = opts.resumeGapMs ?? PEER_TIMEOUT_MS;
    this.statusOut = new Coalescer(this.clock, opts.statusEveryMs ?? 500, () => this.fireStatus());
    this.slotOut = new Coalescer(this.clock, opts.slotEveryMs ?? 250, () => this.fireSlot());
    this.peersOut = new Coalescer(this.clock, opts.peersEveryMs ?? 1000, () => this.firePeers());
    this.attach();
  }

  // ------------------------------------------------------------ events

  private attach(): void {
    const ev = this.node.events;
    this.offs.push(
      ev.on('state', () => this.statusOut.request()),
      ev.on('ledgerClosed', (e) => {
        this.emit({ type: 'ledgerClosed', ledger: ledgerSummaryOf(e.stored, e.result.header), txs: e.txs.map(txSummaryOf) });
        this.statusOut.request();
      }),
      ev.on('scpEnvelope', (e) => this.emit({ type: 'scp', event: scpEventViewOf(e) })),
      ev.on('slot', (e) => {
        this.slotWanted = Math.max(this.slotWanted, e.slot);
        this.slotOut.request();
        this.statusOut.request();
      }),
      ev.on('peers', () => {
        this.peersOut.request();
        this.statusOut.request();
      }),
      ev.on('txStatus', (e) => {
        this.emit(txStatusEventOf(e));
        this.statusOut.request();
      }),
      ev.on('fork', (f) => this.emit({ type: 'fork', info: { ...f } })),
      ev.on('quorum', () => this.statusOut.request()),
      ev.on('catchup', () => this.statusOut.request()),
      ev.on('ledgerReset', () => {
        // node.ledger is a new object now: cached views are stale
        this.scanCache = null;
        this.slotWanted = 0;
        this.statusOut.request();
        this.slotOut.request();
      }),
      ev.on('log', (entry) => this.emit({ type: 'log', entry: { ...entry } })),
    );
  }

  private emit(ev: NodeEvent): void {
    if (this.disposed || this.listeners.size === 0) return;
    for (const fn of [...this.listeners]) {
      try {
        fn(ev);
      } catch {
        // one broken listener must not starve the others
      }
    }
  }

  private fireStatus(): void {
    if (this.listeners.size === 0) return;
    try {
      this.emit({ type: 'status', status: this.node.getStatus() });
    } catch {
      // the node is not running
    }
  }

  private fireSlot(): void {
    const wanted = this.slotWanted;
    this.slotWanted = 0;
    if (this.listeners.size === 0) return;
    try {
      const slot = (wanted > 0 ? this.node.getScpSlot(wanted) : null) ?? this.node.getScpSlot();
      if (slot) this.emit({ type: 'slot', slot });
    } catch {
      // the node is not running
    }
  }

  private firePeers(): void {
    if (this.listeners.size === 0) return;
    try {
      this.emit({ type: 'peers', peers: this.node.getPeers() });
    } catch {
      // the node is not running
    }
  }

  subscribe(listener: (ev: NodeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stop forwarding node events (the node itself keeps running). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    this.statusOut.cancel();
    this.slotOut.cancel();
    this.peersOut.cancel();
    this.listeners.clear();
  }

  // ------------------------------------------------------------ page lifecycle

  /**
   * Page lifecycle from the main thread. After a freeze, or a long hidden
   * period, the node re-checks sync before it votes again. 'pagehide' is
   * handled by the worker (bye, then stop).
   */
  lifecycle(event: LifecycleEvent): void {
    const now = this.clock.now();
    switch (event) {
      case 'hidden':
        this.hiddenAt = now;
        return;
      case 'visible': {
        const since = this.hiddenAt;
        this.hiddenAt = null;
        if (since !== null && now - since > this.resumeGapMs) {
          this.node.onResume(`visible again after ${Math.round((now - since) / 1000)} s hidden`);
        }
        return;
      }
      case 'freeze':
        // best effort: write queued ledgers before the page is frozen
        void this.node.chain.flush();
        return;
      case 'resume':
        this.node.onResume('page resumed after a freeze');
        return;
      case 'pageshow-persisted':
        this.node.onResume('page restored from the back/forward cache');
        return;
      case 'pagehide':
        return;
    }
  }

  // ------------------------------------------------------------ status and network

  private lclSeq(): number {
    return this.node.ledger.lastClosed().header.ledgerSeq;
  }

  async getStatus(): Promise<NodeStatus> {
    return this.node.getStatus();
  }

  async getPeers(): Promise<PeerView[]> {
    return this.node.getPeers();
  }

  async getValidators(): Promise<ValidatorView[]> {
    return this.node.getValidators();
  }

  async getQuorumConfig(): Promise<QuorumConfigView> {
    return this.node.getQuorumConfig();
  }

  /**
   * After a settings change the new status goes out at once: events and
   * results share one channel, so the UI sees it before the call resolves
   * (a mode switch with the same quorum set raises no node event).
   */
  private settingsChanged(): void {
    this.statusOut.now();
  }

  async setQuorumConfig(cfg: QuorumConfigInput): Promise<QuorumConfigView> {
    if (!cfg || (cfg.mode !== 'auto' && cfg.mode !== 'manual')) throw new Error('quorum mode must be "auto" or "manual"');
    if (cfg.mode === 'manual') checkQsetView(cfg.qset);
    const view = await this.node.setQuorumConfig(cfg.mode === 'auto' ? { mode: 'auto' } : { mode: 'manual', qset: cfg.qset });
    this.settingsChanged();
    return view;
  }

  async getScpSlot(slot?: number): Promise<ScpSlotView | null> {
    if (slot === undefined || slot === null) return this.node.getScpSlot();
    const n = Math.floor(Number(slot));
    return Number.isSafeInteger(n) && n > 0 ? this.node.getScpSlot(n) : null;
  }

  /** Newest first. */
  async getScpEvents(limit: number): Promise<ScpEventView[]> {
    const n = recentLimit(limit);
    // slice(-0) would return everything
    if (n === 0) return [];
    return this.node
      .getScpEvents(n)
      .map((e) => ({ ...e }))
      .reverse();
  }

  /** Newest first. */
  async getForks(): Promise<ForkInfo[]> {
    return this.node.getForks().reverse();
  }

  /** Newest first. */
  async getLogs(limit: number): Promise<LogEntry[]> {
    const n = recentLimit(limit);
    if (n === 0) return [];
    return this.node
      .getLogs(n)
      .map((e) => ({ ...e }))
      .reverse();
  }

  async setValidating(on: boolean): Promise<void> {
    await this.node.setValidating(on === true);
    this.settingsChanged();
  }

  async setName(name: string): Promise<void> {
    await this.node.setName(String(name ?? ''));
    this.settingsChanged();
  }

  async resync(): Promise<void> {
    await this.node.resync();
    this.settingsChanged();
  }

  // ------------------------------------------------------------ transactions

  async submitTransaction(envelopeXdr: string): Promise<SubmitResult> {
    if (typeof envelopeXdr !== 'string' || envelopeXdr.trim() === '') {
      return { hash: '', status: 'ERROR', errorResultCode: 'txMALFORMED', errorDetail: 'empty transaction envelope' };
    }
    try {
      return plainSubmitResult(await this.node.submitTransaction(envelopeXdr.trim()));
    } catch (err) {
      return { hash: '', status: 'ERROR', errorResultCode: 'txINTERNAL_ERROR', errorDetail: err instanceof Error ? err.message : String(err) };
    }
  }

  async friendbot(accountId: string): Promise<SubmitResult> {
    return plainSubmitResult(await this.node.friendbot(String(accountId ?? '').trim()));
  }

  // ------------------------------------------------------------ ledgers and history

  async getLedgers(opts: { limit: number; beforeSeq?: number }): Promise<LedgerSummary[]> {
    return (await this.storedLedgers(pageSize(opts?.limit), optionalSeq(opts?.beforeSeq))).map((l) => ledgerSummaryOf(l));
  }

  /** Newest first, seq < beforeSeq. Recent ledgers come from memory (they may not be written yet). */
  private async storedLedgers(limit: number, beforeSeq?: number): Promise<StoredLedger[]> {
    const lcl = this.lclSeq();
    const top = Math.min(lcl, beforeSeq !== undefined ? beforeSeq - 1 : lcl);
    if (limit === 0 || top < 1) return [];
    const chain = this.node.chain;
    const out = new Map<number, StoredLedger>();
    for (let s = top; s >= 1 && out.size < limit; s--) {
      const r = chain.recentLedger(s);
      if (!r) break;
      out.set(s, r);
    }
    if (out.size < limit) {
      const below = out.size > 0 ? Math.min(...out.keys()) : top + 1;
      for (const r of await this.node.storage.getLatestLedgers(limit - out.size, below)) {
        if (!out.has(r.seq)) out.set(r.seq, r);
      }
    }
    return [...out.values()].sort((a, b) => b.seq - a.seq).slice(0, limit);
  }

  async getLedger(seq: number): Promise<LedgerDetail | null> {
    const s = Math.floor(Number(seq));
    if (!Number.isSafeInteger(s) || s < 1 || s > this.lclSeq()) return null;
    const chain = this.node.chain;
    const stored = await chain.getLedger(s);
    if (!stored) return null;
    let txs = await this.node.storage.getTxsByLedger(s);
    if (txs.length < stored.txCount) {
      // closed a moment ago: its txs are still in the write queue
      await chain.flush();
      txs = await this.node.storage.getTxsByLedger(s);
    }
    const header = decodeLedgerHeader(stored.headerXdr);
    return {
      ...ledgerSummaryOf(stored, header),
      headerXdr: stored.headerXdr,
      header: headerFields(header),
      txs: [...txs].sort(byApplyIndex).map(txSummaryOf),
    };
  }

  async getTransaction(hash: string): Promise<TxDetail | null> {
    const h = String(hash ?? '')
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) return null;
    let tx = await this.node.storage.getTx(h);
    if (!tx) {
      await this.node.chain.flush();
      tx = await this.node.storage.getTx(h);
    }
    if (!tx || tx.ledgerSeq > this.lclSeq()) return null;
    return { ...txSummaryOf(tx), envelopeXdr: tx.envelopeXdr, resultXdr: tx.resultXdr, signatures: signaturesOf(tx.envelopeXdr) };
  }

  async getTransactions(opts: { limit: number; account?: string; beforeLedger?: number }): Promise<TxSummary[]> {
    const limit = pageSize(opts?.limit);
    if (limit === 0) return [];
    const before = optionalSeq(opts?.beforeLedger);
    const account = opts?.account;
    const storage = this.node.storage;
    let rows: StoredTx[];
    if (account !== undefined && account !== null && account !== '') {
      if (typeof account !== 'string' || !StrKey.isValidEd25519PublicKey(account)) return [];
      rows = await storage.getTxsByAccount(account, limit, before);
    } else {
      rows = await storage.getLatestTxs(limit, before);
    }
    const lcl = this.lclSeq();
    return rows.filter((t) => t.ledgerSeq <= lcl).map(txSummaryOf);
  }

  // ------------------------------------------------------------ ledger state

  async getAccount(accountId: string): Promise<AccountView | null> {
    const id = typeof accountId === 'string' ? accountId.trim() : '';
    if (!StrKey.isValidEd25519PublicKey(id)) return null;
    const lm = this.node.ledger;
    const acc = lm.getAccount(id);
    if (!acc) return null;
    const header = lm.lastClosed().header;
    const min = lm.minBalance(acc);
    const available = accountAvailableBalance(header, acc);
    const balances: AccountView['balances'] = [
      {
        asset: { type: 'native', code: 'XLM' },
        balance: formatAmount(acc.balance),
        limit: null,
        buyingLiabilities: formatAmount(acc.buyingLiabilities),
        sellingLiabilities: formatAmount(acc.sellingLiabilities),
        authorized: true,
        authorizedToMaintainLiabilities: true,
        clawbackEnabled: false,
      },
    ];
    for (const tl of lm.getTrustLines(id)) {
      balances.push({
        asset: assetViewOf(tl.asset),
        balance: formatAmount(tl.balance),
        limit: formatAmount(tl.limit),
        buyingLiabilities: formatAmount(tl.buyingLiabilities),
        sellingLiabilities: formatAmount(tl.sellingLiabilities),
        authorized: isAuthorized(tl),
        authorizedToMaintainLiabilities: isAuthorizedToMaintainLiabilities(tl),
        clawbackEnabled: isClawbackEnabledOnTrustline(tl),
      });
    }
    const claimable = new Map<string, ClaimableBalanceEntry>();
    for (const c of [...lm.getClaimableBalances({ claimant: id }), ...lm.getClaimableBalances({ sponsor: id })]) claimable.set(c.balanceId, c);
    return {
      accountId: id,
      sequence: acc.seqNum.toString(),
      numSubEntries: acc.numSubEntries,
      minBalance: formatAmount(min),
      availableBalance: formatAmount(available > 0n ? available : 0n),
      flags: {
        authRequired: (acc.flags & AUTH_REQUIRED_FLAG) !== 0,
        authRevocable: (acc.flags & AUTH_REVOCABLE_FLAG) !== 0,
        authImmutable: (acc.flags & AUTH_IMMUTABLE_FLAG) !== 0,
        authClawbackEnabled: (acc.flags & AUTH_CLAWBACK_ENABLED_FLAG) !== 0,
      },
      thresholds: { masterWeight: acc.thresholds.master, low: acc.thresholds.low, med: acc.thresholds.med, high: acc.thresholds.high },
      // the master key first (as Horizon lists it), then the extra signers
      signers: [{ key: id, weight: acc.thresholds.master }, ...acc.signers.map((s) => ({ key: s.key, weight: s.weight }))],
      homeDomain: acc.homeDomain,
      balances,
      offers: lm.getOffersByAccount(id).map(offerView),
      data: lm.getDataEntries(id).map((d) => ({ name: d.name, valueBase64: d.value, valueText: dataText(d.value) })),
      claimableBalances: [...claimable.values()].sort((a, b) => (a.balanceId < b.balanceId ? -1 : 1)).map(claimableView),
      lastModifiedLedger: acc.lastModifiedLedgerSeq,
    };
  }

  async getOrderBook(selling: AssetView, buying: AssetView, limit = 20): Promise<OrderBookView> {
    const n = pageSize(limit, 20);
    const s = assetFromView(selling);
    const b = assetFromView(buying);
    const lm = this.node.ledger;
    return {
      selling: assetViewOf(s),
      buying: assetViewOf(b),
      bids: priceLevels(lm.getOrderBook(b, s, BOOK_DEPTH), true).slice(0, n).map(levelView),
      asks: priceLevels(lm.getOrderBook(s, b, BOOK_DEPTH)).slice(0, n).map(levelView),
    };
  }

  async getAssets(): Promise<AssetStatView[]> {
    return this.scan().assets.map((a) => ({ ...a, asset: { ...a.asset }, issuerFlags: { ...a.issuerFlags } }));
  }

  async getStats(): Promise<NetworkStats> {
    const scan = this.scan();
    const recent = (await this.storedLedgers(21)).filter((l) => l.seq > 1);
    let intervals = this.node.getCloseIntervals();
    if (intervals.length === 0) {
      // nothing closed here yet: use the network's close times
      intervals = [];
      for (let i = recent.length - 1; i > 0; i--) intervals.push((recent[i - 1].closeTime - recent[i].closeTime) * 1000);
    }
    const last20 = recent.slice(0, 20);
    return {
      ledgersClosedHere: this.node.getLedgersClosedHere(),
      avgCloseIntervalMs: Math.round(mean(intervals)),
      recentCloseIntervalsMs: intervals,
      txPerLedger: mean(last20.map((l) => l.txCount)),
      opsPerLedger: mean(last20.map((l) => l.opCount)),
      totalAccounts: scan.accounts,
      totalTrustlines: scan.trustlines,
      totalOffers: scan.offers,
      totalClaimableBalances: scan.claimableBalances,
    };
  }

  /** Entry counts and asset statistics of the current ledger (cached per ledger hash). */
  private scan(): LedgerScan {
    const lm = this.node.ledger;
    const hash = lm.lastClosed().hash;
    const cached = this.scanCache;
    if (cached && cached.ledger === lm && cached.hash === hash) return cached.scan;
    let accounts = 0;
    let trustlines = 0;
    let offers = 0;
    let claimableBalances = 0;
    const stats = new Map<string, { asset: CreditAsset; holders: number; supply: bigint }>();
    const stat = (a: CreditAsset) => {
      const key = `${a.code}:${a.issuer}`;
      let s = stats.get(key);
      if (!s) stats.set(key, (s = { asset: a, holders: 0, supply: 0n }));
      return s;
    };
    for (const e of lm.allEntries()) {
      switch (e.kind) {
        case 'account':
          accounts++;
          break;
        case 'trustline': {
          trustlines++;
          const s = stat(e.asset);
          // holders like Horizon's num_accounts: authorized trust lines
          if (isAuthorized(e)) s.holders++;
          s.supply += e.balance;
          break;
        }
        case 'offer':
          offers++;
          break;
        case 'claimableBalance':
          claimableBalances++;
          if (e.asset.type !== 'native') stat(e.asset).supply += e.amount;
          break;
        default:
          break;
      }
    }
    const assets: AssetStatView[] = [...stats.values()]
      .map((s) => {
        const flags = lm.getAccount(s.asset.issuer)?.flags ?? 0;
        return {
          asset: assetViewOf(s.asset),
          holders: s.holders,
          supply: formatAmount(s.supply),
          issuerFlags: {
            authRequired: (flags & AUTH_REQUIRED_FLAG) !== 0,
            authRevocable: (flags & AUTH_REVOCABLE_FLAG) !== 0,
            authClawbackEnabled: (flags & AUTH_CLAWBACK_ENABLED_FLAG) !== 0,
          },
        };
      })
      .sort(
        (a, b) =>
          b.holders - a.holders ||
          (a.asset.code < b.asset.code ? -1 : a.asset.code > b.asset.code ? 1 : 0) ||
          ((a.asset.issuer ?? '') < (b.asset.issuer ?? '') ? -1 : 1),
      );
    const scan = { accounts, trustlines, offers, claimableBalances, assets };
    this.scanCache = { ledger: lm, hash, scan };
    return scan;
  }
}
