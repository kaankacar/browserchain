import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { Json } from '../lib/xdrJson';
import { cx } from './ui';

function preview(v: Json): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
  }
  return '';
}

function Leaf({ value }: { value: Json }) {
  if (value === null) return <span className="text-fg-3">null</span>;
  if (typeof value === 'string') return <span className="text-ok [overflow-wrap:anywhere]">"{value}"</span>;
  if (typeof value === 'number') return <span className="text-ledger">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-consensus">{String(value)}</span>;
  return null;
}

function Node({ name, value, depth, openDepth }: { name: string | null; value: Json; depth: number; openDepth: number }) {
  const isContainer = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < openDepth);
  const label = name !== null ? <span className="text-network">{name}</span> : null;
  if (!isContainer) {
    return (
      <div className="flex min-w-0 gap-1.5 py-px pl-5">
        {label ? <span className="shrink-0">{label}:</span> : null}
        <span className="min-w-0">
          <Leaf value={value} />
        </span>
      </div>
    );
  }
  const entries: [string, Json][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded py-px text-left hover:bg-hover"
      >
        <ChevronRight aria-hidden className={cx('size-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
        {label ? <span>{label}:</span> : null}
        {!open ? <span className="truncate text-fg-3">{preview(value)}</span> : Array.isArray(value) ? <span className="text-fg-3">[</span> : <span className="text-fg-3">{'{'}</span>}
      </button>
      {open ? (
        <div className="ml-[7px] border-l border-line pl-2">
          {entries.length === 0 ? <div className="pl-5 text-fg-3">empty</div> : null}
          {entries.map(([k, v]) => (
            <Node key={k} name={Array.isArray(value) ? `${k}` : k} value={v} depth={depth + 1} openDepth={openDepth} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Collapsible JSON tree for decoded XDR. */
export function JsonView({ value, openDepth = 3, className }: { value: Json; openDepth?: number; className?: string }) {
  return (
    <div className={cx('overflow-x-auto rounded-lg border border-line bg-sunken p-3 font-mono text-xs leading-relaxed', className)}>
      <Node name={null} value={value} depth={0} openDepth={openDepth} />
    </div>
  );
}
