// Test helpers for DEX scenarios: accounts, assets, trust lines, offers and
// path payments on top of the ledger TestLedger, plus ledger invariants.

import { Asset as SdkAsset, Keypair, Operation, xdr } from '@stellar/stellar-sdk/base';
import { assetEquals, assetId } from '../asset';
import { minBalance } from '../balances';
import { trustlineKey } from '../keys';
import { INT64_MAX } from '../math';
import { offerLiabilities } from '../offers';
import { opResultCode, txResultCode } from '../results';
import { TestLedger, XLM, stroopsToString } from '../testkit';
import type { LedgerManager } from '../manager';
import type { AccountEntry, Asset, LedgerEntry, OfferEntry, Price, TrustLineEntry, TxApplyResult } from '../types';
import { accountIdToString, assetFromXdr } from '../xdrutil';
import { claimAtomFromXdr, type ClaimAtom } from './convert';
import { comparePrices } from './exchange';

export { XLM };

/** Stroops -> SDK amount string. */
export const amt = (v: bigint): string => stroopsToString(v);

/** An asset for tests: the SDK asset (for building ops) and the ledger asset. */
export interface TAsset {
  sdk: SdkAsset;
  asset: Asset;
}

export const XLM_ASSET: TAsset = { sdk: SdkAsset.native(), asset: { type: 'native' } };

export function credit(code: string, issuer: Keypair | string): TAsset {
  const id = typeof issuer === 'string' ? issuer : issuer.publicKey();
  return {
    sdk: new SdkAsset(code, id),
    asset: { type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code, issuer: id },
  };
}

const idOf = (k: Keypair | string): string => (typeof k === 'string' ? k : k.publicKey());

/** Decoded outcome of a one-operation transaction. */
export interface DexOutcome {
  result: TxApplyResult;
  /** Result code of the operation ("MANAGE_SELL_OFFER_SUCCESS", "opEXCEEDED_WORK_LIMIT") or the tx code. */
  code: string;
  claimed: ClaimAtom[];
  /** Manage offer effect. */
  effect?: 'created' | 'updated' | 'deleted';
  /** Offer in a CREATED or UPDATED result. */
  offer?: { offerId: bigint; sellerId: string; selling: Asset; buying: Asset; amount: bigint; price: Price; flags: number };
  /** Path payment `last`. */
  last?: { destination: string; asset: Asset; amount: bigint };
}

export function decodeOutcome(result: TxApplyResult, opIndex = 0): DexOutcome {
  const tr = xdr.TransactionResult.fromXdr(result.resultXdr, 'base64');
  const res = tr.result;
  if (res.type !== 'txSuccess' && res.type !== 'txFailed') return { result, code: txResultCode(tr), claimed: [] };
  const opr = res.results[opIndex];
  const code = opResultCode(opr);
  const out: DexOutcome = { result, code, claimed: [] };
  if (!code.endsWith('_SUCCESS') || opr.type !== 'opInner') return out;
  const type = result.operations[opIndex]?.type;
  if (!['manageSellOffer', 'manageBuyOffer', 'createPassiveSellOffer', 'pathPaymentStrictReceive', 'pathPaymentStrictSend'].includes(type)) {
    return out;
  }
  // The data of the success arm of the operation's result union.
  const success = opr.tr.value.value;
  if (success instanceof xdr.ManageOfferSuccessResult) {
    out.claimed = success.offersClaimed.map((a) => claimAtomFromXdr(a)!);
    const offer = success.offer;
    out.effect = offer.type === 'manageOfferCreated' ? 'created' : offer.type === 'manageOfferUpdated' ? 'updated' : 'deleted';
    if (offer.type !== 'manageOfferDeleted') {
      const o = offer.offer;
      out.offer = {
        offerId: o.offerId,
        sellerId: accountIdToString(o.sellerId),
        selling: assetFromXdr(o.selling),
        buying: assetFromXdr(o.buying),
        amount: o.amount,
        price: { n: o.price.n, d: o.price.d },
        flags: o.flags,
      };
    }
  } else if (success instanceof xdr.PathPaymentStrictReceiveResultSuccess || success instanceof xdr.PathPaymentStrictSendResultSuccess) {
    out.claimed = success.offers.map((a) => claimAtomFromXdr(a)!);
    const last = success.last;
    out.last = { destination: accountIdToString(last.destination), asset: assetFromXdr(last.asset), amount: last.amount };
  }
  return out;
}

/** Short form of a claim atom for assertions: [offerId, amountSold, amountBought]. */
export function atoms(claimed: ClaimAtom[]): [bigint, bigint, bigint][] {
  return claimed.map((c) => [c.offerId, c.amountSold, c.amountBought]);
}

export class Dex {
  readonly t: TestLedger;

  constructor(t?: TestLedger) {
    this.t = t ?? new TestLedger();
  }

  get lm(): LedgerManager {
    return this.t.lm;
  }

  /** (2 + n) * baseReserve */
  minBalance(subEntries: number): bigint {
    return BigInt(2 + subEntries) * BigInt(this.lm.lastClosed().header.baseReserve);
  }

  /** Create and fund new accounts in one ledger. */
  accounts(n: number, balance = 1000n * XLM): Keypair[] {
    const kps = Array.from({ length: n }, () => Keypair.random());
    for (let i = 0; i < kps.length; i += 100) this.t.fund(kps.slice(i, i + 100), balance);
    return kps;
  }

  account(balance = 1000n * XLM): Keypair {
    return this.accounts(1, balance)[0];
  }

  /** Apply a transaction with these operations and return its result. */
  submit(source: Keypair, ops: xdr.Operation[], signers?: Keypair[]): TxApplyResult {
    return this.t.apply(this.t.tx(source, ops, signers ? { signers } : {}));
  }

  /** Apply a one-operation transaction and decode the outcome. */
  run(source: Keypair, op: xdr.Operation, signers?: Keypair[]): DexOutcome {
    return decodeOutcome(this.submit(source, [op], signers));
  }

  /** Like run, but throws unless the transaction succeeded. */
  must(source: Keypair, op: xdr.Operation, signers?: Keypair[]): DexOutcome {
    const o = this.run(source, op, signers);
    if (!o.result.successful) throw new Error(`expected success, got ${o.result.resultCode} / ${o.code}`);
    return o;
  }

  trust(holder: Keypair, a: TAsset, limit: bigint = INT64_MAX): void {
    this.must(holder, Operation.changeTrust({ asset: a.sdk, limit: amt(limit) }));
  }

  pay(from: Keypair, to: Keypair | string, a: TAsset, amount: bigint): DexOutcome {
    return this.run(from, Operation.payment({ destination: idOf(to), asset: a.sdk, amount: amt(amount) }));
  }

  /** Issue `amount` of a credit asset from its issuer. */
  issue(issuer: Keypair, to: Keypair | string, a: TAsset, amount: bigint): void {
    const o = this.pay(issuer, to, a, amount);
    if (o.code !== 'PAYMENT_SUCCESS') throw new Error(`issue failed: ${o.code}`);
  }

  sell(kp: Keypair, selling: TAsset, buying: TAsset, amount: bigint, price: Price, offerId: bigint | number = 0n): DexOutcome {
    return this.run(
      kp,
      Operation.manageSellOffer({ selling: selling.sdk, buying: buying.sdk, amount: amt(amount), price, offerId: offerId.toString() }),
    );
  }

  buy(kp: Keypair, selling: TAsset, buying: TAsset, buyAmount: bigint, price: Price, offerId: bigint | number = 0n): DexOutcome {
    return this.run(
      kp,
      Operation.manageBuyOffer({ selling: selling.sdk, buying: buying.sdk, buyAmount: amt(buyAmount), price, offerId: offerId.toString() }),
    );
  }

  passive(kp: Keypair, selling: TAsset, buying: TAsset, amount: bigint, price: Price): DexOutcome {
    return this.run(kp, Operation.createPassiveSellOffer({ selling: selling.sdk, buying: buying.sdk, amount: amt(amount), price }));
  }

  strictReceive(
    kp: Keypair,
    dest: Keypair | string,
    sendAsset: TAsset,
    sendMax: bigint,
    destAsset: TAsset,
    destAmount: bigint,
    path: TAsset[] = [],
  ): DexOutcome {
    return this.run(
      kp,
      Operation.pathPaymentStrictReceive({
        sendAsset: sendAsset.sdk,
        sendMax: amt(sendMax),
        destination: idOf(dest),
        destAsset: destAsset.sdk,
        destAmount: amt(destAmount),
        path: path.map((p) => p.sdk),
      }),
    );
  }

  strictSend(
    kp: Keypair,
    dest: Keypair | string,
    sendAsset: TAsset,
    sendAmount: bigint,
    destAsset: TAsset,
    destMin: bigint,
    path: TAsset[] = [],
  ): DexOutcome {
    return this.run(
      kp,
      Operation.pathPaymentStrictSend({
        sendAsset: sendAsset.sdk,
        sendAmount: amt(sendAmount),
        destination: idOf(dest),
        destAsset: destAsset.sdk,
        destMin: amt(destMin),
        path: path.map((p) => p.sdk),
      }),
    );
  }

  // ------------------------------------------------------------ state

  accountEntry(k: Keypair | string): AccountEntry {
    const a = this.lm.getAccount(idOf(k));
    if (!a) throw new Error(`no account ${idOf(k)}`);
    return a;
  }

  /** Native balance, or the trust line balance (0 without a trust line). */
  balance(k: Keypair | string, a: TAsset): bigint {
    if (a.asset.type === 'native') return this.lm.getAccount(idOf(k))?.balance ?? 0n;
    const tl = this.lm.getEntry(trustlineKey(idOf(k), a.asset)) as TrustLineEntry | undefined;
    return tl?.balance ?? 0n;
  }

  line(k: Keypair | string, a: TAsset): TrustLineEntry | undefined {
    if (a.asset.type === 'native') throw new Error('native has no trust line');
    return this.lm.getEntry(trustlineKey(idOf(k), a.asset)) as TrustLineEntry | undefined;
  }

  offer(id: bigint): OfferEntry | undefined {
    const e = this.lm.getEntry(`O:${id}`);
    return e?.kind === 'offer' ? e : undefined;
  }

  offersOf(k: Keypair | string): OfferEntry[] {
    return this.lm.getOffersByAccount(idOf(k));
  }

  book(selling: TAsset, buying: TAsset, limit?: number): OfferEntry[] {
    return this.lm.getOrderBook(selling.asset, buying.asset, limit);
  }

  /** Throws if any DEX invariant is broken (see checkDexInvariants). */
  checkInvariants(): void {
    const errors = checkDexInvariants(this.lm.allEntries(), this.lm.lastClosed().header.baseReserve);
    if (errors.length) throw new Error(`invariants broken:\n${errors.join('\n')}`);
  }
}

/**
 * DEX invariants over a full ledger state:
 * - every account and trust line carries exactly the liabilities of its offers;
 * - balances cover selling liabilities and limits cover buying liabilities
 *   (native balances may fall up to `feeSlack` below because fees are charged
 *   regardless of liabilities);
 * - numSubEntries = trust lines + offers + data entries + signers;
 * - offers are positive, well priced, and their seller can hold both assets;
 * - the book is not crossed: for any two opposite offers, p1 * p2 >= 1.
 */
export function checkDexInvariants(entries: LedgerEntry[], baseReserve: number, feeSlack = 10_000n): string[] {
  const errors: string[] = [];
  const accounts = new Map<string, AccountEntry>();
  const lines = new Map<string, TrustLineEntry>();
  const offers: OfferEntry[] = [];
  const subEntries = new Map<string, number>();
  const bump = (id: string) => subEntries.set(id, (subEntries.get(id) ?? 0) + 1);
  for (const e of entries) {
    if (e.kind === 'account') accounts.set(e.accountId, e);
    else if (e.kind === 'trustline') {
      lines.set(trustlineKey(e.accountId, e.asset), e);
      bump(e.accountId);
    } else if (e.kind === 'offer') {
      offers.push(e);
      bump(e.sellerId);
    } else if (e.kind === 'data') bump(e.accountId);
  }

  const selling = new Map<string, bigint>();
  const buying = new Map<string, bigint>();
  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
  const holderKey = (id: string, a: Asset) => (a.type === 'native' ? `A:${id}` : trustlineKey(id, a));

  for (const o of offers) {
    if (o.amount <= 0n) errors.push(`offer ${o.offerId}: amount ${o.amount}`);
    if (o.price.n <= 0 || o.price.d <= 0) errors.push(`offer ${o.offerId}: bad price`);
    if (assetEquals(o.selling, o.buying)) errors.push(`offer ${o.offerId}: same assets`);
    if (!accounts.has(o.sellerId)) errors.push(`offer ${o.offerId}: no seller account`);
    for (const a of [o.selling, o.buying]) {
      if (a.type !== 'native' && a.issuer !== o.sellerId && !lines.has(trustlineKey(o.sellerId, a))) {
        errors.push(`offer ${o.offerId}: seller has no trust line for ${assetId(a)}`);
      }
    }
    const l = offerLiabilities(o);
    if (l.selling <= 0n || l.buying <= 0n) errors.push(`offer ${o.offerId}: empty liabilities`);
    const issuerSells = o.selling.type !== 'native' && o.selling.issuer === o.sellerId;
    const issuerBuys = o.buying.type !== 'native' && o.buying.issuer === o.sellerId;
    if (!issuerSells) add(selling, holderKey(o.sellerId, o.selling), l.selling);
    if (!issuerBuys) add(buying, holderKey(o.sellerId, o.buying), l.buying);
  }

  const header = { baseReserve };
  for (const [id, acc] of accounts) {
    const k = `A:${id}`;
    if (acc.sellingLiabilities !== (selling.get(k) ?? 0n)) errors.push(`${k}: selling liabilities ${acc.sellingLiabilities} != ${selling.get(k) ?? 0n}`);
    if (acc.buyingLiabilities !== (buying.get(k) ?? 0n)) errors.push(`${k}: buying liabilities ${acc.buyingLiabilities} != ${buying.get(k) ?? 0n}`);
    // Fees may take a native balance below reserve + selling liabilities, so
    // only the selling liabilities themselves are checked against the balance.
    if (acc.sellingLiabilities > acc.balance - minBalance(header, acc) + feeSlack) {
      errors.push(`${k}: selling liabilities above the free balance`);
    }
    if (acc.balance > INT64_MAX - acc.buyingLiabilities) errors.push(`${k}: buying liabilities overflow`);
    const expectedSub = (subEntries.get(id) ?? 0) + acc.signers.length;
    if (acc.numSubEntries !== expectedSub) errors.push(`${k}: numSubEntries ${acc.numSubEntries} != ${expectedSub}`);
  }
  for (const [k, tl] of lines) {
    if (tl.sellingLiabilities !== (selling.get(k) ?? 0n)) errors.push(`${k}: selling liabilities ${tl.sellingLiabilities} != ${selling.get(k) ?? 0n}`);
    if (tl.buyingLiabilities !== (buying.get(k) ?? 0n)) errors.push(`${k}: buying liabilities ${tl.buyingLiabilities} != ${buying.get(k) ?? 0n}`);
    if (tl.balance < tl.sellingLiabilities) errors.push(`${k}: balance below selling liabilities`);
    if (tl.balance + tl.buyingLiabilities > tl.limit) errors.push(`${k}: balance + buying liabilities above limit`);
  }

  // The book is not crossed.
  const best = new Map<string, OfferEntry>();
  for (const o of offers) {
    const pair = `${assetId(o.selling)}|${assetId(o.buying)}`;
    const cur = best.get(pair);
    if (!cur || comparePrices(o.price, cur.price) < 0) best.set(pair, o);
  }
  for (const [pair, o] of best) {
    const [s, b] = pair.split('|');
    const opp = best.get(`${b}|${s}`);
    if (!opp || s > b) continue;
    // p1 * p2 >= 1  <=>  p1.n * p2.n >= p1.d * p2.d
    if (BigInt(o.price.n) * BigInt(opp.price.n) < BigInt(o.price.d) * BigInt(opp.price.d)) {
      errors.push(`book crossed: offer ${o.offerId} and offer ${opp.offerId}`);
    }
  }
  return errors;
}
