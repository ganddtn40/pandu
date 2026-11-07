import { createHash } from 'node:crypto';

import {
  SessionProvenanceResponseSchema,
  type ProvenanceEntry,
  type ProvenanceFile,
  type ReplaySnapshot,
  type Session,
} from '@cockpit/core';

import type { Logger } from '../logger.js';
import type { InsertProvenanceInput, Store } from '../store/store.js';

const MAX_RANGES_PER_FILE = 200;
const MAX_PROMPT_EXCERPT = 500;

export interface ProvenanceServiceOptions {
  store: Store;
  logger: Logger;
}

interface AddedRange {
  lineStart: number;
  lineEnd: number;
  text: string;
}

interface LineRange {
  lineStart: number;
  lineEnd: number;
}

function clip(text: string, maximum: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

/**
 * Parse added line numbers from a unified diff. Hunk headers give the new-file
 * start line; `+` lines advance that counter, context lines advance it too, and
 * `-` lines do not. This is the attribution backbone: no model call is needed.
 */
export function parseAddedRanges(diff: string): AddedRange[] {
  const added: Array<{ line: number; text: string }> = [];
  let currentLine = 0;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      currentLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      added.push({ line: currentLine, text: line.slice(1) });
      currentLine += 1;
      continue;
    }
    if (line.startsWith('-')) continue;
    currentLine += 1;
  }

  const ranges: AddedRange[] = [];
  let current: AddedRange | undefined;
  for (const entry of added) {
    if (!current || entry.line !== current.lineEnd + 1) {
      current = { lineStart: entry.line, lineEnd: entry.line, text: entry.text };
      ranges.push(current);
      continue;
    }
    current.lineEnd = entry.line;
    current.text = `${current.text}\n${entry.text}`;
  }

  return ranges.slice(0, MAX_RANGES_PER_FILE);
}

function mergeRanges(entries: readonly LineRange[]): LineRange[] {
  const sorted = [...entries].sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
  const merged: LineRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.lineStart > last.lineEnd + 1) {
      merged.push({ lineStart: range.lineStart, lineEnd: range.lineEnd });
      continue;
    }
    last.lineEnd = Math.max(last.lineEnd, range.lineEnd);
  }

  return merged;
}

export function countAttributedLines(entries: readonly LineRange[]): number {
  return mergeRanges(entries).reduce(
    (total, range) => total + (range.lineEnd - range.lineStart + 1),
    0,
  );
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class ProvenanceService {
  readonly #store: Store;
  readonly #logger: Logger;

  constructor(options: ProvenanceServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
  }

  /**
   * Capture provenance from a finished step snapshot. Safe to call repeatedly:
   * entries for the step are replaced, never duplicated.
   */
  recordSnapshot(snapshot: ReplaySnapshot): void {
    if (snapshot.kind !== 'after' || !snapshot.stepId) return;

    const session = this.#store.getSession(snapshot.sessionId);
    if (!session) return;

    const projectId = this.#ensureProject(session);
    if (!projectId) return;

    const step = this.#store.getStep(snapshot.stepId);
    if (!step || step.sessionId !== session.id) return;

    const fileChanges = this.#store.listSnapshotFileChanges(snapshot.id);
    if (fileChanges.length === 0) {
      this.#store.deleteProvenanceForStep(step.id);
      return;
    }

    const inputs: InsertProvenanceInput[] = [];
    const capturedAt = new Date(snapshot.createdAt);
    const promptText = step.request?.promptText;
    const promptExcerpt = promptText ? clip(promptText, MAX_PROMPT_EXCERPT) : undefined;

    for (const change of fileChanges) {
      if (change.changeType === 'deleted' || !change.diff) continue;
      const ranges = parseAddedRanges(change.diff);
      for (const range of ranges) {
        inputs.push({
          projectId,
          sessionId: session.id,
          stepId: step.id,
          filePath: change.path,
          lineStart: range.lineStart,
          lineEnd: range.lineEnd,
          ...(snapshot.commitSha ? { commitSha: snapshot.commitSha } : {}),
          contentHash: hashContent(range.text),
          ...(step.provider ? { provider: step.provider } : {}),
          ...(step.model ? { model: step.model } : {}),
          ...(promptExcerpt ? { promptExcerpt } : {}),
          confidence: 1,
          capturedAt,
        });
      }
    }

    this.#store.deleteProvenanceForStep(step.id);
    if (inputs.length === 0) return;
    this.#store.insertProvenanceEntries(inputs);
    this.#logger.debug('Captured provenance from a step snapshot', {
      sessionId: session.id,
      stepId: step.id,
      files: new Set(inputs.map((input) => input.filePath)).size,
      ranges: inputs.length,
    });
  }

  recomputeSession(sessionId: string) {
    const session = this.#store.getSession(sessionId);
    if (!session) return undefined;

    this.#store.deleteProvenanceForSession(sessionId);
    for (const snapshot of this.#store.listSnapshots(sessionId)) {
      this.recordSnapshot(snapshot);
    }
    return this.summary(sessionId);
  }

  summary(sessionId: string) {
    const session = this.#store.getSession(sessionId);
    if (!session) return undefined;

    const entries = this.#store.listProvenanceEntries({ sessionId, limit: 20_000 });
    const files = aggregateProvenanceFiles(entries);
    const steps = new Set(entries.flatMap((entry) => (entry.stepId ? [entry.stepId] : [])));
    const projectId = session.projectId ?? entries[0]?.projectId;

    return SessionProvenanceResponseSchema.parse({
      sessionId,
      ...(projectId ? { projectId } : {}),
      entries,
      files,
      totals: {
        entries: entries.length,
        files: files.length,
        aiLines: files.reduce((total, file) => total + file.aiLines, 0),
        steps: steps.size,
      },
    });
  }

  #ensureProject(session: Session): string | undefined {
    if (session.projectId) return session.projectId;
    if (!session.workspacePath) return undefined;

    try {
      const project = this.#store.ensureProject(session.workspacePath);
      this.#store.setSessionProject(session.id, project.id);
      return project.id;
    } catch (error) {
      this.#logger.warn('Cockpit could not create a project for provenance', error);
      return undefined;
    }
  }
}

export function aggregateProvenanceFiles(entries: readonly ProvenanceEntry[]): ProvenanceFile[] {
  const byPath = new Map<string, ProvenanceEntry[]>();
  for (const entry of entries) {
    const list = byPath.get(entry.filePath);
    if (list) list.push(entry);
    else byPath.set(entry.filePath, [entry]);
  }

  return [...byPath.entries()]
    .map(([filePath, fileEntries]) => {
      const providers = new Set(
        fileEntries.flatMap((entry) => (entry.provider ? [entry.provider] : [])),
      );
      const models = new Set(fileEntries.flatMap((entry) => (entry.model ? [entry.model] : [])));
      const lastCapturedAt = fileEntries.reduce(
        (latest, entry) => (entry.capturedAt > latest ? entry.capturedAt : latest),
        fileEntries[0]?.capturedAt ?? new Date(0).toISOString(),
      );

      return {
        path: filePath,
        aiLines: countAttributedLines(fileEntries),
        lineRanges: fileEntries.length,
        entries: fileEntries.length,
        providers: [...providers].sort(),
        models: [...models].sort(),
        lastCapturedAt,
      };
    })
    .sort((a, b) => b.aiLines - a.aiLines || a.path.localeCompare(b.path));
}
