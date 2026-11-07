import {
  AnalyticsResponseSchema,
  ArenaRunSchema,
  BrainProjectStatusSchema,
  BudgetPolicySchema,
  BudgetStatusSchema,
  CapturedStepSchema,
  CapturedStreamChunkSchema,
  ComprehensionQuizSchema,
  ContextInsightSchema,
  ContextSegmentSchema,
  ContextSnapshotSchema,
  DeviceSchema,
  GuardEventSchema,
  GuardRuleSchema,
  HandoffBriefSchema,
  JournalEntrySchema,
  PluginRunSchema,
  PluginSchema,
  ProjectSchema,
  ProvenanceEntrySchema,
  ReplayFileChangeSchema,
  ReplayForkSchema,
  ReplaySnapshotSchema,
  SessionSchema,
  ToolCallTraceSchema,
  UnderstandingDebtSummarySchema,
  UnderstandingFileViewSchema,
  type AnalyticsResponse,
  type ArenaRun,
  type BrainProjectStatus,
  type BudgetPolicy,
  type BudgetStatus,
  type CapturedStep,
  type CapturedStreamChunk,
  type ComprehensionQuiz,
  type ContextInsight,
  type ContextSegment,
  type ContextSnapshot,
  type ContextSnapshotDetailResponse,
  type Device,
  type GuardEvent,
  type GuardRule,
  type HandoffBrief,
  type HealthResponse,
  type JournalEntry,
  type OverviewStats,
  type PairingSession,
  type PairingSessionStatus,
  type Plugin,
  type PluginRun,
  type Project,
  type ProvenanceEntry,
  type QuizSubmitResponse,
  type QuizView,
  type ReplayFileChange,
  type ReplayFork,
  type ReplaySnapshot,
  type Session,
  type SessionContextResponse,
  type SessionProvenanceResponse,
  type SessionReplayResponse,
  type SessionTotals,
  type SnapshotDetailResponse,
  type StepDetailResponse,
  type ToolCallTrace,
  type UnderstandingDebtSummary,
  type UnderstandingDetailResponse,
  type UnderstandingFileView,
  type UnderstandingListResponse,
} from '@cockpit/core';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import type { ApiClient } from '../src/lib/api';
import { ApiProvider } from '../src/lib/api-context';

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
export const STEP_ONE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const STEP_TWO_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TOOL_CALL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const CHUNK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const SNAPSHOT_ID = '99999999-9999-4999-8999-999999999999';
export const BASE_SNAPSHOT_ID = '88888888-8888-4888-8888-888888888888';
export const FILE_CHANGE_ID = '77777777-7777-4777-8777-777777777777';
export const FORK_ID = '66666666-6666-4666-8666-666666666666';
export const GUARD_EVENT_ID = '55555555-5555-4555-8555-555555555555';
export const BUDGET_POLICY_ID = '44444444-4444-4444-8444-444444444444';
export const PROJECT_ID = '21212121-2121-4121-8121-212121212121';
export const UNDERSTANDING_ID = '33333333-3333-4333-8333-333333333333';
export const CONTEXT_SNAPSHOT_ID = '12121212-1212-4212-8212-121212121212';
export const CONTEXT_SEGMENT_ID = '13131313-1313-4313-8313-131313131313';
export const CONTEXT_INSIGHT_ID = '14141414-1414-4414-8414-141414141414';
export const PROVENANCE_ID = '15151515-1515-4515-8515-151515151515';
export const QUIZ_ID = '16161616-1616-4616-8616-161616161616';

export function makeGuardRule(overrides: Partial<GuardRule> = {}): GuardRule {
  return GuardRuleSchema.parse({
    id: 'builtin-dangerous-command',
    name: 'Dangerous shell command',
    description: 'Pauses requests that ask an agent to run a destructive command.',
    kind: 'dangerous_command',
    action: 'pause',
    severity: 'high',
    source: 'builtin',
    enabled: true,
    priority: 20,
    config: { patterns: ['rm -rf'] },
    ...overrides,
  });
}

export function makeGuardEvent(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return GuardEventSchema.parse({
    id: GUARD_EVENT_ID,
    sessionId: SESSION_ID,
    stepId: STEP_ONE_ID,
    ruleId: 'builtin-dangerous-command',
    kind: 'dangerous_command',
    action: 'pause',
    severity: 'high',
    status: 'pending',
    title: 'Dangerous command requested',
    description: 'The request asks the agent to delete a directory recursively.',
    command: 'rm -rf build',
    evidence: [{ field: 'prompt', excerpt: 'rm -rf build' }],
    requestedAt: '2026-04-05T06:12:00.000Z',
    ...overrides,
  });
}

export function makeBudgetPolicy(overrides: Partial<BudgetPolicy> = {}): BudgetPolicy {
  return BudgetPolicySchema.parse({
    id: BUDGET_POLICY_ID,
    name: 'Monthly lab budget',
    scope: 'global',
    period: 'month',
    limitUsd: 25,
    enforcement: 'warn',
    enabled: true,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  });
}

export function makeBudgetStatus(overrides: Partial<BudgetStatus> = {}): BudgetStatus {
  return BudgetStatusSchema.parse({
    policyId: BUDGET_POLICY_ID,
    name: 'Monthly lab budget',
    limitUsd: 25,
    spentUsd: 18.75,
    remainingUsd: 6.25,
    usageRatio: 0.75,
    warning: false,
    exceeded: false,
    enforcement: 'warn',
    period: 'month',
    periodStart: '2026-04-01T00:00:00.000Z',
    ...overrides,
  });
}

export function makeTotals(overrides: Partial<SessionTotals> = {}): SessionTotals {
  return {
    stepCount: 2,
    modelCallCount: 2,
    toolCallCount: 1,
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 150,
    cacheWriteTokens: 20,
    reasoningTokens: 0,
    totalCostUsd: 0.0184,
    unknownCostCalls: 0,
    errorCount: 0,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return SessionSchema.parse({
    id: SESSION_ID,
    title: 'Fix flaky auth test',
    source: 'proxy',
    status: 'completed',
    agent: {
      name: 'Claude Code',
      version: '2.1.0',
      detectedFrom: 'headers',
    },
    modelRef: {
      provider: 'openai',
      protocol: 'openai',
      model: 'gpt-4.1-mini',
    },
    workspacePath: '/home/dev/auth-service',
    gitBranch: 'fix/auth-race',
    startedAt: '2026-04-05T06:07:08.000Z',
    endedAt: '2026-04-05T06:12:30.000Z',
    durationMs: 322_000,
    totals: makeTotals(),
    tags: [],
    ...overrides,
  });
}

export function makeStep(overrides: Partial<CapturedStep> = {}): CapturedStep {
  return CapturedStepSchema.parse({
    id: STEP_ONE_ID,
    sessionId: SESSION_ID,
    seq: 0,
    kind: 'model',
    status: 'completed',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    request: {
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      model: 'gpt-4.1-mini',
      stream: true,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer [REDACTED]',
      },
      body: {
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'Hello from the cockpit' }],
      },
      promptText: 'Hello from the cockpit',
      redactionCount: 1,
    },
    response: {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      finishReason: 'stop',
      text: 'Here is the fix.',
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 150,
        cacheWriteTokens: 20,
        reasoningTokens: 0,
      },
      ttftMs: 120,
      latencyMs: 840,
    },
    usage: {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 150,
      cacheWriteTokens: 20,
      reasoningTokens: 0,
    },
    costUsd: 0.0184,
    costKnown: true,
    startedAt: '2026-04-05T06:07:09.000Z',
    endedAt: '2026-04-05T06:07:09.840Z',
    durationMs: 840,
    ...overrides,
  });
}

export function makeChunk(overrides: Partial<CapturedStreamChunk> = {}): CapturedStreamChunk {
  return CapturedStreamChunkSchema.parse({
    id: CHUNK_ID,
    stepId: STEP_ONE_ID,
    seq: 0,
    kind: 'text',
    data: '{"choices":[{"delta":{"content":"first token"}}]}',
    deltaText: 'first token',
    receivedAt: '2026-04-05T06:07:09.200Z',
    ...overrides,
  });
}

export function makeToolCall(overrides: Partial<ToolCallTrace> = {}): ToolCallTrace {
  return ToolCallTraceSchema.parse({
    id: TOOL_CALL_ID,
    sessionId: SESSION_ID,
    stepId: STEP_ONE_ID,
    providerToolCallId: 'call_123',
    name: 'read_file',
    status: 'completed',
    input: { path: 'src/auth.ts' },
    output: { content: 'export function login() {}' },
    filePaths: ['src/auth.ts'],
    startedAt: '2026-04-05T06:07:10.000Z',
    endedAt: '2026-04-05T06:07:10.120Z',
    ...overrides,
  });
}

export function makeSnapshot(overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  return ReplaySnapshotSchema.parse({
    id: SNAPSHOT_ID,
    sessionId: SESSION_ID,
    stepId: STEP_ONE_ID,
    kind: 'after',
    commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    parentCommitSha: '1234567890abcdef1234567890abcdef12345678',
    branch: 'fix/auth-race',
    worktreePath: '/home/dev/auth-service',
    filesChanged: 1,
    insertions: 2,
    deletions: 1,
    createdAt: '2026-04-05T06:07:09.900Z',
    ...overrides,
  });
}

export function makeFileChange(overrides: Partial<ReplayFileChange> = {}): ReplayFileChange {
  return ReplayFileChangeSchema.parse({
    id: FILE_CHANGE_ID,
    snapshotId: SNAPSHOT_ID,
    path: 'src/auth.ts',
    changeType: 'modified',
    additions: 2,
    deletions: 1,
    diff: [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,3 +1,4 @@',
      ' export function login() {}',
      '-export const oldFlag = true;',
      '+export const newFlag = true;',
      '+export const retry = 3;',
      '',
    ].join('\n'),
    ...overrides,
  });
}

export function makeFork(overrides: Partial<ReplayFork> = {}): ReplayFork {
  return ReplayForkSchema.parse({
    id: FORK_ID,
    sessionId: SESSION_ID,
    stepId: STEP_ONE_ID,
    branch: 'cockpit/fork-11111111-step-abc12345',
    worktreePath: 'C:\\Users\\dev\\.cockpit\\forks\\fork-11111111-abc12345',
    baseCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    resumeBrief: '# Cockpit resume brief\n\nContinue from the fork.',
    status: 'ready',
    createdAt: '2026-04-05T06:15:00.000Z',
    ...overrides,
  });
}

export function makeReplay(overrides: Partial<SessionReplayResponse> = {}): SessionReplayResponse {
  return {
    session: makeSession(),
    steps: [],
    snapshots: [],
    forks: [],
    ...overrides,
  };
}

export function makeSnapshotDetail(
  overrides: Partial<SnapshotDetailResponse> = {},
): SnapshotDetailResponse {
  return {
    snapshot: makeSnapshot(),
    fileChanges: [makeFileChange()],
    ...overrides,
  };
}

export const EMPTY_STATS: OverviewStats = {
  sessionCount: 0,
  activeSessionCount: 0,
  stepCount: 0,
  toolCallCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalCostUsd: 0,
  unknownCostCalls: 0,
  errorCount: 0,
};

export const HEALTH: HealthResponse = {
  ok: true,
  service: 'cockpit-daemon',
  version: '0.1.0',
  uptimeSeconds: 12,
  database: 'ok',
  demoMode: false,
  protocol: { openai: true, anthropic: true },
};

export function makeStepDetail(step: CapturedStep = makeStep()): StepDetailResponse {
  return {
    step,
    chunks: [makeChunk({ stepId: step.id })],
    toolCalls: [makeToolCall({ stepId: step.id })],
  };
}

export function makeProvenanceEntry(overrides: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return ProvenanceEntrySchema.parse({
    id: PROVENANCE_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    stepId: STEP_ONE_ID,
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
    ...overrides,
  });
}

export function makeProvenanceResponse(
  overrides: Partial<SessionProvenanceResponse> = {},
): SessionProvenanceResponse {
  const entries = [makeProvenanceEntry()];
  return {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    entries,
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
    ...overrides,
  };
}

export function makeUnderstandingFileView(
  overrides: Partial<UnderstandingFileView> = {},
): UnderstandingFileView {
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
    ...overrides,
  });
}

export function makeDebtSummary(
  overrides: Partial<UnderstandingDebtSummary> = {},
): UnderstandingDebtSummary {
  const hotspot = {
    path: 'src/auth.ts',
    status: 'opened' as const,
    aiLines: 12,
    unreviewedLines: 9,
    fileScore: 25,
  };
  return UnderstandingDebtSummarySchema.parse({
    reviewedPercent: 25,
    debtPercent: 75,
    totalAiLines: 12,
    reviewedAiLines: 3,
    fileCount: 1,
    unseenFiles: 0,
    acknowledgedFiles: 0,
    hotspots: [hotspot],
    neverReviewedHotspots: [hotspot],
    ...overrides,
  });
}

export function makeUnderstandingListResponse(
  overrides: Partial<UnderstandingListResponse> = {},
): UnderstandingListResponse {
  return {
    files: [makeUnderstandingFileView()],
    summary: makeDebtSummary(),
    ...overrides,
  };
}

export function makeQuizView(overrides: Partial<QuizView> = {}): QuizView {
  return {
    id: QUIZ_ID,
    understandingFileId: UNDERSTANDING_ID,
    questions: [
      {
        id: 'q1',
        prompt: 'How many AI-authored lines does Cockpit attribute to src/auth.ts?',
        choices: [
          { id: 'a', text: '12 lines' },
          { id: 'b', text: '17 lines' },
          { id: 'c', text: '11 lines' },
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
          { id: 'b', text: 'The file was changed outside a recorded request.' },
        ],
      },
    ],
    generatedAt: '2026-04-05T06:21:00.000Z',
    ...overrides,
  };
}

export function makeComprehensionQuiz(
  overrides: Partial<ComprehensionQuiz> = {},
): ComprehensionQuiz {
  return ComprehensionQuizSchema.parse({
    id: QUIZ_ID,
    understandingFileId: UNDERSTANDING_ID,
    questions: [
      {
        id: 'q1',
        prompt: 'How many AI-authored lines does Cockpit attribute to src/auth.ts?',
        choices: [
          { id: 'a', text: '12 lines' },
          { id: 'b', text: '17 lines' },
        ],
        correctChoiceId: 'a',
        explanation: 'Cockpit unions the added line ranges recorded in git snapshots.',
      },
      {
        id: 'q2',
        prompt: 'Which model most recently wrote attributed lines in src/auth.ts?',
        choices: [
          { id: 'a', text: 'gpt-4.1' },
          { id: 'b', text: 'claude-sonnet-4' },
        ],
        correctChoiceId: 'a',
        explanation: 'The newest provenance range records model gpt-4.1.',
      },
      {
        id: 'q3',
        prompt: 'Which prompt best matches the most recent attributed change?',
        choices: [
          { id: 'a', text: 'Fix the auth race condition.' },
          { id: 'b', text: 'No prompt was recorded.' },
        ],
        correctChoiceId: 'a',
        explanation: 'The prompt excerpt is stored on the newest provenance entry.',
      },
    ],
    generatedAt: '2026-04-05T06:21:00.000Z',
    ...overrides,
  });
}

export function makeUnderstandingDetail(
  overrides: Partial<UnderstandingDetailResponse> = {},
): UnderstandingDetailResponse {
  return {
    file: makeUnderstandingFileView(),
    events: [
      {
        id: '17171717-1717-4717-8717-171717171717',
        understandingFileId: UNDERSTANDING_ID,
        type: 'opened',
        occurredAt: '2026-04-05T06:20:00.000Z',
        metadata: {},
      },
    ],
    quizzes: [],
    provenance: [makeProvenanceEntry()],
    ...overrides,
  };
}

export function makeQuizSubmitResponse(
  overrides: Partial<QuizSubmitResponse> = {},
): QuizSubmitResponse {
  return {
    quiz: makeComprehensionQuiz({ completedAt: '2026-04-05T06:22:00.000Z', score: 1 }),
    results: [
      {
        questionId: 'q1',
        choiceId: 'a',
        correct: true,
        correctChoiceId: 'a',
        explanation: 'Cockpit unions the added line ranges recorded in git snapshots.',
      },
      {
        questionId: 'q2',
        choiceId: 'a',
        correct: true,
        correctChoiceId: 'a',
        explanation: 'The newest provenance range records model gpt-4.1.',
      },
      {
        questionId: 'q3',
        choiceId: 'a',
        correct: true,
        correctChoiceId: 'a',
        explanation: 'The prompt excerpt is stored on the newest provenance entry.',
      },
    ],
    score: 1,
    correctCount: 3,
    total: 3,
    ...overrides,
  };
}

export function makeContextSnapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return ContextSnapshotSchema.parse({
    id: CONTEXT_SNAPSHOT_ID,
    sessionId: SESSION_ID,
    stepId: STEP_ONE_ID,
    provider: 'openai',
    model: 'gpt-4.1',
    totalTokens: 3200,
    contextWindow: 1_047_576,
    utilizationPercent: 0.3,
    measuredAt: '2026-04-05T06:07:00.000Z',
    ...overrides,
  });
}

export function makeContextSegment(overrides: Partial<ContextSegment> = {}): ContextSegment {
  return ContextSegmentSchema.parse({
    id: CONTEXT_SEGMENT_ID,
    snapshotId: CONTEXT_SNAPSHOT_ID,
    category: 'system',
    label: 'System prompt',
    tokens: 1200,
    percent: 37.5,
    preview: 'You are a careful coding agent.',
    ...overrides,
  });
}

export function makeContextInsight(overrides: Partial<ContextInsight> = {}): ContextInsight {
  return ContextInsightSchema.parse({
    id: CONTEXT_INSIGHT_ID,
    snapshotId: CONTEXT_SNAPSHOT_ID,
    type: 'large_tool_output',
    severity: 'medium',
    title: 'Large tool output in context',
    detail: 'Tool result contributes 1,800 estimated tokens (56% of this request).',
    paths: ['src/auth.ts'],
    estimatedSavingsTokens: 900,
    ...overrides,
  });
}

export function makeSessionContext(
  overrides: Partial<SessionContextResponse> = {},
): SessionContextResponse {
  const snapshot = makeContextSnapshot();
  return {
    sessionId: SESSION_ID,
    snapshots: [snapshot],
    latest: snapshot,
    ...overrides,
  };
}

export function makeContextDetail(
  overrides: Partial<ContextSnapshotDetailResponse> = {},
): ContextSnapshotDetailResponse {
  return {
    snapshot: makeContextSnapshot(),
    segments: [makeContextSegment()],
    insights: [makeContextInsight()],
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return ProjectSchema.parse({
    id: PROJECT_ID,
    name: 'cockpit',
    rootPath: 'C:\\work\\cockpit',
    createdAt: '2026-04-01T08:00:00.000Z',
    updatedAt: '2026-04-05T06:00:00.000Z',
    lastOpenedAt: '2026-04-05T06:00:00.000Z',
    ...overrides,
  });
}

export function makeAnalytics(overrides: Partial<AnalyticsResponse> = {}): AnalyticsResponse {
  return AnalyticsResponseSchema.parse({
    range: {
      from: '2026-03-30T00:00:00.000Z',
      to: '2026-04-05T00:00:00.000Z',
      days: 7,
    },
    totals: {
      sessionCount: 2,
      stepCount: 8,
      toolCallCount: 3,
      inputTokens: 1200,
      outputTokens: 400,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalCostUsd: 0.42,
      unknownCostCalls: 2,
      errorCount: 1,
    },
    daily: [
      {
        date: '2026-04-04',
        sessionCount: 1,
        stepCount: 5,
        inputTokens: 800,
        outputTokens: 250,
        totalCostUsd: 0.3,
        errorCount: 1,
      },
      {
        date: '2026-04-05',
        sessionCount: 1,
        stepCount: 3,
        inputTokens: 400,
        outputTokens: 150,
        totalCostUsd: 0.12,
        errorCount: 0,
      },
    ],
    models: [
      {
        provider: 'openai',
        model: 'gpt-4.1',
        sessionCount: 2,
        stepCount: 8,
        inputTokens: 1200,
        outputTokens: 400,
        totalCostUsd: 0.42,
      },
    ],
    agents: [{ agent: 'opencode', sessionCount: 2, stepCount: 8, totalCostUsd: 0.42 }],
    ...overrides,
  });
}

export function makeBrainStatus(overrides: Partial<BrainProjectStatus> = {}): BrainProjectStatus {
  return BrainProjectStatusSchema.parse({
    project: makeProject(),
    sources: [],
    outputs: [],
    drift: [],
    ...overrides,
  });
}

export function makeArenaRun(overrides: Partial<ArenaRun> = {}): ArenaRun {
  return ArenaRunSchema.parse({
    id: '18181818-1818-4818-8818-181818181818',
    sourceSessionId: SESSION_ID,
    sourceStepId: STEP_ONE_ID,
    provider: 'openai',
    model: 'gpt-5.1',
    status: 'completed',
    outputText: 'Done.',
    inputTokens: 500,
    outputTokens: 120,
    costUsd: 0.03,
    costKnown: true,
    latencyMs: 1200,
    startedAt: '2026-04-05T06:30:00.000Z',
    completedAt: '2026-04-05T06:30:01.200Z',
    createdAt: '2026-04-05T06:30:00.000Z',
    ...overrides,
  });
}

export function makeHandoffBrief(overrides: Partial<HandoffBrief> = {}): HandoffBrief {
  return HandoffBriefSchema.parse({
    id: '19191919-1919-4919-8919-191919191919',
    sessionId: SESSION_ID,
    title: 'Handoff · Auth hardening',
    contentMarkdown: '# Handoff\n\nResume at step 3.',
    generatedAt: '2026-04-05T06:40:00.000Z',
    ...overrides,
  });
}

export function makeJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return JournalEntrySchema.parse({
    id: '20202020-2020-4020-8020-202020202020',
    projectId: PROJECT_ID,
    weekStart: '2026-03-30',
    title: 'Week of 2026-03-30',
    markdown: '# Week of 2026-03-30\n\nShipped auth hardening.',
    createdAt: '2026-04-05T06:45:00.000Z',
    updatedAt: '2026-04-05T06:45:00.000Z',
    ...overrides,
  });
}

export function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return PluginSchema.parse({
    id: '21212121-2121-4121-8121-212121212122',
    name: 'example-guard',
    version: '0.1.0',
    description: 'Flags risky shell commands.',
    manifest: {
      apiVersion: 1,
      name: 'example-guard',
      version: '0.1.0',
      kind: 'guard',
      entry: 'index.mjs',
      permissions: [],
    },
    path: 'C:\\work\\plugins\\example-guard',
    enabled: true,
    installedAt: '2026-04-05T06:00:00.000Z',
    updatedAt: '2026-04-05T06:00:00.000Z',
    ...overrides,
  });
}

export function makePluginRun(overrides: Partial<PluginRun> = {}): PluginRun {
  return PluginRunSchema.parse({
    id: '23232323-2323-4323-8323-232323232323',
    pluginId: makePlugin().id,
    sessionId: SESSION_ID,
    kind: 'guard',
    status: 'ok',
    result: { findings: [] },
    startedAt: '2026-04-05T06:50:00.000Z',
    endedAt: '2026-04-05T06:50:01.000Z',
    ...overrides,
  });
}

export function makeDevice(overrides: Partial<Device> = {}): Device {
  return DeviceSchema.parse({
    id: '24242424-2424-4424-8424-242424242424',
    name: 'Pixel 9',
    platform: 'android',
    createdAt: '2026-04-05T06:00:00.000Z',
    ...overrides,
  });
}

export function makePairingSession(overrides: Partial<PairingSession> = {}): PairingSession {
  return {
    id: '25252525-2525-4525-8525-252525252525',
    code: 'ABCD-EFGH',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ttlSeconds: 300,
    urls: ['http://127.0.0.1:4319'],
    deepLink: 'cockpit://pair?url=http%3A%2F%2F127.0.0.1%3A4319&code=ABCD-EFGH',
    ...overrides,
  };
}

export function makePairingStatus(
  overrides: Partial<PairingSessionStatus> = {},
): PairingSessionStatus {
  return {
    id: makePairingSession().id,
    expiresAt: makePairingSession().expiresAt,
    expired: false,
    claimed: false,
    ...overrides,
  };
}

export function testClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    health: async () => HEALTH,
    stats: async () => ({ stats: EMPTY_STATS }),
    listSessions: async () => ({ sessions: [], nextCursor: null }),
    getSession: async () => ({ session: makeSession() }),
    getSessionSteps: async () => ({ steps: [] }),
    getStep: async () => ({ step: makeStep(), chunks: [], toolCalls: [] }),
    getSessionReplay: async () => makeReplay(),
    getSnapshot: async () => makeSnapshotDetail(),
    listForks: async () => ({ forks: [] }),
    createFork: async () => ({ fork: makeFork() }),
    removeFork: async () => ({ fork: makeFork({ status: 'removed' }) }),
    listGuardRules: async () => [makeGuardRule()],
    createGuardRule: async () => makeGuardRule(),
    updateGuardRule: async () => makeGuardRule(),
    deleteGuardRule: async () => true,
    listGuardEvents: async () => [makeGuardEvent()],
    decideGuardEvent: async () => makeGuardEvent({ status: 'approved' }),
    listBudgetPolicies: async () => [makeBudgetPolicy()],
    createBudgetPolicy: async () => makeBudgetPolicy(),
    updateBudgetPolicy: async () => makeBudgetPolicy(),
    deleteBudgetPolicy: async () => true,
    getSessionBudgets: async () => [makeBudgetStatus()],
    scanSession: async () => ({
      sessionId: SESSION_ID,
      scannedAt: '2026-04-05T06:20:00.000Z',
      findings: [],
      events: [],
      filesExamined: 2,
    }),
    getTrust: async () => ({ analysis: null }),
    analyzeTrust: async () => ({ analysis: null }),
    getSessionProvenance: async () => makeProvenanceResponse(),
    recomputeSessionProvenance: async () => makeProvenanceResponse(),
    listUnderstanding: async () => makeUnderstandingListResponse(),
    listSessionUnderstanding: async () => makeUnderstandingListResponse(),
    getUnderstanding: async () => makeUnderstandingDetail(),
    openUnderstanding: async () => ({
      file: makeUnderstandingFileView({ status: 'opened' }),
    }),
    acknowledgeUnderstanding: async () => ({
      file: makeUnderstandingFileView({
        status: 'acknowledged',
        reviewedLines: 12,
        unreviewedLines: 0,
        fileScore: 100,
      }),
    }),
    explainUnderstanding: async () => ({
      explanation:
        'src/auth.ts contains 12 AI-attributed lines across 1 recorded change range.\nYou opened this file but have not acknowledged it (3/12 lines reviewed).',
      generatedAt: '2026-04-05T06:23:00.000Z',
    }),
    startUnderstandingQuiz: async () => ({ quiz: makeQuizView() }),
    submitUnderstandingQuiz: async () => makeQuizSubmitResponse(),
    getSessionContext: async () => makeSessionContext(),
    recomputeSessionContext: async () => makeSessionContext(),
    getContextSnapshot: async () => makeContextDetail(),
    listProjects: async () => [makeProject()],
    getBrainStatus: async () => makeBrainStatus(),
    generateBrain: async () => makeBrainStatus(),
    syncBrain: async () => ({ results: [], status: makeBrainStatus() }),
    runArena: async () => [makeArenaRun()],
    listArenaRuns: async () => [makeArenaRun()],
    getArenaRun: async () => makeArenaRun(),
    listHandoffs: async () => [makeHandoffBrief()],
    generateHandoff: async () => makeHandoffBrief(),
    getHandoff: async () => makeHandoffBrief(),
    getAnalytics: async () => makeAnalytics(),
    listJournal: async () => [makeJournalEntry()],
    generateJournal: async () => makeJournalEntry(),
    getJournalEntry: async () => makeJournalEntry(),
    listPlugins: async () => [makePlugin()],
    installPlugin: async () => makePlugin(),
    updatePlugin: async () => makePlugin(),
    removePlugin: async () => true,
    runPlugin: async () => makePluginRun(),
    listPluginRuns: async () => [makePluginRun()],
    createPairing: async () => makePairingSession(),
    getPairingSession: async () => makePairingStatus(),
    cancelPairing: async () => undefined,
    claimPairing: async () => ({
      device: makeDevice(),
      token: `ckp_${'a'.repeat(43)}`,
      baseUrl: 'http://127.0.0.1:4319',
    }),
    listDevices: async () => [makeDevice()],
    revokeDevice: async () => makeDevice({ revokedAt: '2026-04-05T06:30:00.000Z' }),
    ...overrides,
  };
}

export interface RenderPageOptions {
  client?: ApiClient;
  route?: string;
  path?: string;
}

export function renderPage(ui: ReactElement, options: RenderPageOptions = {}): RenderResult {
  const client = options.client ?? testClient();
  const tree =
    options.path === undefined ? (
      ui
    ) : (
      <Routes>
        <Route path={options.path} element={ui} />
      </Routes>
    );

  return render(
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      <ApiProvider client={client}>{tree}</ApiProvider>
    </MemoryRouter>,
  );
}
