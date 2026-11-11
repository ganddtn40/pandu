import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'screenshots', 'phase10');
mkdirSync(SHOTS, { recursive: true });

const UPDATE_DAEMON = 'http://127.0.0.1:4326';
const MIGRATE_DAEMON = 'http://127.0.0.1:4327';

async function open(page: Page, daemon: string, url: string): Promise<void> {
  await page.addInitScript((daemonUrl) => {
    window.__panduDaemonUrl = daemonUrl;
    try {
      localStorage.setItem('pandu.onboarded', '1');
    } catch {
      // Storage is optional.
    }
  }, daemon);
  await page.goto(url);
  await page.waitForFunction(() => window.__panduGlassReady === true);
  await page.waitForTimeout(250);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
}

async function shotOf(page: Page, selector: string, name: string): Promise<void> {
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  await target.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
}

/** Host mutations need the loopback Origin, JSON, and the per-process token. */
async function hostHeaders(page: Page, daemon: string): Promise<Record<string, string>> {
  const response = await page.request.get(`${daemon}/api/csrf`);
  expect(response.ok()).toBeTruthy();
  const { token } = (await response.json()) as { token: string };
  return {
    origin: 'http://127.0.0.1:4174',
    'x-pandu-csrf': token,
    'content-type': 'application/json',
  };
}

async function putSetting(
  page: Page,
  daemon: string,
  key: string,
  value: string,
): Promise<void> {
  const response = await page.request.put(`${daemon}/api/settings`, {
    headers: await hostHeaders(page, daemon),
    data: { [key]: value },
  });
  expect(response.ok()).toBeTruthy();
}

/** The daemon checks the fixture immediately on launch; wait for that result. */
async function waitForUpdate(
  page: Page,
  daemon: string,
  state: string,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await page.request.get(`${daemon}/api/update`);
    if (response.ok()) {
      last = (await response.json()) as Record<string, unknown>;
      if (last.state === state) return last;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`The update fixture never reached ${state}: ${JSON.stringify(last)}`);
}

test.describe.serial('phase 10: updates, migrations, and data safety', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('shows the update card and keeps a snooze across a restart', async ({ page }) => {
    await waitForUpdate(page, UPDATE_DAEMON, 'available');
    await open(page, UPDATE_DAEMON, '/');

    const card = page.locator('[data-update-card]');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-update-state', 'available');
    await expect(card).toContainText('Version 0.3.0 is ready');
    await expect(card).toContainText('You have 0.2.0.');
    await expect(card).toContainText('Backup and restore');
    await expect(card).toContainText('stable channel');
    // The update daemon runs with demo data. The card must say so and must not
    // offer a real install.
    await expect(card.locator('[data-update-demo]')).toHaveText('Demo');
    await expect(card.locator('[data-update-demo-note]')).toContainText('demo data');
    await expect(card.getByRole('button', { name: 'Update now' })).toBeDisabled();
    // The fixture body contains an image tag. Notes are sanitized before the
    // UI renders them, so neither the tag nor its remote URL may appear.
    await expect(card).not.toContainText('tracker.png');
    await expect(card).not.toContainText('<img');
    await shotOf(page, '[data-update-card]', 'home-update-card.png');

    await card.getByRole('button', { name: /Remind me later/ }).click();
    const menu = page.locator('[data-update-snooze-menu]');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(3);
    // The menu extends past the card, so capture the union of both boxes
    // instead of clipping the element screenshot at the card edge.
    const cardBox = await card.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    if (cardBox && menuBox) {
      await page.screenshot({
        path: path.join(SHOTS, 'update-snooze-menu.png'),
        animations: 'disabled',
        clip: {
          x: cardBox.x,
          y: cardBox.y,
          width: cardBox.width,
          height: menuBox.y + menuBox.height - cardBox.y,
        },
      });
    }

    await menu.getByRole('menuitem', { name: 'Tomorrow' }).click();
    await expect(card).toHaveAttribute('data-update-state', 'snoozed');
    await expect(card).toContainText('Reminder set for');
    await shotOf(page, '[data-update-card]', 'home-update-snoozed.png');

    // Snoozing is a daemon setting, so a fresh page load must keep it.
    await page.reload();
    await page.waitForFunction(() => window.__panduGlassReady === true);
    await expect(page.locator('[data-update-card]')).toHaveAttribute(
      'data-update-state',
      'snoozed',
    );

    await putSetting(page, UPDATE_DAEMON, 'update.snoozeUntil', '');
    await waitForUpdate(page, UPDATE_DAEMON, 'available');
  });

  test('shows Settings > Updates and the backup commands', async ({ page }) => {
    await waitForUpdate(page, UPDATE_DAEMON, 'available');
    await open(page, UPDATE_DAEMON, '/settings');

    const updates = page.locator('[data-update-settings]');
    await expect(updates).toBeVisible();
    await expect(updates.locator('[data-update-status]')).toHaveAttribute(
      'data-update-status',
      'available',
    );
    await expect(updates).toContainText('Test key (development)');
    await expect(updates).toContainText('Current version');
    await expect(updates).toContainText('0.2.0');
    await expect(updates).toContainText('Latest version');
    await expect(updates).toContainText('0.3.0');
    await expect(updates.locator('[data-update-demo]')).toHaveText('Demo');
    await expect(updates.locator('[data-update-demo-note]')).toContainText('demo data');
    await expect(updates.getByRole('button', { name: 'Update now' })).toBeDisabled();

    await updates.locator('summary').click();
    await expect(updates.locator('[data-update-notes]')).toContainText('Highlights');
    const notes = updates.locator('[data-update-notes]');
    await expect(notes.locator('h4')).toHaveText('Highlights');
    await expect(notes.locator('ul li')).toHaveCount(3);
    await expect(notes.locator('li code').first()).toHaveText('pandu backup');
    await expect(notes.locator('img')).toHaveCount(0);
    await expect(notes.locator('script')).toHaveCount(0);

    // A link is rendered as text, never as an anchor, and opening one asks first.
    const link = notes.locator('[data-md-link]');
    await expect(link).toHaveText('updating guide');
    await expect(notes.locator('a')).toHaveCount(0);
    await expect(notes.locator('[data-md-link-confirm]')).toHaveCount(0);
    await link.click();
    const linkConfirm = notes.locator('[data-md-link-confirm]');
    await expect(linkConfirm).toBeVisible();
    await expect(linkConfirm).toContainText(
      'https://github.com/ganddtn40/pandu/blob/main/docs/updating.md',
    );
    await linkConfirm.locator('[data-md-link-cancel]').click();
    await expect(linkConfirm).toHaveCount(0);

    // Confirm once more, but capture window.open instead of leaving the app.
    await page.evaluate(() => {
      const opened: string[] = [];
      (window as unknown as { __openedLinks: string[] }).__openedLinks = opened;
      window.open = ((url?: string | URL) => {
        opened.push(String(url));
        return null;
      }) as typeof window.open;
    });
    await link.click();
    await linkConfirm.locator('[data-md-link-open]').click();
    expect(
      await page.evaluate(
        () => (window as unknown as { __openedLinks: string[] }).__openedLinks,
      ),
    ).toEqual(['https://github.com/ganddtn40/pandu/blob/main/docs/updating.md']);
    await expect(linkConfirm).toHaveCount(0);

    await shotOf(page, '[data-update-settings]', 'settings-updates.png');

    const backup = page.locator('[data-backup-card]');
    await expect(backup).toBeVisible();
    await expect(backup).toContainText('flight history');
    await expect(backup).toContainText('pandu backup --encrypt');
    await expect(backup).toContainText('pandu restore <archive>');
    await expect(backup).toContainText('--include-remote');
    await expect(backup).toContainText('turns remote access off');
    await expect(backup).toContainText('Data folder');
    await expect(backup).toContainText('Open folder');
    await expect(backup.getByRole('button', { name: 'Create backup now' })).toBeEnabled();
    await shotOf(page, '[data-backup-card]', 'settings-backup.png');
  });

  test('skips this version and remembers the skip', async ({ page }) => {
    await waitForUpdate(page, UPDATE_DAEMON, 'available');
    await open(page, UPDATE_DAEMON, '/');

    const card = page.locator('[data-update-card]');
    await card.getByRole('button', { name: /Remind me later/ }).click();
    await page.getByRole('menuitem', { name: 'Skip this version' }).click();
    await expect(card).toHaveCount(0);

    await page.reload();
    await page.waitForFunction(() => window.__panduGlassReady === true);
    await expect(page.locator('[data-update-card]')).toHaveCount(0);

    const status = await waitForUpdate(page, UPDATE_DAEMON, 'skipped');
    expect(status.skippedVersion).toBe('0.3.0');

    await putSetting(page, UPDATE_DAEMON, 'update.skipVersion', '');
    await waitForUpdate(page, UPDATE_DAEMON, 'available');
  });

  test('shows the migration backup notice once', async ({ page }) => {
    await open(page, MIGRATE_DAEMON, '/');

    const notice = page.locator('[data-migration-notice]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Database upgraded from v4 to v5');
    await expect(notice).toContainText('A backup was saved to');
    await expect(notice).toContainText('pandu.db.bak-');
    await shotOf(page, '[data-migration-notice]', 'migration-notice.png');

    await notice.getByRole('button', { name: 'Close' }).click();
    await expect(notice).toHaveCount(0);

    await page.reload();
    await page.waitForFunction(() => window.__panduGlassReady === true);
    await expect(page.locator('[data-migration-notice]')).toHaveCount(0);
    // The overview request finishes after the glass engine is ready. Wait for
    // the bento before capturing, or the screenshot catches the loading state.
    await expect(page.locator('.bento')).toBeVisible();

    await shot(page, 'home-after-migration.png');
  });
});
