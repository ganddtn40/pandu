import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));

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

const files = walk(srcRoot).map((path) => ({
  path,
  name: relative(srcRoot, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');
const markup = files.filter((file) => file.name.endsWith('.svelte'));

describe('visual language bans', () => {
  it('never uppercases labels', () => {
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/i);
    for (const file of markup) {
      expect(file.text, file.name).not.toMatch(/text-transform\s*:\s*uppercase/i);
    }
  });

  it('never uses a serif display face', () => {
    expect(css).not.toMatch(/(?<!sans-)serif\b/i);
    for (const file of markup) {
      expect(file.text, file.name).not.toMatch(/(?<!sans-)serif\b/i);
    }
  });

  it('never uses the amber terminal palette', () => {
    const amber = /#(?:ffb000|ffbf00|ffcc00|ffc400|f5a623|ffb300|e8a317)\b/i;
    expect(css).not.toMatch(amber);
    for (const file of files) {
      expect(file.text, file.name).not.toMatch(amber);
    }
  });

  it('never uses sharp corners on surfaces', () => {
    expect(css).not.toMatch(/border-radius\s*:\s*0(?:px)?\s*;/i);
    for (const file of markup) {
      expect(file.text, file.name).not.toMatch(/border-radius\s*:\s*0(?:px)?\s*;/i);
    }
  });

  it('never clips a gradient to text', () => {
    expect(css).not.toMatch(/background-clip\s*:\s*text/i);
  });

  it('avoids hero marketing copy', () => {
    const marketing =
      /\b(supercharge|revolutioni[sz]e|game[- ]changing|blazing fast|the future of work|10x your|unlock your potential)\b/i;
    for (const file of markup) {
      expect(file.text, file.name).not.toMatch(marketing);
    }
  });

  it('avoids decorative emoji in the interface', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const file of markup) {
      expect(file.text, file.name).not.toMatch(emoji);
    }
  });

  it('uses sentence-case status text rather than mono labels', () => {
    // The old terminal look leaned on small monospace uppercase labels. Code
    // may still use the mono font, but no label may be forced to uppercase.
    expect(css).toMatch(/--font-mono:/);
    expect(css).not.toMatch(/text-transform\s*:\s*(uppercase|capitalize)/i);
  });
});
