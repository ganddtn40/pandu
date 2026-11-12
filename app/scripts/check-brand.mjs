#!/usr/bin/env node
/**
 * Fail when a name, id, or URL in the Tauri shell drifts from `brand.json`.
 *
 * Run from anywhere: `node app/scripts/check-brand.mjs`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  appDir,
  exists,
  readBrand,
  readJson,
  readText,
  repoRoot,
  tomlValue,
} from './lib/brand.mjs';

const brand = readBrand();
const failures = [];

function check(label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function checkTruthy(label, value) {
  if (!value) failures.push(`${label}: missing or false`);
}

function walk(directory, suffix) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, suffix));
    else if (path.endsWith(suffix)) out.push(path);
  }
  return out;
}

const slug = brand.slug;
const androidPackage = brand.androidPackage;
const keystorePackage = `${androidPackage}.keystore`;

// package.json -----------------------------------------------------------------
const pkg = readJson('app/package.json');
check('app/package.json name', pkg.name, `@${slug}/app`);
check('app/package.json description', pkg.description, `${brand.name} desktop and Android shell.`);
check('app/package.json icons script', pkg.scripts?.icons, 'tauri icon ../design/logo/icon-manifest.json');
for (const script of ['check:brand', 'sync:brand', 'android:init', 'android:build', 'build:portable', 'checksums', 'smoke', 'resources']) {
  checkTruthy(`app/package.json scripts.${script}`, pkg.scripts?.[script]);
}

// tauri.conf.json --------------------------------------------------------------
const tauri = readJson('app/src-tauri/tauri.conf.json');
check('tauri productName', tauri.productName, brand.name);
check('tauri identifier', tauri.identifier, brand.appId);
check('tauri shortDescription', tauri.bundle?.shortDescription, brand.tagline);
check(
  'tauri longDescription',
  tauri.bundle?.longDescription,
  `${brand.name} records what AI coding agents do, shows it live, replays it, and asks permission before risky actions. Everything stays on your machine. Zero telemetry.`,
);
check('tauri publisher', tauri.bundle?.publisher, `${brand.name} contributors`);
check('tauri deep-link scheme', tauri.plugins?.['deep-link']?.desktop?.schemes?.[0], brand.urlScheme);
check('tauri NSIS installMode', tauri.bundle?.windows?.nsis?.installMode, 'currentUser');
check('tauri webview install mode', tauri.bundle?.windows?.webviewInstallMode?.type, 'downloadBootstrapper');
checkTruthy('tauri CSP', tauri.app?.security?.csp);
checkTruthy('tauri NSIS uninstall hook', tauri.bundle?.windows?.nsis?.installerHooks);

// tauri.android.conf.json ------------------------------------------------------
const android = readJson('app/src-tauri/tauri.android.conf.json');
check('android window title', android.app?.windows?.[0]?.title, brand.name);
check('android window url', android.app?.windows?.[0]?.url, 'companion.html');

// Cargo.toml -------------------------------------------------------------------
const cargo = readText('app/src-tauri/Cargo.toml');
check('Cargo package name', tomlValue(cargo, 'package', 'name'), `${slug}-app`);
check('Cargo repository', tomlValue(cargo, 'package', 'repository'), brand.repository);
check('Cargo description', tomlValue(cargo, 'package', 'description'), `${brand.name} desktop and Android shell`);
check('Cargo lib name', tomlValue(cargo, 'lib', 'name'), `${slug.replace(/-/g, '_')}_app_lib`);
check('Cargo bin name', tomlValue(cargo, 'bin', 'name'), brand.name);
checkTruthy('Cargo bin path', tomlValue(cargo, 'bin', 'path'));

const mainRs = readText('app/src-tauri/src/main.rs');
checkTruthy(
  'main.rs calls the generated lib name',
  mainRs.includes(`${slug.replace(/-/g, '_')}_app_lib::run()`),
);

// Keystore plugin --------------------------------------------------------------
const pluginCargo = readText('app/plugins/keystore/Cargo.toml');
check('plugin Cargo package', tomlValue(pluginCargo, 'package', 'name'), `${slug}-plugin-keystore`);
check('plugin Cargo lib', tomlValue(pluginCargo, 'lib', 'name'), `${slug.replace(/-/g, '_')}_plugin_keystore`);

const gradle = readText('app/plugins/keystore/android/build.gradle.kts');
checkTruthy(
  'plugin Gradle namespace',
  gradle.includes(`namespace = "${keystorePackage}"`),
);

const kotlinDir = join(repoRoot, 'app/plugins/keystore/android/src/main/java');
const kotlinFiles = existsSync(kotlinDir) ? walk(kotlinDir, '.kt') : [];
checkTruthy('plugin Kotlin sources', kotlinFiles.length > 0);
for (const file of kotlinFiles) {
  const first = readText(file.slice(repoRoot.length + 1).replaceAll('\\', '/')).split(/\r?\n/, 1)[0];
  check(`Kotlin package in ${file.slice(repoRoot.length + 1)}`, first, `package ${keystorePackage}`);
}

const pluginLib = readText('app/plugins/keystore/src/lib.rs');
checkTruthy(
  'plugin registers the Android class',
  pluginLib.includes('PANDU_BRAND_ANDROID_PACKAGE') && pluginLib.includes('"KeystorePlugin"'),
);
const pluginBuild = readText('app/plugins/keystore/build.rs');
checkTruthy(
  'plugin build script reads brand.json',
  pluginBuild.includes('brand.json') && pluginBuild.includes('androidPackage'),
);

// packaging/manifest.json ------------------------------------------------------
const manifest = readJson('packaging/manifest.json');
check('packaging product', manifest.product, brand.name);
check('packaging slug', manifest.slug, slug);
check('packaging description', manifest.description, brand.tagline);
check('packaging repository', manifest.repository, brand.repository);
check('packaging binary', manifest.binary, brand.cli.command);
check('packaging dataDir', manifest.dataDir, brand.dataDir);
check('packaging database', manifest.database, brand.databaseFile);
check('packaging envPrefix', manifest.envPrefix, brand.envPrefix);
check('packaging urlScheme', manifest.urlScheme, brand.urlScheme);
check('packaging android package', manifest.artifacts?.android?.package, androidPackage);
check(
  'packaging android archive',
  manifest.artifacts?.android?.archive,
  `${slug}-${tauri.version}-android-universal-release-signed.apk`,
);

// Icons and PWA assets ---------------------------------------------------------
for (const icon of [
  'app/src-tauri/icons/icon.ico',
  'app/src-tauri/icons/icon.icns',
  'app/src-tauri/icons/32x32.png',
  'app/src-tauri/icons/128x128.png',
  'app/src-tauri/icons/128x128@2x.png',
  'app/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png',
  'app/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_foreground.png',
  'app/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_monochrome.png',
  'app/src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml',
]) {
  checkTruthy(icon, exists(icon));
}
for (const icon of [
  'ui/public/icons/icon-192.png',
  'ui/public/icons/icon-512.png',
  'ui/public/icons/icon-maskable-512.png',
]) {
  checkTruthy(icon, exists(icon));
}

// UI manifest ------------------------------------------------------------------
const vite = readText('ui/vite.config.ts');
checkTruthy('Vite manifest is generated from brand.json', vite.includes("from '../brand.json'"));
checkTruthy('Vite emits manifest.webmanifest', vite.includes("fileName: 'manifest.webmanifest'"));

if (failures.length > 0) {
  console.error(`brand drift in ${appDir}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`brand check passed for ${brand.name} (${androidPackage}).`);
