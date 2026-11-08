export const DESIGN_SCHEMA_VERSION = 1;
export const THEME_SCHEMA = 'cockpit.theme';
export const THEME_VERSION = 1;
export const THEME_TEXT_LIMIT = 32 * 1024;
export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.3;
export const GLASS_MIN = 0;
export const GLASS_MAX = 100;

export type ThemeMode = 'dark' | 'light' | 'frost';
export type SurfaceStyle = 'matte' | 'glass' | 'hybrid';
export type AccentId = 'orange' | 'cream' | 'blue' | 'green' | 'violet' | 'silver' | 'mono';
export type RadiusId = 'sharp' | 'soft' | 'round';
export type DensityId = 'compact' | 'comfortable' | 'spacious';
export type FontId = 'system' | 'inter' | 'mono';
export type MotionId = 'full' | 'reduced' | 'off';
export type WallpaperId = 'procedural' | 'image' | 'none';
export type LanguageId = 'en' | 'id' | 'es' | 'fr' | 'de' | 'ja' | 'zh';

export interface DesignPreferences {
  version: number;
  theme: ThemeMode;
  surface: SurfaceStyle;
  accent: AccentId;
  radius: RadiusId;
  density: DensityId;
  font: FontId;
  fontScale: number;
  glassIntensity: number;
  glassBlur: number;
  glassRefraction: number;
  wallpaper: WallpaperId;
  wallpaperImage: string | null;
  borders: boolean;
  motion: MotionId;
  performance: boolean;
  language: LanguageId;
}

export interface ThemeJson {
  schema: 'cockpit.theme';
  version: number;
  theme: ThemeMode;
  surface: SurfaceStyle;
  accent: AccentId;
  radius: RadiusId;
  density: DensityId;
  font: FontId;
  fontScale: number;
  glass: {
    intensity: number;
    blur: number;
    refraction: number;
  };
  wallpaper: WallpaperId;
  borders: boolean;
  motion: MotionId;
  language: LanguageId;
}

export const THEME_MODES: Array<{ id: ThemeMode; label: string; note: string }> = [
  { id: 'dark', label: 'Dark', note: 'Graphite, the default' },
  { id: 'light', label: 'Light', note: 'Warm paper and ink' },
  { id: 'frost', label: 'Frost', note: 'Cool, airy light' },
];

export const SURFACE_STYLES: Array<{ id: SurfaceStyle; label: string; note: string }> = [
  { id: 'matte', label: 'Bento Matte', note: 'Solid cards, no blur' },
  { id: 'glass', label: 'Liquid Glass', note: 'Everything refracts' },
  { id: 'hybrid', label: 'Hybrid', note: 'Matte cards, glass floats' },
];

export const RADII: Record<RadiusId, { label: string; sm: number; md: number; lg: number; xl: number }> = {
  sharp: { label: 'Sharp', sm: 8, md: 12, lg: 20, xl: 24 },
  soft: { label: 'Soft', sm: 12, md: 18, lg: 24, xl: 30 },
  round: { label: 'Round', sm: 16, md: 22, lg: 28, xl: 36 },
};

export const DENSITIES: Record<
  DensityId,
  {
    label: string;
    padCard: number;
    gapCard: number;
    gapSection: number;
    padPanel: number;
  }
> = {
  compact: { label: 'Compact', padCard: 16, gapCard: 10, gapSection: 16, padPanel: 24 },
  comfortable: { label: 'Comfortable', padCard: 20, gapCard: 14, gapSection: 22, padPanel: 28 },
  spacious: { label: 'Spacious', padCard: 26, gapCard: 18, gapSection: 28, padPanel: 34 },
};

export const FONTS: Array<{ id: FontId; label: string; note: string }> = [
  { id: 'system', label: 'System', note: 'Fastest, native' },
  { id: 'inter', label: 'Inter', note: 'Bundled Latin subset' },
  { id: 'mono', label: 'Mono for code', note: 'Sans UI, mono code' },
];

export const MOTIONS: Array<{ id: MotionId; label: string; note: string }> = [
  { id: 'full', label: 'Full', note: 'Springs and parallax' },
  { id: 'reduced', label: 'Reduced', note: 'No parallax' },
  { id: 'off', label: 'Off', note: 'No transitions' },
];

export const WALLPAPERS: Array<{ id: WallpaperId; label: string; note: string }> = [
  { id: 'procedural', label: 'Procedural', note: 'Bundled, zero files' },
  { id: 'image', label: 'Your image', note: 'Stays on this device' },
  { id: 'none', label: 'None', note: 'Flat graphite' },
];

export const LANGUAGES: Array<{ id: LanguageId; label: string; note: string }> = [
  { id: 'en', label: 'English', note: 'Source' },
  { id: 'id', label: 'Bahasa Indonesia', note: 'Draft, needs review' },
  { id: 'es', label: 'Español', note: 'Draft, needs review' },
  { id: 'fr', label: 'Français', note: 'Draft, needs review' },
  { id: 'de', label: 'Deutsch', note: 'Draft, needs review' },
  { id: 'ja', label: '日本語', note: 'Draft, needs review' },
  { id: 'zh', label: '简体中文', note: 'Draft, needs review' },
];

export const THEME_IDS: ThemeMode[] = THEME_MODES.map((entry) => entry.id);
export const SURFACE_IDS: SurfaceStyle[] = SURFACE_STYLES.map((entry) => entry.id);
export const ACCENT_IDS: AccentId[] = ['orange', 'cream', 'blue', 'green', 'violet', 'silver', 'mono'];
export const RADIUS_IDS: RadiusId[] = ['sharp', 'soft', 'round'];
export const DENSITY_IDS: DensityId[] = ['compact', 'comfortable', 'spacious'];
export const FONT_IDS: FontId[] = FONTS.map((entry) => entry.id);
export const MOTION_IDS: MotionId[] = MOTIONS.map((entry) => entry.id);
export const WALLPAPER_IDS: WallpaperId[] = WALLPAPERS.map((entry) => entry.id);
export const LANGUAGE_IDS: LanguageId[] = LANGUAGES.map((entry) => entry.id);

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_IDS.includes(value as ThemeMode);
}

export function isSurfaceStyle(value: unknown): value is SurfaceStyle {
  return SURFACE_IDS.includes(value as SurfaceStyle);
}

export function isAccentId(value: unknown): value is AccentId {
  return ACCENT_IDS.includes(value as AccentId);
}

export function isRadiusId(value: unknown): value is RadiusId {
  return RADIUS_IDS.includes(value as RadiusId);
}

export function isDensityId(value: unknown): value is DensityId {
  return DENSITY_IDS.includes(value as DensityId);
}

export function isFontId(value: unknown): value is FontId {
  return FONT_IDS.includes(value as FontId);
}

export function isMotionId(value: unknown): value is MotionId {
  return MOTION_IDS.includes(value as MotionId);
}

export function isWallpaperId(value: unknown): value is WallpaperId {
  return WALLPAPER_IDS.includes(value as WallpaperId);
}

export function isLanguageId(value: unknown): value is LanguageId {
  return LANGUAGE_IDS.includes(value as LanguageId);
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export const DEFAULT_DESIGN: DesignPreferences = {
  version: DESIGN_SCHEMA_VERSION,
  theme: 'dark',
  surface: 'hybrid',
  accent: 'orange',
  radius: 'soft',
  density: 'comfortable',
  font: 'system',
  fontScale: 1,
  glassIntensity: 55,
  glassBlur: 55,
  glassRefraction: 55,
  wallpaper: 'procedural',
  wallpaperImage: null,
  borders: true,
  motion: 'full',
  performance: false,
  language: 'en',
};
