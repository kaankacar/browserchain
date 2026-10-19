import { describe, expect, it } from 'vitest';
import type { OperationView, TxSummary } from '../../node/api';
import { describeOp, describePredicate, describeTx, detailKind, detailLabel, opKind, predicateHoldsNow } from './describe';

const G = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const op = (type: string, details: OperationView['details']): OperationView => ({ index: 0, type, sourceAccount: G, resultCode: 'X', details });

describe('describeOp', () => {
  it('describes payments and account creation', () => {
    expect(describeOp(op('payment', { to: G, asset: `USDB:${G}`, amount: '125.5000000' }))).toMatchObject({
      kind: 'payment',
      title: 'Payment',
      amount: '125.5 USDB',
      counterparty: G,
    });
    expect(describeOp(op('payment', { destination: G, asset: 'XLM', amount: '1.0000000' })).amount).toBe('1 XLM');
    expect(describeOp(op('createAccount', { destination: G, startingBalance: '10000.0000000' }))).toMatchObject({
      kind: 'account',
      amount: '10,000 XLM',
      counterparty: G,
    });
  });

  it('describes offers, trustlines and claims', () => {
    expect(describeOp(op('manageSellOffer', { selling: `USDB:${G}`, buying: 'XLM', amount: '10.0000000', price: '8.4' }))).toMatchObject({
      kind: 'offer',
      title: 'Sell offer',
      amount: '10 USDB',
      note: 'USDB → XLM @ 8.4',
    });
    expect(describeOp(op('manageSellOffer', { selling: 'XLM', buying: `USDB:${G}`, amount: '0.0000000', price: '1' })).title).toBe('Cancel offer');
    expect(describeOp(op('manageBuyOffer', { selling: 'XLM', buying: `EURB:${G}`, buyAmount: '5.0000000', price: '9' })).amount).toBe('5 EURB');
    expect(describeOp(op('changeTrust', { asset: `GOLD:${G}`, limit: '0.0000000' })).title).toBe('Remove trustline');
    expect(describeOp(op('changeTrust', { asset: `GOLD:${G}`, limit: '922337203685.4775807' }))).toMatchObject({ title: 'Change trust', note: 'GOLD', counterparty: G });
    expect(describeOp(op('createClaimableBalance', { asset: 'XLM', amount: '40.0000000' })).amount).toBe('40 XLM');
    expect(describeOp(op('manageData', { name: 'nickname' })).note).toBe('nickname');
    expect(describeOp(op('inflation', {})).kind).toBe('other');
  });

  it('shows what a strict receive path payment sent and the id of a new offer', () => {
    const sent = op('pathPaymentStrictReceive', {
      to: G,
      sendAsset: 'XLM',
      sendMax: '500.0000000',
      destAsset: `EURB:${G}`,
      destAmount: '50.0000000',
      path: '',
      sendAmountSent: '27.5000000',
    });
    expect(describeOp(sent)).toMatchObject({ amount: '50 EURB', counterparty: G, note: 'sent 27.5 XLM' });
    // a failed one has no sendAmountSent
    expect(describeOp(op('pathPaymentStrictReceive', { to: G, sendAsset: 'XLM', destAsset: 'XLM', destAmount: '1.0000000' })).note).toBeNull();
    const sell = { selling: `USDB:${G}`, buying: 'XLM', amount: '10.0000000', price: '8.4', offerId: '0' };
    expect(describeOp(op('manageSellOffer', { ...sell, createdOfferId: '12' })).note).toBe('USDB → XLM @ 8.4 · new offer #12');
    // filled at once: no offer left in the book
    expect(describeOp(op('manageSellOffer', sell)).note).toBe('USDB → XLM @ 8.4');
    expect(describeOp(op('manageBuyOffer', { selling: 'XLM', buying: `EURB:${G}`, buyAmount: '5.0000000', price: '9', createdOfferId: '7' })).note).toBe(
      'XLM → EURB @ 9 · new offer #7',
    );
    // the transaction page labels them
    expect(detailLabel('sendAmountSent')).toBe('Amount sent');
    expect(detailKind('sendAmountSent', '27.5000000')).toBe('amount');
    expect(detailLabel('createdOfferId')).toBe('New offer ID');
    expect(detailLabel('offerId')).toBe('Offer ID');
  });

  it('describes a whole transaction', () => {
    const tx = { operations: [op('payment', { to: G, asset: 'XLM', amount: '2.0000000' }), op('manageData', { name: 'x' })] } as unknown as TxSummary;
    expect(describeTx(tx)).toMatchObject({ title: 'Payment', more: 1 });
    expect(describeTx({ operations: [] } as unknown as TxSummary).title).toBe('Transaction');
  });

  it('classifies detail values', () => {
    expect(opKind('pathPaymentStrictSend')).toBe('payment');
    expect(detailKind('to', G)).toBe('account');
    expect(detailKind('claimants', `${G},${G}`)).toBe('accounts');
    expect(describeOp(op('pathPaymentStrictSend', { to: G, destAsset: 'XLM', destAmountReceived: '2.5000000' })).amount).toBe('2.5 XLM');
    expect(detailKind('asset', `USDB:${G}`)).toBe('asset');
    expect(detailKind('asset', 'XLM')).toBe('asset');
    expect(detailKind('amount', '1.0000000')).toBe('amount');
    expect(detailKind('balanceId', 'a'.repeat(64))).toBe('hash');
    expect(detailKind('name', 'hello')).toBe('text');
    expect(detailKind('claimed', 3)).toBe('text');
    expect(detailLabel('startingBalance')).toBe('Starting balance');
  });
});


describe('claim predicates', () => {
  const before = { type: 'beforeAbsoluteTime', time: '1790000000' };
  it('describes predicates', () => {
    expect(describePredicate({ type: 'unconditional' })).toBe('any time');
    expect(describePredicate(before)).toBe('before 2026-09-21 14:13 UTC');
    expect(describePredicate({ type: 'not', predicate: before })).toBe('after 2026-09-21 14:13 UTC');
    expect(describePredicate({ type: 'and', predicates: [{ type: 'unconditional' }, before] })).toBe('(any time) and (before 2026-09-21 14:13 UTC)');
    expect(describePredicate('weird')).toBe('"weird"');
  });
  it('evaluates predicates', () => {
    expect(predicateHoldsNow({ type: 'unconditional' }, 0)).toBe(true);
    expect(predicateHoldsNow(before, 1789999999)).toBe(true);
    expect(predicateHoldsNow(before, 1790000000)).toBe(false);
    expect(predicateHoldsNow({ type: 'not', predicate: before }, 1790000001)).toBe(true);
    expect(predicateHoldsNow({ type: 'or', predicates: [before, { type: 'unconditional' }] }, 1790000005)).toBe(true);
    expect(predicateHoldsNow({ type: 'mystery' }, 1)).toBeNull();
    expect(predicateHoldsNow(null, 1)).toBeNull();
  });
});
