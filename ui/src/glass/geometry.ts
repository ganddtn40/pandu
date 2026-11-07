export const MAX_GLASS_SHAPES = 12;
export const MAX_DPR = 2;
export const MIN_GLASS_SIZE = 8;

export function clampDpr(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.max(value, 1), MAX_DPR);
}

export function clampRadius(radius: number, width: number, height: number): number {
  const limit = Math.max(0, Math.min(width, height) / 2);
  if (!Number.isFinite(radius) || radius < 0) return 0;
  return Math.min(radius, limit);
}

/** Parse a computed CSS border-radius value into pixels. */
export function parseRadius(value: string, width: number, height: number): number {
  const first = value.trim().split(/\s+/)[0] ?? '';
  if (first.endsWith('%')) {
    const percent = Number.parseFloat(first);
    if (!Number.isFinite(percent)) return 0;
    return clampRadius((Math.min(width, height) * percent) / 100, width, height);
  }
  const pixels = Number.parseFloat(first);
  if (!Number.isFinite(pixels)) return 0;
  return clampRadius(pixels, width, height);
}

export interface VisibleRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function hasGlassSize(rect: { width: number; height: number }): boolean {
  return rect.width >= MIN_GLASS_SIZE && rect.height >= MIN_GLASS_SIZE;
}

export function isGlassRectVisible(
  rect: VisibleRect,
  viewport: { width: number; height: number },
): boolean {
  if (!hasGlassSize(rect)) return false;
  return (
    rect.left + rect.width > 0 &&
    rect.top + rect.height > 0 &&
    rect.left < viewport.width &&
    rect.top < viewport.height
  );
}

export interface GlassInstanceInput {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  tint: number;
  opacity: number;
  depth: number;
  clip: { x: number; y: number; width: number; height: number; radius: number } | null;
}

export const GLASS_INSTANCE_FLOATS = 14;

/**
 * Pack one shape for the instanced vertex buffer.
 *
 * Layout: rect(4), radius, tint, opacity, depth, clipRect(4), clipRadius,
 * clipEnabled.
 */
export function packGlassInstance(input: GlassInstanceInput): Float32Array {
  const clip = input.clip;
  return new Float32Array([
    input.x,
    input.y,
    input.width,
    input.height,
    input.radius,
    input.tint,
    input.opacity,
    input.depth,
    clip?.x ?? 0,
    clip?.y ?? 0,
    clip?.width ?? 0,
    clip?.height ?? 0,
    clip?.radius ?? 0,
    clip ? 1 : 0,
  ]);
}
