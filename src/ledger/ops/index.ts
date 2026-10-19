// Operation dispatch: threshold levels, support, well-formedness and apply.
// Ported from stellar-core (Apache-2.0): src/transactions/OperationFrame.cpp

import { applyDexOperation, checkDexOperationValid } from '../dex';
import { opOuter, type OpResult } from '../results';
import type { ThresholdLevel } from '../signatures';
import { accountMerge } from './accountMerge';
import { bumpSequence } from './bumpSequence';
import { changeTrust } from './changeTrust';
import { claimClaimableBalance, clawbackClaimableBalance, createClaimableBalance } from './claimableBalances';
import { clawback } from './clawback';
import { createAccount } from './createAccount';
import { manageData } from './manageData';
import { payment } from './payment';
import { setOptions } from './setOptions';
import { allowTrust, setTrustLineFlags } from './trustFlags';
import type { ApplyEnv, OpEnv, OpFrame } from './types';

const CORE_OPS: Record<string, OpFrame> = {
  createAccount,
  payment,
  setOptions,
  changeTrust,
  allowTrust,
  accountMerge,
  manageData,
  bumpSequence,
  createClaimableBalance,
  claimClaimableBalance,
  clawback,
  clawbackClaimableBalance,
  setTrustLineFlags,
};

/** Operation types implemented in src/ledger/dex. */
export const DEX_OPERATION_TYPES: ReadonlySet<string> = new Set([
  'manageSellOffer',
  'manageBuyOffer',
  'createPassiveSellOffer',
  'pathPaymentStrictReceive',
  'pathPaymentStrictSend',
]);

/** Operation types that always fail with opNOT_SUPPORTED on this network. */
export const UNSUPPORTED_OPERATION_TYPES: ReadonlySet<string> = new Set([
  'inflation',
  'beginSponsoringFutureReserves',
  'endSponsoringFutureReserves',
  'revokeSponsorship',
  'liquidityPoolDeposit',
  'liquidityPoolWithdraw',
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
]);

const LOW_THRESHOLD_UNSUPPORTED = new Set(['inflation', 'extendFootprintTtl', 'restoreFootprint']);

/** OperationFrame::isOpSupported */
export function isOpSupported(type: string): boolean {
  return type in CORE_OPS || DEX_OPERATION_TYPES.has(type);
}

/** OperationFrame::getThresholdLevel */
export function opThreshold(env: OpEnv): ThresholdLevel {
  const frame = CORE_OPS[env.op.type];
  if (frame) return frame.threshold(env);
  return LOW_THRESHOLD_UNSUPPORTED.has(env.op.type) ? 'LOW' : 'MEDIUM';
}

/** OperationFrame::doCheckValid */
export function opCheckValid(env: OpEnv): OpResult | null {
  const frame = CORE_OPS[env.op.type];
  if (frame) return frame.checkValid(env);
  if (DEX_OPERATION_TYPES.has(env.op.type)) return checkDexOperationValid(env);
  return opOuter('opNOT_SUPPORTED');
}

/** OperationFrame::doApply */
export function opApply(env: ApplyEnv): OpResult {
  const frame = CORE_OPS[env.op.type];
  if (frame) return frame.apply(env);
  if (DEX_OPERATION_TYPES.has(env.op.type)) return applyDexOperation(env);
  return opOuter('opNOT_SUPPORTED');
}
