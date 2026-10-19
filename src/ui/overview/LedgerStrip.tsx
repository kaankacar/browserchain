import { ArrowRight, Blocks } from 'lucide-react';
import { Identicon } from '../components/Identicon';
import { CloseTimeAgo } from '../components/TimeAgo';
import { Card, cx, Skeleton } from '../components/ui';
import { formatDuration, formatNumber } from '../lib/format';
import { href } from '../lib/route';
import { useNodeState } from '../state/NodeProvider';

export function LedgerStrip() {
  const ledgers = useNodeState((s) => s.ledgers);
  const names = useNodeState((s) => s.validators);
  const recent = ledgers.slice(0, 14);
  const maxTx = Math.max(1, ...recent.map((l) => l.txCount));
  const nameOf = (id: string | null) => (id ? (names.find((v) => v.nodeId === id)?.name ?? null) : null);

  return (
    <Card
      title="Recent ledgers"
      icon={Blocks}
      iconClass="text-ledger"
      bodyClass="p-0"
      actions={
        <a href={href.ledgers()} className="inline-flex items-center gap-1 text-xs font-medium text-fg-3 hover:text-fg">
          All ledgers <ArrowRight aria-hidden className="size-3" />
        </a>
      }
    >
      {/* No scroll snapping here: on a new ledger the browser re-snaps to the
          card it showed, which pushed the newest card out of view. */}
      <ol
        className="flex gap-3 overflow-x-auto p-4 [mask-image:linear-gradient(to_right,black_calc(100%-48px),transparent)]"
        aria-label="Most recent ledgers, newest first"
      >
        {recent.length === 0
          ? Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="shrink-0">
                <Skeleton className="h-[118px] w-40" />
              </li>
            ))
          : recent.map((l, i) => {
              const prev = recent[i + 1];
              // Local close times only mean something for ledgers closed by
              // consensus here; replayed ones (catch-up) close ms apart, so use
              // the network's close times (whole seconds) for those.
              const replayed = !l.externalizedBy || !prev?.externalizedBy;
              const interval = !prev
                ? null
                : replayed
                  ? prev.closeTime && l.closeTime
                    ? (l.closeTime - prev.closeTime) * 1000
                    : null
                  : prev.closedAt && l.closedAt
                    ? l.closedAt - prev.closedAt
                    : null;
              const proposer = nameOf(l.proposer);
              return (
                <li key={l.seq} className={cx('shrink-0', i === 0 && 'animate-slide-in')}>
                  <a
                    href={href.ledger(l.seq)}
                    className={cx(
                      'group flex w-40 flex-col gap-2 rounded-xl border bg-raised p-3 transition-colors hover:border-ledger-fill/60',
                      i === 0 ? 'border-ledger-fill/50 shadow-glow' : 'border-line',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold tabular-nums text-fg group-hover:text-ledger">#{formatNumber(l.seq)}</span>
                      <span className="text-[11px] text-fg-3">{l.closeTime ? <CloseTimeAgo seconds={l.closeTime} /> : 'genesis'}</span>
                    </div>
                    <div>
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="text-fg-2">
                          <span className="font-medium tabular-nums text-fg">{l.txCount}</span> tx{l.txCount === 1 ? '' : 's'}
                          {l.failedTxCount ? <span className="ml-1 text-bad">· {l.failedTxCount} failed</span> : null}
                        </span>
                        <span className="tabular-nums text-fg-3">{l.opCount} ops</span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line" aria-hidden>
                        <div className="h-full rounded-full bg-ledger-fill" style={{ width: `${(l.txCount / maxTx) * 100}%` }} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-fg-3">
                      <span className="flex min-w-0 items-center gap-1">
                        {l.proposer ? <Identicon value={l.proposer} size={14} /> : null}
                        <span className="truncate">{proposer ?? (l.seq === 1 ? 'genesis' : '—')}</span>
                      </span>
                      <span className="shrink-0 tabular-nums" title={replayed ? 'Interval of the network close times (this node replayed the ledger)' : 'Time between closes on this node'}>
                        {interval !== null && interval > 0 && interval < 600_000 ? (replayed ? `${Math.round(interval / 1000)} s` : formatDuration(interval)) : ''}
                      </span>
                    </div>
                  </a>
                </li>
              );
            })}
      </ol>
    </Card>
  );
}
