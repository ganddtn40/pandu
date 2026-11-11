#!/usr/bin/env node
/**
 * Measure the packaged app against the Phase 11 resource budgets.
 *
 *   node app/scripts/resources.mjs
 *   node app/scripts/resources.mjs --skip-run
 *
 * Windows only for the live measurement; artifact sizes work everywhere.
 * The core process (the Rust executable that hosts the daemon) is measured
 * separately from the WebView2 children, because the documented idle-RAM
 * budget applies to the recorder, not to Chromium.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { appPath, readBrand, readJson, repoRoot } from './lib/brand.mjs';

const brand = readBrand();
const tauri = readJson('app/src-tauri/tauri.conf.json');
const args = new Set(process.argv.slice(2));
const skipRun = args.has('--skip-run');
const secondsIndex = process.argv.indexOf('--seconds');
const sampleSeconds = secondsIndex >= 0 ? Number(process.argv[secondsIndex + 1]) : 10;
const budgets = {
  cliMb: 12,
  coreIdleRamMb: 40,
  daemonReadyMs: 300,
  apkMb: 15,
};
const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  budgets,
  sizes: {},
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
const cli = join(repoRoot, 'target/release', process.platform === 'win32' ? 'pandu.exe' : 'pandu');
if (existsSync(cli)) {
  report.sizes['pandu-cli'] = {
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
  return { rss, cpu };
}

function waitForOrigin(path, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        try {
          resolve({ boot: JSON.parse(readFileSync(path, 'utf8')), elapsedMs: Date.now() - started });
        } catch {
          resolve({ boot: null, elapsedMs: Date.now() - started });
        }
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve({ boot: null, elapsedMs: Date.now() - started });
      }
    }, 50);
  });
}

if (!skipRun) {
  if (process.platform !== 'win32') {
    report.notes.push('Live RAM/CPU measurement skipped: Windows only.');
  } else {
    const exe = appPath(`src-tauri/target/release/${tauri.productName}.exe`);
    if (!existsSync(exe)) {
      report.notes.push(`Live measurement skipped: ${exe} does not exist.`);
    } else {
      const home = mkdtempSync(join(tmpdir(), `${brand.slug}-resources-`));
      const originFile = join(home, 'origin.json');
      const env = {
        ...process.env,
        [`${brand.envPrefix}HOME`]: home,
        [`${brand.envPrefix}PORT`]: '0',
        [`${brand.envPrefix}SMOKE_ORIGIN`]: originFile,
        [`${brand.envPrefix}NOTIFICATIONS`]: 'false',
        [`${brand.envPrefix}LOG_WATCH`]: 'false',
      };
      const child = spawn(exe, [], { env, stdio: 'ignore' });
      try {
        const { boot, elapsedMs } = await waitForOrigin(originFile, 30_000);
        if (!boot) {
          report.notes.push('Live measurement failed: the app never wrote its origin.');
        } else {
          // Let the window and WebView2 settle before the first sample.
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          const first = treeStats(processSnapshot(child.pid));
          const firstAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, sampleSeconds * 1_000));
          const secondTree = processSnapshot(child.pid);
          const second = treeStats(secondTree);
          const elapsed = (Date.now() - firstAt) / 1_000;
          const core = secondTree.find((entry) => entry.ProcessId === child.pid);
          const webview = secondTree.filter((entry) => entry.Name?.toLowerCase() === 'msedgewebview2.exe');
          const coreRss = Number(core?.WorkingSetSize ?? 0);
          const webviewRss = webview.reduce((sum, entry) => sum + Number(entry.WorkingSetSize ?? 0), 0);
          report.runtime = {
            origin: boot.origin,
            startupMs: elapsedMs,
            sampleSeconds: elapsed,
            coreRssMb: Number((coreRss / 1024 / 1024).toFixed(1)),
            webviewRssMb: Number((webviewRss / 1024 / 1024).toFixed(1)),
            totalRssMb: Number((second.rss / 1024 / 1024).toFixed(1)),
            idleCpuPercentOneCore: Number((((second.cpu - first.cpu) / 10_000_000 / elapsed) * 100).toFixed(2)),
            processes: secondTree.length,
            temporaryHome: home,
          };
        }
      } finally {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
  }
}

const apkSizes = Object.entries(report.sizes).filter(([name]) => name.endsWith('.apk'));
report.checks = [
  {
    name: 'CLI binary',
    budget: `< ${budgets.cliMb} MB`,
    actual: report.sizes['pandu-cli'] ? `${report.sizes['pandu-cli'].mb} MB` : 'not built',
    pass: report.sizes['pandu-cli'] ? report.sizes['pandu-cli'].mb < budgets.cliMb : null,
  },
  {
    name: 'core idle RAM',
    budget: `< ${budgets.coreIdleRamMb} MB`,
    actual: report.runtime ? `${report.runtime.coreRssMb} MB` : 'not measured',
    pass: report.runtime ? report.runtime.coreRssMb < budgets.coreIdleRamMb : null,
  },
  {
    name: 'daemon ready',
    budget: `< ${budgets.daemonReadyMs} ms`,
    actual: report.runtime ? `${report.runtime.startupMs} ms` : 'not measured',
    pass: report.runtime ? report.runtime.startupMs < budgets.daemonReadyMs : null,
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
  '## Runtime',
  '',
  '| Metric | Value |',
  '| --- | --- |',
];
if (report.runtime) {
  lines.push(
    `| Core idle RAM | ${report.runtime.coreRssMb} MB |`,
    `| WebView2 RAM | ${report.runtime.webviewRssMb} MB |`,
    `| Total process tree RAM | ${report.runtime.totalRssMb} MB |`,
    `| Idle CPU (one core) | ${report.runtime.idleCpuPercentOneCore}% |`,
    `| Daemon ready | ${report.runtime.startupMs} ms |`,
    `| Processes | ${report.runtime.processes} |`,
  );
} else {
  lines.push('| Runtime | not measured |');
}
lines.push(
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
