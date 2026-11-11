/**
 * Shared helpers for the app scripts. Every name, id, and URL comes from
 * `brand.json`; nothing here invents a product string.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const appDir = resolve(scriptsDir, '..', '..');
export const repoRoot = resolve(appDir, '..');

export function readBrand() {
  return JSON.parse(readFileSync(join(repoRoot, 'brand.json'), 'utf8'));
}

export function brandPath(relative) {
  return join(repoRoot, relative);
}

export function appPath(relative) {
  return join(appDir, relative);
}

export function readJson(relative) {
  return JSON.parse(readFileSync(brandPath(relative), 'utf8'));
}

export function writeJson(relative, value) {
  const path = brandPath(relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readText(relative) {
  return readFileSync(brandPath(relative), 'utf8');
}

export function writeText(relative, text) {
  const path = brandPath(relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

export function exists(relative) {
  return existsSync(brandPath(relative));
}

/** Read a scalar from a TOML section, or from the root table. */
export function tomlValue(text, section, key) {
  const lines = text.split(/\r?\n/);
  let current = '';
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`));
    if (match) return match[1];
  }
  return undefined;
}

/** Rewrite one scalar in a TOML section without disturbing the rest of the file. */
export function setTomlValue(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  let current = '';
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)"([^"]*)"`);
    const match = lines[index].match(pattern);
    if (match && match[2] !== value) {
      lines[index] = lines[index].replace(pattern, `$1"${value}"`);
      changed = true;
    }
  }
  return { text: lines.join('\n'), changed };
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
