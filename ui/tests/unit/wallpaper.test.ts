import { describe, expect, it } from 'vitest';
import {
  WALLPAPER_MAX_DATA_URL_BYTES,
  WALLPAPER_MAX_EDGE,
  WALLPAPER_MAX_FILE_BYTES,
  fitWallpaper,
} from '../../src/lib/design/wallpaper';

describe('fitWallpaper', () => {
  it('downscales a wide image to the max edge while keeping the aspect ratio', () => {
    expect(fitWallpaper(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  });

  it('downscales a portrait image by its long edge', () => {
    expect(fitWallpaper(1080, 2400)).toEqual({ width: 864, height: 1920 });
  });

  it('never upscales a small image', () => {
    expect(fitWallpaper(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('honors a custom max edge', () => {
    expect(fitWallpaper(4000, 1000, 1000)).toEqual({ width: 1000, height: 250 });
  });

  it('falls back to 1x1 for invalid dimensions', () => {
    expect(fitWallpaper(0, 100)).toEqual({ width: 1, height: 1 });
    expect(fitWallpaper(-20, 100)).toEqual({ width: 1, height: 1 });
    expect(fitWallpaper(Number.NaN, 100)).toEqual({ width: 1, height: 1 });
    expect(fitWallpaper(Number.POSITIVE_INFINITY, 100)).toEqual({ width: 1, height: 1 });
  });

  it('rounds to whole pixels', () => {
    const fitted = fitWallpaper(3333, 1000);
    expect(Number.isInteger(fitted.width)).toBe(true);
    expect(Number.isInteger(fitted.height)).toBe(true);
  });
});

describe('wallpaper budgets', () => {
  it('keeps the source file limit above the stored data URL limit', () => {
    expect(WALLPAPER_MAX_FILE_BYTES).toBeGreaterThan(WALLPAPER_MAX_DATA_URL_BYTES);
  });

  it('keeps the stored wallpaper under a reasonable storage budget', () => {
    expect(WALLPAPER_MAX_DATA_URL_BYTES).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(WALLPAPER_MAX_EDGE).toBeLessThanOrEqual(1920);
  });
});
