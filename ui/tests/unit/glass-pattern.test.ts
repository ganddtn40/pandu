import { describe, expect, it } from 'vitest';
import { isGlassPattern, readGlassPattern } from '../../src/lib/glass-pattern';

describe('isGlassPattern', () => {
  it('accepts only the two wallpaper patterns', () => {
    expect(isGlassPattern('smoky')).toBe(true);
    expect(isGlassPattern('checker')).toBe(true);
    expect(isGlassPattern('stripes')).toBe(false);
    expect(isGlassPattern(null)).toBe(false);
  });
});

describe('readGlassPattern', () => {
  it('prefers a valid URL override', () => {
    expect(readGlassPattern('?pattern=checker')).toBe('checker');
    expect(readGlassPattern('?pattern=smoky')).toBe('smoky');
  });

  it('falls back to smoky for an invalid override', () => {
    expect(readGlassPattern('?pattern=plaid')).toBe('smoky');
    expect(readGlassPattern('')).toBe('smoky');
  });
});
