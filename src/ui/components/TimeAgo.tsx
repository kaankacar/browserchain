import { formatUtc, timeAgo } from '../lib/format';
import { useNow } from '../state/NodeProvider';

/** "3s ago", refreshed every second; full time in the tooltip. */
export function TimeAgo({ ms, className }: { ms: number; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatUtc(Math.floor(ms / 1000))} className={className}>
      {timeAgo(ms, now)}
    </time>
  );
}

/** Same, for unix-second ledger close times. */
export function CloseTimeAgo({ seconds, className }: { seconds: number; className?: string }) {
  return <TimeAgo ms={seconds * 1000} className={className} />;
}
