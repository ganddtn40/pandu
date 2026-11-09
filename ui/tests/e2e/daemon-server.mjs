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
  process.platform === 'win32' ? 'cockpit.exe' : 'cockpit',
);

if (!existsSync(binary)) {
  console.error(`Missing daemon binary at ${binary}. Run cargo build -p cockpit-cli first.`);
  process.exit(1);
}

const home = path.join(root, 'ui', '.tmp', `e2e-${mode}-${port}`);
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const isMarket = mode === 'market' || mode === 'market-offline';
const userHome = path.join(home, 'user');
const workspace = path.join(home, 'workspace');
if (isMarket) {
  mkdirSync(userHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
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
    COCKPIT_HOME: home,
    COCKPIT_HOST: '127.0.0.1',
    COCKPIT_PORT: port,
    COCKPIT_LOG_WATCH: '0',
    COCKPIT_NOTIFICATIONS: '0',
    COCKPIT_DEMO: mode === 'demo' ? '1' : '0',
    ...(isMarket
      ? {
          // Debug-only overrides: the market daemon reads its registry from the
          // repository and installs into a disposable home, never the real one.
          // Offline mode loads the pre-populated cache instead, so cache age is
          // part of the fixture rather than an environment-registry shortcut.
          COCKPIT_USER_HOME: userHome,
          COCKPIT_WORKSPACE: workspace,
          ...(mode === 'market-offline'
            ? {}
            : { COCKPIT_MARKET_REGISTRY: path.join(root, 'registry') }),
          COCKPIT_MARKET_LOCAL_SOURCE: path.join(root, 'registry', 'fixtures'),
          COCKPIT_MARKET_OFFLINE: mode === 'market-offline' ? '1' : '0',
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
