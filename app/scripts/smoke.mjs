#!/usr/bin/env node
/**
 * Smoke-test the packaged Windows app.
 *
 * The app starts its embedded daemon on an ephemeral port and writes the
 * origin to `PANDU_SMOKE_ORIGIN`. This script waits for that file, checks
 * `/api/health`, checks the bundled UI files, and then closes the app. It uses
 * a throwaway data directory, so the developer database is never touched.
 *
 *   pnpm --dir app build
 *   node app/scripts/smoke.mjs
 *   node app/scripts/smoke.mjs --debug
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPath, readBrand, readJson, repoRoot } from './lib/brand.mjs';

const brand = readBrand();
const tauri = readJson('app/src-tauri/tauri.conf.json');
const args = new Set(process.argv.slice(2));
const debug = args.has('--debug');
const profile = debug ? 'debug' : 'release';
const exe = appPath(`src-tauri/target/${profile}/${tauri.productName}.exe`);
const report = { ok: false, checks: [], notes: [] };

function check(name, ok, detail = '') {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function finish() {
  report.ok = report.checks.every((entry) => entry.ok);
  const out = join(repoRoot, 'dist', 'smoke-report.json');
  mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n${report.ok ? 'smoke passed' : 'smoke failed'}; report: ${out}`);
  process.exit(report.ok ? 0 : 1);
}

if (process.platform !== 'win32') {
  console.error('The desktop smoke test is Windows-only.');
  process.exit(1);
}

if (!existsSync(exe)) {
  console.error(`Missing ${exe}. Build first: pnpm --dir app build`);
  process.exit(1);
}

// The bundle must contain the shell, the companion page, and the PWA manifest.
const dist = appPath('../ui/dist');
check('bundled index.html', existsSync(join(dist, 'index.html')));
check('bundled companion.html', existsSync(join(dist, 'companion.html')));
check('bundled manifest.webmanifest', existsSync(join(dist, 'manifest.webmanifest')));
if (existsSync(join(dist, 'manifest.webmanifest'))) {
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
  check('manifest name comes from brand.json', manifest.name === brand.name, manifest.name);
  check('manifest start_url is the app shell', manifest.start_url === '/', manifest.start_url);
}
if (existsSync(join(dist, 'index.html'))) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  check('index title comes from brand.json', html.includes(`<title>${brand.name}</title>`));
  check('no unsubstituted brand token', !html.includes('__BRAND_'));
}

const home = mkdtempSync(join(tmpdir(), `${brand.slug}-smoke-home-`));
const originFile = join(home, 'origin.json');
const logFile = join(home, 'app.log');
const env = {
  ...process.env,
  [`${brand.envPrefix}HOME`]: home,
  [`${brand.envPrefix}PORT`]: '0',
  [`${brand.envPrefix}SMOKE_ORIGIN`]: originFile,
  [`${brand.envPrefix}NOTIFICATIONS`]: 'false',
  [`${brand.envPrefix}LOG_WATCH`]: 'false',
  [`${brand.envPrefix}DEMO`]: 'false',
};

console.log(`starting ${exe}`);
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout?.on('data', (chunk) => {
  log += chunk.toString();
});
child.stderr?.on('data', (chunk) => {
  log += chunk.toString();
});

function stop() {
  if (child.exitCode !== null) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function waitForOrigin(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(originFile)) {
      try {
        return JSON.parse(readFileSync(originFile, 'utf8'));
      } catch {
        // The file is written in one call; retry if it is caught mid-write.
      }
    }
    if (child.exitCode !== null) return null;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

try {
  const boot = await waitForOrigin(30_000);
  if (!boot) {
    check('app started', false, `no origin file; exit=${child.exitCode}`);
    if (log) console.error(log.slice(-4_000));
    stop();
    writeFileSync(logFile, log, 'utf8');
    finish();
  }
  check('app started', true, `${boot.origin}${boot.attached ? ' (attached)' : ''}`);

  const health = await fetch(`${boot.origin}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await health.json();
  check('daemon health', health.ok && body.ok === true, body.version ?? '');
  check('smoke uses its own data directory', body.dataDir === home, body.dataDir ?? '');
  check('health reports a database', body.database === 'ok');

  const page = await fetch(`${boot.origin}/`, { signal: AbortSignal.timeout(5_000) });
  const html = await page.text();
  check('daemon serves the dashboard route', page.ok && html.includes('<!doctype html>'));
  check('dashboard is branded', html.toLowerCase().includes(brand.name.toLowerCase()));

  if (args.has('--android')) {
    const adb = spawnSync('adb', ['devices'], { encoding: 'utf8' });
    const devices = adb.status === 0 ? adb.stdout.split(/\r?\n/).filter((line) => /\tdevice$/.test(line)) : [];
    if (devices.length === 0) {
      report.notes.push('Android smoke skipped: no emulator or device is connected.');
      console.log('skip  Android smoke (no device)');
    } else {
      const packages = spawnSync('adb', ['shell', 'pm', 'list', 'packages', brand.androidPackage], {
        encoding: 'utf8',
      });
      check(
        'Android companion installed',
        packages.status === 0 && packages.stdout.includes(brand.androidPackage),
      );
    }
  }
} catch (error) {
  check('smoke run', false, String(error));
} finally {
  stop();
  writeFileSync(logFile, log, 'utf8');
  // Keep the temporary home for diagnosis, but make its location obvious.
  report.notes.push(`temporary home: ${home}`);
  if (log.trim()) report.notes.push(`app log: ${logFile}`);
  try {
    if (existsSync(logFile) && log.trim() === '') rmSync(logFile, { force: true });
  } catch {
    // Best effort.
  }
}

finish();
