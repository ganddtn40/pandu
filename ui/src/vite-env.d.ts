/// <reference types="svelte" />
/// <reference types="vite/client" />

interface Window {
  __cockpitGlassReady?: boolean;
  __cockpitGlassMode?: 'webgl' | 'fallback';
}
