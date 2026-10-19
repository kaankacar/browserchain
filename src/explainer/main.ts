// Entry of the explainer page (how-it-works.html): its styles and the theme
// button. The page is static: it never starts a node or a worker.

import '../index.css';
import './explainer.css';

type Theme = 'dark' | 'light';

/** The app's theme choice (src/ui/hooks/useTheme.ts), JSON in localStorage. */
const THEME_KEY = 'browserchain:theme';
const THEME_COLOR: Record<Theme, string> = { dark: '#0a0a0c', light: '#f6f6f3' };

function storedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

const systemLight = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

/** The choice made here or in the app, else the system setting. */
function preferredTheme(): Theme {
  return storedTheme() ?? (systemLight?.matches ? 'light' : 'dark');
}

function toggles(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')];
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  for (const button of toggles()) {
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

function setupTheme(): void {
  applyTheme(preferredTheme());
  for (const button of toggles()) {
    button.hidden = false;
    button.addEventListener('click', () => {
      const next: Theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(THEME_KEY, JSON.stringify(next));
      } catch {
        // storage is blocked: the choice lasts for this page view
      }
      applyTheme(next);
    });
  }
  // a switch in another tab of the app or of this page
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY || e.key === null) applyTheme(preferredTheme());
  });
  systemLight?.addEventListener('change', () => {
    if (storedTheme() === null) applyTheme(preferredTheme());
  });
}

setupTheme();
