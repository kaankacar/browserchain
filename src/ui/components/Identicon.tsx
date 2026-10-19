import { memo } from 'react';
import { IDENTICON_GRID, identicon } from '../lib/identicon';
import { cx } from './ui';

/** Square identicon for a key; decorative unless a label is given. */
export const Identicon = memo(function Identicon({
  value,
  size = 20,
  className,
  label,
  rounded = 'md',
}: {
  value: string;
  size?: number;
  className?: string;
  label?: string;
  rounded?: 'md' | 'full';
}) {
  const icon = identicon(value);
  const cell = 10;
  const pad = 5;
  const dim = IDENTICON_GRID * cell + pad * 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx('shrink-0', rounded === 'full' ? 'rounded-full' : 'rounded-[22%]', className)}
    >
      <rect width={dim} height={dim} fill={icon.bg} />
      {icon.cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={pad + (i % IDENTICON_GRID) * cell}
            y={pad + Math.floor(i / IDENTICON_GRID) * cell}
            width={cell + 0.4}
            height={cell + 0.4}
            fill={icon.fg}
          />
        ) : null,
      )}
    </svg>
  );
});
