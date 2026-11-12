#!/usr/bin/env node
/**
 * Verify that uninstalling Pandu leaves no machine-wide residue.
 *
 *   node app/scripts/uninstall-check.mjs --phase before --expect-installed
 *   node app/scripts/uninstall-check.mjs --phase after --baseline dist/uninstall-baseline.json
 *   node app/scripts/uninstall-check.mjs --phase after --json
 *
 * The check looks for the protocol handler, Start Menu entries, scheduled
 * tasks, services, autostart values, uninstall registry entries, and install
 * directories. It also records whether the user data directory survived.
 *
 * `--phase before` writes a baseline. `--phase after` compares against that
 * baseline and fails if anything that existed before the uninstall still
 * exists, or if a new Pandu-named item appeared. User data is expected to
 * remain; pass `--allow-data-deleted` when the uninstaller was explicitly told
 * to delete it.
 *
 * Windows only. The script never deletes anything; it only reads.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readBrand, repoRoot } from './lib/brand.mjs';

const brand = readBrand();
const args = process.argv.slice(2);
const phaseIndex = args.indexOf('--phase');
const phase = phaseIndex >= 0 ? args[phaseIndex + 1] : 'after';
const baselineIndex = args.indexOf('--baseline');
const baselinePath =
  baselineIndex >= 0
    ? baselineIndex + 1 < args.length
      ? args[baselineIndex + 1]
      : null
    : join(repoRoot, 'dist', 'uninstall-baseline.json');
const asJson = args.includes('--json');
const expectInstalled = args.includes('--expect-installed');
const allowDataDeleted = args.includes('--allow-data-deleted');

if (phase !== 'before' && phase !== 'after') {
  console.error('Use --phase before or --phase after.');
  process.exit(2);
}

if (process.platform !== 'win32') {
  console.error('The uninstall check reads Windows registry, Start Menu, tasks, and services.');
  process.exit(2);
}

const dataDir = join(process.env.USERPROFILE ?? '', brand.dataDir);
const product = brand.name;

const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$product = ${JSON.stringify(product)}
$scheme = ${JSON.stringify(brand.urlScheme)}
$dataDir = ${JSON.stringify(dataDir)}

function RegistryPathExists($path) {
  return Test-Path -LiteralPath $path
}

function Get-RegistryValues($path, $pattern) {
  $item = Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue
  if (-not $item) { return @() }
  $matches = @()
  foreach ($property in $item.PSObject.Properties) {
    if ($property.Name -like 'PS*') { continue }
    if ($property.Name -match $pattern -or [string]$property.Value -match $pattern) {
      $matches += [ordered]@{ name = $property.Name; value = [string]$property.Value }
    }
  }
  return $matches
}

$protocol = @()
foreach ($root in @('HKCU:\Software\Classes', 'HKLM:\Software\Classes')) {
  $key = Join-Path $root $scheme
  if (RegistryPathExists $key) {
    $protocol += [ordered]@{
      key = $key
      urlProtocol = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).'URL Protocol'
      command = (Get-ItemProperty -LiteralPath (Join-Path $key 'shell\open\command') -ErrorAction SilentlyContinue).'(default)'
    }
  }
}

$startMenu = @()
foreach ($root in @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
)) {
  if (-not $root) { continue }
  Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $product } |
    ForEach-Object { $startMenu += $_.FullName }
}

$desktop = @()
foreach ($root in @(
  (Join-Path $env:USERPROFILE 'Desktop'),
  (Join-Path $env:PUBLIC 'Desktop')
)) {
  if (-not $root) { continue }
  Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $product } |
    ForEach-Object { $desktop += $_.FullName }
}

$tasks = @()
Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -match $product -or $_.TaskPath -match $product } |
  ForEach-Object { $tasks += [ordered]@{ name = $_.TaskName; path = $_.TaskPath; state = [string]$_.State } }

$services = @()
Get-Service -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match $product -or $_.DisplayName -match $product } |
  ForEach-Object { $services += [ordered]@{ name = $_.Name; displayName = $_.DisplayName; status = [string]$_.Status } }

$runKeys = @()
foreach ($root in @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
)) {
  $runKeys += Get-RegistryValues $root $product
}

$uninstallEntries = @()
foreach ($root in @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)) {
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    $item = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($item.DisplayName -match $product -or $item.Publisher -match $product) {
      $uninstallEntries += [ordered]@{
        key = $_.PSChildName
        displayName = [string]$item.DisplayName
        installLocation = [string]$item.InstallLocation
      }
    }
  }
}

$installDirs = @()
foreach ($candidate in @(
  (Join-Path $env:LOCALAPPDATA $product),
  (Join-Path $env:ProgramFiles $product),
  (Join-Path \${env:ProgramFiles(x86)} $product)
)) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { $installDirs += $candidate }
}

# The installer remembers its install location under Software\<publisher>\<product>.
$vendorKeys = @()
foreach ($root in @(
  'HKCU:\Software',
  'HKLM:\Software',
  'HKLM:\Software\WOW6432Node'
)) {
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match $product } |
    ForEach-Object { $vendorKeys += $_.Name }
}

[ordered]@{
  product = $product
  dataDir = $dataDir
  dataDirExists = Test-Path -LiteralPath $dataDir
  protocol = $protocol
  startMenu = $startMenu
  desktop = $desktop
  tasks = $tasks
  services = $services
  runKeys = $runKeys
  uninstallEntries = $uninstallEntries
  installDirs = $installDirs
  vendorKeys = $vendorKeys
} | ConvertTo-Json -Depth 6 -Compress
`;

function collect() {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || 'PowerShell failed');
  }
  return JSON.parse(result.stdout.trim());
}

function items(state) {
  return [
    ...state.protocol.map((entry) => ({ kind: 'protocol handler', key: entry.key })),
    ...state.startMenu.map((entry) => ({ kind: 'Start Menu entry', key: entry })),
    ...state.desktop.map((entry) => ({ kind: 'desktop shortcut', key: entry })),
    ...state.tasks.map((entry) => ({ kind: 'scheduled task', key: `${entry.path}${entry.name}` })),
    ...state.services.map((entry) => ({ kind: 'service', key: entry.name })),
    ...state.runKeys.map((entry) => ({ kind: 'autostart value', key: entry.name })),
    ...state.uninstallEntries.map((entry) => ({
      kind: 'uninstall entry',
      key: entry.displayName || entry.key,
    })),
    ...state.installDirs.map((entry) => ({ kind: 'install directory', key: entry })),
    ...state.vendorKeys.map((entry) => ({ kind: 'vendor registry key', key: entry })),
  ];
}

const state = collect();
const current = items(state);

if (phase === 'before') {
  const baseline = {
    generatedAt: new Date().toISOString(),
    product,
    dataDir,
    dataDirExists: state.dataDirExists,
    items: current,
    raw: state,
  };
  mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');

  if (expectInstalled && current.length === 0) {
    console.error(`No ${product} installation artifacts were found to baseline.`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(baseline, null, 2));
  } else {
    console.log(`${product} uninstall baseline`);
    console.log(`  data directory: ${dataDir} (${state.dataDirExists ? 'present' : 'absent'})`);
    console.log(`  installation artifacts: ${current.length}`);
    for (const entry of current) console.log(`    - ${entry.kind}: ${entry.key}`);
    console.log(`  wrote ${baselinePath}`);
  }
  process.exit(0);
}

let baseline = null;
if (baselinePath && existsSync(baselinePath)) {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
}

const before = new Set((baseline?.items ?? []).map((entry) => `${entry.kind}\u0000${entry.key}`));
// Anything present now is a leftover: either it survived the uninstall or it
// appeared during it. The baseline only tells us what to expect to disappear.
const survived = baseline
  ? current.filter((entry) => before.has(`${entry.kind}\u0000${entry.key}`))
  : current;
const appeared = baseline
  ? current.filter((entry) => !before.has(`${entry.kind}\u0000${entry.key}`))
  : [];

const dataRemains = state.dataDirExists;
const dataOk = allowDataDeleted ? true : dataRemains;
const pass = survived.length === 0 && appeared.length === 0 && dataOk;

const report = {
  generatedAt: new Date().toISOString(),
  phase,
  product,
  baseline: baselinePath && existsSync(baselinePath) ? baselinePath : null,
  dataDir,
  dataDirExists: dataRemains,
  dataExpected: allowDataDeleted ? 'deleted' : 'present',
  survived,
  appeared,
  pass,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${product} uninstall check (${phase})`);
  console.log(`  data directory: ${dataDir} (${dataRemains ? 'present' : 'absent'})`);
  console.log(`  expected data: ${report.dataExpected}`);
  if (survived.length > 0) {
    console.log('  leftover installation artifacts:');
    for (const entry of survived) console.log(`    - ${entry.kind}: ${entry.key}`);
  }
  if (appeared.length > 0) {
    console.log('  new installation artifacts (not in the baseline):');
    for (const entry of appeared) console.log(`    - ${entry.kind}: ${entry.key}`);
  }
  if (survived.length === 0 && appeared.length === 0) {
    console.log('  no protocol handler, Start Menu or desktop shortcut, task, service, autostart, uninstall entry, install directory, or vendor registry key remains');
  }
  console.log(`  result: ${pass ? 'PASS' : 'FAIL'}`);
}

process.exit(pass ? 0 : 1);
