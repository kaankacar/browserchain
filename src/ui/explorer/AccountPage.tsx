import { ArrowLeftRight, Coins, Database, Droplets, Gift, History, KeyRound, Shield, UserRound, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TxSummary } from '../../node/api';
import { HashText } from '../components/Hash';
import { Identicon } from '../components/Identicon';
import { AccountLink, AssetLabel, useNameOf } from '../components/links';
import { Badge, Button, Card, EmptyState, ErrorNote, Facts, PageHeader, Skeleton, TableWrap, TD, TH, cx } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { describePredicate } from '../lib/describe';
import { formatAmount, formatNumber, plural, stroopsToAmount, tryAmountToStroops } from '../lib/format';
import { href } from '../lib/route';
import { useApi, useNodeState } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { ExplorerNav, TxTable } from './common';

const HISTORY_PAGE = 15;

function available(balance: string, selling: string): string {
  const b = tryAmountToStroops(balance) ?? 0n;
  const s = tryAmountToStroops(selling) ?? 0n;
  return stroopsToAmount(b > s ? b - s : 0n);
}

function AccountHistory({ id }: { id: string }) {
  const api = useApi();
  const closeCounter = useNodeState((s) => s.closeCounter);
  const first = useAsync(() => api.getTransactions({ account: id, limit: HISTORY_PAGE }), [id, api, closeCounter]);
  const [more, setMore] = useState<TxSummary[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setMore([]);
    setDone(false);
  }, [id]);
  const rows = [...(first.data ?? []), ...more.filter((m) => !(first.data ?? []).some((f) => f.hash === m.hash))];
  const canMore = !done && (first.data?.length ?? 0) >= HISTORY_PAGE;
  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const next = await api.getTransactions({ account: id, limit: HISTORY_PAGE, beforeLedger: last.ledgerSeq });
      setMore((m) => [...m, ...next]);
      if (next.length < HISTORY_PAGE) setDone(true);
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <Card title="History" subtitle="Transactions that touched this account" icon={History} bodyClass="p-0">
      {first.loading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (
        <TxTable txs={rows} empty="No transactions for this account yet." />
      )}
      {canMore ? (
        <div className="border-t border-line p-3 text-center">
          <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>
            Load older
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export function AccountPage({ id }: { id: string }) {
  const api = useApi();
  const closeCounter = useNodeState((s) => s.closeCounter);
  const { data: acc, loading, error } = useAsync(() => api.getAccount(id), [id, api, closeCounter]);
  const nameOf = useNameOf();
  const known = nameOf(id);
  const { keys, fund } = useWallet();
  const mine = keys.some((k) => k.publicKey === id);
  const [funding, setFunding] = useState(false);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-3">
            <Identicon value={id} size={32} />
            <span className="truncate">{known ? known.name : 'Account'}</span>
            {mine ? <Badge tone="ledger">in your wallet</Badge> : known?.kind === 'validator' || known?.kind === 'self' ? <Badge tone="consensus">validator key</Badge> : null}
          </span>
        }
        actions={
          mine ? (
            <a href={href.wallet()} className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-raised px-3.5 text-sm font-medium hover:bg-hover">
              <Wallet aria-hidden className="size-4" /> Open in wallet
            </a>
          ) : null
        }
      >
        <div className="mt-1.5 text-sm text-fg-2">
          <HashText value={id} full />
        </div>
      </PageHeader>
      <ExplorerNav active="none" />
      {error ? <ErrorNote>{error.message}</ErrorNote> : null}
      {loading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : !acc ? (
        <div className="flex flex-col gap-4 sm:gap-5">
          <Card>
            <EmptyState
              icon={UserRound}
              title="Account not found"
              action={
                mine ? (
                  <Button
                    variant="primary"
                    icon={Droplets}
                    loading={funding}
                    onClick={async () => {
                      setFunding(true);
                      try {
                        await fund(id);
                      } finally {
                        setFunding(false);
                      }
                    }}
                  >
                    Fund with friendbot
                  </Button>
                ) : null
              }
            >
              Accounts exist once someone sends them at least 1 XLM. {mine ? 'This key is in your wallet, so friendbot can create it.' : ''}
            </EmptyState>
          </Card>
          <AccountHistory id={id} />
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:gap-5">
          <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
            <Card title="Balances" subtitle={plural(acc.balances.length, 'asset')} icon={Coins} iconClass="text-ledger" className="lg:col-span-7" bodyClass="p-0">
              <TableWrap>
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr>
                      <th className={TH}>Asset</th>
                      <th className={cx(TH, 'text-right')}>Balance</th>
                      <th className={cx(TH, 'text-right')}>Available</th>
                      <th className={cx(TH, 'text-right')}>Limit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acc.balances.map((b) => (
                      <tr key={`${b.asset.code}:${b.asset.issuer ?? ''}`} className="border-t border-line">
                        <td className={TD}>
                          <span className="flex flex-wrap items-center gap-2">
                            <AssetLabel asset={b.asset} />
                            {b.asset.type !== 'native' && !b.authorized ? <Badge tone="warn">not authorized</Badge> : null}
                          </span>
                        </td>
                        <td className={cx(TD, 'text-right font-medium tabular-nums')}>{formatAmount(b.balance)}</td>
                        <td className={cx(TD, 'text-right tabular-nums text-fg-2')}>
                          {b.asset.type === 'native' ? formatAmount(acc.availableBalance) : formatAmount(available(b.balance, b.sellingLiabilities))}
                        </td>
                        <td className={cx(TD, 'text-right tabular-nums text-fg-3')}>{b.limit ? (Number(b.limit) > 9e11 ? 'max' : formatAmount(b.limit)) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
            <Card title="Account" icon={KeyRound} className="lg:col-span-5">
              <Facts
                items={[
                  { label: 'Sequence', value: <span className="font-mono text-xs">{acc.sequence}</span> },
                  { label: 'Subentries', value: <span className="tabular-nums">{acc.numSubEntries}</span> },
                  { label: 'Minimum balance', value: <span className="tabular-nums">{formatAmount(acc.minBalance)} XLM</span> },
                  { label: 'Spendable XLM', value: <span className="tabular-nums">{formatAmount(acc.availableBalance)} XLM</span> },
                  { label: 'Home domain', value: acc.homeDomain || <span className="text-fg-3">none</span> },
                  { label: 'Last modified', value: <a className="tabular-nums hover:text-ledger" href={href.ledger(acc.lastModifiedLedger)}>#{formatNumber(acc.lastModifiedLedger)}</a> },
                  {
                    label: 'Flags',
                    wide: true,
                    value: (
                      <span className="flex flex-wrap gap-1.5">
                        {acc.flags.authRequired ? <Badge>auth required</Badge> : null}
                        {acc.flags.authRevocable ? <Badge>auth revocable</Badge> : null}
                        {acc.flags.authImmutable ? <Badge>auth immutable</Badge> : null}
                        {acc.flags.authClawbackEnabled ? <Badge>clawback</Badge> : null}
                        {!Object.values(acc.flags).some(Boolean) ? <span className="text-fg-3">none</span> : null}
                      </span>
                    ),
                  },
                ]}
              />
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
            <Card title="Signers and thresholds" icon={Shield}>
              <div className="grid grid-cols-4 gap-2 text-center">
                {[
                  ['Master', acc.thresholds.masterWeight],
                  ['Low', acc.thresholds.low],
                  ['Medium', acc.thresholds.med],
                  ['High', acc.thresholds.high],
                ].map(([label, v]) => (
                  <div key={label} className="rounded-lg border border-line bg-raised px-2 py-2">
                    <p className="text-[11px] text-fg-3">{label}</p>
                    <p className="mt-0.5 font-semibold tabular-nums">{v}</p>
                  </div>
                ))}
              </div>
              <ul className="mt-4 divide-y divide-line">
                {acc.signers.map((s) => (
                  <li key={s.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                    {s.key.startsWith('G') ? <AccountLink id={s.key} /> : <HashText value={s.key} head={6} tail={6} />}
                    <span className="shrink-0 text-xs text-fg-3">
                      weight <span className="font-medium tabular-nums text-fg">{s.weight}</span>
                      {s.key === id ? ' · master key' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Data entries" subtitle={plural(acc.data.length, 'entry', 'entries')} icon={Database} bodyClass={acc.data.length ? 'p-0' : undefined}>
              {acc.data.length === 0 ? (
                <p className="text-sm text-fg-3">No data entries.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {acc.data.map((d) => (
                    <li key={d.name} className="grid grid-cols-1 gap-1 px-4 py-2.5 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-4">
                      <span className="truncate font-mono text-xs text-fg-3">{d.name}</span>
                      <span className="min-w-0 [overflow-wrap:anywhere]">{d.valueText ?? <span className="font-mono text-xs text-fg-2">{d.valueBase64}</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
            <Card title="Open offers" subtitle={plural(acc.offers.length, 'offer')} icon={ArrowLeftRight} iconClass="text-network" bodyClass="p-0">
              {acc.offers.length === 0 ? (
                <p className="p-4 text-sm text-fg-3">No open offers.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {acc.offers.map((o) => (
                    <li key={o.offerId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        Sell <span className="font-medium tabular-nums">{formatAmount(o.amount)}</span> <AssetLabel asset={o.selling} issuer={false} /> for{' '}
                        <AssetLabel asset={o.buying} issuer={false} />
                      </span>
                      <span className="text-xs text-fg-3">
                        @ <span className="tabular-nums text-fg">{formatAmount(o.price)}</span> · #{o.offerId}
                        {o.passive ? ' · passive' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Claimable balances" subtitle={plural(acc.claimableBalances.length, 'balance')} icon={Gift} iconClass="text-ledger" bodyClass="p-0">
              {acc.claimableBalances.length === 0 ? (
                <p className="p-4 text-sm text-fg-3">No claimable balances for or from this account.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {acc.claimableBalances.map((c) => (
                    <li key={c.balanceId} className="px-4 py-2.5 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5">
                          <span className="font-medium tabular-nums">{formatAmount(c.amount)}</span> <AssetLabel asset={c.asset} issuer={false} />
                        </span>
                        <span className="text-xs text-fg-3">
                          from <AccountLink id={c.sponsor} size={14} />
                        </span>
                      </div>
                      <ul className="mt-1.5 flex flex-col gap-1 text-xs text-fg-3">
                        {c.claimants.map((cl) => (
                          <li key={cl.destination} className="flex flex-wrap items-center gap-1.5">
                            <AccountLink id={cl.destination} size={14} /> <span>{describePredicate(cl.predicate)}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <AccountHistory id={id} />
        </div>
      )}
    </div>
  );
}
