import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContextSnapshotDetailResponseSchema,
  QuizStartResponseSchema,
  QuizSubmitResponseSchema,
  SessionContextResponseSchema,
  SessionProvenanceResponseSchema,
  UnderstandingDetailResponseSchema,
  UnderstandingFileViewSchema,
  UnderstandingListResponseSchema,
  type ContextSnapshotDetailResponse,
  type QuizSubmitResponse,
  type QuizView,
  type SessionContextResponse,
  type SessionProvenanceResponse,
  type UnderstandingDetailResponse,
  type UnderstandingListResponse,
} from '@cockpit/core';
import { loadConfig, startDaemon, type StartedDaemon } from '@cockpit/daemon';

import { DaemonClient } from '../src/daemon-client.js';
import { createProgram } from '../src/cli.js';
import {
  formatContext,
  formatContextDetail,
  formatProvenance,
  formatQuiz,
  formatQuizResults,
  formatUnderstandingDetail,
  formatUnderstandingList,
  runContext,
  runDebt,
  runDebtAck,
  runDebtDetail,
  runDebtExplain,
  runDebtOpen,
  runDebtQuiz,
  runProvenance,
} from '../src/debt.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const UNDERSTANDING_ID = '33333333-3333-4333-8333-333333333333';
const PROVENANCE_ID = '44444444-4444-4444-8444-444444444444';
const QUIZ_ID = '55555555-5555-4555-8555-555555555555';
const CONTEXT_ID = '66666666-6666-4666-8666-666666666666';
const CONTEXT_SEGMENT_ID = '77777777-7777-4777-8777-777777777777';
const CONTEXT_INSIGHT_ID = '88888888-8888-4888-8888-888888888888';
const EVENT_ID = '99999999-9999-4999-8999-999999999999';

function provenanceEntry() {
  return {
    id: PROVENANCE_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    stepId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    filePath: 'src/auth.ts',
    lineStart: 4,
    lineEnd: 6,
    commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    contentHash: 'a'.repeat(64),
    provider: 'openai',
    model: 'gpt-4.1',
    promptExcerpt: 'Fix the auth race condition.',
    confidence: 1,
    capturedAt: '2026-04-05T06:07:10.000Z',
  };
}

function provenanceResponse(): SessionProvenanceResponse {
  return SessionProvenanceResponseSchema.parse({
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    entries: [provenanceEntry()],
    files: [
      {
        path: 'src/auth.ts',
        aiLines: 3,
        lineRanges: 1,
        entries: 1,
        providers: ['openai'],
        models: ['gpt-4.1'],
        lastCapturedAt: '2026-04-05T06:07:10.000Z',
      },
    ],
    totals: { entries: 1, files: 1, aiLines: 3, steps: 1 },
  });
}

function understandingFileView() {
  return UnderstandingFileViewSchema.parse({
    id: UNDERSTANDING_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    path: 'src/auth.ts',
    aiLines: 12,
    reviewedLines: 3,
    unreviewedLines: 9,
    status: 'opened',
    fileScore: 25,
    firstTouchedAt: '2026-04-05T06:07:10.000Z',
    lastTouchedAt: '2026-04-05T06:12:00.000Z',
    lastOpenedAt: '2026-04-05T06:20:00.000Z',
  });
}

function understandingList(): UnderstandingListResponse {
  const hotspot = {
    path: 'src/auth.ts',
    status: 'opened' as const,
    aiLines: 12,
    unreviewedLines: 9,
    fileScore: 25,
  };
  return UnderstandingListResponseSchema.parse({
    files: [understandingFileView()],
    summary: {
      reviewedPercent: 25,
      debtPercent: 75,
      totalAiLines: 12,
      reviewedAiLines: 3,
      fileCount: 1,
      unseenFiles: 0,
      acknowledgedFiles: 0,
      hotspots: [hotspot],
      neverReviewedHotspots: [hotspot],
    },
  });
}

function quizQuestions() {
  return [
    {
      id: 'q1',
      prompt: 'How many AI-authored lines does Cockpit attribute to src/auth.ts?',
      choices: [
        { id: 'a', text: '12 lines' },
        { id: 'b', text: '17 lines' },
      ],
    },
    {
      id: 'q2',
      prompt: 'Which model most recently wrote attributed lines in src/auth.ts?',
      choices: [
        { id: 'a', text: 'gpt-4.1' },
        { id: 'b', text: 'claude-sonnet-4' },
      ],
    },
    {
      id: 'q3',
      prompt: 'Which prompt best matches the most recent attributed change?',
      choices: [
        { id: 'a', text: 'Fix the auth race condition.' },
        { id: 'b', text: 'No prompt was recorded.' },
      ],
    },
  ];
}

function quizView(): QuizView {
  return {
    id: QUIZ_ID,
    understandingFileId: UNDERSTANDING_ID,
    questions: quizQuestions(),
    generatedAt: '2026-04-05T06:21:00.000Z',
  };
}

function understandingDetail(): UnderstandingDetailResponse {
  return UnderstandingDetailResponseSchema.parse({
    file: understandingFileView(),
    events: [
      {
        id: EVENT_ID,
        understandingFileId: UNDERSTANDING_ID,
        type: 'opened',
        occurredAt: '2026-04-05T06:20:00.000Z',
        metadata: {},
      },
    ],
    quizzes: [
      {
        ...quizView(),
        completedAt: '2026-04-05T06:22:00.000Z',
        score: 1,
      },
    ],
    provenance: [provenanceEntry()],
  });
}

function quizSubmitResponse(): QuizSubmitResponse {
  return QuizSubmitResponseSchema.parse({
    quiz: {
      id: QUIZ_ID,
      understandingFileId: UNDERSTANDING_ID,
      questions: quizQuestions().map((question) => ({
        ...question,
        correctChoiceId: 'a',
        explanation: 'Cockpit derives this from recorded provenance.',
      })),
      generatedAt: '2026-04-05T06:21:00.000Z',
      completedAt: '2026-04-05T06:22:00.000Z',
      score: 1,
    },
    results: quizQuestions().map((question) => ({
      questionId: question.id,
      choiceId: 'a',
      correct: true,
      correctChoiceId: 'a',
      explanation: 'Cockpit derives this from recorded provenance.',
    })),
    score: 1,
    correctCount: 3,
    total: 3,
  });
}

function contextSnapshot() {
  return {
    id: CONTEXT_ID,
    sessionId: SESSION_ID,
    stepId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    provider: 'openai',
    model: 'gpt-4.1',
    totalTokens: 3200,
    contextWindow: 1_047_576,
    utilizationPercent: 0.3,
    measuredAt: '2026-04-05T06:07:00.000Z',
  };
}

function sessionContext(): SessionContextResponse {
  return SessionContextResponseSchema.parse({
    sessionId: SESSION_ID,
    snapshots: [contextSnapshot()],
    latest: contextSnapshot(),
  });
}

function contextDetail(): ContextSnapshotDetailResponse {
  return ContextSnapshotDetailResponseSchema.parse({
    snapshot: contextSnapshot(),
    segments: [
      {
        id: CONTEXT_SEGMENT_ID,
        snapshotId: CONTEXT_ID,
        category: 'system',
        label: 'System prompt',
        tokens: 1200,
        percent: 37.5,
        preview: 'You are a careful coding agent.',
      },
    ],
    insights: [
      {
        id: CONTEXT_INSIGHT_ID,
        snapshotId: CONTEXT_ID,
        type: 'large_tool_output',
        severity: 'medium',
        title: 'Large tool output in context',
        detail: 'Tool result contributes 1,800 estimated tokens.',
        paths: ['src/auth.ts'],
        estimatedSavingsTokens: 900,
      },
    ],
  });
}

describe('debt CLI formatting', () => {
  it('formats provenance summaries and empty states', () => {
    const text = formatProvenance(provenanceResponse());
    expect(text).toContain(`Provenance for session ${SESSION_ID}`);
    expect(text).toContain('Files: 1  AI lines: 3  Ranges: 1  Steps: 1');
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('gpt-4.1');

    const empty = formatProvenance(
      SessionProvenanceResponseSchema.parse({
        sessionId: SESSION_ID,
        entries: [],
        files: [],
        totals: { entries: 0, files: 0, aiLines: 0, steps: 0 },
      }),
    );
    expect(empty).toContain('No provenance has been captured yet.');
  });

  it('formats understanding debt with hotspots and files', () => {
    const text = formatUnderstandingList(understandingList());
    expect(text).toContain('Understanding debt: 75% (3/12 AI lines reviewed)');
    expect(text).toContain('Files: 1  Unseen: 0  Acknowledged: 0');
    expect(text).toContain('Never-reviewed hotspots:');
    expect(text).toContain('src/auth.ts — 9 unreviewed line(s), score 25');
    expect(text).toContain(UNDERSTANDING_ID);
    expect(text).toContain('OPENED');
    expect(text).toContain('src/auth.ts');

    const empty = formatUnderstandingList(
      UnderstandingListResponseSchema.parse({
        files: [],
        summary: {
          reviewedPercent: 0,
          debtPercent: 0,
          totalAiLines: 0,
          reviewedAiLines: 0,
          fileCount: 0,
          unseenFiles: 0,
          acknowledgedFiles: 0,
          hotspots: [],
          neverReviewedHotspots: [],
        },
      }),
    );
    expect(empty).toContain('No AI-authored files are recorded for this scope yet.');
  });

  it('formats understanding detail with explanation, ranges, quizzes, and events', () => {
    const detail = {
      ...understandingDetail(),
      file: {
        ...understandingDetail().file,
        explanation: 'The retry loop now backs off.\nIt is covered by a test.',
      },
    };
    const text = formatUnderstandingDetail(detail);
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('Status: opened  AI lines: 12  Reviewed: 3  Score: 25/100');
    expect(text).toContain('Explanation:');
    expect(text).toContain('  The retry loop now backs off.');
    expect(text).toContain('  It is covered by a test.');
    expect(text).toContain('Provenance ranges (1):');
    expect(text).toContain('lines 4-6');
    expect(text).toContain('prompt: Fix the auth race condition.');
    expect(text).toContain('Quizzes:');
    expect(text).toContain('score 100%');
    expect(text).toContain('Recent events:');
    expect(text).toContain('opened');

    const many = {
      ...understandingDetail(),
      provenance: Array.from({ length: 21 }, (_, index) => ({
        ...provenanceEntry(),
        id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
        lineStart: index + 1,
        lineEnd: index + 1,
      })),
    };
    expect(formatUnderstandingDetail(many)).toContain('… 1 more range(s)');
  });

  it('formats quizzes and submitted results', () => {
    const quiz = formatQuiz(quizView());
    expect(quiz).toContain(`Quiz ${QUIZ_ID} for ${UNDERSTANDING_ID}`);
    expect(quiz).toContain('1. How many AI-authored lines');
    expect(quiz).toContain('a) 12 lines');
    expect(quiz).toContain('Submit with: cockpit debt quiz <id> --answers a,b,c');

    const results = formatQuizResults(quizSubmitResponse());
    expect(results).toContain('Score: 100% (3/3)');
    expect(results).toContain('✓ q1: chose a, correct a');
    expect(results).toContain('Cockpit derives this from recorded provenance.');
  });

  it('formats context summaries, unknown windows, and details', () => {
    const text = formatContext(sessionContext());
    expect(text).toContain(`Context snapshots for session ${SESSION_ID}: 1`);
    expect(text).toContain(
      `Latest: ${(3200).toLocaleString()} estimated tokens of ${(1_047_576).toLocaleString()} (0.3%)`,
    );
    expect(text).toContain('Measured: 2026-04-05T06:07:00.000Z');
    expect(text).toContain('gpt-4.1');

    const unknownWindow = formatContext(
      SessionContextResponseSchema.parse({
        sessionId: SESSION_ID,
        snapshots: [
          {
            ...contextSnapshot(),
            contextWindow: undefined,
            utilizationPercent: undefined,
          },
        ],
        latest: {
          ...contextSnapshot(),
          contextWindow: undefined,
          utilizationPercent: undefined,
        },
      }),
    );
    expect(unknownWindow).toContain('(window unknown)');

    const empty = formatContext(
      SessionContextResponseSchema.parse({ sessionId: SESSION_ID, snapshots: [], latest: null }),
    );
    expect(empty).toContain('No context snapshots have been captured yet.');

    const detail = formatContextDetail(contextDetail());
    expect(detail).toContain(`Context snapshot ${CONTEXT_ID}`);
    expect(detail).toContain(
      `Tokens: ${(3200).toLocaleString()} / ${(1_047_576).toLocaleString()} (0.3%)`,
    );
    expect(detail).toContain('Model: gpt-4.1  Provider: openai');
    expect(detail).toContain('Segments:');
    expect(detail).toContain('System prompt');
    expect(detail).toContain('Insights:');
    expect(detail).toContain('[medium] Large tool output in context');
    expect(detail).toContain(`estimated savings: ${(900).toLocaleString()} tokens`);
  });
});

describe('debt CLI parsing', () => {
  it('passes host and port flags to nested subcommands', async () => {
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: unknown) =>
        new Response(JSON.stringify(understandingDetail()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        'node',
        'cockpit',
        'debt',
        'show',
        UNDERSTANDING_ID,
        '--json',
        '--host',
        '127.0.0.1',
        '--port',
        '4567',
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        `http://127.0.0.1:4567/api/understanding/${UNDERSTANDING_ID}`,
      );
    } finally {
      write.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

interface CliTestContext {
  directory: string;
  workspace: string;
  daemon: StartedDaemon;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup().catch(() => undefined);
  }
});

async function startTestDaemon(): Promise<CliTestContext> {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-cli-debt-'));
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const config = loadConfig({
    COCKPIT_HOME: path.join(directory, 'home'),
    COCKPIT_DATABASE: ':memory:',
    COCKPIT_HOST: '127.0.0.1',
    COCKPIT_PORT: '0',
    COCKPIT_LOG_LEVEL: 'silent',
    COCKPIT_OPENAI_UPSTREAM: 'http://127.0.0.1:9',
    COCKPIT_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:9',
  });
  const daemon = await startDaemon({ config });
  cleanups.push(async () => {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, workspace, daemon };
}

function seedUnderstanding(context: CliTestContext) {
  const session = context.daemon.sessions.create({
    source: 'manual',
    title: 'CLI debt fixture',
    tags: [],
    workspacePath: context.workspace,
  });
  const stored = context.daemon.store.getSession(session.id);
  const projectId = stored?.projectId;
  if (!projectId) throw new Error('The fixture session did not register a project.');

  context.daemon.store.insertProvenanceEntries([
    {
      projectId,
      sessionId: session.id,
      filePath: 'src/auth.ts',
      lineStart: 4,
      lineEnd: 6,
      contentHash: 'a'.repeat(64),
      provider: 'openai',
      model: 'gpt-4.1',
      promptExcerpt: 'Fix the auth race condition.',
      confidence: 1,
      capturedAt: new Date('2026-04-05T06:07:10.000Z'),
    },
  ]);

  const files = context.daemon.understanding.syncSession(session.id);
  const file = files[0];
  if (!file) throw new Error('The fixture understanding file was not created.');
  return { session, projectId, file };
}

describe('debt CLI runners', () => {
  it('drives provenance and understanding commands against a real daemon', async () => {
    const context = await startTestDaemon();
    const client = new DaemonClient(context.daemon.url);
    const { session, file } = seedUnderstanding(context);

    const provenanceText = await runProvenance(client, session.id, false, false);
    expect(provenanceText).toContain(`Provenance for session ${session.id}`);
    expect(provenanceText).toContain('src/auth.ts');
    expect(provenanceText).toContain('AI lines: 3');

    const provenanceJson = SessionProvenanceResponseSchema.parse(
      JSON.parse(await runProvenance(client, session.id, false, true)),
    );
    expect(provenanceJson.totals).toEqual({ entries: 1, files: 1, aiLines: 3, steps: 0 });

    const debtText = await runDebt(client, session.id, false);
    expect(debtText).toContain('Understanding debt: 100% (0/3 AI lines reviewed)');
    expect(debtText).toContain('src/auth.ts');

    const workspaceDebt = await runDebt(client, undefined, false);
    expect(workspaceDebt).toContain('src/auth.ts');

    const debtJson = UnderstandingListResponseSchema.parse(
      JSON.parse(await runDebt(client, undefined, true)),
    );
    expect(debtJson.files.map((item) => item.id)).toEqual([file.id]);

    const detailText = await runDebtDetail(client, file.id, false);
    expect(detailText).toContain('src/auth.ts');
    expect(detailText).toContain('Provenance ranges (1):');
    expect(detailText).toContain('prompt: Fix the auth race condition.');

    const detailJson = UnderstandingDetailResponseSchema.parse(
      JSON.parse(await runDebtDetail(client, file.id, true)),
    );
    expect(detailJson.file.id).toBe(file.id);

    expect(await runDebtOpen(client, file.id, false)).toContain('is now opened.');
    const opened = JSON.parse(await runDebtOpen(client, file.id, true)) as {
      file: { status: string };
    };
    expect(opened.file.status).toBe('opened');
    expect(await runDebtDetail(client, file.id, false)).toContain('Recent events:');

    const explained = await runDebtExplain(client, file.id, false);
    expect(explained).toContain('src/auth.ts contains 3 AI-attributed lines');
    expect(explained).toContain('does not call a model');
    expect(explained).toContain('You opened this file');

    expect(await runDebtAck(client, file.id, false)).toContain('acknowledged (3/3 AI lines).');
    const settled = UnderstandingListResponseSchema.parse(
      JSON.parse(await runDebt(client, session.id, true)),
    );
    expect(settled.summary.debtPercent).toBe(0);
    expect(settled.files[0]?.status).toBe('acknowledged');

    const unseenOnly = await client.listUnderstanding({ status: 'unseen' });
    expect(unseenOnly.files).toEqual([]);

    const quizText = await runDebtQuiz(client, file.id, undefined, false);
    expect(quizText).toContain('Submit with: cockpit debt quiz <id> --answers a,b,c');

    await expect(runDebtQuiz(client, file.id, 'a,b', false)).rejects.toThrow(
      'Expected 3 answers, received 2.',
    );

    const quizJson = QuizStartResponseSchema.parse(
      JSON.parse(await runDebtQuiz(client, file.id, undefined, true)),
    );
    expect(quizJson.quiz.questions).toHaveLength(3);

    const results = await runDebtQuiz(client, file.id, 'a,a,a', false);
    expect(results).toContain('Score: 100% (3/3)');
    expect(results).toContain('✓ q1: chose a, correct a');

    const submitted = QuizSubmitResponseSchema.parse(
      JSON.parse(await runDebtQuiz(client, file.id, 'a,a,a', true)),
    );
    expect(submitted.correctCount).toBe(3);
    expect(submitted.quiz.completedAt).toBeDefined();

    const afterQuiz = await runDebtDetail(client, file.id, false);
    expect(afterQuiz).toContain('Quizzes:');
    expect(afterQuiz).toContain('score 100%');
  });

  it('recomputes provenance from snapshots and reports an empty ledger', async () => {
    const context = await startTestDaemon();
    const client = new DaemonClient(context.daemon.url);
    const { session } = seedUnderstanding(context);

    const text = await runProvenance(client, session.id, true, false);
    expect(text).toContain('No provenance has been captured yet.');

    const json = SessionProvenanceResponseSchema.parse(
      JSON.parse(await runProvenance(client, session.id, true, true)),
    );
    expect(json.entries).toEqual([]);
    expect(json.files).toEqual([]);
    expect(json.totals).toEqual({ entries: 0, files: 0, aiLines: 0, steps: 0 });
  });

  it('drives context snapshots, details, and recompute', async () => {
    const context = await startTestDaemon();
    const client = new DaemonClient(context.daemon.url);
    const session = context.daemon.sessions.create({
      source: 'manual',
      title: 'CLI context fixture',
      tags: [],
      workspacePath: context.workspace,
    });

    const snapshot = context.daemon.store.insertContextSnapshot({
      sessionId: session.id,
      provider: 'openai',
      model: 'gpt-4.1',
      totalTokens: 3200,
      contextWindow: 1_048_576,
      measuredAt: new Date('2026-04-05T06:07:00.000Z'),
      segments: [
        {
          category: 'system',
          label: 'System prompt',
          tokens: 1200,
          percent: 37.5,
          preview: 'You are a careful coding agent.',
        },
        {
          category: 'files',
          label: 'src/auth.ts',
          tokens: 800,
          percent: 25,
          sourcePath: 'src/auth.ts',
        },
      ],
      insights: [
        {
          type: 'large_tool_output',
          severity: 'medium',
          title: 'Large tool output in context',
          detail: 'Tool result contributes 1,800 estimated tokens.',
          paths: ['src/auth.ts'],
          estimatedSavingsTokens: 900,
        },
      ],
    });

    const text = await runContext(client, session.id, false, false);
    expect(text).toContain(`Context snapshots for session ${session.id}: 1`);
    expect(text).toContain('System prompt');
    expect(text).toContain('Insights:');
    expect(text).toContain('[medium] Large tool output in context');

    const payload = JSON.parse(await runContext(client, session.id, false, true)) as {
      sessionId: string;
      latest: { id: string } | null;
      detail: ContextSnapshotDetailResponse | null;
    };
    expect(payload.sessionId).toBe(session.id);
    expect(payload.latest?.id).toBe(snapshot.id);
    expect(payload.detail?.segments).toHaveLength(2);
    expect(payload.detail?.insights[0]?.estimatedSavingsTokens).toBe(900);

    const listed = SessionContextResponseSchema.parse(await client.getSessionContext(session.id));
    expect(listed.latest?.id).toBe(snapshot.id);

    const detail = ContextSnapshotDetailResponseSchema.parse(
      await client.getContextSnapshot(snapshot.id),
    );
    expect(detail.snapshot.id).toBe(snapshot.id);
    expect(detail.segments.map((segment) => segment.category)).toEqual(['system', 'files']);

    const recomputed = await runContext(client, session.id, true, false);
    expect(recomputed).toContain('No context snapshots have been captured yet.');
  });
});
