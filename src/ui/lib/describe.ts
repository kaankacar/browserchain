// Short human descriptions of operations and transactions for feeds and lists.
// Operation details come from the ledger's summarizeOperations; their keys are
// not fixed by the API, so lookups try the common names.

import type { OperationView, TxSummary } from '../../node/api';
import { assetCodeFromKey, formatAmount, opTypeLabel } from './format';

export type OpKind = 'payment' | 'account' | 'trust' | 'offer' | 'claim' | 'data' | 'options' | 'other';

export interface OpDescription {
  kind: OpKind;
  title: string;
  /** e.g. "125.5 XLM" */
  amount: string | null;
  /** Main counterparty account, if any. */
  counterparty: string | null;
  /** Extra short text, e.g. "at 8.4 XLM". */
  note: string | null;
}

function str(d: OperationView['details'], ...keys: string[]): string | null {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function amountWith(amount: string | null, asset: string | null): string | null {
  if (!amount) return null;
  const code = asset ? assetCodeFromKey(asset) : null;
  return code ? `${formatAmount(amount)} ${code}` : formatAmount(amount);
}

export function opKind(type: string): OpKind {
  switch (type) {
    case 'payment':
    case 'pathPaymentStrictReceive':
    case 'pathPaymentStrictSend':
      return 'payment';
    case 'createAccount':
    case 'accountMerge':
    case 'bumpSequence':
      return 'account';
    case 'changeTrust':
    case 'allowTrust':
    case 'setTrustLineFlags':
      return 'trust';
    case 'manageSellOffer':
    case 'manageBuyOffer':
    case 'createPassiveSellOffer':
      return 'offer';
    case 'createClaimableBalance':
    case 'claimClaimableBalance':
    case 'clawbackClaimableBalance':
      return 'claim';
    case 'manageData':
      return 'data';
    case 'setOptions':
      return 'options';
    default:
      return 'other';
  }
}

export function describeOp(op: OperationView): OpDescription {
  const d = op.details;
  const kind = opKind(op.type);
  const base: OpDescription = { kind, title: opTypeLabel(op.type), amount: null, counterparty: null, note: null };
  switch (op.type) {
    case 'payment':
      return { ...base, amount: amountWith(str(d, 'amount'), str(d, 'asset') ?? 'XLM'), counterparty: str(d, 'to', 'destination') };
    case 'pathPaymentStrictReceive':
    case 'pathPaymentStrictSend': {
      // sendAmountSent: what a successful strict receive took from the source
      const sent = op.type === 'pathPaymentStrictReceive' ? amountWith(str(d, 'sendAmountSent'), str(d, 'sendAsset')) : null;
      return {
        ...base,
        amount: amountWith(str(d, 'destAmount', 'destAmountReceived', 'amount'), str(d, 'destAsset', 'asset')),
        counterparty: str(d, 'to', 'destination'),
        note: sent ? `sent ${sent}` : null,
      };
    }
    case 'createAccount':
      return { ...base, amount: amountWith(str(d, 'startingBalance', 'amount'), 'XLM'), counterparty: str(d, 'destination', 'account') };
    case 'accountMerge':
      return { ...base, counterparty: str(d, 'to', 'destination'), amount: amountWith(str(d, 'amount'), 'XLM') };
    case 'changeTrust': {
      const asset = str(d, 'asset', 'line');
      const limit = str(d, 'limit');
      const removing = limit !== null && /^0(\.0+)?$/.test(limit);
      return {
        ...base,
        title: removing ? 'Remove trustline' : 'Change trust',
        note: asset ? assetCodeFromKey(asset) : null,
        counterparty: asset && asset.includes(':') ? asset.slice(asset.indexOf(':') + 1) : null,
      };
    }
    case 'manageSellOffer':
    case 'createPassiveSellOffer':
    case 'manageBuyOffer': {
      const selling = str(d, 'selling');
      const buying = str(d, 'buying');
      const isBuy = op.type === 'manageBuyOffer';
      const amt = str(d, isBuy ? 'buyAmount' : 'amount', 'amount');
      const zero = amt !== null && /^0(\.0+)?$/.test(amt);
      const price = str(d, 'price');
      const pair = selling && buying ? `${assetCodeFromKey(selling)} → ${assetCodeFromKey(buying)}` : null;
      const terms = [pair, price && !zero ? `@ ${formatAmount(price)}` : null].filter(Boolean).join(' ');
      // createdOfferId: the id of the offer the operation left in the book
      const created = str(d, 'createdOfferId');
      return {
        ...base,
        title: zero ? 'Cancel offer' : isBuy ? 'Buy offer' : op.type === 'createPassiveSellOffer' ? 'Passive offer' : 'Sell offer',
        amount: zero ? null : amountWith(amt, isBuy ? buying : selling),
        note: [terms, created ? `new offer #${created}` : null].filter(Boolean).join(' · ') || null,
      };
    }
    case 'createClaimableBalance':
      return { ...base, title: 'Claimable balance', amount: amountWith(str(d, 'amount'), str(d, 'asset') ?? 'XLM') };
    case 'claimClaimableBalance':
      return { ...base, title: 'Claim balance', amount: amountWith(str(d, 'amount'), str(d, 'asset')) };
    case 'manageData': {
      const name = str(d, 'name');
      return { ...base, title: 'Set data', note: name };
    }
    case 'setOptions': {
      const hd = str(d, 'homeDomain');
      return { ...base, note: hd ? `home domain ${hd}` : null };
    }
    case 'bumpSequence':
      return { ...base, note: str(d, 'bumpTo') };
    default:
      return base;
  }
}

/** First operation's description, plus "+N" for the rest. */
export function describeTx(tx: TxSummary): OpDescription & { more: number } {
  const first = tx.operations[0];
  if (!first) return { kind: 'other', title: 'Transaction', amount: null, counterparty: null, note: null, more: 0 };
  return { ...describeOp(first), more: Math.max(0, tx.operations.length - 1) };
}

export type DetailKind = 'account' | 'accounts' | 'asset' | 'amount' | 'hash' | 'text';

const ASSET_KEYS = new Set(['asset', 'selling', 'buying', 'line', 'sendAsset', 'destAsset']);
const AMOUNT_KEYS = /amount|balance|limit|sendMax|destMin|bought|sold/i;

/** How to render one details value (account link, asset, amount, hash, text). */
export function detailKind(key: string, value: string | number | boolean | null): DetailKind {
  if (typeof value !== 'string') return 'text';
  if (/^G[A-Z2-7]{55}$/.test(value)) return 'account';
  if (/^G[A-Z2-7]{55}(,G[A-Z2-7]{55})+$/.test(value)) return 'accounts';
  if (ASSET_KEYS.has(key) && (value === 'XLM' || value === 'native' || /^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/.test(value))) return 'asset';
  if (AMOUNT_KEYS.test(key) && /^-?\d+(\.\d+)?$/.test(value)) return 'amount';
  if (/^[0-9a-f]{64}$/.test(value) || /^[0-9a-f]{72}$/.test(value)) return 'hash';
  return 'text';
}

/** Labels that the generic rule below gets wrong or unclear. */
const DETAIL_LABELS: Record<string, string> = {
  offerId: 'Offer ID',
  createdOfferId: 'New offer ID',
  sendAmountSent: 'Amount sent',
  destAmountReceived: 'Amount received',
};

/** "startingBalance" -> "Starting balance". */
export function detailLabel(key: string): string {
  if (Object.hasOwn(DETAIL_LABELS, key)) return DETAIL_LABELS[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------- claim predicates

/** JSON form the node uses for claim predicates (times are unix seconds). */
type Pred =
  | { type: 'unconditional' }
  | { type: 'and' | 'or'; predicates: [unknown, unknown] }
  | { type: 'not'; predicate: unknown }
  | { type: 'beforeAbsoluteTime'; time: string | number }
  | { type: 'beforeRelativeTime'; seconds: string | number };

function asPred(p: unknown): Pred | null {
  if (!p || typeof p !== 'object') return null;
  const t = (p as { type?: unknown }).type;
  return typeof t === 'string' ? (p as Pred) : null;
}

function utcShort(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "any time", "before 2026-10-16 14:00 UTC", "after …", or JSON for unknown shapes. */
export function describePredicate(p: unknown): string {
  const x = asPred(p);
  if (!x) return JSON.stringify(p);
  switch (x.type) {
    case 'unconditional':
      return 'any time';
    case 'beforeAbsoluteTime':
      return `before ${utcShort(Number(x.time))}`;
    case 'beforeRelativeTime':
      return `within ${Number(x.seconds)} s of creation`;
    case 'not': {
      const inner = asPred(x.predicate);
      if (inner?.type === 'beforeAbsoluteTime') return `after ${utcShort(Number(inner.time))}`;
      if (inner?.type === 'unconditional') return 'never';
      return `not (${describePredicate(x.predicate)})`;
    }
    case 'and':
    case 'or':
      return `(${describePredicate(x.predicates[0])}) ${x.type} (${describePredicate(x.predicates[1])})`;
    default:
      return JSON.stringify(p);
  }
}

/** Whether a predicate holds at `nowSec`; null when the shape is unknown. */
export function predicateHoldsNow(p: unknown, nowSec: number): boolean | null {
  const x = asPred(p);
  if (!x) return null;
  switch (x.type) {
    case 'unconditional':
      return true;
    case 'beforeAbsoluteTime':
      return nowSec < Number(x.time);
    case 'not': {
      const v = predicateHoldsNow(x.predicate, nowSec);
      return v === null ? null : !v;
    }
    case 'and':
    case 'or': {
      const a = predicateHoldsNow(x.predicates[0], nowSec);
      const b = predicateHoldsNow(x.predicates[1], nowSec);
      if (a === null || b === null) return null;
      return x.type === 'and' ? a && b : a || b;
    }
    default:
      return null;
  }
}
