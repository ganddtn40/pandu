import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcknowledgeUnderstandingResponseSchema,
  ContextSnapshotDetailResponseSchema,
  ExplainUnderstandingResponseSchema,
  QuizStartResponseSchema,
  QuizSubmitResponseSchema,
  SessionContextResponseSchema,
  SessionProvenanceResponseSchema,
  UnderstandingDetailResponseSchema,
  UnderstandingListResponseSchema,
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

interface PhaseSixContext {
  directory: string;
  repository: string;
  upstream: FakeUpstream;
  daemon: StartedDaemon;
}

const CONTEXTS: PhaseSixContext[] = [];
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function boot(): Promise<PhaseSixContext> {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-phase6-'));
  const repository = path.join(directory, 'workspace');
  mkdirSync(repository, { recursive: true });

  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.name', 'Cockpit Test']);
  git(repository, ['config', 'user.email', 'cockpit-test@localhost']);
  writeFileSync(path.join(repository, 'app.ts'), 'export const retry = 1;\n', 'utf8');
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'initial']);

  const handler: UpstreamHandler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-phase6',
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
  };
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
  context: PhaseSixContext,
  session: Session,
  prompt: string,
  model = 'gpt-4o-mini',
): ReturnType<StartedDaemon['recorder']['begin']> {
  const handle = context.daemon.recorder.begin({
    sessionId: session.id,
    protocol: 'openai',
    provider: 'openai',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  context.daemon.recorder.finish(handle, {
    status: 'completed',
    responseStatus: 200,
    responseHeaders: { 'content-type': 'application/json' },
    collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
      id: 'chatcmpl-phase6',
      model,
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

function createSession(context: PhaseSixContext, title: string): Session {
  return context.daemon.sessions.create({
    source: 'manual',
    title,
    tags: [],
    workspacePath: context.repository,
    gitBranch: 'main',
  });
}

function writeFeatureFile(context: PhaseSixContext): string {
  const sourceDirectory = path.join(context.repository, 'src');
  mkdirSync(sourceDirectory, { recursive: true });
  const filePath = path.join(sourceDirectory, 'feature.ts');
  writeFileSync(
    filePath,
    [
      'export const featureEnabled = true;',
      "export function featureName() { return 'checkout'; }",
      'export const featureRollout = 0.5;',
      '',
    ].join('\n'),
    'utf8',
  );
  return filePath;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

describe('provenance, understanding debt, and the Context Doctor', () => {
  it('derives provenance from git snapshot diffs and exposes it over REST', async () => {
    const context = await boot();
    const { daemon } = context;
    const session = createSession(context, 'Provenance fixture');
    await daemon.snapshots.ensureBaseline(session);

    completeStep(context, session, 'Add a feature flag helper');
    writeFeatureFile(context);
    await daemon.snapshots.flushSession(session.id);

    const summary = daemon.provenance.summary(session.id);
    expect(summary).toBeDefined();
    if (!summary) return;

    expect(summary.sessionId).toBe(session.id);
    expect(summary.projectId).toBeDefined();
    expect(summary.entries).toHaveLength(1);
    expect(summary.totals).toEqual({ entries: 1, files: 1, aiLines: 3, steps: 1 });

    const entry = summary.entries[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.filePath).toBe('src/feature.ts');
    expect(entry.lineStart).toBe(1);
    expect(entry.lineEnd).toBe(3);
    expect(entry.provider).toBe('openai');
    expect(entry.model).toBe('gpt-4o-mini');
    expect(entry.promptExcerpt).toContain('Add a feature flag helper');
    expect(entry.confidence).toBe(1);
    expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.stepId).toBeDefined();
    expect(entry.commitSha).toBeDefined();

    expect(summary.files[0]).toMatchObject({
      path: 'src/feature.ts',
      aiLines: 3,
      lineRanges: 1,
      entries: 1,
      providers: ['openai'],
      models: ['gpt-4o-mini'],
    });

    const stored = daemon.store.getSession(session.id);
    expect(stored?.projectId).toBe(summary.projectId);

    const response = await fetch(`${daemon.url}/api/sessions/${session.id}/provenance`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const overRest = SessionProvenanceResponseSchema.parse(await response.json());
    expect(overRest.totals.aiLines).toBe(3);

    const recomputed = await fetch(`${daemon.url}/api/sessions/${session.id}/provenance`, {
      method: 'POST',
    });
    expect(recomputed.status).toBe(200);
    const rebuilt = SessionProvenanceResponseSchema.parse(await recomputed.json());
    expect(rebuilt.totals).toEqual(overRest.totals);
    expect(rebuilt.entries.map((item) => item.contentHash)).toEqual(
      overRest.entries.map((item) => item.contentHash),
    );

    const missing = await fetch(`${daemon.url}/api/sessions/${MISSING_ID}/provenance`);
    expect(missing.status).toBe(404);
  });

  it('tracks understanding debt through open, explain, acknowledge, and new AI lines', async () => {
    const context = await boot();
    const { daemon } = context;
    const session = createSession(context, 'Understanding fixture');
    await daemon.snapshots.ensureBaseline(session);

    completeStep(context, session, 'Add the initial helper');
    const featurePath = writeFeatureFile(context);
    await daemon.snapshots.flushSession(session.id);

    const initial = daemon.understanding.list({ sessionId: session.id });
    expect(initial.files).toHaveLength(1);
    const file = initial.files[0];
    expect(file).toBeDefined();
    if (!file) return;

    expect(file.path).toBe('src/feature.ts');
    expect(file.status).toBe('unseen');
    expect(file.aiLines).toBe(3);
    expect(file.reviewedLines).toBe(0);
    expect(file.unreviewedLines).toBe(3);
    expect(file.fileScore).toBe(0);
    expect(initial.summary.debtPercent).toBe(100);
    expect(initial.summary.unseenFiles).toBe(1);

    const listResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/understanding`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get('cache-control')).toBe('no-store');
    const listed = UnderstandingListResponseSchema.parse(await listResponse.json());
    expect(listed.files[0]?.id).toBe(file.id);

    const workspaceResponse = await fetch(
      `${daemon.url}/api/understanding?sessionId=${session.id}`,
    );
    expect(workspaceResponse.status).toBe(200);
    expect(
      UnderstandingListResponseSchema.parse(await workspaceResponse.json()).files,
    ).toHaveLength(1);

    const openResponse = await fetch(`${daemon.url}/api/understanding/${file.id}/open`, {
      method: 'POST',
    });
    expect(openResponse.status).toBe(200);
    const opened = AcknowledgeUnderstandingResponseSchema.parse(await openResponse.json());
    expect(opened.file.status).toBe('opened');

    const detailResponse = await fetch(`${daemon.url}/api/understanding/${file.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = UnderstandingDetailResponseSchema.parse(await detailResponse.json());
    expect(detail.file.status).toBe('opened');
    expect(detail.events.map((event) => event.type)).toContain('opened');
    expect(detail.provenance).toHaveLength(1);
    expect(detail.quizzes).toEqual([]);

    const explainResponse = await fetch(`${daemon.url}/api/understanding/${file.id}/explain`, {
      method: 'POST',
    });
    expect(explainResponse.status).toBe(200);
    const explained = ExplainUnderstandingResponseSchema.parse(await explainResponse.json());
    expect(explained.explanation).toContain('src/feature.ts contains 3 AI-attributed lines');
    expect(explained.explanation).toContain('does not call a model');
    expect(explained.explanation).toContain('You opened this file');

    const explainDetail = await fetch(`${daemon.url}/api/understanding/${file.id}`);
    const explainedDetail = UnderstandingDetailResponseSchema.parse(await explainDetail.json());
    expect(explainedDetail.file.explanation).toBe(explained.explanation);

    const acknowledgeResponse = await fetch(
      `${daemon.url}/api/understanding/${file.id}/acknowledge`,
      { method: 'POST' },
    );
    expect(acknowledgeResponse.status).toBe(200);
    const acknowledged = AcknowledgeUnderstandingResponseSchema.parse(
      await acknowledgeResponse.json(),
    );
    expect(acknowledged.file.status).toBe('acknowledged');
    expect(acknowledged.file.reviewedLines).toBe(3);
    expect(acknowledged.file.unreviewedLines).toBe(0);
    expect(acknowledged.file.fileScore).toBe(100);

    const settled = daemon.understanding.list({ sessionId: session.id });
    expect(settled.summary.debtPercent).toBe(0);
    expect(settled.summary.acknowledgedFiles).toBe(1);

    // New AI lines reopen an acknowledged file without erasing prior review.
    completeStep(context, session, 'Extend the helper with two more flags');
    appendFileSync(
      featurePath,
      ['export const featureBeta = false;', 'export const featureGamma = true;', ''].join('\n'),
      'utf8',
    );
    await daemon.snapshots.flushSession(session.id);

    const reopened = daemon.understanding.list({ sessionId: session.id });
    const reopenedFile = reopened.files[0];
    expect(reopenedFile).toBeDefined();
    if (!reopenedFile) return;
    expect(reopenedFile.aiLines).toBe(5);
    expect(reopenedFile.reviewedLines).toBe(3);
    expect(reopenedFile.unreviewedLines).toBe(2);
    expect(reopenedFile.status).toBe('opened');
    expect(reopenedFile.fileScore).toBe(60);
    expect(reopened.summary.debtPercent).toBe(40);

    const openedOnly = await fetch(`${daemon.url}/api/understanding?status=opened`);
    expect(openedOnly.status).toBe(200);
    expect(UnderstandingListResponseSchema.parse(await openedOnly.json()).files).toHaveLength(1);
  });

  it('generates deterministic quizzes and validates submissions', async () => {
    const context = await boot();
    const { daemon } = context;
    const session = createSession(context, 'Quiz fixture');
    await daemon.snapshots.ensureBaseline(session);

    completeStep(context, session, 'Implement checkout retries');
    writeFeatureFile(context);
    await daemon.snapshots.flushSession(session.id);

    const file = daemon.understanding.list({ sessionId: session.id }).files[0];
    expect(file).toBeDefined();
    if (!file) return;

    const startResponse = await fetch(`${daemon.url}/api/understanding/${file.id}/quiz`, {
      method: 'POST',
    });
    expect(startResponse.status).toBe(200);
    const started = QuizStartResponseSchema.parse(await startResponse.json());
    expect(started.quiz.questions).toHaveLength(3);
    expect(started.quiz.questions.map((question) => question.id)).toEqual(['q1', 'q2', 'q3']);
    for (const question of started.quiz.questions) {
      expect(question.choices.length).toBeGreaterThanOrEqual(2);
    }
    expect(JSON.stringify(started.quiz)).not.toContain('correctChoiceId');
    expect(JSON.stringify(started.quiz)).not.toContain('explanation');

    const resumedResponse = await fetch(`${daemon.url}/api/understanding/${file.id}/quiz`, {
      method: 'POST',
    });
    const resumed = QuizStartResponseSchema.parse(await resumedResponse.json());
    expect(resumed.quiz.id).toBe(started.quiz.id);

    const partial = await postJson(
      `${daemon.url}/api/understanding/quizzes/${started.quiz.id}/submit`,
      { answers: [{ questionId: 'q1', choiceId: 'a' }] },
    );
    expect(partial.status).toBe(400);

    const invalid = await postJson(
      `${daemon.url}/api/understanding/quizzes/${started.quiz.id}/submit`,
      { answers: [] },
    );
    expect(invalid.status).toBe(400);

    const allAnswers = started.quiz.questions.map((question) => ({
      questionId: question.id,
      choiceId: 'a',
    }));
    const submitResponse = await fetch(
      `${daemon.url}/api/understanding/quizzes/${started.quiz.id}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: allAnswers }),
      },
    );
    expect(submitResponse.status).toBe(200);
    const result = QuizSubmitResponseSchema.parse(await submitResponse.json());
    expect(result.total).toBe(3);
    expect(result.correctCount).toBe(3);
    expect(result.score).toBe(1);
    expect(result.quiz.completedAt).toBeDefined();
    expect(result.results.every((answer) => answer.correct)).toBe(true);

    const nextResponse = await fetch(`${daemon.url}/api/understanding/${file.id}/quiz`, {
      method: 'POST',
    });
    const next = QuizStartResponseSchema.parse(await nextResponse.json());
    expect(next.quiz.id).not.toBe(started.quiz.id);

    const detailResponse = await fetch(`${daemon.url}/api/understanding/${file.id}`);
    const detail = UnderstandingDetailResponseSchema.parse(await detailResponse.json());
    expect(detail.quizzes).toHaveLength(2);
    expect(detail.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['quiz_started', 'quiz_completed']),
    );

    const unknownQuiz = await postJson(
      `${daemon.url}/api/understanding/quizzes/${MISSING_ID}/submit`,
      { answers: [{ questionId: 'q1', choiceId: 'a' }] },
    );
    expect(unknownQuiz.status).toBe(404);

    for (const [method, suffix] of [
      ['GET', ''],
      ['POST', '/open'],
      ['POST', '/acknowledge'],
      ['POST', '/explain'],
      ['POST', '/quiz'],
    ] as const) {
      const response = await fetch(`${daemon.url}/api/understanding/${MISSING_ID}${suffix}`, {
        method,
      });
      expect(response.status).toBe(404);
    }

    const badStatus = await fetch(`${daemon.url}/api/understanding?status=not-a-status`);
    expect(badStatus.status).toBe(400);
    const badLimit = await fetch(`${daemon.url}/api/understanding?limit=0`);
    expect(badLimit.status).toBe(400);
  });

  it('captures context snapshots automatically and recomputes them deterministically', async () => {
    const context = await boot();
    const { daemon } = context;
    const session = createSession(context, 'Context fixture');
    await daemon.snapshots.ensureBaseline(session);

    const first = completeStep(context, session, 'Refactor the retry loop');

    const immediate = daemon.contextDoctor.list(session.id);
    expect(immediate.snapshots).toHaveLength(1);
    expect(immediate.latest).not.toBeNull();
    const snapshot = immediate.latest;
    if (!snapshot) return;

    expect(snapshot.stepId).toBe(first.step.id);
    expect(snapshot.provider).toBe('openai');
    expect(snapshot.model).toBe('gpt-4o-mini');
    expect(snapshot.contextWindow).toBe(128_000);
    expect(snapshot.totalTokens).toBeGreaterThan(0);
    expect(snapshot.utilizationPercent).toBe(
      Math.round((snapshot.totalTokens / 128_000) * 1000) / 10,
    );
    expect(new Date(snapshot.measuredAt).toString()).not.toBe('Invalid Date');

    const detail = daemon.contextDoctor.detail(snapshot.id);
    expect(detail).toBeDefined();
    if (!detail) return;
    expect(detail.snapshot.id).toBe(snapshot.id);
    expect(detail.segments.length).toBeGreaterThan(0);
    const history = detail.segments.find((segment) => segment.category === 'history');
    expect(history?.label).toBe('User message 1');
    expect(history?.preview).toContain('Refactor the retry loop');
    expect(detail.insights).toEqual([]);

    const listResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/context`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get('cache-control')).toBe('no-store');
    const listed = SessionContextResponseSchema.parse(await listResponse.json());
    expect(listed.latest?.id).toBe(snapshot.id);

    const detailResponse = await fetch(`${daemon.url}/api/context/${snapshot.id}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.headers.get('cache-control')).toBe('no-store');
    expect(ContextSnapshotDetailResponseSchema.parse(await detailResponse.json()).snapshot.id).toBe(
      snapshot.id,
    );

    const recomputeResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/context`, {
      method: 'POST',
    });
    expect(recomputeResponse.status).toBe(200);
    const recomputed = SessionContextResponseSchema.parse(await recomputeResponse.json());
    expect(recomputed.snapshots).toHaveLength(1);
    expect(recomputed.latest?.totalTokens).toBe(snapshot.totalTokens);
    expect(recomputed.latest?.measuredAt).toBe(new Date(first.step.startedAt).toISOString());

    const unknown = await fetch(`${daemon.url}/api/context/${MISSING_ID}`);
    expect(unknown.status).toBe(404);

    // Unknown models keep an unknown context window instead of guessing.
    completeStep(context, session, 'Use an unfamiliar model', 'mystery-model-9');
    const afterUnknown = daemon.contextDoctor.list(session.id);
    expect(afterUnknown.snapshots).toHaveLength(2);
    expect(afterUnknown.latest?.model).toBe('mystery-model-9');
    expect(afterUnknown.latest?.contextWindow).toBeUndefined();
    expect(afterUnknown.latest?.utilizationPercent).toBeUndefined();
  });

  it('handles sessions without a workspace and invalid identifiers', async () => {
    const context = await boot();
    const { daemon } = context;
    const session = daemon.sessions.create({
      source: 'manual',
      title: 'Detached fixture',
      tags: [],
    });

    const provenance = daemon.provenance.summary(session.id);
    expect(provenance).toBeDefined();
    if (!provenance) return;
    expect(provenance.entries).toEqual([]);
    expect(provenance.files).toEqual([]);
    expect(provenance.totals).toEqual({ entries: 0, files: 0, aiLines: 0, steps: 0 });
    expect(provenance.projectId).toBeUndefined();

    const understanding = daemon.understanding.list({ sessionId: session.id });
    expect(understanding.files).toEqual([]);
    expect(understanding.summary.fileCount).toBe(0);

    const contextResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/context`);
    expect(contextResponse.status).toBe(200);
    const contextPayload = SessionContextResponseSchema.parse(await contextResponse.json());
    expect(contextPayload.snapshots).toEqual([]);
    expect(contextPayload.latest).toBeNull();

    const invalidProvenance = await fetch(`${daemon.url}/api/sessions/not-a-uuid/provenance`);
    expect(invalidProvenance.status).toBe(400);

    const invalidContext = await fetch(`${daemon.url}/api/context/not-a-uuid`);
    expect(invalidContext.status).toBe(400);

    const missingSession = await fetch(`${daemon.url}/api/sessions/${MISSING_ID}/context`);
    expect(missingSession.status).toBe(404);

    const missingUnderstanding = await fetch(
      `${daemon.url}/api/sessions/${MISSING_ID}/understanding`,
    );
    expect(missingUnderstanding.status).toBe(404);
  });
});
