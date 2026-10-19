// Transaction validity (docs/ARCHITECTURE.md 7.3).
// Ported from stellar-core (Apache-2.0): src/transactions/TransactionFrame.cpp
// (commonValidPreSeqNum, commonValid, isBadSeq, isTooEarly, isTooLate,
// checkValidWithOptionallyChargedFee) and src/transactions/OperationFrame.cpp
// (checkSignature, checkValid)

import { getAvailableBalance } from './balances';
import { CHANNEL_DESTINATION_DETAIL, CHANNEL_POLICY_DETAIL, channelDestinationResult, channelPolicyAllows } from './channelPolicy';
import { INT64_MAX } from './math';
import { isOpSupported, opCheckValid, opThreshold } from './ops';
import type { OpEnv } from './ops/types';
import { opOuter, type OpResult, type TxCode } from './results';
import {
  SignatureChecker,
  checkAccountSignature,
  checkSignatureNoAccount,
  neededThreshold,
} from './signatures';
import type { LedgerTxn } from './state';
import { startingSequenceNumber, type DecodedOp, type DecodedTx } from './tx';
import type { AccountEntry } from './types';

/** TransactionFrame::ValidationType, ordered. */
export enum ValidationType {
  Invalid = 0,
  InvalidUpdateSeqNum = 1,
  InvalidPostAuth = 2,
  MaybeValid = 3,
}

export interface ValidityContext {
  /** State to validate against (LCL state for the mempool, current state when applying). */
  ltx: LedgerTxn;
  /** Ledger the transaction would be applied in (ledger bounds, starting sequence number). */
  ledgerSeq: number;
  /** Close time to check time bounds against. */
  closeTime: bigint;
  applying: boolean;
  /** Validate as if the source account's seqNum were this (mempool chains). */
  seqNumOverride?: bigint;
  /** Fees already promised by queued transactions of the same source. */
  pendingFees?: bigint;
  /** Friendbot channel account ids of the network (channel policy). */
  friendbotChannels: ReadonlySet<string>;
  /**
   * Tx sets: accounts that channel CreateAccounts earlier in the source
   * account's chain create (channelDestinationResult). Unset in a single
   * transaction check.
   */
  chainCreates?: ReadonlySet<string>;
}

const NO_ACCOUNTS: ReadonlySet<string> = new Set();

export interface CommonValidResult {
  level: ValidationType;
  code: TxCode | null;
  account?: Readonly<AccountEntry>;
}

/** isTooEarly (time bounds and ledger bounds). */
export function isTooEarly(tx: DecodedTx, closeTime: bigint, ledgerSeq: number): boolean {
  const tb = tx.timeBounds;
  if (tb && tb.minTime !== 0n && tb.minTime > closeTime) return true;
  const lb = tx.ledgerBounds;
  return !!lb && lb.minLedger > ledgerSeq;
}

/** isTooLate (time bounds and ledger bounds). */
export function isTooLate(tx: DecodedTx, closeTime: bigint, ledgerSeq: number): boolean {
  const tb = tx.timeBounds;
  if (tb && tb.maxTime !== 0n && tb.maxTime < closeTime) return true;
  const lb = tx.ledgerBounds;
  return !!lb && lb.maxLedger !== 0 && lb.maxLedger <= ledgerSeq;
}

/** isBadSeq: strict check, or the relaxed minSeqNum <= current < seqNum check (CAP-21). */
export function isBadSeq(tx: DecodedTx, current: bigint, ledgerSeq: number): boolean {
  if (tx.seqNum === startingSequenceNumber(ledgerSeq)) return true;
  if (tx.minSeqNum !== null) return current < tx.minSeqNum || current >= tx.seqNum;
  return current === INT64_MAX || current + 1n !== tx.seqNum;
}

/** Minimum fee: baseFee * max(1, opCount) (getMinInclusionFee). */
export function minFee(tx: DecodedTx, baseFee: number): bigint {
  return BigInt(baseFee) * BigInt(Math.max(1, tx.ops.length));
}

// commonValidPreSeqNum
function commonValidPreSeqNum(tx: DecodedTx, ctx: ValidityContext): { code: TxCode | null; account?: Readonly<AccountEntry> } {
  if (tx.kind !== 'tx') return { code: 'txNOT_SUPPORTED' };
  if (tx.unsupportedPreconditions) return { code: 'txNOT_SUPPORTED' };
  if (tx.ops.length === 0) return { code: 'txMISSING_OPERATION' };
  // Classic transactions may not carry Soroban data.
  if (tx.extV !== 0) return { code: 'txMALFORMED' };
  // BrowserChain: the friendbot channel keys are public (channelPolicy.ts).
  if (!channelPolicyAllows(tx, ctx.friendbotChannels, ctx.ltx.header.baseFee)) return { code: 'txNOT_SUPPORTED' };
  if (isTooEarly(tx, ctx.closeTime, ctx.ledgerSeq)) return { code: 'txTOO_EARLY' };
  if (isTooLate(tx, ctx.closeTime, ctx.ledgerSeq)) return { code: 'txTOO_LATE' };
  if (tx.fee < minFee(tx, ctx.ltx.header.baseFee)) return { code: 'txINSUFFICIENT_FEE' };
  const account = ctx.ltx.getAccount(tx.sourceId);
  if (!account) return { code: 'txNO_ACCOUNT' };
  return { code: null, account };
}

/** TransactionFrame::commonValid */
export function commonValid(tx: DecodedTx, checker: SignatureChecker, ctx: ValidityContext): CommonValidResult {
  const pre = commonValidPreSeqNum(tx, ctx);
  if (pre.code || !pre.account) return { level: ValidationType.Invalid, code: pre.code ?? 'txNO_ACCOUNT' };
  const account = pre.account;

  const current = !ctx.applying && ctx.seqNumOverride !== undefined ? ctx.seqNumOverride : account.seqNum;
  if (isBadSeq(tx, current, ctx.ledgerSeq)) return { level: ValidationType.Invalid, code: 'txBAD_SEQ', account };

  // isTooEarlyForAccount with minSeqAge = 0 and minSeqLedgerGap = 0.
  if (ctx.closeTime < account.seqTime || ctx.ledgerSeq < account.seqLedger) {
    return { level: ValidationType.InvalidUpdateSeqNum, code: 'txBAD_MIN_SEQ_AGE_OR_GAP', account };
  }

  if (!checkAccountSignature(checker, account, account.thresholds.low)) {
    return { level: ValidationType.InvalidUpdateSeqNum, code: 'txBAD_AUTH', account };
  }

  // When applying, the fee was already charged; the balance must still cover the reserve.
  const feeToPay = ctx.applying ? 0n : tx.fee;
  const pending = ctx.applying ? 0n : (ctx.pendingFees ?? 0n);
  if (getAvailableBalance(ctx.ltx.header, account) - pending < feeToPay) {
    return { level: ValidationType.InvalidPostAuth, code: 'txINSUFFICIENT_BALANCE', account };
  }
  return { level: ValidationType.MaybeValid, code: null, account };
}

export function opEnv(tx: DecodedTx, op: DecodedOp, ledgerVersion: number): OpEnv {
  return { tx, op, sourceId: op.sourceId, ledgerVersion };
}

/** OperationFrame::checkSignature. Null when the signatures are sufficient. */
export function checkOperationSignature(
  checker: SignatureChecker,
  ltx: LedgerTxn,
  tx: DecodedTx,
  op: DecodedOp,
  forApply: boolean,
): OpResult | null {
  const acc = ltx.getAccount(op.sourceId);
  if (acc) {
    const level = opThreshold(opEnv(tx, op, ltx.header.ledgerVersion));
    if (!checkAccountSignature(checker, acc, neededThreshold(acc, level))) return opOuter('opBAD_AUTH');
    return null;
  }
  if (forApply || !op.explicitSource) return opOuter('opNO_ACCOUNT');
  if (!checkSignatureNoAccount(checker, op.sourceId)) return opOuter('opBAD_AUTH');
  return null;
}

/** OperationFrame::checkValid (forApply = false). Null when valid. */
export function checkOperationValid(checker: SignatureChecker, ltx: LedgerTxn, tx: DecodedTx, op: DecodedOp): OpResult | null {
  if (!isOpSupported(op.type)) return opOuter('opNOT_SUPPORTED');
  const sig = checkOperationSignature(checker, ltx, tx, op, false);
  if (sig) return sig;
  return opCheckValid(opEnv(tx, op, ltx.header.ledgerVersion));
}

export interface TxValidity {
  ok: boolean;
  code?: TxCode;
  detail?: string;
  /** Failing operation, for txFAILED. */
  failedOp?: { index: number; type: string; code: string };
}

/** TransactionFrame::checkValid (mempool admission, not applying). */
export function checkTransactionValid(tx: DecodedTx, ctx: ValidityContext): TxValidity {
  const checker = new SignatureChecker(tx.hash, tx.signatures);
  const cv = commonValid(tx, checker, { ...ctx, applying: false });
  if (cv.level !== ValidationType.MaybeValid) {
    const policy = cv.code === 'txNOT_SUPPORTED' && !channelPolicyAllows(tx, ctx.friendbotChannels, ctx.ltx.header.baseFee);
    return { ok: false, code: cv.code ?? 'txFAILED', detail: policy ? CHANNEL_POLICY_DETAIL : undefined };
  }

  // Channel destinations (checkValid only). A single check of a transaction
  // that follows queued ones cannot see what they create.
  const followsQueued = ctx.seqNumOverride !== undefined && cv.account !== undefined && ctx.seqNumOverride > cv.account.seqNum;
  const chainCreates = ctx.chainCreates ?? (followsQueued ? null : NO_ACCOUNTS);
  const exists = (id: string) => ctx.ltx.getAccount(id) !== undefined;
  for (const op of tx.ops) {
    const r = checkOperationValid(checker, ctx.ltx, tx, op);
    const dest = r ? null : channelDestinationResult(op, ctx.friendbotChannels, exists, chainCreates);
    const failed = r ?? dest;
    if (failed) {
      return {
        ok: false,
        code: 'txFAILED',
        detail: `operation ${op.index} (${op.type}): ${failed.code}${dest ? ` (${CHANNEL_DESTINATION_DETAIL})` : ''}`,
        failedOp: { index: op.index, type: op.type, code: failed.code },
      };
    }
  }
  if (!checker.checkAllSignaturesUsed()) return { ok: false, code: 'txBAD_AUTH_EXTRA' };
  return { ok: true };
}
