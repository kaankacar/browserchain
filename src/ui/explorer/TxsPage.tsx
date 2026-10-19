import { ChevronRight, RotateCcw, Zap } from 'lucide-react';
import { Card, ErrorNote, PageHeader, Skeleton, cx } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { formatNumber } from '../lib/format';
import { href } from '../lib/route';
import { useApi, useNodeState } from '../state/NodeProvider';
import { ExplorerNav, TxTable } from './common';
import { pageOf } from '../lib/paging';

const LIMIT = 25;

export function TxsPage({ before }: { before?: number }) {
  const api = useApi();
  const closeCounter = useNodeState((s) => s.closeCounter);
  const { data, loading, error } = useAsync(() => api.getTransactions({ limit: LIMIT, beforeLedger: before }), [before, api, before ? 0 : closeCounter]);
  const { shown, olderBefore } = pageOf(data ?? [], LIMIT);
  const link = 'inline-flex h-8 items-center gap-1 rounded-lg border border-line-strong bg-raised px-3 text-xs font-medium text-fg hover:bg-hover';

  return (
    <div>
      <PageHeader title="Explorer" icon={Zap} description="Transactions from every account, newest first." />
      <ExplorerNav active="txs" />
      <Card
        title={before ? `Transactions before ledger #${formatNumber(before)}` : 'Latest transactions'}
        subtitle={before ? undefined : 'Updates live as ledgers close'}
        icon={Zap}
        iconClass="text-ledger"
        bodyClass="p-0"
      >
        {error ? <ErrorNote className="m-4">{error.message}</ErrorNote> : null}
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : (
          <TxTable txs={shown} empty="No transactions yet. Fund an account in the wallet to make one." />
        )}
        <nav aria-label="Transaction pages" className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <a href={before ? href.txs() : undefined} aria-disabled={!before} className={cx(link, !before && 'pointer-events-none opacity-40')}>
            <RotateCcw aria-hidden className="size-3.5" /> Latest
          </a>
          <a href={olderBefore ? href.txs(olderBefore) : undefined} aria-disabled={!olderBefore} className={cx(link, !olderBefore && 'pointer-events-none opacity-40')}>
            Older <ChevronRight aria-hidden className="size-3.5" />
          </a>
        </nav>
      </Card>
    </div>
  );
}
