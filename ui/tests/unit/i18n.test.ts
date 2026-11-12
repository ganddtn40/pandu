import { describe, expect, it } from 'vitest';
import { englishCatalog, isCatalogLoaded, loadCatalog, translate, type Message } from '../../src/lib/i18n/catalog';
import { LANGUAGES, isRtlLanguage } from '../../src/lib/design/types';

function forms(value: Message): string[] {
  if (typeof value === 'string') return [value];
  return Object.values(value).filter((form): form is string => typeof form === 'string');
}

describe('translation catalogs', () => {
  it('keeps English complete', () => {
    expect(Object.keys(englishCatalog).length).toBeGreaterThan(150);
    for (const value of Object.values(englishCatalog)) {
      const entries = forms(value);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('loads every catalog', async () => {
    for (const { id } of LANGUAGES) {
      await loadCatalog(id);
      expect(isCatalogLoaded(id)).toBe(true);
    }
    expect(translate('ar', 'nav.home')).toBe('الرئيسية');
    expect(translate('ko', 'nav.home')).toBe('홈');
  });

  it('falls back to English per key for draft languages', async () => {
    await loadCatalog('id');
    expect(translate('id', 'common.online')).toBe('Daring');
    expect(translate('id', 'flights.lede')).toBe(englishCatalog['flights.lede']);
  });

  it('interpolates variables and leaves unknown placeholders alone', async () => {
    await loadCatalog('id');
    expect(translate('en', 'topbar.activeFlights', { count: 3 })).toBe('3 active');
    expect(translate('id', 'topbar.activeFlights', { count: 2 })).toBe('2 aktif');
    expect(translate('en', 'topbar.activeFlights')).toBe('{count} active');
  });

  it('selects plural forms with Intl.PluralRules', async () => {
    await Promise.all([loadCatalog('es'), loadCatalog('ja'), loadCatalog('ar'), loadCatalog('ru')]);
    expect(translate('en', 'flights.steps', { count: 1 })).toBe('1 step');
    expect(translate('en', 'flights.steps', { count: 2 })).toBe('2 steps');
    expect(translate('en', 'home.unpricedCalls', { count: 1 })).toBe('1 unpriced call');
    expect(translate('en', 'home.unpricedCalls', { count: 0 })).toBe('0 unpriced calls');
    expect(translate('es', 'flights.steps', { count: 1 })).toBe('1 paso');
    expect(translate('es', 'flights.steps', { count: 2 })).toBe('2 pasos');
    expect(translate('ja', 'flights.steps', { count: 1 })).toBe('1 ステップ');
    expect(translate('ar', 'flights.steps', { count: 2 })).toBe('خطوتان');
    expect(translate('ru', 'flights.steps', { count: 2 })).toBe('2 шага');
  });

  it('returns the key when no catalog has a value', () => {
    expect(translate('id', 'missing.key' as never)).toBe('missing.key');
  });

  it('marks Arabic as the only right-to-left language', () => {
    expect(isRtlLanguage('ar')).toBe(true);
    for (const { id } of LANGUAGES) {
      if (id !== 'ar') expect(isRtlLanguage(id)).toBe(false);
    }
  });
});
