import { useId, useState } from 'react';
import { cx } from './ui';

/**
 * Single-series trend line for a stat tile: 2px line in the de-emphasis ink,
 * the latest point in the accent, optional hairline target. Hover or focus
 * shows the value under the pointer.
 */
export function Sparkline({
  values,
  target,
  format,
  label,
  className,
  height = 36,
}: {
  values: number[];
  target?: number;
  format: (v: number) => string;
  label: string;
  className?: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();
  const width = 120;
  if (values.length < 2) return <div className={className} style={{ height }} />;
  const all = target !== undefined ? [...values, target] : values;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const pad = 4;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  const shown = hover ?? last;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * width;
    const i = Math.round(((rel - pad) / (width - pad * 2)) * (values.length - 1));
    setHover(Math.max(0, Math.min(last, i)));
  };

  return (
    <div className={cx('relative', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-full w-full touch-none overflow-visible"
        style={{ height }}
        role="img"
        aria-label={`${label}: latest ${format(values[last])}`}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(last)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? last) - 1));
          if (e.key === 'ArrowRight') setHover((h) => Math.min(last, (h ?? last) + 1));
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--bc-fg-3)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--bc-fg-3)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {target !== undefined ? (
          <line x1={0} x2={width} y1={y(target)} y2={y(target)} stroke="var(--bc-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ) : null}
        <polygon points={`${x(0)},${height} ${points} ${x(last)},${height}`} fill={`url(#${gradientId})`} />
        <polyline
          points={points}
          fill="none"
          stroke="var(--bc-fg-3)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null ? (
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} stroke="var(--bc-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      {/* HTML dot keeps its round shape when the svg is stretched. */}
      <span
        aria-hidden
        className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ledger-fill ring-2 ring-panel"
        style={{ left: `${(x(shown) / width) * 100}%`, top: y(values[shown]) }}
      />
      {hover !== null ? (
        <span className="pointer-events-none absolute -top-6 right-0 rounded-md border border-line bg-raised px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-fg shadow-panel">
          {format(values[hover])}
        </span>
      ) : null}
    </div>
  );
}
