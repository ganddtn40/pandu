import { expect, test, type Page } from '@playwright/test';

const DEMO_DAEMON = 'http://127.0.0.1:4321';

async function prepare(page: Page): Promise<void> {
  await page.addInitScript((daemonUrl) => {
    window.__panduDaemonUrl = daemonUrl;
    try {
      localStorage.setItem('pandu.onboarded', '1');
    } catch {
      // Storage is optional.
    }
  }, DEMO_DAEMON);
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__panduGlassReady === true);
}

const homeItem = (page: Page) => page.locator('.rail__item').first();

test.describe('language catalogs and direction', () => {
  test('deep link boots Arabic before paint and loads its catalog', async ({ page }) => {
    await prepare(page);
    await page.goto('/?lang=ar');
    await ready(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(homeItem(page)).toHaveAttribute('aria-label', 'الرئيسية');

    const rail = await page.locator('.rail').boundingBox();
    const main = await page.locator('main.panel').boundingBox();
    expect(rail).not.toBeNull();
    expect(main).not.toBeNull();
    expect(rail!.x).toBeGreaterThan(main!.x);
  });

  test('switching language loads a catalog and mirrors the shell back', async ({ page }) => {
    await prepare(page);
    await page.goto('/');
    await ready(page);

    await page.getByRole('button', { name: 'Appearance' }).click();
    const dialog = page.getByRole('dialog');
    const language = dialog.locator('select');

    await language.selectOption('ko');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(homeItem(page)).toHaveAttribute('aria-label', '홈');

    await language.selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(homeItem(page)).toHaveAttribute('aria-label', 'الرئيسية');

    await language.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(homeItem(page)).toHaveAttribute('aria-label', 'Home');
  });
});
