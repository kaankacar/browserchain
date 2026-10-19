// Transaction and operation results: readable code names and real
// xdr.TransactionResult / xdr.OperationResult construction (docs/ARCHITECTURE.md 5.8).

import { xdr } from '@stellar/stellar-sdk/base';
import { int64 } from './xdrutil';

/** Outer operation result codes (OperationResultCode). */
export type OuterOpCode =
  | 'opINNER'
  | 'opBAD_AUTH'
  | 'opNO_ACCOUNT'
  | 'opNOT_SUPPORTED'
  | 'opTOO_MANY_SUBENTRIES'
  | 'opEXCEEDED_WORK_LIMIT'
  | 'opTOO_MANY_SPONSORING';

/** Transaction result codes (TransactionResultCode) used by this ledger. */
export type TxCode =
  | 'txSUCCESS'
  | 'txFAILED'
  | 'txTOO_EARLY'
  | 'txTOO_LATE'
  | 'txMISSING_OPERATION'
  | 'txBAD_SEQ'
  | 'txBAD_AUTH'
  | 'txINSUFFICIENT_BALANCE'
  | 'txNO_ACCOUNT'
  | 'txINSUFFICIENT_FEE'
  | 'txBAD_AUTH_EXTRA'
  | 'txINTERNAL_ERROR'
  | 'txNOT_SUPPORTED'
  | 'txBAD_SPONSORSHIP'
  | 'txBAD_MIN_SEQ_AGE_OR_GAP'
  | 'txMALFORMED';

/**
 * Result of one operation. `code` is readable: the inner code (for example
 * "PAYMENT_UNDERFUNDED") when `outer` is opINNER, otherwise the outer code
 * (for example "opBAD_AUTH").
 */
export interface OpResult {
  outer: OuterOpCode;
  code: string;
  success: boolean;
  /** XDR value of the inner result arm when that arm carries data (for example AccountMergeResult's balance). */
  value?: unknown;
}

/** Inner result (opINNER). Success when the code ends with "_SUCCESS". */
export function opInner(code: string, value?: unknown): OpResult {
  return { outer: 'opINNER', code, success: code.endsWith('_SUCCESS'), value };
}

/** Outer failure result (opBAD_AUTH, opNO_ACCOUNT, ...). */
export function opOuter(code: Exclude<OuterOpCode, 'opINNER'>): OpResult {
  return { outer: code, code, success: false };
}

// ---------------------------------------------------------------- names

/** "PAYMENT_UNDERFUNDED" -> "paymentUnderfunded", "txBAD_SEQ" -> "txBadSeq". */
export function toXdrEnumName(readable: string): string {
  let prefix = '';
  let rest = readable;
  const m = /^(tx|op)([A-Z].*)$/.exec(readable);
  if (m) {
    prefix = m[1];
    rest = m[2];
  }
  const parts = rest.toLowerCase().split('_').filter(Boolean);
  const camel = parts.map((p, i) => (i === 0 && !prefix ? p : p[0].toUpperCase() + p.slice(1))).join('');
  return prefix + camel;
}

/** "paymentUnderfunded" -> "PAYMENT_UNDERFUNDED", "txBadSeq" -> "txBAD_SEQ". */
export function fromXdrEnumName(name: string): string {
  let prefix = '';
  let rest = name;
  const m = /^(tx|op)([A-Z].*)$/.exec(name);
  if (m) {
    prefix = m[1];
    rest = m[2];
  }
  const snake = rest.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  return prefix + snake;
}

// ---------------------------------------------------------------- operation types

/** OperationType name -> its result union (xdr class name). */
export const OP_RESULT_TYPES: Record<string, string> = {
  createAccount: 'CreateAccountResult',
  payment: 'PaymentResult',
  pathPaymentStrictReceive: 'PathPaymentStrictReceiveResult',
  manageSellOffer: 'ManageSellOfferResult',
  createPassiveSellOffer: 'ManageSellOfferResult',
  setOptions: 'SetOptionsResult',
  changeTrust: 'ChangeTrustResult',
  allowTrust: 'AllowTrustResult',
  accountMerge: 'AccountMergeResult',
  inflation: 'InflationResult',
  manageData: 'ManageDataResult',
  bumpSequence: 'BumpSequenceResult',
  manageBuyOffer: 'ManageBuyOfferResult',
  pathPaymentStrictSend: 'PathPaymentStrictSendResult',
  createClaimableBalance: 'CreateClaimableBalanceResult',
  claimClaimableBalance: 'ClaimClaimableBalanceResult',
  beginSponsoringFutureReserves: 'BeginSponsoringFutureReservesResult',
  endSponsoringFutureReserves: 'EndSponsoringFutureReservesResult',
  revokeSponsorship: 'RevokeSponsorshipResult',
  clawback: 'ClawbackResult',
  clawbackClaimableBalance: 'ClawbackClaimableBalanceResult',
  setTrustLineFlags: 'SetTrustLineFlagsResult',
  liquidityPoolDeposit: 'LiquidityPoolDepositResult',
  liquidityPoolWithdraw: 'LiquidityPoolWithdrawResult',
  invokeHostFunction: 'InvokeHostFunctionResult',
  extendFootprintTtl: 'ExtendFootprintTtlResult',
  restoreFootprint: 'RestoreFootprintResult',
};

/** Prefix of the inner result codes of an operation type, e.g. "PAYMENT". */
export function opCodePrefix(opType: string): string {
  switch (opType) {
    case 'createPassiveSellOffer':
      return 'MANAGE_SELL_OFFER';
    case 'bumpSequence':
      return 'BUMP_SEQUENCE';
    case 'extendFootprintTtl':
      return 'EXTEND_FOOTPRINT_TTL';
    default:
      return fromXdrEnumName(opType);
  }
}

/**
 * Result union classes by name. Static references (not xdr[name]) keep the
 * xdr namespace tree-shakable: a dynamic lookup makes the bundler keep every
 * generated XDR type.
 */
const RESULT_UNIONS: Record<string, object> = {
  CreateAccountResult: xdr.CreateAccountResult,
  PaymentResult: xdr.PaymentResult,
  PathPaymentStrictReceiveResult: xdr.PathPaymentStrictReceiveResult,
  ManageSellOfferResult: xdr.ManageSellOfferResult,
  SetOptionsResult: xdr.SetOptionsResult,
  ChangeTrustResult: xdr.ChangeTrustResult,
  AllowTrustResult: xdr.AllowTrustResult,
  AccountMergeResult: xdr.AccountMergeResult,
  InflationResult: xdr.InflationResult,
  ManageDataResult: xdr.ManageDataResult,
  BumpSequenceResult: xdr.BumpSequenceResult,
  ManageBuyOfferResult: xdr.ManageBuyOfferResult,
  PathPaymentStrictSendResult: xdr.PathPaymentStrictSendResult,
  CreateClaimableBalanceResult: xdr.CreateClaimableBalanceResult,
  ClaimClaimableBalanceResult: xdr.ClaimClaimableBalanceResult,
  BeginSponsoringFutureReservesResult: xdr.BeginSponsoringFutureReservesResult,
  EndSponsoringFutureReservesResult: xdr.EndSponsoringFutureReservesResult,
  RevokeSponsorshipResult: xdr.RevokeSponsorshipResult,
  ClawbackResult: xdr.ClawbackResult,
  ClawbackClaimableBalanceResult: xdr.ClawbackClaimableBalanceResult,
  SetTrustLineFlagsResult: xdr.SetTrustLineFlagsResult,
  LiquidityPoolDepositResult: xdr.LiquidityPoolDepositResult,
  LiquidityPoolWithdrawResult: xdr.LiquidityPoolWithdrawResult,
  InvokeHostFunctionResult: xdr.InvokeHostFunctionResult,
  ExtendFootprintTtlResult: xdr.ExtendFootprintTtlResult,
  RestoreFootprintResult: xdr.RestoreFootprintResult,
  OperationResult: xdr.OperationResult,
  OperationResultTr: xdr.OperationResultTr,
  TransactionResultResult: xdr.TransactionResultResult,
};

/** A static arm factory of a generated XDR union, looked up by name. */
type ArmFactory = (value?: unknown) => unknown;

/**
 * Build an XDR union value from its class name and arm name, e.g.
 * ("PaymentResult", "paymentUnderfunded"). Every result union names all its
 * arms (no default arm), so each code has a static factory.
 */
function unionArm<T>(unionName: string, armName: string, value?: unknown): T {
  const union = RESULT_UNIONS[unionName] as Record<string, unknown> | undefined;
  const factory = union?.[armName];
  if (typeof factory !== 'function') throw new Error(`unknown XDR arm ${unionName}.${armName}`);
  return (factory as ArmFactory).call(union, value) as T;
}

const zero32 = (): Uint8Array => new Uint8Array(32);

/**
 * stellar-core initializes every operation result to its success arm with a
 * default value; operations that were never applied keep that placeholder.
 */
export function defaultOpResult(opType: string): OpResult {
  const code = `${opCodePrefix(opType)}_SUCCESS`;
  switch (opType) {
    case 'accountMerge':
      return { outer: 'opINNER', code, success: true, value: int64(0n) };
    case 'createClaimableBalance':
      return { outer: 'opINNER', code, success: true, value: xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(zero32()) };
    case 'manageSellOffer':
    case 'manageBuyOffer':
    case 'createPassiveSellOffer':
      return {
        outer: 'opINNER',
        code,
        success: true,
        value: new xdr.ManageOfferSuccessResult({
          offersClaimed: [],
          offer: xdr.ManageOfferSuccessResultOffer.manageOfferDeleted(),
        }),
      };
    case 'pathPaymentStrictReceive':
    case 'pathPaymentStrictSend': {
      const fields = {
        offers: [],
        last: new xdr.SimplePaymentResult({
          destination: xdr.PublicKey.publicKeyTypeEd25519(zero32()),
          asset: xdr.Asset.assetTypeNative(),
          amount: int64(0n),
        }),
      };
      const value =
        opType === 'pathPaymentStrictSend'
          ? new xdr.PathPaymentStrictSendResultSuccess(fields)
          : new xdr.PathPaymentStrictReceiveResultSuccess(fields);
      return { outer: 'opINNER', code, success: true, value };
    }
    case 'inflation':
      return { outer: 'opINNER', code, success: true, value: [] };
    case 'invokeHostFunction':
      return { outer: 'opINNER', code, success: true, value: zero32() };
    default:
      return { outer: 'opINNER', code, success: true };
  }
}

/** Build xdr.OperationResult for an operation of type `opType`. */
export function opResultToXdr(opType: string, r: OpResult): xdr.OperationResult {
  if (r.outer !== 'opINNER') return unionArm<xdr.OperationResult>('OperationResult', toXdrEnumName(r.outer));
  const unionName = OP_RESULT_TYPES[opType];
  if (!unionName) throw new Error(`unknown operation type ${opType}`);
  const inner = unionArm<unknown>(unionName, toXdrEnumName(r.code), r.value);
  const tr = unionArm<xdr.OperationResultTr>('OperationResultTr', opType, inner);
  return xdr.OperationResult.opInner(tr);
}

/** Build xdr.TransactionResult. Operation results are kept for txSUCCESS and txFAILED only. */
export function txResultToXdr(
  feeCharged: bigint,
  code: TxCode,
  opTypes: string[],
  opResults: OpResult[] | null,
): xdr.TransactionResult {
  let result: xdr.TransactionResultResult;
  if (code === 'txSUCCESS' || code === 'txFAILED') {
    const ops = (opResults ?? []).map((r, i) => opResultToXdr(opTypes[i], r));
    result = code === 'txSUCCESS' ? xdr.TransactionResultResult.txSuccess(ops) : xdr.TransactionResultResult.txFailed(ops);
  } else {
    result = unionArm<xdr.TransactionResultResult>('TransactionResultResult', toXdrEnumName(code));
  }
  return new xdr.TransactionResult({ feeCharged: int64(feeCharged), result, ext: xdr.TransactionResultExt.v0() });
}

/** Readable code of an xdr.OperationResult ("PAYMENT_SUCCESS", "opBAD_AUTH"). */
export function opResultCode(r: xdr.OperationResult): string {
  if (r.type !== 'opInner') return fromXdrEnumName(r.type);
  return fromXdrEnumName(r.tr.value.type);
}

/** Readable code of an xdr.TransactionResult ("txSUCCESS", "txBAD_SEQ"). */
export function txResultCode(r: xdr.TransactionResult): string {
  return fromXdrEnumName(r.result.type);
}
