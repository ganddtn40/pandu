import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  DEMO_SEED_VERSION,
  DemoSeedResponseSchema,
  createId,
  estimateUsageCost,
  type DemoSeedResponse,
  type FinishReason,
  type JsonObject,
  type ProviderProtocol,
  type Session,
  type StepStatus,
  type TokenUsage,
} from '@cockpit/core';

import type { Store, ToolCallRecordInput } from '../store/store.js';

export const DEMO_MAIN_TITLE = 'Demo flight: add checkout rate limiting';
const DEMO_AUTH_TITLE = 'Demo flight: stabilize the auth refresh test';
const DEMO_DOCS_TITLE = 'Demo flight: document webhook retries';
const DEMO_SEARCH = 'Demo flight:';

const DEMO_BASE_COMMIT = '4f6c1b9a2d8e7f3012ab45cd90ef112233445566';
const DEMO_AFTER_COMMIT = '9a8b7c6d5e4f30211223344556677889900aabbcc';

export interface SeedDemoOptions {
  /** Override the clock for deterministic tests. */
  now?: Date;
  /** Override the synthetic workspace path. */
  workspacePath?: string;
}

interface DemoStepSpec {
  sessionId: string;
  provider: string;
  protocol: ProviderProtocol;
  model: string;
  systemPrompt: string;
  promptText: string;
  responseText: string;
  responseThinking?: string;
  usage: TokenUsage;
  toolCalls: ToolCallRecordInput[];
  startedAt: Date;
  endedAt: Date;
  status?: StepStatus;
  responseStatus?: number;
  finishReason?: FinishReason;
  error?: string;
  ttftMs?: number;
  stream?: boolean;
  metadata?: JsonObject;
}

function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function splitForStream(text: string, maxChars = 140): string[] {
  const pieces: string[] = [];
  let index = 0;
  while (index < text.length) {
    const end = Math.min(text.length, index + maxChars);
    pieces.push(text.slice(index, end));
    index = end;
  }
  return pieces;
}

function requestBody(
  protocol: ProviderProtocol,
  model: string,
  systemPrompt: string,
  promptText: string,
): JsonObject {
  if (protocol === 'anthropic') {
    return {
      model,
      max_tokens: 4096,
      stream: true,
      system: systemPrompt,
      messages: [{ role: 'user', content: promptText }],
    };
  }
  return {
    model,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: promptText },
    ],
  };
}

function recordModelStep(store: Store, spec: DemoStepSpec): string {
  const stream = spec.stream ?? true;
  const protocol = spec.protocol;
  const requestPath = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const step = store.beginStep({
    sessionId: spec.sessionId,
    kind: 'model',
    provider: spec.provider,
    model: spec.model,
    startedAt: spec.startedAt,
    request: {
      protocol,
      method: 'POST',
      path: requestPath,
      model: spec.model,
      stream,
      headers: {
        'content-type': 'application/json',
        'x-cockpit-demo': 'true',
      },
      body: requestBody(protocol, spec.model, spec.systemPrompt, spec.promptText),
      systemPrompt: spec.systemPrompt,
      promptText: spec.promptText,
      redactionCount: 0,
    },
    metadata: spec.metadata ?? { demo: true },
  });

  if (stream && spec.status !== 'failed') {
    const pieces = splitForStream(spec.responseText);
    const duration = Math.max(1, spec.endedAt.getTime() - spec.startedAt.getTime());
    store.insertStreamChunks(
      pieces.map((piece, index) => ({
        stepId: step.id,
        seq: index,
        kind: 'text',
        data: JSON.stringify(
          protocol === 'anthropic'
            ? { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } }
            : { choices: [{ delta: { content: piece } }] },
        ),
        deltaText: piece,
        receivedAt: new Date(
          spec.startedAt.getTime() + Math.round((duration * (index + 1)) / (pieces.length + 1)),
        ),
      })),
    );
  }

  const cost = estimateUsageCost(spec.usage, spec.model, spec.provider);
  const status = spec.status ?? 'completed';
  const latencyMs = Math.max(0, spec.endedAt.getTime() - spec.startedAt.getTime());

  store.completeStep(
    step.id,
    {
      status,
      model: spec.model,
      responseStatus: spec.responseStatus ?? (status === 'failed' ? 502 : 200),
      responseHeaders: {
        'content-type': stream ? 'text/event-stream' : 'application/json',
        'x-cockpit-demo': 'true',
      },
      ...(status === 'failed' ? {} : { responseText: spec.responseText }),
      ...(spec.responseThinking ? { responseThinking: spec.responseThinking } : {}),
      finishReason: spec.finishReason ?? (status === 'failed' ? 'error' : 'stop'),
      ...(spec.error ? { error: spec.error } : {}),
      usage: spec.usage,
      ...(cost.known ? { costUsd: cost.usd } : {}),
      costKnown: cost.known,
      ttftMs: spec.ttftMs ?? Math.min(900, Math.round(latencyMs / 8)),
      latencyMs,
      endedAt: spec.endedAt,
      metadata: { demo: true },
    },
    spec.toolCalls,
  );

  return step.id;
}

function collectDemoSessions(store: Store, main: Session): Session[] {
  const ids = new Set<string>([main.id]);
  const value = main.metadata?.['demoSessionIds'];
  if (Array.isArray(value)) {
    for (const id of value) {
      if (typeof id === 'string') ids.add(id);
    }
  }

  return [...ids]
    .map((id) => store.getSession(id))
    .filter((session): session is Session => session !== undefined);
}

function summarize(
  store: Store,
  main: Session,
  workspacePath: string,
  created: boolean,
): DemoSeedResponse {
  const sessions = collectDemoSessions(store, main);
  const guardEvents = store.listGuardEvents({ sessionId: main.id, limit: 500 });

  return DemoSeedResponseSchema.parse({
    created,
    seedVersion: DEMO_SEED_VERSION,
    sessionId: main.id,
    workspacePath,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      source: session.source,
      startedAt: session.startedAt,
    })),
    totals: {
      steps: sessions.reduce((sum, session) => sum + session.totals.stepCount, 0),
      toolCalls: sessions.reduce((sum, session) => sum + session.totals.toolCallCount, 0),
      guardEvents: guardEvents.length,
    },
  });
}

function findExistingDemo(store: Store): Session | undefined {
  const page = store.listSessions({ search: DEMO_SEARCH, limit: 20 });
  return page.sessions.find(
    (session) =>
      session.source === 'demo' &&
      session.title === DEMO_MAIN_TITLE &&
      session.metadata?.['demoSeed'] === DEMO_SEED_VERSION,
  );
}

/**
 * Seed a small, realistic history without contacting an agent or a provider.
 * The operation is idempotent: the same main demo flight is reused on every
 * call, so `cockpit demo` is safe to run repeatedly.
 */
export function seedDemoData(store: Store, options: SeedDemoOptions = {}): DemoSeedResponse {
  const existing = findExistingDemo(store);
  if (existing) {
    return summarize(
      store,
      existing,
      existing.workspacePath ?? options.workspacePath ?? defaultWorkspacePath(),
      false,
    );
  }

  const now = options.now ?? new Date();
  const workspacePath = options.workspacePath ?? defaultWorkspacePath();
  const project = store.ensureProject(workspacePath, 'aurora-notes');

  const authSession = seedAuthSession(store, project.id, workspacePath, now);
  const docsSession = seedDocsSession(store, project.id, workspacePath, now);
  const main = seedMainSession(store, project.id, workspacePath, now, [
    authSession.id,
    docsSession.id,
  ]);

  return summarize(store, main, workspacePath, true);
}

function defaultWorkspacePath(): string {
  return path.join(os.homedir(), 'projects', 'aurora-notes');
}

function seedAuthSession(
  store: Store,
  projectId: string,
  workspacePath: string,
  now: Date,
): Session {
  const startedAt = minutesBefore(now, 2 * 24 * 60 + 14);
  const session = store.createSession({
    title: DEMO_AUTH_TITLE,
    source: 'demo',
    provider: 'anthropic',
    protocol: 'anthropic',
    model: 'claude-sonnet-4',
    agent: {
      name: 'Cline',
      version: '3.48.0',
      userAgent: 'Cline/3.48.0',
      detectedFrom: 'demo',
    },
    workspacePath,
    gitBranch: 'fix/auth-refresh',
    gitBaseCommit: DEMO_BASE_COMMIT,
    projectId,
    tags: ['demo', 'auth'],
    metadata: {
      demoSeed: DEMO_SEED_VERSION,
      demoScenario: 'auth-refresh',
    },
    startedAt,
  });

  recordModelStep(store, {
    sessionId: session.id,
    provider: 'anthropic',
    protocol: 'anthropic',
    model: 'claude-sonnet-4',
    systemPrompt:
      'You are Cline, a precise coding agent. Reproduce failures before changing code and keep the fix narrow.',
    promptText:
      'The auth refresh test fails roughly one run in five. Reproduce it, identify the race, and fix it without changing the public auth API.',
    responseText:
      'I can reproduce the flake. The refresh test starts two requests against the same rotating token. The second request can read the token after the first rotation, so it sees a stale value.\n\nI will serialize rotation per session and add a regression test that fires both requests at once.',
    usage: {
      inputTokens: 9_800,
      outputTokens: 720,
      cacheReadTokens: 7_400,
      cacheWriteTokens: 1_200,
      reasoningTokens: 0,
    },
    toolCalls: [
      {
        providerToolCallId: 'call_demo_auth_1',
        name: 'bash',
        input: { command: 'pnpm test --filter auth -- --repeat 20', path: 'packages/auth' },
      },
    ],
    startedAt,
    endedAt: new Date(startedAt.getTime() + 3.5 * 60_000),
    ttftMs: 740,
  });

  recordModelStep(store, {
    sessionId: session.id,
    provider: 'anthropic',
    protocol: 'anthropic',
    model: 'claude-sonnet-4',
    systemPrompt:
      'You are Cline, a precise coding agent. Reproduce failures before changing code and keep the fix narrow.',
    promptText:
      'Apply the per-session rotation lock and prove the flake is gone with the repeated test run.',
    responseText:
      'Added a per-session async lock around token rotation and a regression test that runs both refresh requests concurrently. The repeated suite passed 20/20.',
    usage: {
      inputTokens: 14_200,
      outputTokens: 2_180,
      cacheReadTokens: 10_800,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    toolCalls: [
      {
        providerToolCallId: 'call_demo_auth_2',
        name: 'edit',
        input: { path: 'src/auth/rotate.ts', summary: 'Serialize rotation per session' },
      },
      {
        providerToolCallId: 'call_demo_auth_3',
        name: 'edit',
        input: { path: 'tests/auth.test.ts', summary: 'Add concurrent refresh regression test' },
      },
      {
        providerToolCallId: 'call_demo_auth_4',
        name: 'bash',
        input: { command: 'pnpm test --filter auth -- --repeat 20', path: 'packages/auth' },
      },
    ],
    startedAt: new Date(startedAt.getTime() + 4 * 60_000),
    endedAt: new Date(startedAt.getTime() + 9 * 60_000),
    ttftMs: 680,
  });

  store.endSession(session.id, 'completed', new Date(startedAt.getTime() + 9.5 * 60_000));
  const completed = store.getSession(session.id);
  if (!completed) throw new Error('Failed to read the seeded auth session.');
  return completed;
}

function seedDocsSession(
  store: Store,
  projectId: string,
  workspacePath: string,
  now: Date,
): Session {
  const startedAt = minutesBefore(now, 5 * 24 * 60 + 8);
  const session = store.createSession({
    title: DEMO_DOCS_TITLE,
    source: 'demo',
    provider: 'openai',
    protocol: 'openai',
    model: 'gpt-4.1',
    agent: {
      name: 'Aider',
      version: '0.86.0',
      userAgent: 'Aider/0.86.0',
      detectedFrom: 'demo',
    },
    workspacePath,
    gitBranch: 'docs/webhook-retries',
    gitBaseCommit: DEMO_BASE_COMMIT,
    projectId,
    tags: ['demo', 'docs'],
    metadata: {
      demoSeed: DEMO_SEED_VERSION,
      demoScenario: 'webhook-docs',
    },
    startedAt,
  });

  recordModelStep(store, {
    sessionId: session.id,
    provider: 'openai',
    protocol: 'openai',
    model: 'gpt-4.1',
    systemPrompt:
      'You are Aider, a careful documentation editor. Match the existing docs style and never invent behavior that is not in the code.',
    promptText:
      'Document the webhook retry policy in docs/webhooks.md. Read the retry implementation first so the backoff numbers are exact.',
    responseText:
      'Documented the retry schedule: five attempts, exponential backoff starting at 30 seconds, full jitter, and a 24-hour dead-letter window. Linked the implementation and added a short example payload.',
    usage: {
      inputTokens: 7_200,
      outputTokens: 1_640,
      cacheReadTokens: 5_100,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    toolCalls: [
      {
        providerToolCallId: 'call_demo_docs_1',
        name: 'edit',
        input: {
          path: 'docs/webhooks.md',
          summary: 'Document retry schedule and dead-letter window',
        },
      },
    ],
    startedAt,
    endedAt: new Date(startedAt.getTime() + 4 * 60_000),
    ttftMs: 510,
  });

  store.endSession(session.id, 'completed', new Date(startedAt.getTime() + 4.5 * 60_000));
  const completed = store.getSession(session.id);
  if (!completed) throw new Error('Failed to read the seeded docs session.');
  return completed;
}

function seedMainSession(
  store: Store,
  projectId: string,
  workspacePath: string,
  now: Date,
  demoSessionIds: string[],
): Session {
  const startedAt = minutesBefore(now, 22);
  const session = store.createSession({
    title: DEMO_MAIN_TITLE,
    source: 'demo',
    provider: 'openai',
    protocol: 'openai',
    model: 'gpt-4.1',
    agent: {
      name: 'opencode',
      version: '1.14.0',
      userAgent: 'opencode/1.14.0',
      detectedFrom: 'demo',
    },
    workspacePath,
    gitBranch: 'feat/checkout-rate-limit',
    gitBaseCommit: DEMO_BASE_COMMIT,
    projectId,
    tags: ['demo', 'rate-limiting', 'checkout'],
    metadata: {
      demoSeed: DEMO_SEED_VERSION,
      demoScenario: 'checkout-rate-limit',
      demoSessionIds,
    },
    startedAt,
  });

  const systemPrompt =
    'You are opencode, a careful coding agent. Read the repository before editing. Keep diffs small, run the focused test suite, and never weaken an assertion to make a test pass.';
  const planPrompt =
    'Add a sliding-window rate limiter to POST /api/checkout. Keep the existing tests green and document the 429 response.';

  const planStep = recordModelStep(store, {
    sessionId: session.id,
    provider: 'openai',
    protocol: 'openai',
    model: 'gpt-4.1',
    systemPrompt,
    promptText: planPrompt,
    responseText:
      'Plan:\n1. Read the checkout handler and the Redis client.\n2. Add a reusable sliding-window limiter in src/lib/rate-limit.ts.\n3. Wire it into POST /api/checkout with a 429 and a Retry-After header.\n4. Cover the limit, the Retry-After value, and the Redis outage fallback.\n\nI will keep the limiter injectable so tests do not need a live Redis instance.',
    usage: {
      inputTokens: 14_800,
      outputTokens: 980,
      cacheReadTokens: 9_600,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    toolCalls: [
      {
        providerToolCallId: 'call_demo_plan_1',
        name: 'read',
        input: { path: 'src/api/checkout.ts' },
      },
      {
        providerToolCallId: 'call_demo_plan_2',
        name: 'read',
        input: { path: 'src/lib/redis.ts' },
      },
    ],
    startedAt,
    endedAt: new Date(startedAt.getTime() + 1.5 * 60_000),
    ttftMs: 620,
  });

  const implementStep = recordModelStep(store, {
    sessionId: session.id,
    provider: 'openai',
    protocol: 'openai',
    model: 'gpt-4.1',
    systemPrompt,
    promptText:
      'Implement the plan. Use Redis when it is available and fall back to an in-memory window when it is not.',
    responseText:
      'Added createRateLimiter with a sorted-set window and a small in-memory fallback. POST /api/checkout now returns 429 with Retry-After. Next I will run the focused checkout suite.',
    usage: {
      inputTokens: 31_200,
      outputTokens: 5_640,
      cacheReadTokens: 22_400,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    toolCalls: [
      {
        providerToolCallId: 'call_demo_impl_1',
        name: 'edit',
        input: { path: 'src/lib/rate-limit.ts', summary: 'Add sliding-window limiter' },
      },
      {
        providerToolCallId: 'call_demo_impl_2',
        name: 'edit',
        input: { path: 'src/api/checkout.ts', summary: 'Enforce limit and set Retry-After' },
      },
      {
        providerToolCallId: 'call_demo_impl_3',
        name: 'bash',
        input: { command: 'pnpm test --filter checkout', path: 'packages/api' },
      },
    ],
    startedAt: new Date(startedAt.getTime() + 1.7 * 60_000),
    endedAt: new Date(startedAt.getTime() + 6 * 60_000),
    ttftMs: 710,
  });

  const failedAt = new Date(startedAt.getTime() + 6.2 * 60_000);
  recordModelStep(store, {
    sessionId: session.id,
    provider: 'openai',
    protocol: 'openai',
    model: 'gpt-4.1',
    systemPrompt,
    promptText: 'The checkout suite failed. Triage the failure and explain the smallest safe fix.',
    responseText: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    toolCalls: [],
    startedAt: failedAt,
    endedAt: new Date(failedAt.getTime() + 1.4 * 60_000),
    status: 'failed',
    responseStatus: 529,
    finishReason: 'error',
    error: 'The upstream returned 529 (overloaded) after 60s while triaging the checkout test.',
    ttftMs: 60_000,
    stream: false,
  });

  const fixStep = recordModelStep(store, {
    sessionId: session.id,
    provider: 'openai',
    protocol: 'openai',
    model: 'gpt-4.1',
    systemPrompt,
    promptText:
      'The Redis mock returned null instead of a count. Fix the fallback and make the 429 assertion exact.',
    responseText:
      'The Redis mock returned null instead of a count, so the limiter fell through. I added a null-safe fallback and tightened the assertion to 429 with a Retry-After check. The suite is green now.',
    usage: {
      inputTokens: 24_600,
      outputTokens: 3_980,
      cacheReadTokens: 18_200,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    toolCalls: [
      {
        providerToolCallId: 'call_demo_fix_1',
        name: 'edit',
        input: { path: 'src/lib/rate-limit.ts', summary: 'Handle a null Redis count' },
      },
      {
        providerToolCallId: 'call_demo_fix_2',
        name: 'edit',
        input: { path: 'tests/checkout.test.ts', summary: 'Assert 429 and Retry-After' },
      },
      {
        providerToolCallId: 'call_demo_fix_3',
        name: 'bash',
        input: { command: 'pnpm test --filter checkout', path: 'packages/api' },
      },
    ],
    startedAt: new Date(startedAt.getTime() + 7.8 * 60_000),
    endedAt: new Date(startedAt.getTime() + 13 * 60_000),
    ttftMs: 660,
  });

  recordModelStep(store, {
    sessionId: session.id,
    provider: 'openai',
    protocol: 'openai',
    model: 'gpt-4.1',
    systemPrompt,
    promptText:
      'Summarize the change for a reviewer. Mention tests, operational behavior, and anything still open.',
    responseText:
      'All 12 checkout tests pass. The limiter returns 429 with Retry-After, falls back to an in-memory window when Redis is unavailable, and docs/api.md now documents the response. Open question: the in-memory fallback is per-process, so a multi-instance deployment still needs Redis.',
    usage: {
      inputTokens: 19_400,
      outputTokens: 1_240,
      cacheReadTokens: 15_100,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    toolCalls: [
      {
        providerToolCallId: 'call_demo_summary_1',
        name: 'bash',
        input: { command: 'pnpm test --filter checkout', path: 'packages/api' },
      },
    ],
    startedAt: new Date(startedAt.getTime() + 13.2 * 60_000),
    endedAt: new Date(startedAt.getTime() + 16 * 60_000),
    ttftMs: 540,
  });

  const endedAt = minutesBefore(now, 5);
  store.endSession(session.id, 'completed', endedAt);

  store.insertGuardEvent({
    sessionId: session.id,
    stepId: planStep,
    ruleId: 'builtin-secret-api-key',
    kind: 'secret',
    action: 'warn',
    severity: 'high',
    status: 'redacted',
    title: 'Provider API key redacted from the prompt',
    description:
      'A provider token was present in the request body. The recorder replaced it before the request left the machine and before it was stored.',
    evidence: [
      {
        field: 'request.body.messages[1].content',
        excerpt: 'AURORA_API_KEY=[redacted]',
      },
    ],
    requestedAt: new Date(startedAt.getTime() + 20_000),
    resolvedAt: new Date(startedAt.getTime() + 20_000),
    resolvedBy: 'recorder',
    resolutionNote: 'The value never reached the upstream or the database.',
    metadata: { demo: true },
  });

  store.insertGuardEvent({
    sessionId: session.id,
    stepId: implementStep,
    ruleId: 'builtin-dangerous-command',
    kind: 'dangerous_command',
    action: 'pause',
    severity: 'critical',
    status: 'approved',
    title: 'Destructive command paused for approval',
    description:
      'The agent asked to clear a cache directory outside the workspace. The request waited for a local decision.',
    command: 'rm -rf ~/.cache/aurora',
    evidence: [
      {
        field: 'request.body.messages[1].content',
        excerpt: 'rm -rf ~/.cache/aurora',
      },
    ],
    requestedAt: new Date(startedAt.getTime() + 3 * 60_000),
    resolvedAt: new Date(startedAt.getTime() + 3.4 * 60_000),
    resolvedBy: 'local',
    resolutionNote: 'Cache-only path; approved after checking the working tree.',
    metadata: { demo: true },
  });

  store.insertContextSnapshot({
    sessionId: session.id,
    stepId: fixStep,
    provider: 'openai',
    model: 'gpt-4.1',
    totalTokens: 92_480,
    contextWindow: 1_047_576,
    measuredAt: minutesBefore(now, 8),
    segments: [
      {
        category: 'system',
        label: 'System prompt',
        tokens: 2_100,
        percent: 2.27,
      },
      {
        category: 'rules',
        label: 'AGENTS.md',
        tokens: 3_600,
        percent: 3.89,
        sourcePath: 'AGENTS.md',
        preview: 'Run the focused suite before the full suite. Never weaken assertions.',
      },
      {
        category: 'files',
        label: 'Checkout and limiter source',
        tokens: 52_300,
        percent: 56.55,
        sourcePath: 'src/api/checkout.ts',
      },
      {
        category: 'history',
        label: 'Conversation history',
        tokens: 24_180,
        percent: 26.15,
      },
      {
        category: 'tool_output',
        label: 'Checkout test output',
        tokens: 10_300,
        percent: 11.14,
        sourcePath: 'test-results/checkout.log',
      },
    ],
    insights: [
      {
        type: 'large_tool_output',
        severity: 'medium',
        title: 'Checkout test output dominates the context',
        detail:
          'The full Vitest reporter is still in context. Keep only the failing assertion summary while triaging.',
        paths: ['test-results/checkout.log'],
        estimatedSavingsTokens: 6_400,
      },
      {
        type: 'stale_file',
        severity: 'low',
        title: 'AGENTS.md references a removed Redis helper',
        detail: 'The rules mention createRedisClient, but the repository now exports getRedis.',
        paths: ['AGENTS.md'],
        estimatedSavingsTokens: 800,
      },
      {
        type: 'duplicate_instruction',
        severity: 'info',
        title: 'The testing rule appears twice',
        detail: 'The same focused-test instruction is repeated in AGENTS.md and docs/testing.md.',
        paths: ['AGENTS.md', 'docs/testing.md'],
        estimatedSavingsTokens: 420,
      },
    ],
  });

  store.insertSnapshot({
    sessionId: session.id,
    kind: 'before',
    commitSha: DEMO_BASE_COMMIT,
    branch: 'feat/checkout-rate-limit',
    worktreePath: workspacePath,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    fileChanges: [],
    createdAt: startedAt,
  });

  store.insertSnapshot({
    sessionId: session.id,
    stepId: fixStep,
    kind: 'after',
    commitSha: DEMO_AFTER_COMMIT,
    parentCommitSha: DEMO_BASE_COMMIT,
    branch: 'feat/checkout-rate-limit',
    worktreePath: workspacePath,
    patch: [
      `diff --git a/src/lib/rate-limit.ts b/src/lib/rate-limit.ts`,
      `new file mode 100644`,
      `--- /dev/null`,
      `+++ b/src/lib/rate-limit.ts`,
      `@@ -0,0 +1,84 @@`,
      `+export function createRateLimiter(...) { ... }`,
    ].join('\n'),
    filesChanged: 3,
    insertions: 124,
    deletions: 4,
    fileChanges: [
      {
        path: 'src/lib/rate-limit.ts',
        changeType: 'added',
        additions: 84,
        deletions: 0,
        aiAuthored: true,
        diff: `@@ -0,0 +1,84 @@\n+export function createRateLimiter(options: RateLimiterOptions) { ... }`,
      },
      {
        path: 'src/api/checkout.ts',
        changeType: 'modified',
        additions: 22,
        deletions: 4,
        aiAuthored: true,
        diff: `@@ -40,7 +40,25 @@\n+const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });`,
      },
      {
        path: 'tests/checkout.test.ts',
        changeType: 'modified',
        additions: 18,
        deletions: 0,
        aiAuthored: true,
        diff: `@@ -88,6 +88,24 @@\n+expect(response.status).toBe(429);\n+expect(response.headers.get('retry-after')).toBeTruthy();`,
      },
    ],
    createdAt: minutesBefore(now, 6),
  });

  store.replaceCheatAnalysis({
    sessionId: session.id,
    stepId: fixStep,
    trustScore: 88,
    grade: 'B',
    filesExamined: 7,
    generatedAt: minutesBefore(now, 5.5),
    findings: [
      {
        id: createId(),
        sessionId: session.id,
        stepId: fixStep,
        category: 'weakened_test',
        severity: 'low',
        title: 'Assertion was loosened while fixing the 429 test',
        detail:
          'The new assertion accepts any 4xx response instead of the expected 429, which could hide a regression.',
        detector: 'assertion-diff',
        confidence: 0.9,
        evidence: [
          {
            filePath: 'tests/checkout.test.ts',
            startLine: 92,
            endLine: 96,
            excerpt: 'expect(response.status).toBeGreaterThanOrEqual(400);',
          },
        ],
        suggestion: 'Assert response.status === 429 and check the Retry-After header.',
        createdAt: minutesBefore(now, 5.5).toISOString(),
      },
      {
        id: createId(),
        sessionId: session.id,
        stepId: fixStep,
        category: 'empty_catch',
        severity: 'medium',
        title: 'Redis fallback swallows errors',
        detail:
          'The catch block returns an empty result, so a Redis outage is invisible in logs and metrics.',
        detector: 'empty-catch',
        confidence: 0.9,
        evidence: [
          {
            filePath: 'src/lib/rate-limit.ts',
            startLine: 61,
            endLine: 67,
            excerpt: 'try { return await redis.count(key); } catch { return null; }',
          },
        ],
        suggestion: 'Log the failure at warn level and emit a metric before falling back.',
        createdAt: minutesBefore(now, 5.5).toISOString(),
      },
    ],
  });

  store.insertProvenanceEntries([
    {
      projectId,
      sessionId: session.id,
      stepId: implementStep,
      filePath: 'src/lib/rate-limit.ts',
      lineStart: 1,
      lineEnd: 84,
      commitSha: DEMO_AFTER_COMMIT,
      contentHash: sha256('demo:src/lib/rate-limit.ts'),
      provider: 'openai',
      model: 'gpt-4.1',
      promptExcerpt: 'Add a sliding-window rate limiter to POST /api/checkout.',
      confidence: 0.95,
      capturedAt: minutesBefore(now, 9),
    },
    {
      projectId,
      sessionId: session.id,
      stepId: fixStep,
      filePath: 'src/api/checkout.ts',
      lineStart: 40,
      lineEnd: 61,
      commitSha: DEMO_AFTER_COMMIT,
      contentHash: sha256('demo:src/api/checkout.ts'),
      provider: 'openai',
      model: 'gpt-4.1',
      promptExcerpt: 'Wire the limiter into POST /api/checkout with a 429 and Retry-After.',
      confidence: 0.9,
      capturedAt: minutesBefore(now, 9),
    },
    {
      projectId,
      sessionId: session.id,
      stepId: fixStep,
      filePath: 'tests/checkout.test.ts',
      lineStart: 88,
      lineEnd: 106,
      commitSha: DEMO_AFTER_COMMIT,
      contentHash: sha256('demo:tests/checkout.test.ts'),
      provider: 'openai',
      model: 'gpt-4.1',
      promptExcerpt: 'Cover the limit, the Retry-After value, and the Redis outage fallback.',
      confidence: 0.86,
      capturedAt: minutesBefore(now, 9),
    },
  ]);

  store.createUnderstandingFile({
    projectId,
    sessionId: session.id,
    path: 'src/lib/rate-limit.ts',
    aiLines: 84,
    status: 'unseen',
    firstTouchedAt: minutesBefore(now, 16),
    lastTouchedAt: minutesBefore(now, 16),
  });

  const checkoutFile = store.createUnderstandingFile({
    projectId,
    sessionId: session.id,
    path: 'src/api/checkout.ts',
    aiLines: 22,
    reviewedLines: 8,
    status: 'opened',
    firstTouchedAt: minutesBefore(now, 16),
    lastTouchedAt: minutesBefore(now, 9),
    lastOpenedAt: minutesBefore(now, 3),
    explanation:
      'The limiter is created once at module scope and receives the Redis client through the existing dependency container.',
  });

  const testFile = store.createUnderstandingFile({
    projectId,
    sessionId: session.id,
    path: 'tests/checkout.test.ts',
    aiLines: 18,
    reviewedLines: 18,
    status: 'acknowledged',
    firstTouchedAt: minutesBefore(now, 9),
    lastTouchedAt: minutesBefore(now, 9),
    lastOpenedAt: minutesBefore(now, 3),
    acknowledgedAt: minutesBefore(now, 2),
    explanation: 'Covers the 429 response, the Retry-After header, and the Redis outage fallback.',
  });

  store.insertUnderstandingEvent({
    understandingFileId: checkoutFile.id,
    type: 'opened',
    occurredAt: minutesBefore(now, 3),
    metadata: { via: 'dashboard' },
  });
  store.insertUnderstandingEvent({
    understandingFileId: testFile.id,
    type: 'opened',
    occurredAt: minutesBefore(now, 3),
    metadata: { via: 'dashboard' },
  });
  store.insertUnderstandingEvent({
    understandingFileId: testFile.id,
    type: 'acknowledged',
    occurredAt: minutesBefore(now, 2),
    metadata: { via: 'dashboard' },
  });

  store.createComprehensionQuiz({
    understandingFileId: testFile.id,
    generatedAt: minutesBefore(now, 2),
    questions: [
      {
        id: 'q1',
        prompt: 'What status code does the limiter return when the window is exhausted?',
        choices: [
          { id: 'a', text: '400 Bad Request' },
          { id: 'b', text: '429 Too Many Requests' },
          { id: 'c', text: '503 Service Unavailable' },
        ],
        correctChoiceId: 'b',
        explanation: 'The limiter rejects with 429 and includes a Retry-After header.',
      },
      {
        id: 'q2',
        prompt: 'What happens when Redis is unavailable?',
        choices: [
          { id: 'a', text: 'Every request is rejected' },
          { id: 'b', text: 'The limiter falls back to an in-memory window' },
          { id: 'c', text: 'The checkout endpoint crashes' },
        ],
        correctChoiceId: 'b',
        explanation:
          'The fallback keeps checkout available, but it is per-process and not shared across instances.',
      },
      {
        id: 'q3',
        prompt: 'Which header tells a client when it may retry?',
        choices: [
          { id: 'a', text: 'Retry-After' },
          { id: 'b', text: 'X-RateLimit-Reset' },
          { id: 'c', text: 'Cache-Control' },
        ],
        correctChoiceId: 'a',
        explanation: 'Retry-After is the standard response header for a 429.',
      },
    ],
  });

  const completed = store.getSession(session.id);
  if (!completed) throw new Error('Failed to read the seeded demo session.');
  return completed;
}
