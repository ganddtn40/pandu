import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');

function declarations(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    result[match[1]!] = match[2]!.trim();
  }
  return result;
}

function tokenBlock(pattern: RegExp): Record<string, string> {
  const match = pattern.exec(css);
  if (!match?.[1]) throw new Error(`missing token block: ${pattern}`);
  return declarations(match[1]);
}

const light = tokenBlock(/:root\s*\{([^}]*)\}/);
const dark = tokenBlock(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/);

function parseColor(value: string): Rgba {
  const hex = value.trim();
  if (hex.startsWith('#')) {
    const digits = hex.slice(1);
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : digits;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const match = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(
    hex,
  );
  if (!match) throw new Error(`unsupported color: ${value}`);
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const a = foreground.a + background.a * (1 - foreground.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / a,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / a,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / a,
    a,
  };
}

function luminance(color: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrast(foreground: Rgba, background: Rgba): number {
  const fg = luminance(foreground);
  const bg = luminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The shader's brightest dark-mode pool is a warm cream around 43% sRGB. The
 * light-mode worst case is the cool blue pool at roughly 76% sRGB. The test
 * composites every translucent token over those surfaces so the gate covers
 * the brightest place text can land, not just a flat token swatch.
 */
const wallpaper = {
  light: parseColor('#c2d0e8'),
  dark: parseColor('#6e6352'),
};

function surfaces(tokens: Record<string, string>, theme: 'light' | 'dark'): Record<string, Rgba> {
  const page = wallpaper[theme];
  const color = (name: string): Rgba => parseColor(tokens[name]!);
  const panel = composite(color('--glass-bg'), page);
  return {
    panel,
    tile: composite(color('--tile-bg'), panel),
    field: composite(color('--field-bg'), panel),
    inset: composite(color('--inset-bg'), panel),
    chip: composite(color('--chip-bg'), panel),
    accentSoft: composite(color('--accent-soft'), panel),
  };
}

const textTokens = ['--text', '--text-soft', '--text-faint', '--accent-ink', '--success', '--danger'];

for (const [theme, tokens] of [
  ['light', light],
  ['dark', dark],
] as const) {
  describe(`${theme} theme contrast`, () => {
    const palette = surfaces(tokens, theme);

    for (const textToken of textTokens) {
      for (const [surfaceName, surface] of Object.entries(palette)) {
        it(`${textToken} on ${surfaceName} is at least 4.5:1`, () => {
          const ratio = contrast(parseColor(tokens[textToken]!), surface);
          expect(ratio, `${theme} ${textToken} on ${surfaceName}`).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    it('selected text is at least 4.5:1 on the selected surface', () => {
      const ratio = contrast(
        parseColor(tokens['--selected-text']!),
        parseColor(tokens['--selected']!),
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('toast text is at least 4.5:1 on the toast surface', () => {
      const ratio = contrast(
        parseColor(tokens['--toast-text']!),
        composite(parseColor(tokens['--toast-bg']!), wallpaper[theme]),
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  });
}
