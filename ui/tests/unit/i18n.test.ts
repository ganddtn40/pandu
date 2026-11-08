import { describe, expect, it } from 'vitest';
import { catalogs, translate } from '../../src/lib/i18n/catalog';

describe('translation catalogs', () => {
  it('keeps English complete', () => {
    const english = catalogs.en;
    expect(Object.keys(english).length).toBeGreaterThan(150);
    for (const value of Object.values(english)) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('falls back to English per key for draft languages', () => {
    expect(translate('id', 'common.online')).toBe('Daring');
    expect(translate('id', 'flights.lede')).toBe(catalogs.en['flights.lede']);
  });

  it('interpolates variables and leaves unknown placeholders alone', () => {
    expect(translate('en', 'topbar.activeFlights', { count: 3 })).toBe('3 active');
    expect(translate('id', 'topbar.activeFlights', { count: 2 })).toBe('2 aktif');
    expect(translate('en', 'topbar.activeFlights')).toBe('{count} active');
  });

  it('returns the key when no catalog has a value', () => {
    expect(translate('id', 'missing.key' as never)).toBe('missing.key');
  });
});
