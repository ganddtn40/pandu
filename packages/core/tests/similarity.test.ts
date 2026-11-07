import { describe, expect, it } from 'vitest';

import { textSimilarity, tokenSimilarity } from '../src/index.js';

describe('textSimilarity', () => {
  it('scores near-identical errors as highly similar', () => {
    const first = 'Error: Cannot find module ./src/feature from tests/feature.test.ts';
    const second = 'Error: Cannot find module ./src/feature from tests/other.test.ts';
    expect(textSimilarity(first, second)).toBeGreaterThan(0.8);
  });

  it('scores unrelated text low', () => {
    expect(textSimilarity('deploy to production', 'lunch at noon')).toBeLessThan(0.2);
  });

  it('normalizes whitespace and case', () => {
    expect(textSimilarity('  Rm -RF  ./dist ', 'rm -rf ./dist')).toBe(1);
  });
});

describe('tokenSimilarity', () => {
  it('ignores formatting-only changes', () => {
    expect(tokenSimilarity('rm -rf ./dist', 'rm   -rf ./dist')).toBe(1);
  });

  it('finds repeated tool requests with a different path token', () => {
    expect(
      tokenSimilarity('read_file path=src/a.ts lines=1-40', 'read_file path=src/b.ts lines=1-40'),
    ).toBeCloseTo(2 / 3, 5);
  });
});
