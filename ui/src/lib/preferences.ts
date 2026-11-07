export interface UiPreferences {
  performance: boolean;
  forceFallback: boolean;
}

/**
 * Read the glass preference. A URL override always wins so screenshots and
 * automated checks can request the CSS fallback deterministically.
 */
export function readPreferences(search: string, storedPerformance: boolean): UiPreferences {
  const params = new URLSearchParams(search);
  const performance = storedPerformance || params.get('perf') === '1';
  const forceFallback = performance || params.get('glass') === 'off';
  return { performance, forceFallback };
}
