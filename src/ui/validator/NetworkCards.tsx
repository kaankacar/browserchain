import { Check, GitFork, Radio, ScrollText, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ForkInfo } from '../../node/api';
import type { LogLevel } from '../../lib/log';
import { HashText } from '../components/Hash';
import { LedgerLink, NodeName } from '../components/links';
import { StateBadge, type NodeState } from '../components/StateBadge';
import { TimeAgo } from '../components/TimeAgo';
import { Badge, Card, cx, EmptyState, Input, Segmented, TableWrap, TD, TH } from '../components/ui';
import { selfState as stateOfSelf } from '../lib/catchup';
import { formatNumber, formatTimeOfDay, plural } from '../lib/format';
import { isStrangerFork } from '../lib/forks';
import { describeQset } from '../lib/quorum';
import { useNodeState } from '../state/NodeProvider';

export function PeersTable() {
  const peers = useNodeState((s) => s.peers);
  return (
    <Card title="Connected peers" subtitle="Nodes this tab talks to directly" icon={Radio} iconClass="text-network" bodyClass="p-0">
      {peers.length === 0 ? (
        <EmptyState icon={Radio} title="No peers yet">
          Open BrowserChain in another tab, or share the link with a friend. Tabs of one browser find each other at once.
        </EmptyState>
      ) : (
        <TableWrap>
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr>
                <th className={TH}>Peer</th>
                <th className={TH}>Transport</th>
                <th className={TH}>Ledger</th>
                <th className={TH}>State</th>
                <th className={TH}>Role</th>
                <th className={cx(TH, 'text-right')}>Latency</th>
                <th className={TH}>Last seen</th>
                <th className={TH}>In my quorum</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((p) => (
                <tr key={p.nodeId} className="border-t border-line">
                  <td className={TD}>
                    <NodeName id={p.nodeId} name={p.name} />
                  </td>
                  <td className={TD}>
                    <div className="flex gap-1">
                      {p.transports.map((t) => (
                        <Badge key={t} tone={t === 'broadcast' ? 'network' : t === 'webrtc' ? 'consensus' : 'neutral'}>
                          {t === 'broadcast' ? 'same browser' : t}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className={TD}>
                    <LedgerLink seq={p.lclSeq} />
                  </td>
                  <td className={TD}>
                    <StateBadge state={p.state} />
                  </td>
                  <td className={cx(TD, 'text-fg-2')}>{p.validator ? 'validator' : 'watcher'}</td>
                  <td className={cx(TD, 'text-right tabular-nums text-fg-2')}>{p.latencyMs === null ? '–' : `${p.latencyMs} ms`}</td>
                  <td className={cx(TD, 'text-fg-3')}>
                    <TimeAgo ms={p.lastSeen} />
                  </td>
                  <td className={TD}>{p.inMyQuorum ? <Check aria-label="yes" className="size-4 text-consensus" /> : <span className="text-fg-3">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

export function ValidatorsTable() {
  const validators = useNodeState((s) => s.validators);
  const selfState = useNodeState((s) => stateOfSelf(s.status));
  return (
    <Card title="Known validators" subtitle="Every validator this node has heard from" icon={Users} iconClass="text-consensus" bodyClass="p-0">
      <TableWrap>
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr>
              <th className={TH}>Validator</th>
              <th className={TH}>State</th>
              <th className={TH}>Last slot</th>
              <th className={TH}>Its quorum set</th>
              <th className={TH}>Last heard</th>
            </tr>
          </thead>
          <tbody>
            {validators.map((v) => {
              const state: NodeState = v.isSelf ? selfState : v.connected ? (v.synced ? 'synced' : 'catching-up') : 'offline';
              return (
                <tr key={v.nodeId} className="border-t border-line">
                  <td className={TD}>
                    <span className="flex items-center gap-2">
                      <NodeName id={v.nodeId} />
                      {v.inMyQuorum && !v.isSelf ? <Badge tone="consensus">in my quorum</Badge> : null}
                    </span>
                  </td>
                  <td className={TD}>
                    <StateBadge state={state} />
                  </td>
                  <td className={cx(TD, 'tabular-nums text-fg-2')}>{v.lastSlot ? `#${formatNumber(v.lastSlot)}` : '–'}</td>
                  <td className={cx(TD, 'text-fg-2')}>{v.qset ? describeQset(v.qset) : <span className="text-fg-3">unknown</span>}</td>
                  <td className={cx(TD, 'text-fg-3')}>{v.isSelf ? 'now' : <TimeAgo ms={v.lastSeen} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

const RESOLUTION: Record<ForkInfo['resolution'], { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  'kept-ours': { label: 'Kept our branch', tone: 'ok' },
  'rolled-back': { label: 'Rolled back', tone: 'warn' },
  'alert-only': { label: 'Alert only', tone: 'bad' },
};

export function ForksCard() {
  const forks = useNodeState((s) => s.forks);
  return (
    <Card title="Recent forks" subtitle="Peers that disagreed about a ledger" icon={GitFork} iconClass="text-warn" bodyClass="p-0">
      {forks.length === 0 ? (
        <EmptyState icon={GitFork} title="No forks seen">
          A fork shows up when a peer has a different ledger at the same height. Auto mode keeps the branch that more known validators are on.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {forks.map((f) => {
            // kept only because the validators on the other branch were unknown: a resync joins them
            const r = isStrangerFork(f)
              ? { label: `Kept ours: ${plural(f.unknownValidators ?? 0, 'unknown validator')}`, tone: 'warn' as const }
              : RESOLUTION[f.resolution];
            return (
              <li key={`${f.ts}-${f.peer}-${f.atSeq}`} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm">
                    At <LedgerLink seq={f.atSeq} /> with <NodeName id={f.peer} />
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={r.tone}>
                      {r.label}
                      {f.rolledBackLedgers ? ` ${f.rolledBackLedgers} ledger${f.rolledBackLedgers === 1 ? '' : 's'}` : ''}
                    </Badge>
                    <span className="text-xs text-fg-3">
                      <TimeAgo ms={f.ts} />
                    </span>
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-fg-3">
                    ours <HashText value={f.ourHash} head={8} tail={6} />
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-fg-3">
                    theirs <HashText value={f.theirHash} head={8} tail={6} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: 'text-fg-3',
  info: 'text-network',
  warn: 'text-warn',
  error: 'text-bad',
};

export function LogsCard() {
  const logs = useNodeState((s) => s.logs);
  const [min, setMin] = useState<LogLevel>('info');
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const floor = LEVELS.indexOf(min);
    const needle = q.trim().toLowerCase();
    return logs.filter((l) => LEVELS.indexOf(l.level) >= floor && (!needle || l.msg.toLowerCase().includes(needle) || l.scope.includes(needle)));
  }, [logs, min, q]);
  return (
    <Card title="Node log" subtitle={`${formatNumber(shown.length)} of ${formatNumber(logs.length)} entries`} icon={ScrollText} bodyClass="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Segmented
          label="Minimum level"
          size="sm"
          value={min}
          onChange={setMin}
          options={LEVELS.map((l) => ({ value: l, label: l }))}
        />
        <label htmlFor="log-filter" className="sr-only">
          Filter log messages
        </label>
        <Input id="log-filter" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 w-48 text-xs" />
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={ScrollText} title="No log entries match" />
      ) : (
        <ol className="max-h-[640px] overflow-y-auto py-1 font-mono text-xs">
          {shown.map((l, i) => (
            <li key={`${l.ts}-${i}`} className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 px-4 py-1 hover:bg-hover sm:grid-cols-[6.5rem_3.5rem_7rem_minmax(0,1fr)]">
              <span className="tabular-nums text-fg-3">{formatTimeOfDay(l.ts)}</span>
              <span className={cx('uppercase', LEVEL_CLASS[l.level])}>{l.level}</span>
              <span className="hidden truncate text-fg-3 sm:block">{l.scope}</span>
              <span className="min-w-0 text-fg-2 [overflow-wrap:anywhere]">
                <span className="text-fg-3 sm:hidden">{l.scope} </span>
                {l.msg}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
