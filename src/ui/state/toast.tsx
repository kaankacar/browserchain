import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useClock } from './NodeProvider';

export type ToastTone = 'ok' | 'bad' | 'warn' | 'info';

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  body?: ReactNode;
  href?: string;
  /** ms; 0 keeps it until closed. Default 5000. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<(t: ToastInput) => void>(() => {});

export function useToast(): (t: ToastInput) => void {
  return useContext(ToastContext);
}

const ICONS = { ok: CircleCheck, bad: CircleX, warn: TriangleAlert, info: Info } as const;
const TONE_CLASS = {
  ok: 'text-ok',
  bad: 'text-bad',
  warn: 'text-warn',
  info: 'text-consensus',
} as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const clock = useClock();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      const d = t.duration ?? 5000;
      if (d > 0) clock.setTimeout(() => dismiss(id), d);
    },
    [clock, dismiss],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      >
        {items.map((t) => {
          const tone = t.tone ?? 'info';
          const Icon = ICONS[tone];
          return (
            <div
              key={t.id}
              role="status"
              className="animate-fade-up pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line-strong bg-raised p-3.5 shadow-panel"
            >
              <Icon aria-hidden className={`mt-0.5 size-5 shrink-0 ${TONE_CLASS[tone]}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{t.title}</p>
                {t.body ? <div className="mt-0.5 text-sm text-fg-2 [overflow-wrap:anywhere]">{t.body}</div> : null}
                {t.href ? (
                  <a href={t.href} className="mt-1 inline-block text-sm font-medium text-ledger hover:underline">
                    View details
                  </a>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="rounded-md p-1 text-fg-3 hover:bg-hover hover:text-fg"
                aria-label="Dismiss notification"
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
