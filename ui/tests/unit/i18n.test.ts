import { describe, expect, it } from 'vitest';
import { catalogs, translate, type Message } from '../../src/lib/i18n/catalog';

function forms(value: Message): string[] {
  if (typeof value === 'string') return [value];
  return Object.values(value).filter((form): form is string => typeof form === 'string');
}

describe('translation catalogs', () => {
  it('keeps English complete', () => {
    const english = catalogs.en;
    expect(Object.keys(english).length).toBeGreaterThan(150);
    for (const value of Object.values(english)) {
      const entries = forms(value);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.trim().length).toBeGreaterThan(0);
      }
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

  it('selects plural forms with Intl.PluralRules', () => {
    expect(translate('en', 'flights.steps', { count: 1 })).toBe('1 step');
    expect(translate('en', 'flights.steps', { count: 2 })).toBe('2 steps');
    expect(translate('en', 'home.unpricedCalls', { count: 1 })).toBe('1 unpriced call');
    expect(translate('en', 'home.unpricedCalls', { count: 0 })).toBe('0 unpriced calls');
    expect(translate('es', 'flights.steps', { count: 1 })).toBe('1 paso');
    expect(translate('es', 'flights.steps', { count: 2 })).toBe('2 pasos');
    expect(translate('ja', 'flights.steps', { count: 1 })).toBe('1 ステップ');
  });

  it('returns the key when no catalog has a value', () => {
    expect(translate('id', 'missing.key' as never)).toBe('missing.key');
  });
});
