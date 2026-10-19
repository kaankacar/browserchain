import {
  Blocks,
  BookOpen,
  FlaskConical,
  LayoutDashboard,
  Lightbulb,
  Menu,
  Moon,
  Search,
  Server,
  Sun,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LogoMark, Wordmark } from '../components/Logo';
import { RingArc } from '../components/RingArc';
import { StateDot, STATE_META } from '../components/StateBadge';
import { cx, IconButton } from '../components/ui';
import { useTheme } from '../hooks/useTheme';
import { selfState } from '../lib/catchup';
import { formatNumber } from '../lib/format';
import { href, sectionOf, type Route, type Section } from '../lib/route';
import { useNodeState } from '../state/NodeProvider';
import { SearchBox } from './SearchBox';

// section is null for links that leave the app (the how-it-works page).
const NAV: { section: Section | null; label: string; href: string; icon: LucideIcon; blurb: string }[] = [
  { section: 'overview', label: 'Overview', href: href.overview(), icon: LayoutDashboard, blurb: 'Live consensus and ledgers' },
  { section: 'validator', label: 'Validator', href: href.validator(), icon: Server, blurb: 'This tab’s node, quorum and SCP' },
  { section: 'explorer', label: 'Explorer', href: href.ledgers(), icon: Blocks, blurb: 'Ledgers, transactions, accounts' },
  { section: 'wallet', label: 'Wallet', href: href.wallet(), icon: Wallet, blurb: 'Test keys, payments, DEX' },
  { section: 'lab', label: 'Lab', href: href.lab(), icon: FlaskConical, blurb: 'Decode, build, sign, submit' },
  { section: 'about', label: 'About', href: href.about(), icon: BookOpen, blurb: 'What it is and its limits' },
  { section: null, label: 'How it works', href: './how-it-works.html', icon: Lightbulb, blurb: 'Validators, SCP and how it was built' },
];

function NetworkPill({ mock }: { mock: boolean }) {
  const status = useNodeState((s) => s.status);
  const state = selfState(status);
  return (
    <a
      href={href.validator()}
      title={`Network ${status?.networkName ?? '…'} · ${STATE_META[state].label}`}
      className="flex h-7 shrink-0 items-center gap-2 rounded-full border border-line bg-raised/60 px-2.5 text-xs text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
    >
      <StateDot state={state} pulse />
      <span className="max-w-24 truncate font-medium text-fg">{status?.networkName ?? 'connecting'}</span>
      <span className="hidden text-fg-3 sm:inline">{STATE_META[state].label.toLowerCase()}</span>
      {mock ? (
        <span className="rounded bg-consensus/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-consensus">demo</span>
      ) : null}
    </a>
  );
}

/** Ledger number with a tiny ring that fills toward the next close. */
function LclTicker() {
  const lcl = useNodeState((s) => s.status?.lcl ?? null);
  const synced = useNodeState((s) => selfState(s.status) === 'synced');
  const avg = useNodeState((s) => s.stats?.avgCloseIntervalMs || 5000);
  if (!lcl) return null;
  return (
    <a
      href={href.ledger(lcl.seq)}
      className="hidden h-8 items-center gap-2 rounded-lg px-2 text-sm tabular-nums text-fg-2 hover:bg-hover hover:text-fg xl:flex"
      title="Last closed ledger"
    >
      <svg viewBox="0 0 20 20" className="size-4 -rotate-90" aria-hidden>
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--bc-line-strong)" strokeWidth="2.5" />
        {synced ? <RingArc key={lcl.seq} closedAt={lcl.closedAt} durationMs={avg} r={7.5} center={10} strokeWidth={2.5} /> : null}
      </svg>
      <span className="font-medium text-fg">#{formatNumber(lcl.seq)}</span>
    </a>
  );
}

export function Shell({ route, mock, children }: { route: Route; mock: boolean; children: ReactNode }) {
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const section = sectionOf(route);

  useEffect(() => {
    setMenuOpen(false);
    setSearchOpen(false);
  }, [route]);

  useEffect(() => {
    if (searchOpen) mobileSearchRef.current?.focus();
  }, [searchOpen]);

  // "/" opens search; Escape closes the menu and search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="bc-backdrop flex min-h-screen flex-col">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-raised focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
          <a href={href.overview()} className="flex shrink-0 items-center gap-2 rounded-lg pr-1" aria-label="BrowserChain home">
            <LogoMark />
            <span className="hidden sm:inline">
              <Wordmark />
            </span>
          </a>
          <NetworkPill mock={mock} />
          <nav aria-label="Main" className="ml-2 hidden xl:block">
            <ul className="flex items-center gap-0.5">
              {NAV.map((n) => {
                const on = n.section !== null && n.section === section;
                return (
                  <li key={n.label}>
                    <a
                      href={n.href}
                      aria-current={on ? 'page' : undefined}
                      className={cx(
                        'flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium transition-colors',
                        on ? 'bg-hover text-fg' : 'text-fg-3 hover:text-fg',
                      )}
                    >
                      <n.icon aria-hidden className={cx('size-4', on ? 'text-ledger' : '')} />
                      {n.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <IconButton
              icon={Search}
              label="Search"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen((o) => !o)}
            />
            <LclTicker />
            <IconButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle} />
            <IconButton
              icon={menuOpen ? X : Menu}
              label={menuOpen ? 'Close menu' : 'Open menu'}
              className="xl:hidden"
              aria-expanded={menuOpen}
              aria-controls="bc-mobile-nav"
              onClick={() => setMenuOpen((o) => !o)}
            />
          </div>
        </div>
        {searchOpen ? (
          <div className="border-t border-line px-4 py-3">
            <SearchBox ref={mobileSearchRef} onDone={() => setSearchOpen(false)} />
          </div>
        ) : null}
        {menuOpen ? (
          <nav id="bc-mobile-nav" aria-label="Main" className="border-t border-line xl:hidden">
            <ul className="mx-auto grid max-w-[1280px] grid-cols-1 gap-1 p-3 sm:grid-cols-2">
              {NAV.map((n) => {
                const on = n.section !== null && n.section === section;
                return (
                  <li key={n.label}>
                    <a
                      href={n.href}
                      aria-current={on ? 'page' : undefined}
                      className={cx('flex items-center gap-3 rounded-xl px-3 py-2.5', on ? 'bg-hover' : 'hover:bg-hover')}
                    >
                      <span className="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-raised">
                        <n.icon aria-hidden className={cx('size-4', on ? 'text-ledger' : 'text-fg-2')} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-fg">{n.label}</span>
                        <span className="block truncate text-xs text-fg-3">{n.blurb}</span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-5 outline-none sm:px-6 sm:py-8">
        {children}
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-3 px-4 py-6 text-xs text-fg-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2">
            <LogoMark size={18} />
            <span>
              BrowserChain is a play-money network where every browser tab is a validator.{' '}
              {mock ? 'You are looking at simulated demo data.' : null}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <a className="hover:text-fg" href="./how-it-works.html">
              How it works
            </a>
            <a className="hover:text-fg" href={href.about()}>
              About
            </a>
            <a className="hover:text-fg" href={href.validator('scp')}>
              SCP log
            </a>
            <a className="hover:text-fg" href={href.lab()}>
              XDR lab
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
