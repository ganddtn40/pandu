import { describe, expect, it } from 'vitest';
import {
  DESIGN_STORAGE_KEY,
  LEGACY_PERFORMANCE_KEY,
  LEGACY_THEME_KEY,
  WALLPAPER_STORAGE_KEY,
  decodeTheme,
  designFromTheme,
  encodeTheme,
  loadDesign,
  normalizeDesign,
  parseThemeJson,
  parseThemeText,
  readShareFromSearch,
  saveDesign,
  themeShareUrl,
  themeToJson,
  type StorageLike,
} from '../../src/lib/design/theme-json';
import {
  DEFAULT_DESIGN,
  THEME_SCHEMA,
  THEME_TEXT_LIMIT,
  THEME_VERSION,
  type DesignPreferences,
} from '../../src/lib/design/types';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function validTheme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...themeToJson(DEFAULT_DESIGN), ...overrides };
}

describe('themeToJson and parseThemeJson', () => {
  it('round-trips the default design', () => {
    const json = themeToJson(DEFAULT_DESIGN);
    const parsed = parseThemeJson(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(json);
  });

  it('accepts a valid theme and ignores unknown future fields', () => {
    const parsed = parseThemeJson(validTheme({ futureField: 'ignored' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.schema).toBe(THEME_SCHEMA);
  });

  it('rejects the wrong schema or a newer version', () => {
    expect(parseThemeJson({ ...validTheme(), schema: 'other' }).ok).toBe(false);
    expect(parseThemeJson(validTheme({ version: THEME_VERSION + 1 })).ok).toBe(false);
    expect(parseThemeJson(validTheme({ version: 0 })).ok).toBe(false);
    expect(parseThemeJson(validTheme({ version: 1.5 })).ok).toBe(false);
  });

  it('rejects invalid enums, sizes, and glass values', () => {
    for (const key of ['theme', 'surface', 'accent', 'radius', 'density', 'font', 'wallpaper', 'motion', 'language']) {
      expect(parseThemeJson(validTheme({ [key]: 'nope' })).ok, key).toBe(false);
    }
    expect(parseThemeJson(validTheme({ fontScale: 0.4 })).ok).toBe(false);
    expect(parseThemeJson(validTheme({ fontScale: 9 })).ok).toBe(false);
    expect(parseThemeJson(validTheme({ borders: 'yes' })).ok).toBe(false);
    expect(parseThemeJson(validTheme({ glass: null })).ok).toBe(false);
    expect(parseThemeJson(validTheme({ glass: { intensity: 55, blur: 55 } })).ok).toBe(false);
    expect(
      parseThemeJson(validTheme({ glass: { intensity: 101, blur: 55, refraction: 55 } })).ok,
    ).toBe(false);
  });

  it('rejects non-objects and invalid JSON text', () => {
    expect(parseThemeJson(null).ok).toBe(false);
    expect(parseThemeJson('theme').ok).toBe(false);
    expect(parseThemeText('{').ok).toBe(false);
    expect(parseThemeText('x'.repeat(THEME_TEXT_LIMIT + 1)).ok).toBe(false);
  });
});

describe('designFromTheme', () => {
  const theme = themeToJson({
    ...DEFAULT_DESIGN,
    theme: 'light',
    surface: 'matte',
    accent: 'blue',
    wallpaper: 'image',
  });

  it('applies every shared design field', () => {
    const next = designFromTheme(theme, DEFAULT_DESIGN);
    expect(next.theme).toBe('light');
    expect(next.surface).toBe('matte');
    expect(next.accent).toBe('blue');
  });

  it('never imports a wallpaper image or performance mode', () => {
    const base: DesignPreferences = {
      ...DEFAULT_DESIGN,
      wallpaperImage: 'data:image/jpeg;base64,abc',
      performance: true,
    };
    const next = designFromTheme(theme, base);
    expect(next.wallpaperImage).toBe(base.wallpaperImage);
    expect(next.performance).toBe(true);
    expect(next.wallpaper).toBe('image');
  });

  it('downgrades an image wallpaper when this device has no image', () => {
    const next = designFromTheme(theme, DEFAULT_DESIGN);
    expect(next.wallpaper).toBe('procedural');
  });
});

describe('normalizeDesign', () => {
  it('clamps numbers and falls back for invalid enums', () => {
    const next = normalizeDesign({
      version: 1,
      theme: 'sepia',
      surface: 'glass',
      accent: 'blue',
      fontScale: 99,
      glassIntensity: -10,
      glassBlur: 140,
      glassRefraction: 'high',
      borders: 'yes',
      motion: 'off',
      performance: true,
    });
    expect(next.theme).toBe(DEFAULT_DESIGN.theme);
    expect(next.surface).toBe('glass');
    expect(next.accent).toBe('blue');
    expect(next.fontScale).toBe(1.3);
    expect(next.glassIntensity).toBe(0);
    expect(next.glassBlur).toBe(100);
    expect(next.glassRefraction).toBe(DEFAULT_DESIGN.glassRefraction);
    expect(next.borders).toBe(DEFAULT_DESIGN.borders);
    expect(next.motion).toBe('off');
    expect(next.performance).toBe(true);
  });

  it('ignores a design written by a newer app version', () => {
    const next = normalizeDesign({ ...DEFAULT_DESIGN, version: 99, accent: 'green' }, DEFAULT_DESIGN);
    expect(next).toEqual(DEFAULT_DESIGN);
  });

  it('returns the base for non-objects', () => {
    expect(normalizeDesign(null)).toEqual(DEFAULT_DESIGN);
    expect(normalizeDesign([])).toEqual(DEFAULT_DESIGN);
  });
});

describe('loadDesign and saveDesign', () => {
  it('returns the defaults for empty storage', () => {
    expect(loadDesign(new MemoryStorage())).toEqual(DEFAULT_DESIGN);
  });

  it('migrates legacy theme and performance keys when no design exists', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_THEME_KEY, 'light');
    storage.setItem(LEGACY_PERFORMANCE_KEY, '1');
    const design = loadDesign(storage);
    expect(design.theme).toBe('light');
    expect(design.performance).toBe(true);
  });

  it('prefers the new design key over legacy keys', () => {
    const storage = new MemoryStorage();
    storage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ ...DEFAULT_DESIGN, theme: 'frost' }));
    storage.setItem(LEGACY_THEME_KEY, 'light');
    expect(loadDesign(storage).theme).toBe('frost');
  });

  it('applies URL overrides and clamps font scale', () => {
    const design = loadDesign(
      new MemoryStorage(),
      '?theme=light&surface=matte&accent=violet&radius=round&density=compact&font=inter&fontScale=9&motion=off&borders=off&wallpaper=none&lang=ja',
    );
    expect(design).toMatchObject({
      theme: 'light',
      surface: 'matte',
      accent: 'violet',
      radius: 'round',
      density: 'compact',
      font: 'inter',
      fontScale: 1.3,
      motion: 'off',
      borders: false,
      wallpaper: 'none',
      language: 'ja',
    });
  });

  it('honors ?glass=off and ?perf=0', () => {
    expect(loadDesign(new MemoryStorage(), '?glass=off').performance).toBe(true);
    expect(loadDesign(new MemoryStorage(), '?perf=0').performance).toBe(false);
  });

  it('applies a shared theme before explicit URL overrides', () => {
    const theme = themeToJson({ ...DEFAULT_DESIGN, theme: 'light', accent: 'green' });
    const search = `?share=${encodeTheme(theme)}&accent=blue`;
    const design = loadDesign(new MemoryStorage(), search);
    expect(design.theme).toBe('light');
    expect(design.accent).toBe('blue');
  });

  it('downgrades image wallpaper without a stored image and loads one when present', () => {
    const storage = new MemoryStorage();
    storage.setItem(DESIGN_STORAGE_KEY, JSON.stringify({ ...DEFAULT_DESIGN, wallpaper: 'image' }));
    expect(loadDesign(storage).wallpaper).toBe('procedural');

    storage.setItem(WALLPAPER_STORAGE_KEY, 'data:image/jpeg;base64,abc');
    expect(loadDesign(storage).wallpaper).toBe('image');
    expect(loadDesign(storage).wallpaperImage).toBe('data:image/jpeg;base64,abc');
  });

  it('saves the design without embedding the wallpaper image', () => {
    const storage = new MemoryStorage();
    const design: DesignPreferences = {
      ...DEFAULT_DESIGN,
      wallpaper: 'image',
      wallpaperImage: 'data:image/jpeg;base64,abc',
      performance: true,
    };
    saveDesign(storage, design);

    const stored = JSON.parse(storage.getItem(DESIGN_STORAGE_KEY)!) as Record<string, unknown>;
    expect(stored.wallpaperImage).toBeUndefined();
    expect(stored.wallpaper).toBe('image');
    expect(storage.getItem(WALLPAPER_STORAGE_KEY)).toBe(design.wallpaperImage);
    expect(storage.getItem(LEGACY_THEME_KEY)).toBe(DEFAULT_DESIGN.theme);
    expect(storage.getItem(LEGACY_PERFORMANCE_KEY)).toBe('1');
  });

  it('removes a stale wallpaper image when the wallpaper changes', () => {
    const storage = new MemoryStorage();
    storage.setItem(WALLPAPER_STORAGE_KEY, 'data:image/jpeg;base64,abc');
    saveDesign(storage, { ...DEFAULT_DESIGN, wallpaper: 'procedural' });
    expect(storage.getItem(WALLPAPER_STORAGE_KEY)).toBeNull();
  });

  it('never throws when storage is full', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(() => saveDesign(storage, DEFAULT_DESIGN)).not.toThrow();
  });
});

describe('theme sharing', () => {
  it('round-trips a theme through the URL-safe encoding', () => {
    const theme = themeToJson(DEFAULT_DESIGN);
    const decoded = decodeTheme(encodeTheme(theme));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(theme);
  });

  it('reports damaged share links instead of throwing', () => {
    expect(decodeTheme('').ok).toBe(false);
    expect(decodeTheme('!!!').ok).toBe(false);
    expect(decodeTheme('bm90LWpzb24').ok).toBe(false);
  });

  it('builds a share URL and reads it back', () => {
    const theme = themeToJson({ ...DEFAULT_DESIGN, theme: 'frost' });
    const url = themeShareUrl(theme, 'https://pandu.example');
    expect(url.startsWith('https://pandu.example/?share=')).toBe(true);
    const shared = readShareFromSearch(new URL(url).search);
    expect(shared?.theme).toBe('frost');
    expect(readShareFromSearch('?theme=light')).toBeNull();
    expect(readShareFromSearch('?share=!!!')).toBeNull();
  });
});
