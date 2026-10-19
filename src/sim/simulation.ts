// Deterministic multi-node simulation (ARCHITECTURE 13): N Nodes on one
// VirtualClock, a MemoryNetwork and MemoryStorages, all derived from a seed.
// Controls: add / stop / crash / restart nodes, latency, drop rate,
// partitions, transactions, Byzantine hooks. Assertions: safety (identical
// header hashes for every seq the nodes share), liveness, catch-up and fork
// resolution.

import { Keypair } from '@stellar/stellar-sdk/base';
import { VirtualClock } from '../lib/clock';
import { sha256 } from '../lib/hash';
import { LogSink, type LogLevel } from '../lib/log';
import { seededRng, type Rng } from '../lib/random';
import { MemoryNetwork } from '../overlay/memoryNetwork';
import type { TransportKind } from '../overlay/types';
import { MemoryStorage } from '../storage/memoryStorage';
import type { EmitInterceptor, HerderTuning } from '../herder/herder';
import type { ForkInfo, QuorumConfigInput, SyncState } from '../node/api';
import { Node, type NodeTuning } from '../node/node';

export const SIM_NETWORK = 'sim';

export interface SimOptions {
  seed: number;
  /** One-way latency range in ms (uniform). Default [5, 25]. */
  latency?: [number, number];
  dropRate?: number;
  networkName?: string;
  startMs?: number;
  logLevel?: LogLevel;
  /** Print logs to the console (debugging). */
  echo?: boolean;
  nodeTuning?: Partial<NodeTuning>;
  herderTuning?: Partial<HerderTuning>;
}

export interface SimNodeSpec {
  name: string;
  quorum?: QuorumConfigInput;
  validating?: boolean;
  emitInterceptor?: EmitInterceptor;
  nodeTuning?: Partial<NodeTuning>;
  herderTuning?: Partial<HerderTuning>;
  /**
   * Kind of the node's transport (default 'memory', like BroadcastChannel).
   * 'bridge' or 'webrtc' models a tab that reaches peers over WebRTC.
   */
  transportKind?: TransportKind;
}

export interface CloseRecord {
  seq: number;
  hash: string;
  source: 'consensus' | 'catchup';
  at: number;
  externalizedBy: number;
}

/** A simulated validator: identity and storage survive restarts. */
export class SimNode {
  readonly name: string;
  readonly secret: string;
  readonly nodeId: string;
  readonly storage = new MemoryStorage();
  node: Node | null = null;
  spec: SimNodeSpec;
  /** Current chain view: seq -> hash (rewritten after rollbacks). */
  readonly chain = new Map<number, string>();
  /** Every ledger closed, in order (including ones later rolled back). */
  readonly closes: CloseRecord[] = [];
  readonly forks: ForkInfo[] = [];
  readonly states: { state: SyncState; at: number }[] = [];
  /** Instance counter (restarts). */
  generation = 0;

  constructor(seed: number, spec: SimNodeSpec) {
    this.name = spec.name;
    this.spec = spec;
    const kp = Keypair.fromRawEd25519Seed(sha256(`browserchain-sim|${seed}|${spec.name}`));
    this.secret = kp.secret();
    this.nodeId = kp.publicKey();
  }

  get running(): boolean {
    return this.node !== null && this.node.isRunning;
  }

  /** LCL seq of the running node (or the last chain view when stopped). */
  get lcl(): number {
    if (this.node && this.node.isRunning) return this.node.ledger.lastClosed().header.ledgerSeq;
    let max = 0;
    for (const s of this.chain.keys()) max = Math.max(max, s);
    return max;
  }

  get lclHash(): string {
    if (this.node && this.node.isRunning) return this.node.ledger.lastClosed().hash;
    return this.chain.get(this.lcl) ?? '';
  }

  get state(): SyncState {
    return this.node ? this.node.state : 'stopped';
  }

  /** Ledgers this node closed through consensus. */
  consensusCloses(): CloseRecord[] {
    return this.closes.filter((c) => c.source === 'consensus');
  }
}

export class Simulation {
  readonly clock: VirtualClock;
  readonly net: MemoryNetwork;
  readonly rng: Rng;
  readonly nodes: SimNode[] = [];
  readonly logSink: LogSink;
  readonly options: SimOptions;
  readonly networkName: string;

  constructor(opts: SimOptions) {
    this.options = opts;
    this.networkName = opts.networkName ?? SIM_NETWORK;
    this.clock = new VirtualClock(opts.startMs ?? 1_790_000_000_000);
    this.rng = seededRng(opts.seed);
    const [lo, hi] = opts.latency ?? [5, 25];
    this.net = new MemoryNetwork({
      clock: this.clock,
      seed: opts.seed * 7919 + 1,
      latencyMs: (_a, _b, rng) => lo + Math.floor(rng() * (hi - lo + 1)),
      dropRate: opts.dropRate ?? 0,
    });
    this.logSink = new LogSink(this.clock, opts.logLevel ?? 'warn', opts.echo ?? false, 2000);
  }

  get(name: string): SimNode {
    const n = this.nodes.find((x) => x.name === name);
    if (!n) throw new Error(`no node ${name}`);
    return n;
  }

  /** Create a node and start it. */
  async addNode(spec: SimNodeSpec): Promise<SimNode> {
    if (this.nodes.some((n) => n.name === spec.name)) throw new Error(`duplicate node ${spec.name}`);
    const sn = new SimNode(this.options.seed, spec);
    this.nodes.push(sn);
    await this.startNode(sn);
    return sn;
  }

  async addNodes(specs: SimNodeSpec[]): Promise<SimNode[]> {
    const out: SimNode[] = [];
    for (const s of specs) out.push(await this.addNode(s));
    return out;
  }

  /** Start (or restart) a node with its identity and storage. */
  async startNode(sn: SimNode, spec: Partial<SimNodeSpec> = {}): Promise<Node> {
    if (sn.running) throw new Error(`${sn.name} is running`);
    sn.spec = { ...sn.spec, ...spec };
    sn.generation++;
    const id = `${sn.name}`;
    if (this.net.getTransport(id)) this.net.removeTransport(id);
    const transport = this.net.createTransport(id, { kind: sn.spec.transportKind });
    const node = new Node({
      transports: [transport],
      storage: sn.storage,
      clock: this.clock,
      logSink: this.logSink,
      networkName: this.networkName,
      secret: sn.secret,
      name: sn.name,
      quorum: sn.spec.quorum,
      validating: sn.spec.validating,
      rng: seededRng(this.options.seed * 1000 + sn.generation * 97 + this.nodes.indexOf(sn)),
      tuning: { ...this.options.nodeTuning, ...sn.spec.nodeTuning },
      herderTuning: { ...this.options.herderTuning, ...sn.spec.herderTuning },
      emitInterceptor: sn.spec.emitInterceptor,
    });
    sn.node = node;
    node.events.on('ledgerClosed', (e) => {
      const seq = e.stored.seq;
      for (const k of [...sn.chain.keys()]) if (k >= seq) sn.chain.delete(k);
      sn.chain.set(seq, e.stored.hash);
      sn.closes.push({ seq, hash: e.stored.hash, source: e.source, at: this.clock.now(), externalizedBy: e.stored.externalizedBy });
    });
    node.events.on('ledgerReset', (e) => {
      for (const k of [...sn.chain.keys()]) if (k > e.lclSeq) sn.chain.delete(k);
      sn.chain.set(e.lclSeq, node.ledger.lastClosed().hash);
    });
    node.events.on('fork', (f) => sn.forks.push(f));
    node.events.on('state', (e) => sn.states.push({ state: e.state, at: this.clock.now() }));
    await node.start();
    const lcl = node.ledger.lastClosed();
    for (const k of [...sn.chain.keys()]) if (k > lcl.header.ledgerSeq) sn.chain.delete(k);
    sn.chain.set(lcl.header.ledgerSeq, lcl.hash);
    return node;
  }

  /** Graceful stop (bye). */
  async stopNode(sn: SimNode): Promise<void> {
    if (!sn.node) return;
    await sn.node.stop();
  }

  /** Crash: no bye. 'freeze' keeps links up but silent, 'link-down' drops them. */
  crashNode(sn: SimNode, mode: 'freeze' | 'link-down' = 'freeze'): void {
    sn.node?.kill(mode);
  }

  async restartNode(sn: SimNode, spec: Partial<SimNodeSpec> = {}): Promise<Node> {
    if (sn.running) await this.stopNode(sn);
    return this.startNode(sn, spec);
  }

  /** Split the network; nodes not listed form one more group. */
  partition(groups: SimNode[][]): void {
    this.net.partition(groups.map((g) => g.map((n) => n.name)));
  }

  heal(): void {
    this.net.heal();
  }

  running(): SimNode[] {
    return this.nodes.filter((n) => n.running);
  }

  async run(ms: number): Promise<void> {
    await this.clock.advance(ms);
  }

  /** Advance until pred() is true or maxMs passed. */
  runUntil(pred: () => boolean, maxMs: number, stepMs = 100): Promise<boolean> {
    return this.clock.runUntil(pred, maxMs, stepMs);
  }

  /** Until every given node (default: running ones) has LCL >= seq. */
  waitForLedger(seq: number, maxMs: number, nodes?: SimNode[]): Promise<boolean> {
    return this.runUntil(() => (nodes ?? this.running()).every((n) => n.lcl >= seq), maxMs);
  }

  /** Until every given node is synced (or stalled). */
  waitForSynced(maxMs: number, nodes?: SimNode[]): Promise<boolean> {
    return this.runUntil(() => (nodes ?? this.running()).every((n) => n.state === 'synced'), maxMs);
  }

  /** Lowest and highest LCL of the given nodes (default: running). */
  lclRange(nodes?: SimNode[]): [number, number] {
    const l = (nodes ?? this.running()).map((n) => n.lcl);
    return [Math.min(...l), Math.max(...l)];
  }

  /**
   * Safety: every pair of nodes agrees on the hash of every seq both have in
   * their current chain. Returns the list of conflicts (empty when safe).
   */
  conflicts(nodes: SimNode[] = this.nodes): string[] {
    const out: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        for (const [seq, h] of a.chain) {
          const g = b.chain.get(seq);
          if (g !== undefined && g !== h) out.push(`${a.name} and ${b.name} differ at ledger ${seq}`);
        }
      }
    }
    return out;
  }

  /**
   * Stronger safety check for runs without forks: no node ever closed two
   * different hashes for one seq, and all nodes agree.
   */
  historyConflicts(nodes: SimNode[] = this.nodes): string[] {
    const first = new Map<number, string>();
    const out: string[] = [];
    for (const n of nodes) {
      for (const c of n.closes) {
        const h = first.get(c.seq);
        if (h === undefined) first.set(c.seq, c.hash);
        else if (h !== c.hash) out.push(`${n.name} closed ledger ${c.seq} as ${c.hash.slice(0, 8)}, others ${h.slice(0, 8)}`);
      }
    }
    return out;
  }

  /** seq -> hash read from a node's Storage. */
  async storedChain(sn: SimNode, from = 1, to?: number): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const max = to ?? (await sn.storage.getMaxLedgerSeq());
    for (const l of await sn.storage.getLedgers(from, max)) out.set(l.seq, l.hash);
    return out;
  }

  /** Stop every running node. */
  async shutdown(): Promise<void> {
    for (const n of this.nodes) if (n.running) await n.node!.stop();
  }

  /** Recent warnings and errors (debugging failed runs). */
  recentLogs(limit = 50, level: LogLevel = 'warn'): string[] {
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    return this.logSink
      .recent(2000)
      .filter((e) => order[e.level] >= order[level])
      .slice(-limit)
      .map((e) => `${new Date(e.ts).toISOString().slice(11, 23)} ${e.level} [${e.scope}] ${e.msg}`);
  }
}
