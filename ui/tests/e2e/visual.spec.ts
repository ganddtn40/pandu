import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'screenshots', 'phase4');
mkdirSync(SHOTS, { recursive: true });

/**
 * Headless Chromium reports `prefers-reduced-transparency: reduce`, which the
 * app honors by falling back to CSS. Screenshot tests need the real WebGL path,
 * so report "no preference" for that one query only.
 */
async function forceWebglPreference(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const list = original(query);
      if (query.includes('prefers-reduced-transparency')) {
        Object.defineProperty(list, 'matches', { value: false, configurable: true });
      }
      return list;
    };
  });
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__cockpitGlassReady === true);
  // Give the compositor one more frame so screenshots capture the WebGL pass.
  await page.waitForTimeout(250);
}

async function openGlass(page: Page, url: string): Promise<void> {
  await forceWebglPreference(page);
  await page.goto(url);
  await ready(page);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(
      doc.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    );
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
}

async function findSmallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('button, a[href], input, select, [role="button"]'),
    );
    return nodes
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return rect.width < 44 || rect.height < 44;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${element.tagName.toLowerCase()}.${element.className} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
      });
  });
}

test.describe('desktop shell', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of ['light', 'dark'] as const) {
    test(`renders the shell in ${theme}`, async ({ page }) => {
      await openGlass(page, `/?theme=${theme}`);

      await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
      await expect(page.locator('canvas.glass-canvas')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Live flight' })).toBeVisible();

      const rendered = await page.locator('[data-glass-rendered="true"]').count();
      expect(rendered).toBeGreaterThanOrEqual(4);

      await expectNoHorizontalOverflow(page);
      await screenshot(page, `shell-${theme}.png`);
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`renders the glass preview in ${theme}`, async ({ page }) => {
      await openGlass(page, `/glass-preview?theme=${theme}`);

      await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Surfaces, controls, and type.' }),
      ).toBeVisible();
      await expect(page.getByText('WebGL2', { exact: true }).first()).toBeVisible();

      await expectNoHorizontalOverflow(page);
      await screenshot(page, `glass-preview-${theme}.png`);

      await page.locator('main.panel').evaluate((panel) => {
        panel.scrollTop = panel.scrollHeight;
      });
      await page.waitForTimeout(150);
      await screenshot(page, `glass-preview-refraction-${theme}.png`);
    });
  }

  test('renders the CSS fallback when glass is disabled', async ({ page }) => {
    await page.goto('/?glass=off&theme=dark');
    await ready(page);

    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Live flight' })).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'shell-fallback-dark.png');
  });

  test('keeps the theme choice across reloads', async ({ page }) => {
    await openGlass(page, '/');

    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('cockpit.theme'))).toBe('light');

    await page.reload();
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('shows a visible focus ring for keyboard users', async ({ page }) => {
    await openGlass(page, '/?theme=light');

    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });

    expect(focus).not.toBeNull();
    expect(focus?.outlineStyle).toBe('solid');
    expect(focus?.outlineWidth ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('idle glass canvas does not redraw', async ({ page }) => {
    await openGlass(page, '/glass-preview?theme=dark&pattern=smoky');
    await page.waitForTimeout(1200);

    const before = await page.evaluate(() => window.__cockpitGlassStats?.redrawsTotal ?? -1);
    await page.waitForTimeout(3000);
    const after = await page.evaluate(() => window.__cockpitGlassStats?.redrawsTotal ?? -1);

    expect(before).toBeGreaterThan(0);
    expect(after - before).toBe(0);
  });

  test('toggles the checker refraction wallpaper', async ({ page }) => {
    await openGlass(page, '/glass-preview?theme=dark&pattern=smoky');

    await expect(page.locator('html')).toHaveAttribute('data-glass-pattern', 'smoky');
    await page.getByRole('button', { name: 'Use checker wallpaper' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-glass-pattern', 'checker');
    await expect(page.getByText('Current: checker', { exact: true })).toBeVisible();
    await expect(page.locator('.debug-overlay')).toContainText('On · WebGL2');

    await page.waitForTimeout(300);
    await screenshot(page, 'glass-preview-checker-dark.png');
  });
});

test.describe('phone shell', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  for (const theme of ['light', 'dark'] as const) {
    test(`renders the shell in ${theme}`, async ({ page }) => {
      await openGlass(page, `/?theme=${theme}`);

      await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
      await expect(page.locator('nav.tabbar')).toBeVisible();
      await expect(page.locator('.rail')).toBeHidden();

      await expectNoHorizontalOverflow(page);
      await screenshot(page, `shell-phone-${theme}.png`);
    });
  }

  test('meets the 44px touch target budget', async ({ page }) => {
    await page.goto('/?theme=light');
    await ready(page);
    expect(await findSmallTargets(page)).toEqual([]);

    await page.goto('/glass-preview?theme=light');
    await ready(page);
    expect(await findSmallTargets(page)).toEqual([]);
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 640 },
  ]) {
    test(`keeps the last card clear of the tab pill at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openGlass(page, '/?theme=light');

      await page.locator('main.panel').evaluate((panel) => {
        panel.scrollTop = panel.scrollHeight;
      });
      await page.waitForTimeout(100);

      const clearance = await page.evaluate(() => {
        const recent = document.querySelector('.recent')?.getBoundingClientRect();
        const tabbar = document.querySelector('.tabbar')?.getBoundingClientRect();
        if (!recent || !tabbar) throw new Error('missing phone shell elements');
        return tabbar.top - recent.bottom;
      });

      expect(clearance).toBeGreaterThanOrEqual(15);
      await screenshot(page, `shell-phone-${viewport.width}-bottom.png`);
    });
  }
});
