export type Theme = 'light' | 'dark';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** Pick the theme from an explicit override, then storage, then the OS. */
export function resolveTheme(
  saved: string | null,
  systemPrefersLight: boolean,
  forced: string | null,
): Theme {
  if (isTheme(forced)) return forced;
  if (isTheme(saved)) return saved;
  return systemPrefersLight ? 'light' : 'dark';
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : 'light';
}
