// Ported from stellar-core (Apache-2.0): src/transactions/OfferExchange.cpp
// Crossing offers in the order book: canSellAtMost, canBuyAtMost,
// crossOfferV10 and convertWithOffers (the order book part of
// convertWithOffersAndPools; this network has no liquidity pools).

import { xdr } from '@stellar/stellar-sdk/base';
import { addBalance, getAvailableBalance, getMaxAmountReceive, loadTrustLine, type TrustLineHandle } from '../balances';
import { offerKey } from '../keys';
import { maxBig, minBig } from '../math';
import { acquireLiabilities, eraseOfferEntry, releaseLiabilities } from '../offers';
import type { LedgerTxn } from '../state';
import type { AccountEntry, Asset, LedgerHeader, OfferEntry } from '../types';
import { accountIdFromString, accountIdToString, assetFromXdr, assetToXdr, int64 } from '../xdrutil';
import { adjustOffer, exchangeV10, type ExchangeRounding } from './exchange';

type ReserveHeader = Pick<LedgerHeader, 'baseReserve'>;

// ---------------------------------------------------------------- claim atoms

/**
 * One crossed offer (ClaimOfferAtom): its seller sold `amountSold` of
 * `assetSold` and received `amountBought` of `assetBought`.
 */
export interface ClaimAtom {
  sellerId: string;
  offerId: bigint;
  assetSold: Asset;
  amountSold: bigint;
  assetBought: Asset;
  amountBought: bigint;
}

/** makeClaimAtom for protocol 18+: CLAIM_ATOM_TYPE_ORDER_BOOK. */
export function claimAtomToXdr(a: ClaimAtom): xdr.ClaimAtom {
  return xdr.ClaimAtom.claimAtomTypeOrderBook(
    new xdr.ClaimOfferAtom({
      sellerId: accountIdFromString(a.sellerId),
      offerId: int64(a.offerId),
      assetSold: assetToXdr(a.assetSold),
      amountSold: int64(a.amountSold),
      assetBought: assetToXdr(a.assetBought),
      amountBought: int64(a.amountBought),
    }),
  );
}

/** Order book claim atom from XDR (V0 or ORDER_BOOK); null for liquidity pool atoms. */
export function claimAtomFromXdr(x: xdr.ClaimAtom): ClaimAtom | null {
  switch (x.type) {
    case 'claimAtomTypeOrderBook': {
      const a = x.orderBook;
      return {
        sellerId: accountIdToString(a.sellerId),
        offerId: a.offerId,
        assetSold: assetFromXdr(a.assetSold),
        amountSold: a.amountSold,
        assetBought: assetFromXdr(a.assetBought),
        amountBought: a.amountBought,
      };
    }
    case 'claimAtomTypeV0': {
      const a = x.v0;
      return {
        sellerId: accountIdToString(xdr.PublicKey.publicKeyTypeEd25519(a.sellerEd25519)),
        offerId: a.offerId,
        assetSold: assetFromXdr(a.assetSold),
        amountSold: a.amountSold,
        assetBought: assetFromXdr(a.assetBought),
        amountBought: a.amountBought,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- limits

/** MAX_OFFERS_TO_CROSS: offers one operation may cross (protocol 11+). */
export const MAX_OFFERS_TO_CROSS = 1000;

let maxOffersToCross = MAX_OFFERS_TO_CROSS;

/** getMaxOffersToCross */
export function getMaxOffersToCross(): number {
  return maxOffersToCross;
}

/**
 * Test hook like stellar-core TempReduceLimitsForTesting. Returns a function
 * that restores the previous limit. Never use outside tests.
 */
export function reduceMaxOffersToCrossForTesting(limit: number): () => void {
  const old = maxOffersToCross;
  maxOffersToCross = limit;
  return () => {
    maxOffersToCross = old;
  };
}

/** canSellAtMost: how much of `asset` the account can send (never negative). */
export function canSellAtMost(
  header: ReserveHeader,
  account: Readonly<AccountEntry> | undefined,
  asset: Asset,
  line: TrustLineHandle | null,
): bigint {
  if (asset.type === 'native') {
    if (!account) throw new Error('canSellAtMost: missing account');
    return maxBig(getAvailableBalance(header, account), 0n);
  }
  if (line && line.isAuthorizedToMaintainLiabilities()) return maxBig(line.availableBalance(header), 0n);
  return 0n;
}

/** canBuyAtMost: how much of `asset` the account can receive (never negative). */
export function canBuyAtMost(
  header: ReserveHeader,
  account: Readonly<AccountEntry> | undefined,
  asset: Asset,
  line: TrustLineHandle | null,
): bigint {
  if (asset.type === 'native') {
    if (!account) throw new Error('canBuyAtMost: missing account');
    return maxBig(getMaxAmountReceive(header, account), 0n);
  }
  return line ? maxBig(line.maxAmountReceive(header), 0n) : 0n;
}

// ---------------------------------------------------------------- order book

/** Offers selling `selling` for `buying`, best first (isBetterOffer: price as double, then offer id). */
export function sortedOffers(ltx: LedgerTxn, selling: Asset, buying: Asset): Readonly<OfferEntry>[] {
  return [...ltx.offersInBookOrder(selling, buying)];
}

// ---------------------------------------------------------------- crossing

export type OfferFilterResult = 'KEEP' | 'STOP_BAD_PRICE' | 'STOP_CROSS_SELF';

export type ConvertResult = 'OK' | 'PARTIAL' | 'FILTER_STOP_BAD_PRICE' | 'FILTER_STOP_CROSS_SELF' | 'CROSSED_TOO_MANY';

interface CrossResult {
  taken: boolean;
  numWheatReceived: bigint;
  numSheepSend: bigint;
  wheatStays: boolean;
  atom: ClaimAtom;
}

// adjustOffer on a loaded offer entry, with the seller's current limits.
function adjustOfferEntry(
  header: ReserveHeader,
  offer: OfferEntry,
  account: AccountEntry | undefined,
  wheat: Asset,
  wheatLine: TrustLineHandle | null,
  sheep: Asset,
  sheepLine: TrustLineHandle | null,
): void {
  const maxWheatSend = minBig(offer.amount, canSellAtMost(header, account, wheat, wheatLine));
  const maxSheepReceive = canBuyAtMost(header, account, sheep, sheepLine);
  offer.amount = adjustOffer(offer.price, maxWheatSend, maxSheepReceive);
}

// crossOfferV10: cross one offer that sells wheat for sheep. Mutates `ltx`.
function crossOfferV10(
  ltx: LedgerTxn,
  offerId: bigint,
  maxWheatReceived: bigint,
  maxSheepSend: bigint,
  round: ExchangeRounding,
): CrossResult {
  if (maxWheatReceived <= 0n || maxSheepSend <= 0n) throw new Error('crossOfferV10: nothing to exchange');
  const header = ltx.header;
  const offer = ltx.load(offerKey(offerId)) as OfferEntry | undefined;
  if (!offer || offer.kind !== 'offer') throw new Error(`crossOfferV10: offer ${offerId} does not exist`);
  const sheep = offer.buying;
  const wheat = offer.selling;
  const sellerId = offer.sellerId;
  if (!ltx.getAccount(sellerId)) throw new Error('invalid database state: offer must have matching account');

  // Remove the liabilities of the crossed offer (throws if either asset is unauthorized).
  releaseLiabilities(ltx, offer);

  const account = wheat.type === 'native' || sheep.type === 'native' ? ltx.loadAccount(sellerId) : undefined;
  const sheepLine = sheep.type === 'native' ? null : loadTrustLine(ltx, sellerId, sheep);
  const wheatLine = wheat.type === 'native' ? null : loadTrustLine(ltx, sellerId, wheat);

  // Has no effect since protocol 10; kept as a safety measure like stellar-core.
  adjustOfferEntry(header, offer, account, wheat, wheatLine, sheep, sheepLine);

  const maxWheatSend = minBig(offer.amount, canSellAtMost(header, account, wheat, wheatLine));
  const maxSheepReceive = canBuyAtMost(header, account, sheep, sheepLine);
  const ex = exchangeV10(offer.price, maxWheatSend, maxWheatReceived, maxSheepSend, maxSheepReceive, round);

  if (ex.numSheepSend !== 0n) {
    const ok = sheep.type === 'native' ? addBalance(header, account!, ex.numSheepSend) : sheepLine!.addBalance(header, ex.numSheepSend);
    if (!ok) throw new Error('overflowed sheep balance');
  }
  if (ex.numWheatReceived !== 0n) {
    const ok =
      wheat.type === 'native' ? addBalance(header, account!, -ex.numWheatReceived) : wheatLine!.addBalance(header, -ex.numWheatReceived);
    if (!ok) throw new Error('overflowed wheat balance');
  }

  if (ex.wheatStays) {
    offer.amount -= ex.numWheatReceived;
    adjustOfferEntry(header, offer, account, wheat, wheatLine, sheep, sheepLine);
  } else {
    offer.amount = 0n;
  }

  const taken = offer.amount === 0n;
  if (taken) eraseOfferEntry(ltx, offerId);
  else acquireLiabilities(ltx, offer);

  return {
    taken,
    numWheatReceived: ex.numWheatReceived,
    numSheepSend: ex.numSheepSend,
    wheatStays: ex.wheatStays,
    atom: {
      sellerId,
      offerId,
      assetSold: wheat,
      amountSold: ex.numWheatReceived,
      assetBought: sheep,
      amountBought: ex.numSheepSend,
    },
  };
}

export interface ConvertOutcome {
  result: ConvertResult;
  /** Sheep sent by the taker (the crossed sellers received it). */
  sheepSend: bigint;
  /** Wheat received by the taker. */
  wheatReceived: bigint;
  /** Crossed offers in crossing order. */
  offerTrail: ClaimAtom[];
}

/**
 * convertWithOffers: buy up to `maxWheatReceive` wheat with up to
 * `maxSheepSend` sheep by crossing offers that sell wheat for sheep, best
 * first. Updates the sellers of the crossed offers; the taker's own balances
 * are not touched. The caller decides what to do with partial results (the
 * crossed offers stay crossed in `ltxOuter`).
 */
export function convertWithOffers(
  ltxOuter: LedgerTxn,
  sheep: Asset,
  maxSheepSend: bigint,
  wheat: Asset,
  maxWheatReceive: bigint,
  round: ExchangeRounding,
  filter: (offer: Readonly<OfferEntry>) => OfferFilterResult,
  offersToCross: number,
): ConvertOutcome {
  const offerTrail: ClaimAtom[] = [];
  let sheepSend = 0n;
  let wheatReceived = 0n;
  const outcome = (result: ConvertResult): ConvertOutcome => ({ result, sheepSend, wheatReceived, offerTrail });

  let needMore = maxWheatReceive > 0n && maxSheepSend > 0n;
  // The offer trail would be too long: fail fast (protocol 18+).
  if (needMore && offersToCross <= 0) return outcome('CROSSED_TOO_MANY');
  if (!needMore) return outcome('OK');

  // Crossing changes no other offer of the book: a crossed offer is either
  // removed or partially taken, and a partial take ends the loop. So walking
  // the book order fixed at the start gives the same order as loading the
  // best offer each time. The walk is lazy: its cost does not grow with the
  // size of the book.
  for (const candidate of ltxOuter.offersInBookOrder(wheat, sheep)) {
    const ltx = ltxOuter.child();
    let cross: CrossResult;
    try {
      const offer = ltx.get(offerKey(candidate.offerId)) as Readonly<OfferEntry> | undefined;
      if (!offer) throw new Error('order book changed while crossing');
      const f = filter(offer);
      if (f !== 'KEEP') {
        ltx.rollback();
        return outcome(f === 'STOP_BAD_PRICE' ? 'FILTER_STOP_BAD_PRICE' : 'FILTER_STOP_CROSS_SELF');
      }
      if (offerTrail.length >= offersToCross) {
        ltx.rollback();
        return outcome('CROSSED_TOO_MANY');
      }
      cross = crossOfferV10(ltx, offer.offerId, maxWheatReceive, maxSheepSend, round);
      if (cross.numSheepSend < 0n || cross.numSheepSend > maxSheepSend) throw new Error('crossOfferV10: sheep out of bounds');
      if (cross.numWheatReceived < 0n || cross.numWheatReceived > maxWheatReceive) throw new Error('crossOfferV10: wheat out of bounds');
      ltx.commit();
    } catch (err) {
      ltx.rollback();
      throw err;
    }

    offerTrail.push(cross.atom);
    sheepSend += cross.numSheepSend;
    maxSheepSend -= cross.numSheepSend;
    wheatReceived += cross.numWheatReceived;
    maxWheatReceive -= cross.numWheatReceived;

    needMore = !cross.wheatStays && maxWheatReceive > 0n && maxSheepSend > 0n;
    if (!needMore) return outcome('OK');
    if (!cross.taken) return outcome('PARTIAL');
  }
  return outcome(needMore ? 'PARTIAL' : 'OK');
}
