import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));
const publicRoot = fileURLToPath(new URL('../../public', import.meta.url));
const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(svelte|css|ts)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

const sourceFiles = walk(srcRoot).map((path) => ({
  name: relative(srcRoot, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

describe('user-facing copy', () => {
  it('never ships development phase or preview copy', () => {
    const devCopy = /Phase\s+\d|Preview data|arrives in Phase|coming in Phase|shell preview/i;
    for (const file of sourceFiles) {
      expect(file.text, file.name).not.toMatch(devCopy);
    }
  });
});

describe('small logo', () => {
  it('switches to the simplified mark below 28px', () => {
    const logo = readFileSync(new URL('../../src/lib/Logo.svelte', import.meta.url), 'utf8');
    expect(logo).toMatch(/simplified\s*=\s*\$derived\(size\s*<\s*28\)/);
  });

  it('ships a flat favicon variant with no gradients', () => {
    const small = readFileSync(join(publicRoot, 'logo-small.svg'), 'utf8');
    expect(small).not.toMatch(/gradient/i);
    expect(small).toMatch(/<circle[^>]*r="8\.7"/);
    expect(small).toMatch(/#ff7a2f/);
    expect(indexHtml).toContain('href="/logo-small.svg"');
  });
});

describe('neutral graphite shell', () => {
  function channels(hex: string): [number, number, number] {
    const value = hex.replace('#', '');
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    ];
  }

  it('keeps the base surfaces close to neutral', () => {
    for (const hex of ['#0a0c0f', '#07090c', '#14181f', '#191e26']) {
      const [r, g, b] = channels(hex);
      expect(Math.max(r, g, b) - Math.min(r, g, b), hex).toBeLessThanOrEqual(16);
      expect(b, hex).toBeGreaterThanOrEqual(r);
    }
  });

  it('keeps the dark wallpaper cool instead of warm', () => {
    const block = css.match(/:root\[data-wallpaper='procedural'\] body \{([\s\S]*?)\n\}/)?.[1];
    expect(block).toBeTruthy();
    const colors = [...(block ?? '').matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),/g)];
    expect(colors.length).toBeGreaterThan(0);
    for (const [, r, , b] of colors) {
      expect(Number(b), `rgba(${r}, ..., ${b})`).toBeGreaterThanOrEqual(Number(r) - 4);
    }
  });
});
