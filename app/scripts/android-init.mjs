#!/usr/bin/env node
/**
 * Create the Tauri Android project, then apply the companion's hardening.
 *
 * Tauri generates `src-tauri/gen/android`; this script never edits the
 * generated files by hand outside the small, idempotent patches below. Run it
 * again after `tauri android init --force` to restore the patches.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appDir, appPath, readBrand } from './lib/brand.mjs';

const brand = readBrand();
const args = new Set(process.argv.slice(2));
const genDir = appPath('src-tauri/gen/android');
const manifestPath = join(genDir, 'app/src/main/AndroidManifest.xml');
const stringsPath = join(genDir, 'app/src/main/res/values/strings.xml');
const mainNetworkConfig = join(genDir, 'app/src/main/res/xml/network_security_config.xml');
const debugNetworkConfig = join(genDir, 'app/src/debug/res/xml/network_security_config.xml');
const gradlePath = join(genDir, 'app/build.gradle.kts');
const gradleGroovyPath = join(genDir, 'app/build.gradle');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: appDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    console.error(`\n${command} ${commandArgs.join(' ')} failed.`);
    printToolchainHelp();
    process.exit(result.status ?? 1);
  }
}

function printToolchainHelp() {
  console.error(`
Android builds need a JDK 17, the Android SDK, and the NDK:

  winget install EclipseAdoptium.Temurin.17.JDK
  winget install Google.AndroidStudio
  # In Android Studio: SDK Manager -> install Android SDK Platform 36 and NDK 27

Then set, in the same shell:

  $env:JAVA_HOME = "C:\\Program Files\\Eclipse Adoptium\\jdk-17"
  $env:ANDROID_HOME = "$env:LOCALAPPDATA\\Android\\Sdk"
  $env:NDK_HOME = "$env:ANDROID_HOME\\ndk\\27.2.12479018"

Rust targets (tauri android init installs these when rustup is present):

  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
`);
}

if (args.has('--force') && existsSync(genDir)) {
  console.log(`removing ${genDir} (--force)`);
  rmSync(genDir, { recursive: true, force: true });
}

if (!existsSync(genDir)) {
  run('pnpm', ['exec', 'tauri', 'android', 'init', '--ci']);
}

if (!existsSync(manifestPath)) {
  console.error(`Tauri did not create ${manifestPath}. Run the toolchain steps above, then retry.`);
  process.exit(1);
}

function patchFile(path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after !== before) {
    writeFileSync(path, after, 'utf8');
    console.log(`patched ${path}`);
  }
}

function setAttribute(attributes, name, value) {
  const pattern = new RegExp(`\\s${name}="[^"]*"`);
  if (pattern.test(attributes)) return attributes.replace(pattern, ` ${name}="${value}"`);
  return `${attributes} ${name}="${value}"`;
}

function patchManifest(text) {
  let next = text.replace(/<application\b([^>]*)>/, (_match, attributes) => {
    let attrs = attributes;
    // The companion only talks HTTPS. Release builds get no cleartext
    // exemption at all; the debug source set overlays loopback-only hosts.
    attrs = setAttribute(attrs, 'android:usesCleartextTraffic', 'false');
    attrs = setAttribute(attrs, 'android:networkSecurityConfig', '@xml/network_security_config');
    // The Keystore ciphertext is useless without the device key, but there is
    // no reason to copy it into a cloud backup either.
    attrs = setAttribute(attrs, 'android:allowBackup', 'false');
    attrs = setAttribute(attrs, 'android:fullBackupContent', 'false');
    return `<application${attrs}>`;
  });

  const permissions = ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'];
  for (const permission of permissions) {
    if (!next.includes(`android:name="${permission}"`)) {
      next = next.replace(
        /<application\b/,
        `<uses-permission android:name="${permission}" />\n    <application`,
      );
    }
  }
  return next;
}

patchFile(manifestPath, patchManifest);

// Tauri's generated Gradle project signs release builds with the debug key.
// That would make the APK installable but unshippable: every CI machine would
// produce a different signer identity, and Play would reject it. Remove the
// assignment so Gradle emits an unsigned release APK, which
// `android-build.mjs --sign` signs with the CI keystore instead.
function patchGradleSigning(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inRelease = false;
  let depth = 0;
  for (const line of lines) {
    const startsRelease =
      /getByName\(\s*["']release["']\s*\)\s*\{/.test(line) || /^\s*release\s*\{/.test(line);
    if (!inRelease && startsRelease) {
      inRelease = true;
      depth = 0;
    }
    if (inRelease) {
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      depth += opens - closes;
      const debugSigning =
        /signingConfig\s*=\s*signingConfigs\.getByName\(\s*["']debug["']\s*\)/.test(line) ||
        /signingConfig\s+signingConfigs\.debug\b/.test(line);
      if (debugSigning) {
        console.log('removed the debug signing config from the release build type');
        continue;
      }
      if (depth <= 0) inRelease = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

for (const path of [gradlePath, gradleGroovyPath]) {
  if (existsSync(path)) patchFile(path, patchGradleSigning);
}

function writeConfig(path, debug) {
  mkdirSync(dirname(path), { recursive: true });
  const loopback = debug
    ? `
  <!-- Debug builds only: the Android emulator reaches the development host at
       10.0.2.2. Release builds never include this file. -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>`
    : '';
  const text = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>${loopback}
</network-security-config>
`;
  writeFileSync(path, text, 'utf8');
  console.log(`wrote ${path}`);
}

writeConfig(mainNetworkConfig, false);
writeConfig(debugNetworkConfig, true);

// The launcher label is the one Android string Tauri cannot read from
// `tauri.conf.json` at build time.
if (existsSync(stringsPath)) {
  patchFile(stringsPath, (text) => {
    const escaped = brand.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    if (/<string name="app_name">[^<]*<\/string>/.test(text)) {
      return text.replace(/<string name="app_name">[^<]*<\/string>/, `<string name="app_name">${escaped}</string>`);
    }
    return text.replace('</resources>', `    <string name="app_name">${escaped}</string>\n</resources>`);
  });
}

console.log(`
Android project ready at ${genDir}.

  - Cleartext HTTP is blocked in every release build.
  - Debug builds may reach 10.0.2.2 / 127.0.0.1 / localhost only.
  - The camera permission is declared but requested at runtime only when the
    user taps Scan QR.
  - The release APK is unsigned here. Sign it with scripts/android-build.mjs
    --sign, or let the release workflow sign it with CI secrets.
`);
