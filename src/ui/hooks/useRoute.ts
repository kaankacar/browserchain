import { useMemo, useSyncExternalStore } from 'react';
import { parseRoute, type Route } from '../lib/route';

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

function getHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, getHash, () => '');
}

export function useRoute(): Route {
  const hash = useHash();
  return useMemo(() => parseRoute(hash), [hash]);
}

/** Go to "#/..." (adds a history entry unless replace). */
export function navigate(href: string, opts: { replace?: boolean } = {}): void {
  const target = href.startsWith('#') ? href : `#${href}`;
  if (opts.replace) {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (window.location.hash !== target) {
    window.location.hash = target;
  }
}
