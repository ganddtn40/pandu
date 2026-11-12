import { describe, expect, it } from 'vitest';
import { isTheme, nextTheme, resolveTheme } from '../../src/lib/theme';

describe('isTheme', () => {
  it('accepts only the two themes', () => {
    expect(isTheme('light')).toBe(true);
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('system')).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(1)).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('prefers a forced URL theme', () => {
    expect(resolveTheme('dark', 'light')).toBe('light');
    expect(resolveTheme('light', 'dark')).toBe('dark');
  });

  it('falls back to the saved theme', () => {
    expect(resolveTheme('light', null)).toBe('light');
    expect(resolveTheme('dark', null)).toBe('dark');
  });

  it('uses light when nothing is saved', () => {
    expect(resolveTheme(null, null)).toBe('light');
    expect(resolveTheme('sepia', null)).toBe('light');
  });
});

describe('nextTheme', () => {
  it('toggles between light and dark', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });
});
