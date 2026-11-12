export type Theme = 'light' | 'dark';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/**
 * Pick the theme from an explicit override, then storage, then the product
 * default. Light is the product default; the OS preference no longer decides.
 */
export function resolveTheme(saved: string | null, forced: string | null): Theme {
  if (isTheme(forced)) return forced;
  if (isTheme(saved)) return saved;
  return 'light';
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : 'light';
}
