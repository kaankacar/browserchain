// Ledger close: fee phase and apply phase (docs/ARCHITECTURE.md 7.4).
// Ported from stellar-core (Apache-2.0): src/transactions/TransactionFrame.cpp
// (processFeeSeqNum, commonPreApply, processSeqNum, processSignatures,
// removeOneTimeSignerFromAllSourceAccounts, applyOperations) and
// src/transactions/OperationFrame.cpp (apply)

import { StrKey } from '@stellar/stellar-sdk/base';
import { removeSubentry } from './balances';
import { minBig } from './math';
import { isOpSupported, opApply, opCheckValid } from './ops';
import type { ApplyEnv } from './ops/types';
import { defaultOpResult, opOuter, type OpResult, type TxCode } from './results';
import { SignatureChecker } from './signatures';
import type { LedgerTxn } from './state';
import type { DecodedOp, DecodedTx } from './tx';
import { ValidationType, checkOperationSignature, commonValid, opEnv } from './validate';

export interface TxOutcome {
  code: TxCode;
  /** Operation results for txSUCCESS / txFAILED, else null. */
  opResults: OpResult[] | null;
}

/**
 * Fee phase for one transaction (processFeeSeqNum): charge
 * min(balance, min(fee bid, baseFee * max(1, opCount))) and add it to the fee pool.
 */
export function chargeFee(ltx: LedgerTxn, tx: DecodedTx): bigint {
  if (tx.kind !== 'tx') return 0n;
  const acc = ltx.loadAccount(tx.sourceId);
  if (!acc) return 0n;
  const header = ltx.header;
  let fee = minBig(tx.fee, BigInt(header.baseFee) * BigInt(Math.max(1, tx.ops.length)));
  if (fee <= 0n) return 0n;
  fee = minBig(acc.balance, fee);
  acc.balance -= fee;
  header.feePool += fee;
  return fee;
}

// processSeqNum
function processSeqNum(ltx: LedgerTxn, tx: DecodedTx, ledgerSeq: number, closeTime: bigint): void {
  const acc = ltx.loadAccount(tx.sourceId);
  if (!acc) throw new Error('source account missing');
  if (acc.seqNum > tx.seqNum) throw new Error('unexpected sequence number');
  acc.seqNum = tx.seqNum;
  acc.seqLedger = ledgerSeq;
  acc.seqTime = closeTime;
}

/** removeOneTimeSignerFromAllSourceAccounts: drop the pre-auth signer matching this transaction. */
export function removeOneTimeSigners(ltx: LedgerTxn, tx: DecodedTx): void {
  const preAuthKey = StrKey.encodePreAuthTx(tx.hash);
  const ids = new Set<string>([tx.sourceId, ...tx.ops.map((o) => o.sourceId)]);
  for (const id of ids) {
    const cur = ltx.getAccount(id);
    if (!cur || !cur.signers.some((s) => s.key === preAuthKey)) continue;
    const acc = ltx.loadAccount(id)!;
    acc.signers = acc.signers.filter((s) => s.key !== preAuthKey);
    removeSubentry(acc, 1);
  }
}

// OperationFrame::apply: checkValid(forApply = true) then doApply.
function applyOperation(ltx: LedgerTxn, tx: DecodedTx, op: DecodedOp, ledgerSeq: number, closeTime: bigint): OpResult {
  if (!isOpSupported(op.type)) return opOuter('opNOT_SUPPORTED');
  // Signatures were checked before applying; an earlier operation may have removed the source.
  if (!ltx.getAccount(op.sourceId)) return opOuter('opNO_ACCOUNT');
  const env: ApplyEnv = { ...opEnv(tx, op, ltx.header.ledgerVersion), ltx, ledgerSeq, closeTime };
  const invalid = opCheckValid(env);
  if (invalid) return invalid;
  return opApply(env);
}

/**
 * Apply phase for one transaction (TransactionFrame::apply). The fee has
 * already been charged. Operations run in nested transactions; if any fails,
 * all are rolled back and the result is txFAILED with every operation result.
 * `friendbotChannels`: the network's channel accounts (channel policy).
 */
export function applyTransaction(
  ltxLedger: LedgerTxn,
  tx: DecodedTx,
  ledgerSeq: number,
  closeTime: bigint,
  friendbotChannels: ReadonlySet<string>,
): TxOutcome {
  // commonPreApply: validity, sequence number, signatures.
  const checker = new SignatureChecker(tx.hash, tx.signatures);
  const opResults = tx.ops.map((o) => defaultOpResult(o.type));
  let code: TxCode = 'txSUCCESS';
  let signaturesValid = false;

  const ltxTx = ltxLedger.child();
  try {
    const cv = commonValid(tx, checker, { ltx: ltxTx, ledgerSeq, closeTime, applying: true, friendbotChannels });
    if (cv.code) code = cv.code;
    if (cv.level >= ValidationType.InvalidUpdateSeqNum) processSeqNum(ltxTx, tx, ledgerSeq, closeTime);

    // processSignatures
    if (cv.level !== ValidationType.MaybeValid) {
      removeOneTimeSigners(ltxTx, tx);
    } else {
      let allOpsValid = true;
      for (const op of tx.ops) {
        const r = checkOperationSignature(checker, ltxTx, tx, op, false);
        if (r) {
          opResults[op.index] = r;
          allOpsValid = false;
        }
      }
      removeOneTimeSigners(ltxTx, tx);
      if (!allOpsValid) code = 'txFAILED';
      else if (!checker.checkAllSignaturesUsed()) code = 'txBAD_AUTH_EXTRA';
      else signaturesValid = true;
    }
    ltxTx.commit();
  } catch (err) {
    ltxTx.rollback();
    throw err;
  }

  if (!signaturesValid) return { code, opResults: code === 'txFAILED' ? opResults : null };

  // applyOperations
  const ltxOps = ltxLedger.child();
  try {
    let success = true;
    for (const op of tx.ops) {
      const ltxOp = ltxOps.child();
      let r: OpResult;
      try {
        r = applyOperation(ltxOp, tx, op, ledgerSeq, closeTime);
      } catch (err) {
        ltxOp.rollback();
        throw err;
      }
      opResults[op.index] = r;
      if (r.success) ltxOp.commit();
      else {
        ltxOp.rollback();
        success = false;
      }
    }
    if (success) {
      ltxOps.commit();
      return { code: 'txSUCCESS', opResults };
    }
    ltxOps.rollback();
    return { code: 'txFAILED', opResults };
  } catch {
    // An exception while applying operations: txINTERNAL_ERROR, no effects.
    ltxOps.rollback();
    return { code: 'txINTERNAL_ERROR', opResults: null };
  }
}
