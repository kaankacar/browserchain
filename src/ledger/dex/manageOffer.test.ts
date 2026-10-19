// Ported from stellar-core (Apache-2.0): src/transactions/test/OfferTests.cpp,
// src/transactions/test/ManageBuyOfferTests.cpp
// ManageSellOffer / ManageBuyOffer / CreatePassiveSellOffer scenarios
// (protocol 10+ expectations) plus BrowserChain-specific checks.

import { Keypair, Operation, xdr } from '@stellar/stellar-sdk/base';
import { afterEach, describe, expect, it } from 'vitest';
import { INT64_MAX } from '../math';
import { offerLiabilities } from '../offers';
import type { DecodedTx } from '../tx';
import { AUTH_REQUIRED_FLAG, AUTH_REVOCABLE_FLAG, OFFER_PASSIVE_FLAG, type Price } from '../types';
import { af, opResultTr } from '../testkit';
import { assetToXdr } from '../xdrutil';
import { reduceMaxOffersToCrossForTesting } from './convert';
import { adjustOffer, exchangeV10 } from './exchange';
import { checkDexOperationValid, checkDexOperationValidForOverlay } from './index';
import { manageOfferSpec } from './manageOffer';
import { Dex, XLM, XLM_ASSET, amt, atoms, credit, decodeOutcome, type TAsset } from './testkit';

const P = (n: number, d: number): Price => ({ n, d });
const oneone = P(1, 1);

function setup(accounts = 3, balance = 1000n * XLM) {
  const d = new Dex();
  const [issuer, ...accs] = d.accounts(accounts + 1, balance);
  const usd = credit('USD', issuer);
  const idr = credit('IDR', issuer);
  return { d, issuer, accs, usd, idr };
}

/** Trust each asset and receive `amounts[i]` of it (0 = trust only). */
function holder(d: Dex, issuer: Keypair, kp: Keypair, assets: [TAsset, bigint, bigint?][]): void {
  for (const [a, amount, limit] of assets) {
    d.trust(kp, a, limit ?? INT64_MAX);
    if (amount > 0n) d.issue(issuer, kp, a, amount);
  }
}

function rawSell(selling: xdr.Asset, buying: xdr.Asset, amount: bigint, price: Price, offerId = 0n): xdr.Operation {
  return new xdr.Operation({
    sourceAccount: null,
    body: xdr.OperationBody.manageSellOffer(
      new xdr.ManageSellOfferOp({ selling, buying, amount: xdr.Int64(amount), price: new xdr.Price(price), offerId: xdr.Int64(offerId) }),
    ),
  });
}

function rawBuy(selling: xdr.Asset, buying: xdr.Asset, buyAmount: bigint, price: Price, offerId = 0n): xdr.Operation {
  return new xdr.Operation({
    sourceAccount: null,
    body: xdr.OperationBody.manageBuyOffer(
      new xdr.ManageBuyOfferOp({ selling, buying, buyAmount: xdr.Int64(buyAmount), price: new xdr.Price(price), offerId: xdr.Int64(offerId) }),
    ),
  });
}

afterEach(() => {
  // Every test that lowers the work limit restores it; this is a safety net.
  reduceMaxOffersToCrossForTesting(1000);
});

describe('create, update and delete', () => {
  it('creates an offer with liabilities, a sub-entry and an id from idPool', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[idr, 100_000n], [usd, 0n]]);
    const before = d.accountEntry(a).numSubEntries;
    const r = d.sell(a, idr, usd, 100n, oneone);
    expect(r.code).toBe('MANAGE_SELL_OFFER_SUCCESS');
    expect(r.effect).toBe('created');
    expect(r.claimed).toEqual([]);
    expect(r.offer).toEqual({ offerId: 1n, sellerId: a.publicKey(), selling: idr.asset, buying: usd.asset, amount: 100n, price: oneone, flags: 0 });
    expect(d.lm.lastClosed().header.idPool).toBe(1n);
    expect(d.offer(1n)).toMatchObject({ amount: 100n, sellerId: a.publicKey(), flags: 0 });
    expect(d.accountEntry(a).numSubEntries).toBe(before + 1);
    expect(d.line(a, idr)!.sellingLiabilities).toBe(100n);
    expect(d.line(a, usd)!.buyingLiabilities).toBe(100n);
    d.checkInvariants();

    // A second offer gets the next id.
    expect(d.sell(a, idr, usd, 10n, P(2, 1)).offer!.offerId).toBe(2n);
    expect(d.lm.lastClosed().header.idPool).toBe(2n);
    d.checkInvariants();
  });

  it('updates price and amount, then deletes, keeping liabilities and sub-entries consistent', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[idr, 100_000n], [usd, 0n]]);
    d.sell(a, idr, usd, 100n, oneone);
    const subs = d.accountEntry(a).numSubEntries;

    const price = d.sell(a, idr, usd, 100n, P(1, 2), 1n);
    expect(price.effect).toBe('updated');
    expect(price.offer).toMatchObject({ offerId: 1n, amount: 100n, price: P(1, 2) });
    expect(d.line(a, usd)!.buyingLiabilities).toBe(50n);

    const amount = d.sell(a, idr, usd, 10n, P(1, 2), 1n);
    expect(amount.effect).toBe('updated');
    expect(d.line(a, idr)!.sellingLiabilities).toBe(10n);
    expect(d.line(a, usd)!.buyingLiabilities).toBe(5n);
    expect(d.accountEntry(a).numSubEntries).toBe(subs);
    d.checkInvariants();

    const del = d.sell(a, idr, usd, 0n, P(1, 2), 1n);
    expect(del.code).toBe('MANAGE_SELL_OFFER_SUCCESS');
    expect(del.effect).toBe('deleted');
    expect(d.offer(1n)).toBeUndefined();
    expect(d.line(a, idr)!.sellingLiabilities).toBe(0n);
    expect(d.line(a, usd)!.buyingLiabilities).toBe(0n);
    expect(d.accountEntry(a).numSubEntries).toBe(subs - 1);
    expect(d.lm.lastClosed().header.idPool).toBe(1n);
    d.checkInvariants();
  });

  it('updates the selling and buying assets of an offer (swap)', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[idr, 100_000n], [usd, 100_000n]]);
    d.sell(a, idr, usd, 100n, oneone);
    const r = d.sell(a, usd, idr, 10n, oneone, 1n);
    expect(r.effect).toBe('updated');
    expect(d.offer(1n)).toMatchObject({ selling: usd.asset, buying: idr.asset, amount: 10n });
    expect(d.line(a, idr)!.sellingLiabilities).toBe(0n);
    expect(d.line(a, idr)!.buyingLiabilities).toBe(10n);
    expect(d.line(a, usd)!.sellingLiabilities).toBe(10n);
    expect(d.book(idr, usd)).toEqual([]);
    expect(d.book(usd, idr).map((o) => o.offerId)).toEqual([1n]);
    d.checkInvariants();
  });

  it('returns NOT_FOUND for missing offers and for offers of other accounts', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 100_000n], [usd, 0n]]);
    holder(d, issuer, b, [[idr, 100_000n], [usd, 0n]]);
    d.sell(a, idr, usd, 100n, oneone);
    expect(d.sell(a, idr, usd, 100n, oneone, 2n).code).toBe('MANAGE_SELL_OFFER_NOT_FOUND');
    expect(d.sell(a, idr, usd, 0n, oneone, 2n).code).toBe('MANAGE_SELL_OFFER_NOT_FOUND');
    expect(d.sell(b, idr, usd, 50n, oneone, 1n).code).toBe('MANAGE_SELL_OFFER_NOT_FOUND');
    expect(d.sell(b, idr, usd, 0n, oneone, 1n).code).toBe('MANAGE_SELL_OFFER_NOT_FOUND');
    expect(d.buy(b, idr, usd, 0n, oneone, 1n).code).toBe('MANAGE_BUY_OFFER_NOT_FOUND');
    expect(d.offer(1n)).toMatchObject({ amount: 100n });
    d.checkInvariants();
  });
});

describe('well-formedness (doCheckValid)', () => {
  it('rejects malformed offers in checkValid and at apply time', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[idr, 100_000n], [usd, 0n]]);
    const U = assetToXdr(usd.asset);
    const I = assetToXdr(idr.asset);
    const badCode = xdr.Asset.assetTypeCreditAlphanum4(
      new xdr.AlphaNum4({ assetCode: new Uint8Array([0x55, 0x24, 0x44, 0]), issuer: xdr.PublicKey.publicKeyTypeEd25519(issuer.rawPublicKey()) }),
    );
    const cases: [string, xdr.Operation, string][] = [
      ['same asset', rawSell(I, I, 10n, oneone), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['zero numerator', rawSell(I, U, 10n, P(0, 1)), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['zero denominator', rawSell(I, U, 10n, P(1, 0)), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['negative price', rawSell(I, U, 10n, P(-1, 1)), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['negative denominator', rawSell(I, U, 10n, P(1, -1)), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['negative amount', rawSell(I, U, -1n, oneone), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['delete offer 0', rawSell(I, U, 0n, oneone), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['negative offer id', rawSell(I, U, 10n, oneone, -5n), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['invalid asset code', rawSell(badCode, U, 10n, oneone), 'MANAGE_SELL_OFFER_MALFORMED'],
      ['buy: same asset', rawBuy(U, U, 10n, oneone), 'MANAGE_BUY_OFFER_MALFORMED'],
      ['buy: negative amount', rawBuy(I, U, -3n, oneone), 'MANAGE_BUY_OFFER_MALFORMED'],
      ['buy: zero price', rawBuy(I, U, 3n, P(0, 3)), 'MANAGE_BUY_OFFER_MALFORMED'],
      ['buy: delete offer 0', rawBuy(I, U, 0n, oneone), 'MANAGE_BUY_OFFER_MALFORMED'],
    ];
    for (const [name, op, code] of cases) {
      const env = d.t.rawTx(a, [op]);
      const cv = d.lm.checkValid(env);
      expect(cv.ok, name).toBe(false);
      expect(cv.code, name).toBe('txFAILED');
      expect(cv.detail, name).toContain(code);
      const r = decodeOutcome(d.t.apply(env));
      expect(r.code, name).toBe(code);
    }
    // CreatePassiveSellOffer with amount 0 is a delete of offer 0.
    const passiveZero = new xdr.Operation({
      sourceAccount: null,
      body: xdr.OperationBody.createPassiveSellOffer(
        new xdr.CreatePassiveSellOfferOp({ selling: I, buying: U, amount: xdr.Int64(0n), price: new xdr.Price(oneone) }),
      ),
    });
    expect(decodeOutcome(d.t.apply(d.t.rawTx(a, [passiveZero]))).code).toBe('MANAGE_SELL_OFFER_MALFORMED');
    // A well formed offer passes checkValid.
    expect(d.lm.checkValid(d.t.rawTx(a, [rawSell(I, U, 10n, oneone)])).ok).toBe(true);
    expect(d.lm.getOffersByAccount(a.publicKey())).toEqual([]);
  });

  it('has an overlay check for offers the threshold could clear for nothing (before protocol 29)', () => {
    const seller = Keypair.random().publicKey();
    const cur1 = credit('CUR1', seller);
    const cur2 = credit('CUR2', seller);
    // Round trip through XDR like the ledger does (decoded operations, as the ledger sees them).
    const env = (op: xdr.Operation) => {
      const body = xdr.Operation.fromXdr(op.toXdr()).body;
      return {
        tx: {} as DecodedTx,
        op: { index: 0, type: body.type, explicitSource: false, sourceId: seller, sourceAddress: seller, body },
        sourceId: seller,
        ledgerVersion: 23,
      };
    };
    const sell = (amount: bigint, price: Price, offerId = 0n) =>
      env(Operation.manageSellOffer({ selling: cur1.sdk, buying: cur2.sdk, amount: amt(amount), price, offerId: offerId.toString() }));
    // Selling liabilities 20 (and 21 - 1) at 5/3 can clear for zero.
    expect(checkDexOperationValidForOverlay(sell(20n, P(5, 3)))?.code).toBe('MANAGE_SELL_OFFER_MALFORMED');
    expect(checkDexOperationValidForOverlay(sell(21n, P(5, 3)))?.code).toBe('MANAGE_SELL_OFFER_MALFORMED');
    expect(checkDexOperationValidForOverlay(sell(22n, P(5, 3)))).toBeNull();
    expect(checkDexOperationValidForOverlay(sell(20n, P(3, 5)))).toBeNull();
    // Deletes are always fine; so are path payments.
    expect(checkDexOperationValidForOverlay(sell(0n, P(5, 3), 7n))).toBeNull();
    const pp = Operation.pathPaymentStrictSend({ sendAsset: cur1.sdk, sendAmount: '1', destination: seller, destAsset: cur2.sdk, destMin: '1', path: [] });
    expect(checkDexOperationValidForOverlay(env(pp))).toBeNull();
    // ManageBuyOffer uses the selling liabilities of the stored (inverted) offer:
    // buying 34 at 3/5 sells floor(34 * 3 / 5) = 20 at 5/3.
    const buy = env(Operation.manageBuyOffer({ selling: cur1.sdk, buying: cur2.sdk, buyAmount: amt(34n), price: P(3, 5) }));
    expect(manageOfferSpec(buy).sellingLiabilities()).toBe(20n);
    expect(checkDexOperationValidForOverlay(buy)?.code).toBe('MANAGE_BUY_OFFER_MALFORMED');
    // It is not part of ledger validity.
    expect(checkDexOperationValid(sell(20n, P(5, 3)))).toBeNull();
    // Malformed operations get their doCheckValid result instead of an exception.
    expect(checkDexOperationValidForOverlay(sell(20n, P(0, 1)))?.code).toBe('MANAGE_SELL_OFFER_MALFORMED');
  });

  it('computes ManageBuyOffer liabilities like stellar-core', () => {
    const seller = Keypair.random().publicKey();
    const cur1 = credit('CUR1', seller);
    const cur2 = credit('CUR2', seller);
    const liab = (buyAmount: bigint, price: Price) => {
      const op = Operation.manageBuyOffer({ selling: cur1.sdk, buying: cur2.sdk, buyAmount: amt(buyAmount), price });
      const spec = manageOfferSpec({
        tx: {} as DecodedTx,
        op: { index: 0, type: 'manageBuyOffer', explicitSource: false, sourceId: seller, sourceAddress: seller, body: op.body },
        sourceId: seller,
        ledgerVersion: 23,
      });
      return [spec.buyingLiabilities(), spec.sellingLiabilities()];
    };
    // wheat stays, no rounding
    expect(liab(20n, P(2, 5))).toEqual([20n, 8n]);
    expect(liab(20n, P(1, 2))).toEqual([20n, 10n]);
    expect(liab(20n, P(1, 1))).toEqual([20n, 20n]);
    expect(liab(20n, P(2, 1))).toEqual([20n, 40n]);
    expect(liab(20n, P(5, 2))).toEqual([20n, 50n]);
    // wheat stays, rounding
    expect(liab(21n, P(2, 5))).toEqual([20n, 8n]);
    expect(liab(21n, P(1, 2))).toEqual([20n, 10n]);
    expect(liab(21n, P(2, 1))).toEqual([21n, 42n]);
    expect(liab(21n, P(5, 2))).toEqual([21n, 53n]);
    // zero liabilities
    expect(liab(1n, P(1, 2))).toEqual([0n, 0n]);
  });
});

describe('checkOfferValid and exchange parameters', () => {
  it('requires trust lines, a balance and authorization', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    expect(d.sell(a, idr, usd, 100n, oneone).code).toBe('MANAGE_SELL_OFFER_SELL_NO_TRUST');
    expect(d.buy(a, idr, usd, 100n, oneone).code).toBe('MANAGE_BUY_OFFER_SELL_NO_TRUST');
    d.trust(a, idr);
    expect(d.sell(a, idr, usd, 100n, oneone).code).toBe('MANAGE_SELL_OFFER_UNDERFUNDED');
    d.issue(issuer, a, idr, 1000n);
    expect(d.sell(a, idr, usd, 100n, oneone).code).toBe('MANAGE_SELL_OFFER_BUY_NO_TRUST');
    expect(d.buy(a, idr, usd, 100n, oneone).code).toBe('MANAGE_BUY_OFFER_BUY_NO_TRUST');

    // Authorization (AUTH_REQUIRED issuer).
    const gate = d.account();
    const eur = credit('EUR', gate);
    d.must(gate, Operation.setOptions({ setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG) }));
    d.trust(b, eur);
    d.must(gate, Operation.setTrustLineFlags({ trustor: b.publicKey(), asset: eur.sdk, flags: { authorized: true } }));
    d.issue(gate, b, eur, 10n);
    d.must(gate, Operation.setTrustLineFlags({ trustor: b.publicKey(), asset: eur.sdk, flags: { authorized: false } }));
    expect(d.sell(b, eur, XLM_ASSET, 1n, oneone).code).toBe('MANAGE_SELL_OFFER_SELL_NOT_AUTHORIZED');
    expect(d.sell(b, XLM_ASSET, eur, 1n, oneone).code).toBe('MANAGE_SELL_OFFER_BUY_NOT_AUTHORIZED');
    expect(d.buy(b, XLM_ASSET, eur, 1n, oneone).code).toBe('MANAGE_BUY_OFFER_BUY_NOT_AUTHORIZED');
    d.checkInvariants();
  });

  it('needs the reserve for the new offer (LOW_RESERVE)', () => {
    const { d, issuer, usd, idr } = setup(0);
    // Enough for two trust lines and 20 fees, but not for a third sub-entry.
    const a = d.account(d.minBalance(2) + 20n * 100n);
    holder(d, issuer, a, [[idr, 100_000n], [usd, 0n]]);
    expect(d.sell(a, idr, usd, 100n, oneone).code).toBe('MANAGE_SELL_OFFER_LOW_RESERVE');
    expect(d.buy(a, idr, usd, 100n, oneone).code).toBe('MANAGE_BUY_OFFER_LOW_RESERVE');
    expect(d.passive(a, idr, usd, 100n, oneone).code).toBe('MANAGE_SELL_OFFER_LOW_RESERVE');
    // Updating an existing offer does not need a new reserve.
    d.pay(d.t.root, a, XLM_ASSET, 5_000_000n);
    expect(d.sell(a, idr, usd, 100n, oneone).effect).toBe('created');
    expect(d.sell(a, idr, usd, 200n, oneone, 1n).effect).toBe('updated');
    d.checkInvariants();
  });

  it('fails with LINE_FULL when the buying trust line is full', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    const limit = 1_000_000n;
    holder(d, issuer, a, [[idr, limit, limit], [usd, limit, limit]]);
    expect(d.sell(a, idr, usd, 100n, oneone).code).toBe('MANAGE_SELL_OFFER_LINE_FULL');
    expect(d.buy(a, idr, usd, 100n, oneone).code).toBe('MANAGE_BUY_OFFER_LINE_FULL');
  });

  it('cannot create or modify offers beyond the available balance or limit (non-native)', () => {
    const { d, issuer, accs: [a], usd } = setup(1);
    holder(d, issuer, a, [[usd, 500n, 2000n]]);
    // Selling liabilities: 500 USD available.
    expect(d.sell(a, usd, XLM_ASSET, 501n, oneone).code).toBe('MANAGE_SELL_OFFER_UNDERFUNDED');
    const o1 = d.sell(a, usd, XLM_ASSET, 250n, oneone).offer!.offerId;
    expect(d.sell(a, usd, XLM_ASSET, 501n, oneone, o1).code).toBe('MANAGE_SELL_OFFER_UNDERFUNDED');
    expect(d.sell(a, usd, XLM_ASSET, 500n, oneone, o1).effect).toBe('updated');
    expect(d.sell(a, usd, XLM_ASSET, 1n, oneone).code).toBe('MANAGE_SELL_OFFER_UNDERFUNDED');
    // Buying liabilities: limit 2000 - balance 500 = 1500 USD of room. The
    // price 2 USD per XLM keeps these offers away from our own USD offer.
    expect(d.sell(a, XLM_ASSET, usd, 751n, P(2, 1)).code).toBe('MANAGE_SELL_OFFER_LINE_FULL');
    expect(d.sell(a, XLM_ASSET, usd, 750n, P(2, 1)).effect).toBe('created');
    expect(d.sell(a, XLM_ASSET, usd, 1n, P(2, 1)).code).toBe('MANAGE_SELL_OFFER_LINE_FULL');
    expect(d.line(a, usd)).toMatchObject({ sellingLiabilities: 500n, buyingLiabilities: 1500n });
    d.checkInvariants();
  });

  it('cannot create offers beyond the available native balance', () => {
    const { d, issuer, accs: [a], idr } = setup(1);
    holder(d, issuer, a, [[idr, 0n]]);
    // Free XLM after the next fee and the reserve of the new offer.
    const avail = () => {
      const acc = d.accountEntry(a);
      return acc.balance - d.lm.minBalance(acc) - acc.sellingLiabilities - 100n - 5_000_000n;
    };
    expect(d.sell(a, XLM_ASSET, idr, avail() + 1n, oneone).code).toBe('MANAGE_SELL_OFFER_UNDERFUNDED');
    const all = avail();
    const r = d.sell(a, XLM_ASSET, idr, all, oneone);
    expect(r.offer!.amount).toBe(all);
    const acc = d.accountEntry(a);
    expect(acc.sellingLiabilities).toBe(all);
    expect(acc.balance - d.lm.minBalance(acc) - acc.sellingLiabilities).toBe(0n);
    d.checkInvariants();
  });

  it('updated offers respect the reserve (OfferTests "updated offers respect reserve")', () => {
    const { d, issuer, usd } = setup(0);
    void issuer;
    const a = d.account(d.minBalance(2) + 3n * 100n + 110n);
    d.trust(a, usd);
    const o = d.sell(a, XLM_ASSET, usd, 110n, oneone);
    expect(o.effect).toBe('created');
    expect(d.sell(a, XLM_ASSET, usd, 111n, oneone, o.offer!.offerId).code).toBe('MANAGE_SELL_OFFER_UNDERFUNDED');
    d.checkInvariants();
  });

  it('a new offer below the price error threshold is not stored', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    const subs = d.accountEntry(a).numSubEntries;
    const r = d.sell(a, idr, usd, 27n, P(3, 2));
    expect(r.code).toBe('MANAGE_SELL_OFFER_SUCCESS');
    expect(r.effect).toBe('deleted');
    expect(d.offersOf(a)).toEqual([]);
    expect(d.accountEntry(a).numSubEntries).toBe(subs);
    // 28 meets the threshold.
    expect(d.sell(a, idr, usd, 28n, P(3, 2)).offer!.amount).toBe(28n);
  });
});

describe('crossing', () => {
  it('fully crosses an offer at the same price', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    holder(d, issuer, b, [[usd, 1000n], [idr, 0n]]);
    d.sell(a, idr, usd, 100n, oneone);
    const r = d.sell(b, usd, idr, 100n, oneone);
    expect(r.code).toBe('MANAGE_SELL_OFFER_SUCCESS');
    expect(r.effect).toBe('deleted');
    expect(r.claimed).toEqual([{ sellerId: a.publicKey(), offerId: 1n, assetSold: idr.asset, amountSold: 100n, assetBought: usd.asset, amountBought: 100n }]);
    expect(d.offer(1n)).toBeUndefined();
    expect([d.balance(a, idr), d.balance(a, usd), d.balance(b, idr), d.balance(b, usd)]).toEqual([900n, 100n, 100n, 900n]);
    // The crossed seller and both trust lines are touched accounts of the transaction.
    expect(r.result.accounts).toContain(a.publicKey());
    expect(r.result.operations[0].resultCode).toBe('MANAGE_SELL_OFFER_SUCCESS');
    d.checkInvariants();
  });

  it('partially crosses: the maker keeps the rest, the taker leaves nothing', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    holder(d, issuer, b, [[usd, 1000n], [idr, 0n]]);
    d.sell(a, idr, usd, 100n, oneone);
    const r = d.sell(b, usd, idr, 40n, oneone);
    expect(r.effect).toBe('deleted');
    expect(atoms(r.claimed)).toEqual([[1n, 40n, 40n]]);
    expect(d.offer(1n)!.amount).toBe(60n);
    expect(d.line(a, idr)!.sellingLiabilities).toBe(60n);
    expect(d.line(a, usd)!.buyingLiabilities).toBe(60n);
    d.checkInvariants();
  });

  it('stores the taker remainder after taking the whole book', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    holder(d, issuer, b, [[usd, 1000n], [idr, 0n]]);
    d.sell(a, idr, usd, 100n, oneone);
    const r = d.sell(b, usd, idr, 150n, oneone);
    expect(atoms(r.claimed)).toEqual([[1n, 100n, 100n]]);
    expect(r.effect).toBe('created');
    expect(r.offer).toMatchObject({ offerId: 2n, amount: 50n, selling: usd.asset });
    d.checkInvariants();
  });

  it('crosses better prices first and stops at its limit price', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    holder(d, issuer, b, [[usd, 1000n], [idr, 0n]]);
    d.sell(a, idr, usd, 50n, P(12, 10)); // id 1
    d.sell(a, idr, usd, 50n, P(11, 10)); // id 2
    d.sell(a, idr, usd, 50n, oneone); // id 3
    expect(d.book(idr, usd).map((o) => o.offerId)).toEqual([3n, 2n, 1n]);
    // b pays at most 1.1 USD per IDR.
    const r = d.sell(b, usd, idr, 200n, P(10, 11));
    expect(atoms(r.claimed)).toEqual([
      [3n, 50n, 50n],
      [2n, 50n, 55n],
    ]);
    expect(r.effect).toBe('created');
    expect(r.offer).toMatchObject({ amount: 95n, price: P(10, 11) });
    expect(d.book(idr, usd).map((o) => o.offerId)).toEqual([1n]);
    expect(d.book(usd, idr).map((o) => o.amount)).toEqual([95n]);
    d.checkInvariants();
  });

  it('respects price-time priority among equal prices', () => {
    const { d, issuer, accs: [a, b, c, t], usd, idr } = setup(4);
    for (const kp of [a, b, c]) holder(d, issuer, kp, [[idr, 1000n], [usd, 0n]]);
    holder(d, issuer, t, [[usd, 1000n], [idr, 0n]]);
    d.sell(a, idr, usd, 50n, oneone); // 1
    d.sell(b, idr, usd, 50n, oneone); // 2
    d.sell(c, idr, usd, 50n, oneone); // 3
    d.sell(c, idr, usd, 30n, P(9, 10)); // 4: better price, newest
    expect(d.book(idr, usd).map((o) => o.offerId)).toEqual([4n, 1n, 2n, 3n]);
    const r = d.sell(t, usd, idr, 100n, oneone);
    expect(atoms(r.claimed)).toEqual([
      [4n, 30n, 27n],
      [1n, 50n, 50n],
      [2n, 23n, 23n],
    ]);
    expect(r.effect).toBe('deleted');
    expect(d.offer(2n)!.amount).toBe(27n);
    expect(d.offer(3n)!.amount).toBe(50n);
    expect(d.balance(t, idr)).toBe(103n);
    expect(d.balance(t, usd)).toBe(900n);
    d.checkInvariants();
  });

  describe('22 offers at 3/2 (OfferTests "multiple offers")', () => {
    function market() {
      const { d, issuer, accs: [a, b], usd, idr } = setup(2);
      holder(d, issuer, a, [[usd, 0n], [idr, 100_000n]]);
      holder(d, issuer, b, [[idr, 0n], [usd, 20_000n]]);
      const ops = Array.from({ length: 22 }, () =>
        Operation.manageSellOffer({ selling: idr.sdk, buying: usd.sdk, amount: amt(100n), price: P(3, 2) }),
      );
      const r = d.submit(a, ops);
      expect(r.successful).toBe(true);
      return { d, issuer, a, b, usd, idr };
    }

    it('removes the first six offers and changes the seventh', () => {
      const { d, a, b, usd, idr } = market();
      const r = d.sell(b, usd, idr, 1009n, P(1, 2));
      expect(r.effect).toBe('deleted');
      expect(r.claimed.map((c) => c.offerId)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
      for (let id = 1n; id <= 6n; id++) expect(d.offer(id)).toBeUndefined();
      expect(d.offer(7n)!.amount).toBe(28n);
      expect([d.balance(a, usd), d.balance(a, idr), d.balance(b, usd), d.balance(b, idr)]).toEqual([1008n, 99_328n, 18_992n, 672n]);
      d.checkInvariants();
    });

    it('removes the seventh offer by adjustment', () => {
      const { d, a, b, usd, idr } = market();
      const r = d.sell(b, usd, idr, 1010n, P(1, 2));
      expect(r.effect).toBe('deleted');
      for (let id = 1n; id <= 7n; id++) expect(d.offer(id)).toBeUndefined();
      expect(d.offer(8n)!.amount).toBe(100n);
      expect([d.balance(a, usd), d.balance(a, idr), d.balance(b, usd), d.balance(b, idr)]).toEqual([1010n, 99_327n, 18_990n, 673n]);
      d.checkInvariants();
    });

    it('removes all offers and remains', () => {
      const { d, a, b, usd, idr } = market();
      const r = d.sell(b, usd, idr, 10_000n, P(1, 2));
      expect(r.claimed).toHaveLength(22);
      expect(r.effect).toBe('created');
      expect(r.offer).toMatchObject({ amount: 6700n, price: P(1, 2) });
      expect(d.book(idr, usd)).toEqual([]);
      expect([d.balance(a, usd), d.balance(a, idr), d.balance(b, usd), d.balance(b, idr)]).toEqual([3300n, 97_800n, 16_700n, 2200n]);
      d.checkInvariants();
    });

    it('multiple small offers cross the same maker offer', () => {
      const { d, a, b, usd, idr } = market();
      let expected = 100n;
      for (let i = 0; i < 10; i++) {
        const r = d.sell(b, usd, idr, 10n, P(1, 2));
        // wheatReceive = floor(20 / 3) = 6, sheepSend = ceil(6 * 3 / 2) = 9
        expect(atoms(r.claimed)).toEqual([[1n, 6n, 9n]]);
        expected -= 6n;
        expect(d.offer(1n)!.amount).toBe(expected);
      }
      expect([d.balance(a, usd), d.balance(a, idr), d.balance(b, usd), d.balance(b, idr)]).toEqual([90n, 99_940n, 19_910n, 60n]);
      d.checkInvariants();
    });

    it('fails with CROSS_SELF when the best offer is our own', () => {
      const { d, issuer, a, usd, idr } = market();
      d.issue(issuer, a, usd, 20_000n);
      expect(d.pay(a, issuer, idr, 50_000n).code).toBe('PAYMENT_SUCCESS');
      expect(d.sell(a, usd, idr, 150n, P(2, 3)).code).toBe('MANAGE_SELL_OFFER_CROSS_SELF');
      expect(d.book(idr, usd)).toHaveLength(22);
      d.checkInvariants();
    });
  });

  it('fails with CROSS_SELF when crossing its own offer at an acceptable price', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[usd, 20_000n], [idr, 100_000n]]);
    d.sell(a, idr, usd, 100n, P(3, 2));
    const before = d.lm.stateHash();
    const r = d.sell(a, usd, idr, 150n, P(2, 3));
    expect(r.code).toBe('MANAGE_SELL_OFFER_CROSS_SELF');
    expect(d.buy(a, usd, idr, 10n, P(3, 2)).code).toBe('MANAGE_BUY_OFFER_CROSS_SELF');
    // Only fees and sequence numbers changed.
    expect(d.offer(1n)!.amount).toBe(100n);
    expect(d.lm.stateHash()).not.toBe(before);
    // A worse price stops before our own offer: no error.
    expect(d.sell(a, usd, idr, 150n, P(1, 1)).effect).toBe('created');
    d.checkInvariants();
  });

  it('crossing with rounding: bid before ask uses the bid price', () => {
    const { d, issuer, usd } = setup(0);
    void usd;
    const idr = credit('IDR', issuer);
    const [asking, bidding] = d.accounts(2, 10_000_000_000n);
    holder(d, issuer, asking, [[idr, 100_000_000_000n, 1_000_000_000_000n]]);
    d.trust(bidding, idr, 1_000_000_000_000n);
    const bid = d.sell(bidding, XLM_ASSET, idr, 8_224_563_625n, P(500, 2061));
    expect(bid.effect).toBe('created');
    const ask = d.sell(asking, idr, XLM_ASSET, 2_000_000_000n, P(2551, 625));
    expect(d.offer(bid.offer!.offerId)).toBeUndefined();
    expect(ask.effect).toBe('created');
    expect(ask.offer!.amount).toBe(4_715_278n);
    d.checkInvariants();
  });

  it('crossing with rounding: ask before bid uses the ask price', () => {
    const { d, issuer } = setup(0);
    const idr = credit('IDR', issuer);
    const [asking, bidding] = d.accounts(2, 10_000_000_000n);
    holder(d, issuer, asking, [[idr, 100_000_000_000n, 1_000_000_000_000n]]);
    d.trust(bidding, idr, 1_000_000_000_000n);
    const ask = d.sell(asking, idr, XLM_ASSET, 2_000_000_000n, P(2551, 625));
    const bid = d.sell(bidding, XLM_ASSET, idr, 8_224_563_625n, P(500, 2061));
    expect(d.offer(ask.offer!.offerId)).toBeUndefined();
    expect(bid.effect).toBe('created');
    expect(bid.offer!.amount).toBe(61_363_625n);
    d.checkInvariants();
  });

  it('wheat stays or sheep stays (OfferTests)', () => {
    const check = (wheatPrice: Price, maxWheatSend: bigint, maxSheepSend: bigint) => {
      const { d, issuer, accs: [wheatSeller, sheepSeller], usd, idr } = setup(2);
      holder(d, issuer, wheatSeller, [[idr, maxWheatSend], [usd, 0n]]);
      holder(d, issuer, sheepSeller, [[usd, maxSheepSend], [idr, 0n]]);
      const sheepPrice = P(wheatPrice.d, wheatPrice.n);
      const res = exchangeV10(wheatPrice, maxWheatSend, INT64_MAX, maxSheepSend, INT64_MAX, 'NORMAL');
      const adjWheat = adjustOffer(wheatPrice, maxWheatSend, INT64_MAX);
      const wheatLeft = adjustOffer(wheatPrice, adjWheat - res.numWheatReceived, INT64_MAX);
      const sheepLeft = adjustOffer(sheepPrice, maxSheepSend - res.numSheepSend, INT64_MAX);

      const w = d.sell(wheatSeller, idr, usd, maxWheatSend, wheatPrice);
      expect(w.offer!.amount).toBe(adjWheat);
      const s = d.sell(sheepSeller, usd, idr, maxSheepSend, sheepPrice);
      expect(atoms(s.claimed)).toEqual([[w.offer!.offerId, res.numWheatReceived, res.numSheepSend]]);
      if (res.wheatStays && wheatLeft > 0n) expect(d.offer(w.offer!.offerId)!.amount).toBe(wheatLeft);
      else expect(d.offer(w.offer!.offerId)).toBeUndefined();
      if (!res.wheatStays && sheepLeft > 0n) expect(s.offer!.amount).toBe(sheepLeft);
      else expect(s.effect).toBe('deleted');
      expect(d.balance(sheepSeller, idr)).toBe(res.numWheatReceived);
      expect(d.balance(wheatSeller, usd)).toBe(res.numSheepSend);
      d.checkInvariants();
    };
    // sheep stays
    check(P(3, 2), 3000n, 4501n);
    check(P(3, 2), 3000n, 4500n);
    check(P(2, 3), 3000n, 2001n);
    check(P(2, 3), 3000n, 2000n);
    // wheat stays
    check(P(3, 2), 3000n, 4499n);
    check(P(2, 3), 3000n, 1999n);
  });

  it('issuer offers: the issuer sells its own asset without a trust line, and takes offers', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[usd, 1000n], [idr, 100_000n]]);
    const gw = d.sell(issuer, idr, usd, 100n, P(9, 10));
    expect(gw.effect).toBe('created');
    const r = d.sell(a, usd, idr, 90n, oneone);
    expect(atoms(r.claimed)).toEqual([[gw.offer!.offerId, 100n, 90n]]);
    expect(d.balance(a, usd)).toBe(910n);
    expect(d.balance(a, idr)).toBe(100_100n);

    const a1 = d.sell(a, idr, usd, 100n, P(3, 2));
    const r2 = d.sell(issuer, usd, idr, 150n, P(2, 3));
    expect(atoms(r2.claimed)).toEqual([[a1.offer!.offerId, 100n, 150n]]);
    expect(d.balance(a, usd)).toBe(1060n);
    expect(d.balance(a, idr)).toBe(100_000n);
    d.checkInvariants();
  });
});

describe('amounts near INT64_MAX (OfferTests "issuer offers", "large offer id")', () => {
  const third = INT64_MAX / 3n;

  it('issuer offers do not overflow their own liabilities but count for other assets', () => {
    // Selling its own asset: only the USD buying liabilities are tracked.
    {
      const { d, accs: [acc1], usd } = setup(1);
      const cur1 = credit('CUR1', acc1);
      d.trust(acc1, usd);
      expect(d.sell(acc1, cur1, usd, third * 2n, P(1, 2)).effect).toBe('created');
      expect(d.sell(acc1, cur1, usd, third * 2n, P(1, 2)).effect).toBe('created');
      expect(d.line(acc1, usd)!.buyingLiabilities).toBe(third * 2n);
      d.checkInvariants();
    }
    // Buying its own asset: only the USD selling liabilities are tracked.
    {
      const { d, issuer, accs: [acc1], usd } = setup(1);
      const cur1 = credit('CUR1', acc1);
      holder(d, issuer, acc1, [[usd, INT64_MAX]]);
      expect(d.sell(acc1, usd, cur1, third, P(2, 1)).effect).toBe('created');
      expect(d.sell(acc1, usd, cur1, third, P(2, 1)).effect).toBe('created');
      expect(d.line(acc1, usd)!.sellingLiabilities).toBe(third * 2n);
      d.checkInvariants();
    }
    // The other asset's limit and balance still bind.
    {
      const { d, accs: [acc1], usd } = setup(1);
      const cur1 = credit('CUR1', acc1);
      d.trust(acc1, usd);
      expect(d.sell(acc1, cur1, usd, third * 2n, oneone).effect).toBe('created');
      expect(d.sell(acc1, cur1, usd, third * 2n, oneone).code).toBe('MANAGE_SELL_OFFER_LINE_FULL');
    }
    {
      const { d, issuer, accs: [acc1], usd } = setup(1);
      const cur1 = credit('CUR1', acc1);
      holder(d, issuer, acc1, [[usd, INT64_MAX]]);
      expect(d.sell(acc1, usd, cur1, third * 2n, oneone).effect).toBe('created');
      expect(d.sell(acc1, usd, cur1, third * 2n, oneone).code).toBe('MANAGE_SELL_OFFER_UNDERFUNDED');
    }
  });

  it('modifying or deleting offer id INT64_MAX is NOT_FOUND', () => {
    const { d, issuer, accs: [acc1], usd, idr } = setup(1);
    holder(d, issuer, acc1, [[usd, 1000n], [idr, 1000n]]);
    expect(d.sell(acc1, usd, idr, 1n, oneone, INT64_MAX).code).toBe('MANAGE_SELL_OFFER_NOT_FOUND');
    expect(d.sell(acc1, usd, idr, 0n, oneone, INT64_MAX).code).toBe('MANAGE_SELL_OFFER_NOT_FOUND');
    expect(d.buy(acc1, usd, idr, 0n, oneone, INT64_MAX).code).toBe('MANAGE_BUY_OFFER_NOT_FOUND');
  });
});

describe('passive offers', () => {
  function market() {
    const { d, issuer, accs: [a, b, c], usd, idr } = setup(3);
    holder(d, issuer, a, [[idr, 100_000n], [usd, 0n]]);
    holder(d, issuer, b, [[usd, 100_000n], [idr, 0n]]);
    holder(d, issuer, c, [[idr, 100_000n], [usd, 0n]]);
    const first = d.sell(a, idr, usd, 100n, oneone);
    const second = d.passive(b, usd, idr, 100n, oneone);
    return { d, a, b, c, usd, idr, first: first.offer!.offerId, second: second.offer!.offerId };
  }

  it('does not cross an offer at the same price', () => {
    const { d, usd, idr, first, second } = market();
    expect(d.offer(first)!.amount).toBe(100n);
    expect(d.offer(second)).toMatchObject({ amount: 100n, flags: OFFER_PASSIVE_FLAG });
    expect(d.book(idr, usd)).toHaveLength(1);
    expect(d.book(usd, idr)).toHaveLength(1);
    d.checkInvariants();
  });

  it('crosses with a better price and is not stored', () => {
    const { d, b, usd, idr, first } = market();
    const r = d.passive(b, usd, idr, 100n, P(99, 100));
    expect(r.code).toBe('MANAGE_SELL_OFFER_SUCCESS');
    expect(r.effect).toBe('deleted');
    expect(atoms(r.claimed)).toEqual([[first, 100n, 100n]]);
    expect(d.offer(first)).toBeUndefined();
    d.checkInvariants();
  });

  it('keeps the passive flag when updated, and crosses after a lower price', () => {
    const { d, b, usd, idr, first, second } = market();
    const up = d.sell(b, usd, idr, 100n, P(100, 99), second);
    expect(up.effect).toBe('updated');
    expect(up.offer!.flags).toBe(OFFER_PASSIVE_FLAG);
    expect(d.offer(first)!.amount).toBe(100n);
    const down = d.sell(b, usd, idr, 100n, P(99, 100), second);
    expect(down.effect).toBe('deleted');
    expect(atoms(down.claimed)).toEqual([[first, 100n, 100n]]);
    expect(d.offer(first)).toBeUndefined();
    expect(d.offer(second)).toBeUndefined();
    d.checkInvariants();
  });

  it('a regular offer at the same price takes a passive offer', () => {
    const { d, c, usd, idr, second } = market();
    const r = d.sell(c, idr, usd, 40n, oneone);
    expect(atoms(r.claimed)).toEqual([[second, 40n, 40n]]);
    expect(d.offer(second)!.amount).toBe(60n);
    d.checkInvariants();
  });
});

describe('liabilities', () => {
  it('prevent spending the same balance twice', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 100n], [usd, 0n]]);
    d.trust(b, idr);
    d.sell(a, idr, usd, 100n, oneone);
    // The whole IDR balance is promised to the offer.
    expect(d.sell(a, idr, usd, 1n, P(2, 1)).code).toBe('MANAGE_SELL_OFFER_UNDERFUNDED');
    expect(d.pay(a, b, idr, 1n).code).toBe('PAYMENT_UNDERFUNDED');
    expect(d.strictSend(a, b, idr, 1n, idr, 1n).code).toBe('PATH_PAYMENT_STRICT_SEND_UNDERFUNDED');
    expect(d.strictReceive(a, b, idr, 1n, idr, 1n).code).toBe('PATH_PAYMENT_STRICT_RECEIVE_UNDERFUNDED');
    // Native: an offer locks all free XLM but 1000 stroops (next fee + offer reserve).
    const acc = d.accountEntry(a);
    const free = acc.balance - d.lm.minBalance(acc) - acc.sellingLiabilities - 100n - 5_000_000n;
    expect(d.sell(a, XLM_ASSET, usd, free - 1000n, P(2, 1)).effect).toBe('created');
    // 1000 - 100 (fee of the payment) = 900 left.
    expect(d.pay(a, b, XLM_ASSET, 901n).code).toBe('PAYMENT_UNDERFUNDED');
    expect(d.pay(a, b, XLM_ASSET, 800n).code).toBe('PAYMENT_SUCCESS');
    // With no free XLM left, the account cannot even pay a fee.
    expect(d.pay(a, b, XLM_ASSET, 1n).code).toBe('txINSUFFICIENT_BALANCE');
    d.checkInvariants();
  });

  it('buying liabilities reserve room in the trust line', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[idr, 0n, 100n], [usd, 1000n]]);
    d.sell(a, usd, idr, 100n, oneone);
    expect(d.line(a, idr)!.buyingLiabilities).toBe(100n);
    expect(d.pay(issuer, a, idr, 1n).code).toBe('PAYMENT_LINE_FULL');
    // The trust line cannot shrink below balance + buying liabilities, nor be removed.
    expect(d.run(a, Operation.changeTrust({ asset: idr.sdk, limit: amt(99n) })).code).toBe('CHANGE_TRUST_INVALID_LIMIT');
    expect(d.run(a, Operation.changeTrust({ asset: idr.sdk, limit: '0' })).code).toBe('CHANGE_TRUST_INVALID_LIMIT');
    d.checkInvariants();
  });

  it('offers stay crossable when the maker is only authorized to maintain liabilities', () => {
    for (const side of ['selling', 'buying'] as const) {
      const { d, accs: [maker, taker] } = setup(2);
      const gate = d.account();
      const eur = credit('EUR', gate);
      const gbp = credit('GBP', gate);
      d.must(gate, Operation.setOptions({ setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG) }));
      for (const kp of [maker, taker]) {
        for (const a of [eur, gbp]) {
          d.trust(kp, a);
          d.must(gate, Operation.setTrustLineFlags({ trustor: kp.publicKey(), asset: a.sdk, flags: { authorized: true } }));
        }
      }
      d.issue(gate, maker, eur, 1000n);
      d.issue(gate, taker, gbp, 1000n);
      const id = d.sell(maker, eur, gbp, 500n, oneone).offer!.offerId;
      // Downgrade the maker's selling or buying line.
      const line = side === 'selling' ? eur : gbp;
      d.must(
        gate,
        Operation.setTrustLineFlags({ trustor: maker.publicKey(), asset: line.sdk, flags: { authorized: false, authorizedToMaintainLiabilities: true } }),
      );
      expect(d.offer(id)!.amount).toBe(500n);
      // The maker cannot change the offer...
      expect(d.sell(maker, eur, gbp, 400n, oneone, id).code).toBe(side === 'selling' ? 'MANAGE_SELL_OFFER_SELL_NOT_AUTHORIZED' : 'MANAGE_SELL_OFFER_BUY_NOT_AUTHORIZED');
      // ...but others can still take it.
      const r = d.sell(taker, gbp, eur, 200n, oneone);
      expect(atoms(r.claimed)).toEqual([[id, 200n, 200n]]);
      expect(d.offer(id)!.amount).toBe(300n);
      expect([d.balance(maker, eur), d.balance(maker, gbp)]).toEqual([800n, 200n]);
      d.checkInvariants();
      // And the maker can still delete it.
      expect(d.sell(maker, eur, gbp, 0n, oneone, id).effect).toBe('deleted');
      expect(d.line(maker, eur)).toMatchObject({ sellingLiabilities: 0n, buyingLiabilities: 0n });
      d.checkInvariants();
    }
  });

  it('are released when authorization is revoked (offers are removed)', () => {
    const { d, accs: [a] } = setup(1);
    const gate = d.account();
    const eur = credit('EUR', gate);
    d.must(gate, Operation.setOptions({ setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG) }));
    d.trust(a, eur);
    d.must(gate, Operation.setTrustLineFlags({ trustor: a.publicKey(), asset: eur.sdk, flags: { authorized: true } }));
    d.issue(gate, a, eur, 1000n);
    const o1 = d.sell(a, eur, XLM_ASSET, 500n, oneone).offer!.offerId;
    // 2 EUR per XLM does not cross our own offer.
    const o2 = d.sell(a, XLM_ASSET, eur, 200n, P(2, 1)).offer!.offerId;
    expect(d.offersOf(a)).toHaveLength(2);
    d.must(gate, Operation.setTrustLineFlags({ trustor: a.publicKey(), asset: eur.sdk, flags: { authorized: false } }));
    expect(d.offer(o1)).toBeUndefined();
    expect(d.offer(o2)).toBeUndefined();
    expect(d.line(a, eur)).toMatchObject({ sellingLiabilities: 0n, buyingLiabilities: 0n });
    expect(d.accountEntry(a)).toMatchObject({ sellingLiabilities: 0n, buyingLiabilities: 0n });
    d.checkInvariants();
  });
});

describe('ManageBuyOffer', () => {
  it('stores a sell offer at the inverse price', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    // Buy 100 USD paying 2 IDR per USD: sell 200 IDR at 1/2 USD per IDR.
    const r = d.buy(a, idr, usd, 100n, P(2, 1));
    expect(r.code).toBe('MANAGE_BUY_OFFER_SUCCESS');
    expect(r.effect).toBe('created');
    expect(r.offer).toMatchObject({ selling: idr.asset, buying: usd.asset, amount: 200n, price: P(1, 2) });
    expect(d.line(a, usd)!.buyingLiabilities).toBe(100n);
    expect(d.line(a, idr)!.sellingLiabilities).toBe(200n);
    d.checkInvariants();
  });

  it('exactly crosses existing offers (ManageBuyOfferTests)', () => {
    for (const price of [P(2, 5), P(1, 2), P(1, 1), P(2, 1), P(5, 2)]) {
      const { d, issuer, accs: [a1, a2] } = setup(2);
      const cur1 = credit('CUR1', issuer);
      const cur2 = credit('CUR2', issuer);
      holder(d, issuer, a1, [[cur1, INT64_MAX], [cur2, 0n]]);
      holder(d, issuer, a2, [[cur1, 0n], [cur2, INT64_MAX]]);
      const sell = d.sell(a1, cur1, cur2, 20n, price);
      const buy = d.buy(a2, cur2, cur1, 20n, price);
      expect(buy.effect).toBe('deleted');
      expect(d.offer(sell.offer!.offerId)).toBeUndefined();
      expect(d.balance(a2, cur1)).toBe(20n);
      d.checkInvariants();
    }
  });

  it('matches a manage sell offer when executing partially (ManageBuyOfferTests)', () => {
    // buyPrice: CUR1 per CUR2 for the buy; the matching sell uses its inverse.
    const run = (buyPrice: Price, buyAmount: bigint, sellAmount: bigint) => {
      const sellPrice = P(buyPrice.d, buyPrice.n);
      const { d, issuer, accs: [a1, a2, a3, a4] } = setup(4);
      const [cur1, cur2, cur3, cur4] = ['CUR1', 'CUR2', 'CUR3', 'CUR4'].map((c) => credit(c, issuer));
      holder(d, issuer, a1, [[cur1, 1000n, 1000n], [cur2, 0n, 1000n]]);
      holder(d, issuer, a2, [[cur2, INT64_MAX], [cur1, 0n]]);
      holder(d, issuer, a3, [[cur3, 1000n, 1000n], [cur4, 0n, 1000n]]);
      holder(d, issuer, a4, [[cur4, INT64_MAX], [cur3, 0n]]);
      // The book holds 50 units at the same price in both markets.
      d.sell(a2, cur2, cur1, 50n, buyPrice);
      const b = d.buy(a1, cur1, cur2, buyAmount, buyPrice);
      expect(b.offer!.price).toEqual(sellPrice);
      const x = [1000n - d.balance(a1, cur1), d.balance(a1, cur2), b.offer!.amount];
      d.sell(a4, cur4, cur3, 50n, buyPrice);
      const s = d.sell(a3, cur3, cur4, sellAmount, sellPrice);
      const y = [1000n - d.balance(a3, cur3), d.balance(a3, cur4), s.offer!.amount];
      expect(x).toEqual(y);
      expect(x[1]).toBe(50n);
      d.checkInvariants();
    };
    run(P(2, 5), 200n, 80n);
    run(P(1, 2), 200n, 100n);
    run(P(1, 1), 200n, 200n);
    run(P(2, 1), 200n, 400n);
    run(P(5, 2), 200n, 500n);
    run(P(2, 5), 201n, 80n);
    run(P(1, 2), 201n, 100n);
    run(P(2, 1), 201n, 402n);
    run(P(5, 2), 201n, 503n);
  });

  it('handles zero liabilities (ManageBuyOfferTests)', () => {
    const { d, issuer, accs: [a1, a2] } = setup(2);
    const cur1 = credit('CUR1', issuer);
    const cur2 = credit('CUR2', issuer);
    holder(d, issuer, a1, [[cur1, 100n, 100n], [cur2, 0n, 100n]]);
    holder(d, issuer, a2, [[cur2, 100n, 100n], [cur1, 0n, 100n]]);
    // Initially zero liabilities: nothing executes, nothing is stored.
    expect(d.buy(a1, cur1, cur2, 1n, P(1, 3)).effect).toBe('deleted');
    expect([d.balance(a1, cur1), d.balance(a1, cur2)]).toEqual([100n, 0n]);
    // Zero liabilities after executing partially.
    expect(d.buy(a2, cur2, cur1, 1n, P(3, 1)).effect).toBe('created');
    expect(d.buy(a1, cur1, cur2, 4n, P(1, 3)).effect).toBe('deleted');
    expect([d.balance(a1, cur1), d.balance(a1, cur2)]).toEqual([99n, 3n]);
    d.checkInvariants();
  });

  it('releases liabilities before modifying (ManageBuyOfferTests)', () => {
    const { d, issuer, accs: [a1] } = setup(1);
    const cur1 = credit('CUR1', issuer);
    const cur2 = credit('CUR2', issuer);
    holder(d, issuer, a1, [[cur1, 100n, 100n], [cur2, 0n, 200n]]);
    expect(d.buy(a1, cur1, cur2, 50n, oneone).offer!.offerId).toBe(1n);
    expect(d.buy(a1, cur1, cur2, 100n, oneone, 1n).effect).toBe('updated');
    expect(d.buy(a1, cur1, cur2, 101n, oneone, 1n).code).toBe('MANAGE_BUY_OFFER_UNDERFUNDED');
    expect(d.buy(a1, cur1, cur2, 100n, P(1, 2), 1n).effect).toBe('updated');
    expect(d.buy(a1, cur1, cur2, 100n, P(201, 100), 1n).code).toBe('MANAGE_BUY_OFFER_UNDERFUNDED');
    d.checkInvariants();
  });

  it('buys exactly the requested amount from a larger book', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    holder(d, issuer, b, [[usd, 1000n], [idr, 0n]]);
    d.sell(a, idr, usd, 100n, oneone);
    d.sell(a, idr, usd, 100n, P(2, 1));
    // b wants exactly 150 IDR and pays up to 3 USD each.
    const r = d.buy(b, usd, idr, 150n, P(3, 1));
    expect(atoms(r.claimed)).toEqual([
      [1n, 100n, 100n],
      [2n, 50n, 100n],
    ]);
    expect(r.effect).toBe('deleted');
    expect(d.balance(b, idr)).toBe(150n);
    expect(d.balance(b, usd)).toBe(800n);
    expect(d.offer(2n)!.amount).toBe(50n);
    d.checkInvariants();
  });
});

describe('work limit and order book', () => {
  it('fails with opEXCEEDED_WORK_LIMIT when crossing too many offers', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    holder(d, issuer, b, [[usd, 1000n], [idr, 0n]]);
    d.submit(a, [1, 2, 3].map(() => Operation.manageSellOffer({ selling: idr.sdk, buying: usd.sdk, amount: amt(10n), price: oneone })));
    const restore = reduceMaxOffersToCrossForTesting(2);
    try {
      const r = d.sell(b, usd, idr, 30n, oneone);
      expect(r.code).toBe('opEXCEEDED_WORK_LIMIT');
      expect(d.book(idr, usd)).toHaveLength(3);
      // Two offers are fine.
      expect(atoms(d.sell(b, usd, idr, 20n, oneone).claimed)).toHaveLength(2);
      // Stopping at a bad price (b wants 2 IDR per USD) crosses nothing.
      const r2 = d.sell(b, usd, idr, 10n, P(2, 1));
      expect(r2.claimed).toEqual([]);
      expect(r2.effect).toBe('created');
      // With a limit of 0 any crossing fails fast.
      reduceMaxOffersToCrossForTesting(0);
      expect(d.sell(b, usd, idr, 10n, oneone).code).toBe('opEXCEEDED_WORK_LIMIT');
    } finally {
      restore();
    }
    d.checkInvariants();
  });

  it('enforces the sub-entry limit and the default limit of 1000 crossed offers', () => {
    const { d, issuer, accs: [maker1, maker2, taker], usd, idr } = setup(3, 2000n * XLM);
    holder(d, issuer, maker1, [[idr, 100_000n], [usd, 0n]]);
    holder(d, issuer, maker2, [[idr, 100_000n], [usd, 0n]]);
    holder(d, issuer, taker, [[usd, 100_000n], [idr, 0n]]);
    const offerOp = () => Operation.manageSellOffer({ selling: idr.sdk, buying: usd.sdk, amount: amt(10n), price: oneone });
    // 2 trust lines + 998 offers = ACCOUNT_SUBENTRY_LIMIT (1000).
    for (let made = 0; made < 998; made += 100) {
      const n = Math.min(100, 998 - made);
      expect(d.submit(maker1, Array.from({ length: n }, offerOp)).successful).toBe(true);
    }
    expect(d.accountEntry(maker1).numSubEntries).toBe(1000);
    expect(d.run(maker1, offerOp()).code).toBe('opTOO_MANY_SUBENTRIES');
    expect(d.submit(maker2, Array.from({ length: 10 }, offerOp)).successful).toBe(true);
    expect(d.book(idr, usd, 2000)).toHaveLength(1008);

    // Crossing 1001 offers is too much work; 1000 is fine.
    const tooMuch = d.sell(taker, usd, idr, 10_010n, oneone);
    expect(tooMuch.code).toBe('opEXCEEDED_WORK_LIMIT');
    expect(d.book(idr, usd, 2000)).toHaveLength(1008);
    const ok = d.sell(taker, usd, idr, 10_000n, oneone);
    expect(ok.code).toBe('MANAGE_SELL_OFFER_SUCCESS');
    expect(ok.claimed).toHaveLength(1000);
    expect(ok.effect).toBe('deleted');
    // Price-time priority: maker1's 998 offers first, then maker2's oldest two.
    expect(ok.claimed.slice(996).map((c) => c.sellerId)).toEqual([maker1, maker1, maker2, maker2].map((k) => k.publicKey()));
    expect(d.book(idr, usd, 2000)).toHaveLength(8);
    expect(d.accountEntry(maker1).numSubEntries).toBe(2);
    expect(d.balance(taker, idr)).toBe(10_000n);
    d.checkInvariants();
  });

  it('getOrderBook sorts by price then offer id, honors the limit and follows the state', () => {
    const { d, issuer, accs: [a, b, c], usd, idr } = setup(3);
    for (const kp of [a, b]) holder(d, issuer, kp, [[idr, 10_000n], [usd, 0n]]);
    holder(d, issuer, c, [[usd, 10_000n], [idr, 0n]]);
    const prices = [P(3, 2), P(1, 1), P(2, 3), P(1, 1), P(4, 6), P(5, 2)];
    prices.forEach((p, i) => d.sell(i % 2 ? b : a, idr, usd, 100n, p));
    // 2/3 (id 3) and 4/6 (id 5) are equal; then 1/1 ids 2 and 4; then 3/2; then 5/2.
    expect(d.book(idr, usd).map((o) => o.offerId)).toEqual([3n, 5n, 2n, 4n, 1n, 6n]);
    expect(d.book(idr, usd, 2).map((o) => o.offerId)).toEqual([3n, 5n]);
    expect(d.book(usd, idr)).toEqual([]);
    // c buys 150 IDR at up to 2/3 USD per IDR. Offer 3 is the smaller side:
    // sheepSend = floor(200 / 3) = 66, wheat = ceil(66 * 3 / 2) = 99, and the
    // offer is removed (its last IDR cannot be priced exactly). Offer 5 stays:
    // sheepSend = floor(51 * 4 / 6) = 34, wheat = 51, and its rest is adjusted
    // from 49 down to 48.
    const r = d.buy(c, usd, idr, 150n, P(2, 3));
    expect(atoms(r.claimed)).toEqual([
      [3n, 99n, 66n],
      [5n, 51n, 34n],
    ]);
    expect(r.effect).toBe('deleted');
    expect(d.balance(c, idr)).toBe(150n);
    expect(d.balance(c, usd)).toBe(10_000n - 100n);
    expect(d.book(idr, usd).map((o) => [o.offerId, o.amount])).toEqual([
      [5n, 48n],
      [2n, 100n],
      [4n, 100n],
      [1n, 100n],
      [6n, 100n],
    ]);
    // Returned entries are copies.
    const book = d.book(idr, usd);
    book[0].amount = 1n;
    expect(d.book(idr, usd)[0].amount).toBe(48n);
    d.checkInvariants();
  });
});

describe('results', () => {
  it('builds real ManageOfferSuccessResult XDR with order book claim atoms', () => {
    const { d, issuer, accs: [a, b], usd, idr } = setup(2);
    holder(d, issuer, a, [[idr, 1000n], [usd, 0n]]);
    holder(d, issuer, b, [[usd, 1000n], [idr, 0n]]);
    d.sell(a, idr, usd, 100n, oneone);
    const r = d.sell(b, usd, idr, 150n, oneone);
    const inner = xdr.expectUnionVariant(opResultTr(r.result.resultXdr), 'manageSellOffer').manageSellOfferResult;
    expect(inner.type).toBe('manageSellOfferSuccess');
    const success = xdr.expectUnionVariant(inner, 'manageSellOfferSuccess').success;
    const atom = success.offersClaimed[0];
    expect(atom.type).toBe('claimAtomTypeOrderBook');
    expect(xdr.expectUnionVariant(atom, 'claimAtomTypeOrderBook').orderBook.amountSold.toString()).toBe('100');
    expect(success.offer.type).toBe('manageOfferCreated');
    expect(xdr.expectUnionVariant(success.offer, 'manageOfferCreated').offer.amount.toString()).toBe('50');
    // Summaries report the code and the counterparties.
    expect(r.result.operations[0]).toMatchObject({ type: 'manageSellOffer', resultCode: 'MANAGE_SELL_OFFER_SUCCESS' });
    expect(r.result.accounts).toEqual(expect.arrayContaining([a.publicKey(), b.publicKey()]));
    // CreatePassiveSellOffer reports ManageSellOffer codes.
    const p = d.passive(a, idr, usd, 10n, P(5, 1));
    expect(opResultTr(p.result.resultXdr).type).toBe('createPassiveSellOffer');
    expect(p.offer!.flags).toBe(OFFER_PASSIVE_FLAG);
  });

  it('keeps the liabilities of stored offers equal to offerLiabilities', () => {
    const { d, issuer, accs: [a], usd, idr } = setup(1);
    holder(d, issuer, a, [[idr, 1_000_000n], [usd, 0n]]);
    const prices = [P(1, 3), P(7, 3), P(3, 7), P(1000, 1), P(1, 1000), P(97, 13)];
    let sell = 0n;
    let buy = 0n;
    for (const p of prices) {
      const r = d.sell(a, idr, usd, 1001n, p);
      const l = offerLiabilities({ price: p, amount: r.offer!.amount });
      sell += l.selling;
      buy += l.buying;
    }
    expect(d.line(a, idr)!.sellingLiabilities).toBe(sell);
    expect(d.line(a, usd)!.buyingLiabilities).toBe(buy);
    d.checkInvariants();
  });
});
