import { Blocks, Gauge, Layers, Radio, Users, Wallet, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Sparkline } from '../components/Sparkline';
import { Skeleton } from '../components/ui';
import { formatCompact, formatDuration, formatNumber, plural } from '../lib/format';
import { useNodeState } from '../state/NodeProvider';

function Tile({
  label,
  value,
  sub,
  icon: Icon,
  iconClass,
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: LucideIcon;
  iconClass: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-2 rounded-xl border border-line bg-panel p-4 shadow-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-fg-3">{label}</span>
        <Icon aria-hidden className={`size-4 shrink-0 ${iconClass}`} />
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-2xl font-semibold tracking-tight text-fg">{value}</div>
          {/* wraps instead of cutting off: phone tiles are narrow */}
          {sub ? <div className="mt-0.5 text-xs text-fg-3">{sub}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatsRow() {
  const stats = useNodeState((s) => s.stats);
  const status = useNodeState((s) => s.status);
  const validators = useNodeState((s) => s.validators);
  if (!stats || !status) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
    );
  }
  const intervals = stats.recentCloseIntervalsMs.slice(-12);
  // no interval until two ledgers closed: "0 ms" would read as instant closes
  const hasAvg = stats.recentCloseIntervalsMs.length > 0 && stats.avgCloseIntervalMs > 0;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <Tile
        label="Active validators"
        value={formatNumber(status.validatorsActive)}
        sub={`of ${validators.length || status.validatorsActive} known · tolerates ${plural(status.quorum.faultTolerance, 'failure')}`}
        icon={Users}
        iconClass="text-consensus"
      />
      <Tile label="Avg close time" value={hasAvg ? formatDuration(stats.avgCloseIntervalMs) : '–'} sub={hasAvg ? 'target 5 s' : 'target 5 s · no interval yet'} icon={Gauge} iconClass="text-ledger">
        {/* hidden on phones: the tile is too narrow for the value and the chart */}
        {intervals.length > 1 ? (
          <Sparkline values={intervals} target={5000} format={formatDuration} label="Recent ledger close intervals" className="hidden w-14 shrink-0 sm:block sm:w-20 2xl:w-24" />
        ) : null}
      </Tile>
      <Tile label="Tx per ledger" value={stats.txPerLedger.toFixed(1)} sub={`${stats.opsPerLedger.toFixed(1)} ops per ledger`} icon={Layers} iconClass="text-ledger" />
      <Tile
        label="Accounts"
        value={formatCompact(stats.totalAccounts)}
        sub={`${formatCompact(stats.totalTrustlines)} trustlines · ${formatCompact(stats.totalOffers)} offers`}
        icon={Wallet}
        iconClass="text-network"
      />
      <Tile label="Peers" value={formatNumber(status.peers)} sub={`${plural(status.mempoolSize, 'tx')} queued`} icon={Radio} iconClass="text-network" />
      <Tile label="Closed by this tab" value={formatCompact(stats.ledgersClosedHere)} sub={`LCL #${formatNumber(status.lcl.seq)}`} icon={Blocks} iconClass="text-ledger" />
    </div>
  );
}
