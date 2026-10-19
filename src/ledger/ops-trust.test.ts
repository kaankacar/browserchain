import { Asset, Keypair, LiquidityPoolAsset, Operation, xdr } from '@stellar/stellar-sdk/base';
import { beforeEach, describe, expect, it } from 'vitest';
import { offerKey, trustlineKey } from './keys';
import { offerLiabilities } from './offers';
import { utf8 } from '../lib/bytes';
import { TestLedger, XLM, customLedger, newAccountEntry, af, withBody } from './testkit';
import {
  AUTH_CLAWBACK_ENABLED_FLAG,
  AUTH_REQUIRED_FLAG,
  AUTH_REVOCABLE_FLAG,
  TL_AUTHORIZED_FLAG,
  TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG,
  TL_CLAWBACK_ENABLED_FLAG,
  type CreditAsset,
  type OfferEntry,
  type TrustLineEntry,
} from './types';
import { opBody } from './xdrutil';

/** A copy of a ChangeTrust operation with some ChangeTrustOp fields replaced. */
function changeTrustWith(op: xdr.Operation, fields: Partial<{ line: xdr.ChangeTrustAsset; limit: bigint }>): xdr.Operation {
  const o = opBody(op, 'changeTrust').changeTrustOp;
  return withBody(op, xdr.OperationBody.changeTrust(new xdr.ChangeTrustOp({ ...o, ...fields })));
}

/** A copy of a ChangeTrust operation for a credit asset whose code bytes are replaced. */
function changeTrustWithCode(op: xdr.Operation, code: Uint8Array): xdr.Operation {
  const line = opBody(op, 'changeTrust').changeTrustOp.line;
  if (line.type === 'assetTypeCreditAlphanum4') {
    const a = new xdr.AlphaNum4({ assetCode: code, issuer: line.alphaNum4.issuer });
    return changeTrustWith(op, { line: xdr.ChangeTrustAsset.assetTypeCreditAlphanum4(a) });
  }
  const a = new xdr.AlphaNum12({ assetCode: code, issuer: xdr.expectUnionVariant(line, 'assetTypeCreditAlphanum12').alphaNum12.issuer });
  return changeTrustWith(op, { line: xdr.ChangeTrustAsset.assetTypeCreditAlphanum12(a) });
}

function opCodes(r: { operations: { resultCode: string }[] }): string[] {
  return r.operations.map((o) => o.resultCode);
}

describe('operations: trustlines and credit assets', () => {
  let t: TestLedger;
  let issuer: Keypair;
  let h1: Keypair;
  let h2: Keypair;
  let usd: Asset;
  let USD: CreditAsset;

  const line = (holder: Keypair) => t.lm.getEntry(trustlineKey(holder.publicKey(), USD)) as TrustLineEntry | undefined;
  const pay = (from: Keypair, to: Keypair, amount: string) =>
    t.apply(t.tx(from, [Operation.payment({ destination: to.publicKey(), asset: usd, amount })]));

  beforeEach(() => {
    t = new TestLedger();
    issuer = Keypair.random();
    h1 = Keypair.random();
    h2 = Keypair.random();
    t.fund([issuer, h1, h2], 100n * XLM);
    usd = new Asset('USD', issuer.publicKey());
    USD = { type: 'credit_alphanum4', code: 'USD', issuer: issuer.publicKey() };
  });

  describe('ChangeTrust', () => {
    it('creates an authorized trustline as a sub-entry, updates its limit and deletes it', () => {
      const r = t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '1000' })]));
      expect(opCodes(r)).toEqual(['CHANGE_TRUST_SUCCESS']);
      expect(line(h1)).toMatchObject({ balance: 0n, limit: 1000n * XLM, flags: TL_AUTHORIZED_FLAG });
      expect(t.lm.getAccount(h1.publicKey())!.numSubEntries).toBe(1);
      expect(t.lm.getTrustLines(h1.publicKey())).toHaveLength(1);
      t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '50' })]));
      expect(line(h1)!.limit).toBe(50n * XLM);
      t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '0' })]));
      expect(line(h1)).toBeUndefined();
      expect(t.lm.getAccount(h1.publicKey())!.numSubEntries).toBe(0);
    });

    it('uses the issuer flags: AUTH_REQUIRED leaves it unauthorized, clawback is inherited', () => {
      t.apply(
        t.tx(issuer, [Operation.setOptions({ setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG | AUTH_CLAWBACK_ENABLED_FLAG) })]),
      );
      t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd })]));
      expect(line(h1)!.flags).toBe(TL_CLAWBACK_ENABLED_FLAG);
      expect(line(h1)!.limit).toBe(9_223_372_036_854_775_807n);
    });

    it('CHANGE_TRUST_INVALID_LIMIT below balance + buying liabilities and for new zero-limit lines', () => {
      expect(opCodes(t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '0' })])))).toEqual([
        'CHANGE_TRUST_INVALID_LIMIT',
      ]);
      t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '100' })]));
      expect(opCodes(pay(issuer, h1, '40'))).toEqual(['PAYMENT_SUCCESS']);
      expect(opCodes(t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '39.9999999' })])))).toEqual([
        'CHANGE_TRUST_INVALID_LIMIT',
      ]);
      expect(opCodes(t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '0' })])))).toEqual([
        'CHANGE_TRUST_INVALID_LIMIT',
      ]);
      expect(opCodes(t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '40' })])))).toEqual([
        'CHANGE_TRUST_SUCCESS',
      ]);
    });

    it('CHANGE_TRUST_NO_ISSUER and CHANGE_TRUST_LOW_RESERVE', () => {
      const ghost = new Asset('EUR', Keypair.random().publicKey());
      expect(opCodes(t.apply(t.tx(h1, [Operation.changeTrust({ asset: ghost })])))).toEqual(['CHANGE_TRUST_NO_ISSUER']);
      const poor = Keypair.random();
      t.close([t.tx(t.root, [Operation.createAccount({ destination: poor.publicKey(), startingBalance: '1.2' })])]);
      expect(opCodes(t.apply(t.tx(poor, [Operation.changeTrust({ asset: usd })])))).toEqual(['CHANGE_TRUST_LOW_RESERVE']);
    });

    it('CHANGE_TRUST_MALFORMED for native, self-issued, pool shares and negative limits', () => {
      const detail = (src: Keypair, op: xdr.Operation) => t.lm.checkValid(t.tx(src, [op])).detail;
      expect(detail(h1, Operation.changeTrust({ asset: Asset.native() }))).toContain('CHANGE_TRUST_MALFORMED');
      expect(detail(issuer, Operation.changeTrust({ asset: usd }))).toContain('CHANGE_TRUST_MALFORMED');
      expect(
        detail(h1, Operation.changeTrust({ asset: new LiquidityPoolAsset(Asset.native(), usd, 30) })),
      ).toContain('CHANGE_TRUST_MALFORMED');
      const neg = changeTrustWith(Operation.changeTrust({ asset: usd }), { limit: xdr.Int64(-1n) });
      expect(detail(h1, neg)).toContain('CHANGE_TRUST_MALFORMED');
      const badCode = changeTrustWithCode(Operation.changeTrust({ asset: usd }), new Uint8Array([0x55, 0, 0x53, 0x44]));
      expect(t.lm.checkValid(t.rawTx(h1, [badCode])).detail).toContain('CHANGE_TRUST_MALFORMED');
      const symbol = changeTrustWithCode(Operation.changeTrust({ asset: usd }), utf8('U$D\0'));
      expect(t.lm.checkValid(t.rawTx(h1, [symbol])).detail).toContain('CHANGE_TRUST_MALFORMED');
      const short12 = changeTrustWithCode(
        Operation.changeTrust({ asset: new Asset('LONGCODE', issuer.publicKey()) }),
        utf8('ABCD\0\0\0\0\0\0\0\0'),
      );
      expect(t.lm.checkValid(t.rawTx(h1, [short12])).detail).toContain('CHANGE_TRUST_MALFORMED');
    });

    it('accepts 12-character asset codes', () => {
      const long = new Asset('LONGASSET12', issuer.publicKey());
      expect(t.apply(t.tx(h1, [Operation.changeTrust({ asset: long })])).successful).toBe(true);
      expect(t.lm.getTrustLines(h1.publicKey())[0].asset).toEqual({
        type: 'credit_alphanum12',
        code: 'LONGASSET12',
        issuer: issuer.publicKey(),
      });
    });
  });

  describe('credit payments', () => {
    beforeEach(() => {
      t.close([
        t.tx(h1, [Operation.changeTrust({ asset: usd, limit: '1000' })]),
        t.tx(h2, [Operation.changeTrust({ asset: usd, limit: '100' })]),
      ]);
    });

    it('issues, transfers and burns', () => {
      expect(opCodes(pay(issuer, h1, '500'))).toEqual(['PAYMENT_SUCCESS']);
      expect(line(h1)!.balance).toBe(500n * XLM);
      expect(opCodes(pay(h1, h2, '60'))).toEqual(['PAYMENT_SUCCESS']);
      expect(line(h2)!.balance).toBe(60n * XLM);
      expect(opCodes(pay(h1, issuer, '40'))).toEqual(['PAYMENT_SUCCESS']);
      expect(line(h1)!.balance).toBe(400n * XLM);
    });

    it('PAYMENT_LINE_FULL, PAYMENT_UNDERFUNDED, PAYMENT_NO_TRUST and PAYMENT_SRC_NO_TRUST', () => {
      pay(issuer, h1, '500');
      expect(opCodes(pay(h1, h2, '100.0000001'))).toEqual(['PAYMENT_LINE_FULL']);
      expect(opCodes(pay(h1, h2, '500.0000001'))).toEqual(['PAYMENT_LINE_FULL']);
      expect(opCodes(pay(h2, h1, '1'))).toEqual(['PAYMENT_UNDERFUNDED']);
      const h3 = Keypair.random();
      t.fund([h3], 10n * XLM);
      expect(opCodes(pay(h1, h3, '1'))).toEqual(['PAYMENT_NO_TRUST']);
      expect(opCodes(pay(h3, h1, '1'))).toEqual(['PAYMENT_SRC_NO_TRUST']);
    });

    it('can pay back to an issuer that no longer exists', () => {
      pay(issuer, h1, '10');
      expect(t.apply(t.tx(issuer, [Operation.accountMerge({ destination: h2.publicKey() })])).successful).toBe(true);
      expect(opCodes(pay(h1, issuer, '5'))).toEqual(['PAYMENT_SUCCESS']);
      expect(line(h1)!.balance).toBe(5n * XLM);
      expect(opCodes(pay(h1, h2, '1'))).toEqual(['PAYMENT_SUCCESS']);
    });
  });

  describe('AllowTrust and SetTrustLineFlags', () => {
    beforeEach(() => {
      t.apply(t.tx(issuer, [Operation.setOptions({ setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG) })]));
      t.close([t.tx(h1, [Operation.changeTrust({ asset: usd })]), t.tx(h2, [Operation.changeTrust({ asset: usd })])]);
    });

    it('authorizes, limits to maintaining liabilities and revokes (AllowTrust)', () => {
      expect(opCodes(pay(issuer, h1, '1'))).toEqual(['PAYMENT_NOT_AUTHORIZED']);
      const allow = (authorize: 0 | 1 | 2) =>
        t.apply(t.tx(issuer, [Operation.allowTrust({ trustor: h1.publicKey(), assetCode: 'USD', authorize })]));
      expect(opCodes(allow(1))).toEqual(['ALLOW_TRUST_SUCCESS']);
      expect(line(h1)!.flags).toBe(TL_AUTHORIZED_FLAG);
      expect(opCodes(pay(issuer, h1, '10'))).toEqual(['PAYMENT_SUCCESS']);
      expect(opCodes(allow(2))).toEqual(['ALLOW_TRUST_SUCCESS']);
      expect(line(h1)!.flags).toBe(TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG);
      expect(opCodes(pay(h1, issuer, '1'))).toEqual(['PAYMENT_SRC_NOT_AUTHORIZED']);
      expect(opCodes(allow(0))).toEqual(['ALLOW_TRUST_SUCCESS']);
      expect(line(h1)!.flags).toBe(0);
    });

    it('ALLOW_TRUST_NO_TRUST_LINE, CANT_REVOKE and MALFORMED', () => {
      const h3 = Keypair.random();
      t.fund([h3], 10n * XLM);
      expect(
        opCodes(t.apply(t.tx(issuer, [Operation.allowTrust({ trustor: h3.publicKey(), assetCode: 'USD', authorize: 1 })]))),
      ).toEqual(['ALLOW_TRUST_NO_TRUST_LINE']);
      t.apply(t.tx(issuer, [Operation.allowTrust({ trustor: h1.publicKey(), assetCode: 'USD', authorize: 1 })]));
      t.apply(t.tx(issuer, [Operation.setOptions({ clearFlags: AUTH_REVOCABLE_FLAG })]));
      expect(
        opCodes(t.apply(t.tx(issuer, [Operation.allowTrust({ trustor: h1.publicKey(), assetCode: 'USD', authorize: 0 })]))),
      ).toEqual(['ALLOW_TRUST_CANT_REVOKE']);
      expect(
        opCodes(t.apply(t.tx(issuer, [Operation.allowTrust({ trustor: h1.publicKey(), assetCode: 'USD', authorize: 2 })]))),
      ).toEqual(['ALLOW_TRUST_CANT_REVOKE']);
      const self = Operation.allowTrust({ trustor: issuer.publicKey(), assetCode: 'USD', authorize: 1 });
      expect(t.lm.checkValid(t.tx(issuer, [self])).detail).toContain('ALLOW_TRUST_MALFORMED');
      const one = Operation.allowTrust({ trustor: h1.publicKey(), assetCode: 'USD', authorize: 1 });
      const three = withBody(
        one,
        xdr.OperationBody.allowTrust(new xdr.AllowTrustOp({ ...opBody(one, 'allowTrust').allowTrustOp, authorize: 3 })),
      );
      expect(t.lm.checkValid(t.tx(issuer, [three])).detail).toContain('ALLOW_TRUST_MALFORMED');
    });

    it('SetTrustLineFlags sets and clears flags with stellar-core checks', () => {
      const stlf = (flags: { authorized?: boolean; authorizedToMaintainLiabilities?: boolean; clawbackEnabled?: boolean }, src = issuer) =>
        t.tx(src, [Operation.setTrustLineFlags({ trustor: h1.publicKey(), asset: usd, flags })]);
      expect(opCodes(t.apply(stlf({ authorized: true })))).toEqual(['SET_TRUST_LINE_FLAGS_SUCCESS']);
      expect(line(h1)!.flags).toBe(TL_AUTHORIZED_FLAG);
      expect(opCodes(t.apply(stlf({ authorizedToMaintainLiabilities: true })))).toEqual([
        'SET_TRUST_LINE_FLAGS_INVALID_STATE',
      ]);
      expect(opCodes(t.apply(stlf({ authorized: false, authorizedToMaintainLiabilities: true })))).toEqual([
        'SET_TRUST_LINE_FLAGS_SUCCESS',
      ]);
      expect(line(h1)!.flags).toBe(TL_AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG);
      const h3 = Keypair.random();
      t.fund([h3], 10n * XLM);
      expect(
        opCodes(
          t.apply(t.tx(issuer, [Operation.setTrustLineFlags({ trustor: h3.publicKey(), asset: usd, flags: { authorized: true } })])),
        ),
      ).toEqual(['SET_TRUST_LINE_FLAGS_NO_TRUST_LINE']);
      expect(t.lm.checkValid(stlf({ clawbackEnabled: true })).detail).toContain('SET_TRUST_LINE_FLAGS_MALFORMED');
      expect(t.lm.checkValid(stlf({ authorized: true }, h2)).detail).toContain('SET_TRUST_LINE_FLAGS_MALFORMED');
      t.apply(t.tx(issuer, [Operation.setOptions({ clearFlags: AUTH_REVOCABLE_FLAG })]));
      expect(opCodes(t.apply(stlf({ authorizedToMaintainLiabilities: false })))).toEqual([
        'SET_TRUST_LINE_FLAGS_CANT_REVOKE',
      ]);
      expect(opCodes(t.apply(stlf({ authorized: true, authorizedToMaintainLiabilities: false })))).toEqual([
        'SET_TRUST_LINE_FLAGS_SUCCESS',
      ]);
    });
  });

  describe('revoking authorization removes offers', () => {
    it('releases liabilities and sub-entries of offers buying or selling the asset', () => {
      const I = issuer.publicKey();
      const H = h1.publicKey();
      const issuerAcc = newAccountEntry(I, 100n * XLM, 1n, 1);
      issuerAcc.flags = AUTH_REVOCABLE_FLAG;
      const sellUsd: OfferEntry = {
        kind: 'offer',
        sellerId: H,
        offerId: 1n,
        selling: USD,
        buying: { type: 'native' },
        amount: 50n * XLM,
        price: { n: 2, d: 1 },
        flags: 0,
        lastModifiedLedgerSeq: 1,
      };
      const buyUsd: OfferEntry = { ...sellUsd, offerId: 2n, selling: { type: 'native' }, buying: USD, amount: 10n * XLM, price: { n: 1, d: 3 } };
      const l1 = offerLiabilities(sellUsd);
      const l2 = offerLiabilities(buyUsd);
      expect(l1).toEqual({ selling: 50n * XLM, buying: 100n * XLM });
      const holder = newAccountEntry(H, 100n * XLM, 1n, 1);
      holder.numSubEntries = 3;
      holder.buyingLiabilities = l1.buying;
      holder.sellingLiabilities = l2.selling;
      const tl: TrustLineEntry = {
        kind: 'trustline',
        accountId: H,
        asset: USD,
        balance: 60n * XLM,
        limit: 1000n * XLM,
        flags: TL_AUTHORIZED_FLAG,
        buyingLiabilities: l2.buying,
        sellingLiabilities: l1.selling,
        lastModifiedLedgerSeq: 1,
      };
      const c = new TestLedger(customLedger([issuerAcc, holder, tl, sellUsd, buyUsd], undefined, (h) => (h.idPool = 2n)));
      expect(c.lm.getOrderBook(USD, { type: 'native' })).toHaveLength(1);

      const r = c.apply(
        c.tx(issuer, [Operation.setTrustLineFlags({ trustor: H, asset: usd, flags: { authorized: false } })]),
      );
      expect(opCodes(r)).toEqual(['SET_TRUST_LINE_FLAGS_SUCCESS']);
      expect(c.lm.getEntry(offerKey(1n))).toBeUndefined();
      expect(c.lm.getEntry(offerKey(2n))).toBeUndefined();
      const acc = c.lm.getAccount(H)!;
      expect(acc.numSubEntries).toBe(1);
      expect(acc.buyingLiabilities).toBe(0n);
      expect(acc.sellingLiabilities).toBe(0n);
      const after = c.lm.getEntry(trustlineKey(H, USD)) as TrustLineEntry;
      expect(after.flags).toBe(0);
      expect(after.buyingLiabilities).toBe(0n);
      expect(after.sellingLiabilities).toBe(0n);
      expect(after.balance).toBe(60n * XLM);
    });
  });

  describe('Clawback', () => {
    beforeEach(() => {
      t.apply(t.tx(issuer, [Operation.setOptions({ setFlags: af(AUTH_REVOCABLE_FLAG | AUTH_CLAWBACK_ENABLED_FLAG) })]));
      t.apply(t.tx(h1, [Operation.changeTrust({ asset: usd })]));
      pay(issuer, h1, '100');
    });

    it('claws back from a clawback-enabled trustline', () => {
      expect(line(h1)!.flags).toBe(TL_AUTHORIZED_FLAG | TL_CLAWBACK_ENABLED_FLAG);
      const r = t.apply(t.tx(issuer, [Operation.clawback({ asset: usd, amount: '30', from: h1.publicKey() })]));
      expect(opCodes(r)).toEqual(['CLAWBACK_SUCCESS']);
      expect(line(h1)!.balance).toBe(70n * XLM);
      expect(opCodes(t.apply(t.tx(issuer, [Operation.clawback({ asset: usd, amount: '70.0000001', from: h1.publicKey() })])))).toEqual([
        'CLAWBACK_UNDERFUNDED',
      ]);
    });

    it('CLAWBACK_NOT_CLAWBACK_ENABLED, NO_TRUST and MALFORMED', () => {
      t.apply(t.tx(issuer, [Operation.setOptions({ clearFlags: AUTH_CLAWBACK_ENABLED_FLAG })]));
      t.apply(t.tx(h2, [Operation.changeTrust({ asset: usd })]));
      pay(issuer, h2, '5');
      expect(opCodes(t.apply(t.tx(issuer, [Operation.clawback({ asset: usd, amount: '1', from: h2.publicKey() })])))).toEqual([
        'CLAWBACK_NOT_CLAWBACK_ENABLED',
      ]);
      const h3 = Keypair.random();
      t.fund([h3], 10n * XLM);
      expect(opCodes(t.apply(t.tx(issuer, [Operation.clawback({ asset: usd, amount: '1', from: h3.publicKey() })])))).toEqual([
        'CLAWBACK_NO_TRUST',
      ]);
      expect(t.lm.checkValid(t.tx(issuer, [Operation.clawback({ asset: usd, amount: '1', from: issuer.publicKey() })])).detail).toContain(
        'CLAWBACK_MALFORMED',
      );
      expect(t.lm.checkValid(t.tx(h2, [Operation.clawback({ asset: usd, amount: '1', from: h1.publicKey() })])).detail).toContain(
        'CLAWBACK_MALFORMED',
      );
    });
  });
});
