import { CircleCheck, CirclePause, LoaderCircle, PowerOff, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { SelfState } from '../lib/catchup';
import { Badge, cx, type BadgeTone } from './ui';

/** 'blocked' is this node only: peers are ahead, it cannot catch up from them safely and does not vote. */
export type NodeState = SelfState | 'offline';

export const STATE_META: Record<NodeState, { label: string; tone: BadgeTone; icon: LucideIcon; dot: string; color: string }> = {
  synced: { label: 'Synced', tone: 'ok', icon: CircleCheck, dot: 'bg-ok', color: 'var(--bc-ok)' },
  'catching-up': { label: 'Catching up', tone: 'warn', icon: RefreshCw, dot: 'bg-warn', color: 'var(--bc-warn)' },
  blocked: { label: 'Blocked', tone: 'bad', icon: CirclePause, dot: 'bg-bad', color: 'var(--bc-bad)' },
  stalled: { label: 'Stalled', tone: 'bad', icon: TriangleAlert, dot: 'bg-bad', color: 'var(--bc-bad)' },
  booting: { label: 'Booting', tone: 'neutral', icon: LoaderCircle, dot: 'bg-fg-3', color: 'var(--bc-fg-3)' },
  stopped: { label: 'Stopped', tone: 'neutral', icon: PowerOff, dot: 'bg-fg-3', color: 'var(--bc-fg-3)' },
  offline: { label: 'Offline', tone: 'neutral', icon: PowerOff, dot: 'bg-fg-3', color: 'var(--bc-fg-3)' },
};

export function StateBadge({ state, className }: { state: NodeState; className?: string }) {
  const m = STATE_META[state];
  const spin = state === 'catching-up' || state === 'booting';
  return (
    <Badge tone={m.tone} icon={m.icon} iconClassName={spin ? 'animate-spin' : undefined} className={className}>
      {m.label}
    </Badge>
  );
}

export function StateDot({ state, className, pulse }: { state: NodeState; className?: string; pulse?: boolean }) {
  const m = STATE_META[state];
  return (
    <span className={cx('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {pulse && state === 'synced' ? <span className={cx('absolute inline-flex size-full animate-ping rounded-full opacity-60', m.dot)} /> : null}
      <span className={cx('relative inline-flex size-2 rounded-full', m.dot)} />
    </span>
  );
}
