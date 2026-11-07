import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ApiErrorCode,
  CapturedStep,
  CreateReplayForkInput,
  ReplayFileChange,
  ReplayFork,
  Session,
} from '@cockpit/core';

import type { CockpitConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';
import { commitExists, resolveGitWorkspace } from '../git/snapshots.js';
import { runGit } from '../git/run.js';

const PROMPT_EXCERPT_CHARS = 4_000;
const RESPONSE_EXCERPT_CHARS = 4_000;

type ForkErrorCode = Extract<
  ApiErrorCode,
  'bad_request' | 'not_found' | 'conflict' | 'internal_error'
>;

export class ForkError extends Error {
  readonly status: number;
  readonly code: ForkErrorCode;

  constructor(status: number, code: ForkErrorCode, message: string) {
    super(message);
    this.name = 'ForkError';
    this.status = status;
    this.code = code;
  }
}

export interface ForkServiceOptions {
  store: Store;
  config: CockpitConfig;
  logger: Logger;
}

function clipText(text: string, maximum: number): string {
  const trimmed = text.trim();
  return trimmed.length > maximum ? `${trimmed.slice(0, maximum)}\n…` : trimmed;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'fork'
  );
}

function fence(text: string): string {
  return ['```text', text.replace(/```/g, "'''"), '```'].join('\n');
}

function stepPrompt(step: CapturedStep | undefined): string {
  if (!step?.request) return '';
  if (step.request.promptText) return step.request.promptText;
  if (step.request.systemPrompt) return step.request.systemPrompt;
  return '';
}

function stepResponse(step: CapturedStep | undefined): string {
  if (!step) return '';
  if (step.response?.text) return step.response.text;
  if (step.response?.error) return step.response.error;
  if (step.error) return step.error;
  return '';
}

function fileChangeLines(fileChanges: ReplayFileChange[]): string {
  if (fileChanges.length === 0) return '- No file changes were captured in this snapshot.';
  return fileChanges
    .map(
      (change) =>
        `- \`${change.path}\` (${change.changeType}, +${String(change.additions)} / -${String(change.deletions)})`,
    )
    .join('\n');
}

function toolCallLines(store: Store, step: CapturedStep | undefined): string {
  if (!step) return '- No tool calls were recorded.';
  const calls = store.listToolCalls(step.id);
  if (calls.length === 0) return '- No tool calls were recorded.';
  return calls
    .map((call) => {
      const files = call.filePaths.length > 0 ? ` — ${call.filePaths.join(', ')}` : '';
      return `- ${call.name} (${call.status})${files}`;
    })
    .join('\n');
}

function buildResumeBrief(input: {
  session: Session;
  step: CapturedStep | undefined;
  branch: string;
  worktreePath: string;
  baseCommit: string;
  stepNumber: number | undefined;
  fileChanges: ReplayFileChange[];
  toolCalls: string;
}): string {
  const { session, step, branch, worktreePath, baseCommit, stepNumber, fileChanges, toolCalls } =
    input;
  const prompt = clipText(stepPrompt(step), PROMPT_EXCERPT_CHARS);
  const response = clipText(stepResponse(step), RESPONSE_EXCERPT_CHARS);
  const generatedAt = new Date().toISOString();
  const stepHeading =
    stepNumber === undefined ? 'Latest recorded state' : `Step ${String(stepNumber)}`;

  const resumePrompt = [
    'You are resuming an AI coding session recorded by Cockpit.',
    '',
    `Working directory: ${worktreePath}`,
    `Branch: ${branch}`,
    `Base snapshot: ${baseCommit}`,
    `Session: ${session.title}`,
    session.agent?.name ? `Original agent: ${session.agent.name}` : '',
    session.modelRef?.model ? `Model: ${session.modelRef.model}` : '',
    '',
    prompt ? `Latest user prompt:\n${prompt}` : 'No prompt text was captured for this step.',
    response ? `\nLatest model response:\n${response}` : '',
    '',
    `Files changed in the latest snapshot:\n${fileChanges
      .map(
        (change) =>
          `- ${change.path} (${change.changeType}, +${String(change.additions)} / -${String(change.deletions)})`,
      )
      .join('\n')}`,
    '',
    'Continue from this worktree. Re-read the changed files before editing, run the relevant tests,',
    'and keep the change focused on the original task.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return [
    '# Cockpit resume brief',
    '',
    `Generated ${generatedAt} from session \`${session.id}\`.`,
    '',
    '## Where to work',
    '',
    `- Worktree: \`${worktreePath}\``,
    `- Branch: \`${branch}\``,
    `- Base snapshot: \`${baseCommit}\``,
    `- Session: ${session.title}`,
    ...(session.agent?.name ? [`- Agent: ${session.agent.name}`] : []),
    ...(session.modelRef?.model ? [`- Model: ${session.modelRef.model}`] : []),
    ...(session.workspacePath ? [`- Original workspace: \`${session.workspacePath}\``] : []),
    '',
    `## ${stepHeading}`,
    '',
    step ? `Status: **${step.status}** · ${step.startedAt}` : 'No model step was recorded.',
    '',
    '### Prompt',
    '',
    prompt ? fence(prompt) : '_No prompt text was captured._',
    '',
    '### Response',
    '',
    response ? fence(response) : '_No model response was captured._',
    '',
    '### Tool calls',
    '',
    toolCalls,
    '',
    '### Snapshot file changes',
    '',
    fileChangeLines(fileChanges),
    '',
    '## Resume prompt',
    '',
    fence(resumePrompt),
    '',
    '## Notes',
    '',
    `- Cockpit wrote this brief to \`${path.join(worktreePath, 'COCKPIT_RESUME.md')}\`.`,
    '- The fork branch starts at the recorded snapshot. The original branch was not modified.',
    '- Snapshot commits are detached objects; do not expect them in `git log` on your branch.',
    '',
  ].join('\n');
}

export class ForkService {
  readonly #store: Store;
  readonly #config: CockpitConfig;
  readonly #logger: Logger;

  constructor(options: ForkServiceOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#logger = options.logger;
  }

  async create(session: Session, input: CreateReplayForkInput): Promise<ReplayFork> {
    if (!session.workspacePath) {
      throw new ForkError(
        409,
        'conflict',
        'This session has no workspace path, so Cockpit cannot create a git worktree.',
      );
    }

    const snapshot = this.#store.resolveSnapshotForStep(session.id, input.stepId);
    if (!snapshot?.commitSha) {
      throw new ForkError(
        409,
        'conflict',
        'No git snapshot is available for this step yet. Start another step or end the session to flush the snapshot, then try again.',
      );
    }

    const workspace = await resolveGitWorkspace(session.workspacePath);
    if (!workspace) {
      throw new ForkError(
        409,
        'conflict',
        'The session workspace is not an accessible git repository.',
      );
    }
    if (!(await commitExists(workspace.root, snapshot.commitSha))) {
      throw new ForkError(
        409,
        'conflict',
        'The snapshot commit is missing from the workspace repository. It may have been garbage collected.',
      );
    }

    const suffix = randomUUID().slice(0, 8);
    const stepPart = input.stepId ? `step-${suffix}` : `base-${suffix}`;
    const branch = input.branch?.trim() || `cockpit/fork-${session.id.slice(0, 8)}-${stepPart}`;
    await this.#assertBranchAvailable(workspace.root, branch);

    const worktreePath = await this.#uniqueWorktreePath(session.id, suffix);
    const step = input.stepId ? this.#store.getStep(input.stepId) : this.#latestStep(session.id);
    const validStep = step?.sessionId === session.id ? step : undefined;
    const fileChanges = this.#store.listSnapshotFileChanges(snapshot.id);
    const resumeBrief = buildResumeBrief({
      session,
      step: validStep,
      branch,
      worktreePath,
      baseCommit: snapshot.commitSha,
      stepNumber: validStep ? validStep.seq + 1 : undefined,
      fileChanges,
      toolCalls: toolCallLines(this.#store, validStep),
    });

    let worktreeCreated = false;
    try {
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await runGit(['worktree', 'add', '-b', branch, worktreePath, snapshot.commitSha], {
        cwd: workspace.root,
      });
      worktreeCreated = true;
      await writeFile(path.join(worktreePath, 'COCKPIT_RESUME.md'), resumeBrief, 'utf8');

      return this.#store.insertFork({
        sessionId: session.id,
        ...(validStep ? { stepId: validStep.id } : {}),
        branch,
        worktreePath,
        baseCommit: snapshot.commitSha,
        resumeBrief,
        status: 'ready',
      });
    } catch (error) {
      if (worktreeCreated) {
        await runGit(['worktree', 'remove', '--force', worktreePath], {
          cwd: workspace.root,
          allowFailure: true,
        });
      }
      if (error instanceof ForkError) throw error;
      this.#logger.warn('Cockpit could not create a replay fork', error);
      throw new ForkError(
        500,
        'internal_error',
        'Cockpit could not create the fork worktree. See the daemon log for details.',
      );
    }
  }

  async remove(forkId: string): Promise<ReplayFork> {
    const fork = this.#store.getFork(forkId);
    if (!fork) throw new ForkError(404, 'not_found', 'The requested fork was not found.');
    if (fork.status === 'removed') return fork;

    this.#assertManagedWorktree(fork.worktreePath);

    const session = this.#store.getSession(fork.sessionId);
    if (!session?.workspacePath) {
      throw new ForkError(409, 'conflict', 'The fork session has no workspace path.');
    }

    const workspace = await resolveGitWorkspace(session.workspacePath);
    if (!workspace) {
      throw new ForkError(409, 'conflict', 'The fork workspace is not a git repository.');
    }

    if (await this.#pathExists(fork.worktreePath)) {
      const result = await runGit(['worktree', 'remove', '--force', fork.worktreePath], {
        cwd: workspace.root,
        allowFailure: true,
      });
      if (result.exitCode !== 0) {
        throw new ForkError(
          500,
          'internal_error',
          'Cockpit could not remove the fork worktree. See the daemon log for details.',
        );
      }
    }
    await runGit(['worktree', 'prune'], { cwd: workspace.root, allowFailure: true });

    const updated = this.#store.updateForkStatus(fork.id, 'removed');
    if (!updated) throw new ForkError(404, 'not_found', 'The requested fork was not found.');
    return updated;
  }

  #latestStep(sessionId: string): CapturedStep | undefined {
    return this.#store.listSteps(sessionId, 1_000_000).at(-1);
  }

  async #assertBranchAvailable(root: string, branch: string): Promise<void> {
    const valid = await runGit(['check-ref-format', '--branch', branch], {
      cwd: root,
      allowFailure: true,
    });
    if (valid.exitCode !== 0) {
      throw new ForkError(400, 'bad_request', 'The requested branch name is not valid in git.');
    }

    const existing = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: root,
      allowFailure: true,
    });
    if (existing.exitCode === 0) {
      throw new ForkError(409, 'conflict', `The branch "${branch}" already exists.`);
    }
  }

  async #uniqueWorktreePath(sessionId: string, suffix: string): Promise<string> {
    const base = path.join(
      this.#config.paths.forksDirectory,
      slug(`fork-${sessionId.slice(0, 8)}-${suffix}`),
    );
    if (!(await this.#pathExists(base))) return base;

    for (let attempt = 1; attempt < 20; attempt += 1) {
      const candidate = `${base}-${String(attempt)}`;
      if (!(await this.#pathExists(candidate))) return candidate;
    }
    throw new ForkError(500, 'internal_error', 'Cockpit could not allocate a fork worktree path.');
  }

  #assertManagedWorktree(worktreePath: string): void {
    const resolved = path.resolve(worktreePath);
    const base = path.resolve(this.#config.paths.forksDirectory);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
      throw new ForkError(
        400,
        'bad_request',
        'Refusing to remove a worktree outside the Cockpit forks directory.',
      );
    }
  }

  async #pathExists(candidate: string): Promise<boolean> {
    try {
      await access(candidate);
      return true;
    } catch {
      return false;
    }
  }
}
