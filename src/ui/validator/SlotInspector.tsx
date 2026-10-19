import { ChevronLeft, ChevronRight, Microscope, Radio } from 'lucide-react';
import { useState } from 'react';
import type { BallotView, ScpSlotView, ValueView } from '../../node/api';
import { NodeName } from '../components/links';
import { TimeAgo } from '../components/TimeAgo';
import { Badge, Button, Card, cx, EmptyState, IconButton, Input, Skeleton, TableWrap, TD, TH } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { nominationLabel, slotIdle } from '../lib/consensus';
import { formatBallotCounter, formatDuration, formatNumber, formatUtc } from '../lib/format';
import { PHASES, phaseIndex, statementRank, STATEMENT_LABEL } from '../overview/phases';
import { useApi, useNodeState } from '../state/NodeProvider';

export function ValueChip({ v }: { v: ValueView }) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-line bg-raised px-2 py-1 text-xs">
      <span className="font-mono font-medium text-consensus">{v.id}</span>
      {v.txCount !== null ? <span className="text-fg-2">{formatNumber(v.txCount)} txs</span> : null}
      <span className="text-fg-3" title={formatUtc(v.closeTime)}>
        t={v.closeTime}
      </span>
      {v.proposer ? <NodeName id={v.proposer} size={14} you={false} className="text-fg-2" /> : null}
    </span>
  );
}

function ValueList({ label, values }: { label: string; values: ValueView[] }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-fg-3">
        {label} <span className="tabular-nums">({values.length})</span>
      </p>
      <div className="mt-1 flex flex-wrap gap-1.5">{values.length ? values.map((v) => <ValueChip key={v.id} v={v} />) : <span className="text-xs text-fg-3">none</span>}</div>
    </div>
  );
}

function BallotRow({ name, desc, b }: { name: string; desc: string; b: BallotView | null }) {
  return (
    <tr className="border-t border-line">
      <td className={cx(TD, 'font-mono text-xs font-semibold text-consensus')}>{name}</td>
      <td className={cx(TD, 'hidden text-xs text-fg-3 sm:table-cell')}>{desc}</td>
      <td className={cx(TD, 'tabular-nums')}>{b ? formatBallotCounter(b.counter) : <span className="text-fg-3">–</span>}</td>
      <td className={TD}>{b ? <ValueChip v={b.value} /> : <span className="text-xs text-fg-3">none</span>}</td>
    </tr>
  );
}

function SlotBody({ slot, isValidator }: { slot: ScpSlotView; isValidator: boolean }) {
  const p = PHASES[phaseIndex(slot.phase)];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="consensus" icon={p.icon}>
          {p.label}
        </Badge>
        <Badge>{nominationLabel(slot, isValidator)}</Badge>
        {slot.ballot ? <Badge>ballot {formatBallotCounter(slot.ballot.counter)}</Badge> : null}
        <Badge tone={slot.heardFromQuorum ? 'ok' : 'neutral'}>{slot.heardFromQuorum ? 'heard from quorum' : 'quorum not heard yet'}</Badge>
        <span className="text-fg-3">
          opened <TimeAgo ms={slot.startedAt} />
          {slot.externalizedAt ? ` · externalized after ${formatDuration(slot.externalizedAt - slot.startedAt)}` : ''}
        </span>
      </div>

      <section aria-label="Nomination">
        <h3 className="text-sm font-semibold">Nomination</h3>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs text-fg-3">Round leaders</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {slot.nomination.leaders.length ? (
                slot.nomination.leaders.map((l) => <NodeName key={l} id={l} size={16} className="text-sm" />)
              ) : (
                <span className="text-xs text-fg-3">not chosen yet</span>
              )}
            </div>
          </div>
          <ValueList label="Votes" values={slot.nomination.votes} />
          <ValueList label="Accepted" values={slot.nomination.accepted} />
          <ValueList label="Candidates" values={slot.nomination.candidates} />
        </div>
      </section>

      <section aria-label="Ballot protocol">
        <h3 className="text-sm font-semibold">Ballot protocol</h3>
        <TableWrap bleed className="mt-2">
          <table className="w-full text-sm sm:min-w-[520px]">
            <thead>
              <tr>
                <th className={TH}>Field</th>
                <th className={cx(TH, 'hidden sm:table-cell')}>Meaning</th>
                <th className={TH}>Counter</th>
                <th className={TH}>Value</th>
              </tr>
            </thead>
            <tbody>
              <BallotRow name="b" desc="current ballot" b={slot.ballot} />
              <BallotRow name="p" desc="highest accepted prepared" b={slot.prepared} />
              <BallotRow name="p'" desc="next prepared, other value" b={slot.preparedPrime} />
              <BallotRow name="h" desc="highest confirmed prepared" b={slot.high} />
              <BallotRow name="c" desc="lowest ballot to commit" b={slot.commit} />
            </tbody>
          </table>
        </TableWrap>
        {slot.externalized ? (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg-3">Externalized</span> <ValueChip v={slot.externalized} />
          </p>
        ) : null}
      </section>

      <section aria-label="Latest statement per validator">
        <h3 className="text-sm font-semibold">Latest statements</h3>
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
          {slot.nodes.map((n) => {
            const rank = statementRank(n.statement);
            const ph = rank ? PHASES[rank - 1] : null;
            return (
              <li key={n.nodeId} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                <NodeName id={n.nodeId} className="text-sm sm:w-44 sm:shrink-0" />
                <span className="inline-flex items-center gap-1.5 text-xs sm:w-28 sm:shrink-0">
                  <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: ph ? ph.color : 'var(--bc-line-strong)' }} />
                  {STATEMENT_LABEL[n.statement]}
                </span>
                <span className="min-w-0 truncate font-mono text-xs text-fg-2">{n.summary}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

export function SlotInspector() {
  const live = useNodeState((s) => s.slot);
  const isValidator = useNodeState((s) => s.status?.isValidator ?? true);
  const api = useApi();
  const [selected, setSelected] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const fetched = useAsync(() => (selected === null ? Promise.resolve(null) : api.getScpSlot(selected)), [selected, api]);
  const view = selected === null ? live : (fetched.data ?? null);
  const current = selected ?? live?.slot ?? null;

  const go = (n: number | null) => {
    setSelected(n === null || (live && n === live.slot) ? null : Math.max(1, n));
    setInput('');
  };

  return (
    <Card
      title={current ? `Slot #${formatNumber(current)}` : 'Slot inspector'}
      subtitle={selected === null ? 'Following the slot being decided now' : 'A recent slot from memory'}
      icon={Microscope}
      iconClass="text-consensus"
      actions={
        <div className="flex items-center gap-1">
          <IconButton icon={ChevronLeft} label="Previous slot" size="sm" disabled={!current || current <= 1} onClick={() => current && go(current - 1)} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(input);
              if (Number.isInteger(n) && n > 0) go(n);
            }}
          >
            <label htmlFor="slot-input" className="sr-only">
              Slot number
            </label>
            <Input id="slot-input" inputMode="numeric" placeholder="slot #" value={input} onChange={(e) => setInput(e.target.value.replace(/\D/g, ''))} className="h-7 w-20 text-xs" />
          </form>
          <IconButton icon={ChevronRight} label="Next slot" size="sm" disabled={!current || !live || current >= live.slot} onClick={() => current && go(current + 1)} />
          <Button size="sm" variant={selected === null ? 'consensus' : 'secondary'} icon={Radio} onClick={() => go(null)}>
            Live
          </Button>
        </div>
      }
    >
      {view && selected === null && slotIdle(view) && view.slot > 2 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-consensus/30 bg-consensus/8 px-3 py-2 text-xs text-fg-2">
          <span>Waiting for the next nomination. It starts about every 5 seconds.</span>
          <Button size="sm" variant="ghost" onClick={() => go(view.slot - 1)}>
            Show slot #{formatNumber(view.slot - 1)}
          </Button>
        </div>
      ) : null}
      {view ? (
        <SlotBody slot={view} isValidator={isValidator} />
      ) : selected !== null && !fetched.loading ? (
        <EmptyState icon={Microscope} title={`Slot #${formatNumber(selected)} is not in memory`}>
          Nodes keep SCP state only for recent slots. Ledgers before that are in the explorer.
        </EmptyState>
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </Card>
  );
}
