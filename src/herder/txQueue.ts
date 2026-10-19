// Ported from stellar-core (Apache-2.0): src/herder/TransactionQueue.cpp
// (the classic queue with per-account chains, replace-by-fee and bans).
//
// ARCHITECTURE 10.2: up to 16 queued txs per source account and 2,000 in
// total; a second tx with the same source and sequence number needs 10x the
// fee rate; rejected hashes are remembered for a few ledgers; after each
// close applied txs leave, the rest are re-validated and old ones age out.
// The friendbot channel keys are public, so txs from peers may hold only a
// few of a channel's slots: the rest is kept for this node's own requests.
// Only the channels this node makes its own requests on keep slots free;
// on the others, peers' txs (another node's requests) use all 16.

import { friendbotChannelIds } from '../ledger/genesis';
import { tryDecodeTransaction } from '../ledger/tx';
import type { ILedgerManager, LedgerCloseResult } from '../ledger/types';
import { Lru } from './lru';

export const MAX_TXS_PER_ACCOUNT = 16;
/** Peer-relayed txs of a friendbot channel may hold at most this many of its MAX_TXS_PER_ACCOUNT slots. */
export const MAX_PEER_TXS_PER_CHANNEL = 4;
export const MAX_QUEUE_TXS = 2000;
export const MAX_TX_AGE_LEDGERS = 50;
/** Replace-by-fee needs a fee rate at least this many times the queued one. */
export const FEE_MULTIPLIER = 10n;
/** Rejected tx hashes are ignored for this many ledgers when they come from peers. */
export const BAN_LEDGERS = 10;

export interface QueuedTx {
  /** Transaction hash (contents hash, what users see). */
  hash: string;
  envelopeXdr: string;
  sourceAccount: string;
  seqNum: bigint;
  /** Fee bid. */
  fee: bigint;
  opCount: number;
  /** Local ms when queued. */
  addedAt: number;
  /** LCL seq when queued. */
  addedLedger: number;
  /** Submitted to this node (not received from a peer). */
  fromSelf: boolean;
}

export type QueueAddStatus = 'PENDING' | 'DUPLICATE' | 'ERROR' | 'TRY_AGAIN_LATER';

export interface QueueAddResult {
  status: QueueAddStatus;
  hash: string;
  /** Tx result code on ERROR (e.g. "txBAD_SEQ"). */
  code?: string;
  detail?: string;
  tx?: QueuedTx;
  /** The queued tx that this one replaced (replace-by-fee). */
  replaced?: QueuedTx;
}

export interface QueueDrop {
  tx: QueuedTx;
  code: string;
  detail?: string;
}

export interface TxQueueOptions {
  ledger: () => ILedgerManager;
  now: () => number;
  maxPerAccount?: number;
  maxTotal?: number;
  maxAgeLedgers?: number;
  banLedgers?: number;
  maxPeerTxsPerChannel?: number;
  /**
   * Account ids of the friendbot channels this node makes its own requests
   * on. Peer txs may hold at most maxPeerTxsPerChannel slots of each. Default:
   * every channel.
   */
  ownChannels?: () => ReadonlySet<string>;
}

export class TxQueue {
  private readonly byHash = new Map<string, QueuedTx>();
  /** Per source account, sorted by seqNum. */
  private readonly byAccount = new Map<string, QueuedTx[]>();
  /** hash -> ledger seq until which it stays banned */
  private readonly banned = new Map<string, number>();
  private readonly recentlyApplied = new Lru<string, number>(8192);
  private readonly maxPerAccount: number;
  private readonly maxTotal: number;
  private readonly maxAge: number;
  private readonly banLedgers: number;
  private readonly maxPeerPerChannel: number;

  constructor(private readonly opts: TxQueueOptions) {
    this.maxPerAccount = opts.maxPerAccount ?? MAX_TXS_PER_ACCOUNT;
    this.maxTotal = opts.maxTotal ?? MAX_QUEUE_TXS;
    this.maxAge = opts.maxAgeLedgers ?? MAX_TX_AGE_LEDGERS;
    this.banLedgers = opts.banLedgers ?? BAN_LEDGERS;
    this.maxPeerPerChannel = opts.maxPeerTxsPerChannel ?? MAX_PEER_TXS_PER_CHANNEL;
  }

  size(): number {
    return this.byHash.size;
  }

  has(hash: string): boolean {
    return this.byHash.has(hash);
  }

  get(hash: string): QueuedTx | undefined {
    return this.byHash.get(hash);
  }

  /** All queued txs, grouped by account in sequence order. */
  all(): QueuedTx[] {
    const out: QueuedTx[] = [];
    for (const chain of this.byAccount.values()) out.push(...chain);
    return out;
  }

  envelopes(): string[] {
    return this.all().map((q) => q.envelopeXdr);
  }

  /** Queued txs of one source account, in sequence order. */
  pendingFor(account: string): QueuedTx[] {
    return [...(this.byAccount.get(account) ?? [])];
  }

  /** Number of queued txs of one source account. */
  countFor(account: string): number {
    return this.byAccount.get(account)?.length ?? 0;
  }

  /** Next sequence number to use for `account`, given its ledger seqNum. */
  nextSeqNum(account: string, ledgerSeqNum: bigint): bigint {
    const chain = this.byAccount.get(account);
    const last = chain && chain.length > 0 ? chain[chain.length - 1].seqNum : ledgerSeqNum;
    return (last > ledgerSeqNum ? last : ledgerSeqNum) + 1n;
  }

  isBanned(hash: string): boolean {
    const until = this.banned.get(hash);
    if (until === undefined) return false;
    return until >= this.lclSeq();
  }

  ban(hash: string): void {
    if (!hash) return;
    this.banned.set(hash, this.lclSeq() + this.banLedgers);
  }

  /** True when the tx was applied in a recent ledger. */
  wasApplied(hash: string): boolean {
    return this.recentlyApplied.has(hash);
  }

  /**
   * Admission (TransactionQueue::tryAdd). Peer txs that fail are banned for a
   * few ledgers so that re-floods are cheap to ignore.
   */
  tryAdd(envelopeXdr: string, opts: { fromSelf?: boolean } = {}): QueueAddResult {
    const fromSelf = opts.fromSelf ?? false;
    const lm = this.opts.ledger();
    const tx = tryDecodeTransaction(envelopeXdr, lm.networkId);
    if (!tx) {
      return { status: 'ERROR', hash: '', code: 'txMALFORMED', detail: 'cannot decode the transaction envelope' };
    }
    const hash = tx.hashHex;
    if (this.byHash.has(hash) || this.recentlyApplied.has(hash)) return { status: 'DUPLICATE', hash };
    if (!fromSelf && this.isBanned(hash)) {
      return { status: 'TRY_AGAIN_LATER', hash, detail: 'recently rejected' };
    }

    const chain = this.byAccount.get(tx.sourceId) ?? [];
    const sameSeq = chain.find((q) => q.seqNum === tx.seqNum);
    let seqNumOverride: bigint | undefined;
    let pendingFees = 0n;
    if (sameSeq) {
      // canReplaceByFee: newFee / newOps >= 10 * oldFee / oldOps
      const newOps = BigInt(Math.max(1, tx.ops.length));
      const oldOps = BigInt(Math.max(1, sameSeq.opCount));
      if (tx.fee * oldOps < FEE_MULTIPLIER * sameSeq.fee * newOps) {
        return {
          status: 'TRY_AGAIN_LATER',
          hash,
          detail: `a transaction with sequence ${tx.seqNum} is already queued; replacing it needs ${FEE_MULTIPLIER}x its fee`,
        };
      }
      seqNumOverride = tx.seqNum - 1n;
      for (const q of chain) if (q !== sameSeq) pendingFees += q.fee;
    } else {
      if (chain.length >= this.maxPerAccount) {
        return { status: 'TRY_AGAIN_LATER', hash, detail: `too many queued transactions for ${tx.sourceId}` };
      }
      // anyone can sign channel txs: on the channels this node makes its own
      // friendbot requests on, peers must not take the slots of those requests
      const channel = !fromSelf && friendbotChannelIds(lm.networkPassphrase).has(tx.sourceId);
      if (channel && (this.opts.ownChannels?.().has(tx.sourceId) ?? true)) {
        const fromPeers = chain.reduce((n, q) => (q.fromSelf ? n : n + 1), 0);
        if (fromPeers >= this.maxPeerPerChannel) {
          return {
            status: 'TRY_AGAIN_LATER',
            hash,
            detail: `friendbot channel ${tx.sourceId}: transactions from peers may hold at most ${this.maxPeerPerChannel} of its queue slots`,
          };
        }
      }
      if (this.byHash.size >= this.maxTotal) {
        return { status: 'TRY_AGAIN_LATER', hash, detail: 'the transaction queue is full' };
      }
      if (chain.length > 0) seqNumOverride = chain[chain.length - 1].seqNum;
      for (const q of chain) pendingFees += q.fee;
    }

    const check = lm.checkValid(envelopeXdr, { seqNumOverride, pendingFees });
    if (!check.ok) {
      if (!fromSelf) this.ban(hash);
      return { status: 'ERROR', hash, code: check.code ?? 'txFAILED', detail: check.detail };
    }

    const queued: QueuedTx = {
      hash,
      envelopeXdr,
      sourceAccount: tx.sourceId,
      seqNum: tx.seqNum,
      fee: tx.fee,
      opCount: tx.ops.length,
      addedAt: this.opts.now(),
      addedLedger: this.lclSeq(),
      fromSelf,
    };
    if (sameSeq) this.removeQueued(sameSeq);
    this.insert(queued);
    return sameSeq ? { status: 'PENDING', hash, tx: queued, replaced: sameSeq } : { status: 'PENDING', hash, tx: queued };
  }

  /** Remove a tx by hash. Returns it, or undefined. */
  remove(hash: string): QueuedTx | undefined {
    const q = this.byHash.get(hash);
    if (q) this.removeQueued(q);
    return q;
  }

  /** Drop txs whose envelopes are listed (e.g. trimInvalid's invalid list) and ban them. */
  dropEnvelopes(envelopes: string[], code: string): QueueDrop[] {
    if (envelopes.length === 0) return [];
    const wanted = new Set(envelopes);
    const out: QueueDrop[] = [];
    for (const q of this.all()) {
      if (!wanted.has(q.envelopeXdr)) continue;
      this.removeQueued(q);
      this.ban(q.hash);
      out.push({ tx: q, code });
    }
    return out;
  }

  /**
   * After a ledger close: remove the applied txs, re-validate every account
   * chain against the new LCL and age out old txs. Returns the applied txs
   * that were queued here and the dropped ones.
   */
  onLedgerClosed(result: LedgerCloseResult): { applied: QueuedTx[]; dropped: QueueDrop[] } {
    const applied: QueuedTx[] = [];
    for (const r of result.results) {
      this.recentlyApplied.set(r.hash, result.header.ledgerSeq);
      const q = this.byHash.get(r.hash);
      if (q) {
        this.removeQueued(q);
        applied.push(q);
      }
    }
    const lclSeq = result.header.ledgerSeq;
    for (const [hash, until] of [...this.banned]) if (until < lclSeq) this.banned.delete(hash);
    return { applied, dropped: this.revalidate(lclSeq) };
  }

  /** Re-check all queued txs against the current LCL (also used after a ledger reset). */
  revalidate(lclSeq = this.lclSeq()): QueueDrop[] {
    const lm = this.opts.ledger();
    const dropped: QueueDrop[] = [];
    for (const chain of [...this.byAccount.values()]) {
      let seqNumOverride: bigint | undefined;
      let pendingFees = 0n;
      for (const q of [...chain]) {
        if (lclSeq - q.addedLedger >= this.maxAge) {
          this.removeQueued(q);
          dropped.push({ tx: q, code: 'txTOO_LATE', detail: `queued for ${this.maxAge} ledgers` });
          continue;
        }
        const check = lm.checkValid(q.envelopeXdr, { seqNumOverride, pendingFees });
        if (!check.ok) {
          this.removeQueued(q);
          this.ban(q.hash);
          dropped.push({ tx: q, code: check.code ?? 'txFAILED', detail: check.detail });
          continue;
        }
        seqNumOverride = q.seqNum;
        pendingFees += q.fee;
      }
    }
    return dropped;
  }

  /** Forget everything (resync). */
  clear(): void {
    this.byHash.clear();
    this.byAccount.clear();
    this.banned.clear();
    this.recentlyApplied.clear();
  }

  /** Forget applied hashes and bans (the chain they refer to was rolled back). */
  forgetHistory(): void {
    this.banned.clear();
    this.recentlyApplied.clear();
  }

  private lclSeq(): number {
    return this.opts.ledger().lastClosed().header.ledgerSeq;
  }

  private insert(q: QueuedTx): void {
    this.byHash.set(q.hash, q);
    let chain = this.byAccount.get(q.sourceAccount);
    if (!chain) {
      chain = [];
      this.byAccount.set(q.sourceAccount, chain);
    }
    chain.push(q);
    chain.sort((a, b) => (a.seqNum < b.seqNum ? -1 : a.seqNum > b.seqNum ? 1 : 0));
  }

  private removeQueued(q: QueuedTx): void {
    this.byHash.delete(q.hash);
    const chain = this.byAccount.get(q.sourceAccount);
    if (!chain) return;
    const i = chain.indexOf(q);
    if (i >= 0) chain.splice(i, 1);
    if (chain.length === 0) this.byAccount.delete(q.sourceAccount);
  }
}
