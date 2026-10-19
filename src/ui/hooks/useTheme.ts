import { useCallback, useEffect, useState } from 'react';
import { readPref, writePref } from '../lib/wallet';

export type Theme = 'dark' | 'light';
const KEY = 'browserchain:theme';

export function initialTheme(): Theme {
  return readPref<Theme>(KEY, 'dark') === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f6f3' : '#0a0a0c');
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    applyTheme(theme);
    writePref(KEY, theme);
  }, [theme]);
  // every tab is a validator, so people keep several open: follow a switch made in another tab
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY || e.key === null) setTheme(initialTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}
