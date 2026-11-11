import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'screenshots', 'phase6');
mkdirSync(SHOTS, { recursive: true });

const DEMO_DAEMON = 'http://127.0.0.1:4321';
const LIVE_DAEMON = 'http://127.0.0.1:4322';
const DESIGN_KEY = 'pandu.design';
const WALLPAPER_KEY = 'pandu.wallpaperImage';
const ONBOARDED_KEY = 'pandu.onboarded';

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

interface PrepareOptions {
  daemon?: string;
  onboarded?: boolean;
  forceGlass?: boolean;
  lowEnd?: boolean;
}

/**
 * Point the app at the disposable daemon for this run, seed first-run state,
 * and (for screenshot tests) report no reduced-transparency preference so the
 * real WebGL path renders. Headless Chromium otherwise asks for the CSS
 * fallback.
 */
async function prepare(page: Page, options: PrepareOptions = {}): Promise<void> {
  const {
    daemon = DEMO_DAEMON,
    onboarded = true,
    forceGlass = true,
    lowEnd = false,
  } = options;

  if (forceGlass) {
    // Overriding matchMedia only affects JavaScript. The CSS fallback rule is
    // driven by the real media feature, so emulate it through CDP as well.
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
    });
  }

  await page.addInitScript(
    ({ daemonUrl, isOnboarded, webgl, constrained }) => {
      window.__panduDaemonUrl = daemonUrl;
      try {
        // Seed first-run state once per context. Re-running this on every
        // navigation would wipe the flag that "Skip" just wrote.
        if (!sessionStorage.getItem('pandu.e2ePrepared')) {
          sessionStorage.setItem('pandu.e2ePrepared', '1');
          if (isOnboarded) localStorage.setItem('pandu.onboarded', '1');
          else localStorage.removeItem('pandu.onboarded');
        }
      } catch {
        // Storage is optional.
      }

      if (webgl) {
        const original = window.matchMedia.bind(window);
        window.matchMedia = (query: string) => {
          const list = original(query);
          if (query.includes('prefers-reduced-transparency')) {
            Object.defineProperty(list, 'matches', { value: false, configurable: true });
          }
          return list;
        };
      }

      if (constrained) {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          configurable: true,
          get: () => 2,
        });
        Object.defineProperty(navigator, 'deviceMemory', {
          configurable: true,
          get: () => 2,
        });
      }
    },
    { daemonUrl: daemon, isOnboarded: onboarded, webgl: forceGlass, constrained: lowEnd },
  );
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__panduGlassReady === true);
  await page.waitForTimeout(250);
}

async function open(page: Page, url: string, options: PrepareOptions = {}): Promise<void> {
  await prepare(page, options);
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

async function expectNoDevelopmentCopy(page: Page): Promise<void> {
  await expect(page.locator('body')).not.toContainText(
    /Phase\s+\d|Preview data|arrives in Phase|coming in Phase|shell preview/i,
  );
}

async function expectNoRawPlaceholders(page: Page): Promise<void> {
  await expect(page.locator('body')).not.toContainText(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
}

async function openAppearance(page: Page) {
  await page.locator('.topbar').getByRole('button', { name: 'Appearance' }).click();
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

async function backdropBlur(page: Page, selector: string): Promise<number> {
  return page.evaluate((query) => {
    const element = document.querySelector<HTMLElement>(query);
    if (!element) return 0;
    const style = getComputedStyle(element);
    const value = style.backdropFilter || '';
    const match = value.match(/blur\(([\d.]+)px\)/);
    return match ? Number.parseFloat(match[1] ?? '0') : 0;
  }, selector);
}

async function smallTextOffenders(page: Page, minimum: number): Promise<string[]> {
  return page.evaluate((min) => {
    const offenders: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent?.trim() ?? '';
      if (!text) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest('.sr-only, svg, script, style, [aria-hidden="true"]')) continue;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (Number(style.opacity) === 0) continue;
      const rect = parent.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const size = Number.parseFloat(style.fontSize);
      if (size + 0.05 < min) {
        const name = parent.getAttribute('class') ?? '';
        offenders.push(
          `${parent.tagName.toLowerCase()}.${name.slice(0, 40)} "${text.slice(0, 32)}" ${size}px`,
        );
      }
    }
    return offenders.slice(0, 25);
  }, minimum);
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

async function shapeStats(page: Page) {
  return page.evaluate(() => window.__panduGlassStats ?? null);
}

async function waitForHomeData(page: Page): Promise<void> {
  await expect(page.locator('.preview-note')).toContainText('Synced', { timeout: 15_000 });
}

test.describe('first run', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens the tour before the dashboard and lands on live data', async ({ page }) => {
    await prepare(page, { onboarded: false });
    await page.goto('/');
    await ready(page);

    await expect(page).toHaveURL(/\/welcome$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your agents, in one calm place.' }),
    ).toBeVisible();
    await expect(page.getByText(/Daemon online · v0\.2\.0/)).toBeVisible();
    await expect(page.getByText(/\d+ agents detected/)).toBeVisible();
    await expectNoDevelopmentCopy(page);
    await screenshot(page, 'desktop-onboarding-welcome.png');

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Every step, recorded.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'You stay in control.' }),
    ).toBeVisible();
    await screenshot(page, 'desktop-onboarding-control.png');

    await page.getByRole('button', { name: 'Open Pandu' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await waitForHomeData(page);
    expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDED_KEY)).toBe('1');
  });

  test('can be skipped and replayed from Settings', async ({ page }) => {
    await prepare(page, { onboarded: false });
    await page.goto('/welcome');
    await ready(page);
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

    await page.goto('/settings');
    await ready(page);
    await page.getByRole('button', { name: 'Replay the tour' }).click();
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your agents, in one calm place.' }),
    ).toBeVisible();
  });
});

test.describe('desktop shell', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('renders real daemon data with honest demo labels', async ({ page }) => {
    await open(page, '/');
    await waitForHomeData(page);

    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Review landing page copy').first()).toBeVisible();
    await expect(page.locator('.status-pill--demo').first()).toBeVisible();
    await expect(page.locator('.tile--spend .tile__value')).not.toHaveText('$0.00');
    await expect(page.locator('.tile--tokens .tile__value')).not.toHaveText('0');
    await expect(page.locator('.tile--recent .list-row')).toHaveCount(4);
    await expect(page.locator('.tile--agents .agent-row')).toHaveCount(3);
    await expect(page.locator('.preview-note')).toContainText('Synced');
    await expect(page.locator('.preview-note')).toContainText('demo mode');
    await expectNoDevelopmentCopy(page);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'desktop-home-dark-demo.png');
  });

  for (const theme of ['dark', 'light', 'frost'] as const) {
    test(`renders the home in ${theme}`, async ({ page }) => {
      await open(page, `/?theme=${theme}&surface=hybrid`);
      await waitForHomeData(page);

      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('data-surface', 'hybrid');
      await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
      await expect(page.locator('canvas.glass-canvas')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

      const floats = await page.locator('[data-glass-layer="float"][data-glass-rendered="true"]').count();
      const cards = await page.locator('.tile[data-glass-rendered="true"]').count();
      expect(floats).toBeGreaterThanOrEqual(1);
      expect(cards).toBe(0);

      await expectNoHorizontalOverflow(page);
      await screenshot(page, `desktop-home-${theme}.png`);
    });
  }

  test('renders matte surfaces without WebGL', async ({ page }) => {
    await open(page, '/?theme=dark&surface=matte');
    await waitForHomeData(page);

    await expect(page.locator('html')).toHaveAttribute('data-surface', 'matte');
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'matte');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'desktop-home-matte.png');
  });

  test('renders liquid glass on cards and floating layers', async ({ page }) => {
    await open(page, '/?theme=dark&surface=glass');
    await waitForHomeData(page);

    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
    const cards = await page.locator('.tile[data-glass-rendered="true"]').count();
    expect(cards).toBeGreaterThanOrEqual(4);

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'desktop-home-glass.png');
  });

  test('keeps one logo in the top bar and opens Add agent from the rail', async ({ page }) => {
    await open(page, '/');
    await waitForHomeData(page);

    await expect(page.locator('.topbar .brand')).toHaveCount(1);
    await expect(page.locator('.rail .brand')).toHaveCount(0);

    const geometry = await page.evaluate(() => {
      const rail = document.querySelector('.rail')?.getBoundingClientRect();
      const first = document.querySelector('.rail__nav .rail__item')?.getBoundingClientRect();
      if (!rail || !first) throw new Error('missing rail geometry');
      return { offset: first.top - rail.top };
    });
    expect(geometry.offset).toBeLessThan(40);

    const plus = page.locator('.rail').getByRole('button', { name: 'Add agent' });
    await expect(plus).toHaveAttribute('data-tooltip', 'Add agent');
    await plus.click();
    const dialog = page.getByRole('dialog', { name: 'Add an agent' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('OpenCode', { exact: true })).toBeVisible();
    await expect(dialog.getByText('pandu run -- opencode')).toBeVisible();
    await screenshot(page, 'desktop-add-agent.png');

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await dialog.getByRole('button', { name: 'Copy' }).first().click();
    await expect(page.locator('.toast')).toContainText('Command copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('pandu run --');

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('keeps every label at 12px or larger', async ({ page }) => {
    await open(page, '/');
    await waitForHomeData(page);
    expect(await smallTextOffenders(page, 12)).toEqual([]);

    await page.goto('/flights');
    await ready(page);
    await expect(page.locator('.flight-row').first()).toBeVisible();
    expect(await smallTextOffenders(page, 12)).toEqual([]);
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

  test('exports, imports, shares, and rejects bad theme files', async ({ page }) => {
    await open(page, '/?theme=dark');
    const dialog = await openAppearance(page);

    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('missing exported theme');
    const exported = JSON.parse(readFileSync(downloadPath, 'utf8')) as Record<string, unknown>;

    expect(exported.schema).toBe('pandu.theme');
    expect(exported.version).toBe(1);
    expect(exported).not.toHaveProperty('wallpaperImage');
    expect(exported).not.toHaveProperty('performance');

    const imported = { ...exported, theme: 'light', accent: 'violet', wallpaper: 'none' };
    const themeInput = dialog.locator('input[aria-label="Import a theme file"]');
    await themeInput.setInputFiles({
      name: 'pandu-theme.json',
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
      buffer: Buffer.from(JSON.stringify({ schema: 'not-pandu' })),
    });
    await expect(page.locator('.toast')).toContainText('not a Pandu theme');
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
    expect(shared.schema).toBe('pandu.theme');
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

  test('opens the quick prompt and copies an honest command', async ({ page }) => {
    await open(page, '/');
    await waitForHomeData(page);

    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: 'Run an agent through Pandu' });
    await expect(dialog).toBeVisible();
    expect(await backgroundAlpha(page, '.quick-prompt')).toBeGreaterThanOrEqual(0.9);
    const field = dialog.getByPlaceholder(/Write the prompt/);
    await expect(field).toBeFocused();

    await field.fill('Summarize this folder');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await dialog.getByRole('button', { name: 'Copy prompt' }).click();
    await expect(page.locator('.toast')).toContainText('Prompt copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Summarize this folder');

    await dialog.getByRole('button', { name: 'Copy command' }).click();
    await expect(page.locator('.toast')).toContainText('Command copied. Paste it in your terminal.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('pandu run --');

    await screenshot(page, 'desktop-quick-prompt.png');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('hides, reorders, persists, and resets widgets', async ({ page }) => {
    await open(page, '/?theme=dark');
    await waitForHomeData(page);

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

    const handle = page.getByRole('button', { name: 'Drag Spend' });
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
    await page.getByRole('button', { name: 'Move Spend down' }).click();
    await expect(page.locator('.tile').first()).toHaveAttribute('data-widget', 'live');
  });

  test('keeps an idle hybrid canvas from redrawing', async ({ page }) => {
    await open(page, '/?theme=dark&surface=hybrid');
    await page.waitForTimeout(1200);

    const before = await page.evaluate(() => window.__panduGlassStats?.redrawsTotal ?? -1);
    await page.waitForTimeout(3000);
    const after = await page.evaluate(() => window.__panduGlassStats?.redrawsTotal ?? -1);

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

  test('falls back for reduced transparency and ?glass=off', async ({ page }) => {
    await prepare(page, { forceGlass: false });
    await page.goto('/?theme=dark');
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'reduced-transparency');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();
    await screenshot(page, 'desktop-home-fallback.png');

    await prepare(page, { forceGlass: true });
    await page.goto('/?glass=off&theme=dark');
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'preference');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();
  });

  test('hides developer diagnostics in production', async ({ page }) => {
    await open(page, '/glass-preview');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Surfaces, controls, and type.')).toHaveCount(0);
    await expectNoDevelopmentCopy(page);
  });

  test('renders every secondary screen against the daemon', async ({ page }) => {
    await prepare(page);

    for (const [route, name, heading] of [
      ['/inbox', 'desktop-inbox-demo.png', 'Needs you'],
      ['/flights', 'desktop-flights-list.png', 'Every run, recorded'],
      ['/settings', 'desktop-settings-demo.png', 'Make it yours'],
      ['/market', 'desktop-market.png', 'Skills and MCP servers'],
    ] as const) {
      await page.goto(route);
      await ready(page);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expectNoDevelopmentCopy(page);
      await expectNoHorizontalOverflow(page);
      await screenshot(page, name);
    }
  });

  test('never renders an unsubstituted placeholder', async ({ page }) => {
    await prepare(page);
    for (const route of ['/', '/inbox', '/flights', '/settings', '/market']) {
      await page.goto(route);
      await ready(page);
      if (route === '/') await waitForHomeData(page);
      await expectNoRawPlaceholders(page);
    }
  });

  test('filters, opens, replays, and deep-links a recorded flight', async ({ page }) => {
    await open(page, '/flights');
    await expect(page.locator('.flight-row')).toHaveCount(4);
    await expect(page.locator('.flights-toolbar__count')).toContainText('4 flights');

    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(page.locator('.flight-row')).toHaveCount(2);

    const search = page.getByPlaceholder('Search flights');
    await search.fill('flaky');
    await expect(page.locator('.flight-row')).toHaveCount(1);
    await expect(page.locator('.flight-row')).toContainText('Fix flaky checkout test');

    await page.locator('.flight-row').click();
    await expect(page).toHaveURL(/\/flights\?session=/);
    const detail = page.locator('.flight-detail');
    await expect(detail.getByRole('heading', { level: 2, name: 'Fix flaky checkout test' })).toBeVisible();

    await expect(detail.getByRole('tab', { name: 'Live output' })).toHaveAttribute('aria-selected', 'true');
    await expect(detail.locator('.output-panel')).toContainText('The test reads');
    await expect(detail.locator('.output-panel')).toContainText('recalculation finishes');
    await expect(detail.locator('.output-block--thinking')).toContainText('The 50 ms sleep');
    await screenshot(page, 'desktop-flight-output.png');

    await detail.getByRole('tab', { name: 'Timeline' }).click();
    const progress = detail.locator('.timeline-controls__label span').first();
    await expect(progress).toHaveText('Step 1 of 1');
    await expect(detail.locator('.step-row')).toHaveCount(1);
    await expect(detail.locator('.step-detail')).toContainText('model · claude-sonnet-4');
    await screenshot(page, 'desktop-flight-timeline.png');

    const range = detail.locator('input[type="range"]');
    await range.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(progress).toHaveText('Step 0 of 1');
    await expect(detail.locator('.step-row')).toHaveCount(0);

    await detail.getByRole('button', { name: 'Play replay' }).click();
    await expect(progress).toHaveText('Step 1 of 1', { timeout: 3_000 });

    const deepLink = page.url();
    await page.reload();
    await ready(page);
    await expect(page).toHaveURL(deepLink);
    await expect(page.locator('.flight-detail h2')).toHaveText('Fix flaky checkout test');
  });

  test('shows snapshots with file changes and patches', async ({ page }) => {
    await open(page, '/flights');
    await page.getByRole('button', { name: /Refactor auth middleware/ }).click();
    const detail = page.locator('.flight-detail');
    await expect(detail.getByRole('heading', { level: 2, name: 'Refactor auth middleware' })).toBeVisible();

    await detail.getByRole('tab', { name: /^Snapshots/ }).click();
    const snapshot = detail.locator('.snapshot-card');
    await expect(snapshot).toHaveCount(1);
    await expect(snapshot).toContainText('after');
    await expect(snapshot).toContainText('3 files');
    await expect(snapshot).toContainText('+128');
    await expect(snapshot).toContainText('−42');
    await expect(snapshot).toContainText('feature/auth-cleanup');
    await expect(snapshot).toContainText('8f3c2a1d9b7e');

    await snapshot.locator('summary').click();
    await expect(snapshot.locator('pre')).toContainText('src/auth/session.rs');
    await screenshot(page, 'desktop-flight-snapshots.png');
    await expectNoHorizontalOverflow(page);
  });

  test('shows real daemon health, adapters, and honest platform support', async ({ page }) => {
    await open(page, '/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Make it yours' })).toBeVisible();
    await expect(page.locator('.screen-head')).toContainText('Demo');
    await expect(page.getByText('0.2.0').first()).toBeVisible();
    await expect(page.getByText('http://127.0.0.1:4321')).toBeVisible();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await expect(page.getByText(/5 of 15 installed/)).toBeVisible();
    await expect(page.locator('.adapter-row')).toHaveCount(15);
    await expect(page.getByText('Web / PWA')).toBeVisible();
    await expect(page.getByText('Android', { exact: true })).toBeVisible();
    await expect(page.getByText('Windows', { exact: true })).toBeVisible();
    await expect(page.getByText('macOS', { exact: true })).toBeVisible();
    await expect(page.getByText('iOS', { exact: true })).toBeVisible();
    await expect(page.getByText('Linux', { exact: true })).toBeVisible();
    await expect(page.getByText('Signed updates ready')).toBeVisible();
    await expectNoDevelopmentCopy(page);
    await screenshot(page, 'desktop-settings-demo.png');
  });

  test('shows no demo data or demo actions when the daemon is live', async ({ page }) => {
    await open(page, '/', { daemon: LIVE_DAEMON });
    await waitForHomeData(page);

    await expect(page.locator('.status-pill--demo')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load demo flights' })).toHaveCount(0);
    await expect(page.getByText('No flight in progress')).toBeVisible();
    await expect(page.locator('.tile--spend .tile__value')).toHaveText('$0.00');
    await screenshot(page, 'desktop-home-live-empty.png');

    await page.goto('/inbox');
    await ready(page);
    await expect(page.getByText('You are all caught up')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load demo flights' })).toHaveCount(0);

    await page.goto('/flights');
    await ready(page);
    await expect(page.getByText('No flights yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load demo flights' })).toHaveCount(0);
  });

  test('approves a pending guard and records the decision', async ({ page }) => {
    await open(page, '/inbox');
    const card = page.locator('.guard-card:not(.agent-event)');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading', { level: 2, name: 'Deploy the landing page?' })).toBeVisible();
    await expect(card).toContainText('pnpm deploy --prod');
    await expect(card).toContainText('Demo mode is on');
    await card.scrollIntoViewIfNeeded();
    await screenshot(page, 'desktop-inbox-pending.png');

    // High risk parks focus on the safe choice.
    await expect(card.getByRole('button', { name: 'Deny' })).toBeFocused();
    await card.getByRole('button', { name: 'Approve' }).click();
    const confirm = card.locator('.guard-confirm__input');
    await expect(confirm).toBeFocused();
    await confirm.fill('approve');
    await card.getByRole('button', { name: 'Confirm approve' }).click();
    await expect(page.locator('.toast')).toContainText('Approved. The agent can continue.');
    await expect(page.locator('.guard-card:not(.agent-event)')).toHaveCount(0);
    const resolved = page.locator('.resolved-row').filter({ hasText: 'Deploy the landing page?' });
    await expect(page.locator('.resolved-section')).toContainText('Resolved');
    await expect(resolved).toContainText('Deploy the landing page?');
    await expect(resolved).toContainText('Approved');
    await resolved.scrollIntoViewIfNeeded();
    await screenshot(page, 'desktop-inbox-resolved.png');
  });

  test('lists agent events and acknowledges a finished agent', async ({ page }) => {
    await open(page, '/inbox');
    const events = page.locator('.agent-event');
    await expect(events).toHaveCount(3);
    await expect(events.filter({ hasText: 'Permission needed' })).toHaveCount(1);
    await expect(events.filter({ hasText: 'Sign-in needed' })).toHaveCount(1);
    const done = events.filter({ hasText: 'Agent finished' });
    await expect(done).toHaveCount(1);
    await expect(done).toContainText('Demo');
    await expect(page.locator('.screen-actions')).toContainText('waiting');
    // The high-risk guard parks focus on Deny, which scrolls the inbox down.
    await page.locator('main.panel').evaluate((panel) => {
      panel.scrollTop = 0;
    });
    await screenshot(page, 'desktop-inbox-agent-events.png');

    await done.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.locator('.toast')).toContainText('Event acknowledged.');
    await expect(page.locator('.agent-event')).toHaveCount(2);
    const resolved = page.locator('.resolved-row').filter({ hasText: 'Agent finished' });
    await expect(resolved).toContainText('Acknowledged');
    await resolved.scrollIntoViewIfNeeded();
    await screenshot(page, 'desktop-inbox-agent-ack.png');
  });

  test('opens a live PTY session and queues keystrokes', async ({ page }) => {
    await open(page, '/inbox');
    await page
      .locator('.agent-event')
      .filter({ hasText: 'Permission needed' })
      .getByRole('button', { name: 'Open live session' })
      .click();

    await expect(page).toHaveURL(/\/session\?id=/);
    await expect(page.getByRole('heading', { level: 1, name: 'checkout-service' })).toBeVisible();
    const output = page.locator('.pty-output');
    await expect(output).toContainText('Claude Code v2.1.0');
    await expect(output).toContainText('Do you want to proceed with the file writes? [y/N]');
    expect(await output.textContent()).not.toContain('\u001b');
    await expect(page.getByText('Prompt detection unverified')).toBeVisible();
    await expect(
      page.getByText('Sanitized output. Control sequences that could spoof the interface are stripped.'),
    ).toBeVisible();
    await expect(page.locator('.screen-actions')).toContainText('Needs you');
    await expect(page.locator('.session-answer')).toBeVisible();
    await screenshot(page, 'desktop-session-live.png');

    const answer = page.locator('.session-answer input');
    await answer.fill('y');
    await page.locator('.session-answer').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Keystrokes queued.');
    await expect(answer).toHaveValue('');
  });

  test('explains notification payloads and toggles Windows toasts', async ({ page }) => {
    await open(page, '/settings');
    const card = page
      .locator('.settings-card')
      .filter({ hasText: 'What a notification contains' });
    await expect(card).toContainText('Event type, agent name, and project name only.');
    await expect(card).toContainText('Demo mode never sends desktop toasts.');
    await expect(card.locator('.notify-row')).toHaveCount(3);

    const toastToggle = card.locator('.notify-row').first().locator('.toggle');
    await expect(toastToggle).toHaveAttribute('aria-pressed', 'true');
    await card.scrollIntoViewIfNeeded();
    await screenshot(page, 'desktop-settings-notifications.png');

    await toastToggle.click();
    await expect(toastToggle).toHaveAttribute('aria-pressed', 'false');
    await toastToggle.click();
    await expect(toastToggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('shows a sign-in prompt on a live daemon without an answer box', async ({ page }) => {
    const headers = await hostHeaders(page, LIVE_DAEMON);
    const registered = await page.request.post(`${LIVE_DAEMON}/api/agents/register`, {
      headers,
      data: {
        agentName: 'Gemini CLI',
        projectName: 'billing-service',
        workingDir: '~/projects/billing-service',
        adapter: 'gemini-cli',
      },
    });
    expect(registered.ok()).toBeTruthy();
    const { session } = await registered.json();

    const event = await page.request.post(
      `${LIVE_DAEMON}/api/agents/${session.sessionId}/events`,
      {
        headers,
        data: {
          type: 'auth_required',
          message: 'Sign in with your browser to continue.',
        },
      },
    );
    expect(event.ok()).toBeTruthy();

    await open(page, `/session?id=${session.sessionId}`, { daemon: LIVE_DAEMON });
    await expect(page.getByRole('heading', { level: 1, name: 'billing-service' })).toBeVisible();
    const auth = page.locator('.session-auth');
    await expect(auth.getByRole('heading', { level: 2, name: 'Needs you at the computer' })).toBeVisible();
    await expect(auth).toContainText('Pandu never asks for or relays passwords');
    await expect(auth).not.toContainText('Sign in with your browser to continue.');
    await expect(page.locator('.session-answer input')).toHaveCount(0);
    await expect(auth.getByRole('button', { name: 'I signed in at the computer' })).toBeVisible();
    await screenshot(page, 'desktop-session-auth.png');
  });
});

test.describe('phone shell', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  for (const theme of ['dark', 'light', 'frost'] as const) {
    test(`renders the phone home in ${theme}`, async ({ page }) => {
      await open(page, `/?theme=${theme}&surface=hybrid`);
      await waitForHomeData(page);

      await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'webgl');
      await expect(page.locator('nav.tabbar')).toBeVisible();
      await expect(page.locator('.rail')).toBeHidden();
      await expect(page.locator('.quick-fab')).toBeHidden();
      await expectNoHorizontalOverflow(page);
      await screenshot(page, `phone-home-${theme}.png`);
    });
  }

  test('keeps the tab pill opaque, blurs the content behind it, and caps glass', async ({ page }) => {
    await open(page, '/?theme=dark&surface=glass');
    await waitForHomeData(page);

    const tabbar = page.locator('nav.tabbar');
    await expect(tabbar).toBeVisible();
    expect(await backgroundAlpha(page, 'nav.tabbar')).toBeGreaterThanOrEqual(0.9);
    expect(await backdropBlur(page, 'nav.tabbar')).toBeGreaterThanOrEqual(20);

    const stats = await shapeStats(page);
    expect(stats?.mode).toBe('webgl');
    expect(stats?.shapes ?? 0).toBeGreaterThan(0);
    expect(stats?.shapes ?? 99).toBeLessThanOrEqual(12);
  });

  test('keeps labels at 13px and touch targets at 44px', async ({ page }) => {
    await open(page, '/?theme=light');
    await waitForHomeData(page);
    expect(await smallTextOffenders(page, 13)).toEqual([]);
    expect(await findSmallTargets(page)).toEqual([]);

    await page.goto('/settings');
    await ready(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Make it yours' })).toBeVisible();
    expect(await smallTextOffenders(page, 13)).toEqual([]);
    expect(await findSmallTargets(page)).toEqual([]);

    await expect(page.locator('.quick-fab')).toBeVisible();
    expect(await backgroundAlpha(page, '.quick-fab')).toBeGreaterThanOrEqual(0.9);
  });

  test('renders matte surfaces on the phone', async ({ page }) => {
    await open(page, '/?theme=dark&surface=matte');
    await waitForHomeData(page);

    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'matte');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'phone-home-matte.png');
  });

  test('opens the appearance sheet as a bottom sheet', async ({ page }) => {
    await open(page, '/?theme=dark&surface=hybrid');
    await openAppearance(page);
    await screenshot(page, 'phone-appearance.png');
  });

  test('enters edit mode with a long press', async ({ page }) => {
    await open(page, '/?theme=dark');
    await waitForHomeData(page);
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
    await screenshot(page, 'phone-edit.png');
  });

  test('keeps the last tile clear of the tab pill', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await open(page, '/?theme=light');
    await waitForHomeData(page);

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

  test('never renders an unsubstituted placeholder on the phone', async ({ page }) => {
    await open(page, '/');
    await waitForHomeData(page);
    await expectNoRawPlaceholders(page);
    for (const route of ['/inbox', '/flights', '/settings', '/market']) {
      await page.goto(route);
      await ready(page);
      await expectNoRawPlaceholders(page);
    }
  });

  test('opens the phone flight list and detail', async ({ page }) => {
    await open(page, '/flights');
    await expect(page.locator('.flight-row')).toHaveCount(4);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'phone-flights.png');

    await page
      .locator('.flight-row')
      .filter({ hasText: 'Review landing page copy' })
      .click();
    const detail = page.locator('.flight-detail');
    await expect(detail.getByRole('heading', { level: 2, name: 'Review landing page copy' })).toBeVisible();

    // The detail owns the screen: no page head, filters, list, or floating
    // prompt above or over it.
    await expect(page.locator('.flights-screen')).toHaveClass(/is-detail/);
    await expect(page.locator('.screen-head')).toBeHidden();
    await expect(page.locator('.flights-toolbar')).toBeHidden();
    await expect(page.locator('.flight-list')).toBeHidden();
    await expect(page.locator('.quick-fab')).toBeHidden();
    expect(await detail.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'phone-flight-detail.png');

    await detail.getByRole('button', { name: 'All flights' }).click();
    await expect(page).not.toHaveURL(/session=/);
    await expect(page.locator('.flight-list')).toBeVisible();
    await expect(page.locator('.flights-screen')).not.toHaveClass(/is-detail/);
  });

  test('opens the phone inbox', async ({ page }) => {
    await open(page, '/inbox');
    await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
    // The desktop approval test may already have resolved the one demo event;
    // the screen must render either state cleanly.
    const pending = await page.locator('.guard-card').count();
    const resolved = await page.locator('.resolved-row').count();
    expect(pending + resolved).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'phone-inbox.png');
  });

  test('opens the phone notification settings', async ({ page }) => {
    await open(page, '/settings');
    const card = page
      .locator('.settings-card')
      .filter({ hasText: 'What a notification contains' });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(card.locator('.notify-row')).toHaveCount(3);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'phone-settings-notifications.png');
  });

  test('starts in performance mode on a low-end device', async ({ page }) => {
    await open(page, '/?surface=hybrid', { lowEnd: true });
    await expect(page.locator('html')).toHaveAttribute('data-performance', 'on');
    await expect(page.locator('html')).toHaveAttribute('data-glass-mode', 'fallback');
    await expect(page.locator('html')).toHaveAttribute('data-glass-reason', 'performance');
    await expect(page.locator('canvas.glass-canvas')).toBeHidden();
  });
});
