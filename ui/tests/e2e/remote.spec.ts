import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'screenshots', 'phase7');
mkdirSync(SHOTS, { recursive: true });

const DEMO_DAEMON = 'http://127.0.0.1:4321';
const REMOTE_URL = 'http://127.0.0.1:4320';

async function openHostSettings(page: Page): Promise<void> {
  await page.addInitScript((daemonUrl) => {
    window.__cockpitDaemonUrl = daemonUrl;
    try {
      localStorage.setItem('cockpit.onboarded', '1');
    } catch {
      // Storage is optional.
    }
  }, DEMO_DAEMON);
  await page.goto('/settings');
  await expect(page.locator('.remote-card')).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
}

async function shotOf(locator: Locator, name: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
}

/** Host mutations need the loopback Origin, JSON, and the per-process token. */
async function hostPost(page: Page, pathname: string): Promise<void> {
  const csrf = await page.request.get(`${DEMO_DAEMON}/api/csrf`);
  const { token } = (await csrf.json()) as { token: string };
  await page.request.post(`${DEMO_DAEMON}${pathname}`, {
    headers: {
      origin: 'http://127.0.0.1:4174',
      'x-cockpit-csrf': token,
      'content-type': 'application/json',
    },
    data: {},
    failOnStatusCode: false,
  });
}

test.describe('remote access', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.afterEach(async ({ page }) => {
    // Panic is idempotent and keeps the visual suite's layout free of the
    // persistent remote banner if this test fails halfway through.
    await hostPost(page, '/api/remote/panic').catch(() => {});
  });

  test('pairs a device and serves only the remote surface', async ({ page, browser }) => {
    await openHostSettings(page);

    const card = page.locator('.remote-card');
    await expect(card).toContainText('Remote access is off');
    await card.scrollIntoViewIfNeeded();
    await shotOf(card, '01-host-remote-off.png');

    // Enable Tunnel mode against the loopback test URL. This is the one mode
    // that can run in CI without Tailscale or cloudflared installed.
    await card.getByRole('radio', { name: /Cloudflare tunnel/ }).click();
    await card.getByLabel('Public URL').fill(REMOTE_URL);
    await expect(card).toContainText('This URL is reachable from the public internet');
    await card.getByRole('button', { name: 'Enable remote access' }).click();

    await expect(card).toContainText('Listening');
    await expect(card.getByRole('button', { name: 'Pair a device' })).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await shot(page, '02-host-remote-on.png');

    await card.getByRole('button', { name: 'Pair a device' }).click();
    const code = (await card.locator('.remote-code').innerText()).trim();
    expect(code.length).toBeGreaterThanOrEqual(8);
    const pairingSection = card
      .locator('.remote-section')
      .filter({ has: page.locator('.remote-code') });
    await expect(pairingSection.locator('.remote-qr svg')).toBeVisible();
    await shotOf(pairingSection, '03-host-pairing-code.png');

    await expect
      .poll(async () => {
        try {
          const response = await fetch(`${REMOTE_URL}/api/remote/health`);
          return response.status;
        } catch {
          return 0;
        }
      })
      .toBe(200);

    const remoteContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      deviceScaleFactor: 2,
    });
    const remote = await remoteContext.newPage();
    await remote.goto(REMOTE_URL);
    await expect(remote.getByRole('heading', { name: 'Pair this device' })).toBeVisible();
    await expect(remote.getByText('Cockpit Remote')).toBeVisible();

    await remote.getByLabel('Pairing code').fill(code);
    await remote.getByLabel('Device name').fill('Pixel 8');
    await remote.getByRole('button', { name: 'Send pairing request' }).click();
    await expect(remote.getByText('Waiting for the host to confirm…')).toBeVisible();

    // The host must see and confirm the device by name before any token exists.
    await expect(card.getByText('Pair Pixel 8?')).toBeVisible({ timeout: 10_000 });
    await shotOf(pairingSection, '04-host-pair-confirm.png');

    await card.getByRole('button', { name: 'Confirm pairing' }).click();
    const device = card.locator('.remote-device').filter({ hasText: 'Pixel 8' });
    await expect(device).toBeVisible();
    await expect(device).toContainText('Status');

    await expect(remote.locator('.remote-app__tabs')).toBeVisible({ timeout: 15_000 });
    await expect(remote.getByRole('button', { name: /Inbox/ })).toBeVisible();
    await expect(remote.locator('.remote-app__meta')).toContainText('Status');
    await shot(remote, '05-remote-paired-dashboard.png');

    // The host audit trail records the code, the request, and the confirmation.
    await card.getByRole('button', { name: 'Refresh' }).click();
    const audit = card.locator('.remote-section').filter({ hasText: 'Audit log' });
    await expect(audit).toContainText('pair.confirm');
    await expect(audit).toContainText('pair.code');
    await shotOf(audit, '06-host-audit.png');

    const matrix = card.locator('.remote-section').filter({ hasText: 'Endpoints and scopes' });
    await expect(matrix.locator('.remote-matrix tbody tr')).toHaveCount(16);
    await expect(page.locator('.toast')).toBeHidden({ timeout: 10_000 });
    await page.setViewportSize({ width: 1440, height: 1200 });
    await shotOf(matrix.locator('.remote-matrix-wrap'), '07-endpoints-scopes.png');
    await page.setViewportSize({ width: 1440, height: 900 });

    // The remote listener is a separate router: model proxy paths and host-only
    // management routes must not exist there.
    for (const blocked of ['/v1/models', '/openai/v1/models', '/anthropic/v1/messages', '/s/example', '/api/settings', '/api/health']) {
      const response = await remote.request.get(`${REMOTE_URL}${blocked}`, {
        failOnStatusCode: false,
      });
      expect(response.status(), `${blocked} must be 404 on the remote listener`).toBe(404);
    }

    const health = await remote.request.get(`${REMOTE_URL}/api/remote/health`);
    expect(health.ok()).toBeTruthy();
    expect((await health.json()).remote).toBe(true);

    // Revoking the device closes its live socket immediately; the remote app
    // falls back to the pairing gate on the next refresh.
    await device.getByRole('button', { name: 'Revoke', exact: true }).click();
    await card.getByRole('button', { name: 'Revoke now' }).click();
    await expect(device).toContainText('Revoked');
    await expect(remote.getByRole('heading', { name: 'Pair this device' })).toBeVisible({
      timeout: 20_000,
    });

    await remoteContext.close();
  });
});
