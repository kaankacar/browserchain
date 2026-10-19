// Small design-system primitives shared by every screen.

import { LoaderCircle, MoveHorizontal, type LucideIcon } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { Tone } from '../lib/format';
import { NO_SCROLL, sameEdges, scrollEdges, type ScrollEdges } from '../lib/scroll';

export { cx, withOverrides } from '../lib/classes';
import { cx, withOverrides } from '../lib/classes';

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'consensus';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-ledger-fill text-ledger-ink hover:brightness-110 active:brightness-95 font-semibold',
  secondary: 'border border-line-strong bg-raised text-fg hover:bg-hover',
  ghost: 'text-fg-2 hover:bg-hover hover:text-fg',
  danger: 'border border-bad/40 text-bad hover:bg-bad/10',
  consensus: 'bg-consensus/15 text-consensus border border-consensus/30 hover:bg-consensus/25',
};

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={withOverrides(
        cx(
          'inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-[background-color,filter,color] duration-150 disabled:opacity-50',
          VARIANT[variant],
          SIZE[size],
        ),
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : Icon ? <Icon aria-hidden className="size-4" /> : null}
      {children}
    </button>
  );
});

export function IconButton({
  icon: Icon,
  label,
  className,
  size = 'md',
  danger,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { icon: LucideIcon; label: string; size?: 'sm' | 'md'; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-hover disabled:opacity-40',
        danger ? 'text-bad hover:bg-bad/10' : 'text-fg-2 hover:text-fg',
        size === 'sm' ? 'size-7' : 'size-9',
        className,
      )}
      {...rest}
    >
      <Icon aria-hidden className={size === 'sm' ? 'size-3.5' : 'size-4'} />
    </button>
  );
}

// ---------------------------------------------------------------- cards

export function Card({
  title,
  icon: Icon,
  iconClass = 'text-fg-3',
  actions,
  children,
  className,
  bodyClass,
  subtitle,
  id,
  fill,
}: {
  /** Stretch to the parent's height; the body grows (for equal-height rows). */
  fill?: boolean;
  title?: ReactNode;
  icon?: LucideIcon;
  iconClass?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  subtitle?: ReactNode;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cx('min-w-0 rounded-xl border border-line bg-panel shadow-panel', fill && 'flex h-full flex-col', className)}
    >
      {title || actions ? (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {Icon ? <Icon aria-hidden className={cx('size-4 shrink-0', iconClass)} /> : null}
            <div className="min-w-0">
              <h2 id={headingId} className="truncate text-sm font-semibold tracking-tight text-fg">
                {title}
              </h2>
              {subtitle ? <p className="truncate text-xs text-fg-3">{subtitle}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={withOverrides(cx('p-4', fill && 'flex min-h-0 flex-1 flex-col'), bodyClass)}>{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  icon: Icon,
  iconClass = 'text-ledger',
  description,
  actions,
  children,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  iconClass?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight text-fg sm:text-2xl">
          {Icon ? (
            <span className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-raised">
              <Icon aria-hidden className={cx('size-4', iconClass)} />
            </span>
          ) : null}
          <span className="min-w-0 truncate">{title}</span>
        </h1>
        {description ? <p className="mt-1.5 max-w-2xl text-sm text-fg-2">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- badges

export type BadgeTone = Tone | 'ledger' | 'consensus' | 'network';

const BADGE: Record<BadgeTone, string> = {
  ok: 'bg-ok/12 text-ok ring-ok/25',
  bad: 'bg-bad/12 text-bad ring-bad/25',
  warn: 'bg-warn/12 text-warn ring-warn/25',
  neutral: 'bg-fg-3/12 text-fg-2 ring-fg-3/25',
  ledger: 'bg-ledger-fill/12 text-ledger ring-ledger-fill/30',
  consensus: 'bg-consensus/12 text-consensus ring-consensus/30',
  network: 'bg-network/12 text-network ring-network/30',
};

export function Badge({
  tone = 'neutral',
  icon: Icon,
  iconClassName,
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  icon?: LucideIcon;
  iconClassName?: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        BADGE[tone],
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className={cx('size-3 shrink-0', iconClassName)} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------- forms

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
  optional?: boolean;
}) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-2">
        {label}
        {optional ? (
          <>
            {' '}
            <span className="font-normal text-fg-3">(optional)</span>
          </>
        ) : null}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}

const INPUT =
  'w-full min-w-0 rounded-lg border border-line-strong bg-sunken px-3 text-fg placeholder:text-fg-3 transition-colors hover:border-fg-3/50 focus-visible:border-ledger-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ledger-fill/30 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input(
  { className, mono, ...rest },
  ref,
) {
  return <input ref={ref} className={withOverrides(cx(INPUT, 'h-9', mono ? 'font-mono text-[13px]' : 'text-sm'), className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={withOverrides(cx(INPUT, 'h-9 cursor-pointer pr-8 text-sm'), className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono = true, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        spellCheck={false}
        className={withOverrides(cx(INPUT, 'min-h-28 py-2 leading-relaxed', mono ? 'font-mono text-xs [overflow-wrap:anywhere]' : 'text-sm'), className)}
        {...rest}
      />
    );
  },
);

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  description?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
          checked ? 'border-ledger-fill bg-ledger-fill' : 'border-line-strong bg-sunken',
        )}
      >
        <span
          aria-hidden
          className={cx(
            'inline-block size-3.5 rounded-full shadow transition-transform',
            checked ? 'translate-x-[18px] bg-ledger-ink' : 'translate-x-[2px] bg-fg-3',
          )}
        />
      </button>
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium text-fg">
          {label}
        </label>
        {description ? <p className="text-xs text-fg-3">{description}</p> : null}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: LucideIcon }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-xs sm:text-sm',
              active ? 'bg-raised text-fg shadow-sm ring-1 ring-line-strong' : 'text-fg-3 hover:text-fg',
            )}
          >
            {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- tabs (route links)

export function TabLinks({
  tabs,
  active,
  label,
}: {
  tabs: { id: string; href: string; label: string; icon?: LucideIcon; count?: number }[];
  active: string;
  label: string;
}) {
  const navRef = useRef<HTMLElement>(null);
  // On phones the row scrolls sideways: keep the active tab in view (it can
  // be the last one), without scrolling the page.
  useEffect(() => {
    const nav = navRef.current;
    const a = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !a) return;
    const n = nav.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    if (r.left < n.left || r.right > n.right) nav.scrollLeft += r.left - n.left - (n.width - r.width) / 2;
  }, [active]);
  return (
    <nav ref={navRef} aria-label={label} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {tabs.map((t) => {
          const on = t.id === active;
          const Icon = t.icon;
          return (
            <li key={t.id}>
              <a
                href={t.href}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  // inset focus ring: the scrolling row clips anything outside the link
                  '-mb-px flex items-center gap-2 rounded-t-md border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:-outline-offset-2',
                  on ? 'border-ledger-fill text-fg' : 'border-transparent text-fg-3 hover:text-fg',
                )}
              >
                {Icon ? <Icon aria-hidden className={cx('size-4', on ? 'text-ledger' : '')} /> : null}
                {t.label}
                {t.count !== undefined ? (
                  <span className="rounded-full bg-hover px-1.5 text-xs tabular-nums text-fg-2">{t.count}</span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------- misc

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden className={cx('size-4 animate-spin text-fg-3', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-hover', className)} />;
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-2 px-4 py-10 text-center', className)}>
      {Icon ? (
        <span className="mb-1 inline-flex size-10 items-center justify-center rounded-xl border border-line bg-raised">
          <Icon aria-hidden className="size-5 text-fg-3" />
        </span>
      ) : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {children ? <div className="max-w-sm text-sm text-fg-3">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cx('rounded-lg border border-bad/30 bg-bad/8 px-3 py-2 text-sm text-bad [overflow-wrap:anywhere]', className)}>
      {children}
    </div>
  );
}

export function Notice({
  tone = 'warn',
  icon: Icon,
  title,
  children,
  className,
}: {
  tone?: 'warn' | 'info' | 'ok';
  icon?: LucideIcon;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    warn: 'border-warn/30 bg-warn/8 text-fg-2 [&_svg]:text-warn',
    info: 'border-consensus/30 bg-consensus/8 text-fg-2 [&_svg]:text-consensus',
    ok: 'border-ok/30 bg-ok/8 text-fg-2 [&_svg]:text-ok',
  } as const;
  return (
    <div className={cx('flex gap-3 rounded-xl border px-4 py-3 text-sm', tones[tone], className)}>
      {Icon ? <Icon aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
      <div className="min-w-0">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        <div className={title ? 'mt-0.5' : ''}>{children}</div>
      </div>
    </div>
  );
}

/** Label/value rows that stack on mobile. */
export function Facts({ items, className }: { items: { label: ReactNode; value: ReactNode; wide?: boolean }[]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2', className)}>
      {items.map((it, i) => (
        <div key={i} className={cx('min-w-0', it.wide && 'sm:col-span-2')}>
          <dt className="text-xs text-fg-3">{it.label}</dt>
          <dd className="mt-0.5 min-w-0 text-sm text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-raised px-1.5 py-0.5 font-mono text-[10px] font-medium text-fg-3">
      {children}
    </kbd>
  );
}

// Fades for the hidden sides of a wide table (full class names, for Tailwind).
const TABLE_FADE = {
  none: '',
  right: '[mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)]',
  left: '[mask-image:linear-gradient(to_left,black_calc(100%-40px),transparent)]',
  both: '[mask-image:linear-gradient(to_right,transparent,black_40px,black_calc(100%-40px),transparent)]',
};

/**
 * Responsive table wrapper: scrolls inside its card, never the page. It is
 * positioned so absolutely placed children (sr-only labels) stay clipped.
 * `bleed` pulls it to the card edges when the card body has padding.
 * A table wider than its card (on a phone) gets a scroll cue: a hint above
 * it, and the sides that hide columns fade out.
 */
export function TableWrap({ children, className, bleed = false }: { children: ReactNode; className?: string; bleed?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_SCROLL);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const next = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
      setEdges((cur) => (sameEdges(cur, next) ? cur : next));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // the box (window width) and the table (its rows) both change the overflow
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    for (const child of el.children) ro?.observe(child);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);
  const fade = edges.left && edges.right ? 'both' : edges.left ? 'left' : edges.right ? 'right' : 'none';
  return (
    <div className={cx(bleed && '-mx-4', className)}>
      {edges.overflow ? (
        <p className="flex items-center gap-1.5 px-4 pb-1 pt-2.5 text-xs text-fg-3">
          <MoveHorizontal aria-hidden className="size-3.5 shrink-0" />
          Scroll sideways to see all columns
        </p>
      ) : null}
      <div ref={ref} data-scroll-fade={fade} className={cx('relative overflow-x-auto', TABLE_FADE[fade])}>
        {children}
      </div>
    </div>
  );
}

export const TH = 'whitespace-nowrap px-4 py-2 text-left text-xs font-medium text-fg-3';
export const TD = 'px-4 py-2.5 align-middle';
