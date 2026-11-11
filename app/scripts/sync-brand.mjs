#!/usr/bin/env node
/**
 * Push `brand.json` into the files that cannot import it at runtime.
 *
 * Tauri reads JSON and Cargo reads TOML before any Rust or JavaScript runs, and
 * Gradle/Kotlin need a real Java package. This script is the one place that
 * copies those values. Run it after changing a name, id, or URL, then run
 * `node app/scripts/check-brand.mjs`.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  appDir,
  readBrand,
  readJson,
  readText,
  repoRoot,
  setTomlValue,
  writeJson,
  writeText,
} from './lib/brand.mjs';

const brand = readBrand();
const slug = brand.slug;
const rustSlug = slug.replace(/-/g, '_');
const keystorePackage = `${brand.androidPackage}.keystore`;
const changes = [];

function changed(label) {
  changes.push(label);
}

function writeIfChanged(relativePath, next, label) {
  const current = readText(relativePath);
  if (current !== next) {
    writeText(relativePath, next);
    changed(label);
  }
}

function setToml(relativePath, section, key, value, label) {
  const current = readText(relativePath);
  const result = setTomlValue(current, section, key, value);
  if (result.changed) {
    writeText(relativePath, result.text);
    changed(label);
  }
}

// package.json -----------------------------------------------------------------
{
  const pkg = readJson('app/package.json');
  const next = {
    ...pkg,
    name: `@${slug}/app`,
    description: `${brand.name} desktop and Android shell.`,
    scripts: {
      ...pkg.scripts,
      icons: `tauri icon ../design/logo/png/${slug}-mark-1024.png`,
    },
  };
  if (JSON.stringify(pkg) !== JSON.stringify(next)) {
    writeJson('app/package.json', next);
    changed('app/package.json');
  }
}

// Tauri desktop config ---------------------------------------------------------
{
  const config = readJson('app/src-tauri/tauri.conf.json');
  const next = {
    ...config,
    productName: brand.name,
    identifier: brand.appId,
    bundle: {
      ...config.bundle,
      shortDescription: brand.tagline,
      longDescription: `${brand.name} records what AI coding agents do, shows it live, replays it, and asks permission before risky actions. Everything stays on your machine. Zero telemetry.`,
      publisher: `${brand.name} contributors`,
    },
    plugins: {
      ...config.plugins,
      'deep-link': {
        ...config.plugins?.['deep-link'],
        desktop: {
          ...config.plugins?.['deep-link']?.desktop,
          schemes: [brand.urlScheme],
        },
      },
    },
  };
  if (JSON.stringify(config) !== JSON.stringify(next)) {
    writeJson('app/src-tauri/tauri.conf.json', next);
    changed('app/src-tauri/tauri.conf.json');
  }
}

// Tauri Android config ---------------------------------------------------------
{
  const config = readJson('app/src-tauri/tauri.android.conf.json');
  const windows = config.app?.windows ?? [];
  if (windows[0] && windows[0].title !== brand.name) {
    windows[0] = { ...windows[0], title: brand.name };
    writeJson('app/src-tauri/tauri.android.conf.json', {
      ...config,
      app: { ...config.app, windows },
    });
    changed('app/src-tauri/tauri.android.conf.json');
  }
}

// Cargo manifests --------------------------------------------------------------
setToml('app/src-tauri/Cargo.toml', 'package', 'name', `${slug}-app`, 'Cargo package name');
setToml('app/src-tauri/Cargo.toml', 'package', 'repository', brand.repository, 'Cargo repository');
setToml(
  'app/src-tauri/Cargo.toml',
  'package',
  'description',
  `${brand.name} desktop and Android shell`,
  'Cargo description',
);
setToml('app/src-tauri/Cargo.toml', 'lib', 'name', `${rustSlug}_app_lib`, 'Cargo lib name');
setToml('app/src-tauri/Cargo.toml', 'bin', 'name', brand.name, 'Cargo bin name');

setToml(
  'app/plugins/keystore/Cargo.toml',
  'package',
  'name',
  `${slug}-plugin-keystore`,
  'plugin package name',
);
setToml(
  'app/plugins/keystore/Cargo.toml',
  'package',
  'description',
  `Android Keystore token storage and guard watch for the ${brand.name} companion`,
  'plugin description',
);
setToml(
  'app/plugins/keystore/Cargo.toml',
  'lib',
  'name',
  `${rustSlug}_plugin_keystore`,
  'plugin lib name',
);

// main.rs and the plugin registration string -----------------------------------
{
  const main = readText('app/src-tauri/src/main.rs');
  const next = main.replace(/\b[a-z0-9_]+_app_lib::run\(\)/g, `${rustSlug}_app_lib::run()`);
  writeIfChanged('app/src-tauri/src/main.rs', next, 'app/src-tauri/src/main.rs');
}
{
  const lib = readText('app/src-tauri/src/lib.rs');
  const next = lib.replace(
    /\b[a-z0-9_]+_plugin_keystore::init\(\)/g,
    `${rustSlug}_plugin_keystore::init()`,
  );
  writeIfChanged('app/src-tauri/src/lib.rs', next, 'app/src-tauri/src/lib.rs');
}
{
  const lib = readText('app/plugins/keystore/src/lib.rs');
  const next = lib.replace(/"io\.[A-Za-z0-9_.]+\/keystore"|"[A-Za-z0-9_.]+\.keystore"/g, `"${keystorePackage}"`);
  writeIfChanged('app/plugins/keystore/src/lib.rs', next, 'plugin Android package');
}

// Gradle namespace and Kotlin package declarations -----------------------------
{
  const gradlePath = 'app/plugins/keystore/android/build.gradle.kts';
  const gradle = readText(gradlePath);
  const next = gradle.replace(/namespace\s*=\s*"[^"]+"/, `namespace = "${keystorePackage}"`);
  writeIfChanged(gradlePath, next, 'Gradle namespace');
}

function walk(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.kt')) out.push(path);
  }
  return out;
}

{
  const sourceRoot = join(appDir, 'plugins/keystore/android/src/main/java');
  if (existsSync(sourceRoot)) {
    const files = walk(sourceRoot);
    const targetRoot = join(sourceRoot, ...keystorePackage.split('.'));
    for (const file of files) {
      const text = readText(relative(repoRoot, file).replaceAll('\\', '/'));
      const firstLine = text.split(/\r?\n/, 1)[0];
      const next = `package ${keystorePackage}${text.slice(firstLine.length)}`;
      if (firstLine !== `package ${keystorePackage}`) {
        writeText(relative(repoRoot, file).replaceAll('\\', '/'), next);
        changed(`Kotlin package in ${relative(repoRoot, file)}`);
      }
      if (dirname(file) !== targetRoot) {
        mkdirSync(targetRoot, { recursive: true });
        const target = join(targetRoot, file.slice(dirname(file).length + 1));
        if (!existsSync(target)) {
          renameSync(file, target);
          changed(`moved ${relative(repoRoot, file)}`);
        }
      }
    }
    // Remove now-empty package directories, but never the source root.
    const prune = (directory) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) prune(path);
      }
      if (directory !== sourceRoot && readdirSync(directory).length === 0) {
        rmdirSync(directory);
      }
    };
    prune(sourceRoot);
  }
}

// packaging/manifest.json ------------------------------------------------------
{
  const manifest = readJson('packaging/manifest.json');
  const tauri = readJson('app/src-tauri/tauri.conf.json');
  const version = tauri.version;
  const next = {
    ...manifest,
    product: brand.name,
    slug,
    description: brand.tagline,
    repository: brand.repository,
    binary: brand.cli.command,
    dataDir: brand.dataDir,
    database: brand.databaseFile,
    envPrefix: brand.envPrefix,
    urlScheme: brand.urlScheme,
    channels: {
      ...manifest.channels,
      crates: [brand.crates.core, brand.crates.daemon, brand.crates.cli],
      scoop: slug,
    },
    artifacts: {
      'windows-cli-x86_64': {
        binary: `${slug}.exe`,
        archive: `${brand.crates.cli}-x86_64-pc-windows-msvc.zip`,
      },
      'windows-app-x86_64': {
        binary: `${brand.name}.exe`,
        nsis: `${brand.name}_${version}_x64-setup.exe`,
        msi: `${brand.name}_${version}_x64_en-US.msi`,
        portable: `${slug}-${version}-x86_64-pc-windows-msvc-portable.zip`,
      },
      'macos-cli-aarch64': {
        binary: brand.cli.command,
        archive: `${brand.crates.cli}-aarch64-apple-darwin.tar.xz`,
      },
      'macos-cli-x86_64': {
        binary: brand.cli.command,
        archive: `${brand.crates.cli}-x86_64-apple-darwin.tar.xz`,
      },
      'linux-cli-x86_64': {
        binary: brand.cli.command,
        archive: `${brand.crates.cli}-x86_64-unknown-linux-gnu.tar.xz`,
      },
      android: {
        package: brand.androidPackage,
        archive: `${slug}-${version}-android-universal-release-signed.apk`,
      },
    },
  };
  if (JSON.stringify(manifest) !== JSON.stringify(next)) {
    writeJson('packaging/manifest.json', next);
    changed('packaging/manifest.json');
  }
}

if (changes.length === 0) {
  console.log(`no changes: the app already matches ${brand.name} in brand.json.`);
} else {
  console.log(`synced ${brand.name} from brand.json:`);
  for (const label of changes) console.log(`  - ${label}`);
}
