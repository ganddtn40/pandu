#!/usr/bin/env node
/**
 * Validates the Tauri desktop shell without requiring a Rust toolchain.
 *
 * This catches the mistakes that otherwise only surface after `cargo build`:
 * a missing frontend bundle, icon files listed in the bundle config that were
 * never generated, a capability pointing at a window that does not exist, or a
 * CSP that blocks the loopback dashboard.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    fail(`${relativePath} is missing.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

function requireFile(relativePath, label = relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`${label} is missing (${relativePath}).`);
    return false;
  }
  return true;
}

const config = readJson('src-tauri/tauri.conf.json');
const capabilities = readJson('src-tauri/capabilities/default.json');

if (config) {
  const identifier = config.identifier;
  if (typeof identifier !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(identifier)) {
    fail('tauri.conf.json identifier must be a reverse-DNS style string.');
  }

  const windows = config.app?.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    fail('tauri.conf.json must define at least one app window.');
  } else {
    for (const window of windows) {
      if (typeof window.label !== 'string' || window.label.length === 0) {
        fail('Every app window needs a non-empty label.');
      }
      if (!Number.isInteger(window.width) || !Number.isInteger(window.height)) {
        fail(`Window "${window.label}" needs integer width and height.`);
      }
    }
  }

  const frontendDist = config.build?.frontendDist;
  if (typeof frontendDist !== 'string' || frontendDist.length === 0) {
    fail('build.frontendDist is required.');
  } else {
    const distPath = path.resolve(root, 'src-tauri', frontendDist);
    if (!existsSync(distPath) || !statSync(distPath).isDirectory()) {
      fail(`build.frontendDist does not resolve to a directory: ${frontendDist}`);
    } else if (!existsSync(path.join(distPath, 'index.html'))) {
      fail(`build.frontendDist is missing index.html: ${frontendDist}`);
    }
  }

  const csp = config.app?.security?.csp;
  if (typeof csp !== 'string' || csp.trim().length === 0) {
    fail('app.security.csp must be set; the desktop shell embeds a local dashboard.');
  } else {
    for (const directive of ['default-src', 'connect-src', 'frame-src', 'img-src']) {
      if (!csp.includes(directive)) fail(`CSP is missing the ${directive} directive.`);
    }
    if (!/frame-src[^;]*http:\/\/127\.0\.0\.1:\*/.test(csp)) {
      fail('CSP frame-src must allow the loopback daemon (http://127.0.0.1:*).');
    }
  }

  const icons = config.bundle?.icon;
  if (!Array.isArray(icons) || icons.length === 0) {
    fail('bundle.icon must list the generated icons.');
  } else {
    for (const icon of icons) {
      requireFile(path.join('src-tauri', icon), `Bundle icon ${icon}`);
    }
  }

  const targets = config.bundle?.targets;
  if (targets !== undefined && !Array.isArray(targets)) {
    fail('bundle.targets must be an array when set.');
  }
}

if (capabilities) {
  const labels = new Set(
    (config?.app?.windows ?? [])
      .map((window) => window.label)
      .filter((label) => typeof label === 'string'),
  );
  const windows = capabilities.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    fail('capabilities/default.json must target at least one window.');
  } else {
    for (const label of windows) {
      if (!labels.has(label)) {
        fail(`Capability targets window "${label}", which tauri.conf.json does not define.`);
      }
    }
  }
  if (!Array.isArray(capabilities.permissions) || capabilities.permissions.length === 0) {
    fail('capabilities/default.json must grant at least one permission.');
  }
}

requireFile('src-tauri/Cargo.toml');
requireFile('src-tauri/build.rs');
requireFile('src-tauri/src/main.rs');
requireFile('src-tauri/src/lib.rs');
requireFile('ui/app.js');
requireFile('ui/index.html');
requireFile('ui/styles.css');

if (failures.length > 0) {
  console.error('Desktop config validation failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('Desktop config is valid.');
