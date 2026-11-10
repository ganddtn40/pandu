export type GlassPattern = 'smoky' | 'checker';

import { storageKey } from './brand';

const STORAGE_KEY = storageKey('glassPattern');

export function isGlassPattern(value: unknown): value is GlassPattern {
  return value === 'smoky' || value === 'checker';
}

/** URL override, then saved choice, then the smoky wallpaper. */
export function readGlassPattern(search: string): GlassPattern {
  const forced = new URLSearchParams(search).get('pattern');
  if (isGlassPattern(forced)) return forced;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isGlassPattern(saved)) return saved;
  } catch {
    // Storage is optional.
  }
  return 'smoky';
}

export function applyGlassPattern(pattern: GlassPattern, persist = true): void {
  document.documentElement.dataset.glassPattern = pattern;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, pattern);
    } catch {
      // Storage is optional.
    }
  }
  window.dispatchEvent(new CustomEvent<GlassPattern>('pandu:pattern', { detail: pattern }));
}
