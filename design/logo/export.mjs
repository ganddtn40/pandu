#!/usr/bin/env node
/**
 * Render the logo assets to PNGs for stores, PWA icons, and docs.
 *
 *   node design/logo/export.mjs
 *
 * Requires the UI dependencies (`pnpm install` inside `ui/`). The PNGs are
 * generated artifacts and are ignored by git; the master PNG and the flat SVGs
 * are the source.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(path.join(repoRoot, 'ui', 'package.json'));
const { chromium } = require('playwright');

const outDir = path.join(here, 'png');
const pwaDir = path.join(repoRoot, 'ui', 'public', 'icons');
await mkdir(outDir, { recursive: true });
await mkdir(pwaDir, { recursive: true });

const fontUrl = pathToFileURL(
  path.join(repoRoot, 'ui', 'public', 'fonts', 'InterVariable-latin.woff2'),
).href;

const jobs = [
  { source: 'pandu-mark.png', name: 'pandu-mark-512.png', width: 512, height: 512 },
  { source: 'pandu-mark.png', name: 'pandu-mark-1024.png', width: 1024, height: 1024 },
  { source: 'pandu-mark.png', name: 'icon-192.png', width: 192, height: 192 },
  { source: 'pandu-mark.png', name: 'icon-512.png', width: 512, height: 512 },
  {
    source: 'pandu-mark.png',
    name: 'icon-maskable-512.png',
    width: 512,
    height: 512,
    maskable: true,
  },
  { source: 'pandu-mark-flat.svg', name: 'pandu-mark-flat-512.png', width: 512, height: 512 },
  {
    source: 'pandu-mark-mono.svg',
    name: 'pandu-mark-mono-512.png',
    width: 512,
    height: 512,
    color: '#171b21',
  },
  {
    source: 'pandu-wordmark.svg',
    name: 'pandu-wordmark-1600.png',
    width: 1600,
    height: 427,
    color: '#171b21',
  },
];

const browser = await chromium.launch();

try {
  for (const job of jobs) {
    const raw = await readFile(path.join(here, job.source));
    const isPng = job.source.endsWith('.png');
    const source = isPng
      ? `<img class="icon" src="data:image/png;base64,${raw.toString('base64')}" alt="" />`
      : raw.toString('utf8');
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
        html, body { margin: 0; background: ${job.maskable ? '#ffffff' : 'transparent'}; }
        body { color: ${job.color ?? '#e9eef4'}; }
        svg { display: block; width: ${job.width}px; height: ${job.height}px; }
        .icon { display: block; width: 100%; height: 100%; object-fit: contain; }
      </style></head><body>${source}</body></html>`,
      { waitUntil: 'load' },
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.images].map((image) => image.decode().catch(() => undefined)),
      );
    });
    await page.screenshot({
      path: path.join(outDir, job.name),
      omitBackground: !job.maskable,
    });
    await page.close();
    if (job.name.startsWith('icon-')) {
      await copyFile(path.join(outDir, job.name), path.join(pwaDir, job.name));
      console.log(`wrote png/${job.name} and ui/public/icons/${job.name}`);
    } else {
      console.log(`wrote png/${job.name}`);
    }
  }
} finally {
  await browser.close();
}
