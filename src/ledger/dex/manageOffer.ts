// Ported from stellar-core (Apache-2.0): src/transactions/ManageOfferOpFrameBase.cpp,
// src/transactions/ManageSellOfferOpFrame.cpp, src/transactions/ManageBuyOfferOpFrame.cpp,
// src/transactions/CreatePassiveSellOfferOpFrame.cpp
//
// The operation sells "sheep" (the selling asset) for "wheat" (the buying
// asset). It first crosses the offers in the book that sell wheat for sheep at
// an acceptable price, then stores what is left as an offer.

import { xdr } from '@stellar/stellar-sdk/base';
import { assetEquals } from '../asset';
import { addBalance, createSubentry, getAvailableBalance, getMaxAmountReceive, getTrustLine, loadTrustLine, removeSubentry } from '../balances';
import { offerKey } from '../keys';
import { INT64_MAX, minBig } from '../math';
import { acquireLiabilities, exchangeV10WithoutPriceErrorThresholds, generateOfferId, releaseLiabilities } from '../offers';
import type { ApplyEnv, OpEnv } from '../ops/types';
import { opInner, opOuter, type OpResult } from '../results';
import type { LedgerTxn } from '../state';
import { OFFER_PASSIVE_FLAG, type Asset, type OfferEntry, type Price } from '../types';
import { accountIdFromString, assetFromXdr, assetToXdr, int64, isXdrAssetValid, opBody } from '../xdrutil';
import { canBuyAtMost, canSellAtMost, claimAtomToXdr, convertWithOffers, getMaxOffersToCross, type ClaimAtom } from './convert';
import { adjustOffer, comparePrices, invertPrice, offerCanClearForZero } from './exchange';

export type ManageOfferPrefix = 'MANAGE_SELL_OFFER' | 'MANAGE_BUY_OFFER';

/** A decoded ManageSellOffer, ManageBuyOffer or CreatePassiveSellOffer. */
export interface ManageOfferSpec {
  prefix: ManageOfferPrefix;
  /** Asset sold (selling). */
  sheep: Asset;
  /** Asset bought (buying). */
  wheat: Asset;
  offerId: bigint;
  /** Price of the stored offer: wheat per sheep. Inverted for ManageBuyOffer. */
  price: Price;
  passiveOnCreate: boolean;
  /** Raw amount from the operation (amount for sells, buyAmount for buys). */
  amount: bigint;
  /** isDeleteOffer */
  isDelete: boolean;
  /** getOfferBuyingLiabilities of the requested offer. */
  buyingLiabilities(): bigint;
  /** getOfferSellingLiabilities of the requested offer. */
  sellingLiabilities(): bigint;
  /** applyOperationSpecificLimits */
  applyLimits(maxSheepSend: bigint, sheepSent: bigint, maxWheatReceive: bigint, wheatReceived: bigint): { maxSheepSend: bigint; maxWheatReceive: bigint };
}

interface RawOffer {
  selling: xdr.Asset;
  buying: xdr.Asset;
  amount: bigint;
  price: Price;
  offerId: bigint;
}

function rawOf(env: OpEnv): { raw: RawOffer; prefix: ManageOfferPrefix; buy: boolean; passive: boolean } {
  switch (env.op.type) {
    case 'manageSellOffer': {
      const o = opBody(env.op, 'manageSellOffer').manageSellOfferOp;
      return {
        raw: { selling: o.selling, buying: o.buying, amount: o.amount, price: { n: o.price.n, d: o.price.d }, offerId: o.offerId },
        prefix: 'MANAGE_SELL_OFFER',
        buy: false,
        passive: false,
      };
    }
    case 'createPassiveSellOffer': {
      const o = opBody(env.op, 'createPassiveSellOffer').createPassiveSellOfferOp;
      return {
        raw: { selling: o.selling, buying: o.buying, amount: o.amount, price: { n: o.price.n, d: o.price.d }, offerId: 0n },
        prefix: 'MANAGE_SELL_OFFER',
        buy: false,
        passive: true,
      };
    }
    case 'manageBuyOffer': {
      const o = opBody(env.op, 'manageBuyOffer').manageBuyOfferOp;
      return {
        raw: { selling: o.selling, buying: o.buying, amount: o.buyAmount, price: { n: o.price.n, d: o.price.d }, offerId: o.offerId },
        prefix: 'MANAGE_BUY_OFFER',
        buy: true,
        passive: false,
      };
    }
    default:
      throw new Error(`not an offer operation: ${env.op.type}`);
  }
}

/** ManageOfferOpFrameBase::doCheckValid. Null when the operation is well formed. */
export function checkManageOfferValid(env: OpEnv): OpResult | null {
  const { raw, prefix } = rawOf(env);
  const malformed = opInner(`${prefix}_MALFORMED`);
  if (!isXdrAssetValid(raw.selling) || !isXdrAssetValid(raw.buying)) return malformed;
  if (assetEquals(assetFromXdr(raw.selling), assetFromXdr(raw.buying))) return malformed;
  if (raw.amount < 0n || raw.price.d <= 0 || raw.price.n <= 0) return malformed;
  // Deleting offer 0 (protocol 11+), negative offer ids (protocol 15+).
  if (raw.offerId === 0n && raw.amount === 0n) return malformed;
  if (raw.offerId < 0n) return malformed;
  return null;
}

/** Decode a well-formed offer operation (call checkManageOfferValid first). */
export function manageOfferSpec(env: OpEnv): ManageOfferSpec {
  const { raw, prefix, buy, passive } = rawOf(env);
  const sheep = assetFromXdr(raw.selling);
  const wheat = assetFromXdr(raw.buying);
  const amount = raw.amount;
  if (!buy) {
    const price = raw.price;
    const liabilities = () => exchangeV10WithoutPriceErrorThresholds(price, amount, INT64_MAX, INT64_MAX, INT64_MAX, 'NORMAL');
    return {
      prefix,
      sheep,
      wheat,
      offerId: raw.offerId,
      price,
      passiveOnCreate: passive,
      amount,
      isDelete: amount === 0n,
      buyingLiabilities: () => liabilities().numSheepSend,
      sellingLiabilities: () => liabilities().numWheatReceived,
      applyLimits: (maxSheepSend, sheepSent, maxWheatReceive) => ({
        maxSheepSend: minBig(amount - sheepSent, maxSheepSend),
        maxWheatReceive,
      }),
    };
  }
  // ManageBuyOffer: the stored offer sells `selling` at the inverse price.
  const price = invertPrice(raw.price);
  const liabilities = () => exchangeV10WithoutPriceErrorThresholds(price, INT64_MAX, INT64_MAX, INT64_MAX, amount, 'NORMAL');
  return {
    prefix,
    sheep,
    wheat,
    offerId: raw.offerId,
    price,
    passiveOnCreate: false,
    amount,
    isDelete: amount === 0n,
    buyingLiabilities: () => liabilities().numSheepSend,
    sellingLiabilities: () => liabilities().numWheatReceived,
    applyLimits: (maxSheepSend, _sheepSent, maxWheatReceive, wheatReceived) => ({
      maxSheepSend,
      maxWheatReceive: minBig(amount - wheatReceived, maxWheatReceive),
    }),
  };
}

/**
 * ManageOfferOpFrameBase::doCheckValidForOverlay (protocols before 29): reject
 * offers that the price error threshold could clear without a trade. This is
 * a mempool (flooding) check only; it is not part of ledger validity.
 */
export function checkManageOfferValidForOverlay(env: OpEnv): OpResult | null {
  const spec = manageOfferSpec(env);
  if (spec.isDelete) return null;
  const amount = spec.sellingLiabilities();
  if (offerCanClearForZero(spec.price, amount) || offerCanClearForZero(spec.price, amount - 1n)) {
    return opInner(`${spec.prefix}_MALFORMED`);
  }
  return null;
}

// checkOfferValid (read only).
function checkOfferValid(ltx: LedgerTxn, sourceId: string, spec: ManageOfferSpec): OpResult | null {
  // Deleting needs no trust lines.
  if (spec.isDelete) return null;
  const p = spec.prefix;
  if (spec.sheep.type !== 'native') {
    const sheepLine = getTrustLine(ltx, sourceId, spec.sheep);
    if (!sheepLine) return opInner(`${p}_SELL_NO_TRUST`);
    if (sheepLine.balance() === 0n) return opInner(`${p}_UNDERFUNDED`);
    if (!sheepLine.isAuthorized()) return opInner(`${p}_SELL_NOT_AUTHORIZED`);
  }
  if (spec.wheat.type !== 'native') {
    const wheatLine = getTrustLine(ltx, sourceId, spec.wheat);
    if (!wheatLine) return opInner(`${p}_BUY_NO_TRUST`);
    if (!wheatLine.isAuthorized()) return opInner(`${p}_BUY_NOT_AUTHORIZED`);
  }
  return null;
}

// computeOfferExchangeParameters (read only; protocol 14+).
function computeOfferExchangeParameters(
  ltx: LedgerTxn,
  sourceId: string,
  spec: ManageOfferSpec,
): { maxSheepSend: bigint; maxWheatReceive: bigint } | OpResult {
  const header = ltx.header;
  const account = ltx.getAccount(sourceId);
  if (!account) throw new Error('source account missing');
  const sheepLine = spec.sheep.type === 'native' ? null : getTrustLine(ltx, sourceId, spec.sheep);
  const wheatLine = spec.wheat.type === 'native' ? null : getTrustLine(ltx, sourceId, spec.wheat);

  const maxWheatReceive = canBuyAtMost(header, account, spec.wheat, wheatLine);
  const maxSheepSend = canSellAtMost(header, account, spec.sheep, sheepLine);

  // The new offer's liabilities must fit into the available limit and balance
  // (negative values fail too).
  const availableLimit = spec.wheat.type === 'native' ? getMaxAmountReceive(header, account) : wheatLine!.maxAmountReceive(header);
  if (availableLimit < spec.buyingLiabilities()) return opInner(`${spec.prefix}_LINE_FULL`);
  const availableBalance = spec.sheep.type === 'native' ? getAvailableBalance(header, account) : sheepLine!.availableBalance(header);
  if (availableBalance < spec.sellingLiabilities()) return opInner(`${spec.prefix}_UNDERFUNDED`);

  return spec.applyLimits(maxSheepSend, 0n, maxWheatReceive, 0n);
}

/** Ledger offer -> xdr.OfferEntry (for the operation result). */
export function offerEntryToXdr(o: Readonly<OfferEntry>): xdr.OfferEntry {
  return new xdr.OfferEntry({
    sellerId: accountIdFromString(o.sellerId),
    offerId: int64(o.offerId),
    selling: assetToXdr(o.selling),
    buying: assetToXdr(o.buying),
    amount: int64(o.amount),
    price: new xdr.Price({ n: o.price.n, d: o.price.d }),
    flags: o.flags,
    ext: xdr.OfferEntryExt.v0(),
  });
}

function success(prefix: ManageOfferPrefix, claimed: ClaimAtom[], offer: xdr.ManageOfferSuccessResultOffer): OpResult {
  return opInner(
    `${prefix}_SUCCESS`,
    new xdr.ManageOfferSuccessResult({ offersClaimed: claimed.map(claimAtomToXdr), offer }),
  );
}

/** ManageOfferOpFrameBase::doApply (protocol 23). */
export function applyManageOffer(env: ApplyEnv): OpResult {
  const spec = manageOfferSpec(env);
  const { ltx, sourceId } = env;
  const p = spec.prefix;

  const invalid = checkOfferValid(ltx, sourceId, spec);
  if (invalid) return invalid;

  let creatingNewOffer = false;
  let flags: number;
  if (spec.offerId !== 0n) {
    // Modifying or deleting an existing offer of the source account.
    const key = offerKey(spec.offerId);
    const existing = ltx.get(key) as Readonly<OfferEntry> | undefined;
    if (!existing || existing.kind !== 'offer' || existing.sellerId !== sourceId) return opInner(`${p}_NOT_FOUND`);
    // Free its liabilities so the new offer can use them (the assets may change).
    releaseLiabilities(ltx, existing);
    flags = existing.flags;
    // The entry goes away now; its sub-entry stays counted until the end.
    ltx.erase(key);
  } else {
    creatingNewOffer = true;
    flags = spec.passiveOnCreate ? OFFER_PASSIVE_FLAG : 0;
    // Count the sub-entry (and check the reserve) before crossing.
    const account = ltx.loadAccount(sourceId);
    if (!account) throw new Error('source account missing');
    switch (createSubentry(ltx.header, account, 1)) {
      case 'SUCCESS':
        break;
      case 'LOW_RESERVE':
        return opInner(`${p}_LOW_RESERVE`);
      case 'TOO_MANY_SUBENTRIES':
        return opOuter('opTOO_MANY_SUBENTRIES');
      case 'TOO_MANY_SPONSORING':
        return opOuter('opTOO_MANY_SPONSORING');
    }
  }
  const passive = (flags & OFFER_PASSIVE_FLAG) !== 0;

  let claimed: ClaimAtom[] = [];
  let amount = 0n;
  if (!spec.isDelete) {
    const params = computeOfferExchangeParameters(ltx, sourceId, spec);
    if ('outer' in params) return params;
    // Make sure that we can actually receive something.
    if (params.maxWheatReceive === 0n) return opInner(`${p}_LINE_FULL`);

    const maxWheatPrice = invertPrice(spec.price);
    const conv = convertWithOffers(
      ltx,
      spec.sheep,
      params.maxSheepSend,
      spec.wheat,
      params.maxWheatReceive,
      'NORMAL',
      (o) => {
        if (o.offerId === spec.offerId) throw new Error('crossing the offer being modified');
        const cmp = comparePrices(o.price, maxWheatPrice);
        if ((passive && cmp >= 0) || cmp > 0) return 'STOP_BAD_PRICE';
        // We are crossing our own offer.
        if (o.sellerId === sourceId) return 'STOP_CROSS_SELF';
        return 'KEEP';
      },
      getMaxOffersToCross(),
    );

    let sheepStays: boolean;
    switch (conv.result) {
      case 'OK':
        sheepStays = false;
        break;
      case 'PARTIAL':
      case 'FILTER_STOP_BAD_PRICE':
        sheepStays = true;
        break;
      case 'FILTER_STOP_CROSS_SELF':
        return opInner(`${p}_CROSS_SELF`);
      case 'CROSSED_TOO_MANY':
        return opOuter('opEXCEEDED_WORK_LIMIT');
    }
    claimed = conv.offerTrail;

    const header = ltx.header;
    const { sheepSend: sheepSent, wheatReceived } = conv;
    if (sheepSent < 0n) throw new Error('negative sheep sent');
    if (wheatReceived > 0n) {
      // A failure here would be a bug in the exchange.
      if (!creditSource(ltx, sourceId, spec.wheat, wheatReceived)) throw new Error('offer claimed over limit');
      if (!creditSource(ltx, sourceId, spec.sheep, -sheepSent)) throw new Error('offer sold more than balance');
    }

    if (sheepStays) {
      const account = ltx.getAccount(sourceId);
      if (!account) throw new Error('source account missing');
      const sheepLine = spec.sheep.type === 'native' ? null : getTrustLine(ltx, sourceId, spec.sheep);
      const wheatLine = spec.wheat.type === 'native' ? null : getTrustLine(ltx, sourceId, spec.wheat);
      const limits = spec.applyLimits(
        canSellAtMost(header, account, spec.sheep, sheepLine),
        sheepSent,
        canBuyAtMost(header, account, spec.wheat, wheatLine),
        wheatReceived,
      );
      amount = adjustOffer(spec.price, limits.maxSheepSend, limits.maxWheatReceive);
    }
  }

  if (amount > 0n) {
    const offer = ltx.create<OfferEntry>({
      kind: 'offer',
      sellerId: sourceId,
      offerId: creatingNewOffer ? generateOfferId(ltx) : spec.offerId,
      selling: spec.sheep,
      buying: spec.wheat,
      amount,
      price: { n: spec.price.n, d: spec.price.d },
      flags,
      lastModifiedLedgerSeq: ltx.ledgerSeq,
    });
    acquireLiabilities(ltx, offer);
    const x = offerEntryToXdr(offer);
    return success(
      p,
      claimed,
      creatingNewOffer ? xdr.ManageOfferSuccessResultOffer.manageOfferCreated(x) : xdr.ManageOfferSuccessResultOffer.manageOfferUpdated(x),
    );
  }

  // No offer remains: release the sub-entry counted for it.
  const account = ltx.loadAccount(sourceId);
  if (!account) throw new Error('source account missing');
  removeSubentry(account, 1);
  return success(p, claimed, xdr.ManageOfferSuccessResultOffer.manageOfferDeleted());
}

// Add `delta` of `asset` to the source account's balance (native or trust line).
function creditSource(ltx: LedgerTxn, sourceId: string, asset: Asset, delta: bigint): boolean {
  if (asset.type === 'native') {
    const account = ltx.loadAccount(sourceId);
    return !!account && addBalance(ltx.header, account, delta);
  }
  const line = loadTrustLine(ltx, sourceId, asset);
  return !!line && line.addBalance(ltx.header, delta);
}
