import type {
  AccentId,
  DensityId,
  FontId,
  LanguageId,
  MotionId,
  RadiusId,
  SurfaceStyle,
  ThemeMode,
  WallpaperId,
} from '../design/types';
import type { MessageKey } from './catalog';

/**
 * Option labels live in the catalog, but the design tables are plain data, so
 * the ids map to keys here. Keeping the map typed means a new theme or surface
 * cannot ship without a translated label.
 */
export const THEME_LABELS: Record<ThemeMode, { label: MessageKey; note: MessageKey }> = {
  light: { label: 'design.theme.light.label', note: 'design.theme.light.note' },
  dark: { label: 'design.theme.dark.label', note: 'design.theme.dark.note' },
  frost: { label: 'design.theme.frost.label', note: 'design.theme.frost.note' },
};

export const SURFACE_LABELS: Record<SurfaceStyle, { label: MessageKey; note: MessageKey }> = {
  matte: { label: 'design.surface.matte.label', note: 'design.surface.matte.note' },
  glass: { label: 'design.surface.glass.label', note: 'design.surface.glass.note' },
  hybrid: { label: 'design.surface.hybrid.label', note: 'design.surface.hybrid.note' },
};

export const ACCENT_LABELS: Record<AccentId, MessageKey> = {
  blue: 'design.accent.blue',
  orange: 'design.accent.orange',
  cream: 'design.accent.cream',
  green: 'design.accent.green',
  violet: 'design.accent.violet',
  silver: 'design.accent.silver',
  mono: 'design.accent.mono',
};

export const RADIUS_LABELS: Record<RadiusId, MessageKey> = {
  sharp: 'design.radius.sharp',
  soft: 'design.radius.soft',
  round: 'design.radius.round',
};

export const DENSITY_LABELS: Record<DensityId, MessageKey> = {
  compact: 'design.density.compact',
  comfortable: 'design.density.comfortable',
  spacious: 'design.density.spacious',
};

export const FONT_LABELS: Record<FontId, { label: MessageKey; note: MessageKey }> = {
  system: { label: 'design.font.system.label', note: 'design.font.system.note' },
  inter: { label: 'design.font.inter.label', note: 'design.font.inter.note' },
  mono: { label: 'design.font.mono.label', note: 'design.font.mono.note' },
};

export const MOTION_LABELS: Record<MotionId, { label: MessageKey; note: MessageKey }> = {
  full: { label: 'design.motion.full.label', note: 'design.motion.full.note' },
  reduced: { label: 'design.motion.reduced.label', note: 'design.motion.reduced.note' },
  off: { label: 'design.motion.off.label', note: 'design.motion.off.note' },
};

export const WALLPAPER_LABELS: Record<WallpaperId, { label: MessageKey; note: MessageKey }> = {
  procedural: {
    label: 'design.wallpaper.procedural.label',
    note: 'design.wallpaper.procedural.note',
  },
  image: { label: 'design.wallpaper.image.label', note: 'design.wallpaper.image.note' },
  none: { label: 'design.wallpaper.none.label', note: 'design.wallpaper.none.note' },
};

/** Language names stay native; only the note is translated. */
export const LANGUAGE_NOTES: Record<LanguageId, MessageKey> = {
  en: 'design.language.source',
  id: 'design.language.draft',
  es: 'design.language.draft',
  fr: 'design.language.draft',
  de: 'design.language.draft',
  ja: 'design.language.draft',
  zh: 'design.language.draft',
  ar: 'design.language.draftRtl',
  hi: 'design.language.draft',
  ko: 'design.language.draft',
  pt: 'design.language.draft',
  ru: 'design.language.draft',
  tr: 'design.language.draft',
  vi: 'design.language.draft',
};
