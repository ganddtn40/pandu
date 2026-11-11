#!/usr/bin/env node
/**
 * Build a portable Windows zip: the single executable plus a short README.
 *
 * The executable already embeds the daemon and the UI. WebView2 is the only
 * external runtime and ships with Windows 10/11; the installer bootstrapper
 * covers older machines, while the portable build documents the requirement.
 *
 *   node app/scripts/portable.mjs
 *   node app/scripts/portable.mjs --skip-build
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDir, appPath, readBrand, readJson, repoRoot } from './lib/brand.mjs';

const brand = readBrand();
const tauri = readJson('app/src-tauri/tauri.conf.json');
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');

if (process.platform !== 'win32') {
  console.error('The portable build is Windows-only. Run it on Windows or in the Windows CI job.');
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: appDir,
    stdio: 'inherit',
    shell: options.shell ?? true,
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`\n${command} ${commandArgs.join(' ')} failed.`);
    process.exit(result.status ?? 1);
  }
}

if (!skipBuild) {
  run('pnpm', ['exec', 'tauri', 'build', '--no-bundle']);
}

const version = tauri.version ?? '0.0.0';
const exe = appPath(`src-tauri/target/release/${tauri.productName}.exe`);
if (!existsSync(exe)) {
  console.error(`Missing ${exe}. Build first with: pnpm --dir app build`);
  process.exit(1);
}

const staging = join(repoRoot, 'dist/portable', `${brand.slug}-${version}-windows-x86_64`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
copyFileSync(exe, join(staging, `${tauri.productName}.exe`));

const license = join(repoRoot, 'LICENSE');
if (existsSync(license)) copyFileSync(license, join(staging, 'LICENSE'));

writeFileSync(
  join(staging, 'README.txt'),
  `${brand.name} ${version} - portable Windows build
${brand.tagline}

Run ${tauri.productName}.exe. No installer and no administrator rights are
required. ${brand.name} keeps its database and settings in:

  %USERPROFILE%\\${brand.dataDir}

Closing the window keeps ${brand.name} running in the notification area so it
can keep recording. Quit from the tray menu before moving or deleting the
executable.

Requirements
  - Windows 10 or 11, 64-bit.
  - Microsoft Edge WebView2 Runtime. It is included with current Windows
    releases. If the app does not start, install the Evergreen Runtime from
    https://developer.microsoft.com/microsoft-edge/webview2/

Uninstall
  Quit from the tray, delete this folder, then delete %USERPROFILE%\\${brand.dataDir}
  only if you also want to remove your flights, settings, and paired devices.
  The uninstaller never deletes that folder for you.

SmartScreen
  This build is not code-signed unless the release notes say so. Windows may
  show "Windows protected your PC"; choose "More info" then "Run anyway" only
  if you downloaded the file from the official release page and its SHA-256
  matches SHA256SUMS.
`,
  'utf8',
);

const zip = join(repoRoot, 'dist', `${brand.slug}-${version}-x86_64-pc-windows-msvc-portable.zip`);
rmSync(zip, { force: true });
run('powershell', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path '${join(staging, '*')}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`,
], { shell: false });

console.log(`\nportable build: ${zip}`);
