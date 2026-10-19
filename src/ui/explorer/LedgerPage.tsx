import { Blocks, ChevronLeft, ChevronRight, Clock, FileCode2, Zap } from 'lucide-react';
import { HashText } from '../components/Hash';
import { LedgerLink, NodeName } from '../components/links';
import { CloseTimeAgo } from '../components/TimeAgo';
import { Badge, Card, EmptyState, ErrorNote, Facts, PageHeader, Skeleton, TableWrap, TD, TH, cx } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { formatAmount, formatNumber, formatTimeOfDay, formatUtc, plural } from '../lib/format';
import { href } from '../lib/route';
import { useApi, useNodeState } from '../state/NodeProvider';
import { ExplorerNav, TxTable, XdrPanel } from './common';

export function LedgerPage({ seq }: { seq: number }) {
  const api = useApi();
  const lcl = useNodeState((s) => s.status?.lcl.seq ?? 0);
  // Keep polling (on each close) while the ledger does not exist yet.
  const waiting = lcl > 0 && seq > lcl;
  const { data, loading, error } = useAsync(() => api.getLedger(seq), [seq, api, waiting ? lcl : 0]);

  const nav = (
    <div className="flex items-center gap-1">
      <a
        href={seq > 1 ? href.ledger(seq - 1) : undefined}
        aria-disabled={seq <= 1}
        className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-line-strong bg-raised px-2.5 text-xs font-medium hover:bg-hover', seq <= 1 && 'pointer-events-none opacity-40')}
      >
        <ChevronLeft aria-hidden className="size-3.5" /> #{formatNumber(Math.max(1, seq - 1))}
      </a>
      <a
        href={seq < lcl ? href.ledger(seq + 1) : undefined}
        aria-disabled={seq >= lcl}
        className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-line-strong bg-raised px-2.5 text-xs font-medium hover:bg-hover', seq >= lcl && 'pointer-events-none opacity-40')}
      >
        #{formatNumber(seq + 1)} <ChevronRight aria-hidden className="size-3.5" />
      </a>
    </div>
  );

  return (
    <div>
      <PageHeader title={`Ledger #${formatNumber(seq)}`} icon={Blocks} actions={nav}>
        {data ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-fg-2">
            <Clock aria-hidden className="size-3.5 text-fg-3" />
            {data.closeTime ? (
              <>
                {formatUtc(data.closeTime)} · <CloseTimeAgo seconds={data.closeTime} />
              </>
            ) : (
              'Genesis ledger'
            )}
          </p>
        ) : null}
      </PageHeader>
      <ExplorerNav active="none" />
      {error ? <ErrorNote>{error.message}</ErrorNote> : null}
      {loading && !data ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : !data ? (
        <Card>
          <EmptyState icon={Blocks} title={waiting ? `Ledger #${formatNumber(seq)} has not closed yet` : `Ledger #${formatNumber(seq)} is not available`}>
            {waiting
              ? `The network is at ledger #${formatNumber(lcl)}. This page updates when it closes.`
              : 'This node does not have it. It may be older than the history this node keeps.'}
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-4 sm:gap-5">
          <div className="grid grid-cols-1 items-start gap-4 sm:gap-5 lg:grid-cols-12">
            <Card title="Summary" icon={Blocks} iconClass="text-ledger" className="lg:col-span-7">
              <Facts
                items={[
                  { label: 'Hash', value: <HashText value={data.hash} full />, wide: true },
                  { label: 'Previous ledger', value: data.seq > 1 ? <span className="inline-flex items-center gap-2"><LedgerLink seq={data.seq - 1} /><HashText value={data.prevHash} head={6} tail={4} /></span> : 'none', wide: true },
                  {
                    label: 'Transactions',
                    value: (
                      <span className="tabular-nums">
                        {formatNumber(data.txCount)} ({plural(data.opCount, 'operation')})
                        {data.failedTxCount ? <span className="ml-1 text-bad">· {data.failedTxCount} failed</span> : null}
                      </span>
                    ),
                  },
                  { label: 'Agreed by', value: data.externalizedBy ? plural(data.externalizedBy, 'validator') : 'replayed from history' },
                  { label: 'Proposed by', value: data.proposer ? <NodeName id={data.proposer} /> : <span className="text-fg-3">–</span> },
                  { label: 'Closed here', value: data.closedAt ? <span className="tabular-nums">{formatTimeOfDay(data.closedAt)}</span> : '–' },
                  { label: 'Fee pool', value: <span className="tabular-nums">{formatAmount(data.feePool)} XLM</span> },
                  { label: 'Total coins', value: <span className="tabular-nums">{formatAmount(data.totalCoins)} XLM</span> },
                  { label: 'Base fee / reserve', value: <span className="tabular-nums">{data.baseFee} stroops / {formatAmount((data.baseReserve / 1e7).toFixed(7))} XLM</span> },
                  { label: 'Protocol', value: <Badge>v{data.protocolVersion}</Badge> },
                  { label: 'Tx set hash', value: <HashText value={data.txSetHash} head={10} tail={8} />, wide: true },
                  { label: 'State hash', value: <HashText value={data.stateHash} head={10} tail={8} />, wide: true },
                ]}
              />
            </Card>
            <Card title="Header fields" subtitle="As stored in the ledger header" icon={FileCode2} className="lg:col-span-5" bodyClass="p-0">
              <TableWrap>
                <table className="w-full text-sm">
                  <thead className="sr-only">
                    <tr>
                      <th className={TH}>Field</th>
                      <th className={TH}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.header).map(([k, v]) => (
                      <tr key={k} className="border-b border-line last:border-0">
                        <td className={cx(TD, 'w-2/5 align-top font-mono text-xs text-fg-3')}>{k}</td>
                        <td className={cx(TD, 'font-mono text-xs text-fg-2 [overflow-wrap:anywhere]')}>{String(v) || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          </div>
          <Card title="Transactions" subtitle={plural(data.txs.length, 'transaction')} icon={Zap} iconClass="text-ledger" bodyClass="p-0">
            <TxTable txs={data.txs} showLedger={false} empty="This ledger has no transactions." />
          </Card>
          <XdrPanel title="Ledger header" xdr={data.headerXdr} type="LedgerHeader" />
        </div>
      )}
    </div>
  );
}
