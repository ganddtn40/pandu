#!/usr/bin/env node
/**
 * Measure the packaged app against the Phase 11 resource budgets.
 *
 *   node app/scripts/resources.mjs
 *   node app/scripts/resources.mjs --skip-run
 *   node app/scripts/resources.mjs --seconds 60
 *   node app/scripts/resources.mjs --scenario 500-flights-list
 *
 * Windows only for the live measurement; artifact sizes work everywhere.
 *
 * The report measures the whole process tree: the Rust executable that hosts
 * the daemon, every WebView2 child, and any other descendant. The core process
 * is also reported separately because the documented idle-RAM budget applies
 * to the recorder, not to Chromium.
 *
 * Two databases are used: an empty one and one seeded with 500 flights. Both
 * live in throwaway directories, so the developer database is never touched.
 * The 500-flight list scenario navigates the real UI to `/flights` after the
 * first interactive frame and waits for the rows before sampling.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { appPath, readBrand, readJson, repoRoot } from './lib/brand.mjs';

const brand = readBrand();
const tauri = readJson('app/src-tauri/tauri.conf.json');
const args = new Set(process.argv.slice(2));
const skipRun = args.has('--skip-run');
const secondsIndex = process.argv.indexOf('--seconds');
const sampleSeconds = secondsIndex >= 0 ? Number(process.argv[secondsIndex + 1]) : 60;
const scenarioIndex = process.argv.indexOf('--scenario');
const onlyScenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : null;
const budgets = {
  cliMb: 12,
  coreIdleRamMb: 40,
  daemonReadyMs: 300,
  apkMb: 15,
};
const scenarios = [
  { id: '0-flights-home', flights: 0, route: '/' },
  { id: '500-flights-home', flights: 500, route: '/' },
  { id: '500-flights-list', flights: 500, route: '/flights' },
].filter((scenario) => !onlyScenario || scenario.id === onlyScenario);

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  budgets,
  sizes: {},
  scenarios: [],
  runtime: null,
  notes: [],
};

function walk(directory) {
  if (!existsSync(directory)) return [];
  const out = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

for (const root of [
  join(repoRoot, 'dist'),
  appPath('src-tauri/target/release/bundle'),
]) {
  for (const file of walk(root)) {
    if (!/\.(msi|exe|zip|apk|msix|dmg|AppImage|deb)$/i.test(file)) continue;
    const key = basename(file);
    report.sizes[key] = {
      bytes: statSync(file).size,
      mb: Number((statSync(file).size / 1024 / 1024).toFixed(2)),
    };
  }
}

// The CLI is built by cargo-dist, not by the Tauri bundle step, so measure it
// from the root release profile when it exists.
const cliName = process.platform === 'win32' ? `${brand.cli.command}.exe` : brand.cli.command;
const cliKey = `${brand.slug}-cli`;
const cli = join(repoRoot, 'target/release', cliName);
if (existsSync(cli)) {
  report.sizes[cliKey] = {
    bytes: statSync(cli).size,
    mb: Number((statSync(cli).size / 1024 / 1024).toFixed(2)),
  };
}

function powershell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'powershell failed');
  return result.stdout.trim();
}

function processSnapshot(rootPid) {
  const raw = powershell(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress',
  );
  const parsed = JSON.parse(raw);
  const all = Array.isArray(parsed) ? parsed : [parsed];
  const byParent = new Map();
  for (const process of all) {
    const parent = process.ParentProcessId ?? 0;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(process);
  }
  const tree = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    const process = all.find((entry) => entry.ProcessId === pid);
    if (!process) continue;
    tree.push(process);
    for (const child of byParent.get(pid) ?? []) queue.push(child.ProcessId);
  }
  return tree;
}

function treeStats(tree) {
  let rss = 0;
  let cpu = 0;
  for (const process of tree) {
    rss += Number(process.WorkingSetSize ?? 0);
    cpu += Number(process.UserModeTime ?? 0) + Number(process.KernelModeTime ?? 0);
  }
  const core = tree.find((process) => process.ProcessId === tree[0]?.ProcessId);
  const webview = tree.filter(
    (process) => process.Name?.toLowerCase() === 'msedgewebview2.exe',
  );
  return {
    rss,
    cpu,
    coreRss: Number(core?.WorkingSetSize ?? 0),
    webviewRss: webview.reduce((sum, process) => sum + Number(process.WorkingSetSize ?? 0), 0),
    processes: tree.length,
  };
}

function waitForFile(path, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        try {
          resolve({ value: JSON.parse(readFileSync(path, 'utf8')), elapsedMs: Date.now() - started });
        } catch {
          resolve({ value: null, elapsedMs: Date.now() - started });
        }
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve({ value: null, elapsedMs: Date.now() - started });
      }
    }, 50);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // The daemon is still binding.
    }
    await sleep(100);
  }
  return false;
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function initializeDatabase(home) {
  if (!existsSync(cli)) return false;
  const port = await freePort();
  const child = spawn(cli, ['serve', '--home', home, '--port', String(port)], {
    stdio: 'ignore',
  });
  try {
    const healthy = await waitForHttp(`http://127.0.0.1:${port}/api/health`, 20_000);
    return healthy;
  } finally {
    killTree(child.pid);
  }
}

async function seedFlights(home, count) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('node:sqlite is unavailable; use Node 22 or newer to seed the benchmark database.');
  }
  const database = join(home, brand.databaseFile);
  const db = new DatabaseSync(database);
  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      id, title, source, capture_mode, source_label, status, provider, model,
      agent_name, agent_version, workspace_path, started_at, ended_at, duration_ms,
      step_count, model_call_count, tool_call_count, input_tokens, output_tokens,
      total_cost_usd, tags, metadata
    ) VALUES (?, ?, 'proxy', 'proxy', 'Proxy', 'completed', 'openai', 'gpt-4.1',
      'Codex CLI', '0.46.0', ?, ?, ?, 42000, 1, 1, 0, 1200, 300, 0.01, '["benchmark"]',
      '{"benchmark":true}')
  `);
  const insertStep = db.prepare(`
    INSERT OR REPLACE INTO steps (
      id, session_id, seq, kind, status, provider, model, started_at, ended_at,
      duration_ms, input_tokens, output_tokens, cost_usd, cost_known, response_text
    ) VALUES (?, ?, 1, 'model', 'completed', 'openai', 'gpt-4.1', ?, ?, 42000, 1200, 300, 0.01, 1,
      'Benchmark flight.')
  `);
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (let index = 0; index < count; index += 1) {
      const id = `bench-${String(index).padStart(4, '0')}`;
      const started = new Date(now - index * 37 * 60 * 1000).toISOString();
      const ended = new Date(now - index * 37 * 60 * 1000 + 42_000).toISOString();
      insertSession.run(
        id,
        `Benchmark flight ${index + 1}`,
        `~/projects/benchmark-${index % 12}`,
        started,
        ended,
      );
      insertStep.run(`bench-step-${index}`, id, started, ended);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

async function waitForPageTarget(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          target.webSocketDebuggerUrl &&
          /127\.0\.0\.1|tauri\.localhost/.test(target.url ?? ''),
      );
      if (page) return page;
    } catch {
      // WebView2 has not opened the debugging endpoint yet.
    }
    await sleep(100);
  }
  return null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message ?? 'CDP error'));
      else resolve(message.result);
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), {
        once: true,
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

async function pollExpression(cdp, expression, timeoutMs, predicate = (value) => Boolean(value)) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await cdp.evaluate(expression);
      if (predicate(value)) return value;
    } catch {
      // The page may still be navigating.
    }
    await sleep(100);
  }
  return null;
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(1));
}

async function measureScenario({ id, flights, route, exe, seconds }) {
  const home = mkdtempSync(join(tmpdir(), `${brand.slug}-resources-`));
  if (flights > 0) {
    const initialized = await initializeDatabase(home);
    if (!initialized) {
      throw new Error('the CLI could not initialize the benchmark database');
    }
    await seedFlights(home, flights);
  }

  const originFile = join(home, 'origin.json');
  const cdpPort = await freePort();
  const env = {
    ...process.env,
    [`${brand.envPrefix}HOME`]: home,
    [`${brand.envPrefix}PORT`]: '0',
    [`${brand.envPrefix}SMOKE_ORIGIN`]: originFile,
    [`${brand.envPrefix}NOTIFICATIONS`]: 'false',
    [`${brand.envPrefix}LOG_WATCH`]: 'false',
    [`${brand.envPrefix}WEBVIEW_DEVTOOLS`]: '1',
    [`${brand.envPrefix}WEBVIEW_ARGS`]: `--remote-debugging-port=${cdpPort}`,
  };
  const spawnAt = Date.now();
  const child = spawn(exe, [], { env, stdio: 'ignore' });
  let cdp = null;
  try {
    const origin = await waitForFile(originFile, 30_000);
    if (!origin.value) {
      throw new Error('the app never wrote its daemon origin');
    }
    const daemonReadyMs = Date.now() - spawnAt;

    let timeToInteractiveMs = null;
    const page = await waitForPageTarget(cdpPort, 20_000);
    if (page) {
      cdp = await Cdp.connect(page.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      const readyAt = await pollExpression(
        cdp,
        'document.documentElement.dataset.appReadyAt || null',
        20_000,
      );
      if (readyAt) timeToInteractiveMs = Number(readyAt) - spawnAt;
      if (route !== '/') {
        // Use the app's own history router instead of a full navigation. A
        // custom-protocol navigation to /flights would ask the asset resolver
        // for a file that does not exist.
        await cdp.evaluate(
          `history.pushState({}, '', ${JSON.stringify(route)}); window.dispatchEvent(new PopStateEvent('popstate'));`,
        );
        const rows = await pollExpression(
          cdp,
          "document.querySelectorAll('.flight-row').length",
          20_000,
          (value) => Number(value) > 0,
        );
        if (!rows) throw new Error(`the UI did not render ${route}`);
      }
    } else {
      report.notes.push(
        `${id}: WebView2 did not expose the debugging endpoint; time to interactive is not measured.`,
      );
    }

    // Let the window and WebView2 settle before the first sample.
    await sleep(3_000);
    const samples = [];
    const samplingStarted = Date.now();
    while (Date.now() - samplingStarted < seconds * 1_000) {
      const tree = processSnapshot(child.pid);
      if (tree.length === 0) break;
      samples.push({ at: Date.now(), ...treeStats(tree) });
      await sleep(1_000);
    }
    if (samples.length < 2) {
      throw new Error('not enough process samples; the app may have exited');
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = (last.at - first.at) / 1_000;
    const cpuSeconds = (last.cpu - first.cpu) / 10_000_000;
    return {
      id,
      flights,
      route,
      daemonReadyMs,
      timeToInteractiveMs,
      sampleSeconds: Number(elapsed.toFixed(1)),
      samples: samples.length,
      avgTotalRssMb: mb(average(samples.map((sample) => sample.rss))),
      peakTotalRssMb: mb(Math.max(...samples.map((sample) => sample.rss))),
      avgCoreRssMb: mb(average(samples.map((sample) => sample.coreRss))),
      avgWebviewRssMb: mb(average(samples.map((sample) => sample.webviewRss))),
      avgIdleCpuPercentOneCore: Number(((cpuSeconds / elapsed) * 100).toFixed(2)),
      avgProcesses: Number(average(samples.map((sample) => sample.processes)).toFixed(1)),
      temporaryHome: home,
    };
  } finally {
    cdp?.close();
    killTree(child.pid);
  }
}

if (!skipRun) {
  if (process.platform !== 'win32') {
    report.notes.push('Live RAM/CPU measurement skipped: Windows only.');
  } else {
    const exe = appPath(`src-tauri/target/release/${tauri.productName}.exe`);
    if (!existsSync(exe)) {
      report.notes.push(`Live measurement skipped: ${exe} does not exist.`);
    } else {
      for (const scenario of scenarios) {
        try {
          const result = await measureScenario({
            ...scenario,
            exe,
            seconds: sampleSeconds,
          });
          report.scenarios.push(result);
          if (result.route === '/') report.runtime = result;
        } catch (error) {
          report.notes.push(`${scenario.id}: ${error.message}`);
        }
      }
    }
  }
}

const apkSizes = Object.entries(report.sizes).filter(([name]) => name.endsWith('.apk'));
report.checks = [
  {
    name: 'CLI binary',
    budget: `< ${budgets.cliMb} MB`,
    actual: report.sizes[cliKey] ? `${report.sizes[cliKey].mb} MB` : 'not built',
    pass: report.sizes[cliKey] ? report.sizes[cliKey].mb < budgets.cliMb : null,
  },
  {
    name: 'core idle RAM',
    budget: `< ${budgets.coreIdleRamMb} MB`,
    actual: report.runtime ? `${report.runtime.avgCoreRssMb} MB` : 'not measured',
    pass: report.runtime ? report.runtime.avgCoreRssMb < budgets.coreIdleRamMb : null,
  },
  {
    name: 'daemon ready',
    budget: `< ${budgets.daemonReadyMs} ms`,
    actual: report.runtime ? `${report.runtime.daemonReadyMs} ms` : 'not measured',
    pass: report.runtime ? report.runtime.daemonReadyMs < budgets.daemonReadyMs : null,
  },
  {
    name: 'Android APK',
    budget: `< ${budgets.apkMb} MB`,
    actual: apkSizes.length > 0 ? apkSizes.map(([, size]) => `${size.mb} MB`).join(', ') : 'not built',
    pass: apkSizes.length > 0 ? apkSizes.every(([, size]) => size.mb < budgets.apkMb) : null,
  },
];

const outJson = join(repoRoot, 'dist', 'resource-report.json');
const outMd = join(repoRoot, 'dist', 'resource-report.md');
mkdirSync(join(repoRoot, 'dist'), { recursive: true });
writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const lines = [
  `# ${brand.name} resource report`,
  '',
  `Generated ${report.generatedAt}.`,
  '',
  '## Artifacts',
  '',
  '| Artifact | Size |',
  '| --- | --- |',
  ...Object.entries(report.sizes).map(([name, size]) => `| \`${name}\` | ${size.mb} MB |`),
  '',
  '## Whole-app idle',
  '',
  '| Scenario | Flights | Route | Daemon ready | Time to interactive | Avg working set | Peak | Avg core | Avg WebView2 | Idle CPU | Samples |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
if (report.scenarios.length > 0) {
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.id} | ${scenario.flights} | \`${scenario.route}\` | ${scenario.daemonReadyMs} ms | ${scenario.timeToInteractiveMs ?? 'not measured'} ms | ${scenario.avgTotalRssMb} MB | ${scenario.peakTotalRssMb} MB | ${scenario.avgCoreRssMb} MB | ${scenario.avgWebviewRssMb} MB | ${scenario.avgIdleCpuPercentOneCore}% | ${scenario.samples} |`,
    );
  }
} else {
  lines.push('| not measured | | | | | | | | | | |');
}
lines.push(
  '',
  '## Method',
  '',
  `The live run samples once per second for ${sampleSeconds} seconds after a 3 second settle.`,
  'Working set is the sum of the app process and every descendant, including',
  '`msedgewebview2.exe`. CPU is the change in user plus kernel time over the',
  'sampling window divided by wall time, as a percentage of one core. Time to',
  'interactive is measured over the WebView2 debugging protocol from process',
  'spawn to the first interactive frame (`data-app-ready-at`, set after two',
  'animation frames). The 500-flight database is seeded into a throwaway SQLite',
  'file through the production schema; the developer database is never touched.',
  '',
  '## Budgets',
  '',
  '| Check | Budget | Actual | Result |',
  '| --- | --- | --- | --- |',
  ...report.checks.map(
    (entry) =>
      `| ${entry.name} | ${entry.budget} | ${entry.actual} | ${entry.pass === null ? 'not measured' : entry.pass ? 'pass' : 'FAIL'} |`,
  ),
  '',
  'The idle-RAM budget applies to the Rust process that hosts the recorder. WebView2',
  'is a separate Chromium process tree and is reported for honesty, not hidden.',
  '',
);
if (report.notes.length > 0) {
  lines.push('## Notes', '', ...report.notes.map((note) => `- ${note}`), '');
}
writeFileSync(outMd, `${lines.join('\n')}\n`, 'utf8');

console.log(lines.join('\n'));
console.log(`wrote ${outJson}`);
