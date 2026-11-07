import { describe, expect, it } from 'vitest';
import {
  GLASS_INSTANCE_FLOATS,
  MAX_GLASS_SHAPES,
  clampDpr,
  clampRadius,
  hasGlassSize,
  isGlassRectVisible,
  packGlassInstance,
  parseRadius,
} from '../../src/glass/geometry';

describe('clampDpr', () => {
  it('clamps the device pixel ratio into the supported range', () => {
    expect(clampDpr(1)).toBe(1);
    expect(clampDpr(1.5)).toBe(1.5);
    expect(clampDpr(3)).toBe(2);
  });

  it('falls back to 1 for invalid values', () => {
    expect(clampDpr(0)).toBe(1);
    expect(clampDpr(-2)).toBe(1);
    expect(clampDpr(Number.NaN)).toBe(1);
    expect(clampDpr(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('clampRadius', () => {
  it('keeps the radius inside the box', () => {
    expect(clampRadius(24, 200, 100)).toBe(24);
    expect(clampRadius(80, 200, 100)).toBe(50);
  });

  it('never returns a negative radius', () => {
    expect(clampRadius(-4, 200, 100)).toBe(0);
    expect(clampRadius(Number.NaN, 200, 100)).toBe(0);
  });
});

describe('parseRadius', () => {
  it('parses pixel radii', () => {
    expect(parseRadius('26px', 200, 100)).toBe(26);
    expect(parseRadius('26px 26px 26px 26px', 200, 100)).toBe(26);
  });

  it('parses percentage radii against the shorter side', () => {
    expect(parseRadius('50%', 200, 100)).toBe(50);
    expect(parseRadius('25%', 200, 100)).toBe(25);
  });

  it('returns 0 for missing or invalid values', () => {
    expect(parseRadius('', 200, 100)).toBe(0);
    expect(parseRadius('auto', 200, 100)).toBe(0);
  });
});

describe('hasGlassSize', () => {
  it('rejects tiny shapes', () => {
    expect(hasGlassSize({ width: 4, height: 100 })).toBe(false);
    expect(hasGlassSize({ width: 100, height: 4 })).toBe(false);
    expect(hasGlassSize({ width: 8, height: 8 })).toBe(true);
  });
});

describe('isGlassRectVisible', () => {
  const viewport = { width: 1440, height: 900 };

  it('accepts shapes intersecting the viewport', () => {
    expect(isGlassRectVisible({ left: 10, top: 10, width: 200, height: 100 }, viewport)).toBe(true);
    expect(isGlassRectVisible({ left: -50, top: -50, width: 200, height: 100 }, viewport)).toBe(true);
  });

  it('rejects shapes outside the viewport or below the size floor', () => {
    expect(isGlassRectVisible({ left: 1500, top: 10, width: 200, height: 100 }, viewport)).toBe(false);
    expect(isGlassRectVisible({ left: -300, top: 10, width: 200, height: 100 }, viewport)).toBe(false);
    expect(isGlassRectVisible({ left: 10, top: 10, width: 2, height: 100 }, viewport)).toBe(false);
  });
});

describe('packGlassInstance', () => {
  it('packs a clipped shape into the documented layout', () => {
    const packed = packGlassInstance({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      radius: 24,
      tint: 0.12,
      opacity: 0.6,
      depth: 2,
      clip: { x: 1, y: 2, width: 400, height: 500, radius: 32 },
    });

    expect(packed).toBeInstanceOf(Float32Array);
    expect(packed).toHaveLength(GLASS_INSTANCE_FLOATS);
    expect(Array.from(packed)).toEqual([
      10,
      20,
      300,
      200,
      24,
      Math.fround(0.12),
      Math.fround(0.6),
      2,
      1,
      2,
      400,
      500,
      32,
      1,
    ]);
  });

  it('packs an unclipped shape with zeroed clip data', () => {
    const packed = packGlassInstance({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      radius: 12,
      tint: 0.08,
      opacity: 0.5,
      depth: 3,
      clip: null,
    });

    expect(Array.from(packed.slice(8))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('constants', () => {
  it('stays within the instancing budget', () => {
    expect(MAX_GLASS_SHAPES).toBeGreaterThan(0);
    expect(MAX_GLASS_SHAPES).toBeLessThanOrEqual(12);
    expect(GLASS_INSTANCE_FLOATS).toBe(14);
  });
});
