import { ArrowRight, Box } from 'lucide-react';
import { HashText } from '../components/Hash';
import { NodeName } from '../components/links';
import { RingArc } from '../components/RingArc';
import { StateBadge } from '../components/StateBadge';
import { TimeAgo } from '../components/TimeAgo';
import { Card, Skeleton } from '../components/ui';
import { selfState } from '../lib/catchup';
import { formatDuration, formatNumber, formatUtc, plural } from '../lib/format';
import { href } from '../lib/route';
import { useNodeState } from '../state/NodeProvider';

const SIZE = 240;
const R = 104;
const STROKE = 10;

function Ticks() {
  // One tick per second of the 5 s target interval.
  return (
    <g>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        const x1 = SIZE / 2 + Math.cos(a) * (R + 12);
        const y1 = SIZE / 2 + Math.sin(a) * (R + 12);
        const x2 = SIZE / 2 + Math.cos(a) * (R + 17);
        const y2 = SIZE / 2 + Math.sin(a) * (R + 17);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--bc-line-strong)" strokeWidth={2} strokeLinecap="round" />;
      })}
    </g>
  );
}

export function LedgerRing() {
  const lcl = useNodeState((s) => s.status?.lcl ?? null);
  const state = useNodeState((s) => selfState(s.status));
  const catchup = useNodeState((s) => s.status?.catchup ?? null);
  // the average is 0 until two ledgers closed: a 0 ms ring would look full at once
  const avg = useNodeState((s) => s.stats?.avgCloseIntervalMs || 5000);
  const closeCounter = useNodeState((s) => s.closeCounter);
  const synced = state === 'synced' || state === 'stalled';
  const blocked = state === 'blocked';

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[250px]">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 size-full -rotate-90" aria-hidden>
        <Ticks />
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--bc-line)" strokeWidth={STROKE} />
        {lcl && synced ? (
          <RingArc key={lcl.seq} closedAt={lcl.closedAt} durationMs={avg} r={R} center={SIZE / 2} strokeWidth={STROKE} color={state === 'stalled' ? 'var(--bc-bad)' : undefined} />
        ) : null}
        {!synced ? (
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke={blocked ? 'var(--bc-bad)' : 'var(--bc-network)'}
            strokeWidth={STROKE}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={catchup ? `${Math.max(0.04, catchup.current / Math.max(1, catchup.target))} 1` : '0.22 1'}
            className={catchup ? undefined : 'origin-center animate-spin [animation-duration:1.6s]'}
          />
        ) : null}
      </svg>
      {closeCounter > 0 ? <span key={closeCounter} aria-hidden className="animate-ring-pulse absolute inset-[6%] rounded-full border-2 border-ledger-fill" /> : null}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-3">
          {synced ? 'Ledger' : blocked ? 'Not voting' : state === 'catching-up' ? 'Catching up' : 'Starting'}
        </span>
        {lcl ? (
          <span key={lcl.seq} className="animate-pop mt-0.5 text-5xl font-semibold tracking-tight text-fg">
            {formatNumber(lcl.seq)}
          </span>
        ) : (
          <Skeleton className="mt-2 h-12 w-32" />
        )}
        <span className="mt-1 h-4 text-xs text-fg-3">
          {catchup && blocked ? (
            `peers at #${formatNumber(catchup.target)}`
          ) : catchup ? (
            `${formatNumber(catchup.current)} of ${formatNumber(catchup.target)}`
          ) : lcl && lcl.closedAt > 0 ? (
            <>
              closed <TimeAgo ms={lcl.closedAt} />
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function LedgerHero() {
  const lcl = useNodeState((s) => s.status?.lcl ?? null);
  const state = useNodeState((s) => selfState(s.status));
  const avg = useNodeState((s) => s.stats?.avgCloseIntervalMs ?? null);

  return (
    <Card
      title="Last closed ledger"
      icon={Box}
      iconClass="text-ledger"
      actions={<StateBadge state={state} />}
      fill
      bodyClass="gap-5 p-5 justify-center sm:flex-row sm:items-center lg:flex-col xl:flex-row"
    >
      <div className="w-[min(250px,70vw)] shrink-0 self-center">
        <LedgerRing />
      </div>
      <div className="min-w-0 flex-1">
        {lcl ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div className="col-span-2 min-w-0">
              <dt className="text-xs text-fg-3">Hash</dt>
              <dd className="mt-0.5">
                <HashText value={lcl.hash} head={8} tail={8} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-fg-3">Transactions</dt>
              <dd className="mt-0.5 font-medium tabular-nums">
                {formatNumber(lcl.txCount)}
                {lcl.failedTxCount ? <span className="ml-1 text-xs font-normal text-bad">({lcl.failedTxCount} failed)</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-fg-3">Operations</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{formatNumber(lcl.opCount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-3" title="Average of the recent ledger close intervals">Avg interval</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{avg ? formatDuration(avg) : '–'}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-3">Agreed by</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{lcl.externalizedBy ? plural(lcl.externalizedBy, 'validator') : 'replayed'}</dd>
            </div>
            <div className="col-span-2 min-w-0">
              <dt className="text-xs text-fg-3">Proposed by</dt>
              <dd className="mt-0.5">{lcl.proposer ? <NodeName id={lcl.proposer} /> : <span className="text-fg-3">genesis</span>}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-fg-3">Close time</dt>
              <dd className="mt-0.5 tabular-nums text-fg-2">{lcl.closeTime ? formatUtc(lcl.closeTime) : 'genesis'}</dd>
            </div>
            <div className="col-span-2">
              <a href={href.ledger(lcl.seq)} className="inline-flex items-center gap-1 text-sm font-medium text-ledger hover:underline">
                Open ledger <ArrowRight aria-hidden className="size-3.5" />
              </a>
            </div>
          </dl>
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-40" />
          </div>
        )}
      </div>
    </Card>
  );
}
