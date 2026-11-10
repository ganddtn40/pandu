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

export default defineConfig({
  plugins: [svelte(), brandHtml()],
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
  },
});
