// Read-only DEX helpers for the node and the UI: order book price levels,
// path payment quotes and path finding against the last closed ledger.
//
// Quotes run the same crossing code as PathPaymentStrictSend/Receive
// (convertWithOffers) on a throwaway copy of the state, so a quote equals the
// result of the operation if the ledger does not change in between. Quotes do
// not check the sender's balance or the destination's trust line.

import { assetEquals, assetId } from '../asset';
import { INT64_MAX } from '../math';
import { LedgerRoot } from '../state';
import type { Asset, Hash, LedgerEntry, LedgerHeader, OfferEntry, Price } from '../types';
import { convertWithOffers, getMaxOffersToCross, type ClaimAtom } from './convert';
import { comparePrices, invertPrice } from './exchange';

// ---------------------------------------------------------------- price levels

export interface PriceLevel {
  /** Price of the level (buying per selling of the offers, or inverted). */
  price: Price;
  /** Sum of the offer amounts (in the offers' selling asset). */
  amount: bigint;
  offers: number;
}

/**
 * Group offers of one book (best first, as getOrderBook returns them) into
 * price levels with exact price equality. With `invert`, level prices are
 * d/n (use it to show the opposite book as bids).
 */
export function priceLevels(offers: readonly Readonly<OfferEntry>[], invert = false): PriceLevel[] {
  const levels: PriceLevel[] = [];
  for (const o of offers) {
    const last = levels[levels.length - 1];
    const price = invert ? invertPrice(o.price) : { n: o.price.n, d: o.price.d };
    if (last && comparePrices(last.price, price) === 0) {
      last.amount += o.amount;
      last.offers += 1;
    } else {
      levels.push({ price, amount: o.amount, offers: 1 });
    }
  }
  return levels;
}

// ---------------------------------------------------------------- quotes

/** The part of ILedgerManager the quotes need. */
export interface LedgerView {
  lastClosed(): { header: LedgerHeader; hash: Hash };
  allEntries(): LedgerEntry[];
}

export type QuoteError = 'TOO_FEW_OFFERS' | 'OFFER_CROSS_SELF' | 'EXCEEDED_WORK_LIMIT';

export interface Quote {
  ok: true;
  sendAsset: Asset;
  destAsset: Asset;
  /** Intermediate assets. */
  path: Asset[];
  sendAmount: bigint;
  destAmount: bigint;
  /** Crossed offers in path order. */
  offers: ClaimAtom[];
}

export type QuoteResult = Quote | { ok: false; error: QuoteError };

export interface QuoteRequest {
  sendAsset: Asset;
  destAsset: Asset;
  path?: Asset[];
  /** The paying account: its own offers make the quote fail with OFFER_CROSS_SELF. */
  sourceId?: string;
}

// One state copy per ledger view and LCL hash.
const roots = new WeakMap<object, { hash: Hash; root: LedgerRoot; header: LedgerHeader }>();

function snapshotOf(view: LedgerView): { root: LedgerRoot; header: LedgerHeader } {
  const lcl = view.lastClosed();
  const cached = roots.get(view);
  if (cached && cached.hash === lcl.hash) return cached;
  const fresh = { hash: lcl.hash, root: new LedgerRoot(view.allEntries()), header: lcl.header };
  roots.set(view, fresh);
  return fresh;
}

type Hop = { send: Asset; recv: Asset };

function hopsOf(sendAsset: Asset, path: Asset[], destAsset: Asset): Hop[] {
  const hops: Hop[] = [];
  let cur = sendAsset;
  for (const next of [...path, destAsset]) {
    if (assetEquals(cur, next)) continue;
    hops.push({ send: cur, recv: next });
    cur = next;
  }
  return hops;
}

function runQuote(view: LedgerView, req: QuoteRequest, amount: bigint, strictSend: boolean): QuoteResult {
  if (amount <= 0n) throw new Error('quote amount must be positive');
  const path = req.path ?? [];
  const hops = hopsOf(req.sendAsset, path, req.destAsset);
  const { root, header } = snapshotOf(view);
  const ltx = root.begin(header, header.ledgerSeq + 1);
  try {
    let offersLeft = getMaxOffersToCross();
    const trail: ClaimAtom[][] = [];
    let carried = amount;
    const ordered = strictSend ? hops : [...hops].reverse();
    for (const hop of ordered) {
      const r = convertWithOffers(
        ltx,
        hop.send,
        strictSend ? carried : INT64_MAX,
        hop.recv,
        strictSend ? INT64_MAX : carried,
        strictSend ? 'PATH_PAYMENT_STRICT_SEND' : 'PATH_PAYMENT_STRICT_RECEIVE',
        (o) => (req.sourceId !== undefined && o.sellerId === req.sourceId ? 'STOP_CROSS_SELF' : 'KEEP'),
        offersLeft,
      );
      if (r.result === 'FILTER_STOP_CROSS_SELF') return { ok: false, error: 'OFFER_CROSS_SELF' };
      if (r.result === 'CROSSED_TOO_MANY') return { ok: false, error: 'EXCEEDED_WORK_LIMIT' };
      const complete = strictSend ? r.sheepSend === carried : r.wheatReceived === carried;
      if (r.result !== 'OK' || !complete) return { ok: false, error: 'TOO_FEW_OFFERS' };
      offersLeft -= r.offerTrail.length;
      trail.push(r.offerTrail);
      carried = strictSend ? r.wheatReceived : r.sheepSend;
    }
    const offers = (strictSend ? trail : trail.reverse()).flat();
    return {
      ok: true,
      sendAsset: req.sendAsset,
      destAsset: req.destAsset,
      path,
      sendAmount: strictSend ? amount : carried,
      destAmount: strictSend ? carried : amount,
      offers,
    };
  } finally {
    ltx.rollback();
  }
}

/** What PathPaymentStrictSend would deliver for `sendAmount` (before destMin). */
export function quoteStrictSend(view: LedgerView, req: QuoteRequest & { sendAmount: bigint }): QuoteResult {
  return runQuote(view, req, req.sendAmount, true);
}

/** What PathPaymentStrictReceive would cost for `destAmount` (before sendMax). */
export function quoteStrictReceive(view: LedgerView, req: QuoteRequest & { destAmount: bigint }): QuoteResult {
  return runQuote(view, req, req.destAmount, false);
}

export interface FindPathsRequest {
  mode: 'strictSend' | 'strictReceive';
  sendAsset: Asset;
  destAsset: Asset;
  /** sendAmount for strict send, destAmount for strict receive. */
  amount: bigint;
  /** Max intermediate assets (the protocol allows 5). Default 3. */
  maxPathLength?: number;
  sourceId?: string;
  /** Max results. Default 5. */
  limit?: number;
  /**
   * Work budget: edges the search may follow (a candidate path is one, and
   * each candidate is quoted). Default FIND_PATHS_MAX_STEPS. The search order
   * is fixed, so below the budget the results equal an unbounded search; at
   * the budget the search stops and ranks the candidates found so far. The
   * search goes by path length, so those include every shorter path.
   */
  maxSteps?: number;
}

/** Default work budget of findPaths. A dense market has millions of simple paths. */
export const FIND_PATHS_MAX_STEPS = 2_000;

/**
 * Find paths through the order books (like Horizon's /paths endpoints). Every
 * candidate is quoted exactly; results are best first: most received for
 * strict send, least sent for strict receive, then shorter paths. The search
 * stops after `maxSteps` edges.
 */
export function findPaths(view: LedgerView, req: FindPathsRequest): Quote[] {
  const maxLen = Math.min(5, Math.max(0, req.maxPathLength ?? 3));
  // Conversion graph: X -> Y when some offer sells Y for X.
  const edges = new Map<string, Map<string, Asset>>();
  for (const e of view.allEntries()) {
    if (e.kind !== 'offer') continue;
    const from = assetId(e.buying);
    let m = edges.get(from);
    if (!m) edges.set(from, (m = new Map()));
    m.set(assetId(e.selling), e.selling);
  }
  const sorted = new Map<string, [string, Asset][]>();
  for (const [from, m] of edges) sorted.set(from, [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const destKey = assetId(req.destAsset);
  const candidates: Asset[][] = [];
  let stepsLeft = req.maxSteps ?? FIND_PATHS_MAX_STEPS;
  if (assetEquals(req.sendAsset, req.destAsset)) candidates.push([]);
  else {
    // Breadth first: a budget cut keeps every shorter path (a depth-first
    // walk could spend it all below the first neighbour and miss the direct
    // book). Paths of one length come in the same order as depth first.
    const start = assetId(req.sendAsset);
    let level: { at: string; path: Asset[]; seen: Set<string> }[] = [{ at: start, path: [], seen: new Set([start]) }];
    search: while (level.length > 0) {
      const next: typeof level = [];
      for (const { at, path, seen } of level) {
        for (const [k, asset] of sorted.get(at) ?? []) {
          if (stepsLeft <= 0) break search;
          stepsLeft--;
          if (k === destKey) candidates.push(path);
          else if (path.length < maxLen && !seen.has(k)) next.push({ at: k, path: [...path, asset], seen: new Set(seen).add(k) });
        }
      }
      level = next;
    }
  }

  const quotes: Quote[] = [];
  for (const path of candidates) {
    const base = { sendAsset: req.sendAsset, destAsset: req.destAsset, path, sourceId: req.sourceId };
    const q = req.mode === 'strictSend' ? quoteStrictSend(view, { ...base, sendAmount: req.amount }) : quoteStrictReceive(view, { ...base, destAmount: req.amount });
    if (q.ok) quotes.push(q);
  }
  quotes.sort((a, b) => {
    if (req.mode === 'strictSend' && a.destAmount !== b.destAmount) return a.destAmount > b.destAmount ? -1 : 1;
    if (req.mode === 'strictReceive' && a.sendAmount !== b.sendAmount) return a.sendAmount < b.sendAmount ? -1 : 1;
    return a.path.length - b.path.length;
  });
  return quotes.slice(0, req.limit ?? 5);
}
