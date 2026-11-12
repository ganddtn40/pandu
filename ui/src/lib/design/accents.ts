import type { AccentId, ThemeMode } from './types';

export interface AccentColors {
  base: string;
  strong: string;
  ink: string;
  soft: string;
  contrast: string;
}

export interface AccentPreset {
  id: AccentId;
  label: string;
  dark: AccentColors;
  light: AccentColors;
  frost: AccentColors;
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : value;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function palette(
  base: string,
  strong: string,
  ink: string,
  contrast: string,
  softAlpha: number,
): AccentColors {
  return { base, strong, ink, soft: rgba(base, softAlpha), contrast };
}

export const ACCENTS: AccentPreset[] = [
  {
    id: 'blue',
    label: 'Blue',
    dark: palette('#4D9DFF', '#74B3FF', '#9CC8FF', '#07111D', 0.16),
    light: palette('#2F7FE0', '#1F6BC7', '#0B5CAD', '#07111D', 0.12),
    frost: palette('#2F7FE0', '#1F6BC7', '#0A549C', '#07111D', 0.12),
  },
  {
    id: 'orange',
    label: 'Orange',
    dark: palette('#FF7A2F', '#FF8A45', '#FFB27A', '#1A0D06', 0.16),
    light: palette('#F26A1B', '#C24A05', '#9A3C05', '#1A0D06', 0.12),
    frost: palette('#F26A1B', '#C24A05', '#8E3604', '#1A0D06', 0.12),
  },
  {
    id: 'cream',
    label: 'Cream',
    dark: palette('#E8D9B5', '#F2E6C8', '#F2E6C8', '#1A1710', 0.18),
    light: palette('#B9A36F', '#A38E5A', '#6B5A33', '#1A1710', 0.16),
    frost: palette('#B3A06E', '#9C8A5B', '#5E4F2C', '#1A1710', 0.16),
  },
  {
    id: 'green',
    label: 'Green',
    dark: palette('#43D17C', '#67DF94', '#8BE8B2', '#06160D', 0.16),
    light: palette('#1E9E55', '#0F6B38', '#0D6B38', '#06160D', 0.12),
    frost: palette('#1E9E55', '#0F6B38', '#0B6132', '#06160D', 0.12),
  },
  {
    id: 'violet',
    label: 'Violet',
    dark: palette('#A78BFA', '#BDA6FF', '#C9B8FF', '#0E091D', 0.16),
    light: palette('#7C5CE0', '#6A4AC9', '#5B3DB8', '#FFFFFF', 0.12),
    frost: palette('#7C5CE0', '#6A4AC9', '#5236A8', '#FFFFFF', 0.12),
  },
  {
    id: 'silver',
    label: 'Silver',
    dark: palette('#C7CDD6', '#DDE1E7', '#E2E6EC', '#111418', 0.18),
    light: palette('#6B7480', '#59626E', '#4B5563', '#FFFFFF', 0.14),
    frost: palette('#6B7480', '#59626E', '#44505F', '#FFFFFF', 0.14),
  },
  {
    id: 'mono',
    label: 'Mono',
    dark: palette('#E6E8EC', '#F5F6F8', '#F2F3F5', '#111418', 0.18),
    light: palette('#3A404A', '#2A2F37', '#2A2E35', '#FFFFFF', 0.14),
    frost: palette('#3A404A', '#2A2F37', '#242A32', '#FFFFFF', 0.14),
  },
];

export function accentFor(id: AccentId, theme: ThemeMode): AccentColors {
  const preset = ACCENTS.find((entry) => entry.id === id) ?? ACCENTS[0]!;
  return preset[theme];
}
