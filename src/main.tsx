// Browser entry.
import './index.css';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_NETWORK_NAME } from './lib/constants';
import type { NodeApi } from './node/api';
import { BootError, bootNode } from './node/boot';
import { App } from './ui/App';
import { applyTheme, initialTheme } from './ui/hooks/useTheme';

applyTheme(initialTheme());

const params = new URLSearchParams(window.location.search);
const network = params.get('network') || DEFAULT_NETWORK_NAME;

/**
 * Pick the node implementation: by default a real validator in a Web Worker
 * (src/node/boot.ts); the in-page mock with simulated data behind ?mock=1.
 * `&demo=strangers` or `&demo=blocked` makes the mock play a node state that
 * needs the user (MockDemo).
 */
async function createApi(): Promise<{ api: NodeApi; mock: boolean; onFatal?: (cb: (err: Error) => void) => void }> {
  if (params.get('mock') === '1') {
    const { createMockNode, parseMockDemo } = await import('./ui/mock/mockNode');
    return { api: createMockNode({ networkName: network, demo: parseMockDemo(params.get('demo')) }), mock: true };
  }
  const { client } = await bootNode();
  return { api: client, mock: false, onFatal: (cb) => client.onFatal(cb) };
}

/** The same URL with some query parameters set or removed. */
function urlWith(changes: Record<string, string | null>): string {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`;
}

function Booting() {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 text-fg">
      <div className="flex items-center gap-3 text-sm text-fg-2" role="status">
        <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-line-strong border-t-ledger" />
        Starting your validator…
      </div>
    </div>
  );
}

/** Shown when the validator cannot start (or stops for good). */
function BootFailed({ error, stopped }: { error: unknown; stopped: boolean }) {
  const step = error instanceof BootError ? error.step : stopped ? 'The validator' : 'Starting the validator';
  const detail = error instanceof BootError ? error.detail : error instanceof Error ? error.message : String(error);
  const link = 'font-medium text-ledger underline underline-offset-2 hover:opacity-80';
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-10 text-fg">
      <main className="w-full max-w-xl rounded-xl border border-line bg-panel p-6 shadow-panel">
        <h1 className="text-lg font-semibold">{stopped ? 'Your validator stopped' : 'Could not start your validator'}</h1>
        <p className="mt-3 text-sm text-fg-2">
          <span className="font-medium text-fg">{step}</span> failed:
        </p>
        <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-sunken p-3 font-mono text-xs text-bad [overflow-wrap:anywhere]">
          {detail}
        </pre>
        <h2 className="mt-5 text-sm font-semibold">How to retry</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-fg-2">
          <li>
            <button type="button" className={link} onClick={() => window.location.reload()}>
              Reload the page
            </button>
            . A short hiccup (another tab starting, a slow disk) is usually gone.
          </li>
          <li>
            Start with a fresh in-memory identity:{' '}
            <a className={link} href={urlWith({ fresh: '1', mock: null })}>
              ?fresh=1
            </a>
            . This skips IndexedDB, which some private windows block.
          </li>
          <li>
            Close other BrowserChain tabs, or allow this site to store data, then reload.
          </li>
        </ul>
        <p className="mt-5 text-sm text-fg-2">
          Or look around with simulated data:{' '}
          <a className={link} href={urlWith({ mock: '1', fresh: null })}>
            open the demo (?mock=1)
          </a>
          .
        </p>
        <p className="mt-4 text-xs text-fg-3">BrowserChain needs Web Workers, IndexedDB and BroadcastChannel (WebRTC to reach other browsers).</p>
      </main>
    </div>
  );
}

function renderFailure(root: Root, error: unknown, stopped: boolean): void {
  console.error('BrowserChain boot failed', error);
  root.render(
    <StrictMode>
      <BootFailed error={error} stopped={stopped} />
    </StrictMode>,
  );
}

async function main(): Promise<void> {
  const el = document.getElementById('root');
  if (!el) throw new Error('missing #root');
  const root = createRoot(el);
  root.render(<Booting />);
  let created: Awaited<ReturnType<typeof createApi>>;
  try {
    created = await createApi();
  } catch (err) {
    renderFailure(root, err, false);
    return;
  }
  const { api, mock } = created;
  // Handy in the dev server console: await window.__browserchain.getStatus()
  // (boot.ts always exposes the real client).
  if (mock && import.meta.env.DEV) (window as unknown as { __browserchain: NodeApi }).__browserchain = api;
  created.onFatal?.((err) => renderFailure(root, err, true));
  root.render(
    <StrictMode>
      <App api={api} mock={mock} />
    </StrictMode>,
  );
}

void main();
