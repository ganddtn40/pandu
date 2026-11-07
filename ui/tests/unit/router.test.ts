import { describe, expect, it } from 'vitest';
import { normalizePath } from '../../src/lib/router';

describe('normalizePath', () => {
  it('keeps the two Phase 4 routes', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/glass-preview')).toBe('/glass-preview');
  });

  it('normalizes trailing slashes and query strings', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/glass-preview/')).toBe('/glass-preview');
    expect(normalizePath('/glass-preview?theme=light')).toBe('/glass-preview');
    expect(normalizePath('/?theme=dark#top')).toBe('/');
  });

  it('falls back to home for unknown routes', () => {
    expect(normalizePath('/flights')).toBe('/');
    expect(normalizePath('/settings/')).toBe('/');
    expect(normalizePath('/glass-preview/extra')).toBe('/');
  });
});
