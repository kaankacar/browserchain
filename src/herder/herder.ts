// Ported from stellar-core (Apache-2.0): src/herder/HerderImpl.cpp (simplified)
//
// The herder glues SCP, the ledger, the overlay and the tx queue
// (ARCHITECTURE 10): it triggers nomination for LCL+1, feeds signature
// checked envelopes to SCP once their quorum sets and tx sets are known,
// closes the ledger when SCP externalizes, re-floods our latest envelopes and
// applies the quorum policy. Persistence and catch-up belong to the owner
// (HerderHost), which calls afterLedgerClosed() for every closed ledger.

import type { Keypair } from '@stellar/stellar-sdk/base';
import { xdr } from '@stellar/stellar-sdk/base';
import type { Clock, TimerHandle } from '../lib/clock';
import { LEDGER_TARGET_CLOSE_MS, LEDGER_VALIDITY_BRACKET, MAX_FRIENDBOT_TXS_IN_TX_SET, MAX_SLOTS_TO_REMEMBER } from '../lib/constants';
import { Emitter } from '../lib/events';
import type { Logger } from '../lib/log';
import type { Rng } from '../lib/random';
import { usesChannel } from '../ledger/channelPolicy';
import { friendbotChannelIds } from '../ledger/genesis';
import { tryDecodeTransaction } from '../ledger/tx';
import { encodeStellarValue, makeSignedStellarValue } from '../ledger/value';
import type { ILedgerManager, LedgerCloseResult } from '../ledger/types';
import type { SubmitResult } from '../node/api';
import {
  makeDontHaveMessage,
  makeScpMessage,
  makeScpQuorumSetMessage,
  makeTransactionMessage,
  makeTxSetMessage,
  tryParseStellarMessage,
} from '../overlay/stellarMessage';
import type { PeerInfo } from '../overlay/types';
import { isVBlocking, qsetNodes } from '../scp/quorum';
import { SCP, isWellFormedEnvelope } from '../scp/scp';
import { EnvelopeState } from '../scp/types';
import type { Envelope, Hash, NodeId, QuorumSet, Value } from '../scp/types';
import { envelopeFromXdr, envelopeToBase64, envelopeToXdr, qsetFromXdr, qsetToBase64, qsetToXdr } from '../scp/xdr';
import { PendingEnvelopes, type CachedTxSet } from './pendingEnvelopes';
import { autoQuorumSet, type QuorumManager } from './quorumManager';
import { HerderSCPDriver } from './scpDriver';
import { TxQueue, type QueueDrop } from './txQueue';
import type { CloseMeta, HerderEvents, HerderHost, HerderNet } from './types';
import { decodeValue, envelopeKeyFromBase64, statementValues, verifyEnvelopeCached } from './values';

export interface HerderTuning {
  /** Target interval between triggers (LEDGER_TARGET_CLOSE_MS). */
  triggerIntervalMs: number;
  /** Delay of the first trigger after becoming synced. */
  firstTriggerDelayMs: number;
  /** Re-flood our latest envelopes this often. */
  rebroadcastMs: number;
  /** How often the quorum policy is checked. */
  quorumCheckMs: number;
  /** A slot without progress for this long lets departures take effect. */
  departureStallMs: number;
  /** Minimum gap between "we are behind" notifications. */
  behindNotifyMs: number;
  /** Max envelopes in an scpState answer. */
  maxScpStateEnvelopes: number;
}

export const DEFAULT_HERDER_TUNING: HerderTuning = {
  triggerIntervalMs: LEDGER_TARGET_CLOSE_MS,
  firstTriggerDelayMs: 1000,
  rebroadcastMs: 2000,
  quorumCheckMs: 1000,
  departureStallMs: 4000,
  behindNotifyMs: 2000,
  maxScpStateEnvelopes: 256,
};

/** What an emit interceptor (test hook) may do instead of the normal flood. */
export interface EmitApi {
  readonly nodeId: NodeId;
  readonly keypair: Keypair;
  readonly networkId: Uint8Array;
  /** Connected peer node ids. */
  peers(): NodeId[];
  flood(env: Envelope): void;
  send(nodeId: NodeId, env: Envelope): void;
  ledger(): ILedgerManager;
  getTxSet(hash: Hash): CachedTxSet | undefined;
}

/** Test hook: return true when the emitted envelope was handled. */
export type EmitInterceptor = (env: Envelope, api: EmitApi) => boolean;

/** Our latest SCP envelopes for the open slot, kept across restarts (base64 XDR). */
export interface PersistedScpState {
  slot: number;
  envelopes: string[];
  /** Tx sets of the values in those envelopes. */
  txSets: string[];
  /** Our quorum set when they were emitted. */
  qset: string;
}

export interface HerderOptions {
  keypair: Keypair;
  clock: Clock;
  logger: Logger;
  net: HerderNet;
  host: HerderHost;
  quorum: QuorumManager;
  rng: Rng;
  validating?: boolean;
  tuning?: Partial<HerderTuning>;
  emitInterceptor?: EmitInterceptor;
  /** Friendbot channels this node makes its own requests on (TxQueueOptions.ownChannels). Default: every channel. */
  ownFriendbotChannels?: () => ReadonlySet<string>;
}

interface Nominated {
  txSetHash: Hash;
  closeTime: number;
  value: Value;
}

export class Herder {
  readonly nodeId: NodeId;
  readonly keypair: Keypair;
  readonly networkId: Uint8Array;
  readonly events = new Emitter<HerderEvents>();
  readonly txQueue: TxQueue;
  readonly pending: PendingEnvelopes;
  readonly driver: HerderSCPDriver;
  readonly tuning: HerderTuning;
  private scpInstance: SCP;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly net: HerderNet;
  private readonly host: HerderHost;
  private readonly quorum: QuorumManager;
  private readonly emitInterceptor: EmitInterceptor | undefined;

  private synced = false;
  private validating: boolean;
  private running = false;
  private stopped = false;
  private triggerTimer: TimerHandle | null = null;
  private triggerSlot = 0;
  private rebroadcastTimer: TimerHandle | null = null;
  private quorumTimer: TimerHandle | null = null;
  private lastTriggerAt: number | null = null;
  private readonly nominated = new Map<number, Nominated>();
  private readonly slotStartedAt = new Map<number, number>();
  private readonly slotExternalizedAt = new Map<number, number>();
  private readonly closing = new Set<number>();
  private slotProgressAt = 0;
  private readonly futureSenders = new Map<number, Set<NodeId>>();
  private lastBehindAt = -Infinity;

  constructor(opts: HerderOptions) {
    this.keypair = opts.keypair;
    this.nodeId = opts.keypair.publicKey();
    this.clock = opts.clock;
    this.log = opts.logger;
    this.net = opts.net;
    this.host = opts.host;
    this.quorum = opts.quorum;
    this.validating = opts.validating ?? true;
    this.tuning = { ...DEFAULT_HERDER_TUNING, ...opts.tuning };
    this.emitInterceptor = opts.emitInterceptor;
    this.networkId = this.host.ledger().networkId;
    this.quorum.setValidating(this.validating);

    this.txQueue = new TxQueue({ ledger: () => this.host.ledger(), now: () => this.clock.now(), ownChannels: opts.ownFriendbotChannels });
    this.pending = new PendingEnvelopes({
      clock: this.clock,
      logger: this.log,
      rng: opts.rng,
      net: this.net,
      networkId: this.networkId,
      lcl: () => {
        const l = this.host.ledger().lastClosed();
        return { seq: l.header.ledgerSeq, hash: l.hash };
      },
      canProcess: (slot) => this.synced && !this.stopped && slot <= this.lclSeq() + 1,
      process: (env, from) => this.process(env, from),
      onBuffered: (env) => this.onBuffered(env),
    });
    this.driver = new HerderSCPDriver({
      keypair: this.keypair,
      networkId: this.networkId,
      clock: this.clock,
      logger: this.log,
      ledger: () => this.host.ledger(),
      getQSet: (h) => this.pending.getQSet(h),
      getTxSet: (h) => this.pending.getTxSet(h),
      emitEnvelope: (env) => this.onEmit(env),
      valueExternalized: (slot, value) => this.onValueExternalized(slot, value),
      progress: (slot, what) => this.onProgress(slot, what),
      nodeName: (id) => this.host.nodeName(id),
    });
    const qset = this.quorum.desiredQSet();
    this.scpInstance = new SCP(this.driver, this.nodeId, this.validating, qset);
    this.pending.pinQSet(this.scpInstance.getLocalQuorumSet());
  }

  /** The SCP instance (replaced on ledger resets). */
  get scp(): SCP {
    return this.scpInstance;
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.scheduleRebroadcast();
    this.scheduleQuorumCheck();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.synced = false;
    for (const t of [this.triggerTimer, this.rebroadcastTimer, this.quorumTimer]) {
      if (t !== null) this.clock.clearTimeout(t);
    }
    this.triggerTimer = this.rebroadcastTimer = this.quorumTimer = null;
    this.driver.cancelAllTimers();
    this.pending.stop();
  }

  isSynced(): boolean {
    return this.synced;
  }

  /**
   * synced: feed envelopes for LCL+1 to SCP and nominate. Not synced (booting
   * or catching up): buffer envelopes, stop SCP timers, never nominate.
   */
  setSynced(on: boolean): void {
    if (this.stopped || on === this.synced) return;
    this.synced = on;
    if (on) {
      const lcl = this.lclSeq();
      // slots we did not follow while catching up are stale
      this.scp.purgeSlots(lcl + 1);
      this.slotProgressAt = this.clock.now();
      // SCP externalized LCL+1 just before we paused: its close was skipped,
      // and the trigger skips an externalized slot. Close it now.
      const done = this.scp.getExternalizedValue(lcl + 1);
      if (done !== null) this.scheduleClose(lcl + 1, done);
      this.applySlotBoundaryQuorum();
      this.pending.pump();
      this.scheduleTrigger(true);
    } else {
      this.cancelTrigger();
      this.driver.cancelAllTimers();
    }
  }

  isValidating(): boolean {
    return this.validating;
  }

  setValidating(on: boolean): void {
    if (on === this.validating) return;
    this.validating = on;
    this.quorum.setValidating(on);
    this.scp.setValidator(on);
    if (on) this.scheduleTrigger(false);
    else this.cancelTrigger();
  }

  /** The ledger was replaced (rollback, resync, snapshot): restart consensus state. */
  onLedgerReset(): void {
    this.cancelTrigger();
    this.driver.cancelAllTimers();
    const qset = this.scp.getLocalQuorumSet();
    this.scpInstance = new SCP(this.driver, this.nodeId, this.validating, qset);
    this.pending.reset();
    this.nominated.clear();
    this.slotStartedAt.clear();
    this.slotExternalizedAt.clear();
    this.closing.clear();
    this.futureSenders.clear();
    this.lastTriggerAt = null;
    this.txQueue.forgetHistory();
    for (const d of this.txQueue.revalidate()) this.emitDropped(d);
  }

  // ------------------------------------------------------------ messages

  /** A StellarMessage from a peer. Returns false to stop the overlay re-flood. */
  onStellarMessage(xdrB64: string, from: PeerInfo): boolean {
    if (this.stopped) return false;
    const msg = tryParseStellarMessage(xdrB64);
    if (!msg) return false;
    switch (msg.kind) {
      case 'scpMessage':
        return this.onScpEnvelope(msg.envelope, msg.envelopeXdr, from.nodeId);
      case 'transaction':
        return this.onTransaction(msg.envelopeXdr);
      case 'txSet':
        return this.onTxSet(msg.txSetXdr);
      case 'getTxSet':
        this.answerTxSet(msg.hash, from.nodeId);
        return false;
      case 'scpQuorumset':
        this.onQSet(msg.qset);
        return false;
      case 'getScpQuorumset':
        this.answerQSet(msg.hash, from.nodeId);
        return false;
      case 'dontHave':
        this.pending.onDontHave(msg.itemType === 'txSet' ? 'txSet' : 'qset', msg.hash, from.nodeId);
        return false;
    }
  }

  private onScpEnvelope(x: xdr.ScpEnvelope, b64: string, from: NodeId | null): boolean {
    let env: Envelope;
    try {
      env = envelopeFromXdr(x);
    } catch {
      return false;
    }
    return this.receiveEnvelope(env, b64, from);
  }

  /**
   * Checks and queues an envelope (ARCHITECTURE 10.4). Returns true when it
   * is new and valid enough to be re-flooded.
   */
  receiveEnvelope(env: Envelope, b64: string, from: NodeId | null): boolean {
    if (this.stopped || !isWellFormedEnvelope(env)) return false;
    const st = env.statement;
    if (st.nodeId === this.nodeId) return false;
    const lcl = this.lclSeq();
    const slot = st.slotIndex;
    if (slot + MAX_SLOTS_TO_REMEMBER < lcl || slot > lcl + LEDGER_VALIDITY_BRACKET) return false;
    const key = envelopeKeyFromBase64(b64);
    if (this.pending.isSeen(slot, key)) return false;
    if (!verifyEnvelopeCached(this.networkId, env, key)) {
      this.log.debug(`dropped envelope with a bad signature (claims ${st.nodeId.slice(0, 8)})`);
      return false;
    }
    // an envelope for LCL-1 still shows that a slow peer votes (auto quorum participation)
    if (slot >= lcl - 1) this.quorum.noteEnvelope(st.nodeId, slot);
    if (st.pledges.type !== 'externalize') this.quorum.noteQSetHash(st.nodeId, st.pledges.quorumSetHash);
    this.events.emit('envelope', {
      direction: 'in',
      ts: this.clock.now(),
      slot,
      nodeId: st.nodeId,
      name: this.host.nodeName(st.nodeId),
      type: st.pledges.type,
      envelope: env,
      via: from,
    });
    const status = this.pending.receive(env, key, from);
    return status !== 'discarded' && status !== 'duplicate';
  }

  /** Envelopes from an scpState answer (base64 xdr.ScpEnvelope). */
  ingestScpState(envelopes: string[], from: NodeId): number {
    let n = 0;
    for (const b64 of envelopes) {
      if (this.stopped) break;
      let env: Envelope;
      try {
        env = envelopeFromXdr(b64);
      } catch {
        continue;
      }
      if (this.receiveEnvelope(env, b64, from)) n++;
    }
    return n;
  }

  /** Ask peers for their latest SCP state from LCL+1 on. */
  async requestScpState(peers: NodeId[], fromSlot = this.lclSeq() + 1): Promise<number> {
    let total = 0;
    for (const peer of peers) {
      if (this.stopped) break;
      try {
        const res = await this.net.request(peer, { kind: 'scpState', fromSlot });
        if (res.kind === 'scpState') total += this.ingestScpState(res.envelopes, peer);
      } catch (err) {
        this.log.debug(`scpState from ${peer.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return total;
  }

  /** Answer for the scpState request: latest envelopes of every node for slots >= fromSlot. */
  answerScpState(fromSlot: number): string[] {
    const out: string[] = [];
    for (const slot of this.scp.getKnownSlots()) {
      if (slot < fromSlot) continue;
      for (const env of this.scp.getCurrentState(slot)) {
        if (out.length >= this.tuning.maxScpStateEnvelopes) return out;
        out.push(envelopeToBase64(env));
      }
    }
    return out;
  }

  private onTransaction(envelopeXdr: string): boolean {
    const res = this.txQueue.tryAdd(envelopeXdr, { fromSelf: false });
    if (res.status !== 'PENDING') return false;
    this.events.emit('txStatus', { hash: res.hash, status: 'pending' });
    if (res.replaced) this.events.emit('txStatus', { hash: res.replaced.hash, status: 'dropped', resultCode: 'replaced' });
    return true;
  }

  private onTxSet(txSetXdr: string): boolean {
    let info;
    try {
      info = this.host.ledger().decodeTxSet(txSetXdr);
    } catch {
      return false;
    }
    return this.pending.addTxSet(info);
  }

  private answerTxSet(hash: Hash, peer: NodeId): void {
    const c = this.pending.getTxSet(hash);
    this.net.sendStellar(peer, c ? makeTxSetMessage(c.info.xdr) : makeDontHaveMessage('txSet', hash));
  }

  private onQSet(q: xdr.ScpQuorumSet): void {
    try {
      this.pending.addQSet(qsetFromXdr(q));
    } catch {
      /* malformed */
    }
  }

  private answerQSet(hash: Hash, peer: NodeId): void {
    const q = this.getQSet(hash);
    this.net.sendStellar(peer, q ? makeScpQuorumSetMessage(qsetToXdr(q)) : makeDontHaveMessage('scpQuorumset', hash));
  }

  /** A newly connected peer gets our latest envelopes (ARCHITECTURE 10.4.6). */
  onPeerConnected(peer: PeerInfo): void {
    if (this.stopped || !this.synced) return;
    const lcl = this.lclSeq();
    for (const slot of [lcl, lcl + 1]) {
      for (const env of this.scp.getLatestMessagesSend(slot)) {
        this.net.sendStellar(peer.nodeId, makeScpMessage(envelopeToXdr(env)));
      }
    }
  }

  // ------------------------------------------------------------ transactions

  /** Submit a transaction from this node (UI, friendbot). Floods it when accepted. */
  submitTransaction(envelopeXdr: string): SubmitResult {
    const res = this.txQueue.tryAdd(envelopeXdr, { fromSelf: true });
    if (res.status === 'PENDING' || (res.status === 'DUPLICATE' && this.txQueue.has(res.hash))) {
      const queued = this.txQueue.get(res.hash);
      if (queued) this.net.floodStellar(makeTransactionMessage(queued.envelopeXdr));
    }
    if (res.status === 'PENDING') {
      this.events.emit('txStatus', { hash: res.hash, status: 'pending' });
      if (res.replaced) {
        this.events.emit('txStatus', { hash: res.replaced.hash, status: 'dropped', resultCode: 'replaced' });
      }
    }
    const out: SubmitResult = { hash: res.hash, status: res.status };
    if (res.status === 'ERROR') out.errorResultCode = res.code ?? 'txFAILED';
    if (res.detail) out.errorDetail = res.detail;
    return out;
  }

  // ------------------------------------------------------------ SCP plumbing

  private process(env: Envelope, _from: NodeId | null): void {
    const slot = env.statement.slotIndex;
    if (env.statement.pledges.type === 'nominate' && this.buildsOnOtherLedger(env)) {
      // A nomination from another branch: SCP would keep it as the node's
      // latest statement (nominations are recorded even with invalid values)
      // and then ignore that node's nominations on our branch for this slot.
      this.log.debug(`ignored a nomination for slot ${slot} from another branch (${env.statement.nodeId.slice(0, 8)})`);
      return;
    }
    let res: EnvelopeState;
    try {
      res = this.scp.receiveEnvelope(env);
    } catch (err) {
      this.log.error(`SCP failed on an envelope for slot ${slot}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (res === EnvelopeState.VALID) {
      if (!this.slotStartedAt.has(slot)) this.slotStartedAt.set(slot, this.clock.now());
      this.events.emit('slot', { slot });
    }
  }

  /** True when a value of the statement (slot LCL+1) has a tx set that does not build on our LCL. */
  private buildsOnOtherLedger(env: Envelope): boolean {
    const lcl = this.host.ledger().lastClosed();
    if (env.statement.slotIndex !== lcl.header.ledgerSeq + 1) return false;
    for (const v of statementValues(env.statement)) {
      const info = decodeValue(v);
      const c = info ? this.pending.getTxSet(info.txSetHash) : undefined;
      if (c && c.info.previousLedgerHash !== lcl.hash) return true;
    }
    return false;
  }

  private onEmit(env: Envelope): void {
    if (this.stopped) return;
    const st = env.statement;
    if (!this.slotStartedAt.has(st.slotIndex)) this.slotStartedAt.set(st.slotIndex, this.clock.now());
    this.events.emit('envelope', {
      direction: 'out',
      ts: this.clock.now(),
      slot: st.slotIndex,
      nodeId: this.nodeId,
      name: this.host.nodeName(this.nodeId),
      type: st.pledges.type,
      envelope: env,
      via: null,
    });
    if (this.emitInterceptor && this.emitInterceptor(env, this.emitApi())) return;
    this.net.floodStellar(makeScpMessage(envelopeToXdr(env)));
  }

  private emitApi(): EmitApi {
    return {
      nodeId: this.nodeId,
      keypair: this.keypair,
      networkId: this.networkId,
      peers: () => this.net.peers().map((p) => p.nodeId),
      flood: (e) => this.net.floodStellar(makeScpMessage(envelopeToXdr(e))),
      send: (id, e) => this.net.sendStellar(id, makeScpMessage(envelopeToXdr(e))),
      ledger: () => this.host.ledger(),
      getTxSet: (h) => this.pending.getTxSet(h),
    };
  }

  private onProgress(slot: number, _what: string): void {
    if (slot === this.lclSeq() + 1) this.slotProgressAt = this.clock.now();
    this.events.emit('slot', { slot });
  }

  /** Our own quorum sets, then the cache. */
  getQSet(hash: Hash): QuorumSet | null {
    if (hash === this.scp.getLocalQuorumSetHash()) return this.scp.getLocalQuorumSet();
    return this.pending.getQSet(hash);
  }

  private onBuffered(env: Envelope): void {
    // ARCHITECTURE 10.4.4: validators working on later slots mean we are behind
    if (!this.synced) return;
    const slot = env.statement.slotIndex;
    const lcl = this.lclSeq();
    if (slot <= lcl + 1) return;
    let s = this.futureSenders.get(slot);
    if (!s) {
      s = new Set();
      this.futureSenders.set(slot, s);
    }
    s.add(env.statement.nodeId);
    const nodes = new Set<NodeId>();
    let maxSlot = 0;
    for (const [k, set] of this.futureSenders) {
      if (k <= lcl + 1) continue;
      for (const id of set) nodes.add(id);
      maxSlot = Math.max(maxSlot, k);
    }
    const now = this.clock.now();
    if (now - this.lastBehindAt < this.tuning.behindNotifyMs) return;
    if (nodes.size >= 2 || isVBlocking(this.scp.getLocalQuorumSet(), nodes)) {
      this.lastBehindAt = now;
      this.host.behind({ slot: maxSlot, nodes: [...nodes] });
    }
  }

  // ------------------------------------------------------------ trigger

  private scheduleTrigger(first: boolean): void {
    this.cancelTrigger();
    if (!this.synced || !this.validating || this.stopped) return;
    const now = this.clock.now();
    let at: number;
    if (this.lastTriggerAt === null) at = now + (first ? this.tuning.firstTriggerDelayMs : 0);
    else at = Math.max(now, this.lastTriggerAt + this.tuning.triggerIntervalMs);
    const slot = this.lclSeq() + 1;
    this.triggerSlot = slot;
    this.triggerTimer = this.clock.setTimeout(() => {
      this.triggerTimer = null;
      this.triggerNextLedger(slot);
    }, at - now);
  }

  private cancelTrigger(): void {
    if (this.triggerTimer !== null) this.clock.clearTimeout(this.triggerTimer);
    this.triggerTimer = null;
  }

  /** Slot the pending trigger is for, or null. */
  scheduledTrigger(): number | null {
    return this.triggerTimer !== null ? this.triggerSlot : null;
  }

  /** HerderImpl::triggerNextLedger (ARCHITECTURE 10.3). */
  triggerNextLedger(slot: number): void {
    if (!this.synced || !this.validating || this.stopped) return;
    const lm = this.host.ledger();
    const lcl = lm.lastClosed();
    if (slot !== lcl.header.ledgerSeq + 1) return;
    if (this.scp.getExternalizedValue(slot) !== null) return;
    this.applySlotBoundaryQuorum();

    const now = this.clock.now();
    const closeTime = Math.max(Math.floor(now / 1000), lcl.header.scpValue.closeTime + 1);
    const queued = this.txQueue.envelopes();
    let valid: string[] = [];
    if (queued.length > 0) {
      const trimmed = lm.trimInvalid(queued, closeTime);
      valid = trimmed.valid;
      for (const d of this.txQueue.dropEnvelopes(trimmed.invalid, 'txINVALID')) this.emitDropped(d);
      valid = this.ownChannelTxsFirst(lm, valid, closeTime);
    }
    const txSet = lm.makeTxSet(lcl.hash, valid);
    this.pending.addTxSet(txSet, { slot, force: true });
    this.net.floodStellar(makeTxSetMessage(txSet.xdr));

    const value = encodeStellarValue(makeSignedStellarValue(this.networkId, this.keypair, txSet.hash, closeTime));
    this.nominated.set(slot, { txSetHash: txSet.hash, closeTime, value });
    this.lastTriggerAt = now;
    if (!this.slotStartedAt.has(slot)) this.slotStartedAt.set(slot, now);
    this.slotProgressAt = now;
    this.log.debug(`nominating ${txSet.txs.length} txs for ledger ${slot}`);
    try {
      this.scp.nominate(slot, value, encodeStellarValue(lcl.header.scpValue));
    } catch (err) {
      this.log.error(`nominate failed for slot ${slot}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.events.emit('slot', { slot });
  }

  /**
   * ARCHITECTURE 7.5, 10.3: the friendbot lane holds MAX_FRIENDBOT_TXS_IN_TX_SET
   * channel txs and takes the lowest envelope hashes among the account heads.
   * The channel keys are public, so anyone can fill it every ledger. When this
   * node builds its tx set, its own queued channel txs (friendbot requests made
   * here) come first, the cheapest in lane slots first, together with the txs
   * of their account that must go before them; the rest of the lane follows the
   * deterministic rule. `valid` is trimInvalid's choice from the queue. Peers
   * check the set like any other: it is valid whatever we preferred.
   */
  private ownChannelTxsFirst(lm: ILedgerManager, valid: string[], closeTime: number): string[] {
    const chosen = new Set(valid);
    const queued = this.txQueue.all();
    // cheap check first: every tx submitted here is in already
    if (!queued.some((q) => q.fromSelf && !chosen.has(q.envelopeXdr))) return valid;
    const channels = friendbotChannelIds(lm.networkPassphrase);
    const chains = new Map<string, { txs: { env: string; own: boolean; lane: boolean; hash: string }[]; pos: number }>();
    let left = false;
    for (const q of queued) {
      const tx = tryDecodeTransaction(q.envelopeXdr, lm.networkId);
      if (!tx) continue;
      const lane = usesChannel(tx, channels);
      const own = q.fromSelf && lane;
      if (own && !chosen.has(q.envelopeXdr)) left = true;
      let c = chains.get(q.sourceAccount);
      if (!c) chains.set(q.sourceAccount, (c = { txs: [], pos: 0 }));
      c.txs.push({ env: q.envelopeXdr, own, lane, hash: tx.fullHashHex });
    }
    // our own requests are all in already: nothing to prefer
    if (!left) return valid;
    let room = MAX_FRIENDBOT_TXS_IN_TX_SET;
    // 1. our own channel txs: each takes the lane slots of its account's txs up to it
    for (;;) {
      let best: { c: { txs: { hash: string }[]; pos: number }; end: number; cost: number; hash: string } | null = null;
      for (const c of chains.values()) {
        let cost = 0;
        for (let j = c.pos; j < c.txs.length; j++) {
          if (c.txs[j].lane) cost++;
          if (!c.txs[j].own) continue;
          if (cost <= room && (!best || cost < best.cost || (cost === best.cost && c.txs[j].hash < best.hash))) {
            best = { c, end: j + 1, cost, hash: c.txs[j].hash };
          }
          break;
        }
      }
      if (!best) break;
      best.c.pos = best.end;
      room -= best.cost;
    }
    // 2. the rest of the lane: account heads, lowest envelope hash first
    // (all channel txs bid the same fee rate, ARCHITECTURE 7.3)
    while (room > 0) {
      let best: { txs: { lane: boolean; hash: string }[]; pos: number } | null = null;
      for (const c of chains.values()) {
        while (c.pos < c.txs.length && !c.txs[c.pos].lane) c.pos++;
        if (c.pos < c.txs.length && (!best || c.txs[c.pos].hash < best.txs[best.pos].hash)) best = c;
      }
      if (!best) break;
      best.pos++;
      room--;
    }
    // every account up to its chosen txs; txs that do not use the lane come along until its next channel tx
    const input: string[] = [];
    for (const c of chains.values()) {
      while (c.pos < c.txs.length && !c.txs[c.pos].lane) c.pos++;
      for (let j = 0; j < c.pos; j++) input.push(c.txs[j].env);
    }
    return lm.trimInvalid(input, closeTime).valid;
  }

  /** Our value for the slot with a later close time, re-signed (departure recipe). */
  private freshValue(slot: number): Value | null {
    const n = this.nominated.get(slot);
    if (!n) return null;
    const lcl = this.host.ledger().lastClosed();
    const closeTime = Math.max(n.closeTime + 1, lcl.header.scpValue.closeTime + 1);
    const value = encodeStellarValue(makeSignedStellarValue(this.networkId, this.keypair, n.txSetHash, closeTime));
    this.nominated.set(slot, { txSetHash: n.txSetHash, closeTime, value });
    return value;
  }

  // ------------------------------------------------------------ externalize -> close

  private onValueExternalized(slot: number, value: Value): void {
    const now = this.clock.now();
    if (!this.slotExternalizedAt.has(slot)) this.slotExternalizedAt.set(slot, now);
    this.driver.cancelTimersUpTo(slot);
    this.events.emit('externalized', { slot, value });
    this.scheduleClose(slot, value);
  }

  /** Close an externalized slot soon (outside the SCP call stack), once. */
  private scheduleClose(slot: number, value: Value): void {
    if (this.closing.has(slot)) return;
    this.closing.add(slot);
    this.clock.setTimeout(() => {
      this.closing.delete(slot);
      this.closeExternalized(slot, value);
    }, 0);
  }

  /** ARCHITECTURE 10.5. */
  private closeExternalized(slot: number, value: Value): void {
    if (this.stopped) return;
    const lm = this.host.ledger();
    const lcl = lm.lastClosed();
    const lclSeq = lcl.header.ledgerSeq;
    if (slot <= lclSeq) {
      if (slot === lclSeq && encodeStellarValue(lcl.header.scpValue) !== value) {
        this.host.externalizedMismatch(slot, value);
      }
      return;
    }
    if (slot > lclSeq + 1) {
      // cannot happen while only LCL+1 envelopes reach SCP; catch up instead
      this.host.behind({ slot, nodes: [] });
      return;
    }
    if (!this.synced) return;
    const info = decodeValue(value);
    if (!info) {
      this.log.error(`externalized a malformed value for slot ${slot}`);
      return;
    }
    const cached = this.pending.getTxSet(info.txSetHash);
    if (!cached) {
      this.log.error(`externalized tx set ${info.txSetHash.slice(0, 8)} for slot ${slot} is unknown`);
      this.host.behind({ slot: slot + 1, nodes: [] });
      return;
    }
    let result: LedgerCloseResult;
    try {
      result = lm.closeLedger(cached.info, info);
    } catch (err) {
      this.log.error(`closing ledger ${slot} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.host.externalizedMismatch(slot, value);
      return;
    }
    this.host.ledgerClosed(result, { source: 'consensus', externalizedBy: this.countExternalizers(slot) });
  }

  /** Distinct nodes with a CONFIRM or EXTERNALIZE statement for the slot (self included). */
  countExternalizers(slot: number): number {
    const nodes = new Set<NodeId>();
    this.scp.processCurrentState(
      slot,
      (e) => {
        const t = e.statement.pledges.type;
        if (t === 'confirm' || t === 'externalize') nodes.add(e.statement.nodeId);
        return true;
      },
      true,
    );
    return nodes.size;
  }

  /**
   * Other nodes whose latest statement for the slot is a CONFIRM or an
   * EXTERNALIZE of the value we externalized: they closed that ledger with
   * us (empty when the slot did not externalize here).
   */
  confirmersOf(slot: number): NodeId[] {
    const value = this.scp.getExternalizedValue(slot);
    if (value === null) return [];
    const out: NodeId[] = [];
    this.scp.processCurrentState(
      slot,
      (e) => {
        const p = e.statement.pledges;
        const v = p.type === 'confirm' ? p.ballot.value : p.type === 'externalize' ? p.commit.value : null;
        if (v === value && e.statement.nodeId !== this.nodeId) out.push(e.statement.nodeId);
        return true;
      },
      false,
    );
    return out;
  }

  /**
   * Called by the host after every closed ledger (consensus or catch-up):
   * updates the queue, forgets old slots and prepares the next slot.
   */
  afterLedgerClosed(result: LedgerCloseResult, meta: CloseMeta): void {
    if (this.stopped) return;
    const seq = result.header.ledgerSeq;
    const { dropped } = this.txQueue.onLedgerClosed(result);
    for (const r of result.results) {
      this.events.emit('txStatus', {
        hash: r.hash,
        status: r.successful ? 'applied' : 'failed',
        ledgerSeq: seq,
        resultCode: r.resultCode,
      });
    }
    for (const d of dropped) this.emitDropped(d);

    const minSlot = seq - MAX_SLOTS_TO_REMEMBER;
    if (minSlot > 1) {
      this.scp.purgeSlots(minSlot);
      this.pending.purge(minSlot);
    }
    for (const m of [this.nominated, this.slotStartedAt, this.slotExternalizedAt]) {
      for (const k of [...m.keys()]) if (k < minSlot) m.delete(k);
    }
    for (const k of [...this.futureSenders.keys()]) if (k <= seq + 1) this.futureSenders.delete(k);
    this.slotProgressAt = this.clock.now();
    if (meta.source === 'consensus') this.events.emit('slot', { slot: seq });

    if (this.synced) {
      // watchers never trigger: their slot boundary is the ledger close
      if (!this.validating) this.applySlotBoundaryQuorum();
      this.pending.pump();
      this.scheduleTrigger(false);
    }
  }

  private emitDropped(d: QueueDrop): void {
    this.events.emit('txStatus', { hash: d.tx.hash, status: 'dropped', resultCode: d.code });
  }

  // ------------------------------------------------------------ quorum policy

  /** Install a quorum set. Returns true when it changed. */
  applyQuorumSet(qset: QuorumSet, reason: string): boolean {
    const before = this.scp.getLocalQuorumSetHash();
    try {
      this.scp.updateLocalQuorumSet(qset);
    } catch (err) {
      this.log.error(`quorum set rejected: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    const hash = this.scp.getLocalQuorumSetHash();
    if (hash === before) return false;
    const q = this.scp.getLocalQuorumSet();
    this.pending.pinQSet(q);
    this.log.info(`quorum set ${q.threshold}/${qsetNodes(q).length} (${reason})`);
    this.events.emit('quorum', { qset: q, hash, reason });
    return true;
  }

  /** Auto mode: additions and removals take effect at the slot boundary. */
  private applySlotBoundaryQuorum(): void {
    if (this.quorum.getMode() !== 'auto') return;
    // a watcher with nobody active keeps its set (a set of only itself never externalizes)
    if (!this.validating && this.quorum.activeIds().length === 0) return;
    this.applyQuorumSet(this.quorum.autoQSet(), 'slot boundary');
  }

  /**
   * Auto mode departures (ARCHITECTURE 10.6): validators that stopped being
   * active leave the quorum set right away after a bye, or once the current
   * slot made no progress for departureStallMs. The new set is announced with
   * a newer statement (abandonBallot, else refreshNomination).
   */
  checkDepartures(): boolean {
    if (this.stopped || !this.synced || this.quorum.getMode() !== 'auto') return false;
    const current = this.scp.getLocalQuorumSet();
    const active = new Set(this.quorum.activeIds());
    const members = qsetNodes(current);
    const removed = members.filter((n) => n !== this.nodeId && !active.has(n));
    if (removed.length === 0) return false;
    const anyGone = removed.some((n) => this.quorum.isGone(n));
    const stalled = this.clock.now() - this.slotProgressAt >= this.tuning.departureStallMs;
    if (!anyGone && !stalled) return false;
    const keep = members.filter((n) => !removed.includes(n));
    if (this.validating && !keep.includes(this.nodeId)) keep.push(this.nodeId);
    // a watcher left with nobody keeps its set until validators come back
    if (keep.length === 0) return false;
    const names = removed.map((n) => this.host.nodeName(n) || n.slice(0, 8)).join(', ');
    if (!this.applyQuorumSet(autoQuorumSet(keep), `departure of ${names}`)) return false;
    this.announceQuorumChange();
    return true;
  }

  /**
   * Tell peers about a quorum set change on the open slot (they only take a
   * node's new set from a strictly newer statement): abandon the ballot, or
   * while still nominating, restart nomination with a fresh value.
   */
  announceQuorumChange(): void {
    if (!this.synced || this.stopped) return;
    const slot = this.lclSeq() + 1;
    try {
      if (!this.scp.abandonBallot(slot) && !this.restartNomination(slot)) {
        const fresh = this.freshValue(slot);
        if (fresh) this.scp.refreshNomination(slot, fresh);
      }
    } catch (err) {
      this.log.error(`announcing the quorum change failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.slotProgressAt = this.clock.now();
  }

  /**
   * Restart nomination of the open slot so that round leaders come from the
   * current quorum set. SCP's nomination only ever adds round leaders, so
   * after a departure the departed leaders can block nomination forever.
   * Only done while we have no ballot (nomination votes do not affect
   * safety). Our last nomination and the peers' latest statements are kept.
   */
  private restartNomination(slot: number): boolean {
    const info = this.scp.getSlotInfo(slot);
    if (!info || !info.nomination.started) return false;
    if (info.ballot.current !== null || info.nomination.candidates.length > 0) return false;
    if (!this.nominated.has(slot)) return false;
    const lcl = this.host.ledger().lastClosed();
    if (slot !== lcl.header.ledgerSeq + 1) return false;
    const state = this.scp.getEntireCurrentState(slot);
    const own = state.find((e) => e.statement.nodeId === this.nodeId && e.statement.pledges.type === 'nominate');
    const others = state.filter((e) => e.statement.nodeId !== this.nodeId);
    const fresh = this.freshValue(slot);
    if (!fresh) return false;
    this.scp.purgeSlotsOutsideRange(null, slot - 1, null);
    if (own) this.scp.setStateFromEnvelope(slot, own);
    this.scp.nominate(slot, fresh, encodeStellarValue(lcl.header.scpValue));
    for (const e of others) this.scp.receiveEnvelope(e);
    this.scp.refreshNomination(slot, fresh);
    this.log.debug(`restarted nomination of slot ${slot} with the new quorum set`);
    return true;
  }

  private scheduleQuorumCheck(): void {
    this.quorumTimer = this.clock.setTimeout(() => {
      this.quorumTimer = null;
      if (this.stopped) return;
      try {
        // a watcher does not vote, so its set may follow the active validators at any time
        if (!this.validating && this.synced) this.applySlotBoundaryQuorum();
        else this.checkDepartures();
      } catch (err) {
        this.log.error(`quorum check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.scheduleQuorumCheck();
    }, this.tuning.quorumCheckMs);
  }

  // ------------------------------------------------------------ rebroadcast

  private scheduleRebroadcast(): void {
    this.rebroadcastTimer = this.clock.setTimeout(() => {
      this.rebroadcastTimer = null;
      if (this.stopped) return;
      this.rebroadcast();
      this.scheduleRebroadcast();
    }, this.tuning.rebroadcastMs);
  }

  /** ARCHITECTURE 10.4.7: re-flood our latest envelopes for LCL and LCL+1. */
  rebroadcast(): void {
    if (!this.synced || !this.validating) return;
    const lcl = this.lclSeq();
    for (const slot of [lcl, lcl + 1]) {
      for (const env of this.scp.getLatestMessagesSend(slot)) {
        if (this.emitInterceptor && this.emitInterceptor(env, this.emitApi())) continue;
        this.net.floodStellar(makeScpMessage(envelopeToXdr(env)));
      }
    }
  }

  // ------------------------------------------------------------ restarts

  /**
   * HerderImpl::persistSCPState: our latest envelopes for the open slot and
   * what peers need to check them. Null when we emitted nothing for it.
   */
  exportScpState(): PersistedScpState | null {
    const slot = this.lclSeq() + 1;
    const envs = this.scp.getLatestMessagesSend(slot);
    if (envs.length === 0) return null;
    const txSets: string[] = [];
    for (const env of envs) {
      for (const v of statementValues(env.statement)) {
        const info = decodeValue(v);
        const c = info ? this.pending.getTxSet(info.txSetHash) : undefined;
        if (c && !txSets.includes(c.info.xdr)) txSets.push(c.info.xdr);
      }
    }
    return { slot, envelopes: envs.map(envelopeToBase64), txSets, qset: qsetToBase64(this.scp.getLocalQuorumSet()) };
  }

  /**
   * HerderImpl::restoreSCPState: put our pre-restart statements for LCL+1
   * back into SCP, so we do not vote differently in a slot we already voted
   * in. EXTERNALIZE statements are skipped (the ledger comes from peers).
   */
  restoreScpState(state: PersistedScpState): number {
    if (this.stopped || state.slot !== this.lclSeq() + 1) return 0;
    const lm = this.host.ledger();
    for (const x of state.txSets) {
      try {
        this.pending.addTxSet(lm.decodeTxSet(x), { slot: state.slot, force: true });
      } catch {
        /* skip a bad entry */
      }
    }
    try {
      this.pending.pinQSet(qsetFromXdr(state.qset));
    } catch {
      /* our current set is pinned anyway */
    }
    let n = 0;
    for (const b64 of state.envelopes) {
      try {
        const env = envelopeFromXdr(b64);
        const st = env.statement;
        if (st.nodeId !== this.nodeId || st.slotIndex !== state.slot || st.pledges.type === 'externalize') continue;
        if (this.scp.setStateFromEnvelope(state.slot, env)) n++;
      } catch (err) {
        this.log.warn(`could not restore an SCP statement: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (n > 0) this.log.info(`restored ${n} SCP statements for slot ${state.slot}`);
    return n;
  }

  // ------------------------------------------------------------ queries

  lclSeq(): number {
    return this.host.ledger().lastClosed().header.ledgerSeq;
  }

  slotStart(slot: number): number | null {
    return this.slotStartedAt.get(slot) ?? null;
  }

  slotExternalized(slot: number): number | null {
    return this.slotExternalizedAt.get(slot) ?? null;
  }

  /** Our nominated value for a slot, if any. */
  nominatedValue(slot: number): Value | null {
    return this.nominated.get(slot)?.value ?? null;
  }

  lastProgressAt(): number {
    return this.slotProgressAt;
  }
}
