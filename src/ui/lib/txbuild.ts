// Build and sign classic transactions with @stellar/stellar-sdk/base for the
// wallet and the lab. Everything returns SDK objects or base64 XDR.

import {
  Account,
  Asset,
  Claimant,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Operation,
  StrKey,
  TimeoutInfinite,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import type { AssetView } from '../../node/api';
import { parseAmount } from '../../lib/amount';
import { toHex } from '../../lib/bytes';

export const BASE_FEE_STROOPS = 100;
export const MAX_OPS_PER_TX = 100;

export type MemoInput =
  | { type: 'none' }
  | { type: 'text'; value: string }
  | { type: 'id'; value: string }
  | { type: 'hash'; value: string }
  | { type: 'return'; value: string };

export type MemoType = MemoInput['type'];

const UINT64_MAX = (1n << 64n) - 1n;

export function makeMemo(m: MemoInput): Memo {
  switch (m.type) {
    case 'none':
      return Memo.none();
    case 'text': {
      const bytes = new TextEncoder().encode(m.value).length;
      if (bytes > 28) throw new Error(`Memo text is ${bytes} bytes; the limit is 28.`);
      return Memo.text(m.value);
    }
    case 'id': {
      const v = m.value.trim();
      if (!/^\d{1,20}$/.test(v) || BigInt(v) > UINT64_MAX) throw new Error('Memo id must be an unsigned 64-bit integer.');
      return Memo.id(v);
    }
    case 'hash':
    case 'return': {
      const v = m.value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(v)) throw new Error('Memo hash must be 64 hex characters.');
      return m.type === 'hash' ? Memo.hash(v) : Memo.return(v);
    }
  }
}

/** Memo input from loose form fields; empty value means no memo. */
export function memoFromFields(type: MemoType, value: string): MemoInput {
  if (type === 'none' || value.trim() === '') return { type: 'none' };
  return { type, value } as MemoInput;
}

export function toSdkAsset(a: AssetView): Asset {
  if (a.type === 'native') return Asset.native();
  if (!a.issuer) throw new Error(`Asset ${a.code} has no issuer.`);
  return new Asset(a.code, a.issuer);
}

export function fromSdkAsset(a: Asset): AssetView {
  if (a.isNative()) return { type: 'native', code: 'XLM' };
  const code = a.getCode();
  return { type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code, issuer: a.getIssuer() };
}

/** Check and normalize an amount ("12.5" -> "12.5"). Throws a readable error. */
export function checkAmount(text: string, what = 'Amount', { allowZero = false } = {}): string {
  const t = text.trim();
  if (!t) throw new Error(`${what} is required.`);
  let v: bigint;
  try {
    v = parseAmount(t);
  } catch {
    throw new Error(`${what} must be a number with at most 7 decimals.`);
  }
  if (v < 0n) throw new Error(`${what} cannot be negative.`);
  if (v === 0n && !allowZero) throw new Error(`${what} must be greater than zero.`);
  return t;
}

/** Check a positive decimal price ("0.25"); rounds to 7 decimals (prices are int32 fractions). */
export function checkPrice(text: string): string {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t) || !(Number(t) > 0)) throw new Error('Price must be a positive number.');
  const v = Number(t);
  if (v > 2_147_483_647) throw new Error('Price is too large.');
  const normalized = v.toFixed(7).replace(/\.?0+$/, '');
  if (normalized === '0' || normalized === '') throw new Error('Price is too small (minimum 0.0000001).');
  return normalized;
}

export function checkAccountId(id: string, what = 'Account'): string {
  const t = id.trim();
  if (!StrKey.isValidEd25519PublicKey(t)) throw new Error(`${what} must be a valid G… account id.`);
  return t;
}

export function checkAssetCode(code: string): string {
  const t = code.trim();
  if (!/^[a-zA-Z0-9]{1,12}$/.test(t)) throw new Error('Asset code must be 1-12 letters or digits.');
  return t;
}

export interface TxParams {
  /** Source account (G...). */
  source: string;
  /** The account's CURRENT sequence number; the tx uses sequence + 1. */
  sequence: string;
  networkPassphrase: string;
  /** Max fee per operation in stroops. Default 100. */
  feePerOp?: number;
  memo?: MemoInput;
  /** Unix seconds; omitted = no time bounds. */
  timeBounds?: { minTime: number; maxTime: number };
}

export function buildTx(params: TxParams, ops: xdr.Operation[]): Transaction {
  if (ops.length === 0) throw new Error('Add at least one operation.');
  if (ops.length > MAX_OPS_PER_TX) throw new Error(`At most ${MAX_OPS_PER_TX} operations per transaction.`);
  checkAccountId(params.source, 'Source account');
  if (!/^\d+$/.test(params.sequence)) throw new Error('Sequence number must be a non-negative integer.');
  const fee = params.feePerOp ?? BASE_FEE_STROOPS;
  if (!Number.isInteger(fee) || fee < BASE_FEE_STROOPS) throw new Error(`Fee must be at least ${BASE_FEE_STROOPS} stroops per operation.`);
  const builder = new TransactionBuilder(new Account(params.source, params.sequence), {
    fee: String(fee),
    networkPassphrase: params.networkPassphrase,
    memo: makeMemo(params.memo ?? { type: 'none' }),
    timebounds: params.timeBounds
      ? { minTime: String(params.timeBounds.minTime), maxTime: String(params.timeBounds.maxTime) }
      : undefined,
  });
  for (const op of ops) builder.addOperation(op);
  if (!params.timeBounds) builder.setTimeout(TimeoutInfinite);
  return builder.build();
}

// ---------------------------------------------------------------- operations

export function paymentOp(p: { destination: string; asset: AssetView; amount: string; source?: string }): xdr.Operation {
  return Operation.payment({
    destination: checkAccountId(p.destination, 'Destination'),
    asset: toSdkAsset(p.asset),
    amount: checkAmount(p.amount),
    source: p.source,
  });
}

export function createAccountOp(p: { destination: string; startingBalance: string; source?: string }): xdr.Operation {
  return Operation.createAccount({
    destination: checkAccountId(p.destination, 'Destination'),
    startingBalance: checkAmount(p.startingBalance, 'Starting balance'),
    source: p.source,
  });
}

/** Add or update a trustline; limit "0" removes it. No limit = maximum. */
export function changeTrustOp(p: { asset: AssetView; limit?: string; source?: string }): xdr.Operation {
  if (p.asset.type === 'native') throw new Error('XLM needs no trustline.');
  return Operation.changeTrust({
    asset: toSdkAsset(p.asset),
    limit: p.limit === undefined || p.limit.trim() === '' ? undefined : checkAmount(p.limit, 'Limit', { allowZero: true }),
    source: p.source,
  });
}

export function manageSellOfferOp(p: {
  selling: AssetView;
  buying: AssetView;
  amount: string;
  price: string;
  offerId?: string;
  source?: string;
}): xdr.Operation {
  return Operation.manageSellOffer({
    selling: toSdkAsset(p.selling),
    buying: toSdkAsset(p.buying),
    amount: checkAmount(p.amount, 'Amount', { allowZero: p.offerId !== undefined && p.offerId !== '0' }),
    price: checkPrice(p.price),
    offerId: p.offerId ?? '0',
    source: p.source,
  });
}

export function manageBuyOfferOp(p: {
  selling: AssetView;
  buying: AssetView;
  buyAmount: string;
  price: string;
  offerId?: string;
  source?: string;
}): xdr.Operation {
  return Operation.manageBuyOffer({
    selling: toSdkAsset(p.selling),
    buying: toSdkAsset(p.buying),
    buyAmount: checkAmount(p.buyAmount, 'Amount', { allowZero: p.offerId !== undefined && p.offerId !== '0' }),
    price: checkPrice(p.price),
    offerId: p.offerId ?? '0',
    source: p.source,
  });
}

/** Delete an existing offer (ManageSellOffer with amount 0). */
export function cancelOfferOp(p: { selling: AssetView; buying: AssetView; offerId: string; price?: string }): xdr.Operation {
  if (!/^\d+$/.test(p.offerId) || p.offerId === '0') throw new Error('Offer id is required to cancel an offer.');
  return Operation.manageSellOffer({
    selling: toSdkAsset(p.selling),
    buying: toSdkAsset(p.buying),
    amount: '0',
    price: p.price && Number(p.price) > 0 ? p.price : '1',
    offerId: p.offerId,
  });
}

export type ClaimPredicateInput =
  | { type: 'unconditional' }
  /** Claimable only within `seconds` after creation. */
  | { type: 'beforeRelative'; seconds: number }
  /** Claimable only after `seconds` have passed since creation. */
  | { type: 'afterRelative'; seconds: number };

export function makePredicate(p: ClaimPredicateInput): xdr.ClaimPredicate {
  switch (p.type) {
    case 'unconditional':
      return Claimant.predicateUnconditional();
    case 'beforeRelative':
      if (!Number.isInteger(p.seconds) || p.seconds <= 0) throw new Error('Time window must be a positive number of seconds.');
      return Claimant.predicateBeforeRelativeTime(String(p.seconds));
    case 'afterRelative':
      if (!Number.isInteger(p.seconds) || p.seconds <= 0) throw new Error('Delay must be a positive number of seconds.');
      return Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(String(p.seconds)));
  }
}

export function createClaimableBalanceOp(p: {
  asset: AssetView;
  amount: string;
  claimants: { destination: string; predicate: ClaimPredicateInput }[];
  source?: string;
}): xdr.Operation {
  if (p.claimants.length === 0) throw new Error('Add at least one claimant.');
  if (p.claimants.length > 10) throw new Error('At most 10 claimants.');
  const seen = new Set<string>();
  const claimants = p.claimants.map((c) => {
    const d = checkAccountId(c.destination, 'Claimant');
    if (seen.has(d)) throw new Error('Each claimant can appear only once.');
    seen.add(d);
    return new Claimant(d, makePredicate(c.predicate));
  });
  return Operation.createClaimableBalance({ asset: toSdkAsset(p.asset), amount: checkAmount(p.amount), claimants, source: p.source });
}

/** Balance ids from the node are the 32-byte hash (64 hex); the SDK wants the full XDR id (72 hex). */
export function toSdkBalanceId(id: string): string {
  const t = id.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(t)) return `00000000${t}`;
  if (/^00000000[0-9a-f]{64}$/.test(t)) return t;
  throw new Error('Claimable balance id must be 64 or 72 hex characters.');
}

/** The 64-hex hash part of a balance id. */
export function shortBalanceId(id: string): string {
  const t = id.trim().toLowerCase();
  return t.length === 72 && t.startsWith('00000000') ? t.slice(8) : t;
}

export function claimClaimableBalanceOp(balanceId: string, source?: string): xdr.Operation {
  return Operation.claimClaimableBalance({ balanceId: toSdkBalanceId(balanceId), source });
}

export function manageDataOp(p: { name: string; value: string | null; source?: string }): xdr.Operation {
  const name = p.name.trim();
  if (!name || new TextEncoder().encode(name).length > 64) throw new Error('Data name must be 1-64 bytes.');
  if (p.value !== null && new TextEncoder().encode(p.value).length > 64) throw new Error('Data value must be at most 64 bytes.');
  return Operation.manageData({ name, value: p.value === null || p.value === '' ? null : p.value, source: p.source });
}

export function bumpSequenceOp(bumpTo: string, source?: string): xdr.Operation {
  if (!/^\d{1,19}$/.test(bumpTo.trim())) throw new Error('Bump target must be a sequence number.');
  return Operation.bumpSequence({ bumpTo: bumpTo.trim(), source });
}

export function setHomeDomainOp(homeDomain: string, source?: string): xdr.Operation {
  if (new TextEncoder().encode(homeDomain).length > 32) throw new Error('Home domain must be at most 32 bytes.');
  return Operation.setOptions({ homeDomain, source });
}

// ---------------------------------------------------------------- signing and decoding

export function decodeEnvelope(envelopeXdr: string, networkPassphrase: string): Transaction | FeeBumpTransaction {
  const t = envelopeXdr.trim();
  if (!t) throw new Error('Paste a base64 TransactionEnvelope.');
  try {
    return TransactionBuilder.fromXdr(t, networkPassphrase);
  } catch (err) {
    throw new Error(`Not a valid TransactionEnvelope: ${(err as Error).message}`);
  }
}

export function txHashHex(tx: Transaction | FeeBumpTransaction): string {
  return toHex(tx.hash());
}

export function envelopeXdr(tx: Transaction | FeeBumpTransaction): string {
  return tx.toEnvelope().toXdr('base64');
}

export function keypairFromSecret(secret: string): Keypair {
  const s = secret.trim();
  if (!StrKey.isValidEd25519SecretSeed(s)) throw new Error('Secret key must be a valid S… key.');
  return Keypair.fromSecret(s);
}

/** True when `publicKey` already has a valid signature on the tx. */
export function hasSignatureFrom(tx: Transaction | FeeBumpTransaction, publicKey: string): boolean {
  const kp = Keypair.fromPublicKey(publicKey);
  const hint = toHex(kp.signatureHint());
  const h = tx.hash();
  return tx.signatures.some((s) => toHex(s.hint.toBytes()) === hint && kp.verify(h, s.signature.toBytes()));
}

export interface SignResult {
  xdr: string;
  hash: string;
  /** False when this key had already signed. */
  added: boolean;
  signer: string;
}

export function signEnvelope(envelope: string, secret: string, networkPassphrase: string): SignResult {
  const tx = decodeEnvelope(envelope, networkPassphrase);
  const kp = keypairFromSecret(secret);
  const already = hasSignatureFrom(tx, kp.publicKey());
  if (!already) tx.sign(kp);
  return { xdr: envelopeXdr(tx), hash: txHashHex(tx), added: !already, signer: kp.publicKey() };
}

/** Sign a built tx with one or more secrets and return the envelope XDR. */
export function signTx(tx: Transaction, ...secrets: string[]): string {
  for (const s of secrets) tx.sign(keypairFromSecret(s));
  return envelopeXdr(tx);
}

export interface TxOverview {
  hash: string;
  kind: 'tx' | 'feeBump';
  source: string;
  sequence: string;
  fee: string;
  memo: { type: string; value: string | null };
  operations: { type: string; source: string | null }[];
  signatures: { hint: string }[];
  timeBounds: { minTime: string; maxTime: string } | null;
}

export function describeEnvelope(envelope: string, networkPassphrase: string): TxOverview {
  const tx = decodeEnvelope(envelope, networkPassphrase);
  const sigs = tx.signatures.map((s) => ({ hint: toHex(s.hint.toBytes()) }));
  if (tx instanceof FeeBumpTransaction) {
    return {
      hash: txHashHex(tx),
      kind: 'feeBump',
      source: tx.feeSource,
      sequence: tx.innerTransaction.sequence,
      fee: tx.fee,
      memo: memoView(tx.innerTransaction.memo),
      operations: tx.innerTransaction.operations.map((o) => ({ type: o.type, source: o.source ?? null })),
      signatures: sigs,
      timeBounds: tx.innerTransaction.timeBounds ?? null,
    };
  }
  return {
    hash: txHashHex(tx),
    kind: 'tx',
    source: tx.source,
    sequence: tx.sequence,
    fee: tx.fee,
    memo: memoView(tx.memo),
    operations: tx.operations.map((o) => ({ type: o.type, source: o.source ?? null })),
    signatures: sigs,
    timeBounds: tx.timeBounds ?? null,
  };
}

function memoView(m: Memo): { type: string; value: string | null } {
  if (m.type === 'none') return { type: 'none', value: null };
  const v = m.value;
  if (v === null || v === undefined) return { type: m.type, value: null };
  if (typeof v === 'string') return { type: m.type, value: v };
  return { type: m.type, value: m.type === 'text' ? new TextDecoder().decode(v) : toHex(v) };
}

/**
 * Next sequence to build on. `current` is the ledger's sequence; `lastUsed` is
 * the highest sequence this UI already submitted for the account (pending).
 * Returns the value to pass as TxParams.sequence.
 */
export function baseSequenceFor(current: string, lastUsed: string | null): string {
  const cur = BigInt(current);
  if (lastUsed === null) return cur.toString();
  const last = BigInt(lastUsed);
  return (last > cur ? last : cur).toString();
}
