import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CreateReplayForkResponseSchema,
  ReplayForksResponseSchema,
  SessionReplayResponseSchema,
  SnapshotDetailResponseSchema,
  type Session,
} from '@cockpit/core';
import type { StartedDaemon } from '../src/index.js';
import { collectNonStreamResponse } from '../src/sse/collector.js';

import {
  startTestDaemon,
  startUpstream,
  type FakeUpstream,
  type UpstreamHandler,
} from './helpers.js';

interface ReplayContext {
  directory: string;
  repository: string;
  upstream: FakeUpstream;
  daemon: StartedDaemon;
}

const CONTEXTS: ReplayContext[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function boot(handlerOverride?: UpstreamHandler): Promise<ReplayContext> {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-replay-'));
  const repository = path.join(directory, 'workspace');
  mkdirSync(repository, { recursive: true });

  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.name', 'Cockpit Test']);
  git(repository, ['config', 'user.email', 'cockpit-test@localhost']);
  writeFileSync(path.join(repository, 'app.ts'), 'export const retry = 1;\n', 'utf8');
  writeFileSync(path.join(repository, 'README.md'), '# Demo project\n', 'utf8');
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'initial']);

  const handler: UpstreamHandler =
    handlerOverride ??
    ((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-replay',
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Done.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      );
    });
  const upstream = await startUpstream(handler);
  const daemon = await startTestDaemon({
    home: path.join(directory, 'home'),
    openAiUpstream: upstream.url,
  });

  const context = { directory, repository, upstream, daemon };
  CONTEXTS.push(context);
  return context;
}

afterEach(async () => {
  while (CONTEXTS.length > 0) {
    const context = CONTEXTS.pop();
    if (!context) continue;
    await context.daemon.close().catch(() => undefined);
    await context.upstream.close().catch(() => undefined);
    rmSync(context.directory, { recursive: true, force: true });
  }
});

function completeStep(
  context: ReplayContext,
  session: Session,
  prompt: string,
): ReturnType<StartedDaemon['recorder']['begin']> {
  const handle = context.daemon.recorder.begin({
    sessionId: session.id,
    protocol: 'openai',
    provider: 'openai',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  context.daemon.recorder.finish(handle, {
    status: 'completed',
    responseStatus: 200,
    responseHeaders: { 'content-type': 'application/json' },
    collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
      id: 'chatcmpl-replay',
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Done.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }),
  });
  return handle;
}

describe('git snapshots, replay, and forks', () => {
  it('captures a chained snapshot after each step and exposes replay diffs', async () => {
    const context = await boot();
    const { daemon, repository } = context;

    const session = daemon.sessions.create({
      source: 'manual',
      title: 'Replay fixture',
      tags: [],
      workspacePath: repository,
      gitBranch: 'main',
    });

    await daemon.snapshots.ensureBaseline(session);
    const baseline = daemon.store.listSnapshots(session.id);
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.kind).toBe('before');
    expect(baseline[0]?.commitSha).toBeDefined();

    const stepOne = completeStep(context, session, 'Fix the retry constant');
    writeFileSync(path.join(repository, 'app.ts'), 'export const retry = 3;\n', 'utf8');
    await daemon.snapshots.flushSession(session.id);

    const stepTwo = completeStep(context, session, 'Update the docs');
    writeFileSync(path.join(repository, 'README.md'), '# Demo project\n\nDocs updated.\n', 'utf8');
    daemon.sessions.endSession(session.id, 'completed');
    await daemon.snapshots.flushAll();

    const snapshots = daemon.store.listSnapshots(session.id);
    expect(snapshots.map((snapshot) => snapshot.kind)).toEqual(['before', 'after', 'after']);
    expect(snapshots[1]?.stepId).toBe(stepOne.step.id);
    expect(snapshots[2]?.stepId).toBe(stepTwo.step.id);
    expect(snapshots[2]?.parentCommitSha).toBe(snapshots[1]?.commitSha);

    const firstChanges = daemon.store.listSnapshotFileChanges(snapshots[1]?.id ?? '');
    expect(firstChanges.map((change) => change.path)).toEqual(['app.ts']);
    expect(firstChanges[0]?.diff).toContain('+export const retry = 3;');
    expect(firstChanges[0]?.additions).toBe(1);
    expect(firstChanges[0]?.deletions).toBe(1);

    const secondChanges = daemon.store.listSnapshotFileChanges(snapshots[2]?.id ?? '');
    expect(secondChanges.map((change) => change.path)).toEqual(['README.md']);

    expect(daemon.store.resolveSnapshotForStep(session.id, stepOne.step.id)?.id).toBe(
      snapshots[1]?.id,
    );
    expect(daemon.store.resolveSnapshotForStep(session.id, stepTwo.step.id)?.id).toBe(
      snapshots[2]?.id,
    );

    const replayResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/replay`);
    expect(replayResponse.status).toBe(200);
    expect(replayResponse.headers.get('cache-control')).toBe('no-store');
    const replay = SessionReplayResponseSchema.parse(await replayResponse.json());
    expect(replay.steps).toHaveLength(2);
    expect(replay.steps[0]?.request?.promptText).toContain('Fix the retry constant');
    expect(replay.snapshots).toHaveLength(3);
    expect(replay.snapshots[1]?.stepId).toBe(stepOne.step.id);
    expect(replay.snapshots[1]).not.toHaveProperty('patch');
    expect(replay.forks).toEqual([]);

    const detailResponse = await fetch(`${daemon.url}/api/snapshots/${snapshots[1]?.id ?? ''}`);
    expect(detailResponse.status).toBe(200);
    const detail = SnapshotDetailResponseSchema.parse(await detailResponse.json());
    expect(detail.snapshot.id).toBe(snapshots[1]?.id);
    expect(detail.fileChanges).toHaveLength(1);
    expect(detail.fileChanges[0]?.diff).toContain('+export const retry = 3;');

    const missing = await fetch(`${daemon.url}/api/snapshots/00000000-0000-4000-8000-000000000000`);
    expect(missing.status).toBe(404);
  });

  it('captures the previous step before the next model call starts', async () => {
    const refs: { daemon?: StartedDaemon; session?: Session } = {};
    const observedSnapshotCounts: number[] = [];

    const context = await boot((_request, response) => {
      if (refs.daemon && refs.session) {
        observedSnapshotCounts.push(refs.daemon.store.listSnapshots(refs.session.id).length);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-replay',
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Done.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      );
    });

    refs.daemon = context.daemon;
    const { daemon, repository } = context;
    const session = daemon.sessions.create({
      source: 'manual',
      title: 'Snapshot race fixture',
      tags: [],
      workspacePath: repository,
      gitBranch: 'main',
    });
    refs.session = session;

    const callModel = async (prompt: string): Promise<void> => {
      const response = await fetch(`${daemon.url}/s/${session.id}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
    };

    await callModel('Fix the retry constant');
    writeFileSync(path.join(repository, 'app.ts'), 'export const retry = 3;\n', 'utf8');

    await callModel('Update the docs');
    writeFileSync(path.join(repository, 'README.md'), '# Demo project\n\nDocs updated.\n', 'utf8');

    daemon.sessions.endSession(session.id, 'completed');
    await daemon.snapshots.flushAll();

    // The second upstream call must not begin until step one is captured.
    expect(observedSnapshotCounts).toEqual([1, 2]);

    const snapshots = daemon.store.listSnapshots(session.id);
    expect(snapshots.map((snapshot) => snapshot.kind)).toEqual(['before', 'after', 'after']);

    const stepOneChanges = daemon.store.listSnapshotFileChanges(snapshots[1]?.id ?? '');
    expect(stepOneChanges.map((change) => change.path)).toEqual(['app.ts']);
    expect(
      git(repository, ['show', `${snapshots[1]?.commitSha ?? 'HEAD'}:README.md`]),
    ).not.toContain('Docs updated.');

    const stepTwoChanges = daemon.store.listSnapshotFileChanges(snapshots[2]?.id ?? '');
    expect(stepTwoChanges.map((change) => change.path)).toEqual(['README.md']);
  });

  it('creates a worktree fork at the selected step with a resume brief', async () => {
    const context = await boot();
    const { daemon, repository } = context;

    const session = daemon.sessions.create({
      source: 'manual',
      title: 'Fork fixture',
      tags: [],
      workspacePath: repository,
      gitBranch: 'main',
    });

    await daemon.snapshots.ensureBaseline(session);
    const stepOne = completeStep(context, session, 'Fix the retry constant');
    writeFileSync(path.join(repository, 'app.ts'), 'export const retry = 3;\n', 'utf8');
    await daemon.snapshots.flushSession(session.id);

    const stepTwo = completeStep(context, session, 'Update the docs');
    writeFileSync(path.join(repository, 'README.md'), '# Demo project\n\nDocs updated.\n', 'utf8');
    daemon.sessions.endSession(session.id, 'completed');
    await daemon.snapshots.flushAll();

    const branch = `cockpit/test-fork-${String(Date.now())}`;
    const forkResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/forks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepId: stepOne.step.id, branch }),
    });
    expect(forkResponse.status).toBe(201);
    const { fork } = CreateReplayForkResponseSchema.parse(await forkResponse.json());
    expect(fork.status).toBe('ready');
    expect(fork.branch).toBe(branch);
    expect(fork.stepId).toBe(stepOne.step.id);
    expect(fork.baseCommit).toBe(daemon.store.listSnapshots(session.id)[1]?.commitSha ?? undefined);
    expect(fork.worktreePath.startsWith(path.join(context.directory, 'home', 'forks'))).toBe(true);
    expect(existsSync(fork.worktreePath)).toBe(true);

    const forkedApp = readFileSync(path.join(fork.worktreePath, 'app.ts'), 'utf8');
    expect(forkedApp).toContain('export const retry = 3;');
    const forkedReadme = readFileSync(path.join(fork.worktreePath, 'README.md'), 'utf8');
    expect(forkedReadme).not.toContain('Docs updated.');

    const resumeBrief = readFileSync(path.join(fork.worktreePath, 'COCKPIT_RESUME.md'), 'utf8');
    expect(resumeBrief).toContain('# Cockpit resume brief');
    expect(resumeBrief).toContain('Fix the retry constant');
    expect(resumeBrief).toContain(branch);
    expect(fork.resumeBrief).toBe(resumeBrief);

    expect(git(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(git(repository, ['rev-parse', '--verify', `refs/heads/${branch}`]).trim()).toHaveLength(
      40,
    );

    const duplicate = await fetch(`${daemon.url}/api/sessions/${session.id}/forks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepId: stepTwo.step.id, branch }),
    });
    expect(duplicate.status).toBe(409);

    const forksResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/forks`);
    const forks = ReplayForksResponseSchema.parse(await forksResponse.json());
    expect(forks.forks).toHaveLength(1);
    expect(forks.forks[0]?.id).toBe(fork.id);

    const removeResponse = await fetch(`${daemon.url}/api/forks/${fork.id}`, {
      method: 'DELETE',
    });
    expect(removeResponse.status).toBe(200);
    const removed = (await removeResponse.json()) as { fork: { status: string } };
    expect(removed.fork.status).toBe('removed');
    expect(existsSync(fork.worktreePath)).toBe(false);
    expect(git(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
  });

  it('refuses to fork when the workspace is not a git repository', async () => {
    const context = await boot();
    const { daemon } = context;

    const plainDirectory = path.join(context.directory, 'plain');
    mkdirSync(plainDirectory, { recursive: true });
    writeFileSync(path.join(plainDirectory, 'notes.txt'), 'not a repo\n', 'utf8');

    const session = daemon.sessions.create({
      source: 'manual',
      title: 'No git',
      tags: [],
      workspacePath: plainDirectory,
    });

    await daemon.snapshots.ensureBaseline(session);
    expect(daemon.store.listSnapshots(session.id)).toEqual([]);

    const response = await fetch(`${daemon.url}/api/sessions/${session.id}/forks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('conflict');

    const removeMissing = await fetch(
      `${daemon.url}/api/forks/00000000-0000-4000-8000-000000000000`,
      { method: 'DELETE' },
    );
    expect(removeMissing.status).toBe(404);
  });
});
