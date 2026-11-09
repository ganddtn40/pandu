import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'screenshots', 'phase8');
mkdirSync(SHOTS, { recursive: true });

const MARKET_DAEMON = 'http://127.0.0.1:4323';
const OFFLINE_DAEMON = 'http://127.0.0.1:4324';
const MARKET_HOME = path.resolve('.tmp', 'e2e-market-4323');
const USER_HOME = path.join(MARKET_HOME, 'user');
const PROJECT_CONFIG = path.join(MARKET_HOME, 'workspace', '.mcp.json');
const MANIFEST_DIR = path.join(MARKET_HOME, 'market', 'installed');
const SECRET_VALUE = 'e2e-secret-value';
const COMMIT_SHA = '1'.repeat(40);
const CONTENT_SHA = '9c2240678e75338d8b079a83e5c3c8f60638b64c75eca9dad5acfdbcc4d0886e';

const SKILL_ID = 'example-changelog-writer';
const OTHER_SKILL_ID = 'example-commit-messages';
const MCP_ID = 'example-weather';
const SKILL_NAME = 'Example: Changelog Writer';
const MCP_NAME = 'Example: Weather MCP';

async function openMarket(
  page: Page,
  daemon = MARKET_DAEMON,
  { devOverride = true }: { devOverride?: boolean } = {},
): Promise<void> {
  await page.addInitScript((daemonUrl) => {
    window.__cockpitDaemonUrl = daemonUrl;
    try {
      localStorage.setItem('cockpit.onboarded', '1');
    } catch {
      // Storage is optional.
    }
  }, daemon);
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Skills and MCP servers' })).toBeVisible();
  if (devOverride) {
    await expect(page.getByTestId('market-dev-override')).toHaveText('Dev registry override');
  } else {
    await expect(page.getByTestId('market-dev-override')).toHaveCount(0);
  }
  await expect(page.getByTestId(`market-card-${SKILL_ID}`)).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
}

async function openDetail(page: Page, id: string): Promise<void> {
  await page.getByTestId(`market-card-${id}`).click();
  const sheet = page.getByTestId('market-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { level: 2 })).toBeVisible();
}

async function previewInstall(page: Page): Promise<void> {
  await page.getByTestId('market-preview-button').click();
  await expect(page.getByTestId('market-confirm-install')).toBeVisible();
}

test('catalogue, instant search, filters and detail', async ({ page }) => {
  await openMarket(page);
  await expect(page.getByTestId(`market-card-${OTHER_SKILL_ID}`)).toBeVisible();
  await expect(
    page.getByTestId(`market-card-${OTHER_SKILL_ID}`).getByText('Unreviewed'),
  ).toBeVisible();
  await shot(page, 'market-list.png');

  await page.getByTestId('market-search').fill('changelog');
  await expect(page.getByTestId(`market-card-${SKILL_ID}`)).toBeVisible();
  await expect(page.getByTestId(`market-card-${OTHER_SKILL_ID}`)).toHaveCount(0);

  await page.getByTestId('market-search').fill('');
  await page.getByTestId('market-agent-claude-code').click();
  await expect(page.getByTestId('market-agent-claude-code')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const categories = page.getByLabel('Categories');
  await expect(categories.locator('option')).toHaveText([
    'All categories',
    'coding',
    'docs',
    'data',
  ]);
  await categories.selectOption('coding');
  await expect(page.getByTestId(`market-card-${OTHER_SKILL_ID}`)).toBeVisible();
  await expect(page.getByTestId(`market-card-${SKILL_ID}`)).toHaveCount(0);
  await expect(page.getByTestId(`market-card-${OTHER_SKILL_ID}`).getByText('#git')).toBeVisible();
  await shot(page, 'market-filters.png');

  await categories.selectOption('all');
  await page.getByTestId(`market-card-${OTHER_SKILL_ID}`).click();
  const sheet = page.getByTestId('market-sheet');
  await expect(
    sheet.getByRole('heading', { name: 'Example: Commit Message Coach' }),
  ).toBeVisible();
  await expect(sheet.getByText('filesystem:read')).toBeVisible();
  await expect(sheet.getByText('README', { exact: true })).toBeVisible();
  await expect(sheet.getByText(COMMIT_SHA)).toBeVisible();
  await expect(sheet.getByText(CONTENT_SHA)).toBeVisible();
  await expect(sheet.getByText('MIT', { exact: true })).toBeVisible();
  const repo = sheet.getByRole('link', {
    name: /https:\/\/example\.invalid\/cockpit-examples\/commit-messages/,
  });
  await expect(repo).toHaveAttribute('rel', 'noopener');
  await expect(repo).toHaveText('https://example.invalid/cockpit-examples/commit-messages');
  await sheet.getByText('Pinned commit').scrollIntoViewIfNeeded();
  await shot(page, 'market-detail.png');
});

test('daily refresh shows its state and explains the GitHub request', async ({ page }) => {
  await openMarket(page);
  const toggle = page.getByTestId('market-daily-refresh');
  await expect(toggle).toHaveText(/Daily refresh: Off/);
  await expect(page.getByTestId('market-refresh-note')).toContainText('GitHub');
  await toggle.click();
  await expect(toggle).toHaveText(/Daily refresh: On/);
  await toggle.click();
  await expect(toggle).toHaveText(/Daily refresh: Off/);
});

test('skill install preview, installed tab, uninstall and undo', async ({ page }) => {
  await openMarket(page);
  await openDetail(page, SKILL_ID);
  await previewInstall(page);
  await expect(page.getByTestId('market-confirm-install')).toBeEnabled();
  await expect(page.getByTestId('market-skill-warning')).toContainText(
    'instructions for your agent',
  );
  const skillFile = path.join(
    USER_HOME,
    '.claude',
    'skills',
    'example-changelog-writer',
    'SKILL.md',
  );
  await expect(page.getByTestId('market-preview-file-path').first()).toHaveText(skillFile);
  await expect(page.getByTestId('market-preview-file-display').first()).toHaveText(
    '~/.claude/skills/example-changelog-writer/SKILL.md',
  );

  const sheet = page.getByTestId('market-sheet');
  await sheet.getByText('Show diff').first().click();
  await expect(sheet.locator('.market-diff pre').first()).toContainText('# Changelog Writer');
  await shot(page, 'market-preview.png');

  await page.getByTestId('market-confirm-install').click();
  await expect(
    sheet.getByRole('heading', { level: 3, name: `Installed ${SKILL_NAME}` }),
  ).toBeVisible();
  await expect(page.getByText('Cockpit wrote')).toBeVisible();

  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByTestId('market-tab-installed').click();
  await expect(
    page.getByRole('heading', { name: 'Installed skills and MCP servers' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  const installed = page
    .locator('[data-testid^="market-installed-"]')
    .filter({ hasText: SKILL_NAME });
  await expect(installed).toBeVisible();
  await expect(installed.getByText('Installed', { exact: true })).toBeVisible();
  await shot(page, 'market-installed.png');

  await installed.getByTestId(/^market-uninstall-/).click();
  await expect(page.getByTestId('market-confirm-uninstall')).toBeEnabled();
  await page.getByTestId('market-confirm-uninstall').click();
  await expect(
    page.getByRole('heading', { level: 3, name: `Uninstalled ${SKILL_NAME}` }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  const removed = page
    .locator('[data-testid^="market-installed-"]')
    .filter({ hasText: SKILL_NAME });
  await expect(removed.getByText('Uninstalled', { exact: true })).toBeVisible();
  await removed.getByTestId(/^market-undo-/).click();
  await expect(
    page
      .locator('[data-testid^="market-installed-"]')
      .filter({ hasText: SKILL_NAME })
      .getByText('Installed', { exact: true }),
  ).toBeVisible();
});

test('mcp secret, config diff, install and undo', async ({ page }) => {
  await openMarket(page);
  await page.getByTestId('market-tab-mcp').click();
  await expect(page.getByTestId(`market-card-${MCP_ID}`)).toBeVisible();
  await openDetail(page, MCP_ID);
  await page.getByLabel('Scope').selectOption('project');
  await previewInstall(page);

  const sheet = page.getByTestId('market-sheet');
  const secret = page.getByTestId('market-secret-WEATHER_API_KEY');
  await expect(secret).toBeVisible();
  await expect(page.getByTestId('market-config-path')).toHaveText(PROJECT_CONFIG);
  await expect(page.getByTestId('market-config-display')).toHaveText('.mcp.json');
  await expect(page.getByTestId('market-confirm-install')).toBeDisabled();
  await secret.fill('e2e-secret-value');
  await expect(page.getByTestId('market-confirm-install')).toBeEnabled();
  await expect(sheet.getByText('npx -y example-weather-mcp@1.0.0')).toBeVisible();
  await sheet.getByText('Cockpit will change configuration').scrollIntoViewIfNeeded();
  await shot(page, 'market-preview-diff.png');

  await page.getByTestId('market-confirm-install').click();
  await expect(
    sheet.getByRole('heading', { level: 3, name: `Installed ${MCP_NAME}` }),
  ).toBeVisible();

  const config = readFileSync(PROJECT_CONFIG, 'utf8');
  expect(config).toContain('example-weather');
  expect(config).toContain(SECRET_VALUE);
  expect(existsSync(path.join(USER_HOME, '.claude.json'))).toBe(false);
  for (const file of readdirSync(MANIFEST_DIR)) {
    expect(readFileSync(path.join(MANIFEST_DIR, file), 'utf8')).not.toContain(SECRET_VALUE);
  }

  await page.getByTestId('market-undo-result').click();
  await expect(page.getByTestId('market-sheet')).toHaveCount(0);
  await page.getByTestId('market-tab-installed').click();
  await expect(
    page.locator('[data-testid^="market-installed-"]').filter({ hasText: MCP_NAME }),
  ).toHaveCount(0);
  const after = existsSync(PROJECT_CONFIG) ? readFileSync(PROJECT_CONFIG, 'utf8') : '';
  expect(after).not.toContain('example-weather');
});

test('offline registry shows the cached banner and blocks refresh', async ({ page }) => {
  await openMarket(page, OFFLINE_DAEMON, { devOverride: false });
  await expect(page.getByTestId('market-offline')).toBeVisible();
  await expect(page.getByTestId('market-offline')).toContainText('Showing the cached registry');
  await expect(page.getByTestId('market-cache-age')).toContainText('Last verified 8 days ago');
  await expect(page.getByTestId('market-cache-stale')).toContainText(
    'New revocations may be missed',
  );
  await expect(page.getByRole('button', { name: 'Refresh registry' })).toBeDisabled();
  await shot(page, 'market-offline.png');
});
