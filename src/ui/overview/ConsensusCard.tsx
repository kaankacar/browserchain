import { ArrowRight, Orbit, Users } from 'lucide-react';
import type { ScpSlotView } from '../../node/api';
import { NodeName } from '../components/links';
import { Badge, Card, cx, Skeleton } from '../components/ui';
import { slotIdle, slotProgress } from '../lib/consensus';
import { formatBallotCounter, formatNumber } from '../lib/format';
import { href } from '../lib/route';
import { useNodeState } from '../state/NodeProvider';
import { PHASES, phaseIndex, STATEMENT_LABEL, statementRank } from './phases';

// Phones: the name column fits a default name ("node-WWWW", 80 px at 12 px) next to its identicon.
const GRID = 'grid grid-cols-[minmax(0,6.75rem)_repeat(4,minmax(0,1fr))] sm:grid-cols-[minmax(0,13rem)_repeat(4,minmax(0,1fr))]';

function Stepper({ slot, waiting }: { slot: ScpSlotView; waiting: boolean }) {
  const current = phaseIndex(slot.phase);
  const done = slot.externalized !== null;
  return (
    <ol className={GRID} aria-label="SCP phases for this slot">
      <li aria-hidden />
      {PHASES.map((p, i) => {
        const reached = !waiting && i <= current;
        const active = !waiting && i === current && !done;
        return (
          <li key={p.phase} className="relative flex flex-col items-center text-center" aria-current={active ? 'step' : undefined}>
            {i > 0 ? (
              <span aria-hidden className={cx('absolute right-1/2 top-[15px] h-0.5 w-full sm:top-[17px]', reached ? p.bg : 'bg-line')} />
            ) : null}
            <span
              className={cx(
                'relative z-10 inline-flex size-8 items-center justify-center rounded-full border-2 transition-colors duration-300 sm:size-9',
                reached ? 'border-transparent text-canvas' : 'border-line-strong bg-panel text-fg-3',
                active && 'animate-dot-pulse',
              )}
              style={reached ? { backgroundColor: p.color, color: active ? 'var(--bc-canvas)' : undefined } : undefined}
            >
              <p.icon aria-hidden className="size-4" />
            </span>
            <span className={cx('mt-1.5 text-[10px] font-semibold tracking-tight sm:text-xs sm:tracking-normal', reached ? 'text-fg' : 'text-fg-3')}>{p.label}</span>
            <span className="hidden text-[11px] text-fg-3 md:block">{p.blurb}</span>
          </li>
        );
      })}
    </ol>
  );
}

function NodeRows({ slot, waiting, selfId }: { slot: ScpSlotView; waiting: boolean; selfId: string | null }) {
  return (
    <ul className="mt-4 divide-y divide-line border-t border-line" aria-label="Latest statement of each validator">
      {slot.nodes.map((n) => {
        const rank = waiting ? 0 : statementRank(n.statement);
        return (
          <li key={n.nodeId} className={cx(GRID, 'items-center py-2', n.nodeId === selfId && '-mx-2 rounded-lg bg-ledger-fill/6 px-2')} title={n.summary}>
            <div className="min-w-0 pr-1 sm:pr-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {/* smaller on phones: default names ("node-AB12") must not cut to the same "node-A…" */}
                <NodeName id={n.nodeId} size={18} className="text-xs sm:text-sm" you={false} />
                {n.nodeId === selfId ? (
                  <span className="hidden rounded bg-ledger-fill/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-ledger sm:inline">you</span>
                ) : null}
              </span>
              <p className="mt-0.5 hidden truncate font-mono text-[11px] text-fg-3 sm:block">{waiting ? 'waiting for nomination' : n.summary}</p>
            </div>
            {PHASES.map((p, i) => {
              const on = rank >= i + 1;
              const latest = rank === i + 1 && slot.externalized === null;
              return (
                <div key={p.phase} className="relative flex h-5 items-center justify-center">
                  {i > 0 ? (
                    <span aria-hidden className={cx('absolute right-1/2 top-1/2 h-0.5 w-full -translate-y-1/2', rank >= i + 1 ? p.bg : 'bg-transparent')} />
                  ) : null}
                  <span
                    aria-hidden
                    className={cx(
                      'relative z-10 inline-block rounded-full transition-all duration-300',
                      on ? 'size-3' : 'size-2.5 border border-line-strong bg-panel',
                      latest && 'animate-dot-pulse',
                    )}
                    style={on ? { backgroundColor: p.color, color: p.color } : undefined}
                  />
                </div>
              );
            })}
            <span className="sr-only">
              {n.name}: {STATEMENT_LABEL[n.statement]}
              {n.ballotCounter ? `, ballot ${formatBallotCounter(n.ballotCounter)}` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ConsensusCard() {
  const slot = useNodeState((s) => s.slot);
  const selfId = useNodeState((s) => s.status?.nodeId ?? null);
  const state = useNodeState((s) => s.status?.state ?? 'booting');
  const isValidator = useNodeState((s) => s.status?.isValidator ?? true);
  const proposerName = useNodeState((s) => {
    const p = s.slot?.externalized?.proposer ?? s.slot?.nomination.leaders[0] ?? null;
    return p ? (s.validators.find((v) => v.nodeId === p)?.name ?? null) : null;
  });
  const waiting = slotIdle(slot);
  const leaders = slot?.nomination.leaders ?? [];

  return (
    <Card
      title={slot ? `Consensus on slot #${formatNumber(slot.slot)}` : 'Consensus'}
      fill
      subtitle={slotProgress(slot, { state, isValidator })}
      icon={Orbit}
      iconClass="text-consensus"
      actions={
        <>
          {slot?.heardFromQuorum ? (
            <Badge tone="consensus" icon={Users}>
              heard from quorum
            </Badge>
          ) : null}
          <a href={href.validator('scp')} className="inline-flex items-center gap-1 text-xs font-medium text-fg-3 hover:text-fg">
            Inspect <ArrowRight aria-hidden className="size-3" />
          </a>
        </>
      }
    >
      {slot ? (
        <>
          <Stepper slot={slot} waiting={waiting} />
          <NodeRows slot={slot} waiting={waiting} selfId={selfId} />
          <div className="mt-3 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
            {slot.externalized ? (
              <>
                <span>
                  Externalized value <span className="font-mono text-fg">{slot.externalized.id}</span>
                </span>
                {slot.externalized.txCount !== null ? <span>{formatNumber(slot.externalized.txCount)} txs</span> : null}
                {proposerName ? <span>proposed by {proposerName}</span> : null}
              </>
            ) : leaders.length ? (
              <span className="flex min-w-0 items-center gap-1.5">
                Round leader{leaders.length > 1 ? 's' : ''}:
                {leaders.map((l) => (
                  <NodeName key={l} id={l} size={14} you={false} className="text-fg-2" />
                ))}
              </span>
            ) : (
              <span>Validators nominate about every 5 seconds.</span>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-5/6" />
        </div>
      )}
    </Card>
  );
}
