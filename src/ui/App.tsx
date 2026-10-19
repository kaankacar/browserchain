import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Component, useEffect, useMemo, type ErrorInfo, type ReactNode } from 'react';
import { RealClock, type Clock } from '../lib/clock';
import type { NodeApi } from '../node/api';
import { AboutPage } from './about/AboutPage';
import { Button, Card } from './components/ui';
import { AccountPage } from './explorer/AccountPage';
import { AssetsPage } from './explorer/AssetsPage';
import { LedgerPage } from './explorer/LedgerPage';
import { LedgersPage } from './explorer/LedgersPage';
import { SearchPage } from './explorer/SearchPage';
import { TxPage } from './explorer/TxPage';
import { TxsPage } from './explorer/TxsPage';
import { useRoute } from './hooks/useRoute';
import { LabPage } from './lab/LabPage';
import { Shell } from './layout/Shell';
import { formatNumber, middleEllipsis } from './lib/format';
import type { Route } from './lib/route';
import { NotFoundPage } from './NotFoundPage';
import { OverviewPage } from './overview/OverviewPage';
import { NodeProvider } from './state/NodeProvider';
import { ToastProvider } from './state/toast';
import { WalletProvider } from './state/wallet';
import { ValidatorPage } from './validator/ValidatorPage';
import { WalletPage } from './wallet/WalletPage';

export interface AppProps {
  /** The node: the real worker client, or the mock (createMockNode). */
  api: NodeApi;
  /** Injected clock for timers in the UI (defaults to RealClock). */
  clock?: Clock;
  /** Shows a "demo" badge when the api is the mock. */
  mock?: boolean;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Card title="Something went wrong on this page" icon={TriangleAlert} iconClass="text-bad">
        <p className="text-sm text-fg-2">{this.state.error.message}</p>
        <Button className="mt-4" icon={RefreshCw} onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </Card>
    );
  }
}

export function titleFor(route: Route): string {
  switch (route.name) {
    case 'overview':
      return 'Overview';
    case 'validator':
      return 'Validator';
    case 'ledgers':
      return 'Ledgers';
    case 'ledger':
      return `Ledger #${formatNumber(route.seq)}`;
    case 'txs':
      return 'Transactions';
    case 'tx':
      return `Transaction ${middleEllipsis(route.hash, 6, 4)}`;
    case 'account':
      return `Account ${middleEllipsis(route.id, 4, 4)}`;
    case 'assets':
      return 'Assets';
    case 'search':
      return 'Search';
    case 'wallet':
      return 'Wallet';
    case 'lab':
      return 'Lab';
    case 'about':
      return 'About';
    case 'notFound':
      return 'Not found';
  }
}

function routeKey(route: Route): string {
  switch (route.name) {
    case 'ledger':
      return `ledger:${route.seq}`;
    case 'tx':
      return `tx:${route.hash}`;
    case 'account':
      return `account:${route.id}`;
    case 'search':
      return `search:${route.q}`;
    default:
      return route.name;
  }
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'overview':
      return <OverviewPage />;
    case 'validator':
      return <ValidatorPage tab={route.tab} />;
    case 'ledgers':
      return <LedgersPage before={route.before} />;
    case 'ledger':
      return <LedgerPage seq={route.seq} />;
    case 'txs':
      return <TxsPage before={route.before} />;
    case 'tx':
      return <TxPage hash={route.hash} />;
    case 'account':
      return <AccountPage id={route.id} />;
    case 'assets':
      return <AssetsPage />;
    case 'search':
      return <SearchPage q={route.q} />;
    case 'wallet':
      return <WalletPage tab={route.tab} />;
    case 'lab':
      return <LabPage tab={route.tab} />;
    case 'about':
      return <AboutPage />;
    case 'notFound':
      return <NotFoundPage path={route.path} />;
  }
}

function Router({ mock }: { mock: boolean }) {
  const route = useRoute();
  const key = routeKey(route);
  useEffect(() => {
    document.title = `${titleFor(route)} · BrowserChain`;
  }, [route]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [key]);
  return (
    <Shell route={route} mock={mock}>
      <ErrorBoundary key={key}>
        <Page route={route} />
      </ErrorBoundary>
    </Shell>
  );
}

/** The whole BrowserChain UI for one NodeApi. */
export function App({ api, clock, mock = false }: AppProps) {
  const clk = useMemo(() => clock ?? new RealClock(), [clock]);
  return (
    <NodeProvider api={api} clock={clk}>
      <ToastProvider>
        <WalletProvider>
          <Router mock={mock} />
        </WalletProvider>
      </ToastProvider>
    </NodeProvider>
  );
}
