import { Asset, Claimant, Keypair, Memo, Operation } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { describeTransaction, extractMemo, formatPrice, summarizeOperations, touchedAccounts } from './describe';
import { formatAmount } from '../lib/amount';
import { Dex, XLM_ASSET, credit } from './dex/testkit';
import { TestLedger, XLM } from './testkit';

describe('describe helpers', () => {
  const t = new TestLedger();
  const a = Keypair.random();
  const b = Keypair.random();
  const c = Keypair.random();
  t.fund([a, b], 100n * XLM);

  it('extracts every memo type', () => {
    const memo = (m: Memo) => extractMemo(t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { memo: m }));
    expect(memo(Memo.none())).toEqual({ type: 'none', value: null });
    expect(memo(Memo.text('héllo'))).toEqual({ type: 'text', value: 'héllo' });
    expect(memo(Memo.id('18446744073709551615'))).toEqual({ type: 'id', value: '18446744073709551615' });
    expect(memo(Memo.hash('ab'.repeat(32)))).toEqual({ type: 'hash', value: 'ab'.repeat(32) });
    expect(memo(Memo.return('cd'.repeat(32)))).toEqual({ type: 'return', value: 'cd'.repeat(32) });
  });

  it('summarizes operations with readable details and result codes', () => {
    const usd = new Asset('USD', b.publicKey());
    const env = t.tx(a, [
      Operation.createAccount({ destination: c.publicKey(), startingBalance: '2.5' }),
      Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount: '1.25' }),
      Operation.changeTrust({ asset: usd, limit: '1000' }),
      Operation.manageData({ name: 'k', value: 'v' }),
      Operation.setOptions({ homeDomain: 'a.org', signer: { ed25519PublicKey: b.publicKey(), weight: 1 } }),
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '3',
        claimants: [new Claimant(b.publicKey(), Claimant.predicateUnconditional())],
      }),
    ]);
    const r = t.apply(env);
    expect(r.successful).toBe(true);
    const ops = r.operations;
    expect(ops.map((o) => o.type)).toEqual([
      'createAccount',
      'payment',
      'changeTrust',
      'manageData',
      'setOptions',
      'createClaimableBalance',
    ]);
    expect(ops.every((o) => o.sourceAccount === a.publicKey())).toBe(true);
    expect(ops.map((o) => o.resultCode)).toEqual([
      'CREATE_ACCOUNT_SUCCESS',
      'PAYMENT_SUCCESS',
      'CHANGE_TRUST_SUCCESS',
      'MANAGE_DATA_SUCCESS',
      'SET_OPTIONS_SUCCESS',
      'CREATE_CLAIMABLE_BALANCE_SUCCESS',
    ]);
    expect(ops[0].details).toEqual({ destination: c.publicKey(), startingBalance: '2.5000000' });
    expect(ops[1].details).toEqual({ from: a.publicKey(), to: b.publicKey(), asset: 'XLM', amount: '1.2500000' });
    expect(ops[2].details).toEqual({ asset: `USD:${b.publicKey()}`, limit: '1000.0000000' });
    expect(ops[3].details).toEqual({ name: 'k', value: 'dg==' });
    expect(ops[4].details).toEqual({ homeDomain: 'a.org', signerKey: b.publicKey(), signerWeight: 1 });
    expect(ops[5].details.amount).toBe('3.0000000');
    expect(ops[5].details.claimants).toBe(b.publicKey());
    expect(String(ops[5].details.balanceId)).toMatch(/^[0-9a-f]{64}$/);
    expect(r.accounts).toEqual([a.publicKey(), c.publicKey(), b.publicKey()]);
  });

  it('uses the transaction code for operations that never ran', () => {
    const env = t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { signers: [] });
    const r = t.apply(env);
    expect(r.resultCode).toBe('txBAD_AUTH');
    expect(r.operations.map((o) => o.resultCode)).toEqual(['txBAD_AUTH']);
    expect(summarizeOperations(env)[0].resultCode).toBe('');
  });

  it('describeTransaction combines everything', () => {
    const env = t.tx(b, [Operation.payment({ destination: a.publicKey(), asset: Asset.native(), amount: '1' })], {
      memo: Memo.text('hi'),
    });
    const r = t.apply(env);
    const d = describeTransaction(r.envelopeXdr, r.resultXdr);
    expect(d).toMatchObject({
      sourceAccount: b.publicKey(),
      maxFee: 100n,
      feeCharged: 100n,
      resultCode: 'txSUCCESS',
      successful: true,
      memo: { type: 'text', value: 'hi' },
    });
    expect(d.operations).toEqual(r.operations);
    expect(d.accounts).toEqual(touchedAccounts(r.envelopeXdr, r.resultXdr));
    const pending = describeTransaction(env);
    expect(pending.resultCode).toBeNull();
    expect(pending.feeCharged).toBeNull();
  });

  it('formats prices as 7-decimal strings', () => {
    expect(formatPrice(1, 2)).toBe('0.5000000');
    expect(formatPrice(10, 3)).toBe('3.3333333');
    expect(formatPrice(5, 0)).toBe('0');
  });

  it('describes trust, merge, clawback and claim operations', () => {
    const usd = new Asset('USD', a.publicKey());
    const env = t.rawTx(a, [
      Operation.allowTrust({ trustor: b.publicKey(), assetCode: 'USD', authorize: 1 }),
      Operation.setTrustLineFlags({ trustor: b.publicKey(), asset: usd, flags: { authorized: true } }),
      Operation.clawback({ asset: usd, amount: '1', from: b.publicKey() }),
      Operation.claimClaimableBalance({ balanceId: `00000000${'ab'.repeat(32)}` }),
      Operation.bumpSequence({ bumpTo: '77' }),
      Operation.accountMerge({ destination: b.publicKey() }),
    ]);
    const ops = summarizeOperations(env);
    expect(ops[0].details).toEqual({ trustor: b.publicKey(), assetCode: 'USD', authorize: 1 });
    expect(ops[1].details).toEqual({ trustor: b.publicKey(), asset: `USD:${a.publicKey()}`, setFlags: 1, clearFlags: 0 });
    expect(ops[2].details).toEqual({ from: b.publicKey(), asset: `USD:${a.publicKey()}`, amount: '1.0000000' });
    expect(ops[3].details).toEqual({ balanceId: 'ab'.repeat(32) });
    expect(ops[4].details).toEqual({ bumpTo: '77' });
    expect(ops[5].details).toEqual({ destination: b.publicKey() });
    expect(touchedAccounts(env)).toEqual([a.publicKey(), b.publicKey()]);
  });

  it('describes DEX operations', () => {
    const usd = new Asset('USD', b.publicKey());
    const env = t.rawTx(a, [
      Operation.manageSellOffer({ selling: Asset.native(), buying: usd, amount: '10', price: { n: 1, d: 4 }, offerId: '0' }),
      Operation.manageBuyOffer({ selling: Asset.native(), buying: usd, buyAmount: '5', price: '2' }),
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: '1',
        destination: c.publicKey(),
        destAsset: usd,
        destMin: '0.5',
        path: [new Asset('EUR', b.publicKey())],
      }),
    ]);
    const ops = summarizeOperations(env);
    expect(ops[0].details).toMatchObject({ selling: 'XLM', buying: `USD:${b.publicKey()}`, amount: '10.0000000', price: '0.2500000', priceN: 1, priceD: 4, offerId: '0' });
    expect(ops[1].details).toMatchObject({ buyAmount: '5.0000000', price: '2.0000000' });
    expect(ops[2].details).toMatchObject({ to: c.publicKey(), sendAmount: '1.0000000', destMin: '0.5000000', path: `EUR:${b.publicKey()}` });
    expect(touchedAccounts(env)).toEqual([a.publicKey(), c.publicKey()]);
  });

  it('reports the amount a strict receive path payment actually sent', () => {
    const d = new Dex();
    const [issuer, maker, payer, dest] = d.accounts(4, 10_000n * XLM);
    const USD = credit('USD', issuer);
    const EUR = credit('EUR', issuer);
    for (const k of [maker, payer, dest]) {
      d.trust(k, USD);
      d.trust(k, EUR);
    }
    d.issue(issuer, maker, USD, 1_000n * XLM);
    d.issue(issuer, maker, EUR, 1_000n * XLM);
    // XLM -> USD at 2 XLM per USD, USD -> EUR at 1:1, EUR -> XLM at 1 XLM per EUR.
    d.must(maker, Operation.manageSellOffer({ selling: USD.sdk, buying: XLM_ASSET.sdk, amount: '100', price: { n: 2, d: 1 } }));
    d.must(maker, Operation.manageSellOffer({ selling: EUR.sdk, buying: USD.sdk, amount: '100', price: { n: 1, d: 1 } }));
    d.must(maker, Operation.manageSellOffer({ selling: XLM_ASSET.sdk, buying: EUR.sdk, amount: '100', price: { n: 1, d: 1 } }));

    const before = d.balance(payer, XLM_ASSET);
    const o = d.strictReceive(payer, dest, XLM_ASSET, 1_000n * XLM, EUR, 10n * XLM, [USD]);
    expect(o.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
    const sent = before - d.balance(payer, XLM_ASSET) - o.result.feeCharged;
    expect(sent).toBe(20n * XLM);
    expect(o.result.operations[0].details.sendAmountSent).toBe('20.0000000');

    // A path that comes back to the send asset: only the first hop is what the source sent.
    const before2 = d.balance(payer, XLM_ASSET);
    const loop = d.strictReceive(payer, dest, XLM_ASSET, 1_000n * XLM, USD, 5n * XLM, [USD, EUR, XLM_ASSET]);
    expect(loop.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
    const sent2 = before2 - d.balance(payer, XLM_ASSET) - loop.result.feeCharged;
    expect(loop.result.operations[0].details.sendAmountSent).toBe(formatAmount(sent2));

    // No conversion: the destination amount is what was sent.
    const plain = d.strictReceive(payer, dest, USD, 1n * XLM, USD, 1n, []);
    expect(plain.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_UNDERFUNDED');
    expect(plain.result.operations[0].details.sendAmountSent).toBeUndefined();
    const direct = d.strictReceive(payer, dest, XLM_ASSET, 3n * XLM, XLM_ASSET, 3n * XLM, []);
    expect(direct.code).toBe('PATH_PAYMENT_STRICT_RECEIVE_SUCCESS');
    expect(direct.result.operations[0].details.sendAmountSent).toBe('3.0000000');
  });

  it('reports the id of an offer that a manage offer operation created', () => {
    const d = new Dex();
    const [issuer, maker] = d.accounts(2, 10_000n * XLM);
    const USD = credit('USD', issuer);
    d.trust(maker, USD);
    d.issue(issuer, maker, USD, 1_000n * XLM);
    const sell = d.sell(maker, USD, XLM_ASSET, 10n * XLM, { n: 3, d: 1 });
    const buy = d.buy(maker, XLM_ASSET, USD, 5n * XLM, { n: 1, d: 5 });
    const passive = d.passive(maker, USD, XLM_ASSET, 7n * XLM, { n: 4, d: 1 });
    expect([sell.effect, buy.effect, passive.effect]).toEqual(['created', 'created', 'created']);
    expect(sell.result.operations[0].details.createdOfferId).toBe(sell.offer!.offerId.toString());
    expect(buy.result.operations[0].details.createdOfferId).toBe(buy.offer!.offerId.toString());
    expect(passive.result.operations[0].details.createdOfferId).toBe(passive.offer!.offerId.toString());
    // Updates and deletes create nothing.
    const update = d.sell(maker, USD, XLM_ASSET, 11n * XLM, { n: 3, d: 1 }, sell.offer!.offerId);
    expect(update.effect).toBe('updated');
    expect(update.result.operations[0].details.createdOfferId).toBeUndefined();
    const del = d.sell(maker, USD, XLM_ASSET, 0n, { n: 3, d: 1 }, sell.offer!.offerId);
    expect(del.effect).toBe('deleted');
    expect(del.result.operations[0].details.createdOfferId).toBeUndefined();
  });
});

