import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeMarkdownHref } from '../../src/lib/markdown';

describe('safeMarkdownHref', () => {
  it('accepts plain HTTPS links', () => {
    expect(safeMarkdownHref('https://example.com/notes')).toBe('https://example.com/notes');
  });

  it('rejects schemes that could execute or leave the web', () => {
    expect(safeMarkdownHref('http://example.com')).toBeNull();
    expect(safeMarkdownHref('javascript:alert(1)')).toBeNull();
    expect(safeMarkdownHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeMarkdownHref('file:///C:/Windows')).toBeNull();
    expect(safeMarkdownHref('https://user:pass@example.com')).toBeNull();
    expect(safeMarkdownHref('https://')).toBeNull();
    expect(safeMarkdownHref('')).toBeNull();
  });
});

describe('parseMarkdown', () => {
  it('recognises headings, lists, paragraphs, code, bold, and links', () => {
    const blocks = parseMarkdown(
      '## Highlights\n\n- Fixed `proxy` retries\n- Added **safe** notes\n\n1. First\n2. Second\n\nSee [the docs](https://example.com/docs).',
    );

    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: false });
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: true });
    expect(blocks[3]).toMatchObject({ type: 'paragraph' });
    expect(parseInline('Use `code` and **bold**')).toEqual([
      { type: 'text', value: 'Use ' },
      { type: 'code', value: 'code' },
      { type: 'text', value: ' and ' },
      { type: 'strong', value: 'bold' },
    ]);
    expect(parseInline('[docs](https://example.com/x)')).toEqual([
      { type: 'link', label: 'docs', href: 'https://example.com/x' },
    ]);
  });

  it('keeps an unsafe link label as text and drops the target', () => {
    expect(parseInline('[run](javascript:alert(1))')).toEqual([
      { type: 'link', label: 'run', href: null },
    ]);
  });

  it('never turns raw HTML into markup', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    const text = JSON.stringify(blocks);
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).not.toContain('{@html}');
    expect(blocks.every((block) => block.type === 'paragraph')).toBe(true);
  });

  it('clamps deep headings and ignores empty input', () => {
    expect(parseMarkdown('###### Deep')).toEqual([
      { type: 'heading', level: 3, content: [{ type: 'text', value: 'Deep' }] },
    ]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });

  it('joins wrapped paragraph lines and keeps list items separate', () => {
    const blocks = parseMarkdown('A wrapped\nparagraph\n\n- one\n- two');
    expect(blocks[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', value: 'A wrapped paragraph' }],
    });
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: false });
    expect(blocks[1].type === 'list' && blocks[1].items).toHaveLength(2);
  });
});
