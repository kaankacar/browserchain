// A realistic in-process mock of NodeApi for UI development. It simulates a
// small validator network: SCP phases inside every ~5 s slot, ledger closes
// that apply real Stellar XDR transactions, peers coming and going, random
// traffic, friendbot, forks and logs. All time goes through the injected Clock.

import { Account, Asset, Claimant, Keypair, Memo, Operation, TimeoutInfinite, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { RealClock, type Clock, type TimerHandle } from '../../lib/clock';
import { formatAmount as stroopsToString } from '../../lib/amount';
import { concatBytes, fromHex, toBase64, toHex, writeUint32BE, writeUint64BE } from '../../lib/bytes';
import {
  APP_VERSION,
  BASE_FEE,
  BASE_RESERVE,
  DEFAULT_NETWORK_NAME,
  FRIENDBOT_AMOUNT,
  FRIENDBOT_CHANNEL_BALANCE,
  FRIENDBOT_CHANNELS,
  LEDGER_TARGET_CLOSE_MS,
  MAX_TX_SET_SIZE,
  PROTOCOL_VERSION,
  TOTAL_COINS,
  networkPassphrase,
} from '../../lib/constants';
import { sha256, sha256Hex } from '../../lib/hash';
import type { LogEntry, LogLevel } from '../../lib/log';
import { seededRng, type Rng } from '../../lib/random';
import type {
  AccountView,
  AssetStatView,
  AssetView,
  BallotView,
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
  QuorumSetView,
  ScpEventView,
  ScpNodeStateView,
  ScpPhase,
  ScpSlotView,
  SubmitResult,
  SyncState,
  TxDetail,
  TxSummary,
  ValidatorView,
  ValueView,
} from '../../node/api';
import { autoThreshold, canonicalQset, checkIntersection, faultTolerance, isSliceSatisfied, qsetValidators, validateQset } from '../lib/quorum';
import { MockLedger, TxRejected, assetToSdk, type AppliedTx, type ParsedTx } from './mockLedger';

export interface MockNodeOptions {
  clock?: Clock;
  /** Seed for every random choice (traffic, names, timing jitter). */
  seed?: number;
  networkName?: string;
  /** Validators including this node (4-6 recommended). */
  validators?: number;
  /** Ledgers of history created at startup. */
  historyLedgers?: number;
  /** Simulated boot + catch-up time before the node is synced. */
  bootMs?: number;
  /** Random payments, offers and accounts from other clients. */
  traffic?: boolean;
  /** Peers leave and rejoin now and then. */
  churn?: boolean;
  /** A fork event now and then. */
  forks?: boolean;
  /** Start timers right away (default true). */
  autoStart?: boolean;
  name?: string;
  /** Play a node state that needs the user (see MockDemo). Turns random forks off unless `forks` is set. */
  demo?: MockDemo;
}

/**
 * Node states the demo can play (`?mock=1&demo=...`). A resync ends either.
 * - 'strangers': validators this node did not know before run another
 *   chain. Auto mode keeps ours and reports the fork again while it lasts.
 * - 'blocked': peers are ahead, but this node cannot catch up from them
 *   safely, so it does not vote.
 */
export type MockDemo = 'strangers' | 'blocked';

/** The value of the `demo` URL parameter, if it names a MockDemo. */
export function parseMockDemo(value: string | null | undefined): MockDemo | undefined {
  return value === 'strangers' || value === 'blocked' ? value : undefined;
}

/** Validators in the other group of the 'strangers' demo. */
const STRANGERS = 3;
/** The node reports a fork with unknown validators again at most this often. */
const STRANGER_REPORT_MS = 10_000;
/** Why the node of the 'blocked' demo cannot catch up (as the node logs it). */
const BLOCKED_REASON = 'the peers ahead are validators this tab did not know before, and none of them can send the missing ledgers';

interface SimNode {
  kp: Keypair;
  id: string;
  name: string;
  self: boolean;
  validator: boolean;
  online: boolean;
  state: SyncState;
  transports: string[];
  latencyMs: number;
  lastSeen: number;
  lastSlot: number;
}

interface DemoAccount {
  name: string;
  kp: Keypair;
}

interface TxBatch {
  add: (kp: Keypair, ops: xdr.Operation[], memo?: Memo) => void;
  txs: ParsedTx[];
}

interface StoredLedger {
  summary: LedgerSummary;
  headerXdr: string;
  header: Record<string, string | number>;
  txHashes: string[];
}

/** Steps of a simulated slot; each node emits one statement per step. */
const STEP_OFFSETS = [0, 380, 760, 1050, 1300, 1550, 1800];

interface SlotRun {
  slot: number;
  startedAt: number;
  phase: ScpPhase;
  round: number;
  leaders: string[];
  leader: SimNode | null;
  value: ValueView | null;
  valueHex: string | null;
  txs: ParsedTx[];
  closeTime: number;
  counter: number;
  votes: ValueView[];
  accepted: ValueView[];
  candidates: ValueView[];
  ballot: BallotView | null;
  prepared: BallotView | null;
  high: BallotView | null;
  commit: BallotView | null;
  heardFromQuorum: boolean;
  /** Latest step (1..7) each node reached. */
  reached: Map<string, number>;
  states: Map<string, ScpNodeStateView>;
  /** Slot-level progress from this node's point of view (0..7). */
  progress: number;
  /** Self statements waiting for slot progress. */
  selfPending: number[];
  externalized: ValueView | null;
  externalizedAt: number | null;
  nominatedAt: number | null;
  closing: boolean;
}

const OTHER_NAMES = ['Vega', 'Altair', 'Deneb', 'Rigel', 'Lyra', 'Mira', 'Castor'];
const DEMO_NAMES = ['anchor', 'goldsmith', 'maker', 'alice', 'bob', 'carol', 'dave', 'erin'];
const MEMOS = ['coffee', 'rent', 'thanks!', 'invoice 1042', 'lunch split', 'refund', 'gift', 'payroll', 'test'];

function amountStr(stroops: bigint): string {
  return stroopsToString(stroops);
}

/** Random amount with 2 decimals between min and max whole units. */
function randAmount(rng: Rng, min: number, max: number): string {
  const v = min + rng() * (max - min);
  return v.toFixed(2);
}

export class MockNode implements NodeApi {
  readonly clock: Clock;
  readonly passphrase: string;
  readonly networkName: string;
  readonly networkIdHex: string;
  private readonly rng: Rng;
  private readonly opts: Required<Omit<MockNodeOptions, 'clock' | 'name' | 'demo'>> & { name?: string };
  private readonly ledger: MockLedger;
  private readonly listeners = new Set<(ev: NodeEvent) => void>();
  private readonly timers = new Set<TimerHandle>();
  private running = false;

  private readonly nodes: SimNode[] = [];
  private readonly self: SimNode;
  private validating = true;
  private state: SyncState = 'booting';
  private catchup: NodeStatus['catchup'] = null;
  private readonly startedAt: number;
  private quorumMode: 'auto' | 'manual' = 'auto';
  private manualQset: QuorumSetView | null = null;
  private selfQset: QuorumSetView = { threshold: 1, validators: [], innerSets: [] };

  private readonly ledgers = new Map<number, StoredLedger>();
  private readonly txs = new Map<string, TxDetail>();
  private lclSeq = 1;
  private lclHash = '0'.repeat(64);
  private lclCloseTime = 0;
  private liveCloses = 0;

  private mempool: { parsed: ParsedTx; addedAtLedger: number }[] = [];
  private readonly scpEvents: ScpEventView[] = [];
  private readonly logs: LogEntry[] = [];
  private readonly forks: ForkInfo[] = [];
  private readonly slotHistory = new Map<number, ScpSlotView>();
  private run: SlotRun | null = null;
  private lastNominationAt = 0;
  private stallTimer: TimerHandle | null = null;
  private friendbotCounter = 0;
  /** Hashes submitted through this node (they get txStatus events). */
  private readonly ownTx = new Set<string>();
  /** The slot that just closed; late statements for it still reach the SCP log. */
  private closedRun: SlotRun | null = null;

  /** The demo state being played; a resync ends it. */
  private demoState: MockDemo | null;
  /** 'strangers': the other group's validators (this node never saw them). */
  private readonly strangers: string[];
  /** 'strangers': first ledger where their chain differs from ours. */
  private strangerAtSeq: number | null = null;
  private strangerReports = 0;
  private strangerTimer: TimerHandle | null = null;
  /** 'blocked': the ledger the peers announce. */
  private blockedTarget: number | null = null;

  private readonly root: Keypair;
  private readonly channels: Keypair[] = [];
  private readonly demo: DemoAccount[] = [];
  private readonly extraUsers: DemoAccount[] = [];
  private readonly usd: AssetView;
  private readonly eur: AssetView;
  private readonly gold: AssetView;

  constructor(options: MockNodeOptions = {}) {
    this.clock = options.clock ?? new RealClock();
    this.opts = {
      seed: options.seed ?? 20261015,
      networkName: options.networkName ?? DEFAULT_NETWORK_NAME,
      validators: Math.min(7, Math.max(2, options.validators ?? 5)),
      historyLedgers: options.historyLedgers ?? 48,
      bootMs: options.bootMs ?? 1600,
      traffic: options.traffic ?? true,
      churn: options.churn ?? true,
      forks: options.forks ?? !options.demo,
      autoStart: options.autoStart ?? true,
      name: options.name,
    };
    this.demoState = options.demo ?? null;
    this.rng = seededRng(this.opts.seed);
    this.networkName = this.opts.networkName;
    this.passphrase = networkPassphrase(this.networkName);
    this.networkIdHex = sha256Hex(this.passphrase);
    this.ledger = new MockLedger(this.passphrase);
    this.startedAt = this.clock.now();

    // Validators: this node first, then named peers. Keys are derived from the seed.
    const seedKey = (label: string) => Keypair.fromRawEd25519Seed(sha256(`browserchain-mock|${this.opts.seed}|${label}`));
    const selfKp = seedKey('self');
    this.self = {
      kp: selfKp,
      id: selfKp.publicKey(),
      name: this.opts.name ?? `tab-${selfKp.publicKey().slice(1, 5).toLowerCase()}`,
      self: true,
      validator: true,
      online: true,
      state: 'booting',
      transports: [],
      latencyMs: 0,
      lastSeen: this.startedAt,
      lastSlot: 0,
    };
    this.nodes.push(this.self);
    for (let i = 0; i < this.opts.validators - 1; i++) {
      const kp = seedKey(`validator-${i}`);
      const webrtc = i % 2 === 1;
      this.nodes.push({
        kp,
        id: kp.publicKey(),
        name: OTHER_NAMES[i % OTHER_NAMES.length],
        self: false,
        validator: true,
        online: true,
        state: 'synced',
        transports: webrtc ? ['webrtc'] : i === 0 ? ['broadcast', 'webrtc'] : ['broadcast'],
        latencyMs: webrtc ? 40 + Math.floor(this.rng() * 120) : 1 + Math.floor(this.rng() * 4),
        lastSeen: this.startedAt,
        lastSlot: 0,
      });
    }
    this.strangers = Array.from({ length: STRANGERS }, (_, i) => seedKey(`stranger-${i}`).publicKey());
    const watcherKp = seedKey('watcher');
    this.nodes.push({
      kp: watcherKp,
      id: watcherKp.publicKey(),
      name: 'observer',
      self: false,
      validator: false,
      online: true,
      state: 'synced',
      transports: ['webrtc'],
      latencyMs: 90,
      lastSeen: this.startedAt,
      lastSlot: 0,
    });

    // Genesis accounts as in the architecture doc.
    this.root = Keypair.master(this.passphrase);
    const channelTotal = BigInt(FRIENDBOT_CHANNELS) * FRIENDBOT_CHANNEL_BALANCE;
    this.ledger.createAccountDirect(this.root.publicKey(), TOTAL_COINS - channelTotal, 1);
    for (let i = 0; i < FRIENDBOT_CHANNELS; i++) {
      const kp = Keypair.fromRawEd25519Seed(sha256(`${this.passphrase}|friendbot|${i}`));
      this.channels.push(kp);
      this.ledger.createAccountDirect(kp.publicKey(), FRIENDBOT_CHANNEL_BALANCE, 1);
    }
    for (const name of DEMO_NAMES) this.demo.push({ name, kp: seedKey(`demo-${name}`) });
    const anchor = this.demoKp('anchor').publicKey();
    this.usd = { type: 'credit_alphanum4', code: 'USDB', issuer: anchor };
    this.eur = { type: 'credit_alphanum4', code: 'EURB', issuer: anchor };
    this.gold = { type: 'credit_alphanum4', code: 'GOLD', issuer: this.demoKp('goldsmith').publicKey() };

    this.selfQset = this.computeAutoQset();
    this.buildGenesis();
    this.buildHistory();
    this.log('info', 'node', `node ${this.self.name} (${this.self.id.slice(0, 8)}…) starting on network "${this.networkName}"`);
    if (this.opts.autoStart) this.start();
  }

  // ================================================================ lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.setState('booting');
    const boot = this.opts.bootMs;
    if (boot <= 0) {
      this.bootDone();
    } else {
      this.after(boot * 0.45, () => {
        this.catchup = { target: this.lclSeq, current: Math.max(1, this.lclSeq - 6), source: this.nodes[1]?.id ?? null };
        this.setState('catching-up');
        this.log('info', 'history', `catching up to ledger ${this.lclSeq} from ${this.nodes[1]?.name ?? 'peer'}`);
        const steps = 4;
        for (let i = 1; i <= steps; i++) {
          this.after(((boot * 0.55) / steps) * i, () => {
            // the last step is due with bootDone, which may have blocked us
            if (!this.catchup || this.catchup.blocked !== undefined) return;
            this.catchup = { ...this.catchup, current: Math.min(this.catchup.target, this.catchup.current + 2) };
            this.emitStatus();
          });
        }
      });
      this.after(boot, () => this.bootDone());
    }
    this.scheduleBeacons();
    if (this.opts.churn) this.scheduleChurn();
    if (this.opts.forks) this.scheduleFork();
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
    this.run = null;
  }

  private after(ms: number, fn: () => void): TimerHandle {
    const h = this.clock.setTimeout(() => {
      this.timers.delete(h);
      if (this.running) fn();
    }, Math.max(0, ms));
    this.timers.add(h);
    return h;
  }

  private cancel(h: TimerHandle | null): void {
    if (h === null) return;
    this.clock.clearTimeout(h);
    this.timers.delete(h);
  }

  private bootDone(): void {
    if (this.demoState === 'blocked') this.becomeBlocked();
    else this.becomeSynced();
  }

  private becomeSynced(): void {
    this.catchup = null;
    this.self.state = 'synced';
    this.setState('synced');
    this.log('info', 'herder', `in sync at ledger ${this.lclSeq}; joining consensus`);
    this.armStallWatch();
    this.emitPeers();
    if (!this.run) this.openSlot();
    if (this.demoState === 'strangers') this.scheduleStrangerReport(1500);
  }

  /**
   * Demo 'blocked': the validators we follow are ahead, none of them can
   * serve the ledgers, and voting alone would build a branch of our own. We
   * stay 'catching-up' and do not vote; the others keep closing ledgers.
   */
  private becomeBlocked(): void {
    this.blockedTarget = this.lclSeq + 9;
    this.catchup = { target: this.blockedTarget, current: this.lclSeq, source: null, blocked: BLOCKED_REASON };
    if (this.state === 'catching-up') this.emitStatus();
    else this.setState('catching-up');
    this.emitPeers();
    this.log(
      'warn',
      'node',
      `not voting: peers are at ledger ${this.blockedTarget} and we cannot catch up from ledger ${this.lclSeq} (${BLOCKED_REASON})`,
    );
    this.scheduleBlockedPeers();
  }

  private scheduleBlockedPeers(): void {
    this.after(LEDGER_TARGET_CLOSE_MS, () => {
      if (this.demoState !== 'blocked' || this.blockedTarget === null || !this.catchup) return;
      this.blockedTarget++;
      this.catchup = { ...this.catchup, target: this.blockedTarget };
      this.emitStatus();
      this.emitPeers();
      this.scheduleBlockedPeers();
    });
  }

  /**
   * Demo 'strangers': a group of validators that this node never saw runs
   * another chain since ledger `strangerAtSeq`. Auto mode keeps ours (only
   * validators known before the fork count) and reports the fork again at
   * most every 10 s while it lasts.
   */
  private scheduleStrangerReport(ms: number): void {
    if (this.strangerTimer !== null) return;
    this.strangerTimer = this.after(ms, () => {
      this.strangerTimer = null;
      if (this.demoState !== 'strangers') return;
      this.reportStrangers();
      this.scheduleStrangerReport(STRANGER_REPORT_MS);
    });
  }

  private reportStrangers(): void {
    this.strangerAtSeq ??= Math.max(2, this.lclSeq - 3);
    const atSeq = this.strangerAtSeq;
    const ours = this.ledgers.get(atSeq)?.summary.hash ?? this.lclHash;
    const peer = this.strangers[this.strangerReports % this.strangers.length];
    this.strangerReports++;
    const info: ForkInfo = {
      ts: this.clock.now(),
      atSeq,
      ourHash: ours,
      theirHash: sha256Hex(`${ours}|strangers`),
      peer,
      resolution: 'kept-ours',
      rolledBackLedgers: 0,
      unknownValidators: this.strangers.length,
    };
    this.forks.push(info);
    if (this.forks.length > 50) this.forks.shift();
    this.log(
      this.strangerReports === 1 ? 'warn' : 'debug',
      'history',
      `fork with ${peer.slice(0, 8)} after ledger ${atSeq - 1}: no validator we knew before is on their branch, ${this.strangers.length} we did not know announce it -> keep ours`,
    );
    this.emit({ type: 'fork', info });
  }

  private setState(s: SyncState): void {
    if (this.state === s) return;
    this.state = s;
    this.self.state = s;
    this.emitStatus();
  }

  // ================================================================ events

  subscribe(listener: (ev: NodeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(ev: NodeEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (err) {
        console.error('mock node listener failed', err);
      }
    }
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.buildStatus() });
  }

  private emitPeers(): void {
    this.emit({ type: 'peers', peers: this.buildPeers() });
  }

  private log(level: LogLevel, scope: string, msg: string): void {
    const entry: LogEntry = { ts: this.clock.now(), level, scope, msg };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this.emit({ type: 'log', entry });
  }

  // ================================================================ world setup

  private demoKp(name: string): Keypair {
    const d = this.demo.find((x) => x.name === name);
    if (!d) throw new Error(`no demo account ${name}`);
    return d.kp;
  }

  private buildGenesis(): void {
    const header: Record<string, string | number> = {
      ledgerVersion: PROTOCOL_VERSION,
      ledgerSeq: 1,
      previousLedgerHash: '0'.repeat(64),
      txSetHash: '0'.repeat(64),
      closeTime: 0,
      totalCoins: amountStr(TOTAL_COINS),
      feePool: '0.0000000',
      baseFee: BASE_FEE,
      baseReserve: BASE_RESERVE,
      maxTxSetSize: MAX_TX_SET_SIZE,
      scpValueType: 'STELLAR_VALUE_BASIC',
    };
    const built = this.buildHeader({ seq: 1, prevHash: '0'.repeat(64), txSetHash: '0'.repeat(64), resultHash: '0'.repeat(64), closeTime: 0, proposer: null });
    const summary: LedgerSummary = {
      seq: 1,
      hash: built.hash,
      prevHash: '0'.repeat(64),
      closeTime: 0,
      txCount: 0,
      opCount: 0,
      failedTxCount: 0,
      baseFee: BASE_FEE,
      baseReserve: BASE_RESERVE,
      totalCoins: amountStr(TOTAL_COINS),
      feePool: '0.0000000',
      protocolVersion: PROTOCOL_VERSION,
      txSetHash: '0'.repeat(64),
      stateHash: built.stateHash,
      proposer: null,
      closedAt: this.startedAt - (this.opts.historyLedgers + 1) * LEDGER_TARGET_CLOSE_MS,
      externalizedBy: 0,
    };
    this.ledgers.set(1, { summary, headerXdr: built.headerXdr, header: { ...header, bucketListHash: built.stateHash, hash: built.hash }, txHashes: [] });
    this.lclSeq = 1;
    this.lclHash = built.hash;
    this.lclCloseTime = 0;
  }

  /** Signed tx from a demo/root/channel key; sequence from ledger + `extra` queued. */
  private signedTx(kp: Keypair, ops: xdr.Operation[], extraSeq: number, memo?: Memo): ParsedTx {
    const acc = this.ledger.accounts.get(kp.publicKey());
    if (!acc) throw new Error(`no account ${kp.publicKey()}`);
    const seq = (acc.seq + BigInt(extraSeq)).toString();
    const b = new TransactionBuilder(new Account(kp.publicKey(), seq), { fee: String(BASE_FEE), networkPassphrase: this.passphrase, memo });
    for (const op of ops) b.addOperation(op);
    b.setTimeout(TimeoutInfinite);
    const tx = b.build();
    tx.sign(kp);
    return this.ledger.parse(tx.toEnvelope().toXdr('base64'));
  }

  /** Builds txs for one history ledger while tracking per-source sequence offsets. */
  private batch(): TxBatch {
    const counts = new Map<string, number>();
    const txs: ParsedTx[] = [];
    return {
      txs,
      add: (kp, ops, memo) => {
        const n = counts.get(kp.publicKey()) ?? 0;
        txs.push(this.signedTx(kp, ops, n, memo));
        counts.set(kp.publicKey(), n + 1);
      },
    };
  }

  private buildHistory(): void {
    const total = this.opts.historyLedgers;
    if (total <= 0) return;
    const nowSec = Math.floor(this.clock.now() / 1000);
    const startClose = nowSec - total * (LEDGER_TARGET_CLOSE_MS / 1000) - 2;
    const usd = assetToSdk(this.usd);
    const eur = assetToSdk(this.eur);
    const gold = assetToSdk(this.gold);
    const pk = (n: string) => this.demoKp(n).publicKey();

    for (let i = 0; i < total; i++) {
      const b = this.batch();
      switch (i) {
        case 0:
          b.add(
            this.root,
            DEMO_NAMES.map((n) => Operation.createAccount({ destination: pk(n), startingBalance: n === 'maker' ? '250000' : '25000' })),
            Memo.text('genesis drop'),
          );
          break;
        case 1:
          b.add(this.demoKp('maker'), [Operation.changeTrust({ asset: usd }), Operation.changeTrust({ asset: eur }), Operation.changeTrust({ asset: gold })]);
          b.add(this.demoKp('alice'), [Operation.changeTrust({ asset: usd }), Operation.changeTrust({ asset: gold })]);
          b.add(this.demoKp('bob'), [Operation.changeTrust({ asset: usd }), Operation.changeTrust({ asset: eur })]);
          b.add(this.demoKp('carol'), [Operation.changeTrust({ asset: gold }), Operation.changeTrust({ asset: usd })]);
          b.add(this.demoKp('dave'), [Operation.changeTrust({ asset: usd })]);
          b.add(this.demoKp('erin'), [Operation.changeTrust({ asset: eur }), Operation.changeTrust({ asset: usd })]);
          b.add(this.demoKp('anchor'), [Operation.setOptions({ homeDomain: 'harbor.example' })]);
          b.add(this.demoKp('goldsmith'), [Operation.setOptions({ homeDomain: 'goldsmith.example' })]);
          break;
        case 2:
          b.add(
            this.demoKp('anchor'),
            [
              Operation.payment({ destination: pk('maker'), asset: usd, amount: '150000' }),
              Operation.payment({ destination: pk('maker'), asset: eur, amount: '120000' }),
              Operation.payment({ destination: pk('alice'), asset: usd, amount: '2500' }),
              Operation.payment({ destination: pk('bob'), asset: usd, amount: '1200' }),
              Operation.payment({ destination: pk('bob'), asset: eur, amount: '900' }),
              Operation.payment({ destination: pk('carol'), asset: usd, amount: '640' }),
              Operation.payment({ destination: pk('dave'), asset: usd, amount: '800' }),
              Operation.payment({ destination: pk('erin'), asset: eur, amount: '1500' }),
            ],
            Memo.text('initial issuance'),
          );
          b.add(this.demoKp('goldsmith'), [
            Operation.payment({ destination: pk('maker'), asset: gold, amount: '400' }),
            Operation.payment({ destination: pk('carol'), asset: gold, amount: '25' }),
            Operation.payment({ destination: pk('alice'), asset: gold, amount: '3.5' }),
          ]);
          break;
        case 3:
          b.add(this.demoKp('maker'), this.makerLadderOps());
          break;
        case 4:
          b.add(this.demoKp('alice'), [Operation.manageData({ name: 'nickname', value: 'alice in chains' })]);
          b.add(this.demoKp('anchor'), [
            Operation.createClaimableBalance({
              asset: usd,
              amount: '50',
              claimants: [new Claimant(pk('alice'), Claimant.predicateUnconditional()), new Claimant(pk('anchor'), Claimant.predicateUnconditional())],
            }),
          ]);
          b.add(this.demoKp('bob'), [
            Operation.createClaimableBalance({
              asset: Asset.native(),
              amount: '75',
              claimants: [new Claimant(pk('carol'), Claimant.predicateBeforeRelativeTime('86400'))],
            }),
          ]);
          break;
        default:
          this.trafficTxs(this.trafficCount(), b);
      }
      const closeTime = startClose + i * 5 + (this.rng() < 0.2 ? 1 : 0);
      const closedAt = closeTime * 1000 + Math.floor(this.rng() * 400);
      const validators = this.nodes.filter((n) => n.validator);
      const proposer = validators[Math.floor(this.rng() * validators.length)] ?? this.self;
      this.closeLedger(b.txs, { closeTime, closedAt, proposer, externalizedBy: this.opts.validators, live: false });
    }
  }

  private makerLadderOps(): xdr.Operation[] {
    const usd = assetToSdk(this.usd);
    const eur = assetToSdk(this.eur);
    const gold = assetToSdk(this.gold);
    const xlm = Asset.native();
    const ops: xdr.Operation[] = [];
    // Asks: maker sells the credit asset for XLM. Bids: maker sells XLM for the credit asset.
    const ladder: [Asset, number, string][] = [
      [usd, 8.4, '1800'],
      [eur, 9.1, '1500'],
      [gold, 2150, '6'],
    ];
    for (const [asset, mid, size] of ladder) {
      for (let k = 0; k < 3; k++) {
        const ask = (mid * (1.004 + k * 0.006)).toFixed(4);
        const bid = mid * (0.996 - k * 0.006);
        ops.push(Operation.manageSellOffer({ selling: asset, buying: xlm, amount: (Number(size) * (1 + k * 0.5)).toFixed(2), price: ask }));
        const xlmAmount = (Number(size) * bid * (1 + k * 0.4)).toFixed(2);
        ops.push(Operation.manageSellOffer({ selling: xlm, buying: asset, amount: xlmAmount, price: (1 / bid).toFixed(7) }));
      }
    }
    return ops;
  }

  // ================================================================ traffic

  private trafficCount(): number {
    const r = this.rng();
    if (r < 0.12) return 0;
    if (r < 0.35) return 1;
    if (r < 0.62) return 2;
    if (r < 0.82) return 3;
    if (r < 0.94) return 4;
    return 6;
  }

  private users(): DemoAccount[] {
    const base = this.demo.filter((d) => ['alice', 'bob', 'carol', 'dave', 'erin', 'maker'].includes(d.name));
    return [...base, ...this.extraUsers].filter((u) => this.ledger.accounts.has(u.kp.publicKey()));
  }

  private pickUser(exclude?: string): DemoAccount {
    const list = this.users().filter((u) => u.kp.publicKey() !== exclude);
    return list[Math.floor(this.rng() * list.length)];
  }

  private holds(u: DemoAccount, a: AssetView): boolean {
    return this.ledger.trust.has(`${u.kp.publicKey()}|${a.code}:${a.issuer}`);
  }

  /** Random txs from other clients. Adds to `b` and returns its txs. */
  private trafficTxs(count: number, b: TxBatch = this.batch()): ParsedTx[] {
    for (let i = 0; i < count; i++) {
      try {
        this.oneTrafficTx(b);
      } catch {
        // skip a tx that cannot be built right now
      }
    }
    return b.txs;
  }

  private oneTrafficTx(b: TxBatch): void {
    const r = this.rng();
    const credit = [this.usd, this.eur, this.gold];
    if (r < 0.36) {
      const from = this.pickUser();
      const to = this.pickUser(from.kp.publicKey());
      const memo = this.rng() < 0.4 ? Memo.text(MEMOS[Math.floor(this.rng() * MEMOS.length)]) : this.rng() < 0.1 ? Memo.id(String(1000 + Math.floor(this.rng() * 90000))) : undefined;
      b.add(from.kp, [Operation.payment({ destination: to.kp.publicKey(), asset: Asset.native(), amount: randAmount(this.rng, 1, 420) })], memo);
    } else if (r < 0.56) {
      const asset = credit[Math.floor(this.rng() * credit.length)];
      const holders = this.users().filter((u) => this.holds(u, asset));
      if (holders.length < 2) return;
      const from = holders[Math.floor(this.rng() * holders.length)];
      const to = holders.filter((h) => h !== from)[Math.floor(this.rng() * (holders.length - 1))];
      const amount = asset === this.gold ? (0.1 + this.rng() * 1.5).toFixed(3) : randAmount(this.rng, 5, 160);
      b.add(from.kp, [Operation.payment({ destination: to.kp.publicKey(), asset: assetToSdk(asset), amount })]);
    } else if (r < 0.7) {
      // The market maker moves one of its offers.
      const maker = this.demoKp('maker');
      const mine = [...this.ledger.offers.values()].filter((o) => o.seller === maker.publicKey());
      if (mine.length === 0) {
        b.add(maker, this.makerLadderOps().slice(0, 4));
        return;
      }
      const o = mine[Math.floor(this.rng() * mine.length)];
      const drift = 1 + (this.rng() - 0.5) * 0.01;
      const price = ((o.n / o.d) * drift).toPrecision(7);
      const amount = (Number(amountStr(o.amount)) * (0.8 + this.rng() * 0.4)).toFixed(2);
      b.add(maker, [Operation.manageSellOffer({ selling: assetToSdk(o.selling), buying: assetToSdk(o.buying), amount, price, offerId: o.id.toString() })]);
    } else if (r < 0.78) {
      // A user takes liquidity: sells some USDB for XLM at a crossing price.
      const asset = this.rng() < 0.6 ? this.usd : this.eur;
      const sellers = this.users().filter((u) => u.name !== 'maker' && this.holds(u, asset));
      if (sellers.length === 0) return;
      const u = sellers[Math.floor(this.rng() * sellers.length)];
      const book = this.ledger.orderBook(asset, { type: 'native', code: 'XLM' }, 1);
      const best = book.bids[0];
      if (!best) return;
      const price = (Number(best.price) * 0.995).toFixed(7);
      b.add(u.kp, [Operation.manageSellOffer({ selling: assetToSdk(asset), buying: Asset.native(), amount: randAmount(this.rng, 2, 40), price })], Memo.text('market sell'));
    } else if (r < 0.84) {
      if (this.extraUsers.length >= 24) return;
      const funder = this.pickUser();
      const kp = Keypair.fromRawEd25519Seed(sha256(`browserchain-mock|${this.opts.seed}|user-${this.extraUsers.length}`));
      b.add(funder.kp, [Operation.createAccount({ destination: kp.publicKey(), startingBalance: randAmount(this.rng, 50, 900) })], Memo.text('welcome'));
      this.extraUsers.push({ name: `user-${this.extraUsers.length + 1}`, kp });
    } else if (r < 0.88) {
      const candidates = this.users().filter((u) => !this.holds(u, this.usd));
      if (candidates.length === 0) return;
      const u = candidates[Math.floor(this.rng() * candidates.length)];
      b.add(u.kp, [Operation.changeTrust({ asset: assetToSdk(this.usd) })]);
    } else if (r < 0.93) {
      const now = this.lclCloseTime + 5;
      const claimable = [...this.ledger.claimables.values()].find((c) =>
        c.claimants.some((x) => this.users().some((u) => u.kp.publicKey() === x.destination) && (x.predicate.type !== 'beforeAbsoluteTime' || BigInt(x.predicate.time) > BigInt(now))),
      );
      if (claimable && this.rng() < 0.5) {
        const claimant = claimable.claimants.find((x) => this.users().some((u) => u.kp.publicKey() === x.destination))!;
        const u = this.users().find((x) => x.kp.publicKey() === claimant.destination)!;
        if (claimable.asset.type !== 'native' && !this.holds(u, claimable.asset) && claimable.asset.issuer !== claimant.destination) return;
        b.add(u.kp, [Operation.claimClaimableBalance({ balanceId: `00000000${claimable.id}` })]);
      } else {
        const from = this.pickUser();
        const to = this.pickUser(from.kp.publicKey());
        b.add(from.kp, [
          Operation.createClaimableBalance({
            asset: Asset.native(),
            amount: randAmount(this.rng, 5, 60),
            claimants: [new Claimant(to.kp.publicKey(), Claimant.predicateBeforeRelativeTime(String(3600 * (1 + Math.floor(this.rng() * 48)))))],
          }),
        ]);
      }
    } else if (r < 0.96) {
      const u = this.pickUser();
      const names = ['status', 'website', 'score', 'nickname'];
      const name = names[Math.floor(this.rng() * names.length)];
      b.add(u.kp, [Operation.manageData({ name, value: name === 'score' ? String(Math.floor(this.rng() * 1000)) : `${u.name}-${Math.floor(this.rng() * 100)}` })]);
    } else {
      // A failing payment (more than the sender has) shows up as txFAILED.
      const from = this.pickUser();
      const to = this.pickUser(from.kp.publicKey());
      const holder = this.holds(from, this.usd);
      b.add(from.kp, [
        Operation.payment({
          destination: to.kp.publicKey(),
          asset: holder ? assetToSdk(this.usd) : Asset.native(),
          amount: holder ? '9999999' : '900000000',
        }),
      ]);
    }
  }

  // ================================================================ ledger close

  private buildHeader(h: {
    seq: number;
    prevHash: string;
    txSetHash: string;
    resultHash: string;
    closeTime: number;
    proposer: SimNode | null;
  }): { headerXdr: string; hash: string; stateHash: string; valueHex: string } {
    const stateHash = sha256Hex(this.ledger.digestInput());
    let ext: xdr.StellarValueExt;
    if (h.proposer) {
      const payload = concatBytes(fromHex(this.networkIdHex), writeUint32BE(4), fromHex(h.txSetHash), writeUint64BE(BigInt(h.closeTime)));
      const sig = h.proposer.kp.sign(payload);
      ext = xdr.StellarValueExt.stellarValueSigned(
        new xdr.LedgerCloseValueSignature({ nodeId: xdr.PublicKey.publicKeyTypeEd25519(h.proposer.kp.rawPublicKey()), signature: sig }),
      );
    } else {
      ext = xdr.StellarValueExt.stellarValueBasic();
    }
    const sv = new xdr.StellarValue({
      txSetHash: fromHex(h.txSetHash),
      closeTime: BigInt(h.closeTime),
      upgrades: [],
      ext,
    });
    const zero = new Uint8Array(32);
    const header = new xdr.LedgerHeader({
      ledgerVersion: PROTOCOL_VERSION,
      previousLedgerHash: fromHex(h.prevHash),
      scpValue: sv,
      txSetResultHash: fromHex(h.resultHash),
      bucketListHash: fromHex(stateHash),
      ledgerSeq: h.seq,
      totalCoins: xdr.Int64.fromString(TOTAL_COINS.toString()),
      feePool: xdr.Int64.fromString(this.ledger.feePool.toString()),
      inflationSeq: 0,
      idPool: xdr.Uint64.fromString(this.ledger.idPool.toString()),
      baseFee: BASE_FEE,
      baseReserve: BASE_RESERVE,
      maxTxSetSize: MAX_TX_SET_SIZE,
      skipList: [zero, zero, zero, zero],
      ext: xdr.LedgerHeaderExt.v0(),
    });
    const raw = header.toXdr();
    return { headerXdr: toBase64(raw), hash: sha256Hex(raw), stateHash, valueHex: sv.toXdr('hex') };
  }

  /** stellar-core legacy apply order: per-source seq chains, batched, each batch sorted by hash. */
  private applyOrder(txs: ParsedTx[], txSetHash: string): ParsedTx[] {
    const bySource = new Map<string, ParsedTx[]>();
    for (const t of txs) {
      const list = bySource.get(t.source) ?? [];
      list.push(t);
      bySource.set(t.source, list);
    }
    for (const list of bySource.values()) list.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    const out: ParsedTx[] = [];
    const xorKey = (h: string) => {
      let s = '';
      for (let i = 0; i < 64; i += 2) s += (parseInt(h.slice(i, i + 2), 16) ^ parseInt(txSetHash.slice(i, i + 2), 16)).toString(16).padStart(2, '0');
      return s;
    };
    for (let k = 0; ; k++) {
      const batch = [...bySource.values()].map((l) => l[k]).filter(Boolean);
      if (batch.length === 0) break;
      batch.sort((a, b) => (xorKey(a.hash) < xorKey(b.hash) ? -1 : 1));
      out.push(...batch);
    }
    return out;
  }

  private txSetHashOf(txs: ParsedTx[]): string {
    const sorted = [...txs].sort((a, b) => (a.hash < b.hash ? -1 : 1));
    return sha256Hex(this.lclHash + sorted.map((t) => t.hash).join(''));
  }

  private closeLedger(
    txs: ParsedTx[],
    o: { closeTime: number; closedAt: number; proposer: SimNode | null; externalizedBy: number; live: boolean },
  ): { summary: LedgerSummary; details: TxDetail[] } {
    const seq = this.lclSeq + 1;
    const txSetHash = this.txSetHashOf(txs);
    const ordered = this.applyOrder(txs, txSetHash);
    const applied = this.ledger.applyTxSet(ordered, { ledgerSeq: seq, closeTime: o.closeTime });
    const resultHash = sha256Hex(applied.map((a) => a.resultXdr).join('|') || 'empty');
    const built = this.buildHeader({ seq, prevHash: this.lclHash, txSetHash, resultHash, closeTime: o.closeTime, proposer: o.proposer });
    const details = applied.map((a, i) => this.txDetail(a, i, seq, o.closeTime));
    const opCount = applied.reduce((s, a) => s + a.parsed.opCount, 0);
    const summary: LedgerSummary = {
      seq,
      hash: built.hash,
      prevHash: this.lclHash,
      closeTime: o.closeTime,
      txCount: applied.length,
      opCount,
      failedTxCount: applied.filter((a) => !a.successful).length,
      baseFee: BASE_FEE,
      baseReserve: BASE_RESERVE,
      totalCoins: amountStr(TOTAL_COINS),
      feePool: amountStr(this.ledger.feePool),
      protocolVersion: PROTOCOL_VERSION,
      txSetHash,
      stateHash: built.stateHash,
      proposer: o.proposer?.id ?? null,
      closedAt: o.closedAt,
      externalizedBy: o.externalizedBy,
    };
    const header: Record<string, string | number> = {
      ledgerVersion: PROTOCOL_VERSION,
      ledgerSeq: seq,
      hash: built.hash,
      previousLedgerHash: this.lclHash,
      txSetHash,
      closeTime: o.closeTime,
      txSetResultHash: resultHash,
      bucketListHash: built.stateHash,
      totalCoins: amountStr(TOTAL_COINS),
      feePool: amountStr(this.ledger.feePool),
      inflationSeq: 0,
      idPool: this.ledger.idPool.toString(),
      baseFee: BASE_FEE,
      baseReserve: BASE_RESERVE,
      maxTxSetSize: MAX_TX_SET_SIZE,
      scpValueType: o.proposer ? 'STELLAR_VALUE_SIGNED' : 'STELLAR_VALUE_BASIC',
      proposer: o.proposer?.id ?? '',
    };
    for (const d of details) this.txs.set(d.hash, d);
    this.ledgers.set(seq, { summary, headerXdr: built.headerXdr, header, txHashes: details.map((d) => d.hash) });
    this.lclSeq = seq;
    this.lclHash = built.hash;
    this.lclCloseTime = o.closeTime;
    this.trimHistory();
    return { summary, details };
  }

  private trimHistory(): void {
    const keep = 3000;
    if (this.ledgers.size <= keep) return;
    const cutoff = this.lclSeq - keep;
    for (const [seq, l] of this.ledgers) {
      if (seq > cutoff) continue;
      for (const h of l.txHashes) this.txs.delete(h);
      this.ledgers.delete(seq);
    }
  }

  private txDetail(a: AppliedTx, applyIndex: number, ledgerSeq: number, closeTime: number): TxDetail {
    const tx = a.parsed.tx;
    const memo = tx.memo;
    let memoValue: string | null = null;
    if (memo.type !== 'none' && memo.value !== null && memo.value !== undefined) {
      memoValue = typeof memo.value === 'string' ? memo.value : memo.type === 'text' ? new TextDecoder().decode(memo.value) : toHex(memo.value);
    }
    return {
      hash: a.parsed.hash,
      ledgerSeq,
      applyIndex,
      sourceAccount: a.parsed.source,
      feeCharged: amountStr(a.feeCharged),
      maxFee: amountStr(a.parsed.maxFee),
      opCount: a.parsed.opCount,
      successful: a.successful,
      resultCode: a.resultCode,
      memo: { type: memo.type, value: memoValue },
      closeTime,
      operations: a.operations,
      envelopeXdr: a.parsed.envelopeXdr,
      resultXdr: a.resultXdr,
      signatures: tx.signatures.map((s) => ({ hint: toHex(s.hint.toBytes()), signature: toHex(s.signature.toBytes()) })),
    };
  }

  private toSummary(d: TxDetail): TxSummary {
    const { envelopeXdr: _e, resultXdr: _r, signatures: _s, ...rest } = d;
    return rest;
  }

  // ================================================================ SCP simulation

  private participants(): SimNode[] {
    return this.nodes.filter((n) => n.validator && n.online && (!n.self || this.validating));
  }

  private computeAutoQset(): QuorumSetView {
    const ids = this.nodes.filter((n) => n.validator && (n.self || (n.online && n.state === 'synced'))).map((n) => n.id).sort();
    return { threshold: autoThreshold(ids.length), validators: ids, innerSets: [] };
  }

  private refreshQset(reason?: string): void {
    if (this.quorumMode !== 'auto') return;
    const next = this.computeAutoQset();
    if (JSON.stringify(next) !== JSON.stringify(this.selfQset)) {
      this.selfQset = next;
      if (reason) this.log('info', 'quorum', `auto quorum now ${next.threshold} of ${next.validators.length} (${reason})`);
    }
  }

  private openSlot(): void {
    if (!this.running || this.state === 'catching-up' || this.state === 'booting') return;
    this.refreshQset('slot boundary');
    const slot = this.lclSeq + 1;
    const now = this.clock.now();
    const run: SlotRun = {
      slot,
      startedAt: now,
      phase: 'NOMINATE',
      round: 0,
      leaders: [],
      leader: null,
      value: null,
      valueHex: null,
      txs: [],
      closeTime: 0,
      counter: 1,
      votes: [],
      accepted: [],
      candidates: [],
      ballot: null,
      prepared: null,
      high: null,
      commit: null,
      heardFromQuorum: false,
      reached: new Map(),
      states: new Map(),
      progress: 0,
      selfPending: [],
      externalized: null,
      externalizedAt: null,
      nominatedAt: null,
      closing: false,
    };
    for (const n of this.nodes.filter((x) => x.validator)) {
      run.states.set(n.id, { nodeId: n.id, name: n.name, statement: 'none', ballotCounter: null, summary: '—' });
    }
    this.run = run;
    this.emitSlot();
    this.emitStatus();
    const due = Math.max(this.lastNominationAt + LEDGER_TARGET_CLOSE_MS, now + 350);
    this.after(due - now, () => this.nominate(run));
  }

  private nominate(run: SlotRun): void {
    if (this.run !== run) return;
    const now = this.clock.now();
    this.lastNominationAt = now;
    run.nominatedAt = now;
    run.round = 1;
    const online = this.nodes.filter((n) => n.validator && n.online && (!n.self || this.validating));
    const all = this.nodes.filter((n) => n.validator);
    // Usually an online leader; sometimes an offline one, which forces round 2.
    let leader = online[Math.floor(this.rng() * online.length)] ?? this.self;
    const offline = all.filter((n) => !n.online);
    let delay = 0;
    if (offline.length > 0 && this.rng() < 0.35) {
      run.leaders = [offline[0].id];
      this.emitSlot();
      this.emitStatus();
      delay = 1000;
    }
    this.after(delay, () => {
      if (this.run !== run) return;
      if (delay > 0) run.round = 2;
      leader = leader.online ? leader : this.self;
      run.leader = leader;
      run.leaders = [...new Set([...run.leaders, leader.id])];
      this.buildValue(run);
      this.log('debug', 'scp', `slot ${run.slot} round ${run.round}: leader ${leader.name}, value ${run.value?.id} with ${run.txs.length} txs`);
      const ballotTimeout = this.rng() < 0.08;
      const parts = this.participants();
      for (let step = 1; step <= 7; step++) {
        let at = STEP_OFFSETS[step - 1];
        if (ballotTimeout && step >= 4) at += 700;
        for (const n of parts) {
          const jitter = n.self ? 30 : 40 + Math.floor(this.rng() * 200);
          this.after(at + jitter, () => this.nodeStep(run, n, step));
        }
      }
      if (ballotTimeout) {
        this.after(STEP_OFFSETS[2] + 520, () => {
          if (this.run !== run || run.progress >= 4) return;
          run.counter = 2;
          if (run.ballot) run.ballot = { counter: 2, value: run.ballot.value };
          this.log('info', 'scp', `slot ${run.slot}: ballot timer fired, bumping to counter 2`);
          this.emitSlot();
          for (const n of this.participants()) this.after(40 + Math.floor(this.rng() * 150), () => this.nodeStep(run, n, 3));
        });
      }
      this.emitSlot();
      this.emitStatus();
    });
  }

  private buildValue(run: SlotRun): void {
    const nowSec = Math.floor(this.clock.now() / 1000);
    run.closeTime = Math.max(nowSec, this.lclCloseTime + 1);
    const queued = this.mempool.map((m) => m.parsed);
    const traffic = this.opts.traffic ? this.trafficTxs(this.trafficCount(), this.batchAfterQueue()) : [];
    run.txs = [...queued, ...traffic].slice(0, MAX_TX_SET_SIZE);
    const txSetHash = this.txSetHashOf(run.txs);
    const leader = run.leader ?? this.self;
    const payload = concatBytes(fromHex(this.networkIdHex), writeUint32BE(4), fromHex(txSetHash), writeUint64BE(BigInt(run.closeTime)));
    const sv = new xdr.StellarValue({
      txSetHash: fromHex(txSetHash),
      closeTime: BigInt(run.closeTime),
      upgrades: [],
      ext: xdr.StellarValueExt.stellarValueSigned(
        new xdr.LedgerCloseValueSignature({ nodeId: xdr.PublicKey.publicKeyTypeEd25519(leader.kp.rawPublicKey()), signature: leader.kp.sign(payload) }),
      ),
    });
    run.valueHex = sv.toXdr('hex');
    run.value = { id: sha256Hex(fromHex(run.valueHex)).slice(0, 8), txSetHash, closeTime: run.closeTime, txCount: run.txs.length, proposer: leader.id };
  }

  /** Traffic batch whose sequence numbers start after the queued txs of each source. */
  private batchAfterQueue(): TxBatch {
    const used = new Map<string, number>();
    for (const m of this.mempool) used.set(m.parsed.source, (used.get(m.parsed.source) ?? 0) + 1);
    const txs: ParsedTx[] = [];
    return {
      txs,
      add: (kp, ops, memo) => {
        const n = used.get(kp.publicKey()) ?? 0;
        txs.push(this.signedTx(kp, ops, n, memo));
        used.set(kp.publicKey(), n + 1);
      },
    };
  }

  private statementFor(run: SlotRun, step: number): { type: ScpEventView['type']; summary: string; counter: number | null } {
    const c = run.counter;
    const v = run.value?.id ?? '';
    switch (step) {
      case 1:
        return { type: 'nominate', summary: `NOMINATE votes=[${v}] accepted=[]`, counter: null };
      case 2:
        return { type: 'nominate', summary: `NOMINATE votes=[${v}] accepted=[${v}]`, counter: null };
      case 3:
        return { type: 'prepare', summary: `PREPARE b=${c} p=${c > 1 ? c - 1 : 0} p'=0 nC=0 nH=0`, counter: c };
      case 4:
        return { type: 'prepare', summary: `PREPARE b=${c} p=${c} p'=0 nC=0 nH=0`, counter: c };
      case 5:
        return { type: 'prepare', summary: `PREPARE b=${c} p=${c} p'=0 nC=${c} nH=${c}`, counter: c };
      case 6:
        return { type: 'confirm', summary: `CONFIRM b=${c} nP=${c} nC=${c} nH=${c}`, counter: c };
      default:
        return { type: 'externalize', summary: `EXTERNALIZE c=${c} nH=${c}`, counter: c };
    }
  }

  private nodeStep(run: SlotRun, n: SimNode, step: number): void {
    if (!run.value || !n.online) return;
    if (this.run !== run) {
      // Statements that arrive after we closed the slot are only logged.
      if (this.closedRun === run && !(n.self && !this.validating)) this.lateStatement(run, n, step);
      return;
    }
    if (n.self) {
      if (!this.validating) return;
      // This node only moves on after it saw a quorum for the previous step.
      if (run.progress < step - 1) {
        if (!run.selfPending.includes(step)) run.selfPending.push(step);
        return;
      }
    }
    const prev = run.reached.get(n.id) ?? 0;
    if (step < prev) return;
    run.reached.set(n.id, step);
    const st = this.statementFor(run, step);
    run.states.set(n.id, { nodeId: n.id, name: n.name, statement: st.type, ballotCounter: st.counter, summary: st.summary });
    n.lastSlot = run.slot;
    n.lastSeen = this.clock.now();
    const ev: ScpEventView = {
      ts: this.clock.now(),
      slot: run.slot,
      direction: n.self ? 'out' : 'in',
      nodeId: n.id,
      name: n.name,
      type: st.type,
      summary: st.summary,
    };
    this.scpEvents.push(ev);
    if (this.scpEvents.length > 1000) this.scpEvents.splice(0, this.scpEvents.length - 1000);
    this.emit({ type: 'scp', event: ev });
    this.advance(run);
    this.emitSlot();
  }

  private lateStatement(run: SlotRun, n: SimNode, step: number): void {
    if ((run.reached.get(n.id) ?? 0) >= step) return;
    run.reached.set(n.id, step);
    const st = this.statementFor(run, step);
    const ev: ScpEventView = { ts: this.clock.now(), slot: run.slot, direction: n.self ? 'out' : 'in', nodeId: n.id, name: n.name, type: st.type, summary: st.summary };
    this.scpEvents.push(ev);
    this.emit({ type: 'scp', event: ev });
  }

  /** Nodes (in our quorum set) that reached at least `step`, plus ourselves when we did. */
  private quorumReached(run: SlotRun, step: number): boolean {
    const have = new Set<string>();
    for (const [id, s] of run.reached) if (s >= step) have.add(id);
    // A watcher counts itself as agreeing with what it saw.
    if (!this.validating) have.add(this.self.id);
    const online = new Set(this.nodes.filter((n) => n.online).map((n) => n.id));
    for (const id of [...have]) if (!online.has(id)) have.delete(id);
    return isSliceSatisfied(this.selfQset, have);
  }

  private advance(run: SlotRun): void {
    const v = run.value!;
    let changed = false;
    while (run.progress < 7 && this.quorumReached(run, run.progress + 1)) {
      run.progress++;
      changed = true;
      const ballot: BallotView = { counter: run.counter, value: v };
      switch (run.progress) {
        case 1:
          run.votes = [v];
          run.accepted = [v];
          break;
        case 2:
          run.candidates = [v];
          run.phase = 'PREPARE';
          run.ballot = ballot;
          break;
        case 3:
          run.ballot = ballot;
          run.prepared = ballot;
          break;
        case 4:
          run.prepared = ballot;
          run.high = ballot;
          run.commit = ballot;
          break;
        case 5:
          run.phase = 'CONFIRM';
          run.heardFromQuorum = true;
          break;
        case 6:
          run.phase = 'EXTERNALIZE';
          run.externalized = v;
          run.externalizedAt = this.clock.now();
          break;
        case 7:
          break;
      }
    }
    if (run.votes.length === 0 && [...run.reached.values()].some((s) => s >= 1)) {
      run.votes = [v];
      changed = true;
    }
    if (changed) {
      // Release our own statements that were waiting for this progress.
      const ready = run.selfPending.filter((s) => s - 1 <= run.progress).sort((a, b) => a - b);
      run.selfPending = run.selfPending.filter((s) => s - 1 > run.progress);
      for (const s of ready) this.after(25, () => this.nodeStep(run, this.self, s));
      this.emitStatus();
    }
    if (run.progress >= 6 && !run.closing) {
      run.closing = true;
      // Close once our own EXTERNALIZE went out (or right away as a watcher).
      this.after(this.validating ? 320 : 120, () => this.externalize(run));
    }
  }

  private externalize(run: SlotRun): void {
    if (this.run !== run) return;
    const now = this.clock.now();
    const confirmedBy = [...run.reached.values()].filter((s) => s >= 6).length;
    const included = new Set(run.txs.map((t) => t.hash));
    // Txs in the value that became invalid since nomination are left out (and dropped from the mempool below).
    const valid = run.txs.filter((t) => {
      const acc = this.ledger.accounts.get(t.source);
      return !!acc;
    });
    const { summary, details } = this.closeLedger(valid, {
      closeTime: run.closeTime,
      closedAt: now,
      proposer: run.leader,
      externalizedBy: Math.max(1, confirmedBy),
      live: true,
    });
    this.liveCloses++;
    this.mempool = this.mempool.filter((m) => !included.has(m.parsed.hash));
    const view = this.slotView(run);
    this.slotHistory.set(run.slot, view);
    for (const k of [...this.slotHistory.keys()]) if (k < run.slot - 12) this.slotHistory.delete(k);
    this.emit({ type: 'ledgerClosed', ledger: summary, txs: details.map((d) => this.toSummary(d)) });
    for (const d of details) {
      if (this.ownTx.has(d.hash)) {
        this.emit({ type: 'txStatus', hash: d.hash, status: d.successful ? 'applied' : 'failed', ledgerSeq: summary.seq, resultCode: d.resultCode });
        this.ownTx.delete(d.hash);
      }
    }
    const failed = details.filter((d) => !d.successful).length;
    this.log(
      'info',
      'ledger',
      `closed ledger ${summary.seq} (${details.length} txs${failed ? `, ${failed} failed` : ''}) hash ${summary.hash.slice(0, 8)} in ${((now - run.startedAt) / 1000).toFixed(2)} s`,
    );
    this.ageMempool();
    if (this.state === 'stalled') {
      this.setState('synced');
      this.log('info', 'herder', 'ledgers are closing again');
    }
    this.armStallWatch();
    this.closedRun = run;
    this.run = null;
    this.openSlot();
    this.emitStatus();
  }

  private ageMempool(): void {
    const keep: typeof this.mempool = [];
    for (const m of this.mempool) {
      const acc = this.ledger.accounts.get(m.parsed.source);
      const stale = this.lclSeq - m.addedAtLedger > 50;
      const badSeq = !acc || m.parsed.seq <= acc.seq;
      if (stale || badSeq) {
        this.emit({ type: 'txStatus', hash: m.parsed.hash, status: 'dropped', resultCode: badSeq ? 'txBAD_SEQ' : undefined });
        this.ownTx.delete(m.parsed.hash);
        this.log('warn', 'txqueue', `dropped tx ${m.parsed.hash.slice(0, 8)} (${badSeq ? 'bad sequence' : 'too old'})`);
      } else keep.push(m);
    }
    this.mempool = keep;
  }

  private armStallWatch(): void {
    this.cancel(this.stallTimer);
    this.stallTimer = this.after(LEDGER_TARGET_CLOSE_MS * 3, () => {
      if (this.state === 'synced') {
        this.setState('stalled');
        this.log('warn', 'herder', `no ledger closed for ${(LEDGER_TARGET_CLOSE_MS * 3) / 1000} s; check the quorum set`);
      }
    });
  }

  private slotView(run: SlotRun): ScpSlotView {
    const order = new Map(this.nodes.map((n, i) => [n.id, i]));
    return {
      slot: run.slot,
      phase: run.phase,
      nomination: {
        round: run.round,
        votes: run.votes,
        accepted: run.accepted,
        candidates: run.candidates,
        leaders: run.leaders,
      },
      ballot: run.ballot,
      prepared: run.prepared,
      preparedPrime: null,
      high: run.high,
      commit: run.commit,
      heardFromQuorum: run.heardFromQuorum,
      nodes: [...run.states.values()].sort((a, b) => (order.get(a.nodeId) ?? 99) - (order.get(b.nodeId) ?? 99)),
      externalized: run.externalized,
      startedAt: run.startedAt,
      externalizedAt: run.externalizedAt,
    };
  }

  private emitSlot(): void {
    if (this.run) this.emit({ type: 'slot', slot: this.slotView(this.run) });
  }

  // ================================================================ network life

  private scheduleBeacons(): void {
    this.after(2000, () => {
      const now = this.clock.now();
      for (const n of this.nodes) {
        if (n.self || !n.online) continue;
        n.lastSeen = now - Math.floor(this.rng() * 400);
        if (n.transports.includes('webrtc') && !n.transports.includes('broadcast')) {
          n.latencyMs = Math.max(18, Math.min(260, Math.round(n.latencyMs + (this.rng() - 0.5) * 30)));
        } else {
          n.latencyMs = 1 + Math.floor(this.rng() * 4);
        }
      }
      this.emitPeers();
      this.scheduleBeacons();
    });
  }

  private scheduleChurn(): void {
    this.after(26_000 + this.rng() * 22_000, () => {
      const others = this.nodes.filter((n) => !n.self && n.online);
      const offlineValidators = this.nodes.filter((n) => !n.self && n.validator && !n.online);
      if (offlineValidators.length === 0 && others.length > 0) {
        const n = others[Math.floor(this.rng() * others.length)];
        n.online = false;
        n.state = 'stopped';
        this.log('info', 'overlay', `peer ${n.name} left (bye)`);
        if (n.validator) this.refreshQset(`${n.name} left`);
        if (this.run?.value) this.advance(this.run);
        this.emitPeers();
        this.emitStatus();
        this.after(12_000 + this.rng() * 14_000, () => this.rejoin(n));
      }
      this.scheduleChurn();
    });
  }

  private rejoin(n: SimNode): void {
    n.online = true;
    n.state = 'catching-up';
    n.lastSeen = this.clock.now();
    this.log('info', 'overlay', `peer ${n.name} connected over ${n.transports.join(' + ')}`);
    this.emitPeers();
    this.after(2200, () => {
      n.state = 'synced';
      this.log('info', 'overlay', `peer ${n.name} is synced at ledger ${this.lclSeq}`);
      this.emitPeers();
      this.emitStatus();
    });
  }

  private scheduleFork(): void {
    this.after(70_000 + this.rng() * 90_000, () => {
      const peers = this.nodes.filter((n) => !n.self && n.validator && n.online);
      if (peers.length > 0 && this.lclSeq > 3) {
        const peer = peers[Math.floor(this.rng() * peers.length)];
        const atSeq = this.lclSeq - Math.floor(this.rng() * 2);
        const ours = this.ledgers.get(atSeq)?.summary.hash ?? this.lclHash;
        const theirs = sha256Hex(`${ours}|fork|${this.clock.now()}`);
        const rolled = this.rng() < 0.35;
        const info: ForkInfo = {
          ts: this.clock.now(),
          atSeq,
          ourHash: ours,
          theirHash: theirs,
          peer: peer.id,
          resolution: this.quorumMode === 'manual' ? 'alert-only' : rolled ? 'rolled-back' : 'kept-ours',
          rolledBackLedgers: rolled && this.quorumMode !== 'manual' ? 1 : 0,
        };
        this.forks.push(info);
        if (this.forks.length > 50) this.forks.shift();
        this.log(
          'warn',
          'history',
          `fork at ledger ${atSeq} with ${peer.name}: ${info.resolution === 'kept-ours' ? 'our branch is heavier, kept it' : info.resolution === 'rolled-back' ? 'their branch is heavier, rolled back 1 ledger and caught up' : 'manual quorum: alert only'}`,
        );
        this.emit({ type: 'fork', info });
      }
      this.scheduleFork();
    });
  }

  // ================================================================ views

  private qsetHash(q: QuorumSetView): string {
    return sha256Hex(JSON.stringify(canonicalQset(q)));
  }

  private otherQset(): QuorumSetView {
    const ids = this.nodes.filter((n) => n.validator && n.online).map((n) => n.id).sort();
    return { threshold: autoThreshold(ids.length), validators: ids, innerSets: [] };
  }

  private quorumView(): QuorumConfigView {
    const qsets = new Map<string, QuorumSetView>();
    qsets.set(this.self.id, this.selfQset);
    const other = this.otherQset();
    for (const n of this.nodes) if (!n.self && n.validator && n.online) qsets.set(n.id, other);
    return {
      mode: this.quorumMode,
      qset: this.selfQset,
      qsetHash: this.qsetHash(this.selfQset),
      intersection: checkIntersection(qsets),
      faultTolerance: faultTolerance(this.selfQset),
    };
  }

  private lclSummary(): LedgerSummary {
    return this.ledgers.get(this.lclSeq)!.summary;
  }

  private buildStatus(): NodeStatus {
    const run = this.run;
    return {
      nodeId: this.self.id,
      name: this.self.name,
      networkName: this.networkName,
      networkPassphrase: this.passphrase,
      networkId: this.networkIdHex,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: APP_VERSION,
      state: this.state,
      isValidator: this.validating,
      lcl: this.lclSummary(),
      peers: this.nodes.filter((n) => !n.self && n.online).length,
      validatorsActive: this.nodes.filter((n) => n.validator && n.online && (n.self || n.state === 'synced')).length,
      mempoolSize: this.mempool.length,
      quorum: this.quorumView(),
      startedAt: this.startedAt,
      slot: run ? { index: run.slot, phase: run.phase, ballotCounter: run.ballot?.counter ?? null, round: run.round } : null,
      catchup: this.catchup,
    };
  }

  private buildPeers(): PeerView[] {
    const inQ = new Set(qsetValidators(this.selfQset));
    // demo 'blocked': the peers are ahead of us
    const ahead = this.demoState === 'blocked' ? this.blockedTarget : null;
    const lclOf = (n: SimNode): { seq: number; hash: string } => {
      if (n.state === 'catching-up') {
        const seq = Math.max(1, this.lclSeq - 3);
        return { seq, hash: this.ledgers.get(seq)?.summary.hash ?? this.lclHash };
      }
      if (ahead !== null) return { seq: ahead, hash: sha256Hex(`browserchain-mock|${this.opts.seed}|ahead|${ahead}`) };
      return { seq: this.lclSeq, hash: this.lclHash };
    };
    return this.nodes
      .filter((n) => !n.self && n.online)
      .map((n) => ({
        nodeId: n.id,
        name: n.name,
        transports: n.transports,
        lclSeq: lclOf(n).seq,
        lclHash: lclOf(n).hash,
        state: n.state,
        validator: n.validator,
        lastSeen: n.lastSeen,
        latencyMs: n.latencyMs,
        inMyQuorum: inQ.has(n.id),
      }));
  }

  private buildValidators(): ValidatorView[] {
    const inQ = new Set(qsetValidators(this.selfQset));
    const other = this.otherQset();
    return this.nodes
      .filter((n) => n.validator)
      .map((n) => ({
        nodeId: n.id,
        name: n.name,
        isSelf: n.self,
        active: n.self ? this.validating : n.online && n.state === 'synced',
        synced: n.self ? this.state === 'synced' : n.state === 'synced',
        lastSeen: n.self ? this.clock.now() : n.lastSeen,
        lastSlot: n.self ? (this.run?.slot ?? this.lclSeq) : n.lastSlot,
        connected: n.self ? true : n.online,
        inMyQuorum: inQ.has(n.id),
        qsetHash: n.self ? this.qsetHash(this.selfQset) : n.online ? this.qsetHash(other) : null,
        qset: n.self ? this.selfQset : n.online ? other : null,
      }));
  }

  private computeStats(): NetworkStats {
    const recent = [...this.ledgers.values()].map((l) => l.summary).filter((l) => l.seq > 1).sort((a, b) => b.seq - a.seq).slice(0, 21);
    const intervals: number[] = [];
    for (let i = 0; i + 1 < recent.length; i++) intervals.push(recent[i].closedAt - recent[i + 1].closedAt);
    intervals.reverse();
    const last20 = recent.slice(0, 20);
    const avg = intervals.length ? intervals.reduce((s, x) => s + x, 0) / intervals.length : LEDGER_TARGET_CLOSE_MS;
    const c = this.ledger.counts();
    return {
      ledgersClosedHere: this.liveCloses,
      avgCloseIntervalMs: Math.round(avg),
      recentCloseIntervalsMs: intervals,
      txPerLedger: last20.length ? last20.reduce((s, l) => s + l.txCount, 0) / last20.length : 0,
      opsPerLedger: last20.length ? last20.reduce((s, l) => s + l.opCount, 0) / last20.length : 0,
      totalAccounts: c.accounts,
      totalTrustlines: c.trustlines,
      totalOffers: c.offers,
      totalClaimableBalances: c.claimables,
    };
  }

  // ================================================================ NodeApi

  async getStatus(): Promise<NodeStatus> {
    return structuredClone(this.buildStatus());
  }

  async getLedgers(opts: { limit: number; beforeSeq?: number }): Promise<LedgerSummary[]> {
    const out: LedgerSummary[] = [];
    const start = Math.min(this.lclSeq, (opts.beforeSeq ?? this.lclSeq + 1) - 1);
    for (let s = start; s >= 1 && out.length < opts.limit; s--) {
      const l = this.ledgers.get(s);
      if (l) out.push(l.summary);
    }
    return structuredClone(out);
  }

  async getLedger(seq: number): Promise<LedgerDetail | null> {
    const l = this.ledgers.get(seq);
    if (!l) return null;
    const txs = l.txHashes.map((h) => this.txs.get(h)).filter((t): t is TxDetail => !!t).map((t) => this.toSummary(t));
    return structuredClone({ ...l.summary, headerXdr: l.headerXdr, header: l.header, txs });
  }

  async getTransaction(hash: string): Promise<TxDetail | null> {
    const t = this.txs.get(hash.toLowerCase());
    return t ? structuredClone(t) : null;
  }

  async getTransactions(opts: { limit: number; account?: string; beforeLedger?: number }): Promise<TxSummary[]> {
    const out: TxSummary[] = [];
    const start = Math.min(this.lclSeq, (opts.beforeLedger ?? this.lclSeq + 1) - 1);
    for (let s = start; s >= 1 && out.length < opts.limit; s--) {
      const l = this.ledgers.get(s);
      if (!l) continue;
      const list = l.txHashes.map((h) => this.txs.get(h)).filter((t): t is TxDetail => !!t);
      for (let i = list.length - 1; i >= 0 && out.length < opts.limit; i--) {
        const t = list[i];
        if (opts.account && !this.touches(t, opts.account)) continue;
        out.push(this.toSummary(t));
      }
    }
    return structuredClone(out);
  }

  private touches(t: TxDetail, account: string): boolean {
    if (t.sourceAccount === account) return true;
    return t.operations.some(
      (o) => o.sourceAccount === account || Object.values(o.details).some((v) => typeof v === 'string' && v.split(',').includes(account)),
    );
  }

  async getAccount(accountId: string): Promise<AccountView | null> {
    return structuredClone(this.ledger.accountView(accountId));
  }

  async getOrderBook(selling: AssetView, buying: AssetView, limit = 20): Promise<OrderBookView> {
    return structuredClone(this.ledger.orderBook(selling, buying, limit));
  }

  async getAssets(): Promise<AssetStatView[]> {
    return structuredClone(this.ledger.assets());
  }

  async submitTransaction(envelopeXdr: string): Promise<SubmitResult> {
    let parsed: ParsedTx;
    try {
      parsed = this.ledger.parse(envelopeXdr.trim());
    } catch (err) {
      const e = err as TxRejected;
      return { hash: e.hash ?? '', status: 'ERROR', errorResultCode: e.code ?? 'txMALFORMED', errorDetail: e.message };
    }
    return this.admit(parsed, 'submit');
  }

  private admit(parsed: ParsedTx, via: 'submit' | 'friendbot'): SubmitResult {
    if (this.mempool.some((m) => m.parsed.hash === parsed.hash) || this.txs.has(parsed.hash)) {
      return { hash: parsed.hash, status: 'DUPLICATE' };
    }
    const queued = this.mempool.filter((m) => m.parsed.source === parsed.source);
    if (queued.length >= 16) return { hash: parsed.hash, status: 'TRY_AGAIN_LATER', errorDetail: 'too many queued transactions for this account' };
    try {
      this.ledger.check(parsed, {
        queued: queued.length,
        pendingFees: queued.reduce((s, m) => s + m.parsed.maxFee, 0n),
        closeTime: Math.max(Math.floor(this.clock.now() / 1000), this.lclCloseTime + 1),
      });
    } catch (err) {
      const e = err as TxRejected;
      this.log('info', 'txqueue', `rejected tx ${parsed.hash.slice(0, 8)}: ${e.code}`);
      return { hash: parsed.hash, status: 'ERROR', errorResultCode: e.code ?? 'txMALFORMED', errorDetail: e.message };
    }
    this.mempool.push({ parsed, addedAtLedger: this.lclSeq });
    this.ownTx.add(parsed.hash);
    this.log('info', 'txqueue', `${via === 'friendbot' ? 'friendbot ' : ''}tx ${parsed.hash.slice(0, 8)} queued (${parsed.opCount} op${parsed.opCount === 1 ? '' : 's'})`);
    this.emit({ type: 'txStatus', hash: parsed.hash, status: 'pending' });
    this.emitStatus();
    return { hash: parsed.hash, status: 'PENDING' };
  }

  async friendbot(accountId: string): Promise<SubmitResult> {
    const id = accountId.trim();
    if (!/^G[A-Z2-7]{55}$/.test(id)) return { hash: '', status: 'ERROR', errorResultCode: 'txMALFORMED', errorDetail: 'not a valid account id' };
    try {
      Keypair.fromPublicKey(id);
    } catch {
      return { hash: '', status: 'ERROR', errorResultCode: 'txMALFORMED', errorDetail: 'not a valid account id' };
    }
    const pendingCreate = this.mempool.find((m) =>
      m.parsed.tx.operations.some((o) => o.type === 'createAccount' && o.destination === id),
    );
    if (pendingCreate) return { hash: pendingCreate.parsed.hash, status: 'DUPLICATE', errorDetail: 'this account is already being funded' };
    const channel = this.channels[(this.friendbotCounter++ + parseInt(sha256Hex(this.self.id + id).slice(0, 4), 16)) % this.channels.length];
    const queued = this.mempool.filter((m) => m.parsed.source === channel.publicKey()).length;
    const exists = this.ledger.accounts.has(id);
    const amount = amountStr(FRIENDBOT_AMOUNT);
    const op = exists
      ? Operation.payment({ destination: id, asset: Asset.native(), amount })
      : Operation.createAccount({ destination: id, startingBalance: amount });
    const parsed = this.signedTx(channel, [op], queued, Memo.text('friendbot'));
    this.log('info', 'friendbot', `${exists ? 'topping up' : 'creating'} ${id.slice(0, 8)}… with ${Number(FRIENDBOT_AMOUNT / 10_000_000n).toLocaleString('en-US')} XLM`);
    return this.admit(parsed, 'friendbot');
  }

  async getPeers(): Promise<PeerView[]> {
    return structuredClone(this.buildPeers());
  }

  async getValidators(): Promise<ValidatorView[]> {
    return structuredClone(this.buildValidators());
  }

  async getQuorumConfig(): Promise<QuorumConfigView> {
    return structuredClone(this.quorumView());
  }

  async setQuorumConfig(cfg: QuorumConfigInput): Promise<QuorumConfigView> {
    if (cfg.mode === 'manual') {
      const errors = validateQset(cfg.qset);
      if (errors.length) throw new Error(errors[0]);
      this.quorumMode = 'manual';
      this.manualQset = structuredClone(cfg.qset);
      this.selfQset = this.manualQset;
      this.log('info', 'quorum', `manual quorum set: ${cfg.qset.threshold} of ${cfg.qset.validators.length + cfg.qset.innerSets.length}`);
    } else {
      this.quorumMode = 'auto';
      this.manualQset = null;
      this.selfQset = this.computeAutoQset();
      this.log('info', 'quorum', 'quorum mode set to auto');
    }
    if (this.run?.value) this.advance(this.run);
    this.emitSlot();
    this.emitStatus();
    this.emitPeers();
    return structuredClone(this.quorumView());
  }

  async getScpSlot(slot?: number): Promise<ScpSlotView | null> {
    if (slot === undefined || slot === this.run?.slot) return this.run ? structuredClone(this.slotView(this.run)) : null;
    const v = this.slotHistory.get(slot);
    return v ? structuredClone(v) : null;
  }

  async getScpEvents(limit: number): Promise<ScpEventView[]> {
    return structuredClone(this.scpEvents.slice(-limit).reverse());
  }

  async getStats(): Promise<NetworkStats> {
    return this.computeStats();
  }

  async getForks(): Promise<ForkInfo[]> {
    return structuredClone([...this.forks].reverse());
  }

  async getLogs(limit: number): Promise<LogEntry[]> {
    return structuredClone(this.logs.slice(-limit).reverse());
  }

  async setValidating(on: boolean): Promise<void> {
    if (this.validating === on) return;
    this.validating = on;
    this.log('info', 'herder', on ? 'validating: this node now signs SCP statements' : 'watching: this node follows consensus without voting');
    this.refreshQset(on ? 'validating again' : 'watcher mode');
    this.emitStatus();
  }

  async setName(name: string): Promise<void> {
    const n = name.trim().slice(0, 32);
    if (!n) throw new Error('Name cannot be empty.');
    this.self.name = n;
    if (this.run) {
      const st = this.run.states.get(this.self.id);
      if (st) this.run.states.set(this.self.id, { ...st, name: n });
    }
    this.log('info', 'node', `name set to "${n}"`);
    this.emitStatus();
    this.emitSlot();
  }

  async resync(): Promise<void> {
    this.log('warn', 'history', 'resync requested: wiping the local chain and catching up from peers');
    // a resync ends a demo state: this node now follows the validators around it
    this.demoState = null;
    this.blockedTarget = null;
    this.run = null;
    const source = this.nodes.find((n) => !n.self && n.online && n.validator) ?? null;
    this.catchup = { target: this.lclSeq, current: 1, source: source?.id ?? null };
    this.setState('catching-up');
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      this.after(450 * i, () => {
        if (!this.catchup) return;
        this.catchup = { ...this.catchup, current: Math.max(1, Math.round((this.catchup.target * i) / steps)) };
        this.emitStatus();
      });
    }
    this.after(450 * steps + 200, () => this.becomeSynced());
  }
}

export function createMockNode(options?: MockNodeOptions): MockNode {
  return new MockNode(options);
}
