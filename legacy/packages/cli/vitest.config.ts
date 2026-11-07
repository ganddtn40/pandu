import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));
const daemonSource = fileURLToPath(new URL('../daemon/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@cockpit/core': coreSource,
      '@cockpit/daemon': daemonSource,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
