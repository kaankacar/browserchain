import { ArrowDownLeft, ArrowUpRight, Pause, Play, ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ScpEventView } from '../../node/api';
import { NodeName } from '../components/links';
import { Button, Card, cx, EmptyState, Segmented, Select } from '../components/ui';
import { formatNumber, formatTimeOfDay } from '../lib/format';
import { PHASES } from '../overview/phases';
import { useNodeState } from '../state/NodeProvider';

const TYPES: ScpEventView['type'][] = ['nominate', 'prepare', 'confirm', 'externalize'];
const TYPE_COLOR: Record<ScpEventView['type'], string> = {
  nominate: PHASES[0].color,
  prepare: PHASES[1].color,
  confirm: PHASES[2].color,
  externalize: PHASES[3].color,
};

export function ScpLog() {
  const live = useNodeState((s) => s.scpEvents);
  const [frozen, setFrozen] = useState<ScpEventView[] | null>(null);
  const [types, setTypes] = useState<Set<ScpEventView['type']>>(() => new Set(TYPES));
  const [dir, setDir] = useState<'all' | 'in' | 'out'>('all');
  const [node, setNode] = useState('all');
  const events = frozen ?? live;

  const nodes = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of live) if (!m.has(e.nodeId)) m.set(e.nodeId, e.name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [live]);

  const shown = useMemo(
    () => events.filter((e) => types.has(e.type) && (dir === 'all' || e.direction === dir) && (node === 'all' || e.nodeId === node)).slice(0, 300),
    [events, types, dir, node],
  );

  return (
    <Card
      title="SCP messages"
      subtitle={`${formatNumber(events.length)} recent statements${frozen ? ' · paused' : ''}`}
      icon={ScrollText}
      iconClass="text-consensus"
      bodyClass="p-0"
      actions={
        <Button size="sm" variant={frozen ? 'primary' : 'secondary'} icon={frozen ? Play : Pause} onClick={() => setFrozen(frozen ? null : live)}>
          {frozen ? 'Resume' : 'Pause'}
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div role="group" aria-label="Statement types" className="flex flex-wrap gap-1">
          {TYPES.map((t) => {
            const on = types.has(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setTypes((prev) => {
                    const next = new Set(prev);
                    if (on) next.delete(t);
                    else next.add(t);
                    return next.size ? next : new Set(TYPES);
                  })
                }
                className={cx(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium capitalize transition-colors',
                  on ? 'border-line-strong bg-raised text-fg' : 'border-line text-fg-3 hover:text-fg',
                )}
              >
                <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: on ? TYPE_COLOR[t] : 'var(--bc-line-strong)' }} />
                {t}
              </button>
            );
          })}
        </div>
        <Segmented
          label="Direction"
          size="sm"
          value={dir}
          onChange={setDir}
          options={[
            { value: 'all', label: 'All' },
            { value: 'in', label: 'In', icon: ArrowDownLeft },
            { value: 'out', label: 'Out', icon: ArrowUpRight },
          ]}
        />
        <label htmlFor="scp-node" className="sr-only">
          Validator
        </label>
        <Select id="scp-node" value={node} onChange={(e) => setNode(e.target.value)} className="h-7 w-auto text-xs">
          <option value="all">All validators</option>
          {nodes.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={ScrollText} title="No statements match">
          Statements appear here as validators nominate and vote.
        </EmptyState>
      ) : (
        <ol className="max-h-[560px] divide-y divide-line overflow-y-auto" aria-label="SCP statements, newest first">
          {shown.map((e, i) => (
            <li
              key={`${e.ts}-${e.nodeId}-${e.summary}-${i}`}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-2 text-xs sm:grid-cols-[5.75rem_3.75rem_1rem_9.5rem_minmax(0,1fr)] sm:items-center"
            >
              <span className="font-mono tabular-nums text-fg-3">
                {formatTimeOfDay(e.ts)}
                <span className="ml-2 sm:hidden">#{formatNumber(e.slot)}</span>
              </span>
              <span className="hidden tabular-nums text-fg-3 sm:block">#{formatNumber(e.slot)}</span>
              <span className="hidden sm:block" title={e.direction === 'in' ? 'received' : 'sent by this node'}>
                {e.direction === 'in' ? <ArrowDownLeft aria-label="received" className="size-3.5 text-network" /> : <ArrowUpRight aria-label="sent" className="size-3.5 text-ledger" />}
              </span>
              <NodeName id={e.nodeId} name={e.name} size={14} className="min-w-0 justify-self-end sm:justify-self-auto" />
              <span className="col-span-2 flex min-w-0 items-start gap-2 sm:col-span-1">
                <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full" style={{ backgroundColor: TYPE_COLOR[e.type] }} />
                <span className="min-w-0 font-mono text-fg-2 [overflow-wrap:anywhere]">{e.summary}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
