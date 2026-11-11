import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Playwright starts one daemon per mode so the UI tests never depend on a
 * developer's local database. The home directory is rebuilt on every run,
 * which also resets the pending demo approval.
 */
const [mode = 'demo', port = '4321'] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const binary = path.join(
  root,
  'target',
  'debug',
  process.platform === 'win32' ? 'pandu.exe' : 'pandu',
);

if (!existsSync(binary)) {
  console.error(`Missing daemon binary at ${binary}. Run cargo build -p pandu-cli first.`);
  process.exit(1);
}

const home = path.join(root, 'ui', '.tmp', `e2e-${mode}-${port}`);
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const isMarket =
  mode === 'market' || mode === 'market-offline' || mode === 'market-state';
const isUpdate = mode === 'update';
const isMigrate = mode === 'migrate';
const userHome = path.join(home, 'user');
const workspace = path.join(home, 'workspace');
if (isMarket) {
  mkdirSync(userHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
}

if (isMigrate) {
  // Start from the last released schema so the daemon migrates on open and
  // the UI can show the one-time backup notice.
  cpSync(
    path.join(root, 'crates', 'pandu-daemon', 'tests', 'fixtures', 'schema', 'v4.db'),
    path.join(home, 'pandu.db'),
  );
}

if (mode === 'market-offline') {
  // Build a verified cache with a known age so the UI can prove that it shows
  // cache age and warns when revocations could be stale.
  const cache = path.join(home, 'market', 'registry');
  mkdirSync(path.dirname(cache), { recursive: true });
  cpSync(path.join(root, 'registry'), cache, { recursive: true });
  writeFileSync(
    path.join(home, 'market', 'settings.json'),
    JSON.stringify({
      autoRefresh: false,
      lastRefresh: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  );
}

const child = spawn(binary, ['serve'], {
  cwd: root,
  env: {
    ...process.env,
    // The update and migration fixtures use a repository-relative home so the
    // committed screenshots do not contain a developer's absolute user path.
    PANDU_HOME: isUpdate || isMigrate ? path.relative(root, home) : home,
    PANDU_HOST: '127.0.0.1',
    PANDU_PORT: port,
    PANDU_LOG_WATCH: '0',
    PANDU_NOTIFICATIONS: '0',
    PANDU_DEMO: mode === 'demo' || isUpdate || isMigrate ? '1' : '0',
    ...(isUpdate
      ? {
          // Debug-only override: read a fixed release document instead of
          // calling GitHub, so the screenshot test is deterministic and offline.
          PANDU_UPDATE_FIXTURE: path.join(
            root,
            'ui',
            'tests',
            'e2e',
            'fixtures',
            'update-release.json',
          ),
        }
      : {}),
    ...(isMarket
      ? {
          // Debug-only overrides: the market daemon reads its registry from the
          // repository and installs into a disposable home, never the real one.
          // Offline mode loads the pre-populated cache instead, so cache age is
          // part of the fixture rather than an environment-registry shortcut.
          PANDU_USER_HOME: userHome,
          PANDU_WORKSPACE: workspace,
          ...(mode === 'market-offline'
            ? {}
            : { PANDU_MARKET_REGISTRY: path.join(root, 'registry') }),
          PANDU_MARKET_LOCAL_SOURCE: path.join(root, 'registry', 'fixtures'),
          PANDU_MARKET_OFFLINE: mode === 'market-offline' ? '1' : '0',
        }
      : {}),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

function stop() {
  if (!child.killed) child.kill();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', stop);

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
