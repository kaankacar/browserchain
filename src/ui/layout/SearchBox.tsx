import { Search } from 'lucide-react';
import { forwardRef, useId, useState } from 'react';
import { navigate } from '../hooks/useRoute';
import { href } from '../lib/route';
import { classifySearch } from '../lib/search';
import { cx, Kbd } from '../components/ui';

/** Explorer search: account (G…), 64-hex tx hash or ledger number. */
export const SearchBox = forwardRef<HTMLInputElement, { className?: string; large?: boolean; onDone?: () => void; shortcut?: boolean }>(
  function SearchBox({ className, large, onDone, shortcut }, ref) {
    const [q, setQ] = useState('');
    const [error, setError] = useState<string | null>(null);
    // the header renders two boxes below xl (one hidden): ids must differ
    const id = useId();
    const inputId = `${id}-q`;
    const errorId = `${id}-error`;
    const submit = (e: React.FormEvent) => {
      e.preventDefault();
      const t = classifySearch(q);
      if (t.kind === 'invalid') {
        setError(t.reason);
        return;
      }
      setError(null);
      setQ('');
      if (t.kind === 'account') navigate(href.account(t.id));
      else if (t.kind === 'tx') navigate(href.tx(t.hash));
      else navigate(href.ledger(t.seq));
      onDone?.();
    };
    return (
      <form role="search" onSubmit={submit} className={cx('relative', className)}>
        <label className="sr-only" htmlFor={inputId}>
          Search accounts, transactions and ledgers
        </label>
        <Search aria-hidden className={cx('pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3', large ? 'size-5' : 'size-4')} />
        <input
          ref={ref}
          id={inputId}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setError(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Account, tx hash or ledger #"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cx(
            'w-full rounded-lg border border-line-strong bg-sunken pl-9 text-fg placeholder:text-fg-3 hover:border-fg-3/50 focus-visible:border-ledger-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ledger-fill/30',
            large ? 'h-12 pr-4 pl-11 text-base' : 'h-9 pr-9 text-sm',
          )}
        />
        {shortcut && !large ? (
          <span className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 xl:block">
            <Kbd>/</Kbd>
          </span>
        ) : null}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="absolute left-0 right-0 top-full z-50 mt-1.5 rounded-lg border border-bad/30 bg-raised px-3 py-2 text-xs text-bad shadow-panel"
          >
            {error}
          </p>
        ) : null}
      </form>
    );
  },
);
