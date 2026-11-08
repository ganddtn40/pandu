import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCENTS } from '../../src/lib/design/accents';
import { DENSITIES, RADII } from '../../src/lib/design/types';

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

function parseColor(value: string): Rgba {
  const text = value.trim();
  if (text.startsWith('#')) {
    const digits = text.slice(1);
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : digits;
    if (full.length !== 6) throw new Error(`unsupported color: ${value}`);
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  const match = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(
    text,
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
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1,
  };
}

function luminance(color: Rgba): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrast(foreground: Rgba, background: Rgba): number {
  const front = luminance(composite(foreground, background));
  const back = luminance(background);
  return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
}

const themes = {
  dark: tokenBlock(/:root\s*\{([^}]*)\}/),
  light: tokenBlock(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
  frost: tokenBlock(/:root\[data-theme='frost'\]\s*\{([^}]*)\}/),
} as const;

type ThemeName = keyof typeof themes;

const accentBlocks = new Map<string, Record<string, string>>();
for (const match of css.matchAll(
  /:root\[data-theme='(dark|light|frost)'\]\[data-accent='([a-z]+)'\]\s*\{([^}]*)\}/g,
)) {
  accentBlocks.set(`${match[1]}:${match[2]}`, declarations(match[3]!));
}

function accentBlock(theme: ThemeName, accent: string): Record<string, string> {
  const block = accentBlocks.get(`${theme}:${accent}`);
  if (!block) throw new Error(`missing accent block ${theme}/${accent}`);
  return block;
}

describe('theme token contrast', () => {
  for (const [name, tokens] of Object.entries(themes)) {
    it(`${name} keeps body and supporting text readable on cards and the page`, () => {
      const card = parseColor(tokens['--card-bg']!);
      const page = parseColor(tokens['--bg']!);
      for (const token of ['--text', '--text-soft', '--text-faint']) {
        const color = parseColor(tokens[token]!);
        expect(contrast(color, card), `${token} on --card-bg`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color, page), `${token} on --bg`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name} keeps status text and selected/toast pairs readable`, () => {
      const card = parseColor(tokens['--card-bg']!);
      for (const token of ['--success', '--danger', '--warn']) {
        expect(contrast(parseColor(tokens[token]!), card), `${token} on --card-bg`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      expect(contrast(parseColor(tokens['--selected-text']!), parseColor(tokens['--selected']!))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(parseColor(tokens['--toast-text']!), parseColor(tokens['--toast-bg']!))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('accent presets', () => {
  it('declares every theme/accent pair exactly once', () => {
    expect(accentBlocks.size).toBe(ACCENTS.length * 3);
    for (const theme of Object.keys(themes)) {
      for (const preset of ACCENTS) {
        expect(accentBlocks.has(`${theme}:${preset.id}`)).toBe(true);
      }
    }
  });

  it('keeps CSS and the TypeScript palette in lockstep', () => {
    for (const theme of Object.keys(themes) as ThemeName[]) {
      for (const preset of ACCENTS) {
        const block = accentBlock(theme, preset.id);
        const palette = preset[theme];
        expect(block['--accent']!.toLowerCase(), `${theme}/${preset.id} base`).toBe(
          palette.base.toLowerCase(),
        );
        expect(block['--accent-strong']!.toLowerCase(), `${theme}/${preset.id} strong`).toBe(
          palette.strong.toLowerCase(),
        );
        expect(block['--accent-ink']!.toLowerCase(), `${theme}/${preset.id} ink`).toBe(
          palette.ink.toLowerCase(),
        );
        expect(block['--accent-contrast']!.toLowerCase(), `${theme}/${preset.id} contrast`).toBe(
          palette.contrast.toLowerCase(),
        );
        const soft = parseColor(block['--accent-soft']!);
        const expectedSoft = parseColor(palette.soft);
        expect(soft.r, `${theme}/${preset.id} soft r`).toBeCloseTo(expectedSoft.r, 0);
        expect(soft.g, `${theme}/${preset.id} soft g`).toBeCloseTo(expectedSoft.g, 0);
        expect(soft.b, `${theme}/${preset.id} soft b`).toBeCloseTo(expectedSoft.b, 0);
        expect(soft.a, `${theme}/${preset.id} soft a`).toBeCloseTo(expectedSoft.a, 2);
      }
    }
  });

  it('keeps accent ink readable on cards and accent fills readable', () => {
    for (const theme of Object.keys(themes) as ThemeName[]) {
      const card = parseColor(themes[theme]['--card-bg']!);
      for (const preset of ACCENTS) {
        const block = accentBlock(theme, preset.id);
        const ink = parseColor(block['--accent-ink']!);
        const accent = parseColor(block['--accent']!);
        const onAccent = parseColor(block['--accent-contrast']!);
        expect(contrast(ink, card), `${theme}/${preset.id} ink on card`).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(onAccent, accent),
          `${theme}/${preset.id} contrast on accent`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('shape tokens', () => {
  it('keeps CSS radii and density in lockstep with the TypeScript presets', () => {
    for (const [id, preset] of Object.entries(RADII)) {
      const block = tokenBlock(new RegExp(`:root\\[data-radius='${id}'\\]\\s*\\{([^}]*)\\}`));
      expect(block['--radius-sm']).toBe(`${preset.sm}px`);
      expect(block['--radius-md']).toBe(`${preset.md}px`);
      expect(block['--radius-lg']).toBe(`${preset.lg}px`);
      expect(block['--radius-xl']).toBe(`${preset.xl}px`);
    }

    for (const [id, preset] of Object.entries(DENSITIES)) {
      const block = tokenBlock(new RegExp(`:root\\[data-density='${id}'\\]\\s*\\{([^}]*)\\}`));
      expect(block['--pad-card']).toBe(`${preset.padCard}px`);
      expect(block['--gap-card']).toBe(`${preset.gapCard}px`);
      expect(block['--gap-section']).toBe(`${preset.gapSection}px`);
      expect(block['--pad-panel']).toBe(`${preset.padPanel}px`);
    }
  });

  it('keeps card radii inside the bento range', () => {
    for (const preset of Object.values(RADII)) {
      expect(preset.lg).toBeGreaterThanOrEqual(20);
      expect(preset.lg).toBeLessThanOrEqual(28);
      expect(preset.xl).toBeGreaterThanOrEqual(24);
    }
  });
});
