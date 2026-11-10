/// <reference types="svelte" />
/// <reference types="vite/client" />

interface Window {
  __panduGlassReady?: boolean;
  __panduGlassMode?: 'webgl' | 'fallback';
  __panduGlassStats?: {
    mode: 'webgl' | 'fallback';
    shapes: number;
    fps: number;
    redrawsPerSecond: number;
    redrawsTotal: number;
  };
}
