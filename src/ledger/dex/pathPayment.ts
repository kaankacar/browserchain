// Ported from stellar-core (Apache-2.0): src/transactions/PathPaymentOpFrameBase.cpp,
// src/transactions/PathPaymentStrictReceiveOpFrame.cpp,
// src/transactions/PathPaymentStrictSendOpFrame.cpp
//
// A path payment converts sendAsset -> path[0] -> ... -> destAsset by
// crossing order book offers, one hop at a time (at most 5 path assets, as
// enforced by the XDR). Strict receive walks from the destination back to the
// source; strict send walks forward.

import { xdr } from '@stellar/stellar-sdk/base';
import { assetEquals } from '../asset';
import { accountKey } from '../keys';
import { INT64_MAX } from '../math';
import { creditDestination, debitSource, shouldBypassIssuerCheck } from '../ops/transfer';
import type { ApplyEnv, OpEnv } from '../ops/types';
import { opInner, opOuter, type OpResult } from '../results';
import type { LedgerTxn } from '../state';
import type { Asset } from '../types';
import { accountIdFromString, assetFromXdr, assetToXdr, int64, isXdrAssetValid, muxedToAccountId, opBody } from '../xdrutil';
import { claimAtomToXdr, convertWithOffers, getMaxOffersToCross, type ClaimAtom } from './convert';
import type { ExchangeRounding } from './exchange';

export type PathPaymentPrefix = 'PATH_PAYMENT_STRICT_RECEIVE' | 'PATH_PAYMENT_STRICT_SEND';

/** PathPaymentStrictReceiveOpFrame / PathPaymentStrictSendOpFrame::doCheckValid. */
export function checkPathPaymentValid(env: OpEnv): OpResult | null {
  if (env.op.type === 'pathPaymentStrictReceive') {
    const o = opBody(env.op, 'pathPaymentStrictReceive').pathPaymentStrictReceiveOp;
    const malformed = opInner('PATH_PAYMENT_STRICT_RECEIVE_MALFORMED');
    if (o.destAmount <= 0n || o.sendMax <= 0n) return malformed;
    if (!isXdrAssetValid(o.sendAsset) || !isXdrAssetValid(o.destAsset)) return malformed;
    if (!o.path.every((a) => isXdrAssetValid(a))) return malformed;
    return null;
  }
  const o = opBody(env.op, 'pathPaymentStrictSend').pathPaymentStrictSendOp;
  const malformed = opInner('PATH_PAYMENT_STRICT_SEND_MALFORMED');
  if (o.sendAmount <= 0n || o.destMin <= 0n) return malformed;
  if (!isXdrAssetValid(o.sendAsset) || !isXdrAssetValid(o.destAsset)) return malformed;
  if (!o.path.every((a) => isXdrAssetValid(a))) return malformed;
  return null;
}

interface Hop {
  amountSend: bigint;
  amountRecv: bigint;
  offerTrail: ClaimAtom[];
}

/** Running work budget of one operation (offers it may still cross). */
interface Budget {
  offersLeft: number;
}

// PathPaymentOpFrameBase::convert: one hop sendAsset -> recvAsset.
function convertHop(
  ltx: LedgerTxn,
  prefix: PathPaymentPrefix,
  sourceId: string,
  budget: Budget,
  sendAsset: Asset,
  maxSend: bigint,
  recvAsset: Asset,
  maxRecv: bigint,
  round: ExchangeRounding,
): Hop | OpResult {
  if (assetEquals(sendAsset, recvAsset)) throw new Error('convert: same asset');
  const r = convertWithOffers(
    ltx,
    sendAsset,
    maxSend,
    recvAsset,
    maxRecv,
    round,
    // Crossing our own offer is an error; there is no price limit per hop.
    (o) => (o.sellerId === sourceId ? 'STOP_CROSS_SELF' : 'KEEP'),
    budget.offersLeft,
  );
  if (r.sheepSend < 0n || r.wheatReceived < 0n) throw new Error('amount transferred out of bounds');

  switch (r.result) {
    case 'FILTER_STOP_CROSS_SELF':
      return opInner(`${prefix}_OFFER_CROSS_SELF`);
    case 'OK': {
      // checkTransfer: strict receive needs the whole maxRecv, strict send must spend all of maxSend.
      const complete = round === 'PATH_PAYMENT_STRICT_RECEIVE' ? r.wheatReceived === maxRecv : r.sheepSend === maxSend;
      if (!complete) return opInner(`${prefix}_TOO_FEW_OFFERS`);
      break;
    }
    case 'PARTIAL':
      return opInner(`${prefix}_TOO_FEW_OFFERS`);
    case 'CROSSED_TOO_MANY':
      return opOuter('opEXCEEDED_WORK_LIMIT');
    default:
      throw new Error('unexpected convert result');
  }
  budget.offersLeft -= r.offerTrail.length;
  return { amountSend: r.sheepSend, amountRecv: r.wheatReceived, offerTrail: r.offerTrail };
}

function isFailure(x: Hop | OpResult): x is OpResult {
  return 'outer' in x;
}

function success(
  opType: 'pathPaymentStrictReceive' | 'pathPaymentStrictSend',
  offers: ClaimAtom[],
  destId: string,
  destAsset: Asset,
  amount: bigint,
): OpResult {
  const last = new xdr.SimplePaymentResult({
    destination: accountIdFromString(destId),
    asset: assetToXdr(destAsset),
    amount: int64(amount),
  });
  const attrs = { offers: offers.map(claimAtomToXdr), last };
  return opType === 'pathPaymentStrictReceive'
    ? opInner('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS', new xdr.PathPaymentStrictReceiveResultSuccess(attrs))
    : opInner('PATH_PAYMENT_STRICT_SEND_SUCCESS', new xdr.PathPaymentStrictSendResultSuccess(attrs));
}

/** PathPaymentStrictReceiveOpFrame::doApply (protocol 23). */
export function applyPathPaymentStrictReceive(env: ApplyEnv): OpResult {
  const P: PathPaymentPrefix = 'PATH_PAYMENT_STRICT_RECEIVE';
  const { ltx, sourceId } = env;
  const o = opBody(env.op, 'pathPaymentStrictReceive').pathPaymentStrictReceiveOp;
  const sendAsset = assetFromXdr(o.sendAsset);
  const destAsset = assetFromXdr(o.destAsset);
  const path = o.path.map((a) => assetFromXdr(a));
  const destId = muxedToAccountId(o.destination);
  const destAmount = o.destAmount;
  const sendMax = o.sendMax;

  // Credits can always go back to their issuer, even if the issuer account is gone.
  const bypassIssuerCheck = shouldBypassIssuerCheck(sendAsset, destAsset, path.length, destId);
  if (!bypassIssuerCheck && !ltx.get(accountKey(destId))) return opInner(`${P}_NO_DESTINATION`);

  // updateDestBalance
  const credit = creditDestination(ltx, destId, destAsset, destAmount);
  if (credit) return opInner(`${P}_${credit}`);

  // Walk the path from the destination back to the source.
  const fullPath = [...path].reverse();
  fullPath.push(sendAsset);
  const budget: Budget = { offersLeft: getMaxOffersToCross() };
  let recvAsset = destAsset;
  let maxAmountRecv = destAmount;
  const offers: ClaimAtom[] = [];
  for (const hopSendAsset of fullPath) {
    if (assetEquals(recvAsset, hopSendAsset)) continue;
    const hop = convertHop(ltx, P, sourceId, budget, hopSendAsset, INT64_MAX, recvAsset, maxAmountRecv, 'PATH_PAYMENT_STRICT_RECEIVE');
    if (isFailure(hop)) return hop;
    maxAmountRecv = hop.amountSend;
    recvAsset = hopSendAsset;
    // Keep the trail in path order (source first).
    offers.unshift(...hop.offerTrail);
  }

  if (maxAmountRecv > sendMax) return opInner(`${P}_OVER_SENDMAX`);

  // updateSourceBalance
  const debit = debitSource(ltx, sourceId, sendAsset, maxAmountRecv);
  if (debit) return opInner(`${P}_${debit}`);

  return success('pathPaymentStrictReceive', offers, destId, destAsset, destAmount);
}

/** PathPaymentStrictSendOpFrame::doApply (protocol 23). */
export function applyPathPaymentStrictSend(env: ApplyEnv): OpResult {
  const P: PathPaymentPrefix = 'PATH_PAYMENT_STRICT_SEND';
  const { ltx, sourceId } = env;
  const o = opBody(env.op, 'pathPaymentStrictSend').pathPaymentStrictSendOp;
  const sendAsset = assetFromXdr(o.sendAsset);
  const destAsset = assetFromXdr(o.destAsset);
  const path = o.path.map((a) => assetFromXdr(a));
  const destId = muxedToAccountId(o.destination);
  const sendAmount = o.sendAmount;
  const destMin = o.destMin;

  const bypassIssuerCheck = shouldBypassIssuerCheck(sendAsset, destAsset, path.length, destId);
  if (!bypassIssuerCheck && !ltx.get(accountKey(destId))) return opInner(`${P}_NO_DESTINATION`);

  // updateSourceBalance
  const debit = debitSource(ltx, sourceId, sendAsset, sendAmount);
  if (debit) return opInner(`${P}_${debit}`);

  // Walk the path from the source to the destination.
  const fullPath = [...path, destAsset];
  const budget: Budget = { offersLeft: getMaxOffersToCross() };
  let hopSendAsset = sendAsset;
  let maxAmountSend = sendAmount;
  const offers: ClaimAtom[] = [];
  for (const recvAsset of fullPath) {
    if (assetEquals(recvAsset, hopSendAsset)) continue;
    const hop = convertHop(ltx, P, sourceId, budget, hopSendAsset, maxAmountSend, recvAsset, INT64_MAX, 'PATH_PAYMENT_STRICT_SEND');
    if (isFailure(hop)) return hop;
    maxAmountSend = hop.amountRecv;
    hopSendAsset = recvAsset;
    offers.push(...hop.offerTrail);
  }

  if (maxAmountSend < destMin) return opInner(`${P}_UNDER_DESTMIN`);

  // updateDestBalance
  const credit = creditDestination(ltx, destId, destAsset, maxAmountSend);
  if (credit) return opInner(`${P}_${credit}`);

  return success('pathPaymentStrictSend', offers, destId, destAsset, maxAmountSend);
}
