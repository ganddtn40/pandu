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
    expect(resolveTheme('dark', true, 'light')).toBe('light');
    expect(resolveTheme('light', false, 'dark')).toBe('dark');
  });

  it('falls back to the saved theme', () => {
    expect(resolveTheme('light', false, null)).toBe('light');
    expect(resolveTheme('dark', true, null)).toBe('dark');
  });

  it('uses the OS preference when nothing is saved', () => {
    expect(resolveTheme(null, true, null)).toBe('light');
    expect(resolveTheme(null, false, null)).toBe('dark');
    expect(resolveTheme('sepia', false, null)).toBe('dark');
  });
});

describe('nextTheme', () => {
  it('toggles between light and dark', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });
});
