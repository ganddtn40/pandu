import { describe, expect, it } from 'vitest';

import { createId, type ProvenanceEntry } from '@cockpit/core';

import {
  aggregateProvenanceFiles,
  countAttributedLines,
  hashContent,
  parseAddedRanges,
} from '../src/provenance/service.js';

const DIFF = [
  'diff --git a/src/retry.ts b/src/retry.ts',
  'index 1111111..2222222 100644',
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -1,3 +1,5 @@',
  ' export const retry = 1;',
  '-export const backoff = 0;',
  '+export const backoff = 250;',
  '+export const maxAttempts = 3;',
  ' export function retryDelay() {',
  '   return backoff;',
  ' }',
  '@@ -20,2 +22,3 @@',
  ' const timeout = 1000;',
  '+const jitter = true;',
  ' export { timeout };',
  '',
].join('\n');

describe('parseAddedRanges', () => {
  it('maps added lines onto new-file line numbers', () => {
    const ranges = parseAddedRanges(DIFF);
    expect(ranges).toEqual([
      {
        lineStart: 2,
        lineEnd: 3,
        text: 'export const backoff = 250;\nexport const maxAttempts = 3;',
      },
      { lineStart: 23, lineEnd: 23, text: 'const jitter = true;' },
    ]);
  });

  it('ignores deletions and file headers outside hunks', () => {
    const ranges = parseAddedRanges(DIFF);
    const text = ranges.map((range) => range.text).join('\n');
    expect(text).not.toContain('export const backoff = 0;');
    expect(text).not.toContain('+++ b/src/retry.ts');
  });

  it('returns an empty list for deletion-only diffs', () => {
    const deletionOnly = [
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ b/src/old.ts',
      '@@ -1,2 +1 @@',
      '-export const old = true;',
      ' export const kept = true;',
      '',
    ].join('\n');
    expect(parseAddedRanges(deletionOnly)).toEqual([]);
  });

  it('does not advance line numbers on removed lines', () => {
    const replacement = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -4,3 +4,3 @@',
      ' context one',
      '-old line',
      '+new line',
      ' context two',
      '',
    ].join('\n');
    expect(parseAddedRanges(replacement)).toEqual([{ lineStart: 5, lineEnd: 5, text: 'new line' }]);
  });

  it('handles new files whose hunk starts at line zero', () => {
    const added = [
      '--- /dev/null',
      '+++ b/src/created.ts',
      '@@ -0,0 +1,2 @@',
      '+export const created = true;',
      '+export const enabled = true;',
      '',
    ].join('\n');
    expect(parseAddedRanges(added)).toEqual([
      {
        lineStart: 1,
        lineEnd: 2,
        text: 'export const created = true;\nexport const enabled = true;',
      },
    ]);
  });
});

describe('countAttributedLines', () => {
  it('counts unique lines across overlapping ranges', () => {
    expect(
      countAttributedLines([
        { lineStart: 1, lineEnd: 5 },
        { lineStart: 4, lineEnd: 8 },
        { lineStart: 10, lineEnd: 10 },
      ]),
    ).toBe(9);
  });

  it('treats adjacent ranges as a single contiguous block', () => {
    expect(
      countAttributedLines([
        { lineStart: 3, lineEnd: 4 },
        { lineStart: 1, lineEnd: 2 },
        { lineStart: 5, lineEnd: 6 },
      ]),
    ).toBe(6);
  });

  it('returns zero for no ranges', () => {
    expect(countAttributedLines([])).toBe(0);
  });
});

describe('hashContent', () => {
  it('produces a stable sha256 digest', () => {
    const first = hashContent('export const retry = 3;');
    const second = hashContent('export const retry = 3;');
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(hashContent('export const retry = 4;')).not.toBe(first);
  });
});

function entry(overrides: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return {
    id: createId(),
    projectId: createId(),
    sessionId: createId(),
    stepId: createId(),
    filePath: 'src/retry.ts',
    lineStart: 1,
    lineEnd: 2,
    commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    contentHash: hashContent('export const retry = 3;'),
    provider: 'openai',
    model: 'gpt-4o-mini',
    promptExcerpt: 'Fix the retry loop.',
    confidence: 1,
    capturedAt: '2026-04-05T06:07:10.000Z',
    ...overrides,
  };
}

describe('aggregateProvenanceFiles', () => {
  it('groups entries by path and counts unique attributed lines', () => {
    const projectId = createId();
    const files = aggregateProvenanceFiles([
      entry({ projectId, lineStart: 1, lineEnd: 3, provider: 'openai', model: 'gpt-4o-mini' }),
      entry({
        projectId,
        lineStart: 3,
        lineEnd: 5,
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        capturedAt: '2026-04-05T07:00:00.000Z',
      }),
      entry({
        projectId,
        filePath: 'src/other.ts',
        lineStart: 10,
        lineEnd: 10,
        provider: 'openai',
        model: 'gpt-4o-mini',
      }),
    ]);

    expect(files.map((file) => file.path)).toEqual(['src/retry.ts', 'src/other.ts']);
    expect(files[0]).toMatchObject({
      aiLines: 5,
      lineRanges: 2,
      entries: 2,
      providers: ['anthropic', 'openai'],
      models: ['claude-sonnet-4', 'gpt-4o-mini'],
      lastCapturedAt: '2026-04-05T07:00:00.000Z',
    });
    expect(files[1]).toMatchObject({ path: 'src/other.ts', aiLines: 1, lineRanges: 1 });
  });

  it('returns an empty list when nothing was attributed', () => {
    expect(aggregateProvenanceFiles([])).toEqual([]);
  });
});
