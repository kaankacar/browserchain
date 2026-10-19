import { ArrowLeftRight, Coins } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AccountLink, AssetLabel } from '../components/links';
import { Badge, Card, cx, EmptyState, ErrorNote, Input, PageHeader, Skeleton, TableWrap, TD, TH } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { assetKey, formatAmount, formatNumber, plural } from '../lib/format';
import { href } from '../lib/route';
import { writePref } from '../lib/wallet';
import { useApi, useNodeState } from '../state/NodeProvider';
import { ExplorerNav } from './common';

export function AssetsPage() {
  const api = useApi();
  const closeCounter = useNodeState((s) => s.closeCounter);
  const { data, loading, error } = useAsync(() => api.getAssets(), [api, closeCounter]);
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return (data ?? []).filter((a) => !needle || a.asset.code.toUpperCase().includes(needle) || (a.asset.issuer ?? '').includes(needle));
  }, [data, q]);

  return (
    <div>
      <PageHeader title="Explorer" icon={Coins} description="Assets issued on this network. Anyone can issue one from the wallet." />
      <ExplorerNav active="assets" />
      <Card
        title="Assets"
        subtitle={data ? plural(data.length, 'issued asset') : undefined}
        icon={Coins}
        iconClass="text-ledger"
        bodyClass="p-0"
        actions={
          <>
            <label htmlFor="asset-filter" className="sr-only">
              Filter assets
            </label>
            <Input id="asset-filter" placeholder="Filter by code or issuer" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-52 text-xs" />
          </>
        }
      >
        {error ? <ErrorNote className="m-4">{error.message}</ErrorNote> : null}
        {loading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Coins} title={data?.length ? 'No asset matches' : 'No assets yet'}>
            Issue one from the wallet: it takes three small transactions.
          </EmptyState>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr>
                  <th className={TH}>Asset</th>
                  <th className={TH}>Issuer</th>
                  <th className={cx(TH, 'text-right')}>Holders</th>
                  <th className={cx(TH, 'text-right')}>Supply</th>
                  <th className={TH}>Issuer flags</th>
                  <th className={TH}>
                    <span className="sr-only">Trade</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={assetKey(a.asset)} className="border-t border-line">
                    <td className={TD}>
                      <AssetLabel asset={a.asset} issuer={false} />
                    </td>
                    <td className={TD}>
                      <AccountLink id={a.asset.issuer ?? ''} />
                    </td>
                    <td className={cx(TD, 'text-right tabular-nums')}>{formatNumber(a.holders)}</td>
                    <td className={cx(TD, 'text-right tabular-nums')}>{formatAmount(a.supply, { maxDecimals: 2 })}</td>
                    <td className={TD}>
                      <span className="flex flex-wrap gap-1">
                        {a.issuerFlags.authRequired ? <Badge>auth required</Badge> : null}
                        {a.issuerFlags.authRevocable ? <Badge>revocable</Badge> : null}
                        {a.issuerFlags.authClawbackEnabled ? <Badge>clawback</Badge> : null}
                        {!a.issuerFlags.authRequired && !a.issuerFlags.authRevocable && !a.issuerFlags.authClawbackEnabled ? <span className="text-fg-3">open</span> : null}
                      </span>
                    </td>
                    <td className={cx(TD, 'text-right')}>
                      <a
                        href={href.wallet('trade')}
                        onClick={() => writePref('browserchain:trade:pair', { base: assetKey(a.asset), counter: 'XLM' })}
                        className="inline-flex items-center gap-1 text-xs font-medium text-ledger hover:underline"
                      >
                        <ArrowLeftRight aria-hidden className="size-3.5" /> Trade
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
