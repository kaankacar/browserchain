import { Asset, Claimant, Keypair, Operation, StrKey, xdr } from '@stellar/stellar-sdk/base';
import { beforeEach, describe, expect, it } from 'vitest';
import { toBase64, utf8 } from '../lib/bytes';
import { INT64_MAX } from './math';
import { TestLedger, XLM, customLedger, newAccountEntry, af, opResultTr, withBody } from './testkit';
import { AUTH_CLAWBACK_ENABLED_FLAG, AUTH_IMMUTABLE_FLAG, AUTH_REQUIRED_FLAG, AUTH_REVOCABLE_FLAG } from './types';
import { int64, opBody } from './xdrutil';

function opCodes(r: { operations: { resultCode: string }[] }): string[] {
  return r.operations.map((o) => o.resultCode);
}

describe('operations: accounts', () => {
  let t: TestLedger;
  let a: Keypair;
  let b: Keypair;

  beforeEach(() => {
    t = new TestLedger();
    a = Keypair.random();
    b = Keypair.random();
    t.fund([a, b], 100n * XLM);
  });

  describe('CreateAccount', () => {
    it('creates the account with seqNum = ledgerSeq << 32 and debits the source', () => {
      const c = Keypair.random();
      const before = t.balanceOf(a.publicKey());
      const r = t.apply(t.tx(a, [Operation.createAccount({ destination: c.publicKey(), startingBalance: '10' })]));
      expect(r.resultCode).toBe('txSUCCESS');
      expect(opCodes(r)).toEqual(['CREATE_ACCOUNT_SUCCESS']);
      const acc = t.lm.getAccount(c.publicKey())!;
      expect(acc.balance).toBe(10n * XLM);
      expect(acc.seqNum).toBe(BigInt(t.ledgerSeq) << 32n);
      expect(acc.thresholds).toEqual({ master: 1, low: 0, med: 0, high: 0 });
      expect(acc.lastModifiedLedgerSeq).toBe(t.ledgerSeq);
      expect(t.balanceOf(a.publicKey())).toBe(before - 10n * XLM - 100n);
      // The new account can transact with seq = ledgerSeq << 32 + 1.
      const r2 = t.apply(t.tx(c, [Operation.bumpSequence({ bumpTo: '0' })]));
      expect(r2.resultCode).toBe('txSUCCESS');
    });

    it('CREATE_ACCOUNT_ALREADY_EXIST, LOW_RESERVE and UNDERFUNDED', () => {
      expect(opCodes(t.apply(t.tx(a, [Operation.createAccount({ destination: b.publicKey(), startingBalance: '1' })])))).toEqual([
        'CREATE_ACCOUNT_ALREADY_EXIST',
      ]);
      const c = Keypair.random().publicKey();
      expect(opCodes(t.apply(t.tx(a, [Operation.createAccount({ destination: c, startingBalance: '0.9999999' })])))).toEqual([
        'CREATE_ACCOUNT_LOW_RESERVE',
      ]);
      expect(opCodes(t.apply(t.tx(a, [Operation.createAccount({ destination: c, startingBalance: '99.5' })])))).toEqual([
        'CREATE_ACCOUNT_UNDERFUNDED',
      ]);
      expect(t.lm.getAccount(c)).toBeUndefined();
      const ok = t.apply(t.tx(a, [Operation.createAccount({ destination: c, startingBalance: '1' })]));
      expect(ok.successful).toBe(true);
    });

    it('CREATE_ACCOUNT_MALFORMED for the source itself', () => {
      const r = t.lm.checkValid(t.tx(a, [Operation.createAccount({ destination: a.publicKey(), startingBalance: '1' })]));
      expect(r.detail).toContain('CREATE_ACCOUNT_MALFORMED');
    });
  });

  describe('Payment', () => {
    it('moves native balance; paying yourself is a no-op', () => {
      const r = t.apply(t.tx(a, [Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount: '12.5' })]));
      expect(opCodes(r)).toEqual(['PAYMENT_SUCCESS']);
      expect(t.balanceOf(b.publicKey())).toBe(100n * XLM + 125_000_000n);
      expect(t.balanceOf(a.publicKey())).toBe(100n * XLM - 125_000_000n - 100n);
      const self = t.apply(t.tx(a, [Operation.payment({ destination: a.publicKey(), asset: Asset.native(), amount: '1000' })]));
      expect(opCodes(self)).toEqual(['PAYMENT_SUCCESS']);
    });

    it('PAYMENT_NO_DESTINATION and PAYMENT_UNDERFUNDED (reserve counts)', () => {
      const ghost = Keypair.random().publicKey();
      expect(opCodes(t.apply(t.tx(a, [Operation.payment({ destination: ghost, asset: Asset.native(), amount: '1' })])))).toEqual([
        'PAYMENT_NO_DESTINATION',
      ]);
      // 100 XLM - 200 stroops of fees - 1 XLM reserve is spendable.
      const avail = t.balanceOf(a.publicKey()) - 100n - XLM;
      const tooMuch = Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount: '99' });
      expect(opCodes(t.apply(t.tx(a, [tooMuch])))).toEqual(['PAYMENT_UNDERFUNDED']);
      const exact = (avail - 100n).toString();
      const amount = `${exact.slice(0, -7) || '0'}.${exact.slice(-7).padStart(7, '0')}`;
      const r = t.apply(t.tx(a, [Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount })]));
      expect(opCodes(r)).toEqual(['PAYMENT_SUCCESS']);
      expect(t.balanceOf(a.publicKey())).toBe(XLM);
    });

    it('PAYMENT_LINE_FULL when the destination would overflow', () => {
      const lm = customLedger([
        newAccountEntry(a.publicKey(), 100n * XLM, 1n, 1),
        newAccountEntry(b.publicKey(), INT64_MAX - 5n, 1n, 1),
      ]);
      const c = new TestLedger(lm);
      const r = c.apply(c.tx(a, [Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount: '0.0000010' })]));
      expect(opCodes(r)).toEqual(['PAYMENT_LINE_FULL']);
      const ok = c.apply(c.tx(a, [Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount: '0.0000005' })]));
      expect(opCodes(ok)).toEqual(['PAYMENT_SUCCESS']);
    });
  });

  describe('SetOptions', () => {
    it('sets home domain, thresholds, flags and inflation destination', () => {
      const r = t.apply(
        t.tx(a, [
          Operation.setOptions({
            homeDomain: 'example.com',
            lowThreshold: 1,
            medThreshold: 2,
            highThreshold: 3,
            masterWeight: 5,
            setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG),
            inflationDest: b.publicKey(),
          }),
        ]),
      );
      expect(opCodes(r)).toEqual(['SET_OPTIONS_SUCCESS']);
      const acc = t.lm.getAccount(a.publicKey())!;
      expect(acc.homeDomain).toBe('example.com');
      expect(acc.thresholds).toEqual({ master: 5, low: 1, med: 2, high: 3 });
      expect(acc.flags).toBe(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG);
      expect(acc.inflationDest).toBe(b.publicKey());
      t.apply(t.tx(a, [Operation.setOptions({ clearFlags: AUTH_REQUIRED_FLAG })]));
      expect(t.lm.getAccount(a.publicKey())!.flags).toBe(AUTH_REVOCABLE_FLAG);
    });

    it('adds, updates and removes signers with sub-entry accounting', () => {
      const s = Keypair.random().publicKey();
      t.apply(t.tx(a, [Operation.setOptions({ signer: { ed25519PublicKey: s, weight: 2 } })]));
      let acc = t.lm.getAccount(a.publicKey())!;
      expect(acc.signers).toEqual([{ key: s, weight: 2 }]);
      expect(acc.numSubEntries).toBe(1);
      expect(t.lm.minBalance(acc)).toBe(15_000_000n);
      t.apply(t.tx(a, [Operation.setOptions({ signer: { ed25519PublicKey: s, weight: 7 } })]));
      acc = t.lm.getAccount(a.publicKey())!;
      expect(acc.signers).toEqual([{ key: s, weight: 7 }]);
      expect(acc.numSubEntries).toBe(1);
      t.apply(t.tx(a, [Operation.setOptions({ signer: { ed25519PublicKey: s, weight: 0 } })]));
      acc = t.lm.getAccount(a.publicKey())!;
      expect(acc.signers).toEqual([]);
      expect(acc.numSubEntries).toBe(0);
    });

    it('keeps signers sorted and caps them at 20', () => {
      const keys = Array.from({ length: 21 }, () => Keypair.random().publicKey());
      const ops = keys.slice(0, 20).map((k) => Operation.setOptions({ signer: { ed25519PublicKey: k, weight: 1 } }));
      expect(t.apply(t.tx(a, ops)).successful).toBe(true);
      const acc = t.lm.getAccount(a.publicKey())!;
      expect(acc.signers.map((s) => s.key)).toEqual(keys.slice(0, 20).sort());
      expect(acc.numSubEntries).toBe(20);
      const r = t.apply(t.tx(a, [Operation.setOptions({ signer: { ed25519PublicKey: keys[20], weight: 1 } })]));
      expect(opCodes(r)).toEqual(['SET_OPTIONS_TOO_MANY_SIGNERS']);
    });

    it('SET_OPTIONS_LOW_RESERVE and SET_OPTIONS_INVALID_INFLATION', () => {
      const poor = Keypair.random();
      t.close([t.tx(t.root, [Operation.createAccount({ destination: poor.publicKey(), startingBalance: '1.4' })])]);
      const r = t.apply(t.tx(poor, [Operation.setOptions({ signer: { ed25519PublicKey: b.publicKey(), weight: 1 } })]));
      expect(opCodes(r)).toEqual(['SET_OPTIONS_LOW_RESERVE']);
      const r2 = t.apply(t.tx(a, [Operation.setOptions({ inflationDest: Keypair.random().publicKey() })]));
      expect(opCodes(r2)).toEqual(['SET_OPTIONS_INVALID_INFLATION']);
    });

    it('SET_OPTIONS_CANT_CHANGE with AUTH_IMMUTABLE and SET_OPTIONS_AUTH_REVOCABLE_REQUIRED', () => {
      expect(opCodes(t.apply(t.tx(a, [Operation.setOptions({ setFlags: AUTH_CLAWBACK_ENABLED_FLAG })])))).toEqual([
        'SET_OPTIONS_AUTH_REVOCABLE_REQUIRED',
      ]);
      expect(
        opCodes(t.apply(t.tx(a, [Operation.setOptions({ setFlags: af(AUTH_CLAWBACK_ENABLED_FLAG | AUTH_REVOCABLE_FLAG) })]))),
      ).toEqual(['SET_OPTIONS_SUCCESS']);
      expect(opCodes(t.apply(t.tx(a, [Operation.setOptions({ clearFlags: AUTH_REVOCABLE_FLAG })])))).toEqual([
        'SET_OPTIONS_AUTH_REVOCABLE_REQUIRED',
      ]);
      t.apply(t.tx(b, [Operation.setOptions({ setFlags: af(AUTH_IMMUTABLE_FLAG | AUTH_REVOCABLE_FLAG) })]));
      expect(opCodes(t.apply(t.tx(b, [Operation.setOptions({ clearFlags: AUTH_REVOCABLE_FLAG })])))).toEqual([
        'SET_OPTIONS_CANT_CHANGE',
      ]);
      expect(opCodes(t.apply(t.tx(b, [Operation.setOptions({ setFlags: AUTH_REQUIRED_FLAG })])))).toEqual([
        'SET_OPTIONS_CANT_CHANGE',
      ]);
      // Non-auth options still work.
      expect(opCodes(t.apply(t.tx(b, [Operation.setOptions({ homeDomain: 'ok.org' })])))).toEqual(['SET_OPTIONS_SUCCESS']);
    });

    it('rejects malformed options in checkValid', () => {
      const detail = (op: xdr.Operation) => t.lm.checkValid(t.tx(a, [op])).detail;
      expect(detail(Operation.setOptions({ setFlags: af(16) }))).toContain('SET_OPTIONS_UNKNOWN_FLAG');
      expect(detail(Operation.setOptions({ setFlags: af(1), clearFlags: af(1) }))).toContain('SET_OPTIONS_BAD_FLAGS');
      expect(detail(Operation.setOptions({ signer: { ed25519PublicKey: a.publicKey(), weight: 1 } }))).toContain(
        'SET_OPTIONS_BAD_SIGNER',
      );
      expect(detail(Operation.setOptions({ homeDomain: 'bad\ndomain' }))).toContain('SET_OPTIONS_INVALID_HOME_DOMAIN');
      const raw = Operation.setOptions({ homeDomain: 'x' });
      const rawOp = opBody(raw, 'setOptions').setOptionsOp;
      const heavy = withBody(raw, xdr.OperationBody.setOptions(new xdr.SetOptionsOp({ ...rawOp, masterWeight: 300 })));
      expect(detail(heavy)).toContain('SET_OPTIONS_THRESHOLD_OUT_OF_RANGE');
      const bigWeight = Operation.setOptions({ signer: { ed25519PublicKey: b.publicKey(), weight: 1 } });
      const bigOp = opBody(bigWeight, 'setOptions').setOptionsOp;
      const heavySigner = withBody(
        bigWeight,
        xdr.OperationBody.setOptions(new xdr.SetOptionsOp({ ...bigOp, signer: new xdr.Signer({ key: bigOp.signer!.key, weight: 256 }) })),
      );
      expect(detail(heavySigner)).toContain('SET_OPTIONS_BAD_SIGNER');
    });
  });

  describe('AccountMerge', () => {
    it('moves the balance, deletes the account and reports the merged balance', () => {
      const bBefore = t.balanceOf(b.publicKey());
      const r = t.apply(t.tx(a, [Operation.accountMerge({ destination: b.publicKey() })]));
      expect(opCodes(r)).toEqual(['ACCOUNT_MERGE_SUCCESS']);
      expect(r.operations[0].details.amount).toBe('99.9999900');
      expect(t.lm.getAccount(a.publicKey())).toBeUndefined();
      expect(t.balanceOf(b.publicKey())).toBe(bBefore + 100n * XLM - 100n);
      const merge = xdr.expectUnionVariant(opResultTr(r.resultXdr), 'accountMerge').accountMergeResult;
      expect(xdr.expectUnionVariant(merge, 'accountMergeSuccess').sourceAccountBalance.toString()).toBe((100n * XLM - 100n).toString());
    });

    it('removes signers and accepts muxed destinations', () => {
      t.apply(t.tx(a, [Operation.setOptions({ signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 1 } })]));
      const env = t.tx(a, [Operation.accountMerge({ destination: b.publicKey() })]);
      expect(t.apply(env).successful).toBe(true);
      const c = Keypair.random();
      t.fund([c], 10n * XLM);
      const mOp = new xdr.Operation({
        sourceAccount: null,
        body: xdr.OperationBody.accountMerge(
          xdr.MuxedAccount.keyTypeMuxedEd25519(
            new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString('7'), ed25519: StrKey.decodeEd25519PublicKey(b.publicKey()) }),
          ),
        ),
      });
      const r = t.apply(t.tx(c, [mOp]));
      expect(r.successful).toBe(true);
      expect(String(r.operations[0].details.destination).startsWith('M')).toBe(true);
    });

    it('ACCOUNT_MERGE_NO_ACCOUNT, HAS_SUB_ENTRIES, IMMUTABLE_SET, IS_SPONSOR and MALFORMED', () => {
      expect(opCodes(t.apply(t.tx(a, [Operation.accountMerge({ destination: Keypair.random().publicKey() })])))).toEqual([
        'ACCOUNT_MERGE_NO_ACCOUNT',
      ]);
      t.apply(t.tx(a, [Operation.manageData({ name: 'k', value: 'v' })]));
      expect(opCodes(t.apply(t.tx(a, [Operation.accountMerge({ destination: b.publicKey() })])))).toEqual([
        'ACCOUNT_MERGE_HAS_SUB_ENTRIES',
      ]);
      t.apply(t.tx(b, [Operation.setOptions({ setFlags: AUTH_IMMUTABLE_FLAG })]));
      expect(opCodes(t.apply(t.tx(b, [Operation.accountMerge({ destination: a.publicKey() })])))).toEqual([
        'ACCOUNT_MERGE_IMMUTABLE_SET',
      ]);
      const c = Keypair.random();
      t.fund([c], 10n * XLM);
      t.apply(
        t.tx(c, [
          Operation.createClaimableBalance({
            asset: Asset.native(),
            amount: '1',
            claimants: [new Claimant(a.publicKey(), Claimant.predicateUnconditional())],
          }),
        ]),
      );
      expect(opCodes(t.apply(t.tx(c, [Operation.accountMerge({ destination: a.publicKey() })])))).toEqual([
        'ACCOUNT_MERGE_IS_SPONSOR',
      ]);
      expect(t.lm.checkValid(t.tx(c, [Operation.accountMerge({ destination: c.publicKey() })])).detail).toContain(
        'ACCOUNT_MERGE_MALFORMED',
      );
    });

    it('ACCOUNT_MERGE_SEQNUM_TOO_FAR when the sequence reached the next ledger start', () => {
      const bumpTo = (BigInt(t.ledgerSeq + 1) << 32n).toString();
      const r = t.apply(t.tx(a, [Operation.bumpSequence({ bumpTo }), Operation.accountMerge({ destination: b.publicKey() })]));
      expect(r.resultCode).toBe('txFAILED');
      expect(opCodes(r)).toEqual(['BUMP_SEQUENCE_SUCCESS', 'ACCOUNT_MERGE_SEQNUM_TOO_FAR']);
      // The bump was rolled back with the transaction.
      expect(t.lm.getAccount(a.publicKey())!.seqNum).toBeLessThan(BigInt(bumpTo));
    });

    it('ACCOUNT_MERGE_DEST_FULL', () => {
      const lm = customLedger([
        newAccountEntry(a.publicKey(), 100n * XLM, 1n, 1),
        newAccountEntry(b.publicKey(), INT64_MAX - 10n * XLM, 1n, 1),
      ]);
      const c = new TestLedger(lm);
      expect(opCodes(c.apply(c.tx(a, [Operation.accountMerge({ destination: b.publicKey() })])))).toEqual([
        'ACCOUNT_MERGE_DEST_FULL',
      ]);
    });

    it('later operations of a merged source fail with opNO_ACCOUNT and the merge is undone', () => {
      const r = t.apply(
        t.tx(a, [
          Operation.accountMerge({ destination: b.publicKey() }),
          Operation.payment({ destination: b.publicKey(), asset: Asset.native(), amount: '1' }),
        ]),
      );
      expect(r.resultCode).toBe('txFAILED');
      expect(opCodes(r)).toEqual(['ACCOUNT_MERGE_SUCCESS', 'opNO_ACCOUNT']);
      expect(t.lm.getAccount(a.publicKey())).toBeDefined();
    });

    it('a merged account can be re-created with a new sequence number', () => {
      t.apply(t.tx(a, [Operation.accountMerge({ destination: b.publicKey() })]));
      t.apply(t.tx(b, [Operation.createAccount({ destination: a.publicKey(), startingBalance: '5' })]));
      expect(t.lm.getAccount(a.publicKey())!.seqNum).toBe(BigInt(t.ledgerSeq) << 32n);
    });
  });

  describe('ManageData', () => {
    it('creates, updates and deletes entries', () => {
      expect(opCodes(t.apply(t.tx(a, [Operation.manageData({ name: 'color', value: 'blue' })])))).toEqual([
        'MANAGE_DATA_SUCCESS',
      ]);
      expect(t.lm.getDataEntries(a.publicKey())).toMatchObject([{ name: 'color', value: toBase64(utf8('blue')) }]);
      expect(t.lm.getAccount(a.publicKey())!.numSubEntries).toBe(1);
      t.apply(t.tx(a, [Operation.manageData({ name: 'color', value: new Uint8Array([0, 1, 2]) })]));
      expect(t.lm.getDataEntries(a.publicKey())[0].value).toBe('AAEC');
      expect(t.lm.getAccount(a.publicKey())!.numSubEntries).toBe(1);
      t.apply(t.tx(a, [Operation.manageData({ name: 'color', value: null })]));
      expect(t.lm.getDataEntries(a.publicKey())).toEqual([]);
      expect(t.lm.getAccount(a.publicKey())!.numSubEntries).toBe(0);
    });

    it('MANAGE_DATA_NAME_NOT_FOUND, LOW_RESERVE and INVALID_NAME', () => {
      expect(opCodes(t.apply(t.tx(a, [Operation.manageData({ name: 'nope', value: null })])))).toEqual([
        'MANAGE_DATA_NAME_NOT_FOUND',
      ]);
      const poor = Keypair.random();
      t.close([t.tx(t.root, [Operation.createAccount({ destination: poor.publicKey(), startingBalance: '1.0001' })])]);
      expect(opCodes(t.apply(t.tx(poor, [Operation.manageData({ name: 'x', value: 'y' })])))).toEqual([
        'MANAGE_DATA_LOW_RESERVE',
      ]);
      expect(t.lm.checkValid(t.tx(a, [Operation.manageData({ name: '', value: 'y' })])).detail).toContain(
        'MANAGE_DATA_INVALID_NAME',
      );
      expect(t.lm.checkValid(t.tx(a, [Operation.manageData({ name: 'a\u0001', value: 'y' })])).detail).toContain(
        'MANAGE_DATA_INVALID_NAME',
      );
    });

    it('opTOO_MANY_SUBENTRIES at the sub-entry limit', () => {
      const acc = newAccountEntry(a.publicKey(), 10_000n * XLM, 1n, 1);
      acc.numSubEntries = 1000;
      const c = new TestLedger(customLedger([acc]));
      expect(opCodes(c.apply(c.tx(a, [Operation.manageData({ name: 'x', value: 'y' })])))).toEqual(['opTOO_MANY_SUBENTRIES']);
    });
  });

  describe('BumpSequence', () => {
    it('bumps forward, ignores lower targets and records seqLedger/seqTime', () => {
      const target = t.seqOf(a.publicKey()) + 100n;
      const r = t.apply(t.tx(a, [Operation.bumpSequence({ bumpTo: target.toString() })]));
      expect(opCodes(r)).toEqual(['BUMP_SEQUENCE_SUCCESS']);
      let acc = t.lm.getAccount(a.publicKey())!;
      expect(acc.seqNum).toBe(target);
      expect(acc.seqLedger).toBe(t.ledgerSeq);
      expect(acc.seqTime).toBe(BigInt(t.closeTime));
      t.apply(t.tx(a, [Operation.bumpSequence({ bumpTo: '5' })]));
      acc = t.lm.getAccount(a.publicKey())!;
      expect(acc.seqNum).toBe(target + 1n);
    });

    it('BUMP_SEQUENCE_BAD_SEQ for negative targets', () => {
      const op = withBody(Operation.bumpSequence({ bumpTo: '1' }), xdr.OperationBody.bumpSequence(new xdr.BumpSequenceOp({ bumpTo: int64(-1n) })));
      expect(t.lm.checkValid(t.tx(a, [op])).detail).toContain('BUMP_SEQUENCE_BAD_SEQ');
    });
  });

  it('muxed payment destinations credit the underlying account', () => {
    const op = new xdr.Operation({
      sourceAccount: null,
      body: xdr.OperationBody.payment(
        new xdr.PaymentOp({
          destination: xdr.MuxedAccount.keyTypeMuxedEd25519(
            new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString('99'), ed25519: StrKey.decodeEd25519PublicKey(b.publicKey()) }),
          ),
          asset: xdr.Asset.assetTypeNative(),
          amount: int64(XLM),
        }),
      ),
    });
    const before = t.balanceOf(b.publicKey());
    expect(t.apply(t.tx(a, [op])).successful).toBe(true);
    expect(t.balanceOf(b.publicKey())).toBe(before + XLM);
  });
});
