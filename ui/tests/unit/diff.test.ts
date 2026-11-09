import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/lib/diff';

describe('diffLines', () => {
  it('normalizes CRLF input and drops the trailing newline row', () => {
    const rows = diffLines(
      '--- a/.claude.json\r\n+++ b/.claude.json\r\n@@ mcpServers.demo @@\r\n-old\r\n+new\r\n',
    );
    expect(rows.map((row) => row.tone)).toEqual(['head', 'head', 'hunk', 'del', 'add']);
    expect(rows.map((row) => row.line)).toEqual([
      '--- a/.claude.json',
      '+++ b/.claude.json',
      '@@ mcpServers.demo @@',
      '-old',
      '+new',
    ]);
    for (const row of rows) expect(row.line).not.toContain('\r');
  });

  it('keeps a blank context line inside the diff', () => {
    const rows = diffLines('--- a\r\n+++ b\r\n@@ key @@\r\n same\r\n\r\n+new\r\n');
    expect(rows.map((row) => row.line)).toEqual(['--- a', '+++ b', '@@ key @@', ' same', '', '+new']);
  });
});
