import { nextTheme, resolveTheme, type Theme } from './theme';

const STORAGE_KEY = 'cockpit.theme';

function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  const params = new URLSearchParams(window.location.search);
  return resolveTheme(
    localStorage.getItem(STORAGE_KEY),
    window.matchMedia('(prefers-color-scheme: light)').matches,
    params.get('theme'),
  );
}

export const themeState = $state<{ value: Theme }>({ value: currentTheme() });

export function setTheme(theme: Theme): void {
  themeState.value = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable in private windows. The theme still applies.
  }
  window.dispatchEvent(new CustomEvent<Theme>('cockpit:theme', { detail: theme }));
}

export function toggleTheme(): void {
  setTheme(nextTheme(themeState.value));
}
