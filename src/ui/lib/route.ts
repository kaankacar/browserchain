// Hash routing: "#/ledger/12", "#/tx/<hash>", "#/account/G...". Pure parse/build.

export const VALIDATOR_TABS = ['node', 'scp', 'peers', 'logs'] as const;
export const WALLET_TABS = ['send', 'trust', 'issue', 'trade', 'claim', 'activity'] as const;
export const LAB_TABS = ['decode', 'build', 'sign', 'submit'] as const;

export type ValidatorTab = (typeof VALIDATOR_TABS)[number];
export type WalletTab = (typeof WALLET_TABS)[number];
export type LabTab = (typeof LAB_TABS)[number];

export type Route =
  | { name: 'overview' }
  | { name: 'validator'; tab: ValidatorTab }
  | { name: 'ledgers'; before?: number }
  | { name: 'ledger'; seq: number }
  | { name: 'txs'; before?: number }
  | { name: 'tx'; hash: string }
  | { name: 'account'; id: string }
  | { name: 'assets' }
  | { name: 'search'; q: string }
  | { name: 'wallet'; tab: WalletTab }
  | { name: 'lab'; tab: LabTab }
  | { name: 'about' }
  | { name: 'notFound'; path: string };

export type RouteName = Route['name'];

function pickTab<T extends string>(tabs: readonly T[], value: string | undefined, fallback: T): T | null {
  if (value === undefined || value === '') return fallback;
  return (tabs as readonly string[]).includes(value) ? (value as T) : null;
}

function positiveInt(s: string | null | undefined): number | undefined {
  if (!s || !/^\d{1,10}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 0xffffffff ? n : undefined;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse a location hash ("#/ledger/12?x=1") into a Route. Never throws. */
export function parseRoute(hash: string): Route {
  let h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h.startsWith('/')) h = `/${h}`;
  const qi = h.indexOf('?');
  const pathPart = qi >= 0 ? h.slice(0, qi) : h;
  const query = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  const parts = pathPart.split('/').filter(Boolean).map(safeDecode);
  const notFound: Route = { name: 'notFound', path: pathPart };
  const [head, arg, extra] = parts;

  if (parts.length === 0) return { name: 'overview' };
  switch (head) {
    case 'overview':
      return parts.length === 1 ? { name: 'overview' } : notFound;
    case 'validator': {
      const tab = pickTab(VALIDATOR_TABS, arg, 'node');
      return tab && extra === undefined ? { name: 'validator', tab } : notFound;
    }
    case 'explorer':
    case 'ledgers': {
      if (parts.length > 1) return notFound;
      const before = positiveInt(query.get('before'));
      return before ? { name: 'ledgers', before } : { name: 'ledgers' };
    }
    case 'ledger': {
      const seq = positiveInt(arg);
      return seq && extra === undefined ? { name: 'ledger', seq } : notFound;
    }
    case 'txs': {
      if (parts.length > 1) return notFound;
      const before = positiveInt(query.get('before'));
      return before ? { name: 'txs', before } : { name: 'txs' };
    }
    case 'tx': {
      const hash = (arg ?? '').toLowerCase();
      return /^[0-9a-f]{64}$/.test(hash) && extra === undefined ? { name: 'tx', hash } : notFound;
    }
    case 'account': {
      const id = (arg ?? '').trim().toUpperCase();
      return /^[GM][A-Z2-7]{55,68}$/.test(id) && extra === undefined ? { name: 'account', id } : notFound;
    }
    case 'assets':
      return parts.length === 1 ? { name: 'assets' } : notFound;
    case 'search': {
      const q = parts.slice(1).join('/') || query.get('q') || '';
      return { name: 'search', q };
    }
    case 'wallet': {
      const tab = pickTab(WALLET_TABS, arg, 'send');
      return tab && extra === undefined ? { name: 'wallet', tab } : notFound;
    }
    case 'lab': {
      const tab = pickTab(LAB_TABS, arg, 'decode');
      return tab && extra === undefined ? { name: 'lab', tab } : notFound;
    }
    case 'about':
      return parts.length === 1 ? { name: 'about' } : notFound;
    default:
      return notFound;
  }
}

/** Canonical href for a route ("#/ledger/12"). */
export function routeHref(route: Route): string {
  switch (route.name) {
    case 'overview':
      return '#/';
    case 'validator':
      return route.tab === 'node' ? '#/validator' : `#/validator/${route.tab}`;
    case 'ledgers':
      return route.before ? `#/ledgers?before=${route.before}` : '#/ledgers';
    case 'ledger':
      return `#/ledger/${route.seq}`;
    case 'txs':
      return route.before ? `#/txs?before=${route.before}` : '#/txs';
    case 'tx':
      return `#/tx/${route.hash}`;
    case 'account':
      return `#/account/${route.id}`;
    case 'assets':
      return '#/assets';
    case 'search':
      return `#/search/${encodeURIComponent(route.q)}`;
    case 'wallet':
      return route.tab === 'send' ? '#/wallet' : `#/wallet/${route.tab}`;
    case 'lab':
      return route.tab === 'decode' ? '#/lab' : `#/lab/${route.tab}`;
    case 'about':
      return '#/about';
    case 'notFound':
      return `#${route.path}`;
  }
}

export const href = {
  overview: () => '#/',
  ledger: (seq: number) => `#/ledger/${seq}`,
  tx: (hash: string) => `#/tx/${hash}`,
  account: (id: string) => `#/account/${id}`,
  ledgers: (before?: number) => routeHref({ name: 'ledgers', before }),
  txs: (before?: number) => routeHref({ name: 'txs', before }),
  assets: () => '#/assets',
  validator: (tab: ValidatorTab = 'node') => routeHref({ name: 'validator', tab }),
  wallet: (tab: WalletTab = 'send') => routeHref({ name: 'wallet', tab }),
  lab: (tab: LabTab = 'decode') => routeHref({ name: 'lab', tab }),
  about: () => '#/about',
  search: (q: string) => routeHref({ name: 'search', q }),
};

/** Top-level section a route belongs to (for nav highlighting). */
export type Section = 'overview' | 'validator' | 'explorer' | 'wallet' | 'lab' | 'about' | 'none';

export function sectionOf(route: Route): Section {
  switch (route.name) {
    case 'overview':
      return 'overview';
    case 'validator':
      return 'validator';
    case 'ledgers':
    case 'ledger':
    case 'txs':
    case 'tx':
    case 'account':
    case 'assets':
    case 'search':
      return 'explorer';
    case 'wallet':
      return 'wallet';
    case 'lab':
      return 'lab';
    case 'about':
      return 'about';
    default:
      return 'none';
  }
}
