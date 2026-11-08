import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'screenshots', 'phase4b');
mkdirSync(SHOTS, { recursive: true });

const DESIGN_KEY = 'cockpit.design';
const WALLPAPER_KEY = 'cockpit.wallpaperImage';

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
  await page.waitForTimeout(300);
}

async function open(page: Page, url: string): Promise<void> {
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

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function storedDesign(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), DESIGN_KEY);
}

/**
 * Overlay surfaces (sheets, the prompt, the phone tab bar) sit above the WebGL
 * canvas, so they must keep a readable CSS background instead of waiting for a
 * glass shape the canvas cannot draw over them.
 */
async function backgroundAlpha(page: Page, selector: string): Promise<number> {
  return page.evaluate((query) => {
    const element = document.querySelector<HTMLElement>(query);
    if (!element) return 0;
    const color = getComputedStyle(element).backgroundColor;
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) return 1;
    const parts = match[1].split(',').map((part) => Number(part.trim()));
    return parts.length === 4 ? (parts[3] ?? 1) : 1;
  }, selector);
}

async function findSmallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('button, a[href], input, select, [role="button"]'),
    );
    return nodes
      .filter((element) => {
        if (element.closest('.sr-only')) return false;
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

  for (const theme of ['dark', 'light', 'frost'] as const) {
    test(`renders the hybrid home in ${theme}`, async ({ page }) => {
      await open(page, `/?theme=${theme}&surface=hybrid`);

      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('data-surface', 'hybrid');
      await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
      await expect(page.locator('canvas.glass-canvas')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

      // Hybrid draws the floating chrome, never the matte cards.
      const floats = await page.locator('[data-glass-layer="float"][data-glass-rendered="true"]').count();
      const cards = await page.locator('.tile[data-glass-rendered="true"]').count();
      expect(floats).toBeGreaterThanOrEqual(1);
      expect(cards).toBe(0);

      await expectNoHorizontalOverflow(page);
      await screenshot(page, `desktop-${theme}-hybrid.png`);
    });
  }

  test('renders matte surfaces without WebGL', async ({ page }) => {
    await open(page, '/?theme=dark&surface=matte');

    await expect(page.locator('html')).toHaveAttribute('data-surface', 'matte');
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'matte');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'desktop-dark-matte.png');
  });

  test('renders liquid glass on cards and floating layers', async ({ page }) => {
    await open(page, '/?theme=dark&surface=glass');

    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
    const cards = await page.locator('.tile[data-glass-rendered="true"]').count();
    expect(cards).toBeGreaterThanOrEqual(4);

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'desktop-dark-glass.png');
  });

  test('previews appearance changes live and persists them', async ({ page }) => {
    await open(page, '/?theme=dark&surface=hybrid');
    const dialog = await openAppearance(page);
    expect(await backgroundAlpha(page, '.sheet--appearance')).toBeGreaterThanOrEqual(0.9);

    await dialog.getByRole('button', { name: /^Light/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await dialog
      .getByRole('group', { name: 'Accent colour' })
      .getByRole('button', { name: 'Blue', exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');

    await dialog
      .getByRole('group', { name: 'Corner radius' })
      .getByRole('button', { name: 'Round', exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-radius', 'round');

    await dialog
      .getByRole('group', { name: 'Density' })
      .getByRole('button', { name: 'Compact', exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

    await dialog.getByRole('button', { name: /Liquid Glass/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'glass');

    await dialog.evaluate((element) => {
      element.querySelector<HTMLElement>('.sheet__body')?.scrollTo({ top: 0 });
    });
    await page.waitForTimeout(50);

    await screenshot(page, 'desktop-appearance-light.png');

    expect(await storedDesign(page)).toMatchObject({
      theme: 'light',
      surface: 'glass',
      accent: 'blue',
      radius: 'round',
      density: 'compact',
    });

    await dialog.getByRole('button', { name: 'Close appearance' }).click();
    await page.goto('/');
    await ready(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'glass');
    await expect(page.locator('html')).toHaveAttribute('data-radius', 'round');
  });

  test('pauses and resumes WebGL with performance mode', async ({ page }) => {
    await open(page, '/?theme=dark&surface=hybrid');
    const dialog = await openAppearance(page);
    const toggle = dialog.getByRole('button', { name: 'Performance mode' });

    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-performance', 'on');
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'performance');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();

    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-performance', 'off');
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
    await expect(page.locator('canvas.glass-canvas')).toBeVisible();
  });

  test('opens the quick prompt from the keyboard', async ({ page }) => {
    await open(page, '/?theme=dark');

    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: 'Ask your agent anything' });
    await expect(dialog).toBeVisible();
    expect(await backgroundAlpha(page, '.quick-prompt')).toBeGreaterThanOrEqual(0.9);
    await expect(dialog.getByPlaceholder(/Explain this stack trace/)).toBeFocused();

    await dialog.getByPlaceholder(/Explain this stack trace/).fill('Summarize this folder');
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeEnabled();
    await screenshot(page, 'desktop-quick-prompt.png');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('hides, reorders, persists, and resets widgets', async ({ page }) => {
    await open(page, '/?theme=dark');

    await expect(page.locator('.tile--guards')).toBeVisible();
    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('button', { name: 'Hide Guards' }).click();
    await expect(page.locator('.tile--guards')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show Guards' })).toBeVisible();

    await page.reload();
    await ready(page);
    await expect(page.locator('.tile--guards')).toHaveCount(0);

    await page.getByRole('button', { name: 'Customize' }).click();
    await page.locator('.edit-note').getByRole('button', { name: 'Reset layout' }).click();
    await expect(page.locator('.tile--guards')).toBeVisible();

    // Drag the spend tile before the live tile with a real pointer gesture.
    const handle = page.getByRole('button', { name: 'Drag Spend today' });
    const target = page.locator('.tile--live');
    const handleBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    if (!handleBox || !targetBox) throw new Error('missing drag geometry');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 24, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.tile').first()).toHaveAttribute('data-widget', 'spend');

    await page.reload();
    await ready(page);
    await expect(page.locator('.tile').first()).toHaveAttribute('data-widget', 'spend');

    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('button', { name: 'Move Spend today down' }).click();
    await expect(page.locator('.tile').first()).toHaveAttribute('data-widget', 'live');
  });

  test('exports, imports, shares, and rejects bad theme files', async ({ page }) => {
    await open(page, '/?theme=dark');
    const dialog = await openAppearance(page);

    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('missing exported theme');
    const exported = JSON.parse(readFileSync(downloadPath, 'utf8')) as Record<string, unknown>;

    expect(exported.schema).toBe('cockpit.theme');
    expect(exported.version).toBe(1);
    expect(exported).not.toHaveProperty('wallpaperImage');
    expect(exported).not.toHaveProperty('performance');

    const imported = { ...exported, theme: 'light', accent: 'violet', wallpaper: 'none' };
    const themeInput = dialog.locator('input[aria-label="Import a theme file"]');
    await themeInput.setInputFiles({
      name: 'cockpit-theme.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(imported)),
    });

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet');
    await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'none');
    await expect(page.locator('.toast')).toContainText('Theme imported');

    await themeInput.setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schema: 'not-cockpit' })),
    });
    await expect(page.locator('.toast')).toContainText('not a Cockpit theme');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await dialog.getByRole('button', { name: 'Copy share link' }).click();
    await expect(page.locator('.toast')).toContainText('Share link copied');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    const encoded = new URL(clipboard).searchParams.get('share');
    expect(encoded).toBeTruthy();
    const shared = JSON.parse(
      Buffer.from(encoded!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(shared.schema).toBe('cockpit.theme');
    expect(shared.theme).toBe('light');
    expect(shared.accent).toBe('violet');
    expect(shared).not.toHaveProperty('wallpaperImage');
  });

  test('stores a wallpaper on this device only and removes it', async ({ page }) => {
    await open(page, '/?theme=dark');
    const dialog = await openAppearance(page);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3l4wAAAABJRU5ErkJggg==',
      'base64',
    );
    await dialog.locator('input[aria-label="Choose a wallpaper image"]').setInputFiles({
      name: 'wallpaper.png',
      mimeType: 'image/png',
      buffer: png,
    });

    await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'image');
    await expect(page.locator('.toast')).toContainText('Wallpaper saved on this device only');
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), WALLPAPER_KEY))
      .toMatch(/^data:image\/jpeg/);
    await expect(dialog.getByRole('button', { name: 'Replace image' })).toBeVisible();

    await screenshot(page, 'desktop-appearance-wallpaper.png');

    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'procedural');
    expect(await page.evaluate((key) => localStorage.getItem(key), WALLPAPER_KEY)).toBeNull();
  });

  test('keeps an idle hybrid canvas from redrawing', async ({ page }) => {
    await open(page, '/?theme=dark&surface=hybrid');
    await page.waitForTimeout(1200);

    const before = await page.evaluate(() => window.__cockpitGlassStats?.redrawsTotal ?? -1);
    await page.waitForTimeout(3000);
    const after = await page.evaluate(() => window.__cockpitGlassStats?.redrawsTotal ?? -1);

    expect(before).toBeGreaterThan(0);
    expect(after - before).toBe(0);
  });

  test('shows a visible focus ring for keyboard users', async ({ page }) => {
    await open(page, '/?theme=light');

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

  test('renders the secondary screens', async ({ page }) => {
    await forceWebglPreference(page);

    for (const [route, name] of [
      ['/settings', 'desktop-settings-dark.png'],
      ['/inbox', 'desktop-inbox-dark.png'],
      ['/flights', 'desktop-flights-dark.png'],
      ['/market', 'desktop-market-dark.png'],
      ['/welcome', 'desktop-welcome-dark.png'],
      ['/glass-preview', 'desktop-glass-preview-dark.png'],
    ] as const) {
      await page.goto(route);
      await ready(page);
      await expectNoHorizontalOverflow(page);
      await screenshot(page, name);
    }

    await expect(page.getByRole('heading', { level: 1, name: 'Surfaces, controls, and type.' })).toBeVisible();
  });

  test('falls back for reduced transparency and ?glass=off', async ({ page }) => {
    // No preference override: headless Chromium requests reduced transparency.
    await page.goto('/?theme=dark');
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'reduced-transparency');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();
    await screenshot(page, 'desktop-dark-fallback.png');

    await forceWebglPreference(page);
    await page.goto('/?glass=off&theme=dark');
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'preference');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();
  });
});

test.describe('phone shell', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  for (const theme of ['dark', 'light', 'frost'] as const) {
    test(`renders the phone home in ${theme}`, async ({ page }) => {
      await open(page, `/?theme=${theme}&surface=hybrid`);

      await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
      await expect(page.locator('nav.tabbar')).toBeVisible();
      await expect(page.locator('.rail')).toBeHidden();
      await expect(page.locator('.quick-fab')).toBeHidden();
      expect(await backgroundAlpha(page, 'nav.tabbar')).toBeGreaterThanOrEqual(0.9);

      await expectNoHorizontalOverflow(page);
      await screenshot(page, `phone-${theme}-hybrid.png`);
    });
  }

  test('renders matte surfaces on the phone', async ({ page }) => {
    await open(page, '/?theme=dark&surface=matte');

    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'matte');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'phone-dark-matte.png');
  });

  test('meets the 44px touch target budget', async ({ page }) => {
    await page.goto('/?theme=light');
    await ready(page);
    expect(await findSmallTargets(page)).toEqual([]);

    const dialog = await openAppearance(page);
    await expect(dialog).toBeVisible();
    expect(await findSmallTargets(page)).toEqual([]);

    await dialog.getByRole('button', { name: 'Close appearance' }).click();
    await page.goto('/settings');
    await ready(page);
    expect(await findSmallTargets(page)).toEqual([]);
    await expect(page.locator('.quick-fab')).toBeVisible();
    expect(await backgroundAlpha(page, '.quick-fab')).toBeGreaterThanOrEqual(0.9);
  });

  test('opens the appearance sheet as a bottom sheet', async ({ page }) => {
    await open(page, '/?theme=dark&surface=hybrid');
    await openAppearance(page);
    await screenshot(page, 'phone-dark-appearance.png');
  });

  test('enters edit mode with a long press', async ({ page }) => {
    await open(page, '/?theme=dark');
    const tile = page.locator('.tile--live');
    const box = await tile.boundingBox();
    if (!box) throw new Error('missing tile geometry');

    await tile.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      pointerId: 7,
      clientX: box.x + 24,
      clientY: box.y + 24,
    });
    await page.waitForTimeout(650);

    await expect(page.locator('.edit-note')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide Live flight' })).toBeVisible();
    await screenshot(page, 'phone-dark-edit.png');
  });

  test('keeps the last tile clear of the tab pill', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await open(page, '/?theme=light');

    await page.locator('main.panel').evaluate((panel) => {
      panel.scrollTop = panel.scrollHeight;
    });
    await page.waitForTimeout(120);

    const clearance = await page.evaluate(() => {
      const tiles = document.querySelectorAll('.tile');
      const last = tiles[tiles.length - 1]?.getBoundingClientRect();
      const tabbar = document.querySelector('.tabbar')?.getBoundingClientRect();
      if (!last || !tabbar) throw new Error('missing phone shell elements');
      return tabbar.top - last.bottom;
    });

    expect(clearance).toBeGreaterThanOrEqual(12);
    await screenshot(page, 'phone-360-bottom.png');
  });
});
