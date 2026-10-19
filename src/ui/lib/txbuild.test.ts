import { Keypair, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import {
  baseSequenceFor,
  buildTx,
  cancelOfferOp,
  changeTrustOp,
  checkAmount,
  checkPrice,
  claimClaimableBalanceOp,
  createAccountOp,
  createClaimableBalanceOp,
  describeEnvelope,
  envelopeXdr,
  hasSignatureFrom,
  makeMemo,
  manageBuyOfferOp,
  manageDataOp,
  manageSellOfferOp,
  memoFromFields,
  paymentOp,
  shortBalanceId,
  signEnvelope,
  signTx,
  toSdkAsset,
  toSdkBalanceId,
  fromSdkAsset,
  txHashHex,
} from './txbuild';

const PASS = 'BrowserChain Network ; October 2026';
const alice = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(11));
const bob = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(12));
const issuer = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(13));
const USD = { type: 'credit_alphanum4' as const, code: 'USDB', issuer: issuer.publicKey() };
const XLM = { type: 'native' as const, code: 'XLM' };

function decode(b64: string): Transaction {
  return TransactionBuilder.fromXdr(b64, PASS) as Transaction;
}

describe('building transactions', () => {
  it('builds a signed XLM payment with the next sequence number and base fee', () => {
    const tx = buildTx(
      { source: alice.publicKey(), sequence: '41', networkPassphrase: PASS, memo: { type: 'text', value: 'rent' } },
      [paymentOp({ destination: bob.publicKey(), asset: XLM, amount: '12.5' })],
    );
    const b64 = signTx(tx, alice.secret());
    const back = decode(b64);
    expect(back.source).toBe(alice.publicKey());
    expect(back.sequence).toBe('42');
    expect(back.fee).toBe('100');
    expect(back.memo.type).toBe('text');
    // Text memos decoded from XDR are raw bytes (Uint8Array) in the SDK.
    expect(back.memo.value).toEqual(new TextEncoder().encode('rent'));
    expect(back.timeBounds).toEqual({ minTime: '0', maxTime: '0' });
    expect(back.operations).toHaveLength(1);
    const op = back.operations[0];
    expect(op.type).toBe('payment');
    if (op.type === 'payment') {
      expect(op.destination).toBe(bob.publicKey());
      expect(op.amount).toBe('12.5000000');
      expect(op.asset.isNative()).toBe(true);
    }
    expect(hasSignatureFrom(back, alice.publicKey())).toBe(true);
    expect(hasSignatureFrom(back, bob.publicKey())).toBe(false);
    expect(txHashHex(back)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('charges 100 stroops per operation and honors a higher fee', () => {
    const ops = [changeTrustOp({ asset: USD }), manageDataOp({ name: 'k', value: 'v' })];
    expect(buildTx({ source: alice.publicKey(), sequence: '1', networkPassphrase: PASS }, ops).fee).toBe('200');
    expect(buildTx({ source: alice.publicKey(), sequence: '1', networkPassphrase: PASS, feePerOp: 250 }, ops).fee).toBe('500');
    expect(() => buildTx({ source: alice.publicKey(), sequence: '1', networkPassphrase: PASS, feePerOp: 50 }, ops)).toThrow(/at least 100/);
  });

  it('builds credit payments, trustlines and account creation', () => {
    const tx = buildTx({ source: alice.publicKey(), sequence: '7', networkPassphrase: PASS }, [
      changeTrustOp({ asset: USD, limit: '1000' }),
      paymentOp({ destination: bob.publicKey(), asset: USD, amount: '3' }),
      createAccountOp({ destination: bob.publicKey(), startingBalance: '2' }),
      changeTrustOp({ asset: USD, limit: '0' }),
    ]);
    const [ct, pay, ca, rm] = tx.operations;
    expect(ct.type === 'changeTrust' && ct.limit).toBe('1000.0000000');
    expect(pay.type === 'payment' && pay.asset.getCode()).toBe('USDB');
    expect(ca.type === 'createAccount' && ca.startingBalance).toBe('2.0000000');
    expect(rm.type === 'changeTrust' && rm.limit).toBe('0.0000000');
  });

  it('builds offers and cancels with exact prices', () => {
    const tx = buildTx({ source: alice.publicKey(), sequence: '7', networkPassphrase: PASS }, [
      manageSellOfferOp({ selling: USD, buying: XLM, amount: '10', price: '8.4' }),
      manageBuyOfferOp({ selling: XLM, buying: USD, buyAmount: '5', price: '8.25' }),
      cancelOfferOp({ selling: USD, buying: XLM, offerId: '12' }),
    ]);
    const raw = xdr.expectUnionVariant(tx.toEnvelope(), 'envelopeTypeTx').v1.tx.operations;
    const sell = xdr.expectUnionVariant(raw[0].body, 'manageSellOffer').manageSellOfferOp;
    expect(sell.price.n / sell.price.d).toBeCloseTo(8.4, 9);
    const buy = xdr.expectUnionVariant(raw[1].body, 'manageBuyOffer').manageBuyOfferOp;
    expect(buy.price.n / buy.price.d).toBeCloseTo(8.25, 9);
    const cancel = tx.operations[2];
    expect(cancel.type === 'manageSellOffer' && cancel.amount).toBe('0.0000000');
    expect(cancel.type === 'manageSellOffer' && cancel.offerId).toBe('12');
    expect(() => cancelOfferOp({ selling: USD, buying: XLM, offerId: '0' })).toThrow();
  });

  it('builds claimable balances and claims', () => {
    const tx = buildTx({ source: alice.publicKey(), sequence: '7', networkPassphrase: PASS }, [
      createClaimableBalanceOp({
        asset: XLM,
        amount: '5',
        claimants: [
          { destination: bob.publicKey(), predicate: { type: 'beforeRelative', seconds: 3600 } },
          { destination: alice.publicKey(), predicate: { type: 'afterRelative', seconds: 60 } },
        ],
      }),
    ]);
    const op = tx.operations[0];
    expect(op.type).toBe('createClaimableBalance');
    if (op.type === 'createClaimableBalance') {
      expect(op.claimants).toHaveLength(2);
      expect(op.claimants[0].predicate.type).toBe('claimPredicateBeforeRelativeTime');
      expect(op.claimants[1].predicate.type).toBe('claimPredicateNot');
    }
    const id = tx.getClaimableBalanceId(0);
    expect(id).toHaveLength(72);
    expect(shortBalanceId(id)).toHaveLength(64);
    expect(toSdkBalanceId(shortBalanceId(id))).toBe(id);
    const claim = buildTx({ source: bob.publicKey(), sequence: '1', networkPassphrase: PASS }, [claimClaimableBalanceOp(shortBalanceId(id))]);
    const c = claim.operations[0];
    expect(c.type === 'claimClaimableBalance' && c.balanceId).toBe(id);
    expect(() =>
      createClaimableBalanceOp({
        asset: XLM,
        amount: '1',
        claimants: [
          { destination: bob.publicKey(), predicate: { type: 'unconditional' } },
          { destination: bob.publicKey(), predicate: { type: 'unconditional' } },
        ],
      }),
    ).toThrow(/once/);
  });
});

describe('validation', () => {
  it('rejects bad amounts, prices, accounts and memos with readable errors', () => {
    expect(checkAmount('1.5')).toBe('1.5');
    expect(() => checkAmount('')).toThrow(/required/);
    expect(() => checkAmount('0')).toThrow(/greater than zero/);
    expect(checkAmount('0', 'Limit', { allowZero: true })).toBe('0');
    expect(() => checkAmount('1.12345678')).toThrow(/7 decimals/);
    expect(() => checkAmount('-1')).toThrow();
    expect(() => checkPrice('0')).toThrow();
    expect(checkPrice('0.25')).toBe('0.25');
    expect(checkPrice('25.380000000000003')).toBe('25.38');
    expect(() => checkPrice('0.00000001')).toThrow(/too small/);
    expect(() => checkPrice('9999999999')).toThrow(/too large/);
    expect(() => paymentOp({ destination: 'GBAD', asset: XLM, amount: '1' })).toThrow(/Destination/);
    expect(() => makeMemo({ type: 'text', value: 'x'.repeat(29) })).toThrow(/28/);
    expect(() => makeMemo({ type: 'id', value: '18446744073709551616' })).toThrow(/64-bit/);
    expect(makeMemo({ type: 'id', value: '18446744073709551615' }).type).toBe('id');
    expect(() => makeMemo({ type: 'hash', value: 'abc' })).toThrow(/64 hex/);
    expect(makeMemo({ type: 'hash', value: 'ab'.repeat(32) }).type).toBe('hash');
    expect(memoFromFields('text', '  ')).toEqual({ type: 'none' });
    expect(memoFromFields('id', '5')).toEqual({ type: 'id', value: '5' });
    expect(() => changeTrustOp({ asset: XLM })).toThrow(/XLM/);
    expect(() => buildTx({ source: alice.publicKey(), sequence: '1', networkPassphrase: PASS }, [])).toThrow(/at least one/);
  });

  it('converts assets both ways', () => {
    expect(fromSdkAsset(toSdkAsset(USD))).toEqual(USD);
    expect(fromSdkAsset(toSdkAsset(XLM))).toEqual(XLM);
    expect(() => toSdkAsset({ type: 'credit_alphanum4', code: 'X' })).toThrow(/issuer/);
  });

  it('picks the sequence to build on', () => {
    expect(baseSequenceFor('100', null)).toBe('100');
    expect(baseSequenceFor('100', '101')).toBe('101');
    expect(baseSequenceFor('105', '101')).toBe('105');
  });
});

describe('signing envelopes', () => {
  it('adds a signature once and describes the envelope', () => {
    const tx = buildTx({ source: alice.publicKey(), sequence: '1', networkPassphrase: PASS }, [
      paymentOp({ destination: bob.publicKey(), asset: XLM, amount: '1', source: bob.publicKey() }),
    ]);
    const unsigned = envelopeXdr(tx);
    const first = signEnvelope(unsigned, alice.secret(), PASS);
    expect(first.added).toBe(true);
    expect(first.signer).toBe(alice.publicKey());
    const again = signEnvelope(first.xdr, alice.secret(), PASS);
    expect(again.added).toBe(false);
    const both = signEnvelope(first.xdr, bob.secret(), PASS);
    expect(both.added).toBe(true);
    const info = describeEnvelope(both.xdr, PASS);
    expect(info.kind).toBe('tx');
    expect(info.signatures).toHaveLength(2);
    expect(info.operations).toEqual([{ type: 'payment', source: bob.publicKey() }]);
    expect(info.hash).toBe(first.hash);
    expect(() => signEnvelope('not xdr', alice.secret(), PASS)).toThrow(/TransactionEnvelope/);
    expect(() => signEnvelope(unsigned, 'SBAD', PASS)).toThrow(/Secret/);
  });

  it('reads pasted envelopes with spaces and line breaks; rejects stray characters', () => {
    const tx = buildTx({ source: alice.publicKey(), sequence: '1', networkPassphrase: PASS }, [manageDataOp({ name: 'a', value: 'b' })]);
    const env = signTx(tx, alice.secret());
    const wrapped = `  ${env.replace(/(.{40})/g, '$1\n')}\n`;
    expect(describeEnvelope(wrapped, PASS).hash).toBe(txHashHex(tx));
    // stellar-base 15 skipped characters outside the base64 alphabet; the SDK refuses them.
    expect(() => describeEnvelope(`${env.slice(0, 20)}*${env.slice(20)}`, PASS)).toThrow(/Not a valid TransactionEnvelope/);
    expect(() => describeEnvelope(`${env}!`, PASS)).toThrow(/Not a valid TransactionEnvelope/);
  });

  it('signs over the network passphrase', () => {
    const tx = buildTx({ source: alice.publicKey(), sequence: '1', networkPassphrase: PASS }, [manageDataOp({ name: 'a', value: 'b' })]);
    const signed = signTx(tx, alice.secret());
    const other = TransactionBuilder.fromXdr(signed, 'Some Other Network') as Transaction;
    expect(hasSignatureFrom(other, alice.publicKey())).toBe(false);
    const env = xdr.TransactionEnvelope.fromXdr(signed, 'base64');
    expect(env.type).toBe('envelopeTypeTx');
  });
});
