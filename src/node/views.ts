// Builders from internal data to the NodeApi views (src/node/api.ts).
// Pure functions; a NodeService can use them to answer UI queries.

import { formatAmount } from '../lib/amount';
import { decodeLedgerHeader } from '../ledger/header';
import type { LedgerHeader, OperationSummary } from '../ledger/types';
import type { PeerInfo } from '../overlay/types';
import type { Ballot, QuorumSet, SlotInfo, Statement, Value } from '../scp/types';
import type { StoredLedger, StoredTx } from '../storage/types';
import type { ScpEnvelopeEvent } from '../herder/types';
import type { ValidatorRecord } from '../herder/quorumManager';
import { decodeValue, valueId } from '../herder/values';
import type {
  BallotView,
  LedgerSummary,
  PeerView,
  QuorumSetView,
  ScpEventView,
  ScpNodeStateView,
  ScpPhase,
  ScpSlotView,
  SyncState,
  TxSummary,
  ValidatorView,
  ValueView,
} from './api';

/** LedgerSummary from a stored ledger (the header is decoded when not given). */
export function ledgerSummaryOf(stored: StoredLedger, header?: LedgerHeader): LedgerSummary {
  const h = header ?? decodeLedgerHeader(stored.headerXdr);
  return {
    seq: stored.seq,
    hash: stored.hash,
    prevHash: h.previousLedgerHash,
    closeTime: h.scpValue.closeTime,
    txCount: stored.txCount,
    opCount: stored.opCount,
    failedTxCount: stored.failedTxCount,
    baseFee: h.baseFee,
    baseReserve: h.baseReserve,
    totalCoins: formatAmount(h.totalCoins),
    feePool: formatAmount(h.feePool),
    protocolVersion: h.ledgerVersion,
    txSetHash: h.scpValue.txSetHash,
    stateHash: h.bucketListHash,
    proposer: h.scpValue.signature?.nodeId ?? null,
    closedAt: stored.closedAt,
    externalizedBy: stored.externalizedBy,
  };
}

/** LedgerSummary from a header alone (e.g. a ledger loaded from a snapshot). */
export function ledgerSummaryFromHeader(header: LedgerHeader, hash: string, closedAt = 0): LedgerSummary {
  return {
    seq: header.ledgerSeq,
    hash,
    prevHash: header.previousLedgerHash,
    closeTime: header.scpValue.closeTime,
    txCount: 0,
    opCount: 0,
    failedTxCount: 0,
    baseFee: header.baseFee,
    baseReserve: header.baseReserve,
    totalCoins: formatAmount(header.totalCoins),
    feePool: formatAmount(header.feePool),
    protocolVersion: header.ledgerVersion,
    txSetHash: header.scpValue.txSetHash,
    stateHash: header.bucketListHash,
    proposer: header.scpValue.signature?.nodeId ?? null,
    closedAt,
    externalizedBy: 0,
  };
}

/** TxSummary from a stored tx. */
export function txSummaryOf(tx: StoredTx): TxSummary {
  let operations: OperationSummary[] = [];
  let memo: TxSummary['memo'] = { type: 'none', value: null };
  try {
    const parsed = JSON.parse(tx.summaryJson) as { operations?: OperationSummary[]; memo?: TxSummary['memo'] };
    operations = parsed.operations ?? [];
    memo = parsed.memo ?? memo;
  } catch {
    /* keep the defaults */
  }
  return {
    hash: tx.hash,
    ledgerSeq: tx.ledgerSeq,
    applyIndex: tx.applyIndex,
    sourceAccount: tx.sourceAccount,
    feeCharged: formatAmount(BigInt(tx.feeCharged)),
    maxFee: formatAmount(BigInt(tx.maxFee)),
    opCount: operations.length,
    successful: tx.successful,
    resultCode: tx.resultCode,
    memo: { type: memo.type, value: memo.value },
    closeTime: tx.closeTime,
    operations: operations.map((o) => ({
      index: o.index,
      type: o.type,
      sourceAccount: o.sourceAccount,
      resultCode: o.resultCode,
      details: { ...o.details },
    })),
  };
}

export function qsetViewOf(q: QuorumSet): QuorumSetView {
  return { threshold: q.threshold, validators: [...q.validators], innerSets: q.innerSets.map(qsetViewOf) };
}

export function qsetFromView(q: QuorumSetView): QuorumSet {
  return { threshold: q.threshold, validators: [...q.validators], innerSets: q.innerSets.map(qsetFromView) };
}

/** ValueView of an SCP value. `txCount` comes from the tx set cache (null if unknown). */
export function valueViewOf(value: Value, txCount: number | null = null): ValueView {
  const info = decodeValue(value);
  if (!info) return { id: valueId(value), txSetHash: '', closeTime: 0, txCount: null, proposer: null };
  return {
    id: valueId(value),
    txSetHash: info.txSetHash,
    closeTime: info.closeTime,
    txCount,
    proposer: info.signature?.nodeId ?? null,
  };
}

function ballotStr(b: Ballot | null): string {
  return b ? `${b.counter}` : '-';
}

/** Compact text of a statement, e.g. "PREPARE b=2 p=1 p'=- nC=0 nH=0". */
export function statementSummary(st: Statement): string {
  const p = st.pledges;
  switch (p.type) {
    case 'nominate':
      return `NOMINATE votes=${p.votes.length} accepted=${p.accepted.length}`;
    case 'prepare':
      return `PREPARE b=${ballotStr(p.ballot)} p=${ballotStr(p.prepared)} p'=${ballotStr(p.preparedPrime)} nC=${p.nC} nH=${p.nH}`;
    case 'confirm':
      return `CONFIRM b=${ballotStr(p.ballot)} nP=${p.nPrepared} nC=${p.nCommit} nH=${p.nH}`;
    case 'externalize':
      return `EXTERNALIZE c=${ballotStr(p.commit)} nH=${p.nH}`;
  }
}

export function scpEventViewOf(e: ScpEnvelopeEvent): ScpEventView {
  return {
    ts: e.ts,
    slot: e.slot,
    direction: e.direction,
    nodeId: e.nodeId,
    name: e.name,
    type: e.type,
    summary: statementSummary(e.envelope.statement),
  };
}

function ballotCounterOf(st: Statement | null): number | null {
  if (!st) return null;
  const p = st.pledges;
  switch (p.type) {
    case 'prepare':
    case 'confirm':
      return p.ballot.counter;
    case 'externalize':
      return p.commit.counter;
    default:
      return null;
  }
}

export interface SlotViewInput {
  info: SlotInfo;
  name: (nodeId: string) => string;
  /** Number of txs of a tx set, null when unknown. */
  txCount: (txSetHash: string) => number | null;
  startedAt: number | null;
  externalizedAt: number | null;
}

/** ScpSlotView from SCP's SlotInfo. */
export function scpSlotViewOf(input: SlotViewInput): ScpSlotView {
  const { info } = input;
  const vv = (v: Value): ValueView => {
    const d = decodeValue(v);
    return valueViewOf(v, d ? input.txCount(d.txSetHash) : null);
  };
  const bv = (b: Ballot | null): BallotView | null => (b ? { counter: b.counter, value: vv(b.value) } : null);
  let phase: ScpPhase;
  if (info.externalizedValue !== null) phase = 'EXTERNALIZE';
  else if (info.ballot.current === null) phase = 'NOMINATE';
  else phase = info.ballot.phase;
  const nodes: ScpNodeStateView[] = info.latestStatements.map((s) => {
    const st = s.ballot ?? s.nomination;
    return {
      nodeId: s.nodeId,
      name: input.name(s.nodeId),
      statement: st ? st.pledges.type : 'none',
      ballotCounter: ballotCounterOf(s.ballot),
      summary: st ? statementSummary(st) : '',
    };
  });
  return {
    slot: info.slotIndex,
    phase,
    nomination: {
      round: info.nomination.roundNumber,
      votes: info.nomination.votes.map(vv),
      accepted: info.nomination.accepted.map(vv),
      candidates: info.nomination.candidates.map(vv),
      leaders: [...info.nomination.roundLeaders],
    },
    ballot: bv(info.ballot.current),
    prepared: bv(info.ballot.prepared),
    preparedPrime: bv(info.ballot.preparedPrime),
    high: bv(info.ballot.high),
    commit: bv(info.ballot.commit),
    heardFromQuorum: info.ballot.heardFromQuorum,
    nodes,
    externalized: info.externalizedValue !== null ? vv(info.externalizedValue) : null,
    startedAt: input.startedAt ?? 0,
    externalizedAt: input.externalizedAt,
  };
}

export function peerViewOf(p: PeerInfo, inMyQuorum: boolean): PeerView {
  return {
    nodeId: p.nodeId,
    name: p.name,
    transports: [...p.transports],
    lclSeq: p.ann.lcl.seq,
    lclHash: p.ann.lcl.hash,
    state: p.ann.state as SyncState,
    validator: p.ann.validator,
    lastSeen: p.lastSeen,
    latencyMs: p.latencyMs,
    inMyQuorum,
  };
}

export function validatorViewOf(
  r: ValidatorRecord,
  opts: { active: boolean; inMyQuorum: boolean; qset: QuorumSet | null },
): ValidatorView {
  return {
    nodeId: r.nodeId,
    name: r.name,
    isSelf: r.isSelf,
    active: opts.active,
    synced: r.state === 'synced' || r.state === 'stalled',
    lastSeen: r.lastHeard,
    lastSlot: r.lastSlot,
    connected: r.connected,
    inMyQuorum: opts.inMyQuorum,
    qsetHash: r.qsetHash,
    qset: opts.qset ? qsetViewOf(opts.qset) : null,
  };
}
