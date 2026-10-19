// Human-oriented views of transactions for the UI and history indexes
// (docs/ARCHITECTURE.md 7.6).

import { xdr } from '@stellar/stellar-sdk/base';
import { fromBase64, toBase64, toHex } from '../lib/bytes';
import { formatAmount } from '../lib/amount';
import { opResultCode, txResultCode } from './results';
import type { OperationSummary, TxApplyResult } from './types';
import {
  accountIdToString,
  assetCodeToString,
  assetLabelFromXdr,
  balanceIdToHex,
  muxedToAccountId,
  muxedToAddress,
  signerKeyToString,
  xdrStringToText,
  xdrStringToUtf8,
} from './xdrutil';

type Details = OperationSummary['details'];

interface EnvelopeView {
  sourceAddress: string;
  sourceId: string;
  memo: xdr.Memo;
  operations: xdr.Operation[];
  fee: bigint;
}

function toEnvelope(envelope: string | xdr.TransactionEnvelope): xdr.TransactionEnvelope {
  return typeof envelope === 'string' ? xdr.TransactionEnvelope.fromXdr(fromBase64(envelope)) : envelope;
}

function toResult(result: string | xdr.TransactionResult | null | undefined): xdr.TransactionResult | null {
  if (result == null) return null;
  return typeof result === 'string' ? xdr.TransactionResult.fromXdr(fromBase64(result)) : result;
}

function envelopeView(env: xdr.TransactionEnvelope): EnvelopeView {
  switch (env.type) {
    case 'envelopeTypeTx': {
      const t = env.v1.tx;
      return {
        sourceAddress: muxedToAddress(t.sourceAccount),
        sourceId: muxedToAccountId(t.sourceAccount),
        memo: t.memo,
        operations: t.operations,
        fee: BigInt(t.fee),
      };
    }
    case 'envelopeTypeTxV0': {
      const t = env.v0.tx;
      const src = muxedToAccountId(xdr.MuxedAccount.keyTypeEd25519(t.sourceAccountEd25519));
      return { sourceAddress: src, sourceId: src, memo: t.memo, operations: t.operations, fee: BigInt(t.fee) };
    }
    case 'envelopeTypeTxFeeBump': {
      const fb = env.feeBump.tx;
      const t = fb.innerTx.v1.tx;
      return {
        sourceAddress: muxedToAddress(t.sourceAccount),
        sourceId: muxedToAccountId(t.sourceAccount),
        memo: t.memo,
        operations: t.operations,
        fee: fb.fee,
      };
    }
    default:
      throw new Error('unknown envelope type');
  }
}

/** Memo of a transaction envelope. */
export function extractMemo(envelope: string | xdr.TransactionEnvelope): TxApplyResult['memo'] {
  const memo = envelopeView(toEnvelope(envelope)).memo;
  switch (memo.type) {
    case 'memoText':
      return { type: 'text', value: xdrStringToUtf8(memo.text) };
    case 'memoId':
      return { type: 'id', value: memo.id.toString() };
    case 'memoHash':
      return { type: 'hash', value: toHex(memo.hash.value) };
    case 'memoReturn':
      return { type: 'return', value: toHex(memo.retHash.value) };
    default:
      return { type: 'none', value: null };
  }
}

/** Price n/d as a 7-decimal string. */
export function formatPrice(n: number, d: number): string {
  if (d === 0) return '0';
  return formatAmount((BigInt(n) * 10_000_000n) / BigInt(d));
}

function amount(v: bigint): string {
  return formatAmount(v);
}

function pathLabel(path: xdr.Asset[]): string {
  return path.map((a) => assetLabelFromXdr(a)).join(' -> ');
}

/**
 * Amount of the send asset that a successful strict receive path payment
 * took from its source. The claim atoms are in path order and every hop
 * crosses at least one offer, so the first hop is the leading run of atoms
 * that trade one asset pair. Without atoms nothing was converted.
 */
function strictReceiveAmountSent(o: xdr.PathPaymentStrictReceiveOp, atoms: xdr.ClaimAtom[]): bigint | null {
  if (atoms.length === 0) return o.destAmount;
  const pairOf = (a: xdr.ClaimAtom): [string, string, bigint] | null =>
    a.type === 'claimAtomTypeOrderBook'
      ? [assetLabelFromXdr(a.orderBook.assetSold), assetLabelFromXdr(a.orderBook.assetBought), a.orderBook.amountBought]
      : null;
  const first = pairOf(atoms[0]);
  if (!first || first[1] !== assetLabelFromXdr(o.sendAsset)) return null;
  let sent = 0n;
  for (const a of atoms) {
    const p = pairOf(a);
    if (!p || p[0] !== first[0] || p[1] !== first[1]) break;
    sent += p[2];
  }
  return sent;
}

function claimAtomSellers(atoms: xdr.ClaimAtom[]): string[] {
  const out: string[] = [];
  for (const a of atoms) {
    if (a.type === 'claimAtomTypeOrderBook') out.push(accountIdToString(a.orderBook.sellerId));
    else if (a.type === 'claimAtomTypeV0') out.push(accountIdToString(xdr.PublicKey.publicKeyTypeEd25519(a.v0.sellerEd25519)));
  }
  return out;
}

/**
 * The data of a successful inner result (the success arm of the operation's
 * result union, for example a ManageOfferSuccessResult), or null when the
 * operation did not succeed or the result belongs to another operation type.
 */
function successOf(r: xdr.OperationResult | undefined, opType: xdr.OperationBody['type']): unknown {
  if (!r || r.type !== 'opInner') return null;
  const tr = r.tr;
  if (tr.type !== opType || !/Success$/.test(tr.value.type)) return null;
  return tr.value.value;
}

/** Per-operation details; also returns the accounts each operation touches. */
function describeOp(op: xdr.Operation, sourceAddress: string, result: xdr.OperationResult | undefined): { details: Details; accounts: string[] } {
  const body = op.body;
  const success = successOf(result, body.type);
  const accounts: string[] = [];
  const d: Details = {};
  switch (body.type) {
    case 'createAccount': {
      const o = body.createAccountOp;
      d.destination = accountIdToString(o.destination);
      d.startingBalance = amount(o.startingBalance);
      accounts.push(d.destination);
      break;
    }
    case 'payment': {
      const o = body.paymentOp;
      d.from = sourceAddress;
      d.to = muxedToAddress(o.destination);
      d.asset = assetLabelFromXdr(o.asset);
      d.amount = amount(o.amount);
      accounts.push(muxedToAccountId(o.destination));
      break;
    }
    case 'pathPaymentStrictReceive': {
      const o = body.pathPaymentStrictReceiveOp;
      d.from = sourceAddress;
      d.to = muxedToAddress(o.destination);
      d.sendAsset = assetLabelFromXdr(o.sendAsset);
      d.sendMax = amount(o.sendMax);
      d.destAsset = assetLabelFromXdr(o.destAsset);
      d.destAmount = amount(o.destAmount);
      d.path = pathLabel(o.path);
      accounts.push(muxedToAccountId(o.destination));
      if (success instanceof xdr.PathPaymentStrictReceiveResultSuccess) {
        const sent = strictReceiveAmountSent(o, success.offers);
        if (sent !== null) d.sendAmountSent = amount(sent);
        accounts.push(...claimAtomSellers(success.offers));
      }
      break;
    }
    case 'pathPaymentStrictSend': {
      const o = body.pathPaymentStrictSendOp;
      d.from = sourceAddress;
      d.to = muxedToAddress(o.destination);
      d.sendAsset = assetLabelFromXdr(o.sendAsset);
      d.sendAmount = amount(o.sendAmount);
      d.destAsset = assetLabelFromXdr(o.destAsset);
      d.destMin = amount(o.destMin);
      d.path = pathLabel(o.path);
      accounts.push(muxedToAccountId(o.destination));
      if (success instanceof xdr.PathPaymentStrictSendResultSuccess) {
        d.destAmountReceived = amount(success.last.amount);
        accounts.push(...claimAtomSellers(success.offers));
      }
      break;
    }
    case 'manageSellOffer':
    case 'createPassiveSellOffer': {
      const o = body.type === 'manageSellOffer' ? body.manageSellOfferOp : body.createPassiveSellOfferOp;
      d.selling = assetLabelFromXdr(o.selling);
      d.buying = assetLabelFromXdr(o.buying);
      d.amount = amount(o.amount);
      d.price = formatPrice(o.price.n, o.price.d);
      d.priceN = o.price.n;
      d.priceD = o.price.d;
      if (body.type === 'manageSellOffer') d.offerId = body.manageSellOfferOp.offerId.toString();
      if (success instanceof xdr.ManageOfferSuccessResult) {
        if (success.offer.type === 'manageOfferCreated') d.createdOfferId = success.offer.offer.offerId.toString();
        accounts.push(...claimAtomSellers(success.offersClaimed));
      }
      break;
    }
    case 'manageBuyOffer': {
      const o = body.manageBuyOfferOp;
      d.selling = assetLabelFromXdr(o.selling);
      d.buying = assetLabelFromXdr(o.buying);
      d.buyAmount = amount(o.buyAmount);
      d.price = formatPrice(o.price.n, o.price.d);
      d.priceN = o.price.n;
      d.priceD = o.price.d;
      d.offerId = o.offerId.toString();
      if (success instanceof xdr.ManageOfferSuccessResult) {
        if (success.offer.type === 'manageOfferCreated') d.createdOfferId = success.offer.offer.offerId.toString();
        accounts.push(...claimAtomSellers(success.offersClaimed));
      }
      break;
    }
    case 'setOptions': {
      const o = body.setOptionsOp;
      const inf = o.inflationDest;
      if (inf != null) d.inflationDest = accountIdToString(inf);
      if (o.clearFlags != null) d.clearFlags = o.clearFlags;
      if (o.setFlags != null) d.setFlags = o.setFlags;
      if (o.masterWeight != null) d.masterWeight = o.masterWeight;
      if (o.lowThreshold != null) d.lowThreshold = o.lowThreshold;
      if (o.medThreshold != null) d.medThreshold = o.medThreshold;
      if (o.highThreshold != null) d.highThreshold = o.highThreshold;
      if (o.homeDomain != null) d.homeDomain = xdrStringToText(o.homeDomain);
      const signer = o.signer;
      if (signer != null) {
        d.signerKey = signerKeyToString(signer.key);
        d.signerWeight = signer.weight;
      }
      break;
    }
    case 'changeTrust': {
      const o = body.changeTrustOp;
      d.asset = assetLabelFromXdr(o.line);
      d.limit = amount(o.limit);
      break;
    }
    case 'allowTrust': {
      const o = body.allowTrustOp;
      d.trustor = accountIdToString(o.trustor);
      const code = o.asset;
      d.assetCode = assetCodeToString(code.type === 'assetTypeCreditAlphanum4' ? code.assetCode4.value : code.assetCode12.value);
      d.authorize = o.authorize;
      accounts.push(d.trustor);
      break;
    }
    case 'accountMerge': {
      d.destination = muxedToAddress(body.destination);
      accounts.push(muxedToAccountId(body.destination));
      if (typeof success === 'bigint') d.amount = amount(success);
      break;
    }
    case 'manageData': {
      const o = body.manageDataOp;
      d.name = xdrStringToText(o.dataName);
      const v = o.dataValue;
      d.value = v == null ? null : toBase64(v.value);
      break;
    }
    case 'bumpSequence':
      d.bumpTo = body.bumpSequenceOp.bumpTo.toString();
      break;
    case 'createClaimableBalance': {
      const o = body.createClaimableBalanceOp;
      d.asset = assetLabelFromXdr(o.asset);
      d.amount = amount(o.amount);
      const dests = o.claimants.map((c) => accountIdToString(c.v0.destination));
      d.claimants = dests.join(',');
      accounts.push(...dests);
      if (xdr.ClaimableBalanceId.is(success)) d.balanceId = balanceIdToHex(success);
      break;
    }
    case 'claimClaimableBalance':
      d.balanceId = balanceIdToHex(body.claimClaimableBalanceOp.balanceId);
      break;
    case 'clawbackClaimableBalance':
      d.balanceId = balanceIdToHex(body.clawbackClaimableBalanceOp.balanceId);
      break;
    case 'clawback': {
      const o = body.clawbackOp;
      d.from = muxedToAddress(o.from);
      d.asset = assetLabelFromXdr(o.asset);
      d.amount = amount(o.amount);
      accounts.push(muxedToAccountId(o.from));
      break;
    }
    case 'setTrustLineFlags': {
      const o = body.setTrustLineFlagsOp;
      d.trustor = accountIdToString(o.trustor);
      d.asset = assetLabelFromXdr(o.asset);
      d.setFlags = o.setFlags;
      d.clearFlags = o.clearFlags;
      accounts.push(d.trustor);
      break;
    }
    case 'beginSponsoringFutureReserves':
      d.sponsoredId = accountIdToString(body.beginSponsoringFutureReservesOp.sponsoredId);
      break;
    default:
      break;
  }
  return { details: d, accounts };
}

/** Operation results of a txSUCCESS or txFAILED result, else null. */
function operationResults(res: xdr.TransactionResult | null): xdr.OperationResult[] | null {
  if (!res) return null;
  const r = res.result;
  return r.type === 'txSuccess' || r.type === 'txFailed' ? r.results : null;
}

/**
 * Operation summaries of a transaction. `result` is the xdr.TransactionResult
 * (object or base64); when it carries no operation results (the transaction
 * failed before its operations ran), each operation gets the transaction code.
 */
export function summarizeOperations(
  envelope: string | xdr.TransactionEnvelope,
  result?: string | xdr.TransactionResult | null,
): OperationSummary[] {
  const view = envelopeView(toEnvelope(envelope));
  const res = toResult(result);
  const opResults = operationResults(res);
  const txCode = res ? txResultCode(res) : '';
  return view.operations.map((op, index) => {
    const src = op.sourceAccount;
    const sourceAddress = src != null ? muxedToAddress(src) : view.sourceAddress;
    const r = opResults ? opResults[index] : undefined;
    return {
      index,
      type: op.body.type,
      sourceAccount: sourceAddress,
      resultCode: r ? opResultCode(r) : txCode,
      details: describeOp(op, sourceAddress, r).details,
    };
  });
}

/** Every account a transaction touches (source, operation sources, destinations, counterparties). */
export function touchedAccounts(
  envelope: string | xdr.TransactionEnvelope,
  result?: string | xdr.TransactionResult | null,
): string[] {
  const view = envelopeView(toEnvelope(envelope));
  const opResults = operationResults(toResult(result));
  const seen = new Set<string>([view.sourceId]);
  view.operations.forEach((op, index) => {
    const src = op.sourceAccount;
    if (src != null) seen.add(muxedToAccountId(src));
    const sourceAddress = src != null ? muxedToAddress(src) : view.sourceAddress;
    for (const a of describeOp(op, sourceAddress, opResults ? opResults[index] : undefined).accounts) seen.add(a);
  });
  return [...seen];
}

/** Source account (G...), fee bid and readable result of a transaction. */
export function describeTransaction(
  envelope: string | xdr.TransactionEnvelope,
  result?: string | xdr.TransactionResult | null,
): {
  sourceAccount: string;
  maxFee: bigint;
  feeCharged: bigint | null;
  resultCode: string | null;
  successful: boolean;
  memo: TxApplyResult['memo'];
  operations: OperationSummary[];
  accounts: string[];
} {
  const env = toEnvelope(envelope);
  const view = envelopeView(env);
  const res = toResult(result);
  const resultCode = res ? txResultCode(res) : null;
  return {
    sourceAccount: view.sourceId,
    maxFee: view.fee,
    feeCharged: res ? res.feeCharged : null,
    resultCode,
    successful: resultCode === 'txSUCCESS',
    memo: extractMemo(env),
    operations: summarizeOperations(env, res),
    accounts: touchedAccounts(env, res),
  };
}
