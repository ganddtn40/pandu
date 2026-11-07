import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));

const daemonTarget = process.env['COCKPIT_DAEMON_URL'] ?? 'http://127.0.0.1:4319';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cockpit/core': coreSource,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: daemonTarget,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
  },
});
