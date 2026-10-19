import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { middleEllipsis } from '../lib/format';
import { useClock } from '../state/NodeProvider';
import { cx } from './ui';

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = 'Copy',
  className,
  size = 'sm',
}: {
  value: string;
  label?: string;
  className?: string;
  size?: 'xs' | 'sm';
}) {
  const clock = useClock();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clock.clearTimeout(timer.current);
    },
    [clock],
  );
  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (await copyText(value)) {
      setCopied(true);
      if (timer.current !== null) clock.clearTimeout(timer.current);
      timer.current = clock.setTimeout(() => setCopied(false), 1400);
    }
  };
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors hover:bg-hover',
        copied ? 'text-ok' : 'text-fg-3 hover:text-fg',
        size === 'xs' ? 'size-5' : 'size-6',
        className,
      )}
    >
      <Icon aria-hidden className={size === 'xs' ? 'size-3' : 'size-3.5'} />
    </button>
  );
}

/** Monospace key/hash with middle ellipsis, full value on hover, optional link and copy. */
export function HashText({
  value,
  head = 6,
  tail = 6,
  href,
  copy = true,
  className,
  full = false,
}: {
  value: string;
  head?: number;
  tail?: number;
  href?: string;
  copy?: boolean;
  className?: string;
  /** Show the full value (wrapping) instead of the ellipsis. */
  full?: boolean;
}) {
  const text = full ? value : middleEllipsis(value, head, tail);
  const inner = (
    <span title={value} className={cx('font-mono text-[0.92em]', full && '[overflow-wrap:anywhere]')}>
      {text}
    </span>
  );
  return (
    <span className={cx('inline-flex min-w-0 max-w-full items-center gap-1 align-middle', className)}>
      {href ? (
        <a href={href} className="min-w-0 text-fg hover:text-ledger hover:underline">
          {inner}
        </a>
      ) : (
        <span className="min-w-0">{inner}</span>
      )}
      {copy && value ? <CopyButton value={value} label="Copy to clipboard" size="xs" /> : null}
    </span>
  );
}
