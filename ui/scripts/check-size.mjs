#!/usr/bin/env node
/**
 * Fail the build when a JavaScript chunk exceeds its gzip budget.
 *
 *   pnpm --dir ui build
 *   pnpm --dir ui size
 *
 * The check reads Vite's real manifest, so the "initial" number follows the
 * static import graph of each HTML entry. Dynamic route chunks are measured on
 * their own; they are not part of the first load unless the route is opened.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const manifestPath = join(dist, '.vite', 'manifest.json');

const budgets = {
  initialHostKb: 90,
  initialCompanionKb: 80,
  asyncChunkKb: 25,
  sharedChunkKb: 70,
  totalJsKb: 200,
  cssKb: 30,
};

if (!existsSync(manifestPath)) {
  console.error(`Missing ${manifestPath}. Run \`vite build\` before the size check.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const gzipCache = new Map();

function gzipKb(relativeFile) {
  if (gzipCache.has(relativeFile)) return gzipCache.get(relativeFile);
  const path = join(dist, relativeFile);
  if (!existsSync(path)) {
    throw new Error(`The manifest points at a missing file: ${relativeFile}`);
  }
  const kb = Number(
    (gzipSync(readFileSync(path), { level: 9 }).length / 1024).toFixed(2),
  );
  gzipCache.set(relativeFile, kb);
  return kb;
}

function entryChunks(entryKey) {
  const seen = new Set();
  const files = [];
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    const item = manifest[key];
    if (!item) return;
    if (item.file?.endsWith('.js')) files.push(item.file);
    for (const imported of item.imports ?? []) visit(imported);
  }
  visit(entryKey);
  return files;
}

function sum(files) {
  return Number(files.reduce((total, file) => total + gzipKb(file), 0).toFixed(2));
}

const rows = [];
const failures = [];

function check(name, value, budget, unit = 'KB') {
  const pass = value <= budget;
  rows.push({ name, value, budget, unit, pass });
  if (!pass) failures.push(`${name}: ${value} ${unit} > ${budget} ${unit}`);
}

const hostInitial = entryChunks('index.html');
const companionInitial = entryChunks('companion.html');
check('initial host JS', sum(hostInitial), budgets.initialHostKb);
check('initial companion JS', sum(companionInitial), budgets.initialCompanionKb);

const initialFiles = new Set([...hostInitial, ...companionInitial]);
const asyncFiles = [];
const sharedFiles = [];
for (const item of Object.values(manifest)) {
  if (!item.file?.endsWith('.js')) continue;
  if (initialFiles.has(item.file)) continue;
  if (item.isDynamicEntry) asyncFiles.push(item.file);
  else sharedFiles.push(item.file);
}

for (const file of asyncFiles) {
  check(`chunk ${file}`, gzipKb(file), budgets.asyncChunkKb);
}
for (const file of sharedFiles) {
  check(`shared ${file}`, gzipKb(file), budgets.sharedChunkKb);
}

const allJs = readdirSync(join(dist, 'assets'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => join('assets', file));
const allCss = readdirSync(join(dist, 'assets')).filter((file) => file.endsWith('.css'));

check('total JS', sum(allJs), budgets.totalJsKb);
check(
  'CSS',
  Number(
    allCss
      .reduce((total, file) => total + gzipKb(join('assets', file)), 0)
      .toFixed(2),
  ),
  budgets.cssKb,
);

const report = {
  generatedAt: new Date().toISOString(),
  budgets,
  initial: {
    host: { files: hostInitial, kb: sum(hostInitial) },
    companion: { files: companionInitial, kb: sum(companionInitial) },
  },
  async: asyncFiles.map((file) => ({ file, kb: gzipKb(file) })).sort((a, b) => b.kb - a.kb),
  shared: sharedFiles.map((file) => ({ file, kb: gzipKb(file) })).sort((a, b) => b.kb - a.kb),
  totalJsKb: sum(allJs),
  cssKb: Number(
    allCss.reduce((total, file) => total + gzipKb(join('assets', file)), 0).toFixed(2),
  ),
  pass: failures.length === 0,
};

writeFileSync(join(dist, 'size-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const width = Math.max(...rows.map((row) => row.name.length), 12);
console.log('gzip size gate');
for (const row of rows) {
  const status = row.pass ? 'pass' : 'FAIL';
  console.log(
    `  ${row.name.padEnd(width)}  ${String(row.value).padStart(7)} ${row.unit}  <= ${row.budget} ${row.unit}  ${status}`,
  );
}
console.log(`  report: ${relative(root, join(dist, 'size-report.json'))}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} size budget(s) exceeded:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
