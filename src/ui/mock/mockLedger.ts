// In-memory classic ledger for the mock node. It decodes real Stellar XDR,
// checks and applies the common operations with stellar-core result codes,
// and builds real TransactionResult XDR. It is a UI development tool, not a
// faithful ledger (no liabilities locking, simplified offer crossing).

import { Asset, FeeBumpTransaction, Keypair, StrKey, Transaction, TransactionBuilder, extractBaseAddress, xdr } from '@stellar/stellar-sdk/base';
import type {
  AccountView,
  AssetStatView,
  AssetView,
  BalanceLine,
  ClaimableBalanceView,
  OfferView,
  OperationView,
  OrderBookView,
} from '../../node/api';
import { formatAmount as stroopsToString, INT64_MAX } from '../../lib/amount';
import { fromHex, toBase64, toHex } from '../../lib/bytes';
import { BASE_FEE, BASE_RESERVE, TOTAL_COINS } from '../../lib/constants';

const RESERVE = BigInt(BASE_RESERVE);
const TL_AUTHORIZED = 0x1;
const AUTH_REQUIRED = 0x1;
const AUTH_REVOCABLE = 0x2;
const AUTH_IMMUTABLE = 0x4;
const AUTH_CLAWBACK = 0x8;

export interface MAccount {
  id: string;
  balance: bigint;
  seq: bigint;
  subEntries: number;
  numSponsoring: number;
  thresholds: { master: number; low: number; med: number; high: number };
  signers: { key: string; weight: number }[];
  flags: number;
  homeDomain: string;
  lastModified: number;
}

export interface MTrust {
  account: string;
  code: string;
  issuer: string;
  balance: bigint;
  limit: bigint;
  flags: number;
  lastModified: number;
}

export interface MOffer {
  id: bigint;
  seller: string;
  selling: AssetView;
  buying: AssetView;
  amount: bigint;
  /** Price of 1 selling in buying = n / d. */
  n: number;
  d: number;
  passive: boolean;
  lastModified: number;
}

export interface MData {
  account: string;
  name: string;
  value: Uint8Array;
  lastModified: number;
}

/** JSON-safe claim predicate (times are unix seconds as decimal strings). */
export type PredicateJson =
  | { type: 'unconditional' }
  | { type: 'and'; predicates: [PredicateJson, PredicateJson] }
  | { type: 'or'; predicates: [PredicateJson, PredicateJson] }
  | { type: 'not'; predicate: PredicateJson }
  | { type: 'beforeAbsoluteTime'; time: string };

export interface MClaimable {
  id: string; // 64 hex
  asset: AssetView;
  amount: bigint;
  sponsor: string;
  claimants: { destination: string; predicate: PredicateJson }[];
  lastModified: number;
}

export interface ParsedTx {
  tx: Transaction;
  hash: string;
  envelopeXdr: string;
  source: string;
  seq: bigint;
  maxFee: bigint;
  opCount: number;
}

export interface AppliedTx {
  parsed: ParsedTx;
  successful: boolean;
  resultCode: string;
  feeCharged: bigint;
  operations: OperationView[];
  resultXdr: string;
  accounts: string[];
}

export class TxRejected extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly hash = '',
  ) {
    super(detail);
  }
}

interface OpOutcome {
  ok: boolean;
  code: string;
  result: xdr.OperationResult;
  details: Record<string, string | number | boolean | null>;
}

interface StateSnap {
  accounts: Map<string, MAccount>;
  trust: Map<string, MTrust>;
  offers: Map<string, MOffer>;
  data: Map<string, MData>;
  claimables: Map<string, MClaimable>;
  idPool: bigint;
}

// ---------------------------------------------------------------- small helpers

export function assetFromSdk(a: Asset): AssetView {
  if (a.isNative()) return { type: 'native', code: 'XLM' };
  const code = a.getCode();
  return { type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code, issuer: a.getIssuer() };
}

export function assetToSdk(a: AssetView): Asset {
  return a.type === 'native' ? Asset.native() : new Asset(a.code, a.issuer!);
}

export function assetLabel(a: AssetView): string {
  return a.type === 'native' ? 'XLM' : `${a.code}:${a.issuer}`;
}

function sameAsset(a: AssetView, b: AssetView): boolean {
  return assetLabel(a) === assetLabel(b);
}

function trustKey(account: string, a: AssetView): string {
  return `${account}|${a.code}:${a.issuer}`;
}

function amountOf(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(s);
  if (!m) throw new Error(`bad amount ${s}`);
  return BigInt(m[1]) * 10_000_000n + BigInt((m[2] ?? '').padEnd(7, '0'));
}

export function priceString(n: number, d: number): string {
  if (d === 0) return '0';
  const v = n / d;
  const s = v >= 1e6 ? v.toFixed(2) : v.toFixed(7);
  return s.replace(/\.?0+$/, '') || '0';
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Exact sign of an/ad - bn/bd (int32 products can exceed 2^53). */
export function cmpFrac(an: number, ad: number, bn: number, bd: number): number {
  const x = BigInt(an) * BigInt(bd);
  const y = BigInt(bn) * BigInt(ad);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** "paymentUnderfunded" -> "PAYMENT_UNDERFUNDED"; "txBadSeq" -> "txBAD_SEQ"; "opNoAccount" -> "opNO_ACCOUNT". */
export function codeFromArm(arm: string): string {
  const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  const m = /^(tx|op)([A-Z].*)$/.exec(arm);
  if (m) return m[1] + snake(m[2]);
  return snake(arm);
}

type XdrFactory = Record<string, (...args: unknown[]) => unknown>;

/** Result union class of each operation type (static references keep the xdr namespace tree-shakable). */
const RESULT_UNION: Record<string, unknown> = {
  createAccount: xdr.CreateAccountResult,
  payment: xdr.PaymentResult,
  manageSellOffer: xdr.ManageSellOfferResult,
  createPassiveSellOffer: xdr.ManageSellOfferResult,
  manageBuyOffer: xdr.ManageBuyOfferResult,
  changeTrust: xdr.ChangeTrustResult,
  setOptions: xdr.SetOptionsResult,
  accountMerge: xdr.AccountMergeResult,
  manageData: xdr.ManageDataResult,
  bumpSequence: xdr.BumpSequenceResult,
  createClaimableBalance: xdr.CreateClaimableBalanceResult,
  claimClaimableBalance: xdr.ClaimClaimableBalanceResult,
};

function innerResult(opType: string, arm: string, value?: unknown): xdr.OperationResult {
  const union = RESULT_UNION[opType] as XdrFactory;
  const inner = value === undefined ? union[arm]() : union[arm](value);
  const tr = (xdr.OperationResultTr as unknown as XdrFactory)[opType](inner) as xdr.OperationResultTr;
  return xdr.OperationResult.opInner(tr);
}

function outcome(
  opType: string,
  ok: boolean,
  arm: string,
  details: OpOutcome['details'],
  value?: unknown,
): OpOutcome {
  return { ok, code: codeFromArm(arm), result: innerResult(opType, arm, value), details };
}

function predicateToJson(p: xdr.ClaimPredicate, closeTime: number): PredicateJson {
  switch (p.type) {
    case 'claimPredicateUnconditional':
      return { type: 'unconditional' };
    case 'claimPredicateAnd': {
      const [a, b] = p.andPredicates;
      return { type: 'and', predicates: [predicateToJson(a, closeTime), predicateToJson(b, closeTime)] };
    }
    case 'claimPredicateOr': {
      const [a, b] = p.orPredicates;
      return { type: 'or', predicates: [predicateToJson(a, closeTime), predicateToJson(b, closeTime)] };
    }
    case 'claimPredicateNot': {
      const inner = p.notPredicate;
      return { type: 'not', predicate: inner ? predicateToJson(inner, closeTime) : { type: 'unconditional' } };
    }
    case 'claimPredicateBeforeAbsoluteTime':
      return { type: 'beforeAbsoluteTime', time: p.absBefore.toString() };
    case 'claimPredicateBeforeRelativeTime': {
      const t = BigInt(closeTime) + p.relBefore;
      return { type: 'beforeAbsoluteTime', time: t.toString() };
    }
    default:
      return { type: 'unconditional' };
  }
}

export function predicateHolds(p: PredicateJson, closeTime: number): boolean {
  switch (p.type) {
    case 'unconditional':
      return true;
    case 'and':
      return predicateHolds(p.predicates[0], closeTime) && predicateHolds(p.predicates[1], closeTime);
    case 'or':
      return predicateHolds(p.predicates[0], closeTime) || predicateHolds(p.predicates[1], closeTime);
    case 'not':
      return !predicateHolds(p.predicate, closeTime);
    case 'beforeAbsoluteTime':
      return BigInt(closeTime) < BigInt(p.time);
  }
}

function accountIdXdr(id: string): xdr.PublicKey {
  return xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(id));
}

function opThresholdLevel(op: Transaction['operations'][number]): 'low' | 'med' | 'high' {
  switch (op.type) {
    case 'allowTrust':
    case 'setTrustLineFlags':
    case 'bumpSequence':
    case 'claimClaimableBalance':
      return 'low';
    case 'accountMerge':
      return 'high';
    case 'setOptions':
      return op.masterWeight !== undefined ||
        op.lowThreshold !== undefined ||
        op.medThreshold !== undefined ||
        op.highThreshold !== undefined ||
        op.signer !== undefined
        ? 'high'
        : 'med';
    default:
      return 'med';
  }
}

// ---------------------------------------------------------------- the ledger

export class MockLedger {
  accounts = new Map<string, MAccount>();
  trust = new Map<string, MTrust>();
  offers = new Map<string, MOffer>();
  data = new Map<string, MData>();
  claimables = new Map<string, MClaimable>();
  idPool = 0n;
  feePool = 0n;
  readonly totalCoins = TOTAL_COINS;

  constructor(readonly passphrase: string) {}

  // ------------------------------------------------------------ setup

  createAccountDirect(id: string, balance: bigint, ledgerSeq: number): MAccount {
    const acc: MAccount = {
      id,
      balance,
      seq: 0n,
      subEntries: 0,
      numSponsoring: 0,
      thresholds: { master: 1, low: 0, med: 0, high: 0 },
      signers: [],
      flags: 0,
      homeDomain: '',
      lastModified: ledgerSeq,
    };
    this.accounts.set(id, acc);
    return acc;
  }

  // ------------------------------------------------------------ balances

  minBalance(acc: MAccount): bigint {
    return BigInt(2 + acc.subEntries + acc.numSponsoring) * RESERVE;
  }

  sellingLiabilities(account: string, asset: AssetView): bigint {
    let sum = 0n;
    for (const o of this.offers.values()) if (o.seller === account && sameAsset(o.selling, asset)) sum += o.amount;
    return sum;
  }

  buyingLiabilities(account: string, asset: AssetView): bigint {
    let sum = 0n;
    for (const o of this.offers.values()) {
      if (o.seller === account && sameAsset(o.buying, asset)) sum += (o.amount * BigInt(o.n)) / BigInt(o.d);
    }
    return sum;
  }

  availableNative(acc: MAccount): bigint {
    const v = acc.balance - this.minBalance(acc) - this.sellingLiabilities(acc.id, { type: 'native', code: 'XLM' });
    return v > 0n ? v : 0n;
  }

  /** Spendable amount of an asset; issuers have unlimited supply of their own asset. */
  available(account: string, asset: AssetView): bigint {
    if (asset.type === 'native') {
      const acc = this.accounts.get(account);
      return acc ? this.availableNative(acc) : 0n;
    }
    if (asset.issuer === account) return INT64_MAX;
    const tl = this.trust.get(trustKey(account, asset));
    if (!tl) return 0n;
    const v = tl.balance - this.sellingLiabilities(account, asset);
    return v > 0n ? v : 0n;
  }

  /** How much more of an asset the account can receive (null when it has no trustline). */
  receiveRoom(account: string, asset: AssetView): bigint | null {
    if (asset.type === 'native') {
      const acc = this.accounts.get(account);
      return acc ? INT64_MAX - acc.balance : null;
    }
    if (asset.issuer === account) return INT64_MAX;
    const tl = this.trust.get(trustKey(account, asset));
    if (!tl) return null;
    return tl.limit - tl.balance;
  }

  private credit(account: string, asset: AssetView, amount: bigint, ledgerSeq: number): void {
    if (asset.type === 'native') {
      const acc = this.accounts.get(account)!;
      acc.balance += amount;
      acc.lastModified = ledgerSeq;
      return;
    }
    if (asset.issuer === account) return; // burned
    const tl = this.trust.get(trustKey(account, asset))!;
    tl.balance += amount;
    tl.lastModified = ledgerSeq;
  }

  private debit(account: string, asset: AssetView, amount: bigint, ledgerSeq: number): void {
    if (asset.type === 'native') {
      const acc = this.accounts.get(account)!;
      acc.balance -= amount;
      acc.lastModified = ledgerSeq;
      return;
    }
    if (asset.issuer === account) return; // minted
    const tl = this.trust.get(trustKey(account, asset))!;
    tl.balance -= amount;
    tl.lastModified = ledgerSeq;
  }

  private canAddSubEntry(acc: MAccount, extra = 1): boolean {
    const needed = BigInt(2 + acc.subEntries + acc.numSponsoring + extra) * RESERVE;
    return acc.balance - this.sellingLiabilities(acc.id, { type: 'native', code: 'XLM' }) >= needed;
  }

  // ------------------------------------------------------------ transactions

  parse(envelopeXdr: string): ParsedTx {
    let decoded: Transaction | FeeBumpTransaction;
    try {
      decoded = TransactionBuilder.fromXdr(envelopeXdr, this.passphrase);
    } catch (err) {
      throw new TxRejected('txMALFORMED', `cannot decode envelope: ${(err as Error).message}`);
    }
    if (decoded instanceof FeeBumpTransaction) {
      throw new TxRejected('txNOT_SUPPORTED', 'fee bump transactions are not supported', toHex(decoded.hash()));
    }
    const tx = decoded;
    const hash = toHex(tx.hash());
    const env = tx.toEnvelope();
    if (env.type !== 'envelopeTypeTx') {
      throw new TxRejected('txNOT_SUPPORTED', 'only v1 transaction envelopes are supported', hash);
    }
    return {
      tx,
      hash,
      envelopeXdr: env.toXdr('base64'),
      source: extractBaseAddress(tx.source),
      seq: BigInt(tx.sequence),
      maxFee: BigInt(tx.fee),
      opCount: tx.operations.length,
    };
  }

  private signatureWeight(p: ParsedTx, acc: MAccount): number {
    const h = p.tx.hash();
    const sigs = p.tx.signatures.map((s) => ({ hint: toHex(s.hint.toBytes()), sig: s.signature.toBytes() }));
    const candidates = [{ key: acc.id, weight: acc.thresholds.master }, ...acc.signers.filter((s) => s.key.startsWith('G'))];
    let total = 0;
    for (const c of candidates) {
      if (c.weight <= 0) continue;
      const kp = Keypair.fromPublicKey(c.key);
      const hint = toHex(kp.signatureHint());
      if (sigs.some((s) => s.hint === hint && kp.verify(h, s.sig))) total += c.weight;
    }
    return total;
  }

  /**
   * Mempool admission check. `queued` is how many txs of this source are
   * already queued (their seq numbers come first). Throws TxRejected.
   */
  check(p: ParsedTx, opts: { queued: number; pendingFees: bigint; closeTime: number }): void {
    const { tx } = p;
    if (p.opCount === 0 || p.opCount > 100) throw new TxRejected('txMALFORMED', 'a transaction needs 1 to 100 operations', p.hash);
    if (p.maxFee < BigInt(BASE_FEE * p.opCount)) {
      throw new TxRejected('txINSUFFICIENT_FEE', `fee must be at least ${BASE_FEE * p.opCount} stroops`, p.hash);
    }
    if (tx.ledgerBounds || tx.minAccountSequence || tx.minAccountSequenceAge || tx.minAccountSequenceLedgerGap || tx.extraSigners?.length) {
      throw new TxRejected('txNOT_SUPPORTED', 'only time bounds are supported as preconditions', p.hash);
    }
    if (tx.timeBounds) {
      const min = Number(tx.timeBounds.minTime);
      const max = Number(tx.timeBounds.maxTime);
      if (min > 0 && opts.closeTime < min) throw new TxRejected('txTOO_EARLY', 'time bounds start in the future', p.hash);
      if (max > 0 && opts.closeTime > max) throw new TxRejected('txTOO_LATE', 'time bounds have passed', p.hash);
    }
    const acc = this.accounts.get(p.source);
    if (!acc) throw new TxRejected('txNO_ACCOUNT', 'the source account does not exist', p.hash);
    const expected = acc.seq + 1n + BigInt(opts.queued);
    if (p.seq !== expected) {
      throw new TxRejected('txBAD_SEQ', `sequence ${p.seq} is not the next one (${expected})`, p.hash);
    }
    // Signatures: tx source at LOW, every op source at its level.
    const needs = new Map<string, number>();
    const bump = (id: string, level: 'low' | 'med' | 'high') => {
      const a = this.accounts.get(id);
      if (!a) return;
      const t = Math.max(1, a.thresholds[level]);
      needs.set(id, Math.max(needs.get(id) ?? 0, t));
    };
    bump(p.source, 'low');
    for (const op of tx.operations) bump(op.source ? extractBaseAddress(op.source) : p.source, opThresholdLevel(op));
    for (const [id, need] of needs) {
      const a = this.accounts.get(id)!;
      if (this.signatureWeight(p, a) < need) throw new TxRejected('txBAD_AUTH', `missing signature for ${id}`, p.hash);
    }
    if (this.availableNative(acc) < p.maxFee + opts.pendingFees) {
      throw new TxRejected('txINSUFFICIENT_BALANCE', 'not enough XLM for the fee', p.hash);
    }
  }

  private snapshot(): StateSnap {
    const copyMap = <K, V extends object>(m: Map<K, V>) => new Map([...m].map(([k, v]) => [k, { ...v }] as [K, V]));
    return {
      accounts: copyMap(this.accounts),
      trust: copyMap(this.trust),
      offers: copyMap(this.offers),
      data: copyMap(this.data),
      claimables: copyMap(this.claimables),
      idPool: this.idPool,
    };
  }

  private restore(s: StateSnap): void {
    this.accounts = s.accounts;
    this.trust = s.trust;
    this.offers = s.offers;
    this.data = s.data;
    this.claimables = s.claimables;
    this.idPool = s.idPool;
  }

  /** Fee phase then apply phase, like stellar-core. */
  applyTxSet(txs: ParsedTx[], ctx: { ledgerSeq: number; closeTime: number }): AppliedTx[] {
    const fees = new Map<string, bigint>();
    for (const p of txs) {
      const acc = this.accounts.get(p.source);
      if (!acc) {
        fees.set(p.hash, 0n);
        continue;
      }
      const want = BigInt(BASE_FEE * p.opCount);
      const fee = acc.balance < want ? acc.balance : want;
      acc.balance -= fee;
      acc.lastModified = ctx.ledgerSeq;
      this.feePool += fee;
      fees.set(p.hash, fee);
    }
    return txs.map((p) => this.applyOne(p, fees.get(p.hash) ?? 0n, ctx));
  }

  private txResultXdr(fee: bigint, arm: string, opResults?: xdr.OperationResult[]): string {
    const factory = xdr.TransactionResultResult as unknown as XdrFactory;
    const result = (opResults ? factory[arm](opResults) : factory[arm]()) as xdr.TransactionResultResult;
    return new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString(fee.toString()),
      result,
      ext: xdr.TransactionResultExt.v0(),
    }).toXdr('base64');
  }

  private applyOne(p: ParsedTx, fee: bigint, ctx: { ledgerSeq: number; closeTime: number }): AppliedTx {
    const touched = new Set<string>([p.source]);
    const base = { parsed: p, feeCharged: fee };
    const acc = this.accounts.get(p.source);
    if (!acc) {
      return { ...base, successful: false, resultCode: 'txNO_ACCOUNT', operations: [], resultXdr: this.txResultXdr(fee, 'txNoAccount'), accounts: [...touched] };
    }
    if (p.seq !== acc.seq + 1n) {
      return { ...base, successful: false, resultCode: 'txBAD_SEQ', operations: [], resultXdr: this.txResultXdr(fee, 'txBadSeq'), accounts: [...touched] };
    }
    acc.seq = p.seq;
    acc.lastModified = ctx.ledgerSeq;

    const snap = this.snapshot();
    const outcomes: OpOutcome[] = [];
    const ops = p.tx.operations;
    const rawEnv = p.tx.toEnvelope();
    const rawOps = rawEnv.type === 'envelopeTypeTx' ? rawEnv.v1.tx.operations : [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const src = op.source ? extractBaseAddress(op.source) : p.source;
      touched.add(src);
      let out: OpOutcome;
      if (!this.accounts.has(src)) {
        out = { ok: false, code: 'opNO_ACCOUNT', result: xdr.OperationResult.opNoAccount(), details: {} };
      } else {
        try {
          out = this.applyOp(p, i, op, rawOps[i], src, ctx);
        } catch (err) {
          out = { ok: false, code: 'opNOT_SUPPORTED', result: xdr.OperationResult.opNotSupported(), details: { error: (err as Error).message } };
        }
      }
      for (const v of Object.values(out.details)) {
        if (typeof v !== 'string') continue;
        for (const part of v.split(',')) if (/^G[A-Z2-7]{55}$/.test(part)) touched.add(part);
      }
      outcomes.push(out);
    }
    const success = outcomes.every((o) => o.ok);
    if (!success) {
      // Roll back the operations but keep the fee and the sequence bump.
      const seqAfter = acc.seq;
      this.restore(snap);
      const a = this.accounts.get(p.source);
      if (a) a.seq = seqAfter;
    }
    const operations: OperationView[] = outcomes.map((o, i) => ({
      index: i,
      type: ops[i].type,
      sourceAccount: ops[i].source ? extractBaseAddress(ops[i].source!) : p.source,
      resultCode: o.code,
      details: o.details,
    }));
    return {
      ...base,
      successful: success,
      resultCode: success ? 'txSUCCESS' : 'txFAILED',
      operations,
      resultXdr: this.txResultXdr(fee, success ? 'txSuccess' : 'txFailed', outcomes.map((o) => o.result)),
      accounts: [...touched],
    };
  }

  // ------------------------------------------------------------ operations

  private applyOp(
    p: ParsedTx,
    index: number,
    op: Transaction['operations'][number],
    raw: xdr.Operation,
    src: string,
    ctx: { ledgerSeq: number; closeTime: number },
  ): OpOutcome {
    const L = ctx.ledgerSeq;
    switch (op.type) {
      case 'createAccount': {
        const d = { destination: op.destination, startingBalance: op.startingBalance, funder: src };
        const amt = amountOf(op.startingBalance);
        if (this.accounts.has(op.destination)) return outcome('createAccount', false, 'createAccountAlreadyExist', d);
        if (amt < 2n * RESERVE) return outcome('createAccount', false, 'createAccountLowReserve', d);
        const from = this.accounts.get(src)!;
        if (this.availableNative(from) < amt) return outcome('createAccount', false, 'createAccountUnderfunded', d);
        from.balance -= amt;
        from.lastModified = L;
        const created = this.createAccountDirect(op.destination, amt, L);
        created.seq = BigInt(L) << 32n;
        return outcome('createAccount', true, 'createAccountSuccess', d);
      }

      case 'payment': {
        const asset = assetFromSdk(op.asset);
        const amt = amountOf(op.amount);
        const dest = extractBaseAddress(op.destination);
        const d = { from: src, to: dest, asset: assetLabel(asset), amount: op.amount };
        if (amt <= 0n) return outcome('payment', false, 'paymentMalformed', d);
        if (!this.accounts.has(dest)) return outcome('payment', false, 'paymentNoDestination', d);
        if (asset.type !== 'native') {
          if (!this.accounts.has(asset.issuer!)) return outcome('payment', false, 'paymentNoIssuer', d);
          if (src !== asset.issuer && !this.trust.has(trustKey(src, asset))) return outcome('payment', false, 'paymentSrcNoTrust', d);
          if (dest !== asset.issuer) {
            const tl = this.trust.get(trustKey(dest, asset));
            if (!tl) return outcome('payment', false, 'paymentNoTrust', d);
            if ((tl.flags & TL_AUTHORIZED) === 0) return outcome('payment', false, 'paymentNotAuthorized', d);
          }
        }
        if (this.available(src, asset) < amt) return outcome('payment', false, 'paymentUnderfunded', d);
        const room = this.receiveRoom(dest, asset);
        if (room !== null && room < amt) return outcome('payment', false, 'paymentLineFull', d);
        this.debit(src, asset, amt, L);
        this.credit(dest, asset, amt, L);
        return outcome('payment', true, 'paymentSuccess', d);
      }

      case 'changeTrust': {
        if (!(op.line instanceof Asset)) return outcome('changeTrust', false, 'changeTrustMalformed', { asset: 'liquidity pool share' });
        const asset = assetFromSdk(op.line);
        const limit = amountOf(op.limit);
        const d = { asset: assetLabel(asset), limit: op.limit, trustor: src };
        if (asset.type === 'native') return outcome('changeTrust', false, 'changeTrustMalformed', d);
        if (asset.issuer === src) return outcome('changeTrust', false, 'changeTrustSelfNotAllowed', d);
        const issuer = this.accounts.get(asset.issuer!);
        if (!issuer) return outcome('changeTrust', false, 'changeTrustNoIssuer', d);
        const key = trustKey(src, asset);
        const tl = this.trust.get(key);
        const acc = this.accounts.get(src)!;
        if (tl) {
          if (limit === 0n) {
            if (tl.balance > 0n || this.sellingLiabilities(src, asset) > 0n || this.buyingLiabilities(src, asset) > 0n) {
              return outcome('changeTrust', false, 'changeTrustInvalidLimit', d);
            }
            this.trust.delete(key);
            acc.subEntries--;
            acc.lastModified = L;
            return outcome('changeTrust', true, 'changeTrustSuccess', { ...d, removed: true });
          }
          if (limit < tl.balance) return outcome('changeTrust', false, 'changeTrustInvalidLimit', d);
          tl.limit = limit;
          tl.lastModified = L;
          return outcome('changeTrust', true, 'changeTrustSuccess', d);
        }
        if (limit === 0n) return outcome('changeTrust', false, 'changeTrustInvalidLimit', d);
        if (!this.canAddSubEntry(acc)) return outcome('changeTrust', false, 'changeTrustLowReserve', d);
        this.trust.set(key, {
          account: src,
          code: asset.code,
          issuer: asset.issuer!,
          balance: 0n,
          limit,
          flags: issuer.flags & AUTH_REQUIRED ? 0 : TL_AUTHORIZED,
          lastModified: L,
        });
        acc.subEntries++;
        acc.lastModified = L;
        return outcome('changeTrust', true, 'changeTrustSuccess', d);
      }

      case 'manageSellOffer':
      case 'createPassiveSellOffer': {
        const body = raw.body;
        let sdkPrice: xdr.Price;
        if (body.type === 'manageSellOffer') sdkPrice = body.manageSellOfferOp.price;
        else if (body.type === 'createPassiveSellOffer') sdkPrice = body.createPassiveSellOfferOp.price;
        else throw new Error(`unexpected operation body ${body.type}`);
        return this.applyOffer(op.type, src, {
          selling: assetFromSdk(op.selling),
          buying: assetFromSdk(op.buying),
          amount: amountOf(op.amount),
          n: sdkPrice.n,
          d: sdkPrice.d,
          offerId: op.type === 'manageSellOffer' ? BigInt(op.offerId) : 0n,
          passive: op.type === 'createPassiveSellOffer',
          buy: false,
          ledgerSeq: L,
        });
      }

      case 'manageBuyOffer': {
        const body = raw.body;
        if (body.type !== 'manageBuyOffer') throw new Error(`unexpected operation body ${body.type}`);
        const price = body.manageBuyOfferOp.price;
        return this.applyOffer('manageBuyOffer', src, {
          selling: assetFromSdk(op.selling),
          buying: assetFromSdk(op.buying),
          amount: amountOf(op.buyAmount),
          n: price.n,
          d: price.d,
          offerId: BigInt(op.offerId),
          passive: false,
          buy: true,
          ledgerSeq: L,
        });
      }

      case 'createClaimableBalance': {
        const asset = assetFromSdk(op.asset);
        const amt = amountOf(op.amount);
        const id = p.tx.getClaimableBalanceId(index).slice(8);
        const d = { asset: assetLabel(asset), amount: op.amount, claimants: op.claimants.map((c) => c.destination).join(','), balanceId: id };
        if (amt <= 0n || op.claimants.length === 0) return outcome('createClaimableBalance', false, 'createClaimableBalanceMalformed', d);
        if (asset.type !== 'native' && asset.issuer !== src && !this.trust.has(trustKey(src, asset))) {
          return outcome('createClaimableBalance', false, 'createClaimableBalanceNoTrust', d);
        }
        const acc = this.accounts.get(src)!;
        if (!this.canAddSubEntry(acc, op.claimants.length)) return outcome('createClaimableBalance', false, 'createClaimableBalanceLowReserve', d);
        const avail = this.available(src, asset) - (asset.type === 'native' ? BigInt(op.claimants.length) * RESERVE : 0n);
        if (avail < amt) return outcome('createClaimableBalance', false, 'createClaimableBalanceUnderfunded', d);
        this.debit(src, asset, amt, L);
        acc.numSponsoring += op.claimants.length;
        this.claimables.set(id, {
          id,
          asset,
          amount: amt,
          sponsor: src,
          claimants: op.claimants.map((c) => ({ destination: c.destination, predicate: predicateToJson(c.predicate, ctx.closeTime) })),
          lastModified: L,
        });
        return outcome(
          'createClaimableBalance',
          true,
          'createClaimableBalanceSuccess',
          d,
          xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(fromHex(id)),
        );
      }

      case 'claimClaimableBalance': {
        const id = op.balanceId.length === 72 ? op.balanceId.slice(8) : op.balanceId;
        const cb = this.claimables.get(id);
        const d: OpOutcome['details'] = { balanceId: id, claimant: src };
        if (!cb) return outcome('claimClaimableBalance', false, 'claimClaimableBalanceDoesNotExist', d);
        d.asset = assetLabel(cb.asset);
        d.amount = stroopsToString(cb.amount);
        const me = cb.claimants.find((c) => c.destination === src);
        if (!me || !predicateHolds(me.predicate, ctx.closeTime)) return outcome('claimClaimableBalance', false, 'claimClaimableBalanceCannotClaim', d);
        const room = this.receiveRoom(src, cb.asset);
        if (room === null) return outcome('claimClaimableBalance', false, 'claimClaimableBalanceNoTrust', d);
        if (room < cb.amount) return outcome('claimClaimableBalance', false, 'claimClaimableBalanceLineFull', d);
        this.credit(src, cb.asset, cb.amount, L);
        this.claimables.delete(id);
        const sponsor = this.accounts.get(cb.sponsor);
        if (sponsor) {
          sponsor.numSponsoring = Math.max(0, sponsor.numSponsoring - cb.claimants.length);
          sponsor.lastModified = L;
        }
        return outcome('claimClaimableBalance', true, 'claimClaimableBalanceSuccess', d);
      }

      case 'manageData': {
        const key = `${src}|${op.name}`;
        const value = op.value ? new Uint8Array(op.value) : null;
        const d = { name: op.name, value: value ? toBase64(value) : null };
        const acc = this.accounts.get(src)!;
        const existing = this.data.get(key);
        if (!value) {
          if (!existing) return outcome('manageData', false, 'manageDataNameNotFound', d);
          this.data.delete(key);
          acc.subEntries--;
          acc.lastModified = L;
          return outcome('manageData', true, 'manageDataSuccess', d);
        }
        if (!existing) {
          if (!this.canAddSubEntry(acc)) return outcome('manageData', false, 'manageDataLowReserve', d);
          acc.subEntries++;
        }
        this.data.set(key, { account: src, name: op.name, value, lastModified: L });
        acc.lastModified = L;
        return outcome('manageData', true, 'manageDataSuccess', d);
      }

      case 'setOptions': {
        const acc = this.accounts.get(src)!;
        const d: OpOutcome['details'] = {};
        if (op.homeDomain !== undefined) {
          if (op.homeDomain.length > 32) return outcome('setOptions', false, 'setOptionsInvalidHomeDomain', { homeDomain: op.homeDomain });
          acc.homeDomain = op.homeDomain;
          d.homeDomain = op.homeDomain;
        }
        const t = acc.thresholds;
        const next = { ...t };
        if (op.masterWeight !== undefined) next.master = op.masterWeight;
        if (op.lowThreshold !== undefined) next.low = op.lowThreshold;
        if (op.medThreshold !== undefined) next.med = op.medThreshold;
        if (op.highThreshold !== undefined) next.high = op.highThreshold;
        if (Object.values(next).some((v) => v < 0 || v > 255)) return outcome('setOptions', false, 'setOptionsThresholdOutOfRange', d);
        acc.thresholds = next;
        if (op.masterWeight !== undefined) d.masterWeight = op.masterWeight;
        if (op.lowThreshold !== undefined) d.lowThreshold = op.lowThreshold;
        if (op.medThreshold !== undefined) d.medThreshold = op.medThreshold;
        if (op.highThreshold !== undefined) d.highThreshold = op.highThreshold;
        if (op.setFlags !== undefined) {
          acc.flags |= op.setFlags;
          d.setFlags = op.setFlags;
        }
        if (op.clearFlags !== undefined) {
          acc.flags &= ~op.clearFlags;
          d.clearFlags = op.clearFlags;
        }
        const signer = op.signer as { ed25519PublicKey?: string; weight?: number } | undefined;
        if (signer && signer.ed25519PublicKey) {
          const key = signer.ed25519PublicKey;
          const weight = signer.weight ?? 0;
          if (key === src) return outcome('setOptions', false, 'setOptionsBadSigner', { signer: key });
          const others = acc.signers.filter((s) => s.key !== key);
          const had = others.length !== acc.signers.length;
          if (weight === 0) {
            if (had) acc.subEntries--;
            acc.signers = others;
          } else {
            if (!had) {
              if (others.length >= 20) return outcome('setOptions', false, 'setOptionsTooManySigners', { signer: key });
              if (!this.canAddSubEntry(acc)) return outcome('setOptions', false, 'setOptionsLowReserve', { signer: key });
              acc.subEntries++;
            }
            acc.signers = [...others, { key, weight }].sort((a, b) => (a.key < b.key ? -1 : 1));
          }
          d.signer = key;
          d.signerWeight = weight;
        }
        acc.lastModified = L;
        return outcome('setOptions', true, 'setOptionsSuccess', d);
      }

      case 'bumpSequence': {
        const acc = this.accounts.get(src)!;
        const to = BigInt(op.bumpTo);
        if (to > acc.seq) acc.seq = to;
        acc.lastModified = L;
        return outcome('bumpSequence', true, 'bumpSequenceSuccess', { bumpTo: op.bumpTo });
      }

      case 'accountMerge': {
        const dest = extractBaseAddress(op.destination);
        const d = { from: src, to: dest };
        if (dest === src) return outcome('accountMerge', false, 'accountMergeMalformed', d);
        const to = this.accounts.get(dest);
        if (!to) return outcome('accountMerge', false, 'accountMergeNoAccount', d);
        const acc = this.accounts.get(src)!;
        if (acc.subEntries > 0 || acc.numSponsoring > 0) return outcome('accountMerge', false, 'accountMergeHasSubEntries', d);
        to.balance += acc.balance;
        to.lastModified = L;
        this.accounts.delete(src);
        return outcome('accountMerge', true, 'accountMergeSuccess', { ...d, amount: stroopsToString(acc.balance) }, xdr.Int64.fromString(acc.balance.toString()));
      }

      default:
        return { ok: false, code: 'opNOT_SUPPORTED', result: xdr.OperationResult.opNotSupported(), details: {} };
    }
  }

  private applyOffer(
    opType: 'manageSellOffer' | 'createPassiveSellOffer' | 'manageBuyOffer',
    src: string,
    o: {
      selling: AssetView;
      buying: AssetView;
      amount: bigint;
      n: number;
      d: number;
      offerId: bigint;
      passive: boolean;
      buy: boolean;
      ledgerSeq: number;
    },
  ): OpOutcome {
    const prefix = o.buy ? 'manageBuyOffer' : 'manageSellOffer';
    const L = o.ledgerSeq;
    // Sell price (buying per selling) as a fraction.
    const sellN = o.buy ? o.d : o.n;
    const sellD = o.buy ? o.n : o.d;
    const details: OpOutcome['details'] = {
      selling: assetLabel(o.selling),
      buying: assetLabel(o.buying),
      [o.buy ? 'buyAmount' : 'amount']: stroopsToString(o.amount),
      price: priceString(o.n, o.d),
      offerId: o.offerId.toString(),
    };
    const fail = (arm: string) => outcome(opType, false, `${prefix}${arm}`, details);
    if (sameAsset(o.selling, o.buying) || o.n <= 0 || o.d <= 0 || o.amount < 0n) return fail('Malformed');
    if (o.offerId === 0n && o.amount === 0n) return fail('Malformed');
    if (o.selling.type !== 'native' && o.selling.issuer !== src && !this.trust.has(trustKey(src, o.selling))) return fail('SellNoTrust');
    if (o.buying.type !== 'native' && o.buying.issuer !== src && !this.trust.has(trustKey(src, o.buying))) return fail('BuyNoTrust');

    const acc = this.accounts.get(src)!;
    let existing: MOffer | undefined;
    if (o.offerId !== 0n) {
      existing = this.offers.get(o.offerId.toString());
      if (!existing || existing.seller !== src) return fail('NotFound');
      if (o.amount === 0n) {
        this.offers.delete(existing.id.toString());
        acc.subEntries--;
        acc.lastModified = L;
        const res = new xdr.ManageOfferSuccessResult({ offersClaimed: [], offer: xdr.ManageOfferSuccessResultOffer.manageOfferDeleted() });
        return outcome(opType, true, `${prefix}Success`, { ...details, deleted: true }, res);
      }
      // Re-place the offer with the new terms.
      this.offers.delete(existing.id.toString());
    }

    const avail = this.available(src, o.selling);
    const needSell = o.buy ? ceilDiv(o.amount * BigInt(o.n), BigInt(o.d)) : o.amount;
    if (avail <= 0n || avail < needSell) {
      if (existing) this.offers.set(existing.id.toString(), existing);
      return fail('Underfunded');
    }
    if (!existing && !this.canAddSubEntry(acc)) return fail('LowReserve');

    // Cross against offers selling `buying` for `selling`, best price first.
    const counters = [...this.offers.values()]
      .filter((c) => sameAsset(c.selling, o.buying) && sameAsset(c.buying, o.selling))
      .sort((a, b) => cmpFrac(a.n, a.d, b.n, b.d) || (a.id < b.id ? -1 : 1));
    let remaining = o.buy ? o.amount : o.amount; // buy: units of buying wanted; sell: units of selling to sell
    const claimed: xdr.ClaimAtom[] = [];
    let bought = 0n;
    let sold = 0n;
    for (const c of counters) {
      if (remaining <= 0n) break;
      // Counter price (selling per buying) = c.n / c.d. It crosses when c.n/c.d <= sellD/sellN.
      const lhs = BigInt(c.n) * BigInt(sellN);
      const rhs = BigInt(c.d) * BigInt(sellD);
      if (o.passive ? lhs >= rhs : lhs > rhs) break;
      if (c.seller === src) {
        if (existing) this.offers.set(existing.id.toString(), existing);
        return fail('CrossSelf');
      }
      const counterHas = this.available(c.seller, o.buying) + c.amount; // its own offer is counted in its liabilities
      let take = c.amount < counterHas ? c.amount : counterHas; // units of `buying` we get
      if (take <= 0n) {
        this.removeOffer(c, L);
        continue;
      }
      const cn = BigInt(c.n);
      const cd = BigInt(c.d);
      if (o.buy) {
        if (take > remaining) take = remaining;
      } else {
        const cost = ceilDiv(take * cn, cd);
        if (cost > remaining) take = (remaining * cd) / cn;
      }
      const myAvail = this.available(src, o.selling);
      if (ceilDiv(take * cn, cd) > myAvail) take = (myAvail * cd) / cn;
      const room = this.receiveRoom(src, o.buying);
      if (room !== null && take > room) take = room;
      const counterRoom = this.receiveRoom(c.seller, o.selling);
      if (counterRoom === null) {
        this.removeOffer(c, L);
        continue;
      }
      let pay = ceilDiv(take * cn, cd);
      if (pay > counterRoom) {
        take = (counterRoom * cd) / cn;
        pay = ceilDiv(take * cn, cd);
      }
      if (take <= 0n || pay <= 0n) break;
      this.debit(c.seller, o.buying, take, L);
      this.credit(src, o.buying, take, L);
      this.debit(src, o.selling, pay, L);
      this.credit(c.seller, o.selling, pay, L);
      c.amount -= take;
      c.lastModified = L;
      if (c.amount <= 0n) this.removeOffer(c, L);
      claimed.push(
        xdr.ClaimAtom.claimAtomTypeOrderBook(
          new xdr.ClaimOfferAtom({
            sellerId: accountIdXdr(c.seller),
            offerId: xdr.Int64.fromString(c.id.toString()),
            assetSold: assetToSdk(o.buying).toXdrObject(),
            amountSold: xdr.Int64.fromString(take.toString()),
            assetBought: assetToSdk(o.selling).toXdrObject(),
            amountBought: xdr.Int64.fromString(pay.toString()),
          }),
        ),
      );
      bought += take;
      sold += pay;
      remaining -= o.buy ? take : pay;
    }

    // What is left rests on the book as a sell offer.
    let restAmount = 0n;
    if (remaining > 0n) restAmount = o.buy ? (remaining * BigInt(o.n)) / BigInt(o.d) : remaining;
    const left = this.available(src, o.selling);
    if (restAmount > left) restAmount = left;
    details.bought = stroopsToString(bought);
    details.sold = stroopsToString(sold);
    details.claimed = claimed.length;

    let offerResult: xdr.ManageOfferSuccessResultOffer;
    if (restAmount > 0n) {
      const id = existing ? existing.id : ++this.idPool;
      const rest: MOffer = {
        id,
        seller: src,
        selling: o.selling,
        buying: o.buying,
        amount: restAmount,
        n: sellN,
        d: sellD,
        passive: o.passive,
        lastModified: L,
      };
      this.offers.set(id.toString(), rest);
      if (!existing) acc.subEntries++;
      details.offerId = id.toString();
      const entry = new xdr.OfferEntry({
        sellerId: accountIdXdr(src),
        offerId: xdr.Int64.fromString(id.toString()),
        selling: assetToSdk(o.selling).toXdrObject(),
        buying: assetToSdk(o.buying).toXdrObject(),
        amount: xdr.Int64.fromString(restAmount.toString()),
        price: new xdr.Price({ n: sellN, d: sellD }),
        flags: o.passive ? 1 : 0,
        ext: xdr.OfferEntryExt.v0(),
      });
      offerResult = existing ? xdr.ManageOfferSuccessResultOffer.manageOfferUpdated(entry) : xdr.ManageOfferSuccessResultOffer.manageOfferCreated(entry);
    } else {
      if (existing) acc.subEntries--;
      offerResult = xdr.ManageOfferSuccessResultOffer.manageOfferDeleted();
    }
    acc.lastModified = L;
    const res = new xdr.ManageOfferSuccessResult({ offersClaimed: claimed, offer: offerResult });
    return outcome(opType, true, `${prefix}Success`, details, res);
  }

  private removeOffer(o: MOffer, ledgerSeq: number): void {
    if (!this.offers.delete(o.id.toString())) return;
    const seller = this.accounts.get(o.seller);
    if (seller) {
      seller.subEntries = Math.max(0, seller.subEntries - 1);
      seller.lastModified = ledgerSeq;
    }
  }

  // ------------------------------------------------------------ views

  accountView(id: string): AccountView | null {
    const acc = this.accounts.get(id);
    if (!acc) return null;
    const native: AssetView = { type: 'native', code: 'XLM' };
    const balances: BalanceLine[] = [
      {
        asset: native,
        balance: stroopsToString(acc.balance),
        limit: null,
        buyingLiabilities: stroopsToString(this.buyingLiabilities(id, native)),
        sellingLiabilities: stroopsToString(this.sellingLiabilities(id, native)),
        authorized: true,
        authorizedToMaintainLiabilities: true,
        clawbackEnabled: false,
      },
    ];
    const lines = [...this.trust.values()].filter((t) => t.account === id).sort((a, b) => (a.code + a.issuer < b.code + b.issuer ? -1 : 1));
    for (const t of lines) {
      const asset: AssetView = { type: t.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code: t.code, issuer: t.issuer };
      balances.push({
        asset,
        balance: stroopsToString(t.balance),
        limit: stroopsToString(t.limit),
        buyingLiabilities: stroopsToString(this.buyingLiabilities(id, asset)),
        sellingLiabilities: stroopsToString(this.sellingLiabilities(id, asset)),
        authorized: (t.flags & TL_AUTHORIZED) !== 0,
        authorizedToMaintainLiabilities: (t.flags & TL_AUTHORIZED) !== 0,
        clawbackEnabled: false,
      });
    }
    const offers = [...this.offers.values()].filter((o) => o.seller === id).map((o) => this.offerView(o));
    const data = [...this.data.values()]
      .filter((x) => x.account === id)
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((x) => {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(x.value);
        return { name: x.name, valueBase64: toBase64(x.value), valueText: /^[\x20-\x7e]*$/.test(text) ? text : null };
      });
    const claimableBalances = [...this.claimables.values()]
      .filter((c) => c.sponsor === id || c.claimants.some((x) => x.destination === id))
      .map((c) => this.claimableView(c));
    const minBal = this.minBalance(acc);
    return {
      accountId: id,
      sequence: acc.seq.toString(),
      numSubEntries: acc.subEntries,
      minBalance: stroopsToString(minBal),
      availableBalance: stroopsToString(this.availableNative(acc)),
      flags: {
        authRequired: (acc.flags & AUTH_REQUIRED) !== 0,
        authRevocable: (acc.flags & AUTH_REVOCABLE) !== 0,
        authImmutable: (acc.flags & AUTH_IMMUTABLE) !== 0,
        authClawbackEnabled: (acc.flags & AUTH_CLAWBACK) !== 0,
      },
      thresholds: { masterWeight: acc.thresholds.master, low: acc.thresholds.low, med: acc.thresholds.med, high: acc.thresholds.high },
      signers: [{ key: id, weight: acc.thresholds.master }, ...acc.signers],
      homeDomain: acc.homeDomain,
      balances,
      offers,
      data,
      claimableBalances,
      lastModifiedLedger: acc.lastModified,
    };
  }

  offerView(o: MOffer): OfferView {
    return {
      offerId: o.id.toString(),
      seller: o.seller,
      selling: o.selling,
      buying: o.buying,
      amount: stroopsToString(o.amount),
      price: priceString(o.n, o.d),
      priceR: { n: o.n, d: o.d },
      passive: o.passive,
    };
  }

  claimableView(c: MClaimable): ClaimableBalanceView {
    return {
      balanceId: c.id,
      asset: c.asset,
      amount: stroopsToString(c.amount),
      sponsor: c.sponsor,
      claimants: c.claimants.map((x) => ({ destination: x.destination, predicate: x.predicate })),
    };
  }

  /** Horizon-style book: asks in `selling` units, bids in `buying` units; both priced in buying per selling. */
  orderBook(selling: AssetView, buying: AssetView, limit = 20): OrderBookView {
    const asks = new Map<string, { n: number; d: number; amount: bigint }>();
    const bids = new Map<string, { n: number; d: number; amount: bigint }>();
    for (const o of this.offers.values()) {
      if (sameAsset(o.selling, selling) && sameAsset(o.buying, buying)) {
        const k = `${o.n}/${o.d}`;
        const e = asks.get(k) ?? { n: o.n, d: o.d, amount: 0n };
        e.amount += o.amount;
        asks.set(k, e);
      } else if (sameAsset(o.selling, buying) && sameAsset(o.buying, selling)) {
        const k = `${o.d}/${o.n}`;
        const e = bids.get(k) ?? { n: o.d, d: o.n, amount: 0n };
        e.amount += o.amount;
        bids.set(k, e);
      }
    }
    const toRows = (m: Map<string, { n: number; d: number; amount: bigint }>, dir: 1 | -1) =>
      [...m.values()]
        .sort((a, b) => dir * cmpFrac(a.n, a.d, b.n, b.d))
        .slice(0, limit)
        .map((e) => ({ price: priceString(e.n, e.d), amount: stroopsToString(e.amount), priceR: { n: e.n, d: e.d } }));
    return { selling, buying, asks: toRows(asks, 1), bids: toRows(bids, -1) };
  }

  assets(): AssetStatView[] {
    const stats = new Map<string, AssetStatView & { supplyBig: bigint }>();
    for (const t of this.trust.values()) {
      const key = `${t.code}:${t.issuer}`;
      let s = stats.get(key);
      if (!s) {
        const issuer = this.accounts.get(t.issuer);
        const f = issuer?.flags ?? 0;
        s = {
          asset: { type: t.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code: t.code, issuer: t.issuer },
          holders: 0,
          supply: '0.0000000',
          supplyBig: 0n,
          issuerFlags: { authRequired: (f & AUTH_REQUIRED) !== 0, authRevocable: (f & AUTH_REVOCABLE) !== 0, authClawbackEnabled: (f & AUTH_CLAWBACK) !== 0 },
        };
        stats.set(key, s);
      }
      if (t.flags & TL_AUTHORIZED) s.holders++;
      s.supplyBig += t.balance;
    }
    return [...stats.values()]
      .sort((a, b) => b.holders - a.holders || (a.asset.code < b.asset.code ? -1 : 1))
      .map(({ supplyBig, ...rest }) => ({ ...rest, supply: stroopsToString(supplyBig) }));
  }

  counts(): { accounts: number; trustlines: number; offers: number; claimables: number } {
    return { accounts: this.accounts.size, trustlines: this.trust.size, offers: this.offers.size, claimables: this.claimables.size };
  }

  /** Simple deterministic state digest for the mock header (not the real flat state hash). */
  digestInput(): string {
    const parts: string[] = [];
    for (const [k, a] of [...this.accounts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) parts.push(`${k}:${a.balance}:${a.seq}:${a.subEntries}`);
    for (const [k, t] of [...this.trust].sort((x, y) => (x[0] < y[0] ? -1 : 1))) parts.push(`${k}:${t.balance}:${t.limit}`);
    for (const [k, o] of [...this.offers].sort((x, y) => (x[0] < y[0] ? -1 : 1))) parts.push(`${k}:${o.amount}:${o.n}/${o.d}`);
    for (const k of [...this.claimables.keys()].sort()) parts.push(k);
    return parts.join('|');
  }
}
