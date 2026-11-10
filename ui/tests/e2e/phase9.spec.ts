import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'screenshots', 'phase9');
mkdirSync(SHOTS, { recursive: true });

const DEMO_DAEMON = 'http://127.0.0.1:4321';

async function open(page: Page, url: string): Promise<void> {
  await page.addInitScript((daemonUrl) => {
    window.__cockpitDaemonUrl = daemonUrl;
    try {
      localStorage.setItem('cockpit.onboarded', '1');
    } catch {
      // Storage is optional.
    }
  }, DEMO_DAEMON);
  await page.goto(url);
  await page.waitForFunction(() => window.__cockpitGlassReady === true);
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

test.describe('model, effort, and context', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('shows the latest context meter on Home', async ({ page }) => {
    await open(page, '/');
    await expect(page.locator('.preview-note')).toContainText('Synced', { timeout: 15_000 });

    // Each meter carries its own flight title. The live PTY flight has no
    // proxy context, so the proxy flight keeps a separate labeled meter rather
    // than being presented as the live flight's meter.
    const contextSection = page.locator('[data-live-context]');
    await expect(contextSection).toContainText('Latest per flight');
    const reviewEntry = contextSection
      .locator('[data-context-flight]')
      .filter({ hasText: 'Review landing page copy' });
    await expect(reviewEntry).toBeVisible();

    const meter = reviewEntry.locator('[data-context-meter]');
    await expect(meter).toBeVisible();
    await expect(meter).toHaveAttribute('data-context-percent', '82.4');
    await expect(meter).toHaveAttribute('data-context-high', 'true');
    await expect(meter).toContainText('High context');
    await expect(meter).toContainText('Provider usage');
    await expect(meter).toContainText('864k / 1.0M');

    await shot(page, 'home-context-meter.png');
  });

  test('confirms a host-only override and marks the forwarded flight', async ({ page }) => {
    await open(page, '/flights');
    await page.getByRole('button', { name: /Review landing page copy/ }).click();

    const detail = page.locator('.flight-detail');
    await expect(
      detail.getByRole('heading', { level: 2, name: 'Review landing page copy' }),
    ).toBeVisible();

    const card = detail.locator('[data-model-card]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('gemini-2.5-pro');
    await expect(card).toContainText('82.4%');
    await expect(card.locator('[data-context-meter]')).toBeVisible();
    // The provider reports a total, not a split, so the System/Tools/History/
    // Files/Other rows are an estimate from the recorded request body.
    await expect(card.locator('.context-meter__breakdown-label')).toHaveText(
      'Estimated breakdown',
    );
    await expect(card.locator('.context-meter__breakdown')).toContainText('System');
    await shotOf(page, '.model-card', 'flight-model-effort.png');

    // The override is opt-in and the confirmation step explains exactly what
    // Cockpit rewrites before the Apply button becomes the only way forward.
    await card.locator('[data-model-override-open]').click();
    const panel = card.locator('[data-model-override]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Cockpit rewrites only the model and effort fields');
    await expect(panel).toContainText('Estimated cost on this flight');
    await expect(panel.locator('[data-model-override-confirm]')).toBeEnabled();

    // Gemini 2.5 exposes a numeric thinking budget, not thinking levels.
    const budget = panel.locator('[data-model-budget]');
    await expect(budget).toBeVisible();
    await expect(budget).toContainText('Dynamic');
    await expect(budget).toContainText('Range 128–33k tokens');

    await panel.locator('select').first().selectOption('gemini-3.8-flash');
    await expect(panel.locator('[data-model-budget]')).toHaveCount(0);
    await expect(panel.locator('select').nth(1)).toBeVisible();
    await expect(panel).toContainText('cheaper');
    await expect(panel).toContainText('The first request after switching re-reads');
    await shotOf(page, '.model-card', 'override-confirmation.png');

    await panel.locator('[data-model-override-confirm]').click();
    await expect(page.locator('.toast')).toContainText('Model override applied.');
    await expect(card.locator('[data-model-modified]')).toBeVisible();
    await expect(card.locator('[data-model-modified]')).toContainText('Modified by Cockpit');
    await expect(card.locator('[data-model-original]')).toContainText('gemini-2.5-pro');
    await expect(card.locator('[data-model-original]')).toContainText('gemini-3.8-flash');
    await shotOf(page, '.model-card', 'override-modified-badge.png');

    // Restore the demo flight so later suites see the seeded state.
    await card.getByRole('button', { name: 'Clear override' }).click();
    await expect(page.locator('.toast')).toContainText('Model override cleared.');
    await expect(card.locator('[data-model-modified]')).toHaveCount(0);
  });

  test('shows manual instructions where no verified switch exists', async ({ page }) => {
    await open(page, '/flights');
    await page.getByRole('button', { name: /Refactor auth middleware/ }).click();

    const card = page.locator('.flight-detail [data-model-card]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Manual model switch');
    await expect(card.locator('[data-model-override-open]')).toHaveCount(0);
  });
});
