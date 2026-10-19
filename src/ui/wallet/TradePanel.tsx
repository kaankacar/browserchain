import { ArrowDownUp, ArrowLeftRight, BookOpen, Link2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import type { AccountView, AssetView } from '../../node/api';
import { bookRows, type BookRow as Row } from '../lib/orderbook';
import { AssetLabel } from '../components/links';
import { Button, Card, cx, EmptyState, ErrorNote, Field, IconButton, Input, Notice, Segmented, Select, Skeleton } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { assetKey, formatAmount, NATIVE_ASSET, parseAssetKey } from '../lib/format';
import { cancelOfferOp, changeTrustOp, manageBuyOfferOp, manageSellOfferOp } from '../lib/txbuild';
import { href } from '../lib/route';
import { readPref, writePref, type WalletKey } from '../lib/wallet';
import { useApi, useNodeState } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { hasTrust, spendable, TxStatusLine, useAction } from './shared';

/** An asset of the remembered pair, or null when the stored value is not a valid asset key. */
function pairAsset(key: unknown): AssetView | null {
  try {
    return typeof key === 'string' ? parseAssetKey(key) : null;
  } catch {
    return null;
  }
}

function fmt(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return '–';
  return formatAmount(n.toFixed(7), { maxDecimals: digits });
}

function BookSide({ title, rows, tone, maxCum, onPick, baseCode, counterCode }: { title: string; rows: Row[]; tone: 'ok' | 'bad'; maxCum: number; onPick: (r: Row) => void; baseCode: string; counterCode: string }) {
  return (
    <div className="min-w-0">
      <div className="grid grid-cols-3 gap-2 px-2 pb-1.5 text-[11px] font-medium text-fg-3">
        <span className={tone === 'ok' ? 'text-ok' : 'text-bad'}>{title}</span>
        <span className="text-right">{baseCode}</span>
        <span className="text-right">{counterCode}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-2 py-3 text-xs text-fg-3">No {title.toLowerCase()}.</p>
      ) : (
        <ul className="flex flex-col gap-px">
          {rows.map((r, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => onPick(r)}
                title={`Use price ${r.price}`}
                className="relative grid w-full grid-cols-3 gap-2 overflow-hidden rounded px-2 py-1 text-xs tabular-nums hover:bg-hover"
              >
                <span
                  aria-hidden
                  className={cx('absolute inset-y-0 right-0', tone === 'ok' ? 'bg-ok/10' : 'bg-bad/10')}
                  style={{ width: `${maxCum > 0 ? (r.cum / maxCum) * 100 : 0}%` }}
                />
                <span className={cx('relative text-left font-medium', tone === 'ok' ? 'text-ok' : 'text-bad')}>{fmt(r.price, 4)}</span>
                <span className="relative text-right text-fg">{fmt(r.base, 2)}</span>
                <span className="relative text-right text-fg-2">{fmt(r.counter, 2)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TradePanel({ wallet, account }: { wallet: WalletKey; account: AccountView }) {
  const api = useApi();
  const { submit } = useWallet();
  const closeCounter = useNodeState((s) => s.closeCounter);
  // refetched after every ledger: assets issued while this tab is open must show up
  const assets = useAsync(() => api.getAssets(), [api, closeCounter]);
  const id = useId();
  const all = useMemo(() => [NATIVE_ASSET, ...(assets.data ?? []).map((a) => a.asset)], [assets.data]);
  const [pair, setPair] = useState<{ base: string; counter: string } | null>(() => readPref('browserchain:trade:pair', null));
  // Default to the first asset. The remembered pair outlives networks and chain
  // resets: drop it when this network does not have its assets.
  useEffect(() => {
    if (!assets.data) return;
    const known = new Set(all.map(assetKey));
    if (pair && known.has(pair.base) && known.has(pair.counter) && pair.base !== pair.counter) return;
    const next = assets.data.length ? { base: assetKey(assets.data[0].asset), counter: 'XLM' } : null;
    if (next?.base !== pair?.base || next?.counter !== pair?.counter) setPair(next);
  }, [pair, assets.data, all]);
  const base = useMemo(() => (pair ? pairAsset(pair.base) : null), [pair]);
  const counter = useMemo(() => (pair ? pairAsset(pair.counter) : null), [pair]);
  const book = useAsync(() => (base && counter ? api.getOrderBook(base, counter, 12) : Promise.resolve(undefined)), [pair?.base, pair?.counter, api, closeCounter]);
  const { asks, bids } = bookRows(book.data);
  const maxCum = Math.max(asks[asks.length - 1]?.cum ?? 0, bids[bids.length - 1]?.cum ?? 0);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  const order = useAction();
  const trust = useAction();
  const cancel = useAction();
  const [cancelling, setCancelling] = useState<string | null>(null);

  const choose = (next: { base: string; counter: string }) => {
    setPair(next);
    writePref('browserchain:trade:pair', next);
    setPrice('');
    setHash(null);
  };

  if (!pair || !base || !counter) {
    return (
      <Card title="Trade" icon={ArrowLeftRight}>
        {assets.data && assets.data.length === 0 ? (
          <EmptyState icon={ArrowLeftRight} title="No assets to trade yet" action={<a className="text-sm font-medium text-ledger hover:underline" href={href.wallet('issue')}>Issue an asset</a>}>
            The DEX trades issued assets against XLM or each other. This network has none yet.
          </EmptyState>
        ) : (
          <Skeleton className="h-48 w-full" />
        )}
      </Card>
    );
  }

  const missing = [base, counter].filter((a) => !hasTrust(account, a));
  const total = Number(amount) * Number(price);
  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : null;

  const placeOrder = (e: React.FormEvent) => {
    e.preventDefault();
    void order.run(async () => {
      setHash(null);
      const op =
        side === 'buy'
          ? manageBuyOfferOp({ selling: counter, buying: base, buyAmount: amount, price })
          : manageSellOfferOp({ selling: base, buying: counter, amount, price });
      const res = await submit({ key: wallet, ops: [op], label: `${side === 'buy' ? 'Buy' : 'Sell'} ${formatAmount(amount)} ${base.code} @ ${price}` });
      if (!res.ok) throw new Error(res.message);
      setHash(res.hash);
      setAmount('');
    });
  };

  const assetOptions = (exclude: string) =>
    all
      .filter((a) => assetKey(a) !== exclude)
      .map((a) => (
        <option key={assetKey(a)} value={assetKey(a)}>
          {a.code}
          {a.issuer ? ` · ${a.issuer.slice(0, 4)}…${a.issuer.slice(-4)}` : ''}
        </option>
      ));

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <Card
        title="Order book"
        subtitle={spread !== null ? `Spread ${fmt(spread, 4)} ${counter.code}` : 'Prices in counter per base'}
        icon={BookOpen}
        iconClass="text-network"
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={`${id}-base`} className="sr-only">
              Base asset
            </label>
            <Select id={`${id}-base`} value={pair.base} onChange={(e) => choose({ base: e.target.value, counter: pair.counter })} className="h-8 w-auto text-xs">
              {assetOptions(pair.counter)}
            </Select>
            <IconButton icon={ArrowDownUp} label="Swap base and counter" size="sm" onClick={() => choose({ base: pair.counter, counter: pair.base })} />
            <label htmlFor={`${id}-counter`} className="sr-only">
              Counter asset
            </label>
            <Select id={`${id}-counter`} value={pair.counter} onChange={(e) => choose({ base: pair.base, counter: e.target.value })} className="h-8 w-auto text-xs">
              {assetOptions(pair.base)}
            </Select>
          </div>
        }
      >
        <p className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-3">
          <span className="inline-flex items-center gap-1.5">
            Price of 1 <AssetLabel asset={base} issuer={false} /> in <AssetLabel asset={counter} issuer={false} />
          </span>
          <span className="sm:before:mr-1.5 sm:before:content-['·']">Click a row to use its price.</span>
        </p>
        {book.loading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <BookSide title="Bids" rows={bids} tone="ok" maxCum={maxCum} baseCode={base.code} counterCode={counter.code} onPick={(r) => { setPrice(String(Number(r.price.toFixed(7)))); setSide('sell'); }} />
            <BookSide title="Asks" rows={asks} tone="bad" maxCum={maxCum} baseCode={base.code} counterCode={counter.code} onPick={(r) => { setPrice(String(Number(r.price.toFixed(7)))); setSide('buy'); }} />
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
        <Card title="Place an order" icon={ArrowLeftRight} iconClass="text-ledger">
          {missing.length ? (
            <Notice tone="info" icon={Link2} title="Trustline needed" className="mb-4">
              <p>To trade this pair, {wallet.name} must trust {missing.map((m) => m.code).join(' and ')}.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {missing.map((m) => (
                  <Button
                    key={assetKey(m)}
                    size="sm"
                    icon={Link2}
                    loading={trust.busy}
                    onClick={() =>
                      void trust.run(async () => {
                        const res = await submit({ key: wallet, ops: [changeTrustOp({ asset: m })], label: `Trust ${m.code}` });
                        if (!res.ok) throw new Error(res.message);
                        setHash(res.hash);
                      })
                    }
                  >
                    Trust {m.code}
                  </Button>
                ))}
              </div>
              {trust.error ? <ErrorNote className="mt-2">{trust.error}</ErrorNote> : null}
            </Notice>
          ) : null}
          <form onSubmit={placeOrder} className="flex flex-col gap-4">
            <Segmented
              label="Order side"
              value={side}
              onChange={setSide}
              options={[
                { value: 'buy', label: `Buy ${base.code}` },
                { value: 'sell', label: `Sell ${base.code}` },
              ]}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Amount (${base.code})`} htmlFor={`${id}-amt`}>
                <Input id={`${id}-amt`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} placeholder="0.00" className="tabular-nums" required />
              </Field>
              <Field label={`Price (${counter.code})`} htmlFor={`${id}-price`}>
                <Input id={`${id}-price`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(',', '.'))} placeholder={asks[0] ? fmt(side === 'buy' ? asks[0].price : (bids[0]?.price ?? asks[0].price), 4) : '0.00'} className="tabular-nums" required />
              </Field>
            </div>
            <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-raised px-3 py-2.5 text-xs">
              <dt className="text-fg-3">{side === 'buy' ? 'You pay about' : 'You receive about'}</dt>
              <dd className="text-right font-medium tabular-nums text-fg">
                {Number.isFinite(total) && total > 0 ? `${fmt(total, 4)} ${counter.code}` : '–'}
              </dd>
              <dt className="text-fg-3">Spendable</dt>
              <dd className="text-right tabular-nums text-fg-2">
                {side === 'buy' ? `${formatAmount(spendable(account, counter), { maxDecimals: 4 })} ${counter.code}` : `${formatAmount(spendable(account, base), { maxDecimals: 4 })} ${base.code}`}
              </dd>
            </dl>
            {order.error ? <ErrorNote>{order.error}</ErrorNote> : null}
            {hash ? <TxStatusLine hash={hash} /> : null}
            <Button type="submit" variant="primary" loading={order.busy} disabled={missing.length > 0}>
              {side === 'buy' ? `Buy ${base.code}` : `Sell ${base.code}`}
            </Button>
          </form>
        </Card>

        <Card title="My open offers" subtitle={`${account.offers.length} on the book`} icon={BookOpen} bodyClass="p-0">
          {account.offers.length === 0 ? (
            <p className="p-4 text-sm text-fg-3">No open offers. An order that does not fill right away rests on the book until it is taken or cancelled.</p>
          ) : (
            <ul className="divide-y divide-line">
              {account.offers.map((o) => (
                <li key={o.offerId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5">
                      Sell <span className="font-medium tabular-nums">{formatAmount(o.amount, { maxDecimals: 4 })}</span>
                      <AssetLabel asset={o.selling} issuer={false} /> for <AssetLabel asset={o.buying} issuer={false} />
                    </p>
                    <p className="text-xs text-fg-3">
                      @ {formatAmount(o.price, { maxDecimals: 7 })} {o.buying.code} each · offer #{o.offerId}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={X}
                    loading={cancel.busy && cancelling === o.offerId}
                    onClick={() => {
                      setCancelling(o.offerId);
                      void cancel.run(async () => {
                        const res = await submit({ key: wallet, ops: [cancelOfferOp({ selling: o.selling, buying: o.buying, offerId: o.offerId, price: o.price })], label: `Cancel offer #${o.offerId}` });
                        if (!res.ok) throw new Error(res.message);
                        setHash(res.hash);
                      });
                    }}
                  >
                    Cancel
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {cancel.error ? <ErrorNote className="m-4">{cancel.error}</ErrorNote> : null}
        </Card>
      </div>
    </div>
  );
}

