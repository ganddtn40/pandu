import {
  DEFAULT_DESIGN,
  DESIGN_SCHEMA_VERSION,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  GLASS_MAX,
  GLASS_MIN,
  THEME_SCHEMA,
  THEME_TEXT_LIMIT,
  THEME_VERSION,
  clampNumber,
  isAccentId,
  isDensityId,
  isFontId,
  isLanguageId,
  isMotionId,
  isRadiusId,
  isSurfaceStyle,
  isThemeMode,
  isWallpaperId,
  type DesignPreferences,
  type ThemeJson,
} from './types';

export const DESIGN_STORAGE_KEY = 'cockpit.design';
export const WALLPAPER_STORAGE_KEY = 'cockpit.wallpaperImage';
export const LEGACY_THEME_KEY = 'cockpit.theme';
export const LEGACY_PERFORMANCE_KEY = 'cockpit.performance';
export const LEGACY_PATTERN_KEY = 'cockpit.glassPattern';

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export type ThemeParseResult =
  | { ok: true; value: ThemeJson }
  | { ok: false; error: string };

function fail(error: string): ThemeParseResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function themeToJson(design: DesignPreferences): ThemeJson {
  return {
    schema: THEME_SCHEMA,
    version: THEME_VERSION,
    theme: design.theme,
    surface: design.surface,
    accent: design.accent,
    radius: design.radius,
    density: design.density,
    font: design.font,
    fontScale: design.fontScale,
    glass: {
      intensity: design.glassIntensity,
      blur: design.glassBlur,
      refraction: design.glassRefraction,
    },
    wallpaper: design.wallpaper,
    borders: design.borders,
    motion: design.motion,
    language: design.language,
  };
}

/**
 * Validate a parsed theme object. Unknown keys are ignored so a future version
 * can add fields without breaking this one, but every known field is checked.
 */
export function parseThemeJson(input: unknown): ThemeParseResult {
  if (!isRecord(input)) return fail('This is not a Cockpit theme object.');
  if (input.schema !== THEME_SCHEMA) {
    return fail('This file is not a Cockpit theme (missing cockpit.theme schema).');
  }
  if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1) {
    return fail('The theme version is missing or invalid.');
  }
  if (input.version > THEME_VERSION) {
    return fail(`Theme version ${input.version} is newer than this app supports (${THEME_VERSION}).`);
  }
  if (!isThemeMode(input.theme)) return fail('Choose a valid theme: dark, light, or frost.');
  if (!isSurfaceStyle(input.surface)) return fail('Choose a valid surface style.');
  if (!isAccentId(input.accent)) return fail('Choose a valid accent.');
  if (!isRadiusId(input.radius)) return fail('Choose a valid corner radius.');
  if (!isDensityId(input.density)) return fail('Choose a valid density.');
  if (!isFontId(input.font)) return fail('Choose a valid font.');
  if (!isWallpaperId(input.wallpaper)) return fail('Choose a valid wallpaper.');
  if (!isMotionId(input.motion)) return fail('Choose a valid motion setting.');
  if (typeof input.borders !== 'boolean') return fail('The card border setting must be true or false.');
  if (typeof input.fontScale !== 'number' || !Number.isFinite(input.fontScale)) {
    return fail('The font size is missing or invalid.');
  }
  if (input.fontScale < FONT_SCALE_MIN || input.fontScale > FONT_SCALE_MAX) {
    return fail(`Font size must be between ${FONT_SCALE_MIN} and ${FONT_SCALE_MAX}.`);
  }
  if (!isLanguageId(input.language)) return fail('Choose a supported language.');
  if (!isRecord(input.glass)) return fail('The glass settings are missing.');

  const glass = input.glass;
  const intensity = glass.intensity;
  const blur = glass.blur;
  const refraction = glass.refraction;
  for (const [key, value] of [
    ['intensity', intensity],
    ['blur', blur],
    ['refraction', refraction],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(`The glass ${key} setting is missing or invalid.`);
    }
    if (value < GLASS_MIN || value > GLASS_MAX) {
      return fail(`The glass ${key} setting must be between ${GLASS_MIN} and ${GLASS_MAX}.`);
    }
  }

  return {
    ok: true,
    value: {
      schema: THEME_SCHEMA,
      version: input.version,
      theme: input.theme,
      surface: input.surface,
      accent: input.accent,
      radius: input.radius,
      density: input.density,
      font: input.font,
      fontScale: input.fontScale,
      glass: {
        intensity: intensity as number,
        blur: blur as number,
        refraction: refraction as number,
      },
      wallpaper: input.wallpaper,
      borders: input.borders,
      motion: input.motion,
      language: input.language,
    },
  };
}

export function parseThemeText(text: string): ThemeParseResult {
  if (text.length > THEME_TEXT_LIMIT) {
    return fail('The theme file is too large. Cockpit themes must be under 32 KB.');
  }
  try {
    return parseThemeJson(JSON.parse(text) as unknown);
  } catch {
    return fail('The theme file is not valid JSON.');
  }
}

/**
 * Merge a theme into the local preferences. Wallpaper images and performance
 * mode are device-local and never imported from a shared theme.
 */
export function designFromTheme(theme: ThemeJson, base: DesignPreferences): DesignPreferences {
  const wallpaper =
    theme.wallpaper === 'image' && !base.wallpaperImage ? 'procedural' : theme.wallpaper;
  return {
    ...base,
    version: DESIGN_SCHEMA_VERSION,
    theme: theme.theme,
    surface: theme.surface,
    accent: theme.accent,
    radius: theme.radius,
    density: theme.density,
    font: theme.font,
    fontScale: theme.fontScale,
    glassIntensity: theme.glass.intensity,
    glassBlur: theme.glass.blur,
    glassRefraction: theme.glass.refraction,
    wallpaper,
    borders: theme.borders,
    motion: theme.motion,
    language: theme.language,
  };
}

export function normalizeDesign(value: unknown, base: DesignPreferences = DEFAULT_DESIGN): DesignPreferences {
  if (!isRecord(value)) return { ...base };
  if (typeof value.version === 'number' && value.version > DESIGN_SCHEMA_VERSION) {
    return { ...base };
  }
  return {
    version: DESIGN_SCHEMA_VERSION,
    theme: isThemeMode(value.theme) ? value.theme : base.theme,
    surface: isSurfaceStyle(value.surface) ? value.surface : base.surface,
    accent: isAccentId(value.accent) ? value.accent : base.accent,
    radius: isRadiusId(value.radius) ? value.radius : base.radius,
    density: isDensityId(value.density) ? value.density : base.density,
    font: isFontId(value.font) ? value.font : base.font,
    fontScale: clampNumber(value.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX, base.fontScale),
    glassIntensity: clampNumber(value.glassIntensity, GLASS_MIN, GLASS_MAX, base.glassIntensity),
    glassBlur: clampNumber(value.glassBlur, GLASS_MIN, GLASS_MAX, base.glassBlur),
    glassRefraction: clampNumber(
      value.glassRefraction,
      GLASS_MIN,
      GLASS_MAX,
      base.glassRefraction,
    ),
    wallpaper: isWallpaperId(value.wallpaper) ? value.wallpaper : base.wallpaper,
    wallpaperImage: base.wallpaperImage,
    borders: typeof value.borders === 'boolean' ? value.borders : base.borders,
    motion: isMotionId(value.motion) ? value.motion : base.motion,
    performance: typeof value.performance === 'boolean' ? value.performance : base.performance,
    language: isLanguageId(value.language) ? value.language : base.language,
  };
}

function readJson(storage: StorageLike, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readLegacy(storage: StorageLike, design: DesignPreferences): DesignPreferences {
  let next = design;
  try {
    const theme = storage.getItem(LEGACY_THEME_KEY);
    if (isThemeMode(theme) && theme !== 'frost') {
      next = { ...next, theme };
    }
    if (storage.getItem(LEGACY_PERFORMANCE_KEY) === '1') {
      next = { ...next, performance: true };
    }
  } catch {
    // Storage can be unavailable. Defaults still apply.
  }
  return next;
}

function applySearchOverrides(design: DesignPreferences, search: string): DesignPreferences {
  const params = new URLSearchParams(search);
  let next = design;

  const shared = params.get('share');
  if (shared) {
    const decoded = decodeTheme(shared);
    if (decoded.ok) next = designFromTheme(decoded.value, next);
  }

  const theme = params.get('theme');
  if (isThemeMode(theme)) next = { ...next, theme };
  const surface = params.get('surface');
  if (isSurfaceStyle(surface)) next = { ...next, surface };
  const accent = params.get('accent');
  if (isAccentId(accent)) next = { ...next, accent };
  const radius = params.get('radius');
  if (isRadiusId(radius)) next = { ...next, radius };
  const density = params.get('density');
  if (isDensityId(density)) next = { ...next, density };
  const font = params.get('font');
  if (isFontId(font)) next = { ...next, font };
  const fontScale = params.get('fontScale');
  if (fontScale !== null) {
    next = {
      ...next,
      fontScale: clampNumber(Number(fontScale), FONT_SCALE_MIN, FONT_SCALE_MAX, next.fontScale),
    };
  }
  const motion = params.get('motion');
  if (isMotionId(motion)) next = { ...next, motion };
  const borders = params.get('borders');
  if (borders === 'on' || borders === '1') next = { ...next, borders: true };
  if (borders === 'off' || borders === '0') next = { ...next, borders: false };
  const wallpaper = params.get('wallpaper');
  if (isWallpaperId(wallpaper)) next = { ...next, wallpaper };
  const language = params.get('lang');
  if (isLanguageId(language)) next = { ...next, language };

  if (params.get('perf') === '1' || params.get('glass') === 'off') {
    next = { ...next, performance: true };
  }
  if (params.get('perf') === '0') next = { ...next, performance: false };

  if (next.wallpaper === 'image' && !next.wallpaperImage) {
    next = { ...next, wallpaper: 'procedural' };
  }
  return next;
}

/**
 * Read the per-device design. Order: defaults, the new design key, legacy keys
 * when the new key is absent, then URL overrides (including a shared theme).
 */
export function loadDesign(storage: StorageLike, search = ''): DesignPreferences {
  let stored: unknown = null;
  try {
    stored = readJson(storage, DESIGN_STORAGE_KEY);
  } catch {
    stored = null;
  }
  let design = normalizeDesign(stored, DEFAULT_DESIGN);

  try {
    const image = storage.getItem(WALLPAPER_STORAGE_KEY);
    if (image && image.startsWith('data:image/')) {
      design = { ...design, wallpaperImage: image };
    }
  } catch {
    // Storage is optional.
  }

  if (stored === null) {
    design = readLegacy(storage, design);
  }
  if (design.wallpaper === 'image' && !design.wallpaperImage) {
    design = { ...design, wallpaper: 'procedural' };
  }
  return applySearchOverrides(design, search);
}

export function saveDesign(storage: StorageLike, design: DesignPreferences): void {
  const { wallpaperImage, ...rest } = design;
  try {
    storage.setItem(DESIGN_STORAGE_KEY, JSON.stringify(rest));
    storage.setItem(LEGACY_THEME_KEY, design.theme);
    storage.setItem(LEGACY_PERFORMANCE_KEY, design.performance ? '1' : '0');
    if (design.wallpaper === 'image' && wallpaperImage) {
      storage.setItem(WALLPAPER_STORAGE_KEY, wallpaperImage);
    } else {
      storage.removeItem(WALLPAPER_STORAGE_KEY);
    }
  } catch {
    // A full or unavailable store must never stop the live preview.
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeTheme(theme: ThemeJson): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(theme)));
}

export function decodeTheme(encoded: string): ThemeParseResult {
  if (!encoded) return fail('The shared theme is empty.');
  try {
    const text = new TextDecoder().decode(base64UrlToBytes(encoded));
    return parseThemeText(text);
  } catch {
    return fail('The shared theme link is damaged.');
  }
}

export function themeShareUrl(theme: ThemeJson, origin: string): string {
  const url = new URL('/', origin);
  url.searchParams.set('share', encodeTheme(theme));
  return url.toString();
}

export function readShareFromSearch(search: string): ThemeJson | null {
  const shared = new URLSearchParams(search).get('share');
  if (!shared) return null;
  const decoded = decodeTheme(shared);
  return decoded.ok ? decoded.value : null;
}
