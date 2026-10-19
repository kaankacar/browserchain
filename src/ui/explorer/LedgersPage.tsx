import { Blocks } from 'lucide-react';
import type { LedgerSummary } from '../../node/api';
import { HashText } from '../components/Hash';
import { NodeName } from '../components/links';
import { CloseTimeAgo } from '../components/TimeAgo';
import { Card, cx, ErrorNote, PageHeader, Skeleton, TD, TH } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { formatNumber, formatUtc } from '../lib/format';
import { newerLedgerPage } from '../lib/paging';
import { href } from '../lib/route';
import { useApi, useNodeState } from '../state/NodeProvider';
import { ExplorerNav, Pager } from './common';

const PAGE = 20;

function Rows({ ledgers, live }: { ledgers: LedgerSummary[]; live: boolean }) {
  return (
    <>
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr>
            <th className={TH}>Ledger</th>
            <th className={TH}>Closed</th>
            <th className={cx(TH, 'text-right')}>Txs</th>
            <th className={cx(TH, 'text-right')}>Ops</th>
            <th className={TH}>Proposed by</th>
            <th className={cx(TH, 'text-right')}>Agreed by</th>
            <th className={TH}>Hash</th>
          </tr>
        </thead>
        <tbody>
          {ledgers.map((l, i) => (
            <tr key={l.seq} className={cx('border-t border-line hover:bg-hover/50', live && i === 0 && 'animate-flash')}>
              <td className={TD}>
                <a href={href.ledger(l.seq)} className="font-semibold tabular-nums text-fg hover:text-ledger">
                  #{formatNumber(l.seq)}
                </a>
              </td>
              <td className={cx(TD, 'text-fg-2')} title={formatUtc(l.closeTime)}>
                {l.closeTime ? <CloseTimeAgo seconds={l.closeTime} /> : 'genesis'}
              </td>
              <td className={cx(TD, 'text-right tabular-nums')}>
                {l.txCount}
                {l.failedTxCount ? <span className="ml-1 text-xs text-bad">({l.failedTxCount} failed)</span> : null}
              </td>
              <td className={cx(TD, 'text-right tabular-nums text-fg-2')}>{l.opCount}</td>
              <td className={TD}>{l.proposer ? <NodeName id={l.proposer} /> : <span className="text-fg-3">–</span>}</td>
              <td className={cx(TD, 'text-right tabular-nums text-fg-2')}>{l.externalizedBy || <span className="text-fg-3">replayed</span>}</td>
              <td className={TD}>
                <HashText value={l.hash} head={8} tail={6} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-line md:hidden">
        {ledgers.map((l) => (
          <li key={l.seq} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <a href={href.ledger(l.seq)} className="font-semibold tabular-nums text-fg hover:text-ledger">
                #{formatNumber(l.seq)}
              </a>
              <p className="mt-0.5 truncate font-mono text-xs text-fg-3">{l.hash.slice(0, 16)}…</p>
            </div>
            <div className="shrink-0 text-right text-xs">
              <p className="text-fg-2">
                <span className="font-medium tabular-nums text-fg">{l.txCount}</span> txs · {l.opCount} ops
              </p>
              <p className="mt-0.5 text-fg-3">{l.closeTime ? <CloseTimeAgo seconds={l.closeTime} /> : 'genesis'}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function LedgersPage({ before }: { before?: number }) {
  const api = useApi();
  const live = useNodeState((s) => s.ledgers);
  const newest = useNodeState((s) => s.status?.lcl.seq ?? 0);
  const older = useAsync(() => (before ? api.getLedgers({ limit: PAGE, beforeSeq: before }) : Promise.resolve(null)), [before, api]);
  const ledgers = before ? (older.data ?? []) : live.slice(0, PAGE);
  const last = ledgers[ledgers.length - 1]?.seq ?? 0;
  const newer = newerLedgerPage(before, PAGE, newest);
  const newerHref = newer === null ? null : newer === 'latest' ? href.ledgers() : href.ledgers(newer);
  const olderHref = last > 1 ? href.ledgers(last) : null;

  return (
    <div>
      <PageHeader title="Explorer" icon={Blocks} description="Every ledger this node has closed or downloaded, with its transactions." />
      <ExplorerNav active="ledgers" />
      <Card
        title={before ? `Ledgers before #${formatNumber(before)}` : 'Latest ledgers'}
        subtitle={before ? undefined : 'Updates live as ledgers close'}
        icon={Blocks}
        iconClass="text-ledger"
        bodyClass="p-0"
      >
        {older.error ? <ErrorNote className="m-4">{older.error.message}</ErrorNote> : null}
        {ledgers.length === 0 && (older.loading || !before) ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : (
          <Rows ledgers={ledgers} live={!before} />
        )}
        <Pager label="Ledger pages" newer={newerHref} older={olderHref} />
      </Card>
    </div>
  );
}
