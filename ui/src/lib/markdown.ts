/**
 * A deliberately small Markdown parser for release notes.
 *
 * Release notes arrive from a remote server, so this parser produces data that
 * Svelte renders as text. It never produces HTML and the UI never uses
 * `{@html}`. Only the constructs a release note needs are recognised:
 * headings, ordered and unordered lists, paragraphs, inline code, bold text,
 * and links. A link is only clickable when it is a plain HTTPS URL, and the
 * renderer asks before opening one.
 */

export type MarkdownInline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'link'; label: string; href: string | null };

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; content: MarkdownInline[] }
  | { type: 'paragraph'; content: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; items: MarkdownInline[][] };

const MAX_SOURCE_CHARS = 20_000;
const MAX_URL_CHARS = 2_048;
const MAX_BLOCKS = 400;

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const INLINE_TOKEN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\))/g;
const LINK = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)$/;

/**
 * Accept only a plain, absolute HTTPS URL with no embedded credentials.
 * Anything else keeps its label but loses the link.
 */
export function safeMarkdownHref(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_URL_CHARS) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url.toString();
}

function stripControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function parseInline(source: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  const text = stripControls(source);
  for (const part of text.split(INLINE_TOKEN)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      nodes.push({ type: 'code', value: part.slice(1, -1).trim() });
      continue;
    }
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      nodes.push({ type: 'strong', value: part.slice(2, -2).trim() });
      continue;
    }
    const link = LINK.exec(part);
    if (link) {
      nodes.push({
        type: 'link',
        label: link[1].trim(),
        href: safeMarkdownHref(link[2]),
      });
      continue;
    }
    nodes.push({ type: 'text', value: part });
  }
  return nodes;
}

function isBlockStart(line: string): boolean {
  return HEADING.test(line) || LIST_ITEM.test(line);
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const normalized = stripControls(source.slice(0, MAX_SOURCE_CHARS)).replace(
    /\r\n?/g,
    '\n',
  );
  const lines = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, content: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /^\d/.test(item[1]);
      const items: MarkdownInline[][] = [];
      while (index < lines.length) {
        const next = LIST_ITEM.exec(lines[index]);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        items.push(parseInline(next[2]));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', content: parseInline(paragraph.join(' ')) });
  }

  return blocks;
}
