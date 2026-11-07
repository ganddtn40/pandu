import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FileChangeType, ReplaySnapshot, Session } from '@cockpit/core';

import type { Logger } from '../logger.js';
import type { SnapshotFileChangeInput, Store } from '../store/store.js';
import { GitCommandError, runGit } from './run.js';

const MAX_STORED_FILES = 500;
const MAX_FILE_DIFF_CHARS = 300_000;
const MAX_PATCH_CHARS = 2_000_000;
const DIFF_CONCURRENCY = 4;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export interface GitWorkspace {
  root: string;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  changeType: FileChangeType;
  additions: number;
  deletions: number;
  diff?: string;
}

export interface SnapshotDiff {
  patch: string;
  files: DiffFile[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface StepSnapshotRecorder {
  noteStepStarted(sessionId: string, stepId: string): void;
}

export interface SessionSnapshotRecorder {
  noteSessionEnded(sessionId: string): void;
}

export interface GitSnapshotServiceOptions {
  store: Store;
  logger: Logger;
  onSnapshot?: (snapshot: ReplaySnapshot) => void;
}

function clip(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum)}\n… diff truncated by Cockpit …\n`;
}

function gitIdentityEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: 'Cockpit',
    GIT_AUTHOR_EMAIL: 'cockpit@localhost',
    GIT_COMMITTER_NAME: 'Cockpit',
    GIT_COMMITTER_EMAIL: 'cockpit@localhost',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function literalPathspec(filePath: string): string {
  return `:(literal)${filePath}`;
}

function cleanBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const trimmed = branch.trim();
  if (trimmed.length === 0 || trimmed === 'HEAD') return undefined;
  return trimmed;
}

export async function resolveGitWorkspace(
  workspacePath: string,
): Promise<GitWorkspace | undefined> {
  try {
    const info = await stat(workspacePath);
    if (!info.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const result = await runGit(['rev-parse', '--show-toplevel'], {
    cwd: workspacePath,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return undefined;

  const root = result.stdout.trim();
  if (root.length === 0) return undefined;
  return { root: path.resolve(root) };
}

export async function resolveHead(root: string): Promise<string | undefined> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: root,
    allowFailure: true,
  });
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !COMMIT_SHA_PATTERN.test(sha)) return undefined;
  return sha;
}

export async function currentBranch(root: string): Promise<string | undefined> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return undefined;
  return cleanBranch(result.stdout);
}

export async function commitExists(root: string, commitSha: string): Promise<boolean> {
  const result = await runGit(['cat-file', '-e', `${commitSha}^{commit}`], {
    cwd: root,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

/**
 * Build a commit object from the current working tree without touching the
 * user's index, HEAD, or branch. `GIT_INDEX_FILE` points at a throwaway index,
 * so in-progress `git add` sessions in another terminal are unaffected.
 */
export async function createWorkingTreeCommit(
  root: string,
  parentSha: string | undefined,
  message: string,
): Promise<string> {
  const indexPath = path.join(tmpdir(), `cockpit-index-${randomUUID()}`);
  const env = gitIdentityEnv(indexPath);

  try {
    await runGit(['add', '-A', '--', '.'], { cwd: root, env });
    const tree = (await runGit(['write-tree'], { cwd: root, env })).stdout.trim();
    if (tree.length === 0) throw new Error('Git returned an empty tree.');

    const args = ['commit-tree', tree, '-m', message.replace(/\s+/g, ' ').slice(0, 500)];
    if (parentSha) args.push('-p', parentSha);
    const commitSha = (await runGit(args, { cwd: root, env })).stdout.trim();
    if (!COMMIT_SHA_PATTERN.test(commitSha)) {
      throw new Error('Git did not return a valid snapshot commit.');
    }
    return commitSha;
  } finally {
    await rm(indexPath, { force: true, maxRetries: 2 }).catch(() => undefined);
  }
}

interface NameStatusEntry {
  path: string;
  oldPath?: string;
  changeType: FileChangeType;
}

interface NumstatEntry {
  additions: number;
  deletions: number;
}

function parseNameStatus(output: string): NameStatusEntry[] {
  const tokens = output.split('\0');
  const entries: NameStatusEntry[] = [];
  let index = 0;

  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (!status) continue;

    const letter = status[0] ?? 'M';
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      if (!oldPath || !newPath) continue;
      entries.push({
        path: newPath,
        oldPath,
        changeType: letter === 'R' ? 'renamed' : 'added',
      });
      continue;
    }

    const filePath = tokens[index];
    index += 1;
    if (!filePath) continue;
    const changeType: FileChangeType =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    entries.push({ path: filePath, changeType });
  }

  return entries;
}

function parseNumstat(output: string): Map<string, NumstatEntry> {
  const tokens = output.split('\0');
  const entries = new Map<string, NumstatEntry>();
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (!token) continue;

    const parts = token.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : Number(parts[0] ?? 0);
    const deletions = parts[1] === '-' ? 0 : Number(parts[1] ?? 0);
    let filePath = parts[2] ?? '';

    if (filePath.length === 0) {
      // Renames and copies carry the old and new path in two extra tokens.
      index += 1;
      filePath = tokens[index] ?? '';
      index += 1;
    }

    if (!filePath) continue;
    entries.set(filePath, {
      additions: Number.isFinite(additions) ? Math.max(0, additions) : 0,
      deletions: Number.isFinite(deletions) ? Math.max(0, deletions) : 0,
    });
  }

  return entries;
}

function changeDiffArgs(parentSha: string, commitSha: string, entry: NameStatusEntry): string[] {
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--unified=3',
    '--find-renames',
    parentSha,
    commitSha,
    '--',
  ];
  if (entry.oldPath && entry.oldPath !== entry.path) {
    args.push(literalPathspec(entry.oldPath), literalPathspec(entry.path));
  } else {
    args.push(literalPathspec(entry.path));
  }
  return args;
}

export async function diffSnapshots(
  root: string,
  parentSha: string,
  commitSha: string,
): Promise<SnapshotDiff> {
  const [nameStatus, numstat] = await Promise.all([
    runGit(
      ['diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', parentSha, commitSha],
      {
        cwd: root,
      },
    ),
    runGit(['diff', '--numstat', '-z', '--find-renames', '--no-ext-diff', parentSha, commitSha], {
      cwd: root,
    }),
  ]);

  const entries = parseNameStatus(nameStatus.stdout);
  const stats = parseNumstat(numstat.stdout);
  const files: DiffFile[] = entries.map((entry) => {
    const statEntry = stats.get(entry.path);
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      changeType: entry.changeType,
      additions: statEntry?.additions ?? 0,
      deletions: statEntry?.deletions ?? 0,
    };
  });

  const stored = files.slice(0, MAX_STORED_FILES);
  const diffs: string[] = new Array<string>(stored.length).fill('');

  for (let offset = 0; offset < stored.length; offset += DIFF_CONCURRENCY) {
    const batch = stored.slice(offset, offset + DIFF_CONCURRENCY);
    const batchDiffs = await Promise.all(
      batch.map(async (entry) => {
        const result = await runGit(changeDiffArgs(parentSha, commitSha, entry), {
          cwd: root,
          maxBuffer: 16 * 1024 * 1024,
        });
        return clip(result.stdout, MAX_FILE_DIFF_CHARS);
      }),
    );
    for (let index = 0; index < batchDiffs.length; index += 1) {
      diffs[offset + index] = batchDiffs[index] ?? '';
    }
  }

  for (let index = 0; index < stored.length; index += 1) {
    stored[index] = { ...stored[index], diff: diffs[index] ?? '' } as DiffFile;
  }

  const insertions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);

  return {
    patch: clip(diffs.join(''), MAX_PATCH_CHARS),
    files: stored,
    filesChanged: files.length,
    insertions,
    deletions,
  };
}

/**
 * Captures the working tree after a step and chains snapshots through shadow
 * commits. Snapshot commits are unreferenced by design: the user's branch and
 * reflog are never rewritten.
 */
export class GitSnapshotService implements StepSnapshotRecorder, SessionSnapshotRecorder {
  readonly #store: Store;
  readonly #logger: Logger;
  readonly #onSnapshot: ((snapshot: ReplaySnapshot) => void) | undefined;
  readonly #pendingSteps = new Map<string, string>();
  readonly #baselines = new Map<string, Promise<void>>();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: GitSnapshotServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#onSnapshot = options.onSnapshot;
  }

  ensureBaseline(session: Session): Promise<void> {
    const existing = this.#baselines.get(session.id);
    if (existing) return existing;

    const task = this.#enqueue(() => this.#captureBase(session));
    this.#baselines.set(session.id, task);
    return task;
  }

  noteStepStarted(sessionId: string, stepId: string): void {
    const previousStepId = this.#pendingSteps.get(sessionId);
    this.#pendingSteps.set(sessionId, stepId);

    void this.#enqueue(async () => {
      const session = this.#store.getSession(sessionId);
      if (!session) return;

      if (previousStepId) {
        await this.#captureAfter(session, previousStepId);
        return;
      }

      const snapshots = this.#store.listSnapshots(sessionId);
      if (snapshots.length === 0) await this.#captureBase(session);
    });
  }

  noteSessionEnded(sessionId: string): void {
    const pendingStepId = this.#pendingSteps.get(sessionId);
    this.#pendingSteps.delete(sessionId);
    if (!pendingStepId) return;

    void this.#enqueue(async () => {
      const session = this.#store.getSession(sessionId);
      if (!session) return;
      await this.#captureAfter(session, pendingStepId);
    });
  }

  /**
   * Wait for the previous step's snapshot before the next step starts. Tool
   * side effects land between model calls, so the snapshot must capture the
   * tree at the boundary — but the next request must not race that capture and
   * get its own changes attributed to the previous step.
   */
  async settlePendingStep(sessionId: string): Promise<void> {
    const job = this.#drainSession(sessionId);
    if (job) await job;
  }

  async flushSession(sessionId: string): Promise<void> {
    const job = this.#drainSession(sessionId);
    if (job) {
      await job;
      return;
    }
    await this.#waitForQueue();
  }

  async flushAll(): Promise<void> {
    const pending = [...this.#pendingSteps.keys()];
    await Promise.all(pending.map((sessionId) => this.flushSession(sessionId)));
    await this.#waitForQueue();
  }

  #drainSession(sessionId: string): Promise<void> | undefined {
    const pendingStepId = this.#pendingSteps.get(sessionId);
    if (!pendingStepId) return undefined;
    this.#pendingSteps.delete(sessionId);

    return this.#enqueue(async () => {
      const session = this.#store.getSession(sessionId);
      if (!session) return;
      await this.#captureAfter(session, pendingStepId);
    });
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(job).catch((error: unknown) => {
      this.#logger.warn('Cockpit could not capture a git snapshot', error);
    });
    this.#queue = run;
    return run;
  }

  async #waitForQueue(): Promise<void> {
    for (;;) {
      const tail = this.#queue;
      await tail;
      if (tail === this.#queue) return;
    }
  }

  async #captureBase(session: Session): Promise<void> {
    if (!session.workspacePath) return;

    try {
      const workspace = await resolveGitWorkspace(session.workspacePath);
      if (!workspace) {
        this.#logger.debug('Workspace is not a git repository; replay snapshots disabled', {
          sessionId: session.id,
        });
        return;
      }

      const head = await resolveHead(workspace.root);
      const commitSha = await createWorkingTreeCommit(
        workspace.root,
        head,
        `cockpit: baseline ${session.id}`,
      );
      const branch = (await currentBranch(workspace.root)) ?? session.gitBranch;

      const snapshot = this.#store.insertSnapshot({
        sessionId: session.id,
        kind: 'before',
        commitSha,
        ...(head ? { parentCommitSha: head } : {}),
        ...(branch ? { branch } : {}),
        worktreePath: workspace.root,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        fileChanges: [],
      });
      this.#notifySnapshot(snapshot);
    } catch (error) {
      this.#logCaptureFailure(session, error);
    }
  }

  async #captureAfter(session: Session, stepId: string): Promise<void> {
    if (!session.workspacePath) return;

    try {
      let snapshots = this.#store.listSnapshots(session.id);
      if (snapshots.length === 0) {
        await this.#captureBase(session);
        snapshots = this.#store.listSnapshots(session.id);
      }

      const previous = snapshots.at(-1);
      if (!previous?.commitSha) return;

      const workspace = await resolveGitWorkspace(session.workspacePath);
      if (!workspace) return;

      if (!(await commitExists(workspace.root, previous.commitSha))) {
        this.#logger.debug('The previous snapshot commit is missing; recapturing baseline', {
          sessionId: session.id,
          commitSha: previous.commitSha,
        });
        await this.#captureBase(session);
        return;
      }

      const commitSha = await createWorkingTreeCommit(
        workspace.root,
        previous.commitSha,
        `cockpit: step ${stepId} in ${session.id}`,
      );
      const diff = await diffSnapshots(workspace.root, previous.commitSha, commitSha);
      const branch = (await currentBranch(workspace.root)) ?? session.gitBranch;
      const step = this.#store.getStep(stepId);
      const validStepId = step?.sessionId === session.id ? stepId : undefined;

      const snapshot = this.#store.insertSnapshot({
        sessionId: session.id,
        ...(validStepId ? { stepId: validStepId } : {}),
        kind: 'after',
        commitSha,
        parentCommitSha: previous.commitSha,
        ...(branch ? { branch } : {}),
        worktreePath: workspace.root,
        ...(diff.patch.length > 0 ? { patch: diff.patch } : {}),
        filesChanged: diff.filesChanged,
        insertions: diff.insertions,
        deletions: diff.deletions,
        fileChanges: diff.files.map((file): SnapshotFileChangeInput => ({
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          changeType: file.changeType,
          additions: file.additions,
          deletions: file.deletions,
          ...(file.diff ? { diff: file.diff } : {}),
        })),
      });
      this.#notifySnapshot(snapshot);
    } catch (error) {
      this.#logCaptureFailure(session, error);
    }
  }

  #notifySnapshot(snapshot: ReplaySnapshot): void {
    if (!this.#onSnapshot) return;
    try {
      this.#onSnapshot(snapshot);
    } catch (error) {
      this.#logger.warn('Cockpit snapshot listener failed', error);
    }
  }

  #logCaptureFailure(session: Session, error: unknown): void {
    this.#logger.warn('Cockpit could not capture a git snapshot', {
      sessionId: session.id,
      message:
        error instanceof GitCommandError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
    });
  }
}
