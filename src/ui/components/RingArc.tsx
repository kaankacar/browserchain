import { useState } from 'react';
import { useClock } from '../state/NodeProvider';

/**
 * A circle stroke that fills from 0 to 100% over the ledger interval with a
 * CSS animation. Mount it with key={ledgerSeq}: delay and duration are frozen
 * at mount, because changing them on a running animation makes it jump.
 */
export function RingArc({
  closedAt,
  durationMs,
  r,
  center,
  strokeWidth,
  color = 'var(--bc-ledger-fill)',
}: {
  closedAt: number;
  durationMs: number;
  r: number;
  center: number;
  strokeWidth: number;
  color?: string;
}) {
  const clock = useClock();
  const [timing] = useState(() => {
    const dur = Math.max(1000, durationMs);
    return { dur, delay: Math.max(0, Math.min(dur, clock.now() - closedAt)) };
  });
  return (
    <circle
      cx={center}
      cy={center}
      r={r}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      pathLength={1}
      strokeDasharray="1"
      strokeDashoffset="1"
      className="animate-ring-fill"
      style={{ ['--ring-duration' as string]: `${timing.dur}ms`, animationDelay: `-${timing.delay}ms` }}
    />
  );
}
