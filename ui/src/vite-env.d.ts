/// <reference types="svelte" />
/// <reference types="vite/client" />

interface Window {
  __cockpitGlassReady?: boolean;
  __cockpitGlassMode?: 'webgl' | 'fallback';
  __cockpitGlassStats?: {
    mode: 'webgl' | 'fallback';
    shapes: number;
    fps: number;
    redrawsPerSecond: number;
    redrawsTotal: number;
  };
}
