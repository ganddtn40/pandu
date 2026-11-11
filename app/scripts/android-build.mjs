#!/usr/bin/env node
/**
 * Build the Android companion, then optionally sign and verify the APK.
 *
 * Signing is deliberately outside Gradle: the repository never contains a
 * keystore or a signing config. CI writes the keystore from secrets into a
 * temporary file and passes its path through the environment.
 *
 *   node app/scripts/android-build.mjs --sign --require-sign
 *
 * Required environment when signing:
 *   PANDU_ANDROID_KEYSTORE
 *   PANDU_ANDROID_KEYSTORE_PASSWORD
 *   PANDU_ANDROID_KEY_ALIAS
 *   PANDU_ANDROID_KEY_PASSWORD
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { appDir, appPath, readBrand, readJson, repoRoot } from './lib/brand.mjs';

const brand = readBrand();
const tauri = readJson('app/src-tauri/tauri.conf.json');
const args = process.argv.slice(2);
const debug = args.includes('--debug');
const sign = args.includes('--sign');
const requireSign = args.includes('--require-sign');
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : join(repoRoot, 'dist/android');
const targets = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--target') {
    let next = index + 1;
    while (next < args.length && !args[next].startsWith('--')) {
      targets.push(args[next]);
      next += 1;
    }
    index = next - 1;
  }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? appDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`\n${command} ${commandArgs.join(' ')} failed.`);
    process.exit(result.status ?? 1);
  }
}

function walk(directory, suffix) {
  if (!existsSync(directory)) return [];
  const out = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, suffix));
    else if (path.endsWith(suffix)) out.push(path);
  }
  return out;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findApksigner() {
  if (process.env.APKSIGNER && existsSync(process.env.APKSIGNER)) return process.env.APKSIGNER;
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    const buildTools = join(sdk, 'build-tools');
    if (existsSync(buildTools)) {
      const versions = readdirSync(buildTools)
        .filter((name) => existsSync(join(buildTools, name, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (versions[0]) {
        return join(buildTools, versions[0], process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
      }
    }
  }
  return process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
}

if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  console.error(`
ANDROID_HOME is not set. Install the Android SDK and JDK 17 first:

  winget install EclipseAdoptium.Temurin.17.JDK
  winget install Google.AndroidStudio

Then:

  $env:JAVA_HOME = "C:\\Program Files\\Eclipse Adoptium\\jdk-17"
  $env:ANDROID_HOME = "$env:LOCALAPPDATA\\Android\\Sdk"
  $env:NDK_HOME = "$env:ANDROID_HOME\\ndk\\27.2.12479018"
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
  node app/scripts/android-init.mjs
`);
  process.exit(1);
}

const tauriArgs = ['exec', 'tauri', 'android', 'build'];
if (debug) tauriArgs.push('--debug');
if (targets.length > 0) tauriArgs.push('--target', ...targets);
run('pnpm', tauriArgs);

const apkRoot = appPath('src-tauri/gen/android/app/build/outputs/apk');
const apks = walk(apkRoot, '.apk');
if (apks.length === 0) {
  console.error(`No APK was produced under ${apkRoot}.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const checksums = [];
const prefix = brand.envPrefix;
const keystore = process.env[`${prefix}ANDROID_KEYSTORE`];
const keystorePassword = process.env[`${prefix}ANDROID_KEYSTORE_PASSWORD`];
const keyAlias = process.env[`${prefix}ANDROID_KEY_ALIAS`];
const keyPassword = process.env[`${prefix}ANDROID_KEY_PASSWORD`];

if ((sign || requireSign) && !(keystore && keystorePassword && keyAlias && keyPassword)) {
  console.error(`
Signing was requested but the ${prefix}ANDROID_* secrets are incomplete.
Set all four:
  ${prefix}ANDROID_KEYSTORE
  ${prefix}ANDROID_KEYSTORE_PASSWORD
  ${prefix}ANDROID_KEY_ALIAS
  ${prefix}ANDROID_KEY_PASSWORD
`);
  process.exit(1);
}

if (sign && !existsSync(keystore)) {
  console.error(`Keystore not found at ${keystore}.`);
  process.exit(1);
}

const apksigner = findApksigner();
const version = tauri.version ?? '0.0.0';

for (const apk of apks) {
  const parent = basename(dirname(apk));
  const arch = parent === 'apk' || parent === 'release' || parent === 'debug' ? 'universal' : parent;
  const suffix = debug ? 'debug' : 'release';
  const base = `${brand.slug}-${version}-android-${arch}-${suffix}`;
  let output = join(outDir, `${base}${sign ? '-signed' : '-unsigned'}.apk`);

  if (sign) {
    const unsigned = join(outDir, `${base}-unsigned.apk`);
    copyFileSync(apk, unsigned);
    run(apksigner, [
      'sign',
      '--ks',
      keystore,
      `--ks-pass`,
      `env:${prefix}ANDROID_KEYSTORE_PASSWORD`,
      '--ks-key-alias',
      keyAlias,
      '--key-pass',
      `env:${prefix}ANDROID_KEY_PASSWORD`,
      '--out',
      output,
      unsigned,
    ]);
    run(apksigner, ['verify', '--verbose', '--print-certs', output]);
  } else {
    copyFileSync(apk, output);
    console.warn(`unsigned APK: ${relative(repoRoot, output)} (pass --sign to sign it)`);
  }

  const hash = sha256File(output);
  checksums.push(`${hash}  ${relative(outDir, output).replaceAll('\\', '/')}`);
  console.log(`${hash}  ${relative(repoRoot, output)}`);
}

writeFileSync(join(outDir, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8');
console.log(`\nAPK(s) in ${outDir}`);
