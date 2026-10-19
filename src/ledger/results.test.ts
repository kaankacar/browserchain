import { xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import {
  OP_RESULT_TYPES,
  defaultOpResult,
  fromXdrEnumName,
  opCodePrefix,
  opInner,
  opOuter,
  opResultCode,
  opResultToXdr,
  toXdrEnumName,
  txResultCode,
  txResultToXdr,
} from './results';
import { int64 } from './xdrutil';
import { sha256Hex } from '../lib/hash';

/** Member names of an XDR enum, from its js-xdr 5 schema. */
function enumNames(schema: { nameByValue: ReadonlyMap<number, string> }): string[] {
  return [...schema.nameByValue.values()];
}

/** The enum a result union switches on (e.g. PaymentResultCode for PaymentResult). */
function switchEnumOf(unionName: string): { nameByValue: ReadonlyMap<number, string> } {
  const union = (xdr as unknown as Record<string, { schema: { switchOn: { nameByValue: ReadonlyMap<number, string> } } }>)[unionName];
  return union.schema.switchOn;
}

describe('result code names', () => {
  it('round trip for every transaction and operation result code', () => {
    const all = [
      ...enumNames(xdr.TransactionResultCode.schema),
      ...enumNames(xdr.OperationResultCode.schema),
      ...Object.values(OP_RESULT_TYPES).flatMap((u) => enumNames(switchEnumOf(u))),
    ];
    expect(all.length).toBeGreaterThan(150);
    for (const name of all) expect(toXdrEnumName(fromXdrEnumName(name))).toBe(name);
  });

  it('uses stellar-core spellings', () => {
    expect(fromXdrEnumName('txBadSeq')).toBe('txBAD_SEQ');
    expect(fromXdrEnumName('txBadAuthExtra')).toBe('txBAD_AUTH_EXTRA');
    expect(fromXdrEnumName('opNoAccount')).toBe('opNO_ACCOUNT');
    expect(fromXdrEnumName('paymentUnderfunded')).toBe('PAYMENT_UNDERFUNDED');
    expect(fromXdrEnumName('changeTrustTrustLineMissing')).toBe('CHANGE_TRUST_TRUST_LINE_MISSING');
    expect(toXdrEnumName('SET_TRUST_LINE_FLAGS_CANT_REVOKE')).toBe('setTrustLineFlagsCantRevoke');
    expect(opCodePrefix('createPassiveSellOffer')).toBe('MANAGE_SELL_OFFER');
    expect(opCodePrefix('clawbackClaimableBalance')).toBe('CLAWBACK_CLAIMABLE_BALANCE');
  });
});

describe('result XDR', () => {
  it('builds every operation type default success result', () => {
    for (const type of Object.keys(OP_RESULT_TYPES)) {
      const r = opResultToXdr(type, defaultOpResult(type));
      const back = xdr.OperationResult.fromXdr(r.toXdr());
      expect(opResultCode(back)).toBe(`${opCodePrefix(type)}_SUCCESS`);
    }
  });

  it('builds failures, outer codes and values', () => {
    const fail = xdr.OperationResult.fromXdr(opResultToXdr('payment', opInner('PAYMENT_LINE_FULL')).toXdr());
    expect(opResultCode(fail)).toBe('PAYMENT_LINE_FULL');
    const outer = xdr.OperationResult.fromXdr(opResultToXdr('payment', opOuter('opBAD_AUTH')).toXdr());
    expect(outer.type).toBe('opBadAuth');
    expect(opResultCode(outer)).toBe('opBAD_AUTH');
    const merge = opResultToXdr('accountMerge', opInner('ACCOUNT_MERGE_SUCCESS', int64(42n)));
    const mergeBack = xdr.OperationResult.fromXdr(merge.toXdr());
    if (mergeBack.type !== 'opInner' || mergeBack.tr.type !== 'accountMerge') throw new Error('expected an accountMerge result');
    const mergeResult = mergeBack.tr.accountMergeResult;
    if (mergeResult.type !== 'accountMergeSuccess') throw new Error(`expected accountMergeSuccess, got ${mergeResult.type}`);
    expect(mergeResult.sourceAccountBalance.toString()).toBe('42');
    expect(opInner('PAYMENT_SUCCESS').success).toBe(true);
    expect(opInner('PAYMENT_MALFORMED').success).toBe(false);
    expect(opOuter('opNOT_SUPPORTED').success).toBe(false);
  });

  it('keeps operation results only for txSUCCESS and txFAILED', () => {
    const ok = txResultToXdr(300n, 'txFAILED', ['payment', 'bumpSequence'], [opInner('PAYMENT_UNDERFUNDED'), opInner('BUMP_SEQUENCE_SUCCESS')]);
    const back = xdr.TransactionResult.fromXdr(ok.toXdr());
    expect(back.feeCharged.toString()).toBe('300');
    expect(txResultCode(back)).toBe('txFAILED');
    const backResult = back.result;
    if (backResult.type !== 'txFailed') throw new Error(`expected txFailed, got ${backResult.type}`);
    expect(backResult.results.map((r) => opResultCode(r))).toEqual(['PAYMENT_UNDERFUNDED', 'BUMP_SEQUENCE_SUCCESS']);
    const bad = xdr.TransactionResult.fromXdr(txResultToXdr(100n, 'txBAD_SEQ', ['payment'], null).toXdr());
    expect(txResultCode(bad)).toBe('txBAD_SEQ');
    for (const code of ['txTOO_EARLY', 'txTOO_LATE', 'txMISSING_OPERATION', 'txBAD_AUTH', 'txINSUFFICIENT_BALANCE', 'txNO_ACCOUNT', 'txINSUFFICIENT_FEE', 'txBAD_AUTH_EXTRA', 'txINTERNAL_ERROR', 'txNOT_SUPPORTED', 'txBAD_MIN_SEQ_AGE_OR_GAP', 'txMALFORMED'] as const) {
      expect(txResultCode(xdr.TransactionResult.fromXdr(txResultToXdr(0n, code, [], null).toXdr()))).toBe(code);
    }
  });

  it('encodes every result code to the same bytes as stellar-base 15 (pinned digest)', () => {
    // Result bytes feed txSetResultHash: replaying ledgers closed before the
    // move to stellar-sdk needs the same bytes for every code. The digest was
    // computed with @stellar/stellar-base 15.0.0 and @stellar/stellar-sdk 17.2.1;
    // both gave the same value. A new result code in a future XDR changes the
    // count first.
    const unions = xdr as unknown as Record<string, { schema: { cases: { name: string; arm: { kind: string } }[] } }>;
    const lines: string[] = [];
    for (const opType of Object.keys(OP_RESULT_TYPES)) {
      for (const c of unions[OP_RESULT_TYPES[opType]].schema.cases) {
        const code = fromXdrEnumName(c.name);
        if (c.arm.kind === 'void') {
          lines.push(`${opType} ${code} ${txResultToXdr(100n, 'txFAILED', [opType], [opInner(code)]).toXdr('base64')}`);
        } else if (code.endsWith('_SUCCESS')) {
          lines.push(`${opType} ${code} ${txResultToXdr(100n, 'txSUCCESS', [opType], [defaultOpResult(opType)]).toXdr('base64')}`);
        }
      }
    }
    for (const code of ['opBAD_AUTH', 'opNO_ACCOUNT', 'opNOT_SUPPORTED', 'opTOO_MANY_SUBENTRIES', 'opEXCEEDED_WORK_LIMIT', 'opTOO_MANY_SPONSORING'] as const) {
      lines.push(`${code} ${txResultToXdr(100n, 'txFAILED', ['payment'], [opOuter(code)]).toXdr('base64')}`);
    }
    for (const code of ['txTOO_EARLY', 'txTOO_LATE', 'txMISSING_OPERATION', 'txBAD_SEQ', 'txBAD_AUTH', 'txINSUFFICIENT_BALANCE', 'txNO_ACCOUNT', 'txINSUFFICIENT_FEE', 'txBAD_AUTH_EXTRA', 'txINTERNAL_ERROR', 'txNOT_SUPPORTED', 'txBAD_SPONSORSHIP', 'txBAD_MIN_SEQ_AGE_OR_GAP', 'txMALFORMED'] as const) {
      lines.push(`${code} ${txResultToXdr(100n, code, [], null).toXdr('base64')}`);
    }
    expect(lines).toHaveLength(212);
    expect(sha256Hex(lines.sort().join('\n'))).toBe('194c6fccf0601990161fa90c8e8e1b0428f8c3eea116e5034610f1fe7a9a8cd6');
  });
});
