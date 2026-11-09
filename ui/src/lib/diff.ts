export type DiffTone = 'head' | 'hunk' | 'add' | 'del' | 'context';

export interface DiffRow {
  tone: DiffTone;
  line: string;
}

/**
 * Split a unified diff into rows for rendering. CRLF input is normalized so a
 * stray carriage return never reaches the DOM, and the trailing newline of a
 * diff does not produce an extra empty row.
 */
export function diffLines(text: string): DiffRow[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const rows: DiffRow[] = normalized.split('\n').map((line) => {
    let tone: DiffTone = 'context';
    if (line.startsWith('+++') || line.startsWith('---')) tone = 'head';
    else if (line.startsWith('@@')) tone = 'hunk';
    else if (line.startsWith('+')) tone = 'add';
    else if (line.startsWith('-')) tone = 'del';
    return { tone, line };
  });
  if (rows.length > 0 && rows[rows.length - 1].line === '') rows.pop();
  return rows;
}
