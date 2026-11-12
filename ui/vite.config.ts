import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';
import brand from '../brand.json' with { type: 'json' };

/**
 * The inline boot script in `index.html` must run before the first paint, so
 * it cannot import `src/lib/brand.ts`. Replace its tokens at build time from
 * the same `brand.json` the rest of the app uses.
 */
function brandHtml(): Plugin {
  return {
    name: 'pandu-brand-html',
    transformIndexHtml(html) {
      return html
        .replaceAll('__BRAND_TITLE__', brand.name)
        .replaceAll('__BRAND_STORAGE_PREFIX__', brand.storagePrefix);
    },
  };
}

/**
 * The web app manifest is generated from `brand.json` so the install name,
 * description, and identifiers never drift from the native shells.
 */
function brandManifest(): Plugin {
  return {
    name: 'pandu-brand-manifest',
    generateBundle() {
      const manifest = {
        name: brand.name,
        short_name: brand.name,
        description: brand.tagline,
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        background_color: '#f3f1ec',
        theme_color: '#f3f1ec',
        lang: 'en',
        dir: 'ltr',
        categories: ['developer', 'productivity', 'utilities'],
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          { name: 'Inbox', url: '/inbox' },
          { name: 'Flights', url: '/flights' },
          { name: 'Settings', url: '/settings' },
        ],
      };
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), brandHtml(), brandManifest()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    reportCompressedSize: true,
    // `scripts/check-size.mjs` reads this to follow the real static import
    // graph instead of guessing which chunks an entry loads.
    manifest: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        companion: 'companion.html',
      },
    },
  },
});
