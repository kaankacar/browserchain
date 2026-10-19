// DEX operations: ManageSellOffer, ManageBuyOffer, CreatePassiveSellOffer,
// PathPaymentStrictReceive, PathPaymentStrictSend (stellar-core semantics,
// protocol 23).
//
// Contract with the ledger core (src/ledger/ops/index.ts):
// - The core has already checked that the operation source account exists and,
//   outside apply, that the signatures meet the MEDIUM threshold.
// - checkDexOperationValid is OperationFrame::doCheckValid: null when the
//   operation is well formed, else its *_MALFORMED result.
// - applyDexOperation is OperationFrame::doApply on `env.ltx` (an
//   operation-level LedgerTxn the core rolls back when the result is not a
//   success). Offer ids come from env.ltx.header.idPool.

import { xdr } from '@stellar/stellar-sdk/base';
import { equalBytes } from '../../lib/bytes';
import type { ApplyEnv, OpEnv } from '../ops/types';
import { opOuter, type OpResult } from '../results';
import type { DecodedOp, DecodedTx } from '../tx';
import { opBody } from '../xdrutil';
import { applyManageOffer, checkManageOfferValid, checkManageOfferValidForOverlay } from './manageOffer';
import { applyPathPaymentStrictReceive, applyPathPaymentStrictSend, checkPathPaymentValid } from './pathPayment';

/** Asset::operator== (XDR equality; never throws on malformed codes). */
function sameAsset(a: xdr.Asset, b: xdr.Asset): boolean {
  return equalBytes(a.toXdr(), b.toXdr());
}

/**
 * OperationFrame::isDexOperation: an offer that is not a delete (non-zero
 * amount), or a path payment with a path or two different assets.
 */
export function isDexOperation(op: DecodedOp): boolean {
  switch (op.type) {
    case 'manageSellOffer':
      return opBody(op, 'manageSellOffer').manageSellOfferOp.amount !== 0n;
    case 'manageBuyOffer':
      return opBody(op, 'manageBuyOffer').manageBuyOfferOp.buyAmount !== 0n;
    case 'createPassiveSellOffer':
      return opBody(op, 'createPassiveSellOffer').createPassiveSellOfferOp.amount !== 0n;
    case 'pathPaymentStrictReceive': {
      const o = opBody(op, 'pathPaymentStrictReceive').pathPaymentStrictReceiveOp;
      return o.path.length > 0 || !sameAsset(o.sendAsset, o.destAsset);
    }
    case 'pathPaymentStrictSend': {
      const o = opBody(op, 'pathPaymentStrictSend').pathPaymentStrictSendOp;
      return o.path.length > 0 || !sameAsset(o.sendAsset, o.destAsset);
    }
    default:
      return false;
  }
}

/** TransactionFrame::hasDexOperations */
export function hasDexOperations(tx: DecodedTx): boolean {
  return tx.ops.some(isDexOperation);
}

/** OperationFrame::doCheckValid for the DEX operations. */
export function checkDexOperationValid(env: OpEnv): OpResult | null {
  switch (env.op.type) {
    case 'manageSellOffer':
    case 'manageBuyOffer':
    case 'createPassiveSellOffer':
      return checkManageOfferValid(env);
    case 'pathPaymentStrictReceive':
    case 'pathPaymentStrictSend':
      return checkPathPaymentValid(env);
    default:
      return opOuter('opNOT_SUPPORTED');
  }
}

/** OperationFrame::doApply for the DEX operations. Throws only on internal errors. */
export function applyDexOperation(env: ApplyEnv): OpResult {
  switch (env.op.type) {
    case 'manageSellOffer':
    case 'manageBuyOffer':
    case 'createPassiveSellOffer':
      return applyManageOffer(env);
    case 'pathPaymentStrictReceive':
      return applyPathPaymentStrictReceive(env);
    case 'pathPaymentStrictSend':
      return applyPathPaymentStrictSend(env);
    default:
      return opOuter('opNOT_SUPPORTED');
  }
}

/**
 * OperationFrame::checkValidForOverlay for the DEX operations (stellar-core
 * runs it when admitting transactions to its queue, before protocol 29).
 * Not part of ledger validity. Malformed operations return their
 * doCheckValid result.
 */
export function checkDexOperationValidForOverlay(env: OpEnv): OpResult | null {
  const invalid = checkDexOperationValid(env);
  if (invalid) return invalid;
  switch (env.op.type) {
    case 'manageSellOffer':
    case 'manageBuyOffer':
    case 'createPassiveSellOffer':
      return checkManageOfferValidForOverlay(env);
    default:
      return null;
  }
}

export {
  MAX_OFFERS_TO_CROSS,
  canBuyAtMost,
  canSellAtMost,
  claimAtomFromXdr,
  claimAtomToXdr,
  convertWithOffers,
  getMaxOffersToCross,
  sortedOffers,
} from './convert';
export type { ClaimAtom, ConvertOutcome, ConvertResult, OfferFilterResult } from './convert';
export {
  adjustOffer,
  applyPriceErrorThresholds,
  checkPriceErrorBound,
  comparePrices,
  exchangeV10,
  exchangeV10WithoutPriceErrorThresholds,
  invertPrice,
  isPriceValid,
  offerCanClearForZero,
} from './exchange';
export type { ExchangeResultV10, ExchangeRounding } from './exchange';
export { manageOfferSpec, offerEntryToXdr } from './manageOffer';
export type { ManageOfferSpec } from './manageOffer';
export { FIND_PATHS_MAX_STEPS, findPaths, priceLevels, quoteStrictReceive, quoteStrictSend } from './quote';
export type { FindPathsRequest, LedgerView, PriceLevel, Quote, QuoteError, QuoteRequest, QuoteResult } from './quote';
