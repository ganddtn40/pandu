import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm preview',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'node tests/e2e/daemon-server.mjs demo 4321',
      url: 'http://127.0.0.1:4321/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node tests/e2e/daemon-server.mjs live 4322',
      url: 'http://127.0.0.1:4322/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node tests/e2e/daemon-server.mjs market 4323',
      url: 'http://127.0.0.1:4323/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node tests/e2e/daemon-server.mjs market-offline 4324',
      url: 'http://127.0.0.1:4324/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
