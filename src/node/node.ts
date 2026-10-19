// Node composition (ARCHITECTURE 11): keys, Storage, ledger, Overlay, Herder,
// history (serving, catch-up, forks) and the quorum policy. The same code runs
// in the browser worker and in the simulation (memory transport, memory
// storage, virtual clock).
//
// Lifecycle: booting -> catching-up -> synced <-> stalled, and stopped.
// - booting: wait up to bootWaitMs for peers. A peer ahead or on another
//   branch starts catch-up or fork handling; peers that agree with us (or no
//   peers at all) make us synced.
// - catching-up: SCP is paused; ledgers come from a peer (history module).
// - synced: the herder runs SCP for LCL+1. stalled: synced, but no ledger
//   closed for stallMs.

import { Keypair, StrKey } from '@stellar/stellar-sdk/base';
import { toHex } from '../lib/bytes';
import type { Clock } from '../lib/clock';
import { DEFAULT_NETWORK_NAME, GENESIS_LEDGER_SEQ, LEDGER_TARGET_CLOSE_MS, MAX_SLOTS_TO_REMEMBER, networkPassphrase } from '../lib/constants';
import { Emitter } from '../lib/events';
import { networkIdOf, sha256 } from '../lib/hash';
import { LogSink, Logger, type LogEntry } from '../lib/log';
import { seededRng, type Rng } from '../lib/random';
import { friendbotChannelIds, friendbotKeypairs } from '../ledger/genesis';
import type { LedgerManager } from '../ledger/manager';
import type { LedgerCloseResult } from '../ledger/types';
import { Overlay } from '../overlay/overlay';
import type { LclRef, PeerInfo, PeerSyncState, Transport } from '../overlay/types';
import { checkQuorumSetSanity, isQuorumSlice, isVBlocking, qsetNodes } from '../scp/quorum';
import type { QuorumSet } from '../scp/types';
import type { Storage } from '../storage/types';
import { Herder, type EmitInterceptor, type HerderTuning, type PersistedScpState } from '../herder/herder';
import { PARTICIPATION_GRACE_MS, QuorumManager, type QuorumMode } from '../herder/quorumManager';
import type { CloseMeta, HerderHost, TxStatusEvent } from '../herder/types';
import { ChainStore, branchWeightEnd } from '../history/chainStore';
import { CatchupError, catchUpFrom, catchupAttemptBudgetMs, fetchHeaderHash, type CatchupHost } from '../history/catchup';
import { decideForkByVouchers, findForkPoint, type ForkPoint, type Vouchers } from '../history/fork';
import { HistoryServer } from '../history/server';
import type {
  ForkInfo,
  NodeStatus,
  PeerView,
  QuorumConfigInput,
  QuorumConfigView,
  ScpEventView,
  ScpSlotView,
  SubmitResult,
  SyncState,
  ValidatorView,
} from './api';
import type { NodeEvents } from './events';
import { buildFriendbotTx, createsAccount, friendbotChannel, ownedFriendbotChannels } from './friendbot';
import { ScopedClock } from './scopedClock';
import { TapTransport } from './tapTransport';
import {
  ledgerSummaryFromHeader,
  ledgerSummaryOf,
  peerViewOf,
  qsetFromView,
  qsetViewOf,
  scpEventViewOf,
  scpSlotViewOf,
  validatorViewOf,
} from './views';

export interface NodeTuning {
  /** Wait this long for peers at boot before going solo. */
  bootWaitMs: number;
  /**
   * The same wait for a node whose transports include WebRTC, while it has
   * seen no peer at all: Nostr signalling can take several seconds.
   */
  bootWaitWebRtcMs: number;
  /** After the first peer shows up, wait this long for more before deciding. */
  bootSettleMs: number;
  /** Period of the sync / fork / stall checks. */
  syncCheckMs: number;
  /** Synced but nothing closed for this long: 'stalled'. */
  stallMs: number;
  /** A peer is one ledger ahead and nothing closed for this long: ask for SCP state. */
  stuckMs: number;
  /** Minimum gap between scpState requests. */
  scpStateGapMs: number;
  /** A fork with the same peer is re-checked after this long. */
  forkRecheckMs: number;
  /** A source that sent bad data is avoided this long. */
  badSourceMs: number;
  /** A source that is unreachable or lacks data is avoided this long. */
  unreachableSourceMs: number;
  /** After a failed catch-up to a target, do not pause consensus for the same target again this long. */
  catchupBackoffMs: number;
  /** Catch-up attempts before giving up for this round. */
  maxCatchupAttempts: number;
  requestTimeoutMs: number;
  /** Minimum gap between 'peers' events caused by status updates. */
  peersEventGapMs: number;
  scpEventsKept: number;
  forksKept: number;
  /** A validator first heard of counts as active (auto quorum) this long before it votes. */
  participationGraceMs: number;
}

export const DEFAULT_NODE_TUNING: NodeTuning = {
  bootWaitMs: 4000,
  bootWaitWebRtcMs: 12_000,
  bootSettleMs: 1000,
  syncCheckMs: 1000,
  stallMs: 3 * LEDGER_TARGET_CLOSE_MS,
  stuckMs: 2 * LEDGER_TARGET_CLOSE_MS,
  scpStateGapMs: 3000,
  forkRecheckMs: 10_000,
  badSourceMs: 60_000,
  unreachableSourceMs: 15_000,
  catchupBackoffMs: 15_000,
  maxCatchupAttempts: 8,
  requestTimeoutMs: 10_000,
  peersEventGapMs: 1000,
  scpEventsKept: 500,
  forksKept: 50,
  participationGraceMs: PARTICIPATION_GRACE_MS,
};

export interface NodeOptions {
  /** Transports given to the overlay (memory, BroadcastChannel, bridge). */
  transports: Transport[];
  storage: Storage;
  clock: Clock;
  /** Log sink (default: a new LogSink at 'info'). Its entries are re-emitted as 'log' events. */
  logSink?: LogSink;
  /** Network name (default DEFAULT_NETWORK_NAME); selects the passphrase. */
  networkName?: string;
  /** Node secret (S...). Default: meta 'identity', else a new random key (stored). */
  secret?: string;
  /** Display name. Default: meta 'name', else "node-XXXX". */
  name?: string;
  /** Quorum mode. Default: meta 'quorum', else auto. */
  quorum?: QuorumConfigInput;
  /** Validating (true) or watching (false). Default: meta 'validating', else true. */
  validating?: boolean;
  /** Seeded RNG (peer choice). Default: seeded from the node id. */
  rng?: Rng;
  tuning?: Partial<NodeTuning>;
  herderTuning?: Partial<HerderTuning>;
  overlay?: { statusIntervalMs?: number; peerTimeoutMs?: number; requestTimeoutMs?: number };
  /** Test hook used by the Byzantine simulation. */
  emitInterceptor?: EmitInterceptor;
}

export const META_IDENTITY = 'identity';
export const META_NAME = 'name';
export const META_QUORUM = 'quorum';
export const META_VALIDATING = 'validating';
/** Our latest SCP envelopes for the open slot (restored after a restart). */
export const META_SCP_STATE = 'scpState';
/** The member book: validators seen as active members on our chain, and since which ledger. */
export const META_MEMBERS = 'members';

const FOLLOWING: ReadonlySet<PeerSyncState> = new Set<PeerSyncState>(['synced', 'stalled']);

/** Disconnected validators not heard for this long leave the directory. */
const DIRECTORY_TTL_MS = 30 * 60_000;

/** Friendbot requests remembered for a retry (oldest forgotten first). */
const FRIENDBOT_TRACKED = 1024;

/** While we wait for a catch-up we cannot do, repeat the warning at most this often. */
const BLOCKED_LOG_MS = 60_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ForkCheck {
  /** Their LCL when we last compared. */
  lcl: LclRef;
  at: number;
  /** We kept our branch because only validators unknown to us are on theirs: check again even if their LCL stays. */
  strangers?: boolean;
}

/** A fork that only unknown validators are on is reported again at most this often while it lasts. */
export const STRANGER_REPORT_MS = 10_000;

export class Node {
  readonly events = new Emitter<NodeEvents>();
  readonly networkName: string;
  readonly passphrase: string;
  readonly networkId: Uint8Array;
  readonly networkIdHex: string;
  readonly logSink: LogSink;
  readonly tuning: NodeTuning;
  private readonly opts: NodeOptions;
  private readonly clock: ScopedClock;
  private log: Logger;
  private kp: Keypair | null = null;
  private nodeName = '';
  private lm!: LedgerManager;
  private chainStore!: ChainStore;
  private quorumMgr!: QuorumManager;
  private herderObj!: Herder;
  private overlayObj!: Overlay;
  private historyServer!: HistoryServer;
  private taps: TapTransport[] = [];
  private stateValue: SyncState = 'booting';
  private phase: 'new' | 'starting' | 'running' | 'stopped' = 'new';
  private dead = false;
  private rng: Rng = seededRng(1);
  private unsubscribeLog: (() => void) | null = null;

  private startedAtMs = 0;
  private bootStartedAt = 0;
  private firstPeerAt: number | null = null;
  /** A peer (in any state) was connected during this boot. */
  private bootSawPeer = false;
  private lastCloseAt = 0;
  private ledgersClosedHere = 0;
  private readonly closeIntervals: number[] = [];
  private task: Promise<void> | null = null;
  private taskName = '';
  private abortTask = false;
  private catchupInfo: { target: number; current: number; source: string | null } | null = null;
  private readonly forks: ForkInfo[] = [];
  private readonly forkChecks = new Map<string, ForkCheck>();
  private readonly badSources = new Map<string, number>();
  /** `${seq}:${hash}` of a catch-up target we recently failed -> cooldown end (local ms). */
  private readonly catchupBackoff = new Map<string, number>();
  /** Last lone target we logged (one warning per target). */
  private loneTargetLogged = '';
  private readonly scpEvents: ScpEventView[] = [];
  private lastScpStateAt = -Infinity;
  private lastPeersEventAt = -Infinity;
  private byeFrom: string | null = null;
  private friendbotCounter = 0;
  private friendbotKeys: Keypair[] | null = null;
  /** Our friendbot txs without a final status: hash -> request. */
  private readonly friendbotTxs = new Map<string, { dest: string; create: boolean; attempt: number }>();
  private syncTimer: number | null = null;
  private kickPending = false;
  private scpSavePending = false;
  /** Local time of the latest hello or status from each connected peer. */
  private readonly statusAt = new Map<string, number>();
  /** Set by onResume(): until synced again, only announcements newer than this count. */
  private resumedAt: number | null = null;
  private abortingForResume: Promise<void> | null = null;
  /**
   * True once this node had a chain beyond genesis (loaded, closed, replayed
   * or from a snapshot), until a resync wipes it. Such a node catches up by
   * replay (ARCHITECTURE 12.2). A rollback to a fork point at genesis does
   * not make it a new node that may load a peer's snapshot.
   */
  private hadChain = false;
  /**
   * Set while peers we follow are ahead, we cannot catch up with them, and
   * we would vote alone: we stay 'catching-up' and do not vote, so we do not
   * build a branch of our own (ARCHITECTURE 12.2). Cleared when synced.
   */
  private blocked: LclRef | null = null;
  private blockedLoggedAt = -Infinity;
  /** Why we are blocked, short enough for the UI (NodeStatus.catchup.blocked). */
  private blockedReason = '';
  /** Local ms of the latest report of a fork that only unknown validators are on. */
  private strangerReportAt = -Infinity;
  /** Last stranger fork we warned about (atSeq:ourHash:theirHash): repeats are logged at debug level. */
  private strangerLogged = '';
  /**
   * First ledger of our chain that validators unknown to us cannot show us
   * (they lack the history to compare): where our branch and theirs part, as
   * far as we can tell. Reset when the ledger is replaced.
   */
  private strangerSplitAt: number | null = null;
  private membersSavePending = false;
  /** Local ms of our last ledger closed by consensus since the ledger was last replaced. */
  private lastConsensusCloseAt = -Infinity;

  constructor(opts: NodeOptions) {
    this.opts = opts;
    this.networkName = opts.networkName ?? DEFAULT_NETWORK_NAME;
    this.passphrase = networkPassphrase(this.networkName);
    this.networkId = networkIdOf(this.passphrase);
    this.networkIdHex = toHex(this.networkId);
    this.clock = new ScopedClock(opts.clock);
    this.logSink = opts.logSink ?? new LogSink(opts.clock, 'info');
    this.log = new Logger(this.logSink, 'node');
    this.tuning = { ...DEFAULT_NODE_TUNING, ...opts.tuning };
  }

  // ------------------------------------------------------------ accessors

  get nodeId(): string {
    if (!this.kp) throw new Error('node not started');
    return this.kp.publicKey();
  }

  get name(): string {
    return this.nodeName;
  }

  get state(): SyncState {
    return this.stateValue;
  }

  /** The current ledger manager (replaced after rollbacks and resyncs). */
  get ledger(): LedgerManager {
    return this.lm;
  }

  get storage(): Storage {
    return this.opts.storage;
  }

  get chain(): ChainStore {
    return this.chainStore;
  }

  get herder(): Herder {
    return this.herderObj;
  }

  get overlay(): Overlay {
    return this.overlayObj;
  }

  get quorum(): QuorumManager {
    return this.quorumMgr;
  }

  get startedAt(): number {
    return this.startedAtMs;
  }

  get isRunning(): boolean {
    return this.phase === 'running' && !this.dead;
  }

  /** Name of the running background task ('catch-up', 'fork', 'resync'), or ''. */
  get busyWith(): string {
    return this.task ? this.taskName : '';
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.phase !== 'new') throw new Error('node already started');
    this.phase = 'starting';
    const storage = this.opts.storage;
    await storage.open();

    // identity and settings (meta)
    let secret = this.opts.secret ?? (await storage.getMeta<string>(META_IDENTITY));
    if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) secret = Keypair.random().secret();
    this.kp = Keypair.fromSecret(secret);
    await storage.setMeta(META_IDENTITY, secret);
    const nodeId = this.kp.publicKey();
    this.nodeName = this.opts.name ?? (await storage.getMeta<string>(META_NAME)) ?? `node-${nodeId.slice(1, 5)}`;
    await storage.setMeta(META_NAME, this.nodeName);
    const validating = this.opts.validating ?? (await storage.getMeta<boolean>(META_VALIDATING)) ?? true;
    await storage.setMeta(META_VALIDATING, validating);
    let qcfg: QuorumConfigInput = this.opts.quorum ?? (await storage.getMeta<QuorumConfigInput>(META_QUORUM)) ?? { mode: 'auto' };
    if (qcfg.mode === 'manual' && checkQuorumSetSanity(qsetFromView(qcfg.qset), false) !== null) {
      this.log.warn('stored manual quorum set is not sane; using auto mode');
      qcfg = { mode: 'auto' };
    }
    await storage.setMeta(META_QUORUM, qcfg);
    this.log = new Logger(this.logSink, this.nodeName);
    this.rng = this.opts.rng ?? seededRng(sha256(nodeId)[0] * 65536 + sha256(nodeId)[1] * 256 + sha256(nodeId)[2]);
    this.unsubscribeLog = this.logSink.subscribe((e: LogEntry) => this.events.emit('log', e));

    // ledger: latest snapshot + replay of stored ledgers, or genesis
    this.chainStore = new ChainStore({
      storage,
      passphrase: this.passphrase,
      clock: this.clock,
      logger: this.log.child('history'),
    });
    const load = await this.chainStore.loadLedger();
    this.lm = load.ledger;
    const lcl = this.lm.lastClosed();
    this.hadChain = lcl.header.ledgerSeq > GENESIS_LEDGER_SEQ;
    this.log.info(
      `ledger ${lcl.header.ledgerSeq} loaded (snapshot ${load.fromSnapshot}, ${load.replayed} replayed)` +
        (load.truncatedAfter !== null ? `, storage cut after ${load.truncatedAfter}` : ''),
    );

    this.quorumMgr = new QuorumManager({
      selfId: nodeId,
      selfName: this.nodeName,
      clock: this.clock,
      mode: qcfg.mode,
      manualQset: qcfg.mode === 'manual' ? qsetFromView(qcfg.qset) : null,
      validating,
      participationGraceMs: this.tuning.participationGraceMs,
    });
    this.quorumMgr.setLocalChain({ seq: lcl.header.ledgerSeq, hash: lcl.hash }, lcl.header.previousLedgerHash);
    this.quorumMgr.importMembers(await storage.getMeta<unknown>(META_MEMBERS));

    this.taps = this.opts.transports.map(
      (t) =>
        new TapTransport(
          t,
          (id) => {
            this.byeFrom = id;
          },
          () => {
            this.byeFrom = null;
          },
        ),
    );
    this.overlayObj = new Overlay({
      keypair: this.kp,
      networkId: this.networkIdHex,
      name: this.nodeName,
      clock: this.clock,
      logger: this.log.child('overlay'),
      transports: this.taps,
      handlers: {
        onStellarMessage: (xdr, from) => (this.dead ? false : this.herderObj.onStellarMessage(xdr, from)),
        onRequest: (body) => (this.dead ? null : this.historyServer.handle(body)),
        onPeerConnected: (p) => this.onPeerConnected(p),
        onPeerDisconnected: (p) => this.onPeerDisconnected(p),
        onPeerStatus: (p) => this.onPeerStatus(p),
      },
      announcement: {
        lcl: { seq: lcl.header.ledgerSeq, hash: lcl.hash },
        state: 'booting',
        validator: validating,
        qsetHash: '',
        quorumMode: qcfg.mode,
      },
      statusIntervalMs: this.opts.overlay?.statusIntervalMs,
      peerTimeoutMs: this.opts.overlay?.peerTimeoutMs,
      requestTimeoutMs: this.opts.overlay?.requestTimeoutMs ?? this.tuning.requestTimeoutMs,
    });

    this.herderObj = new Herder({
      keypair: this.kp,
      clock: this.clock,
      logger: this.log.child('herder'),
      net: this.overlayObj,
      host: this.herderHost(),
      quorum: this.quorumMgr,
      rng: this.rng,
      validating,
      tuning: this.opts.herderTuning,
      emitInterceptor: this.opts.emitInterceptor,
      ownFriendbotChannels: () => this.ownFriendbotChannelIds(),
    });
    this.herderObj.events.on('envelope', (e) => {
      if (e.direction === 'out') this.saveScpStateSoon();
      this.scpEvents.push(scpEventViewOf(e));
      if (this.scpEvents.length > this.tuning.scpEventsKept) this.scpEvents.splice(0, this.scpEvents.length - this.tuning.scpEventsKept);
      this.events.emit('scpEnvelope', e);
    });
    this.herderObj.events.on('slot', (e) => this.events.emit('slot', e));
    this.herderObj.events.on('txStatus', (e) => {
      this.events.emit('txStatus', e);
      this.onFriendbotStatus(e);
    });
    this.herderObj.events.on('quorum', (e) => {
      this.events.emit('quorum', { ...e, mode: this.quorumMgr.getMode() });
      this.announce();
    });
    this.historyServer = new HistoryServer({
      chain: this.chainStore,
      passphrase: this.passphrase,
      ledger: () => this.lm,
      scpState: (fromSlot) => (this.dead ? null : this.herderObj.answerScpState(fromSlot)),
    });

    const saved = await storage.getMeta<PersistedScpState>(META_SCP_STATE);
    if (saved) this.herderObj.restoreScpState(saved);

    this.startedAtMs = this.clock.now();
    this.bootStartedAt = this.startedAtMs;
    this.lastCloseAt = this.startedAtMs;
    this.phase = 'running';
    this.herderObj.start();
    this.overlayObj.start();
    this.setState('booting');
    this.scheduleSyncCheck();
    this.log.info(`started as ${nodeId.slice(0, 8)} on network "${this.networkName}"`);
  }

  /** Graceful stop: sends bye, flushes storage and closes it. */
  async stop(): Promise<void> {
    if (this.phase === 'stopped' || this.phase === 'new') {
      this.phase = 'stopped';
      return;
    }
    this.abortTask = true;
    this.herderObj.stop();
    this.overlayObj.stop();
    this.setState('stopped');
    this.phase = 'stopped';
    this.clock.dispose();
    try {
      await this.saveMembers();
      await this.chainStore.flush();
      await this.opts.storage.close();
    } catch (err) {
      this.log.warn(`storage close failed: ${errText(err)}`);
    }
    this.unsubscribeLog?.();
  }

  /**
   * Simulated crash: no bye, timers stop, storage stays as it is.
   * 'freeze' keeps links up but silent (peers time out); 'link-down' stops
   * the transports (peers see the links go down).
   */
  kill(mode: 'freeze' | 'link-down' = 'freeze'): void {
    if (this.dead) return;
    this.dead = true;
    this.abortTask = true;
    this.clock.dispose();
    this.herderObj?.stop();
    for (const t of this.taps) {
      if (mode === 'freeze') t.freeze();
      else t.stop();
    }
    this.phase = 'stopped';
    this.stateValue = 'stopped';
    this.unsubscribeLog?.();
  }

  private alive(): boolean {
    return this.phase === 'running' && !this.dead;
  }

  private setState(state: SyncState): void {
    if (state === this.stateValue && state !== 'booting') return;
    const previous = this.stateValue;
    this.stateValue = state;
    if (state !== 'catching-up') {
      this.blocked = null;
      this.blockedReason = '';
    }
    if (state === 'booting') {
      this.bootStartedAt = this.clock.now();
      this.firstPeerAt = null;
      this.bootSawPeer = false;
    }
    if (previous !== state) {
      this.log.info(`state ${previous} -> ${state}`);
      this.events.emit('state', { state, previous });
    }
    this.announce();
  }

  /** Update what we announce to peers (status beacons). */
  private announce(): void {
    if (!this.overlayObj || this.dead) return;
    const lcl = this.lm.lastClosed();
    const qsetHash = this.herderObj ? this.herderObj.scp.getLocalQuorumSetHash() : '';
    this.quorumMgr.setSelfState(this.stateValue, qsetHash);
    try {
      this.overlayObj.setAnnouncement({
        name: this.nodeName,
        lcl: { seq: lcl.header.ledgerSeq, hash: lcl.hash },
        state: this.stateValue,
        validator: this.herderObj ? this.herderObj.isValidating() : true,
        qsetHash,
        quorumMode: this.quorumMgr.getMode(),
      });
    } catch (err) {
      this.log.error(`announcement rejected: ${errText(err)}`);
    }
  }

  // ------------------------------------------------------------ herder host

  private herderHost(): HerderHost {
    return {
      ledger: () => this.lm,
      ledgerClosed: (result, meta) => this.onLedgerClosed(result, meta),
      behind: (info) => this.onBehind(info),
      externalizedMismatch: (slot) => {
        this.log.warn(`SCP externalized another value for ledger ${slot}: checking for a fork`);
        this.forkChecks.clear();
        this.kick();
      },
      nodeName: (id) => (this.kp && id === this.kp.publicKey() ? this.nodeName : this.quorumMgr.name(id)),
    };
  }

  /** Every closed ledger goes through here (consensus and catch-up). */
  private onLedgerClosed(result: LedgerCloseResult, meta: CloseMeta): void {
    if (this.dead) return;
    const seq = result.header.ledgerSeq;
    if (seq > GENESIS_LEDGER_SEQ) this.hadChain = true;
    const snapshot = ChainStore.isCheckpoint(seq) ? JSON.stringify(this.lm.snapshot()) : null;
    const { stored, txs, persisted } = this.chainStore.record(result, meta.externalizedBy, snapshot);
    this.herderObj.afterLedgerClosed(result, meta);
    this.quorumMgr.setLocalChain({ seq, hash: result.hash }, result.header.previousLedgerHash);
    const now = this.clock.now();
    let members = this.quorumMgr.noteMembers();
    if (meta.source === 'consensus') {
      // late CONFIRM / EXTERNALIZE messages raise the count of earlier ledgers
      for (let s = Math.max(2, seq - MAX_SLOTS_TO_REMEMBER); s <= seq; s++) {
        if (s < seq) this.chainStore.raiseExternalizedBy(s, this.herderObj.countExternalizers(s));
        // who closed each ledger with us: members of our chain since then
        for (const id of this.herderObj.confirmersOf(s)) if (this.quorumMgr.noteMember(id, s)) members = true;
      }
      if (this.ledgersClosedHere > 0) {
        this.closeIntervals.push(now - this.lastCloseAt);
        if (this.closeIntervals.length > 20) this.closeIntervals.shift();
      }
      this.ledgersClosedHere++;
      this.lastConsensusCloseAt = now;
      if (this.stateValue === 'stalled') this.setState('synced');
    }
    if (members) this.saveMembersSoon();
    this.lastCloseAt = now;
    this.announce();
    void persisted.then(() => {
      if (!this.dead) this.events.emit('ledgerClosed', { result, stored, txs, source: meta.source });
    });
  }

  /** Persist our latest envelopes once the current burst of emits is over. */
  private saveScpStateSoon(): void {
    if (this.scpSavePending || this.dead) return;
    this.scpSavePending = true;
    this.clock.setTimeout(() => {
      this.scpSavePending = false;
      if (this.dead || this.phase !== 'running') return;
      const state = this.herderObj.exportScpState();
      if (state) {
        this.opts.storage.setMeta(META_SCP_STATE, state).catch((err: unknown) => this.log.warn(`saving SCP state failed: ${errText(err)}`));
      }
    }, 0);
  }

  /** Record the validators that are members of our chain now; persist the book when it changed. */
  private noteMembers(): void {
    if (this.quorumMgr.noteMembers()) this.saveMembersSoon();
  }

  private saveMembersSoon(): void {
    if (this.membersSavePending || this.dead) return;
    this.membersSavePending = true;
    this.clock.setTimeout(() => {
      this.membersSavePending = false;
      if (this.dead || this.phase !== 'running') return;
      void this.saveMembers();
    }, 0);
  }

  private saveMembers(): Promise<void> {
    return this.opts.storage
      .setMeta(META_MEMBERS, this.quorumMgr.exportMembers())
      .catch((err: unknown) => this.log.warn(`saving the member book failed: ${errText(err)}`));
  }

  private onBehind(info: { slot: number; nodes: string[] }): void {
    if (!this.alive() || this.task) return;
    if (this.stateValue !== 'synced' && this.stateValue !== 'stalled') return;
    const lclSeq = this.lclSeq();
    const peers = this.followingPeers();
    const target = this.pickTarget(peers);
    if (target && target.seq > lclSeq + 1 && this.canCatchUpTo(target, peers) && !this.loneVoucher(target, peers)) {
      this.startCatchup('SCP shows we are behind');
      return;
    }
    const connected = new Set(this.overlayObj.peers().map((p) => p.nodeId));
    const askers = info.nodes.filter((n) => connected.has(n));
    this.requestScpState(askers.length > 0 ? askers : this.scpStatePeers());
  }

  // ------------------------------------------------------------ overlay events

  private onPeerConnected(p: PeerInfo): void {
    if (this.dead) return;
    this.statusAt.set(p.nodeId, this.clock.now());
    this.quorumMgr.noteStatus(p);
    this.noteMembers();
    this.herderObj.onPeerConnected(p);
    this.emitPeers(true);
    this.kick();
  }

  private onPeerDisconnected(p: PeerInfo): void {
    if (this.dead) return;
    const bye = this.byeFrom === p.nodeId;
    this.statusAt.delete(p.nodeId);
    this.quorumMgr.noteDisconnected(p.nodeId, bye);
    if (bye) {
      this.log.info(`${p.name || p.nodeId.slice(0, 8)} left (bye)`);
      // ARCHITECTURE 10.6: a bye takes effect right away
      this.herderObj.checkDepartures();
    }
    this.emitPeers(true);
  }

  private onPeerStatus(p: PeerInfo): void {
    if (this.dead) return;
    this.statusAt.set(p.nodeId, this.clock.now());
    this.quorumMgr.noteStatus(p);
    if (this.quorumMgr.isForked(p.nodeId) && this.isConsistent(p.ann.lcl) === true) {
      this.quorumMgr.markForked(p.nodeId, false);
    }
    this.noteMembers();
    this.emitPeers(false);
    this.kick();
  }

  private emitPeers(force: boolean): void {
    const now = this.clock.now();
    if (!force && now - this.lastPeersEventAt < this.tuning.peersEventGapMs) return;
    this.lastPeersEventAt = now;
    this.events.emit('peers', { peers: this.overlayObj.peers() });
  }

  /** Run the sync check soon (outside the overlay callback). */
  private kick(): void {
    if (this.kickPending || !this.alive()) return;
    this.kickPending = true;
    this.clock.setTimeout(() => {
      this.kickPending = false;
      this.syncCheck();
    }, 0);
  }

  private scheduleSyncCheck(): void {
    this.syncTimer = this.clock.setTimeout(() => {
      this.syncTimer = null;
      if (!this.alive()) return;
      try {
        this.syncCheck();
      } catch (err) {
        this.log.error(`sync check failed: ${errText(err)}`);
      }
      this.scheduleSyncCheck();
    }, this.tuning.syncCheckMs);
  }

  // ------------------------------------------------------------ sync logic

  private lclSeq(): number {
    return this.lm.lastClosed().header.ledgerSeq;
  }

  /**
   * Is the announced LCL on our chain? false: it names a ledger we have with
   * another hash; true: same hash; null: we cannot tell (it is ahead of us or
   * older than what we keep in memory).
   */
  private isConsistent(ref: LclRef): boolean | null {
    const lcl = this.lm.lastClosed();
    const ourSeq = lcl.header.ledgerSeq;
    if (ref.seq > ourSeq) return null;
    if (ref.seq === ourSeq) return ref.hash === lcl.hash;
    if (ref.seq === ourSeq - 1) return ref.hash === lcl.header.previousLedgerHash;
    const h = this.chainStore.hashAt(ref.seq);
    return h === undefined ? null : h === ref.hash;
  }

  /** Peers that follow the chain (synced or stalled), not known to be on another branch. */
  private followingPeers(): PeerInfo[] {
    return this.overlayObj.peers().filter((p) => FOLLOWING.has(p.ann.state) && !this.quorumMgr.isForked(p.nodeId));
  }

  /**
   * Catch-up target (ARCHITECTURE 12.2): among peers ahead of us, the (seq,
   * hash) announced by the most peers, then the highest seq. In manual mode
   * only a target announced by a v-blocking set of the configured quorum set
   * counts: the user trusts the chain of those validators, nobody else's.
   */
  private pickTarget(peers: PeerInfo[]): LclRef | null {
    const ourSeq = this.lclSeq();
    const groups = new Map<string, { ref: LclRef; ids: string[] }>();
    for (const p of peers) {
      if (p.ann.lcl.seq <= ourSeq) continue;
      const key = `${p.ann.lcl.seq}:${p.ann.lcl.hash}`;
      const g = groups.get(key);
      if (g) g.ids.push(p.nodeId);
      else groups.set(key, { ref: { seq: p.ann.lcl.seq, hash: p.ann.lcl.hash }, ids: [p.nodeId] });
    }
    const manual = this.quorumMgr.getMode() === 'manual' ? this.quorumMgr.desiredQSet() : null;
    let best: { ref: LclRef; ids: string[] } | null = null;
    for (const g of groups.values()) {
      if (manual && !isVBlocking(manual, g.ids)) continue;
      if (!best || g.ids.length > best.ids.length || (g.ids.length === best.ids.length && g.ref.seq > best.ref.seq)) best = g;
    }
    return best ? best.ref : null;
  }

  /**
   * Manual mode: a peer more than one ledger ahead whose chain we may not
   * follow (no v-blocking set announces it). It is checked for a fork
   * instead, so the user hears about a fork. Null in auto mode.
   */
  private untrustedAhead(peers: PeerInfo[], target: LclRef | null): PeerInfo | null {
    if (this.quorumMgr.getMode() !== 'manual') return null;
    const lclSeq = this.lclSeq();
    const far = peers.filter((p) => p.ann.lcl.seq > lclSeq + 1 && !(target && p.ann.lcl.seq === target.seq && p.ann.lcl.hash === target.hash));
    return far.find((p) => this.forkCheckDue(p)) ?? null;
  }

  private syncCheck(): void {
    if (!this.alive() || this.task) return;
    const now = this.clock.now();
    if (this.stateValue === 'booting') {
      this.bootCheck(now);
      return;
    }
    this.quorumMgr.prune(now - DIRECTORY_TTL_MS);
    this.pruneSourceCaches(now);
    this.noteMembers();
    // 'catching-up' with no task running: a catch-up we could not do (we do
    // not vote meanwhile). The checks below run as when synced, then
    // blockedCheck decides whether to keep waiting.
    const blocked = this.stateValue === 'catching-up';
    if (this.stateValue !== 'synced' && this.stateValue !== 'stalled' && !blocked) return;
    if (this.stateValue === 'synced' && now - this.lastCloseAt > this.tuning.stallMs) this.setState('stalled');

    // forks: a peer names one of our ledgers with another hash, or a peer on
    // another branch moved on (ahead of us its LCL cannot be compared, so a
    // fork check without a rollback would otherwise never be repeated)
    for (const p of this.overlayObj.peers()) {
      if (!FOLLOWING.has(p.ann.state) && p.ann.state !== 'booting') continue;
      const consistent = this.isConsistent(p.ann.lcl);
      const suspect = consistent === false || (consistent === null && this.quorumMgr.isForked(p.nodeId));
      if (suspect && this.forkCheckDue(p)) {
        this.startForkCheck(p);
        return;
      }
    }
    const peers = this.followingPeers();
    const target = this.pickTarget(peers);
    const lclSeq = this.lclSeq();
    if (target && target.seq > lclSeq + 1 && this.canCatchUpTo(target, peers)) {
      const lone = blocked ? null : this.loneVoucher(target, peers);
      if (!lone) {
        this.startCatchup(blocked ? `trying again: peers are at ledger ${target.seq}` : `peers are at ledger ${target.seq}`);
        return;
      }
      // not followed, but checked like a failed catch-up would: if it is on
      // another branch, the fork rule decides
      if (this.forkCheckDue(lone)) {
        this.startForkCheck(lone);
        return;
      }
    }
    if (blocked) {
      this.blockedCheck(target);
      return;
    }
    const untrusted = this.untrustedAhead(peers, target);
    if (untrusted) {
      this.startForkCheck(untrusted);
      return;
    }
    const ahead = peers.filter((p) => p.ann.lcl.seq > lclSeq).map((p) => p.nodeId);
    if (ahead.length > 0 && now - this.lastCloseAt >= this.tuning.stuckMs) {
      this.requestScpState(ahead.slice(0, 2));
    }
  }

  /** After onResume(), announcements from before the pause are stale. */
  private heardSinceResume(nodeId: string): boolean {
    return this.resumedAt === null || (this.statusAt.get(nodeId) ?? -Infinity) >= this.resumedAt;
  }

  /** A transport reaches peers over WebRTC (the worker's bridge). */
  private usesWebRtc(): boolean {
    return this.opts.transports.some((t) => t.kind === 'webrtc' || t.kind === 'bridge');
  }

  private bootCheck(now: number): void {
    const all = this.overlayObj.peers();
    if (all.length > 0) this.bootSawPeer = true;
    const peers = all.filter((p) => (p.ann.state === 'booting' || FOLLOWING.has(p.ann.state)) && this.heardSinceResume(p.nodeId));
    if (peers.length > 0 && this.firstPeerAt === null) this.firstPeerAt = now;
    // ARCHITECTURE 11: over WebRTC, Nostr signalling can take several seconds
    // before the first peer shows up. Starting a chain alone too early makes
    // two browsers build separate chains.
    const webrtc = this.usesWebRtc();
    const aloneWaitMs = webrtc && !this.bootSawPeer ? Math.max(this.tuning.bootWaitMs, this.tuning.bootWaitWebRtcMs) : this.tuning.bootWaitMs;
    const settleCapMs = webrtc ? Math.max(this.tuning.bootWaitMs, this.tuning.bootWaitWebRtcMs) : this.tuning.bootWaitMs;
    for (const p of peers) {
      if (this.isConsistent(p.ann.lcl) === false && this.forkCheckDue(p)) {
        this.startForkCheck(p);
        return;
      }
    }
    const ahead = peers.filter((p) => p.ann.lcl.seq > this.lclSeq() && !this.quorumMgr.isForked(p.nodeId));
    if (ahead.length > 0 && ahead.some((p) => this.sourceOk(p.nodeId))) {
      if (this.pickTarget(ahead)) {
        this.startCatchup('a peer is ahead');
        return;
      }
      // manual mode, and no v-blocking set announces their chain: we do not
      // follow it, but a fork with it is reported
      const p = ahead.find((x) => this.forkCheckDue(x));
      if (p) {
        this.startForkCheck(p);
        return;
      }
    }
    if (peers.length === 0) {
      if (now - this.bootStartedAt >= aloneWaitMs) this.becomeSynced('no peers: validating alone');
      return;
    }
    // a peer showed up: settle shortly after the first one
    if (now - (this.firstPeerAt ?? now) >= this.tuning.bootSettleMs || now - this.bootStartedAt >= settleCapMs) {
      this.becomeSynced('in sync with peers');
    }
  }

  private becomeSynced(reason: string): void {
    if (!this.alive()) return;
    this.resumedAt = null;
    this.log.info(`synced at ledger ${this.lclSeq()} (${reason})`);
    this.lastCloseAt = Math.max(this.lastCloseAt, this.clock.now() - this.tuning.stuckMs / 2);
    this.setState('synced');
    this.herderObj.setSynced(true);
    this.requestScpState(this.scpStatePeers(), true);
  }

  private scpStatePeers(): string[] {
    return this.followingPeers()
      .filter((p) => p.ann.lcl.seq >= this.lclSeq())
      .map((p) => p.nodeId)
      .slice(0, 2);
  }

  private requestScpState(peers: string[], force = false): void {
    if (peers.length === 0 || !this.alive()) return;
    const now = this.clock.now();
    if (!force && now - this.lastScpStateAt < this.tuning.scpStateGapMs) return;
    this.lastScpStateAt = now;
    void this.herderObj.requestScpState(peers);
  }

  // ------------------------------------------------------------ background tasks

  private runTask(name: string, fn: () => Promise<void>): void {
    if (this.task || !this.alive()) return;
    this.abortTask = false;
    this.taskName = name;
    const p = (async () => {
      try {
        await fn();
      } catch (err) {
        if (!(err instanceof CatchupError && err.code === 'aborted')) this.log.error(`${name} failed: ${errText(err)}`);
      }
    })();
    this.task = p;
    void p.finally(() => {
      if (this.task === p) {
        this.task = null;
        this.taskName = '';
      }
      if (this.alive()) this.kick();
    });
  }

  /** Host for catch-up and fork checks; `deadline` (local ms) bounds one catch-up attempt. */
  private catchupHost(deadline?: number): CatchupHost {
    return {
      expired: () => deadline !== undefined && this.clock.now() > deadline,
      request: (id, body, t) => this.overlayObj.request(id, body, t),
      passphrase: this.passphrase,
      logger: this.log.child('catchup'),
      ledger: () => this.lm,
      installSnapshot: async (lm, data) => {
        const seq = lm.lastClosed().header.ledgerSeq;
        await this.chainStore.truncateAfter(seq);
        await this.chainStore.putSnapshot(seq, data);
        this.installLedger(lm, `snapshot ${seq}`);
      },
      replayed: (result) => this.onLedgerClosed(result, { source: 'catchup', externalizedBy: 0 }),
      progress: (p) => {
        this.catchupInfo = { target: p.target, current: p.current, source: p.source };
        this.events.emit('catchup', this.getCatchupProgress());
      },
      aborted: () => !this.alive() || this.abortTask,
      requestTimeoutMs: this.tuning.requestTimeoutMs,
    };
  }

  /** Replace the ledger (after a snapshot load, rollback or resync). */
  private installLedger(lm: LedgerManager, reason: string): void {
    this.lm = lm;
    this.lastConsensusCloseAt = -Infinity;
    this.strangerSplitAt = null;
    const lcl = lm.lastClosed();
    if (lcl.header.ledgerSeq > GENESIS_LEDGER_SEQ) this.hadChain = true;
    this.herderObj.onLedgerReset();
    this.quorumMgr.setLocalChain({ seq: lcl.header.ledgerSeq, hash: lcl.hash }, lcl.header.previousLedgerHash);
    this.announce();
    this.events.emit('ledgerReset', { lclSeq: lcl.header.ledgerSeq, reason });
  }

  private pause(): void {
    this.herderObj.setSynced(false);
    if (this.stateValue !== 'catching-up') this.setState('catching-up');
  }

  startCatchup(reason: string): void {
    if (this.task || !this.alive()) return;
    this.log.info(`catching up: ${reason}`);
    const lcl = this.lm.lastClosed();
    const aloneAt = this.aloneAtWork() ? { seq: lcl.header.ledgerSeq, hash: lcl.hash } : null;
    this.pause();
    this.runTask('catch-up', () => this.catchupLoop(aloneAt));
  }

  /**
   * A lone validator at work: synced, it would vote alone, and it closed a
   * ledger by consensus within stallMs. When its catch-up fails, it goes on
   * as before: it builds no new branch (block() is for a node that would
   * start voting alone, as one that comes back).
   */
  private aloneAtWork(): boolean {
    if (this.stateValue !== 'synced' && this.stateValue !== 'stalled') return false;
    return this.clock.now() - this.lastConsensusCloseAt < this.tuning.stallMs && this.votingAlone();
  }

  private sourceOk(nodeId: string): boolean {
    const until = this.badSources.get(nodeId);
    return until === undefined || until <= this.clock.now();
  }

  /**
   * Should we pause consensus to catch up to `target` now? Only when a usable
   * (not recently failed) peer can serve it and we did not just fail the same
   * target. This stops a single far-ahead peer that serves nothing from making
   * us flap between synced and catching-up every tick.
   */
  private canCatchUpTo(target: LclRef, peers: PeerInfo[]): boolean {
    const until = this.catchupBackoff.get(`${target.seq}:${target.hash}`);
    if (until !== undefined && until > this.clock.now()) return false;
    return peers.some((p) => p.ann.lcl.seq >= target.seq && this.sourceOk(p.nodeId));
  }

  /**
   * A far-ahead target is not followed while our side outnumbers or equals
   * the peers that announce it: our side is us plus the synced peers that
   * agree with our chain (LCL ours, one before or one after), and we closed
   * a ledger within stallMs. A healthy quorum must not stop to chase such
   * peers: they can forge the whole chain above our LCL, snapshot included,
   * or serve nothing at all. The target is followed when more peers announce
   * it than agree with us, when nobody agrees with us (the peer may be the
   * only node that is up to date), and when we are stalled. Returns the first
   * announcing peer (to check for a fork instead), or null to follow.
   */
  private loneVoucher(target: LclRef, peers: PeerInfo[]): PeerInfo | null {
    if (this.clock.now() - this.lastCloseAt >= this.tuning.stallMs) return null;
    const vouchers = peers.filter((p) => p.ann.lcl.seq === target.seq && p.ann.lcl.hash === target.hash);
    if (vouchers.length === 0) return null;
    const ids = new Set(vouchers.map((p) => p.nodeId));
    const ourSeq = this.lclSeq();
    const agree = peers.filter(
      (p) => !ids.has(p.nodeId) && Math.abs(p.ann.lcl.seq - ourSeq) <= 1 && this.isConsistent(p.ann.lcl) !== false,
    ).length;
    if (agree === 0 || vouchers.length > agree + 1) return null;
    const first = vouchers[0];
    const key = `${first.nodeId}:${target.seq}:${target.hash}`;
    if (this.loneTargetLogged !== key) {
      this.loneTargetLogged = key;
      this.log.warn(
        `not following ${first.name || first.nodeId.slice(0, 8)} to ledger ${target.seq}: ` +
          `${vouchers.length} peer(s) announce it, ${agree + 1} with us agree with our ledger ${ourSeq}`,
      );
    }
    return first;
  }

  /** Drop expired entries from the node-id and target keyed caches. */
  private pruneSourceCaches(now: number): void {
    for (const [k, until] of this.badSources) if (until <= now) this.badSources.delete(k);
    for (const [k, until] of this.catchupBackoff) if (until <= now) this.catchupBackoff.delete(k);
    for (const [k, c] of this.forkChecks) if (now - c.at > this.tuning.forkRecheckMs * 4) this.forkChecks.delete(k);
  }

  /**
   * A committed node that no source can replay to `target` may load a
   * snapshot only when the target is vouched for (ARCHITECTURE 12.2). In
   * manual mode a v-blocking set must announce it (pickTarget requires that
   * for any target). In auto mode only validators that this node saw as
   * active members at or before its LCL count, as for fork verdicts: at
   * least two of them announce the target, and they are strictly more than
   * the ones against it. Against: this node, known validators that agree
   * with our chain (LCL within one of ours), and known validators that
   * announce another ledger at the target's seq. Identities that appeared
   * later count for nothing, however many there are.
   */
  private snapshotVouched(target: LclRef): { ok: boolean; vouchers: number; against: number } {
    if (this.quorumMgr.getMode() === 'manual') return { ok: true, vouchers: 0, against: 0 };
    const lclSeq = this.lclSeq();
    let vouchers = 0;
    let against = 1;
    for (const p of this.overlayObj.peers()) {
      if (!p.ann.validator || !this.quorumMgr.wasMemberAt(p.nodeId, lclSeq)) continue;
      const ref = p.ann.lcl;
      if (ref.seq === target.seq && ref.hash === target.hash) vouchers++;
      else if (ref.seq === target.seq || (Math.abs(ref.seq - lclSeq) <= 1 && this.isConsistent(ref) === true)) against++;
    }
    return { ok: vouchers >= 2 && vouchers > against, vouchers, against };
  }

  /**
   * Would we close ledgers alone if we voted now? Manual mode: our quorum
   * set has a slice of only us. Auto mode: no other validator is active, and
   * no connected validator is on our chain (LCL ours or the one before),
   * whatever its state. Validators that wait like us are company: blocked
   * together, they would wait for each other forever.
   */
  private votingAlone(): boolean {
    if (this.quorumMgr.getMode() === 'manual') return isQuorumSlice(this.quorumMgr.desiredQSet(), [this.nodeId]);
    if (this.quorumMgr.activeIds().some((id) => id !== this.nodeId)) return false;
    return !this.overlayObj
      .peers()
      .some(
        (p) =>
          p.ann.validator &&
          p.ann.state !== 'stopped' &&
          !this.quorumMgr.isForked(p.nodeId) &&
          Math.abs(p.ann.lcl.seq - this.lclSeq()) <= 1 &&
          this.isConsistent(p.ann.lcl) === true,
      );
  }

  /**
   * ARCHITECTURE 12.2: peers we follow are ahead, we cannot catch up with
   * them, and we would vote alone. Voting would build a branch of our own,
   * so we stay 'catching-up' (not voting) and try again when a source is
   * usable (syncCheck).
   */
  private block(target: LclRef, why: string, short?: string): void {
    const first = this.blocked === null;
    this.blocked = { ...target };
    this.herderObj.setSynced(false);
    if (this.stateValue !== 'catching-up') this.setState('catching-up');
    // the UI shows why (NodeStatus.catchup.blocked); a moved target keeps the last known reason
    if (short) this.blockedReason = short;
    else if (!this.blockedReason) this.blockedReason = 'no peer ahead can serve the ledgers this node needs';
    this.catchupInfo = { target: target.seq, current: this.lclSeq(), source: null };
    this.events.emit('catchup', this.getCatchupProgress());
    const now = this.clock.now();
    if (!first && now - this.blockedLoggedAt < BLOCKED_LOG_MS) return;
    this.blockedLoggedAt = now;
    this.log.warn(
      `not voting: peers are at ledger ${target.seq} and we cannot catch up from ledger ${this.lclSeq()} (${why}). ` +
        `Alone we would build a branch of our own. Waiting for a source that has the ledgers, ` +
        `or for validators known before to vouch for a snapshot (a resync starts over from a snapshot)`,
    );
  }

  /** Waiting for a catch-up we cannot do: rejoin consensus when that is safe again. */
  private blockedCheck(target: LclRef | null): void {
    const lclSeq = this.lclSeq();
    if (!target || target.seq <= lclSeq + 1) {
      this.unblock(target ? `peers are at ledger ${target.seq}` : 'no peer we follow is ahead');
      return;
    }
    if (!this.votingAlone()) {
      this.unblock('validators on our chain are active');
      return;
    }
    if (!this.blocked || this.blocked.seq !== target.seq || this.blocked.hash !== target.hash) {
      this.block(target, this.blocked ? 'still no usable source' : 'no catch-up in progress');
    }
  }

  private unblock(why: string): void {
    this.blocked = null;
    this.blockedReason = '';
    this.catchupInfo = null;
    this.events.emit('catchup', null);
    this.becomeSynced(why);
  }

  /**
   * Catch up until we are at most one ledger behind the network, then become
   * synced. When peers we follow stay ahead and we would vote alone, block()
   * instead (ARCHITECTURE 12.2), unless we were a lone validator at work on
   * ledger `aloneAt` and are still on it.
   */
  private async catchupLoop(aloneAt: LclRef | null = null): Promise<void> {
    let failures = 0;
    /** Sources that lack the ledgers after our LCL `lackingAfter` (no replay from them). */
    let lacking = new Set<string>();
    let lackingAfter = this.lclSeq();
    /** Why the last attempt did not reach the target (log), and the same in a few words (UI). */
    let why = 'catch-up failed';
    let short = '';
    /** A peer ahead whose chain we cannot check: its validators lack the ledgers and nobody we knew vouches for it. */
    let unverified: string | null = null;
    // a retry while blocked repeats known warnings: log them at debug level
    const warn = (msg: string) => (this.blocked ? this.log.debug(msg) : this.log.warn(msg));
    while (this.alive() && !this.abortTask) {
      const peers = this.followingPeers();
      const candidates = peers.length > 0 ? peers : this.overlayObj.peers().filter((p) => p.ann.state === 'booting');
      const target = this.pickTarget(candidates);
      const lclSeq = this.lclSeq();
      if (!target || target.seq <= lclSeq) break;
      if (peers.length > 0 && this.loneVoucher(target, peers)) {
        why = 'not following: more validators agree with our chain';
        short = 'more validators agree with the chain of this node than announce the ledger ahead';
        break;
      }
      if (target.seq === lclSeq + 1 && failures === 0 && this.stateValue === 'catching-up' && peers.length > 0) {
        // One behind: let SCP finish the slot, if their ledger builds on ours.
        // A peer one ahead on another branch is checked for a fork now: if it
        // loses and rolls back onto our chain, nothing else would report it here.
        const peer = candidates.find((p) => p.ann.lcl.seq === target.seq && p.ann.lcl.hash === target.hash);
        const theirs = peer ? await fetchHeaderHash(this.catchupHost(), peer.nodeId, lclSeq).catch(() => null) : null;
        if (!peer || theirs === null || theirs === this.lm.lastClosed().hash || !this.alive() || this.abortTask) break;
        await this.forkCheck(peer);
        failures++;
        continue;
      }
      if (lclSeq !== lackingAfter) {
        lacking = new Set();
        lackingAfter = lclSeq;
      }
      const exact = candidates.filter((p) => p.ann.lcl.seq === target.seq && p.ann.lcl.hash === target.hash);
      const others = candidates.filter((p) => p.ann.lcl.seq > target.seq);
      const sources = [...exact, ...others].map((p) => p.nodeId).filter((id) => this.sourceOk(id));
      if (sources.length === 0) {
        why = 'no usable catch-up source';
        warn(why);
        break;
      }
      // ARCHITECTURE 12.2: a node with a committed chain catches up by replay,
      // which re-executes every transaction (forged balances would need forged
      // signatures). A snapshot is for a node that never had a chain beyond
      // genesis (a rollback to genesis does not count), or when no source has
      // the ledgers to replay and validators known before vouch for the target.
      let allowSnapshot = !this.hadChain;
      let pool = sources;
      if (!allowSnapshot) {
        pool = sources.filter((id) => !lacking.has(id));
        if (pool.length === 0) {
          const vouched = this.snapshotVouched(target);
          if (!vouched.ok) {
            why =
              `no source has the ledgers after ${lclSeq}, and a snapshot needs at least 2 validators known at ledger ${lclSeq} ` +
              `announcing it, more than against it (${vouched.vouchers} for, ${vouched.against} against, us included)`;
            short =
              `the peers ahead lack the ledgers after ${lclSeq}, and too few validators this node knew before ` +
              `vouch for their snapshot (${vouched.vouchers} for, ${vouched.against} against)`;
            unverified = exact.find((p) => !this.quorumMgr.wasMemberAt(p.nodeId, lclSeq))?.nodeId ?? null;
            warn(`cannot replay to ledger ${target.seq}: ${why}`);
            // the target moves with every ledger: rest the sources, not only this target
            const until = this.clock.now() + this.tuning.unreachableSourceMs;
            for (const id of sources) this.badSources.set(id, until);
            this.catchupBackoff.set(`${target.seq}:${target.hash}`, this.clock.now() + this.tuning.catchupBackoffMs);
            break;
          }
          allowSnapshot = true;
          pool = sources;
        }
      }
      const source = pool[failures % pool.length];
      this.catchupInfo = { target: target.seq, current: lclSeq, source };
      this.events.emit('catchup', this.getCatchupProgress());
      try {
        const deadline = this.clock.now() + catchupAttemptBudgetMs(target.seq - lclSeq);
        const res = await catchUpFrom(this.catchupHost(deadline), source, target, { allowSnapshot });
        this.log.info(
          `caught up to ${res.to} from ${this.quorumMgr.name(source) || source.slice(0, 8)}` +
            (res.snapshot !== null ? ` (snapshot ${res.snapshot})` : '') +
            `, ${res.replayed} ledgers replayed`,
        );
        failures = 0;
      } catch (err) {
        if (!(err instanceof CatchupError)) throw err;
        if (err.code === 'aborted') return;
        why = `catch-up from ${this.quorumMgr.name(source) || source.slice(0, 8)} failed (${err.code}): ${err.message}`;
        short = `catch-up from ${this.quorumMgr.name(source) || source.slice(0, 8)} failed (${err.code})`;
        warn(why);
        if (err.code === 'fork') {
          const peer = this.overlayObj.getPeer(source);
          if (peer) await this.forkCheck(peer);
          failures++;
        } else if (err.code === 'diverged') {
          // as in forkCheck: its chain does not replay to its own headers, so
          // it is on another branch (not in our quorum, not followed), and it
          // is checked again only after it moves
          this.badSources.set(source, this.clock.now() + this.tuning.badSourceMs);
          this.quorumMgr.markForked(source, true);
          const p = this.overlayObj.getPeer(source);
          if (p) this.forkChecks.set(source, { lcl: { ...p.ann.lcl }, at: this.clock.now() });
          const load = await this.chainStore.loadLedger();
          this.installLedger(load.ledger, 'reload after a diverged replay');
          failures++;
        } else if (err.code === 'bad-source') {
          this.badSources.set(source, this.clock.now() + this.tuning.badSourceMs);
          failures++;
        } else if (err.code === 'no-data' && !allowSnapshot) {
          // it lacks ledgers between ours and the target: replay from another
          // source, or (when every source lacks them) consider a snapshot
          lacking.add(source);
          failures++;
        } else {
          // no-data / network: sideline this source so the loop tries the
          // others. The only source is retried instead: one lost message must
          // not end the catch-up (we would vote alone far behind and fork).
          if (sources.length > 1) this.badSources.set(source, this.clock.now() + this.tuning.unreachableSourceMs);
          failures++;
        }
        if (failures >= this.tuning.maxCatchupAttempts) {
          warn('catch-up gave up for now');
          break;
        }
      }
    }
    if (!this.alive() || this.abortTask) return;
    // still behind with no usable source: back off this target so we do not
    // pause consensus for it again on the next tick
    const following = this.followingPeers();
    const pending = this.pickTarget(following);
    if (pending && pending.seq > this.lclSeq() + 1) {
      if (!this.canCatchUpTo(pending, following)) {
        this.catchupBackoff.set(`${pending.seq}:${pending.hash}`, this.clock.now() + this.tuning.catchupBackoffMs);
      }
      // ARCHITECTURE 12.2: alone, voting would build a branch of our own. A
      // lone validator at work that is still on the same ledger already
      // was that branch: it goes on.
      const lcl = this.lm.lastClosed();
      const stillAlone = aloneAt !== null && aloneAt.seq === lcl.header.ledgerSeq && aloneAt.hash === lcl.hash;
      if (this.votingAlone() && !stillAlone) {
        this.block(pending, why, short);
        return;
      }
    }
    this.catchupInfo = null;
    this.events.emit('catchup', null);
    const behind = pending !== null && pending.seq > this.lclSeq() + 1;
    // we go on with our chain although unknown validators announce one we cannot check
    if (behind && unverified !== null && this.quorumMgr.getMode() === 'auto') this.reportUnverifiedStrangers(unverified);
    this.becomeSynced(!behind ? 'caught up' : this.votingAlone() ? `${why}; validating alone as before` : `${why}; voting with the validators on our chain`);
  }

  // ------------------------------------------------------------ forks

  private forkCheckDue(p: PeerInfo): boolean {
    const last = this.forkChecks.get(p.nodeId);
    if (!last) return true;
    if (this.clock.now() - last.at < this.tuning.forkRecheckMs) return false;
    const sameLcl = last.lcl.seq === p.ann.lcl.seq && last.lcl.hash === p.ann.lcl.hash;
    // a fork kept only because its validators are unknown is checked (and reported) again while it lasts
    return !sameLcl || last.strangers === true;
  }

  private startForkCheck(p: PeerInfo): void {
    if (this.task || !this.alive()) return;
    this.runTask('fork', async () => {
      const wasSynced = this.stateValue === 'synced' || this.stateValue === 'stalled';
      await this.forkCheck(p);
      // a rollback left us catching up: continue until in sync
      if (this.stateValue === 'catching-up') await this.catchupLoop();
      else if (!wasSynced && this.stateValue === 'booting') this.kick();
    });
  }

  /**
   * ARCHITECTURE 12.3: find the fork point with `peer`, then (auto mode)
   * compare branch weights; the loser rolls back and catches up from the
   * winner. Manual mode only reports the fork.
   */
  private async forkCheck(peer: PeerInfo): Promise<void> {
    const host = this.catchupHost();
    const theirLcl = { ...peer.ann.lcl };
    this.forkChecks.set(peer.nodeId, { lcl: theirLcl, at: this.clock.now() });
    const ours = this.lm.lastClosed();
    const low = Math.min(ours.header.ledgerSeq, theirLcl.seq);
    let fp;
    try {
      fp = await findForkPoint(host, peer.nodeId, low, async (seq) => {
        const lcl = this.lm.lastClosed();
        if (seq === lcl.header.ledgerSeq) return lcl.hash;
        return this.chainStore.hashAtAsync(seq);
      });
    } catch (err) {
      this.log.warn(`fork check with ${peer.name || peer.nodeId.slice(0, 8)} failed: ${errText(err)}`);
      // a peer that does not answer is not asked again for a while, unless it is our only peer
      if (err instanceof CatchupError && err.code === 'network' && this.followingPeers().some((p) => p.nodeId !== peer.nodeId)) {
        this.badSources.set(peer.nodeId, this.clock.now() + this.tuning.unreachableSourceMs);
      }
      return;
    }
    if (!fp) {
      this.log.warn(`no common ledger with ${peer.name || peer.nodeId.slice(0, 8)}`);
      this.quorumMgr.markForked(peer.nodeId, true);
      // it lacks the history to compare: if it is a validator we never knew, the stranger rule keeps ours
      if (this.quorumMgr.getMode() === 'auto' && this.reportUnverifiedStrangers(peer.nodeId)) {
        this.forkChecks.set(peer.nodeId, { lcl: theirLcl, at: this.clock.now(), strangers: true });
      }
      return;
    }
    if (fp.forkPoint >= low) {
      // one chain extends the other: no fork
      this.quorumMgr.markForked(peer.nodeId, false);
      return;
    }
    const info: ForkInfo = {
      ts: this.clock.now(),
      atSeq: fp.forkPoint + 1,
      ourHash: fp.ourNext ?? '',
      theirHash: fp.theirNext ?? '',
      peer: peer.nodeId,
      resolution: 'alert-only',
      rolledBackLedgers: 0,
    };
    this.quorumMgr.markForked(peer.nodeId, true);
    if (this.quorumMgr.getMode() === 'manual') {
      this.logFork(this.recordFork(info), `fork with ${peer.name || peer.nodeId.slice(0, 8)} after ledger ${fp.forkPoint} (manual mode: alert only)`);
      return;
    }
    // ARCHITECTURE 12.3: the branch more validators vouch for wins. Only
    // validators this node saw as active members at or before the fork
    // point count (ours includes us), so identities that appeared later
    // decide nothing, however many there are. Equal counts: the weights
    // (self-reported, clamped), then the hash of the first ledger after the
    // fork point. A node that never saw another member has no quorum
    // history to protect: the weights decide, as for equal counts. A node
    // that saw its first member after the fork point (it joined later, for
    // example during a partition) counts the members it saw first: it
    // learned the history before them from them.
    const horizon = this.quorumMgr.earliestMemberSince();
    const knownAt = horizon === undefined ? null : Math.max(fp.forkPoint, horizon);
    const sides = knownAt === null ? null : await this.vouchersFor(fp, theirLcl, knownAt);
    const vouchers: Vouchers | null = sides ? { ours: sides.ours.length + 1, theirs: sides.theirs.length } : null;
    const lcl = this.lm.lastClosed();
    const oursInfo = { weight: 0, lcl: { seq: lcl.header.ledgerSeq, hash: lcl.hash }, first: fp.ourNext ?? '' };
    const theirs = { weight: 0, lcl: { ...theirLcl }, first: fp.theirNext ?? '' };
    let detail = vouchers
      ? `validators known at ledger ${knownAt} vouch ${vouchers.ours} for ours (us included), ${vouchers.theirs} for theirs`
      : 'no validator known before';
    if (!vouchers || vouchers.ours === vouchers.theirs) {
      const w = await this.branchWeights(peer, fp, theirLcl, sides);
      if (!w) {
        this.log.warn(`branchWeight from ${peer.nodeId.slice(0, 8)} failed`);
        return;
      }
      oursInfo.weight = w.ours;
      theirs.weight = w.theirs;
      theirs.lcl = w.lcl;
      detail += `; weights ours ${w.ours}@${oursInfo.lcl.seq}, theirs ${w.theirs}@${w.lcl.seq}`;
    }
    const verdict = decideForkByVouchers(vouchers, oursInfo, theirs);
    const verdictMsg =
      `fork with ${peer.name || peer.nodeId.slice(0, 8)} after ledger ${fp.forkPoint}: ${detail} -> ${verdict === 'ours' ? 'keep ours' : 'roll back'}`;
    if (verdict === 'ours') {
      info.resolution = 'kept-ours';
      // ARCHITECTURE 12.3: kept only because the validators on their branch
      // were unknown to us before the fork point, and they are at least as
      // many as our vouchers (us included): honest strangers look like Sybil
      // identities, so we do not follow them, but we report it while it lasts.
      const strangers = vouchers && knownAt !== null ? await this.strangersOn(fp, theirLcl, knownAt) : 0;
      if (vouchers && strangers > 0 && strangers >= vouchers.ours) {
        info.unknownValidators = strangers;
        this.forkChecks.set(peer.nodeId, { lcl: theirLcl, at: this.clock.now(), strangers: true });
        this.reportStrangers(info, `${verdictMsg}; ${strangers} validators unknown to us before the fork point are on their branch (a resync joins them)`);
        return;
      }
      this.logFork(this.recordFork(info), verdictMsg);
      return;
    }
    info.resolution = 'rolled-back';
    info.rolledBackLedgers = lcl.header.ledgerSeq - fp.forkPoint;
    this.logFork(this.recordFork(info), verdictMsg);
    await this.rollback(fp.forkPoint);
    this.quorumMgr.markForked(peer.nodeId, false);
    this.forkChecks.delete(peer.nodeId);
    try {
      // replay only while we keep committed ledgers (the catch-up loop that
      // follows handles sources that lack them)
      const deadline = this.clock.now() + catchupAttemptBudgetMs(theirs.lcl.seq - this.lclSeq());
      await catchUpFrom(this.catchupHost(deadline), peer.nodeId, theirs.lcl, { allowSnapshot: !this.hadChain });
    } catch (err) {
      this.log.warn(`catch-up from the winning branch failed: ${errText(err)}`);
      if (err instanceof CatchupError && err.code === 'diverged') {
        // Its branch does not replay to its own headers: do not follow it,
        // and check it again only after it moves (forkCheckDue). The failed
        // replay left the ledger past what is stored: reload (as catchupLoop does).
        this.badSources.set(peer.nodeId, this.clock.now() + this.tuning.badSourceMs);
        this.quorumMgr.markForked(peer.nodeId, true);
        this.forkChecks.set(peer.nodeId, { lcl: theirLcl, at: this.clock.now() });
        const load = await this.chainStore.loadLedger();
        this.installLedger(load.ledger, 'reload after a diverged replay');
      }
    }
  }

  /**
   * The connected validators that vouch for each branch of a fork after
   * fp.forkPoint (ARCHITECTURE 12.3): only those this node saw as active
   * members at or before ledger `knownAt` (the fork point, or our first
   * member when that came later), each placed by the LCL of its signed
   * status. `ours` does not include this node.
   */
  private async vouchersFor(fp: ForkPoint, theirLcl: LclRef, knownAt: number): Promise<{ ours: string[]; theirs: string[] }> {
    const known = this.overlayObj
      .peers()
      .filter((p) => p.ann.validator && p.ann.state !== 'stopped' && p.ann.lcl.seq > fp.forkPoint && this.quorumMgr.wasMemberAt(p.nodeId, knownAt));
    const placed = await Promise.all(known.map(async (p) => ({ id: p.nodeId, side: await this.branchOf(p.nodeId, { ...p.ann.lcl }, fp, theirLcl) })));
    return {
      ours: placed.filter((x) => x.side === 'ours').map((x) => x.id),
      theirs: placed.filter((x) => x.side === 'theirs').map((x) => x.id),
    };
  }

  /**
   * How many connected validators that this node did not know as members at
   * ledger `knownAt` announce their branch of the fork (ARCHITECTURE 12.3).
   */
  private async strangersOn(fp: ForkPoint, theirLcl: LclRef, knownAt: number): Promise<number> {
    const unknown = this.overlayObj
      .peers()
      .filter((p) => p.ann.validator && p.ann.state !== 'stopped' && p.ann.lcl.seq > fp.forkPoint && !this.quorumMgr.wasMemberAt(p.nodeId, knownAt));
    const sides = await Promise.all(unknown.map((p) => this.branchOf(p.nodeId, { ...p.ann.lcl }, fp, theirLcl)));
    return sides.filter((s) => s === 'theirs').length;
  }

  /**
   * Validators unknown to us announce a chain we cannot check: they lack the
   * ledgers to compare with ours (no common ledger found) or to replay
   * (ARCHITECTURE 12.2), and nobody we knew vouches for it. We keep ours. As
   * for a fork that only strangers are on, report it when at least 2 of them
   * (as many as a snapshot needs) and at least as many as the validators on
   * our chain (us included) are there. Our side: connected validators we saw
   * as members at our LCL, on our chain. Theirs: connected validators we
   * never saw as members, not on our chain. Returns true when reported.
   */
  private reportUnverifiedStrangers(peer: string): boolean {
    const lcl = this.lm.lastClosed();
    const lclSeq = lcl.header.ledgerSeq;
    if (this.quorumMgr.wasMemberAt(peer, lclSeq)) return false;
    let ours = 1;
    let strangers = 0;
    for (const p of this.overlayObj.peers()) {
      if (!p.ann.validator || p.ann.state === 'stopped') continue;
      const known = this.quorumMgr.wasMemberAt(p.nodeId, lclSeq);
      const onOurs = Math.abs(p.ann.lcl.seq - lclSeq) <= 1 && this.isConsistent(p.ann.lcl) === true;
      if (known && onOurs) ours++;
      else if (!known && !onOurs) strangers++;
    }
    if (strangers < 2 || strangers < ours) return false;
    // where we part, as far as we can tell: the first ledger after the newest we and they may share
    this.strangerSplitAt ??= lclSeq + 1;
    const at = this.strangerSplitAt;
    const ourHash = at === lclSeq ? lcl.hash : (this.chainStore.hashAt(at) ?? '');
    const info: ForkInfo = {
      ts: this.clock.now(),
      atSeq: at,
      ourHash,
      theirHash: '',
      peer,
      resolution: 'kept-ours',
      rolledBackLedgers: 0,
      unknownValidators: strangers,
    };
    this.reportStrangers(
      info,
      `${strangers} validators unknown to us announce a chain we cannot check against ours (at ledger ${lclSeq}), ` +
        `against ${ours} on ours (us included): keep ours (a resync joins them)`,
    );
    return true;
  }

  /**
   * Report a fork that we kept only because the validators on the other side
   * are unknown to us (ARCHITECTURE 12.3). While it lasts it is reported
   * again at most every STRANGER_REPORT_MS, so the UI can keep its alert
   * fresh. The fork list keeps the newest report of it.
   */
  private reportStrangers(info: ForkInfo, msg: string): void {
    const key = `${info.atSeq}:${info.ourHash}:${info.theirHash}`;
    if (key !== this.strangerLogged) {
      this.strangerLogged = key;
      this.log.warn(msg);
    } else {
      this.log.debug(msg);
    }
    const now = this.clock.now();
    if (now - this.strangerReportAt < STRANGER_REPORT_MS) return;
    this.strangerReportAt = now;
    const report: ForkInfo = { ...info, ts: now };
    for (let i = this.forks.length - 1; i >= 0; i--) {
      const f = this.forks[i];
      if (f.unknownValidators !== undefined && f.atSeq === report.atSeq && f.ourHash === report.ourHash && f.theirHash === report.theirHash) {
        this.forks.splice(i, 1);
      }
    }
    this.forks.push(report);
    if (this.forks.length > this.tuning.forksKept) this.forks.splice(0, this.forks.length - this.tuning.forksKept);
    this.events.emit('fork', { ...report });
  }

  /**
   * The branch of the fork that an announced LCL is on, or null (on neither,
   * or we cannot tell). Our chain and the peer's LCL place most statuses. A
   * status ahead of us, or at another ledger of their branch than the
   * peer's LCL, is placed by the announcing node's ledger after the fork point.
   */
  private async branchOf(nodeId: string, ref: LclRef, fp: ForkPoint, theirLcl: LclRef): Promise<'ours' | 'theirs' | null> {
    if (ref.seq <= fp.forkPoint) return null;
    const lcl = this.lm.lastClosed();
    const ourSeq = lcl.header.ledgerSeq;
    if (ref.seq <= ourSeq) {
      const h = ref.seq === ourSeq ? lcl.hash : await this.chainStore.hashAtAsync(ref.seq);
      if (h === ref.hash) return 'ours';
      if (h !== undefined && ref.seq === fp.forkPoint + 1) return ref.hash === fp.theirNext ? 'theirs' : null;
    }
    if (ref.seq === theirLcl.seq && ref.hash === theirLcl.hash) return 'theirs';
    let next: string | null;
    try {
      next = await fetchHeaderHash(this.catchupHost(), nodeId, fp.forkPoint + 1);
    } catch {
      return null;
    }
    if (next === null) return null;
    if (next === fp.theirNext) return 'theirs';
    // our ledger after the fork point, and an LCL we cannot check (ahead of us)
    if (next === fp.ourNext && ref.seq > ourSeq) return 'ours';
    return null;
  }

  /**
   * Branch weights when the vouchers are equal, or when this node has no
   * member history. Weights are local counts (replayed ledgers count 0), so
   * each branch's weight is the highest one reported by a few of its
   * members: the vouchers when there are any, else the peer and the peers
   * at its LCL. Their weight is clamped to (ledgers after the fork point) x
   * (validators we know): a branch's weight is a sum of externalizedBy, so
   * a larger one is a lie. The peer's answer also gives its current LCL
   * (the catch-up target). Null when no weight for their branch arrived.
   */
  private async branchWeights(
    peer: PeerInfo,
    fp: ForkPoint,
    theirLcl: LclRef,
    sides: { ours: string[]; theirs: string[] } | null,
  ): Promise<{ ours: number; theirs: number; lcl: LclRef } | null> {
    let theirSide: string[];
    let ourSide: string[];
    if (sides) {
      theirSide = sides.theirs.slice(0, 4);
      ourSide = sides.ours.slice(0, 3);
    } else {
      const peers = this.overlayObj.peers().filter((p) => p.nodeId !== peer.nodeId && FOLLOWING.has(p.ann.state));
      theirSide = [
        peer.nodeId,
        ...peers.filter((p) => p.ann.lcl.seq === theirLcl.seq && p.ann.lcl.hash === theirLcl.hash).map((p) => p.nodeId),
      ].slice(0, 4);
      ourSide = peers
        .filter((p) => !theirSide.includes(p.nodeId) && this.isConsistent(p.ann.lcl) === true)
        .map((p) => p.nodeId)
        .slice(0, 3);
    }
    const ask = [...new Set([peer.nodeId, ...theirSide, ...ourSide])];
    const answers = await Promise.all(
      ask.map(async (id) => {
        try {
          const res = await this.overlayObj.request(id, { kind: 'branchWeight', afterSeq: fp.forkPoint });
          return res.kind === 'branchWeight' ? { id, weight: res.weight, lcl: res.lcl } : null;
        } catch {
          return null;
        }
      }),
    );
    const got = new Map<string, { weight: number; lcl: LclRef }>();
    for (const a of answers) if (a) got.set(a.id, a);
    const reported = theirSide.filter((id) => got.has(id)).map((id) => got.get(id)!.weight);
    if (reported.length === 0) return null;
    const lcl = got.get(peer.nodeId)?.lcl ?? theirLcl;
    const theirSpan = Math.max(0, branchWeightEnd(fp.forkPoint, lcl.seq) - fp.forkPoint);
    const knownValidators = Math.max(1, this.quorumMgr.list().filter((r) => r.validator).length);
    const weightCap = theirSpan * knownValidators;
    const rawTheirs = Math.max(...reported);
    if (rawTheirs > weightCap) {
      this.log.warn(`clamped branch weight from ${peer.nodeId.slice(0, 8)}: ${rawTheirs} -> ${weightCap} (${theirSpan} ledgers, ${knownValidators} validators)`);
    }
    const ourWeight = Math.max(
      await this.chainStore.branchWeight(fp.forkPoint, this.lclSeq()),
      ...ourSide.filter((id) => got.has(id)).map((id) => got.get(id)!.weight),
    );
    return { ours: ourWeight, theirs: Math.min(rawTheirs, weightCap), lcl: { ...lcl } };
  }

  /**
   * Report a fork. A fork checked again with the same outcome (the newest
   * report for this peer has the same ledgers and resolution) is not
   * reported twice. Returns false for such a repeat.
   */
  private recordFork(info: ForkInfo): boolean {
    for (let i = this.forks.length - 1; i >= 0; i--) {
      const f = this.forks[i];
      if (f.peer !== info.peer) continue;
      if (f.atSeq === info.atSeq && f.ourHash === info.ourHash && f.theirHash === info.theirHash && f.resolution === info.resolution) {
        return false;
      }
      break;
    }
    this.forks.push(info);
    if (this.forks.length > this.tuning.forksKept) this.forks.splice(0, this.forks.length - this.tuning.forksKept);
    this.events.emit('fork', { ...info });
    return true;
  }

  /** Log a fork outcome: warn when it is news, debug when a check only repeated it. */
  private logFork(isNew: boolean, msg: string): void {
    if (isNew) this.log.warn(msg);
    else this.log.debug(msg);
  }

  /**
   * Drop our ledgers after forkPoint (storage and state), reload the ledger
   * from the newest snapshot at or before it, and re-queue our discarded
   * transactions once we are back in sync.
   */
  private async rollback(forkPoint: number): Promise<void> {
    this.pause();
    const lclSeq = this.lclSeq();
    const discarded = await this.chainStore.txEnvelopesAfter(forkPoint, lclSeq);
    await this.chainStore.truncateAfter(forkPoint);
    const load = await this.chainStore.loadLedger();
    this.installLedger(load.ledger, `rollback to ledger ${forkPoint}`);
    this.log.warn(`rolled back ${lclSeq - forkPoint} ledgers to ${this.lclSeq()}`);
    this.requeueLater(discarded);
  }

  /**
   * Re-submit txs from discarded ledgers once we are in sync again. A tx that
   * cannot be queued again (and is not applied or queued already) is reported
   * 'dropped' with the reason.
   */
  private requeueLater(envelopes: string[]): void {
    if (envelopes.length === 0) return;
    const off = this.events.on('state', (e) => {
      if (e.state !== 'synced') return;
      off();
      let n = 0;
      let lost = 0;
      for (const env of envelopes) {
        const res = this.herderObj.submitTransaction(env);
        if (res.status === 'PENDING') n++;
        else if (res.status !== 'DUPLICATE' && res.hash) {
          lost++;
          this.events.emit('txStatus', { hash: res.hash, status: 'dropped', resultCode: res.errorResultCode ?? res.status });
        }
      }
      if (n > 0) this.log.info(`re-queued ${n} transactions from rolled back ledgers`);
      if (lost > 0) this.log.info(`dropped ${lost} transactions from rolled back ledgers`);
    });
  }

  // ------------------------------------------------------------ public actions

  /** Submit a transaction (base64 TransactionEnvelope). */
  async submitTransaction(envelopeXdr: string): Promise<SubmitResult> {
    if (!this.alive()) return { hash: '', status: 'ERROR', errorResultCode: 'txINTERNAL_ERROR', errorDetail: 'node is not running' };
    return this.herderObj.submitTransaction(envelopeXdr);
  }

  /**
   * Fund (create or top up) an account with 10,000 XLM from a friendbot
   * channel. When a CreateAccount for it is already queued (from any node),
   * a Payment from the same channel follows it, so it applies after it.
   * Otherwise the channel is one this node owns (ownedFriendbotChannels over
   * the active validators), so concurrent requests at several nodes never
   * use the same channel and sequence number. A request whose tx is dropped
   * for its sequence number is retried once with a new tx.
   */
  async friendbot(accountId: string): Promise<SubmitResult> {
    if (!this.alive()) return { hash: '', status: 'ERROR', errorResultCode: 'txINTERNAL_ERROR', errorDetail: 'node is not running' };
    if (!StrKey.isValidEd25519PublicKey(accountId)) {
      return { hash: '', status: 'ERROR', errorResultCode: 'txMALFORMED', errorDetail: `invalid account id ${accountId}` };
    }
    const { result, create } = this.fundAccount(accountId);
    if (result.status === 'PENDING') this.trackFriendbotTx(result.hash, accountId, create, 0);
    return result;
  }

  /**
   * Account ids of the friendbot channels this node makes its own requests
   * on: the ones it owns, or every channel when it owns none (fundAccount).
   * The tx queue keeps most of their slots for those requests (ARCHITECTURE
   * 10.2). On other channels, txs from peers (the requests of the channel's
   * owner) may use every slot, so that they reach every tx set.
   */
  private ownFriendbotChannelIds(): ReadonlySet<string> {
    const owned = ownedFriendbotChannels(this.nodeId, this.quorumMgr.activeIds());
    if (owned.length === 0) return friendbotChannelIds(this.passphrase);
    this.friendbotKeys ??= friendbotKeypairs(this.passphrase);
    return new Set(owned.map((c) => this.friendbotKeys![c].publicKey()));
  }

  private fundAccount(accountId: string): { result: SubmitResult; create: boolean } {
    this.friendbotKeys ??= friendbotKeypairs(this.passphrase);
    const channels = this.friendbotKeys;
    const ids = channels.map((c) => c.publicKey());
    const queue = this.herderObj.txQueue;
    const exists = this.lm.getAccount(accountId) !== undefined;
    let index = -1;
    if (!exists) {
      const pending = queue.all().find((q) => ids.includes(q.sourceAccount) && createsAccount(q.envelopeXdr, accountId));
      if (pending) index = ids.indexOf(pending.sourceAccount);
    }
    const create = !exists && index < 0;
    if (index < 0) {
      const owned = ownedFriendbotChannels(this.nodeId, this.quorumMgr.activeIds());
      if (owned.length === 0) {
        index = friendbotChannel(this.nodeId, this.friendbotCounter++);
      } else {
        // the owned channel with the fewest queued txs (round robin on ties)
        const start = this.friendbotCounter++ % owned.length;
        let best = Infinity;
        for (let k = 0; k < owned.length; k++) {
          const c = owned[(start + k) % owned.length];
          const n = queue.countFor(ids[c]);
          if (n < best) {
            best = n;
            index = c;
          }
        }
      }
    }
    const channel = channels[index];
    const account = this.lm.getAccount(ids[index]);
    if (!account) {
      return { result: { hash: '', status: 'ERROR', errorResultCode: 'txNO_ACCOUNT', errorDetail: 'friendbot channel missing' }, create };
    }
    const seqNum = queue.nextSeqNum(ids[index], account.seqNum);
    const env = buildFriendbotTx({ passphrase: this.passphrase, channel, seqNum, destination: accountId, create });
    return { result: this.herderObj.submitTransaction(env), create };
  }

  private trackFriendbotTx(hash: string, dest: string, create: boolean, attempt: number): void {
    this.friendbotTxs.set(hash, { dest, create, attempt });
    // bounded: forget the oldest requests (their txs live on in the queue)
    while (this.friendbotTxs.size > FRIENDBOT_TRACKED) {
      this.friendbotTxs.delete(this.friendbotTxs.keys().next().value as string);
    }
  }

  /** Retry a friendbot request once when another tx took its sequence number. */
  private onFriendbotStatus(e: TxStatusEvent): void {
    const req = this.friendbotTxs.get(e.hash);
    if (!req || e.status === 'pending') return;
    this.friendbotTxs.delete(e.hash);
    // 'txINVALID' is how the trigger's trimInvalid reports any invalid tx;
    // for a friendbot tx (no time bounds, rich channel) that is its sequence
    if (e.status !== 'dropped' || req.attempt > 0 || (e.resultCode !== 'txBAD_SEQ' && e.resultCode !== 'txINVALID')) return;
    // leave the herder's call stack (the drop is reported while it updates the queue)
    this.clock.setTimeout(() => {
      if (!this.alive()) return;
      // a create whose account exists now was funded by another request
      if (req.create && this.lm.getAccount(req.dest) !== undefined) return;
      const { result, create } = this.fundAccount(req.dest);
      if (result.status === 'PENDING') {
        this.trackFriendbotTx(result.hash, req.dest, create, req.attempt + 1);
        this.log.info(`friendbot: tx ${e.hash.slice(0, 8)} for ${req.dest.slice(0, 8)} was dropped (${e.resultCode}); retried as ${result.hash.slice(0, 8)}`);
      } else {
        this.log.warn(`friendbot: retry for ${req.dest.slice(0, 8)} failed: ${result.errorResultCode ?? result.status} ${result.errorDetail ?? ''}`);
      }
    }, 0);
  }

  isValidating(): boolean {
    return this.herderObj ? this.herderObj.isValidating() : (this.opts.validating ?? true);
  }

  /** Switch between validating and watching (non-validator). */
  async setValidating(on: boolean): Promise<void> {
    this.herderObj.setValidating(on);
    await this.opts.storage.setMeta(META_VALIDATING, on);
    this.log.info(on ? 'validating' : 'watching (not validating)');
    this.announce();
  }

  async setName(name: string): Promise<void> {
    const n = name.trim().slice(0, 64);
    if (!n) throw new Error('name must not be empty');
    this.nodeName = n;
    this.quorumMgr.setSelfName(n);
    await this.opts.storage.setMeta(META_NAME, n);
    this.announce();
  }

  /** Wipe the local chain and resync from peers (keeps identity and settings). */
  async resync(): Promise<void> {
    if (!this.alive()) return;
    this.abortTask = true;
    if (this.task) await this.task.catch(() => undefined);
    this.abortTask = false;
    this.pause();
    this.herderObj.txQueue.clear();
    await this.chainStore.clear();
    const load = await this.chainStore.loadLedger();
    this.hadChain = false;
    // the member book refers to ledgers of the wiped chain
    this.quorumMgr.clearMembers();
    await this.saveMembers();
    this.installLedger(load.ledger, 'resync');
    this.forkChecks.clear();
    for (const r of this.quorumMgr.list()) if (!r.isSelf) this.quorumMgr.markForked(r.nodeId, false);
    // Sources sidelined and targets backed off while we had the old chain
    // (for example peers whose snapshot nobody we knew vouched for) are the
    // ones a fresh node catches up from: forget those verdicts.
    this.badSources.clear();
    this.catchupBackoff.clear();
    this.strangerLogged = '';
    this.log.info('chain wiped; resyncing from peers');
    this.setState('booting');
  }

  /**
   * The process was paused (frozen tab, sleeping machine): ledgers and peer
   * timeouts may have passed without us. Stop voting at once, then decide
   * as at boot, from announcements received after now: catch up when a peer
   * is ahead or on another branch, else rejoin consensus.
   */
  onResume(reason: string): void {
    if (!this.alive()) return;
    this.resumedAt = this.clock.now();
    this.herderObj.setSynced(false);
    this.log.info(`resumed (${reason}): checking sync before voting again`);
    const task = this.task;
    if (!task) {
      this.setState('booting');
      return;
    }
    // a running catch-up or fork check may act on stale peer data: stop it first
    if (this.abortingForResume === task) return;
    this.abortingForResume = task;
    this.abortTask = true;
    void task.then(() => {
      this.abortingForResume = null;
      if (!this.alive() || this.resumedAt === null) return;
      this.abortTask = false;
      this.setState('booting');
    });
  }

  // ------------------------------------------------------------ quorum config

  getQuorumConfig(): QuorumConfigView {
    const scp = this.herderObj.scp;
    const qset = scp.getLocalQuorumSet();
    return {
      mode: this.quorumMgr.getMode(),
      qset: qsetViewOf(qset),
      qsetHash: scp.getLocalQuorumSetHash(),
      intersection: this.quorumMgr.intersection(qset, (h) => this.herderObj.getQSet(h)),
      faultTolerance: this.quorumMgr.faultTolerance(qset),
    };
  }

  async setQuorumConfig(cfg: QuorumConfigInput): Promise<QuorumConfigView> {
    let changed: boolean;
    if (cfg.mode !== this.quorumMgr.getMode()) {
      // a fork verdict depends on the mode: check known forks again now
      this.forkChecks.clear();
      this.kick();
    }
    if (cfg.mode === 'manual') {
      const q = qsetFromView(cfg.qset);
      this.quorumMgr.setManual(q);
      changed = this.herderObj.applyQuorumSet(this.quorumMgr.desiredQSet(), 'manual quorum set');
    } else {
      this.quorumMgr.setAuto();
      changed = this.herderObj.applyQuorumSet(this.quorumMgr.autoQSet(), 'auto mode');
    }
    if (changed) this.herderObj.announceQuorumChange();
    await this.opts.storage.setMeta(META_QUORUM, cfg);
    this.announce();
    return this.getQuorumConfig();
  }

  // ------------------------------------------------------------ views

  getPeers(): PeerView[] {
    const members = new Set(qsetNodes(this.herderObj.scp.getLocalQuorumSet()));
    return this.overlayObj.peers().map((p) => peerViewOf(p, members.has(p.nodeId)));
  }

  getValidators(): ValidatorView[] {
    const members = new Set(qsetNodes(this.herderObj.scp.getLocalQuorumSet()));
    const now = this.clock.now();
    return this.quorumMgr
      .list()
      .filter((r) => r.isSelf || r.validator)
      .map((r) =>
        validatorViewOf(r, {
          active: this.quorumMgr.isActive(r.nodeId, now),
          inMyQuorum: members.has(r.nodeId),
          qset: r.isSelf ? this.herderObj.scp.getLocalQuorumSet() : r.qsetHash ? this.herderObj.getQSet(r.qsetHash) : null,
        }),
      );
  }

  /** SCP view of a slot (default: the slot being decided, LCL+1). */
  getScpSlot(slot?: number): ScpSlotView | null {
    const index = slot ?? this.lclSeq() + 1;
    const info = this.herderObj.scp.getSlotInfo(index);
    if (!info) return null;
    return scpSlotViewOf({
      info,
      name: (id) => (id === this.nodeId ? this.nodeName : this.quorumMgr.name(id)),
      txCount: (h) => this.herderObj.pending.getTxSet(h)?.stats.txCount ?? null,
      startedAt: this.herderObj.slotStart(index),
      externalizedAt: this.herderObj.slotExternalized(index),
    });
  }

  getScpEvents(limit: number): ScpEventView[] {
    return this.scpEvents.slice(-Math.max(0, limit));
  }

  getForks(): ForkInfo[] {
    return this.forks.map((f) => ({ ...f }));
  }

  getLogs(limit: number): LogEntry[] {
    return this.logSink.recent(limit);
  }

  /**
   * Catch-up progress (NodeStatus.catchup). `blocked` says why while peers
   * are ahead and this node cannot catch up from them safely, so it does not
   * vote (ARCHITECTURE 12.2).
   */
  getCatchupProgress(): { target: number; current: number; source: string | null; blocked?: string } | null {
    if (!this.catchupInfo) return null;
    const out: { target: number; current: number; source: string | null; blocked?: string } = { ...this.catchupInfo };
    if (this.blocked !== null && this.blockedReason) out.blocked = this.blockedReason;
    return out;
  }

  /** Recent intervals between ledgers closed here by consensus (ms). */
  getCloseIntervals(): number[] {
    return [...this.closeIntervals];
  }

  getLedgersClosedHere(): number {
    return this.ledgersClosedHere;
  }

  getStatus(): NodeStatus {
    const lcl = this.lm.lastClosed();
    const stored = this.chainStore.recentLedger(lcl.header.ledgerSeq);
    const slotIndex = lcl.header.ledgerSeq + 1;
    const slotView = this.state === 'synced' || this.state === 'stalled' ? this.getScpSlot(slotIndex) : null;
    const now = this.clock.now();
    return {
      nodeId: this.nodeId,
      name: this.nodeName,
      networkName: this.networkName,
      networkPassphrase: this.passphrase,
      networkId: this.networkIdHex,
      protocolVersion: lcl.header.ledgerVersion,
      appVersion: this.overlayObj.currentAnnouncement().appVersion,
      state: this.stateValue,
      isValidator: this.isValidating(),
      lcl: stored && stored.hash === lcl.hash ? ledgerSummaryOf(stored, lcl.header) : ledgerSummaryFromHeader(lcl.header, lcl.hash),
      peers: this.overlayObj.peers().length,
      validatorsActive: this.quorumMgr.activeIds(now).length,
      mempoolSize: this.herderObj.txQueue.size(),
      quorum: this.getQuorumConfig(),
      startedAt: this.startedAtMs,
      slot: slotView
        ? {
            index: slotIndex,
            phase: slotView.phase,
            ballotCounter: slotView.ballot ? slotView.ballot.counter : null,
            round: slotView.nomination.round,
          }
        : null,
      catchup: this.getCatchupProgress(),
    };
  }
}

export type { QuorumMode, QuorumSet };
