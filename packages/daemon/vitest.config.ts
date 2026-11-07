import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@cockpit/core': coreSource,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Git-heavy integration tests can exceed the 5s default on Windows when
    // the workspace packages run their suites in parallel.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
    },
  },
});
