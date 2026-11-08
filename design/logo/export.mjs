#!/usr/bin/env node
/**
 * Render the logo SVGs to PNGs for stores, PWA icons, and docs.
 *
 *   node design/logo/export.mjs
 *
 * Requires the UI dependencies (`pnpm install` inside `ui/`). The PNGs are
 * generated artifacts and are ignored by git; the SVGs are the source.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(path.join(repoRoot, 'ui', 'package.json'));
const { chromium } = require('playwright');

const outDir = path.join(here, 'png');
await mkdir(outDir, { recursive: true });

const fontUrl = pathToFileURL(
  path.join(repoRoot, 'ui', 'public', 'fonts', 'InterVariable-latin.woff2'),
).href;

const jobs = [
  { source: 'cockpit-mark.svg', name: 'cockpit-mark-512.png', width: 512, height: 512 },
  { source: 'cockpit-mark.svg', name: 'cockpit-mark-1024.png', width: 1024, height: 1024 },
  { source: 'cockpit-mark.svg', name: 'icon-192.png', width: 192, height: 192 },
  { source: 'cockpit-mark.svg', name: 'icon-512.png', width: 512, height: 512 },
  { source: 'cockpit-mark-light.svg', name: 'cockpit-mark-light-512.png', width: 512, height: 512 },
  { source: 'cockpit-mark-mono.svg', name: 'cockpit-mark-mono-512.png', width: 512, height: 512 },
  { source: 'cockpit-wordmark.svg', name: 'cockpit-wordmark-1600.png', width: 1600, height: 427 },
];

const browser = await chromium.launch();

try {
  for (const job of jobs) {
    const svg = await readFile(path.join(here, job.source), 'utf8');
    const page = await browser.newPage({
      viewport: { width: job.width, height: job.height },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><style>
        @font-face {
          font-family: 'Inter';
          src: url('${fontUrl}') format('woff2');
          font-weight: 100 900;
          font-display: block;
        }
        html, body { margin: 0; background: transparent; }
        body { color: #e9eef4; }
        svg { display: block; width: ${job.width}px; height: ${job.height}px; }
      </style></head><body>${svg}</body></html>`,
      { waitUntil: 'load' },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(outDir, job.name), omitBackground: true });
    await page.close();
    console.log(`wrote png/${job.name}`);
  }
} finally {
  await browser.close();
}
