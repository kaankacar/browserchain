// Ported from stellar-core (Apache-2.0): src/herder/HerderSCPDriver.cpp
// (value validation, combineCandidates, timers), simplified for classic
// tx sets as described in ARCHITECTURE 10.1.

import type { Keypair } from '@stellar/stellar-sdk/base';
import { concatBytes, fromHex, toHex } from '../lib/bytes';
import type { Clock, TimerHandle } from '../lib/clock';
import { MAX_TIME_SLIP_SECONDS } from '../lib/constants';
import { sha256 } from '../lib/hash';
import type { Logger } from '../lib/log';
import type { ILedgerManager } from '../ledger/types';
import type { SCPDriver } from '../scp/driver';
import { computeHashNode, computeValueHash } from '../scp/hash';
import { ValidationLevel } from '../scp/types';
import type { Ballot, Envelope, Hash, NodeId, QuorumSet, Value } from '../scp/types';
import { signEnvelope } from '../scp/xdr';
import { Lru } from './lru';
import type { CachedTxSet } from './pendingEnvelopes';
import { decodeValue, describeValue, verifyValueSignature } from './values';

/** Nomination round / ballot counter timeout: 1 s per round, capped at 30 s. */
export const MAX_SCP_TIMEOUT_MS = 30_000;

export function computeScpTimeout(roundNumber: number): number {
  return Math.min(1000 * Math.max(1, roundNumber), MAX_SCP_TIMEOUT_MS);
}

/** Herder state the driver needs. */
export interface DriverContext {
  readonly keypair: Keypair;
  readonly networkId: Uint8Array;
  readonly clock: Clock;
  readonly logger: Logger;
  ledger(): ILedgerManager;
  getQSet(hash: Hash): QuorumSet | null;
  getTxSet(hash: Hash): CachedTxSet | undefined;
  emitEnvelope(env: Envelope): void;
  valueExternalized(slot: number, value: Value): void;
  /** Something moved forward in the slot (for the departure rule and the UI). */
  progress(slot: number, what: string): void;
  nodeName(nodeId: NodeId): string;
}

export class HerderSCPDriver implements SCPDriver {
  private readonly timers = new Map<string, { slot: number; handle: TimerHandle }>();
  /** (lcl hash, tx set hash, close time) -> checkTxSetValid result */
  private readonly txSetValid = new Lru<string, boolean>(1024);

  constructor(private readonly ctx: DriverContext) {}

  signEnvelope(env: Envelope): void {
    signEnvelope(env, this.ctx.keypair, this.ctx.networkId);
  }

  getQSet(hash: Hash): QuorumSet | null {
    return this.ctx.getQSet(hash);
  }

  emitEnvelope(env: Envelope): void {
    this.ctx.emitEnvelope(env);
  }

  // ------------------------------------------------------------ values

  /**
   * HerderSCPDriver::validateValue. Values for slots other than LCL+1 can
   * only be checked partly (MaybeValid). For LCL+1 the tx set must be cached,
   * build on the LCL and pass checkTxSetValid at the value's close time.
   */
  validateValue(slotIndex: number, value: Value, nomination: boolean): ValidationLevel {
    const info = decodeValue(value);
    if (!info) return ValidationLevel.Invalid;
    if (info.upgrades.length > 0 || !info.signature) return ValidationLevel.Invalid;
    const lm = this.ctx.ledger();
    const lcl = lm.lastClosed();
    const lclSeq = lcl.header.ledgerSeq;
    const lclCloseTime = lcl.header.scpValue.closeTime;
    // The close time checks come before the signature check (about 0.6 ms in
    // JS), so values that cannot pass them are cheap to reject.
    if (slotIndex === lclSeq + 1) {
      // checkCloseTime
      if (info.closeTime <= lclCloseTime) return ValidationLevel.Invalid;
      if (nomination && info.closeTime > Math.floor(this.ctx.clock.now() / 1000) + MAX_TIME_SLIP_SECONDS) {
        return ValidationLevel.Invalid;
      }
    } else if (slotIndex > lclSeq + 1 && info.closeTime <= lclCloseTime) {
      // validatePastOrFutureValue: a future value must still close after our LCL
      return ValidationLevel.Invalid;
    }
    if (!verifyValueSignature(this.ctx.networkId, value, info)) return ValidationLevel.Invalid;
    if (slotIndex !== lclSeq + 1) return ValidationLevel.MaybeValid;
    const cached = this.ctx.getTxSet(info.txSetHash);
    if (!cached || cached.info.previousLedgerHash !== lcl.hash) return ValidationLevel.Invalid;
    const key = `${lcl.hash}|${info.txSetHash}|${info.closeTime}`;
    let ok = this.txSetValid.get(key);
    if (ok === undefined) {
      const res = lm.checkTxSetValid(cached.info, info.closeTime);
      ok = res.valid;
      if (!ok) this.ctx.logger.debug(`tx set ${info.txSetHash.slice(0, 8)} invalid: ${res.reason ?? ''}`);
      this.txSetValid.set(key, ok);
    }
    return ok ? ValidationLevel.FullyValidated : ValidationLevel.Invalid;
  }

  extractValidValue(slotIndex: number, value: Value): Value | null {
    return this.validateValue(slotIndex, value, true) === ValidationLevel.FullyValidated ? value : null;
  }

  /**
   * HerderSCPDriver::combineCandidates (ARCHITECTURE 10.1): the candidate
   * whose tx set has the most operations, then the highest total fee bid,
   * then the smallest sha256(txSetHash || sha256(all candidates)). The value
   * is returned unchanged, so it keeps its nominator's signature.
   */
  combineCandidates(slotIndex: number, candidates: Value[]): Value | null {
    if (candidates.length === 0) return null;
    const all = sha256(concatBytes(...candidates.map((v) => fromHex(v))));
    let best: { value: Value; ops: number; fees: bigint; tie: string } | null = null;
    for (const value of candidates) {
      const info = decodeValue(value);
      if (!info) continue;
      const stats = this.ctx.getTxSet(info.txSetHash)?.stats;
      const ops = stats?.opCount ?? -1;
      const fees = stats?.totalFees ?? -1n;
      const tie = toHex(sha256(concatBytes(fromHex(info.txSetHash), all)));
      const c = { value, ops, fees, tie };
      if (!best || better(c, best)) best = c;
    }
    return best?.value ?? null;
  }

  computeHashNode(slotIndex: number, prev: Value, isPriority: boolean, roundNumber: number, nodeId: NodeId): bigint {
    return computeHashNode(slotIndex, prev, isPriority, roundNumber, nodeId);
  }

  computeValueHash(slotIndex: number, prev: Value, roundNumber: number, value: Value): bigint {
    return computeValueHash(slotIndex, prev, roundNumber, value);
  }

  computeTimeout(roundNumber: number, _isNomination: boolean): number {
    return computeScpTimeout(roundNumber);
  }

  // ------------------------------------------------------------ timers

  setupTimer(slotIndex: number, timerId: number, timeoutMs: number, cb: (() => void) | null): void {
    const key = `${slotIndex}:${timerId}`;
    this.cancel(key);
    if (cb === null) return;
    // HerderSCPDriver::setupTimer: no timers for closed slots
    if (slotIndex <= this.ctx.ledger().lastClosed().header.ledgerSeq) return;
    const handle = this.ctx.clock.setTimeout(() => {
      this.timers.delete(key);
      try {
        cb();
      } catch (err) {
        this.ctx.logger.error(`SCP timer ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, timeoutMs);
    this.timers.set(key, { slot: slotIndex, handle });
  }

  stopTimer(slotIndex: number, timerId: number): void {
    this.cancel(`${slotIndex}:${timerId}`);
  }

  private cancel(key: string): void {
    const t = this.timers.get(key);
    if (!t) return;
    this.ctx.clock.clearTimeout(t.handle);
    this.timers.delete(key);
  }

  /** Cancel timers of every slot <= slot (valueExternalized does this in stellar-core). */
  cancelTimersUpTo(slot: number): void {
    for (const [key, t] of [...this.timers]) if (t.slot <= slot) this.cancel(key);
  }

  cancelAllTimers(): void {
    for (const key of [...this.timers.keys()]) this.cancel(key);
  }

  timerCount(): number {
    return this.timers.size;
  }

  // ------------------------------------------------------------ notifications

  valueExternalized(slotIndex: number, value: Value): void {
    this.ctx.valueExternalized(slotIndex, value);
  }

  nominatingValue(slotIndex: number, _value: Value): void {
    this.ctx.progress(slotIndex, 'nominating');
  }

  updatedCandidateValue(slotIndex: number, _value: Value): void {
    this.ctx.progress(slotIndex, 'candidate');
  }

  startedBallotProtocol(slotIndex: number, _ballot: Ballot): void {
    this.ctx.progress(slotIndex, 'ballot');
  }

  acceptedBallotPrepared(slotIndex: number, _ballot: Ballot): void {
    this.ctx.progress(slotIndex, 'accepted-prepared');
  }

  confirmedBallotPrepared(slotIndex: number, _ballot: Ballot): void {
    this.ctx.progress(slotIndex, 'confirmed-prepared');
  }

  acceptedCommit(slotIndex: number, _ballot: Ballot): void {
    this.ctx.progress(slotIndex, 'accepted-commit');
  }

  getValueString(value: Value): string {
    return describeValue(value);
  }

  toShortString(nodeId: NodeId): string {
    return this.ctx.nodeName(nodeId) || `${nodeId.slice(0, 5)}…${nodeId.slice(-4)}`;
  }
}

function better(
  a: { value: Value; ops: number; fees: bigint; tie: string },
  b: { value: Value; ops: number; fees: bigint; tie: string },
): boolean {
  if (a.ops !== b.ops) return a.ops > b.ops;
  if (a.fees !== b.fees) return a.fees > b.fees;
  if (a.tie !== b.tie) return a.tie < b.tie;
  // same tx set: keep it deterministic
  return a.value < b.value;
}
