/**
 * Deterministic similarity primitives used by the loop and duplicate-context
 * detectors. They are intentionally simple, fast, and dependency-free. No
 * embeddings and no network calls: identical local input produces identical
 * scores on every machine.
 */

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shingles(value: string, size: number): Set<string> {
  const normalized = normalize(value);
  if (normalized.length === 0) {
    return new Set<string>();
  }
  if (normalized.length <= size) {
    return new Set<string>([normalized]);
  }

  const result = new Set<string>();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    result.add(normalized.slice(index, index + size));
  }
  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Character trigram Jaccard similarity. Useful for tool calls and error text
 * where small edits should still count as near duplicates.
 */
export function textSimilarity(left: string, right: string): number {
  if (normalize(left) === normalize(right)) {
    return 1;
  }
  return jaccard(shingles(left, 3), shingles(right, 3));
}

const TOKEN_PATTERN = /[\p{L}\p{N}_./-]+/gu;

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(TOKEN_PATTERN) ?? []);
}

/**
 * Token Jaccard similarity. Punctuation and formatting changes are ignored,
 * which makes it a better fit for near-identical command or error signatures.
 */
export function tokenSimilarity(left: string, right: string): number {
  return jaccard(tokenSet(left), tokenSet(right));
}
