#!/usr/bin/env node
/**
 * Write a SHA256SUMS file for every artifact in a directory.
 *
 *   node app/scripts/checksums.mjs --dir dist
 *   node app/scripts/checksums.mjs --dir dist/windows --out dist/windows/SHA256SUMS
 *
 * The format is the standard `<hex>  <relative path>` used by `sha256sum -c`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { repoRoot } from './lib/brand.mjs';

const args = process.argv.slice(2);
function value(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

const dir = resolve(repoRoot, value('--dir', 'dist'));
const out = resolve(repoRoot, value('--out', join(dir, 'SHA256SUMS')));

if (!existsSync(dir)) {
  console.error(`Nothing to checksum: ${dir} does not exist.`);
  process.exit(1);
}

function walk(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

async function hash(path) {
  return new Promise((resolveHash, reject) => {
    const digest = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => digest.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(digest.digest('hex')));
  });
}

const files = walk(dir)
  .filter((path) => path !== out)
  .filter((path) => !path.endsWith('SHA256SUMS'))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.error(`Nothing to checksum in ${dir}.`);
  process.exit(1);
}

const lines = [];
for (const file of files) {
  const digest = await hash(file);
  const name = relative(dir, file).replaceAll('\\', '/');
  lines.push(`${digest}  ${name}`);
  console.log(`${digest}  ${name}`);
}

writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
console.log(`\nwrote ${relative(repoRoot, out)} (${lines.length} files)`);
