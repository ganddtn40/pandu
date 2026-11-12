#!/usr/bin/env node
/**
 * Fail when a translation catalog drifts from the English source.
 *
 *   pnpm --dir ui check:i18n
 *
 * The UI falls back to English per key, so a draft catalog is allowed to be
 * incomplete. It is not allowed to invent keys, drop a placeholder, or leave a
 * language without the core navigation and action strings. The report prints
 * real coverage so a half-finished catalog is visible instead of silent.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalogPath = join(root, 'src', 'lib', 'i18n', 'catalog.ts');
const catalogsDir = join(root, 'src', 'lib', 'i18n', 'catalogs');
const typesPath = join(root, 'src', 'lib', 'design', 'types.ts');

/** Every language must translate these before it can ship. */
const CORE_KEYS = [
  'nav.home',
  'nav.inbox',
  'nav.flights',
  'nav.market',
  'nav.settings',
  'rail.addAgent',
  'topbar.search',
  'topbar.activeFlights',
  'topbar.idle',
  'common.online',
  'common.offline',
  'common.retry',
  'common.copy',
  'common.copied',
  'home.title',
  'home.quickPrompt',
  'inbox.title',
  'flights.title',
  'settings.title',
  'onboarding.open',
  'onboarding.continue',
  'onboarding.back',
];

/** Placeholders the translator may add even when English spells the brand out. */
const OPTIONAL_PLACEHOLDERS = new Set(['product', 'cli']);

const MINIMUM_KEYS = 100;

const catalogSource = readFileSync(catalogPath, 'utf8');
const typesSource = readFileSync(typesPath, 'utf8');

const errors = [];

function extractLanguageIds() {
  const match = typesSource.match(/export type LanguageId =([\s\S]*?);/);
  if (!match) throw new Error('Could not find the LanguageId union in types.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function extractLanguageList() {
  const match = typesSource.match(/export const LANGUAGES[\s\S]*?\n\];/);
  if (!match) throw new Error('Could not find the LANGUAGES list in types.ts');
  return [...match[0].matchAll(/id:\s*'([^']+)'/g)].map((entry) => entry[1]);
}

function extractEnglish() {
  const start = catalogSource.indexOf('const en = {');
  const end = catalogSource.indexOf('} as const satisfies Record<string, Message>;', start);
  if (start < 0 || end < 0) throw new Error('Could not find the English catalog');
  return catalogSource.slice(start, end);
}

function keyMatches(block) {
  return [...block.matchAll(/^\s*'([^']+)':/gm)];
}

function keysOf(block) {
  return keyMatches(block).map((match) => match[1]);
}

function valueSlice(block, matches, index) {
  const start = matches[index].index;
  const end = index + 1 < matches.length ? matches[index + 1].index : block.length;
  return block.slice(start, end);
}

function placeholders(text) {
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
}

function duplicateKeys(keys) {
  const seen = new Set();
  const duplicates = new Set();
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

function catalogBlocks() {
  const blocks = new Map();
  for (const file of readdirSync(catalogsDir)) {
    if (!file.endsWith('.ts')) continue;
    const id = file.slice(0, -3);
    const source = readFileSync(join(catalogsDir, file), 'utf8');
    const match = source.match(/^const (\w+): Catalog = \{/m);
    if (!match) throw new Error(`Could not find the catalog in ${file}`);
    if (match[1] !== id) {
      throw new Error(`${file} declares "${match[1]}", expected "${id}"`);
    }
    const start = match.index;
    const end = source.indexOf('\n};', start);
    if (end < 0) throw new Error(`Unterminated catalog for ${id}`);
    blocks.set(id, source.slice(start, end));
  }
  return blocks;
}

const languageIds = extractLanguageIds();
const listedLanguages = extractLanguageList();
const englishBlock = extractEnglish();
const englishKeys = keysOf(englishBlock);
const englishMatches = keyMatches(englishBlock);
const englishByKey = new Map();
for (let index = 0; index < englishMatches.length; index += 1) {
  englishByKey.set(englishMatches[index][1], valueSlice(englishBlock, englishMatches, index));
}

const duplicateEnglish = duplicateKeys(englishKeys);
if (duplicateEnglish.length > 0) {
  errors.push(`English has duplicate keys: ${duplicateEnglish.join(', ')}`);
}

const blocks = catalogBlocks();
blocks.set('en', englishBlock);
const missingCatalogs = languageIds.filter((id) => !blocks.has(id));
if (missingCatalogs.length > 0) {
  errors.push(`Missing catalogs for: ${missingCatalogs.join(', ')}`);
}
const unlisted = [...blocks.keys()].filter((id) => !languageIds.includes(id));
if (unlisted.length > 0) {
  errors.push(`Catalogs without a LanguageId: ${unlisted.join(', ')}`);
}
if (listedLanguages.join(',') !== languageIds.join(',')) {
  errors.push('LANGUAGES and the LanguageId union are out of sync');
}

const report = [];
for (const id of languageIds) {
  if (id === 'en') continue;
  const block = blocks.get(id);
  if (!block) continue;

  const matches = keyMatches(block);
  const keys = matches.map((match) => match[1]);
  const uniqueKeys = new Set(keys);

  const duplicates = duplicateKeys(keys);
  if (duplicates.length > 0) {
    errors.push(`${id}: duplicate keys: ${duplicates.join(', ')}`);
  }

  for (const key of uniqueKeys) {
    if (!englishByKey.has(key)) {
      errors.push(`${id}: unknown key "${key}"`);
    }
  }

  for (const key of CORE_KEYS) {
    if (!uniqueKeys.has(key)) errors.push(`${id}: missing core key "${key}"`);
  }

  if (uniqueKeys.size < MINIMUM_KEYS) {
    errors.push(`${id}: only ${uniqueKeys.size} keys translated, need at least ${MINIMUM_KEYS}`);
  }

  for (let index = 0; index < matches.length; index += 1) {
    const key = matches[index][1];
    const english = englishByKey.get(key);
    if (!english) continue;
    const translated = valueSlice(block, matches, index);
    const expected = placeholders(english);
    const actual = placeholders(translated);
    for (const placeholder of expected) {
      if (placeholder === 'product' || placeholder === 'cli') {
        if (!actual.has('product') && !actual.has('cli')) {
          errors.push(`${id}: "${key}" is missing the {${placeholder}} placeholder`);
        }
        continue;
      }
      if (!actual.has(placeholder)) {
        errors.push(`${id}: "${key}" is missing the {${placeholder}} placeholder`);
      }
    }
    for (const placeholder of actual) {
      if (!expected.has(placeholder) && !OPTIONAL_PLACEHOLDERS.has(placeholder)) {
        errors.push(`${id}: "${key}" has an unknown {${placeholder}} placeholder`);
      }
    }
    const values = [...translated.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
      .slice(1)
      .map((match) => match[1]);
    if (!values.some((value) => value.trim().length > 0)) {
      errors.push(`${id}: "${key}" has an empty translation`);
    }
  }

  const coverage = ((uniqueKeys.size / englishKeys.length) * 100).toFixed(1);
  report.push(`  ${id.padEnd(3)} ${String(uniqueKeys.size).padStart(4)} keys  ${coverage.padStart(5)}%`);
}

if (errors.length > 0) {
  console.error('i18n check failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`i18n check passed: ${languageIds.length} catalogs, ${englishKeys.length} English keys.`);
for (const line of report) console.log(line);
