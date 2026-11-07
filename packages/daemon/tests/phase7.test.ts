import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnalyticsResponseSchema,
  ArenaRunsResponseSchema,
  BrainProjectStatusSchema,
  BrainSyncResponseSchema,
  HandoffBriefResponseSchema,
  HandoffBriefsResponseSchema,
  JournalEntriesResponseSchema,
  JournalEntryResponseSchema,
  PluginResponseSchema,
  PluginRunResponseSchema,
  PluginRunsResponseSchema,
  PluginsResponseSchema,
  ProjectsResponseSchema,
  RemovePluginResponseSchema,
  type CapturedStep,
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

interface PhaseSevenContext {
  directory: string;
  repository: string;
  upstream: FakeUpstream;
  daemon: StartedDaemon;
}

const CONTEXTS: PhaseSevenContext[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function boot(handlerOverride?: UpstreamHandler): Promise<PhaseSevenContext> {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-phase7-'));
  const repository = path.join(directory, 'workspace');
  mkdirSync(path.join(repository, 'src'), { recursive: true });

  writeFileSync(
    path.join(repository, 'package.json'),
    JSON.stringify(
      {
        name: 'phase7-workspace',
        private: true,
        scripts: { build: 'tsc -p .', test: 'vitest run', lint: 'eslint .' },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(path.join(repository, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  writeFileSync(path.join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(repository, 'README.md'), '# Phase 7 workspace\n\nA test repository.\n');
  writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const ready = true;\n');

  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.name', 'Cockpit Test']);
  git(repository, ['config', 'user.email', 'cockpit-test@localhost']);
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'initial']);

  const handler: UpstreamHandler =
    handlerOverride ??
    ((request, response) => {
      const body = JSON.parse(request.body.toString('utf8')) as { model?: string };
      const model = body.model ?? 'unknown';
      const content = [
        `Model ${model} says hello.`,
        '',
        '```diff',
        '--- a/app.ts',
        '+++ b/app.ts',
        '@@ -1 +1 @@',
        '-export const retry = 1;',
        '+export const retry = 3;',
        '```',
      ].join('\n');

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-phase7',
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
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

function createWorkspaceSession(daemon: StartedDaemon, repository: string): Session {
  return daemon.sessions.create({
    source: 'manual',
    title: 'Phase 7 fixture',
    tags: [],
    workspacePath: repository,
    gitBranch: 'main',
    agent: { name: 'opencode', version: '1.0.0', detectedFrom: 'manual' },
  });
}

function recordStep(
  daemon: StartedDaemon,
  session: Session,
  prompt: string,
  responseText = 'Done.',
): CapturedStep {
  const handle = daemon.recorder.begin({
    sessionId: session.id,
    protocol: 'openai',
    provider: 'openai',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer sk-user-secret',
    },
    bodyText: JSON.stringify({
      model: 'gpt-4o-mini',
      stream: true,
      api_key: 'sk-user-secret',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  daemon.recorder.finish(handle, {
    status: 'completed',
    responseStatus: 200,
    responseHeaders: { 'content-type': 'application/json' },
    collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
      id: 'chatcmpl-phase7',
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: responseText },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }),
  });

  return handle.step;
}

async function requestJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    payload: text.length > 0 ? (JSON.parse(text) as unknown) : undefined,
  };
}

function postJson(url: string, body: unknown): Promise<{ status: number; payload: unknown }> {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchJson(url: string, body: unknown): Promise<{ status: number; payload: unknown }> {
  return requestJson(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function utcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

describe('Project Brain', () => {
  it('generates from repository facts, syncs safely, and refuses to overwrite drift', async () => {
    const { daemon, repository } = await boot();
    const session = createWorkspaceSession(daemon, repository);
    recordStep(daemon, session, 'Phase 7 fixture prompt');
    const projectId = session.projectId;
    expect(projectId).toBeDefined();

    const projects = await requestJson(`${daemon.url}/api/projects`);
    expect(projects.status).toBe(200);
    const projectList = ProjectsResponseSchema.parse(projects.payload);
    expect(projectList.projects.map((project) => project.id)).toContain(projectId);

    const generate = await postJson(
      `${daemon.url}/api/projects/${projectId ?? ''}/brain/generate`,
      {
        formats: ['agents_md'],
      },
    );
    expect(generate.status).toBe(200);
    const generated = BrainProjectStatusSchema.parse(generate.payload);
    expect(generated.sources.map((source) => source.path)).toEqual(
      expect.arrayContaining(['README.md', 'package.json', 'tsconfig.json', 'src/']),
    );
    expect(generated.outputs).toHaveLength(1);
    const output = generated.outputs[0]!;
    expect(output.format).toBe('agents_md');
    expect(output.path).toBe('AGENTS.md');
    expect(output.existsOnDisk).toBe(false);
    expect(output.drifted).toBe(false);
    expect(output.content).toContain('# Agent Instructions');
    expect(output.content).toContain('TypeScript');
    expect(output.content).toContain('pnpm run build');
    expect(output.content).toContain('Phase 7 fixture prompt');
    expect(output.content).toContain('Steps: 1');

    const status = await requestJson(`${daemon.url}/api/projects/${projectId ?? ''}/brain`);
    expect(status.status).toBe(200);
    expect(BrainProjectStatusSchema.parse(status.payload).outputs[0]?.existsOnDisk).toBe(false);

    const dryRun = await postJson(`${daemon.url}/api/projects/${projectId ?? ''}/brain/sync`, {
      formats: ['agents_md'],
      dryRun: true,
    });
    expect(dryRun.status).toBe(200);
    const dryRunResult = BrainSyncResponseSchema.parse(dryRun.payload);
    expect(dryRunResult.results[0]).toMatchObject({ action: 'written', path: 'AGENTS.md' });
    expect(dryRunResult.results[0]?.message).toContain('Dry run');
    expect(() => readFileSync(path.join(repository, 'AGENTS.md'), 'utf8')).toThrow();

    const write = await postJson(`${daemon.url}/api/projects/${projectId ?? ''}/brain/sync`, {
      formats: ['agents_md'],
    });
    expect(write.status).toBe(200);
    const written = BrainSyncResponseSchema.parse(write.payload);
    expect(written.results[0]?.action).toBe('written');
    expect(readFileSync(path.join(repository, 'AGENTS.md'), 'utf8')).toBe(output.content);
    expect(written.status.outputs[0]?.existsOnDisk).toBe(true);
    expect(written.status.outputs[0]?.syncedAt).toBeDefined();

    const unchanged = await postJson(`${daemon.url}/api/projects/${projectId ?? ''}/brain/sync`, {
      formats: ['agents_md'],
    });
    expect(BrainSyncResponseSchema.parse(unchanged.payload).results[0]?.action).toBe('unchanged');

    writeFileSync(path.join(repository, 'AGENTS.md'), '# My own rules\n', 'utf8');

    const driftedStatus = await requestJson(`${daemon.url}/api/projects/${projectId ?? ''}/brain`);
    const drifted = BrainProjectStatusSchema.parse(driftedStatus.payload);
    expect(drifted.outputs[0]?.drifted).toBe(true);
    expect(drifted.outputs[0]?.diskChecksum).toBeDefined();

    const driftSync = await postJson(`${daemon.url}/api/projects/${projectId ?? ''}/brain/sync`, {
      formats: ['agents_md'],
    });
    const driftResult = BrainSyncResponseSchema.parse(driftSync.payload);
    expect(driftResult.results[0]?.action).toBe('drift');
    expect(driftResult.status.drift.filter((event) => event.resolvedAt === undefined)).toHaveLength(
      1,
    );
    expect(readFileSync(path.join(repository, 'AGENTS.md'), 'utf8')).toBe('# My own rules\n');

    const forced = await postJson(`${daemon.url}/api/projects/${projectId ?? ''}/brain/sync`, {
      formats: ['agents_md'],
      force: true,
    });
    const forcedResult = BrainSyncResponseSchema.parse(forced.payload);
    expect(forcedResult.results[0]?.action).toBe('written');
    expect(readFileSync(path.join(repository, 'AGENTS.md'), 'utf8')).toBe(output.content);
    expect(forcedResult.status.drift.every((event) => event.resolvedAt !== undefined)).toBe(true);

    const missing = await requestJson(
      `${daemon.url}/api/projects/00000000-0000-4000-8000-000000000000/brain`,
    );
    expect(missing.status).toBe(404);
  });
});

describe('Model Arena', () => {
  it('replays a redacted request against targets without recording new sessions', async () => {
    const { daemon, repository, upstream } = await boot();
    const session = createWorkspaceSession(daemon, repository);
    const step = recordStep(daemon, session, 'Change the retry constant');
    const sessionCountBefore = daemon.store.listSessions({ limit: 100 }).sessions.length;

    const storedBody = JSON.stringify(step.request?.body ?? {});
    expect(storedBody).not.toContain('sk-user-secret');

    const arena = await postJson(`${daemon.url}/api/sessions/${session.id}/arena`, {
      stepId: step.id,
      targets: [
        { provider: 'openai', model: 'gpt-4o-mini' },
        { provider: 'openai', model: 'gpt-4o' },
      ],
    });
    expect(arena.status).toBe(200);
    const runs = ArenaRunsResponseSchema.parse(arena.payload).runs;
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
    expect(runs.map((run) => run.model)).toEqual(['gpt-4o-mini', 'gpt-4o']);
    for (const run of runs) {
      expect(run.inputTokens).toBe(20);
      expect(run.outputTokens).toBe(10);
      expect(run.latencyMs).toBeGreaterThanOrEqual(0);
      expect(run.costKnown).toBe(true);
      expect(run.costUsd).toBeGreaterThan(0);
      expect(run.baselineCostUsd).toBeGreaterThan(0);
      expect(run.savingsPercent).toBeDefined();
      expect(run.outputText).toContain(`Model ${run.model} says hello.`);
      expect(run.diffText).toContain('+export const retry = 3;');
    }

    expect(upstream.requests).toHaveLength(2);
    for (const request of upstream.requests) {
      const body = JSON.parse(request.body.toString('utf8')) as {
        model?: string;
        stream?: boolean;
        api_key?: string;
      };
      expect(body.stream).toBe(false);
      expect(body.api_key).not.toBe('sk-user-secret');
      expect(request.body.toString('utf8')).not.toContain('sk-user-secret');
      expect(request.headers.authorization).toBe('Bearer sk-test-openai');
    }
    expect(
      upstream.requests.map((request) => JSON.parse(request.body.toString('utf8')).model),
    ).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(daemon.store.listSessions({ limit: 100 }).sessions.length).toBe(sessionCountBefore);

    const list = await requestJson(`${daemon.url}/api/arena?sessionId=${session.id}`);
    expect(list.status).toBe(200);
    expect(ArenaRunsResponseSchema.parse(list.payload).runs).toHaveLength(2);

    const show = await requestJson(`${daemon.url}/api/arena/${runs[0]?.id ?? ''}`);
    expect(show.status).toBe(200);
    expect(
      ArenaRunsResponseSchema.shape.runs.element.parse((show.payload as { run: unknown }).run),
    ).toMatchObject({ id: runs[0]?.id });

    const badQuery = await requestJson(`${daemon.url}/api/arena?limit=0`);
    expect(badQuery.status).toBe(400);

    const unknownStep = await postJson(`${daemon.url}/api/sessions/${session.id}/arena`, {
      stepId: '00000000-0000-4000-8000-000000000000',
      targets: [{ provider: 'openai', model: 'gpt-4o' }],
    });
    expect(unknownStep.status).toBe(404);
  });
});

describe('Handoff', () => {
  it('builds a deterministic brief and can stop after an earlier step', async () => {
    const { daemon, repository } = await boot();
    const session = createWorkspaceSession(daemon, repository);
    const first = recordStep(daemon, session, 'Fix the auth race', 'Patched the race.');
    recordStep(daemon, session, 'Add a regression test', 'Added the test.');

    const generated = await postJson(`${daemon.url}/api/sessions/${session.id}/handoffs`, {});
    expect(generated.status).toBe(201);
    const brief = HandoffBriefResponseSchema.parse(generated.payload).brief;
    expect(brief.sessionId).toBe(session.id);
    expect(brief.title).toContain('Phase 7 fixture');
    expect(brief.contentMarkdown).toContain('# Handoff');
    expect(brief.contentMarkdown).toContain('## Objective');
    expect(brief.contentMarkdown).toContain('Add a regression test');
    expect(brief.contentMarkdown).toContain('## What happened');
    expect(brief.contentMarkdown).toContain('Patched the race.');
    expect(brief.contentMarkdown).toContain('Added the test.');
    expect(brief.contentMarkdown).toContain('## Resume');
    expect(brief.contentMarkdown).toContain('cockpit run');

    const list = await requestJson(`${daemon.url}/api/sessions/${session.id}/handoffs`);
    expect(list.status).toBe(200);
    expect(HandoffBriefsResponseSchema.parse(list.payload).briefs.map((item) => item.id)).toEqual([
      brief.id,
    ]);

    const show = await requestJson(`${daemon.url}/api/handoffs/${brief.id}`);
    expect(show.status).toBe(200);
    expect(HandoffBriefResponseSchema.parse(show.payload).brief.contentMarkdown).toBe(
      brief.contentMarkdown,
    );

    const earlier = await postJson(`${daemon.url}/api/sessions/${session.id}/handoffs`, {
      stepId: first.id,
    });
    expect(earlier.status).toBe(201);
    const earlierBrief = HandoffBriefResponseSchema.parse(earlier.payload).brief;
    expect(earlierBrief.contentMarkdown).toContain('Fix the auth race');
    expect(earlierBrief.contentMarkdown).not.toContain('Add a regression test');

    const unknown = await postJson(
      `${daemon.url}/api/sessions/00000000-0000-4000-8000-000000000000/handoffs`,
      {},
    );
    expect(unknown.status).toBe(404);
  });
});

describe('Analytics', () => {
  it('aggregates UTC daily buckets, totals, models, and agents', async () => {
    const { daemon, repository } = await boot();
    const project = daemon.store.ensureProject(repository, 'phase7-analytics');
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);

    const todaySession = daemon.store.createSession({
      title: 'Today session',
      source: 'manual',
      tags: [],
      projectId: project.id,
      startedAt: today,
      agent: { name: 'opencode', detectedFrom: 'manual' },
    });
    const yesterdaySession = daemon.store.createSession({
      title: 'Yesterday session',
      source: 'manual',
      tags: [],
      projectId: project.id,
      startedAt: yesterday,
      agent: { name: 'claude-code', detectedFrom: 'manual' },
    });
    recordStep(daemon, todaySession, 'Today work');
    recordStep(daemon, yesterdaySession, 'Yesterday work');

    const response = await requestJson(
      `${daemon.url}/api/analytics?days=7&projectId=${project.id}`,
    );
    expect(response.status).toBe(200);
    const analytics = AnalyticsResponseSchema.parse(response.payload);
    expect(analytics.range.days).toBe(7);
    expect(analytics.daily).toHaveLength(7);
    expect(analytics.totals.sessionCount).toBe(2);
    expect(analytics.totals.stepCount).toBe(2);
    expect(analytics.totals.inputTokens).toBe(40);
    expect(analytics.totals.outputTokens).toBe(20);
    expect(analytics.totals.totalCostUsd).toBeGreaterThan(0);
    expect(analytics.models).toEqual([
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4o-mini',
        sessionCount: 2,
        stepCount: 2,
      }),
    ]);
    expect(analytics.agents.map((agent) => agent.agent)).toEqual(['claude-code', 'opencode']);

    const todayPoint = analytics.daily.find((point) => point.date === utcDateKey(today));
    const yesterdayPoint = analytics.daily.find((point) => point.date === utcDateKey(yesterday));
    expect(todayPoint).toMatchObject({ sessionCount: 1, stepCount: 1 });
    expect(yesterdayPoint).toMatchObject({ sessionCount: 1, stepCount: 1 });

    const filtered = await requestJson(
      `${daemon.url}/api/analytics?days=7&projectId=${project.id}&agent=opencode`,
    );
    expect(AnalyticsResponseSchema.parse(filtered.payload).totals.sessionCount).toBe(1);

    const invalid = await requestJson(`${daemon.url}/api/analytics?days=0`);
    expect(invalid.status).toBe(400);
  });
});

describe('Journal', () => {
  it('generates one Monday-to-Sunday entry and upserts the same week', async () => {
    const { daemon, repository } = await boot();
    const project = daemon.store.ensureProject(repository, 'phase7-journal');
    const firstSession = daemon.store.createSession({
      title: 'Wednesday work',
      source: 'manual',
      tags: [],
      projectId: project.id,
      startedAt: new Date('2026-04-01T10:00:00.000Z'),
      agent: { name: 'opencode', detectedFrom: 'manual' },
    });
    const secondSession = daemon.store.createSession({
      title: 'Friday work',
      source: 'manual',
      tags: [],
      projectId: project.id,
      startedAt: new Date('2026-04-03T10:00:00.000Z'),
      agent: { name: 'claude-code', detectedFrom: 'manual' },
    });
    recordStep(daemon, firstSession, 'Wednesday prompt');
    recordStep(daemon, secondSession, 'Friday prompt');

    const generated = await postJson(`${daemon.url}/api/journal/generate`, {
      projectId: project.id,
      weekStart: '2026-03-30',
    });
    expect(generated.status).toBe(200);
    const entry = JournalEntryResponseSchema.parse(generated.payload).entry;
    expect(entry.projectId).toBe(project.id);
    expect(entry.weekStart).toBe('2026-03-30');
    expect(entry.title).toBe('Week of 2026-03-30 — phase7-journal');
    expect(entry.markdown).toContain('# Week of 2026-03-30 — phase7-journal');
    expect(entry.markdown).toContain('- Sessions: 2');
    expect(entry.markdown).toContain('- Steps: 2');
    expect(entry.markdown).toContain('## Activity by day');
    expect(entry.markdown).toContain('| 2026-04-01 | 1 | 1 |');
    expect(entry.markdown).toContain('| 2026-04-03 | 1 | 1 |');
    expect(entry.markdown).toContain('## Next week');

    const regenerated = await postJson(`${daemon.url}/api/journal/generate`, {
      projectId: project.id,
      weekStart: '2026-03-30',
    });
    expect(regenerated.status).toBe(200);
    expect(JournalEntryResponseSchema.parse(regenerated.payload).entry.id).toBe(entry.id);

    const list = await requestJson(`${daemon.url}/api/journal?projectId=${project.id}`);
    expect(list.status).toBe(200);
    expect(JournalEntriesResponseSchema.parse(list.payload).entries).toHaveLength(1);

    const show = await requestJson(`${daemon.url}/api/journal/${entry.id}`);
    expect(show.status).toBe(200);
    expect(JournalEntryResponseSchema.parse(show.payload).entry.markdown).toBe(entry.markdown);

    const unknown = await postJson(`${daemon.url}/api/journal/generate`, {
      projectId: '00000000-0000-4000-8000-000000000000',
      weekStart: '2026-03-30',
    });
    expect(unknown.status).toBe(404);

    const invalidWeek = await postJson(`${daemon.url}/api/journal/generate`, {
      weekStart: 'March 30',
    });
    expect(invalidWeek.status).toBe(400);
  });
});

describe('Plugins', () => {
  function writePlugin(
    directory: string,
    options: {
      name?: string;
      version?: string;
      entry?: string;
      source?: string;
    } = {},
  ): string {
    const pluginDirectory = path.join(directory, `plugin-${options.name ?? 'phase7-analyzer'}`);
    mkdirSync(pluginDirectory, { recursive: true });
    writeFileSync(
      path.join(pluginDirectory, 'cockpit-plugin.json'),
      JSON.stringify(
        {
          apiVersion: 1,
          name: options.name ?? 'phase7-analyzer',
          version: options.version ?? '1.0.0',
          description: 'Counts steps and checks the environment.',
          kind: 'analyzer',
          entry: options.entry ?? 'index.mjs',
          permissions: ['read:session'],
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      path.join(pluginDirectory, 'index.mjs'),
      options.source ??
        [
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          '  const payload = JSON.parse(input);',
          '  console.log(JSON.stringify({',
          '    ok: true,',
          '    stepCount: payload.steps.length,',
          "    hasProviderKey: typeof process.env.COCKPIT_OPENAI_API_KEY === 'string',",
          "    isPlugin: process.env.COCKPIT_PLUGIN === '1',",
          '  }));',
          '});',
          '',
        ].join('\n'),
      'utf8',
    );
    return pluginDirectory;
  }

  it('installs, runs with a minimal environment, toggles, reinstalls, and removes', async () => {
    const { daemon, repository, directory } = await boot();
    const session = createWorkspaceSession(daemon, repository);
    recordStep(daemon, session, 'Plugin input');

    const pluginDirectory = writePlugin(directory);
    const install = await postJson(`${daemon.url}/api/plugins`, { path: pluginDirectory });
    expect(install.status).toBe(201);
    const plugin = PluginResponseSchema.parse(install.payload).plugin;
    expect(plugin).toMatchObject({
      name: 'phase7-analyzer',
      version: '1.0.0',
      enabled: true,
    });
    expect(plugin.path).toBe(path.resolve(pluginDirectory));

    const listed = await requestJson(`${daemon.url}/api/plugins`);
    expect(listed.status).toBe(200);
    expect(PluginsResponseSchema.parse(listed.payload).plugins).toHaveLength(1);

    const run = await postJson(`${daemon.url}/api/plugins/${plugin.id}/run`, {
      sessionId: session.id,
    });
    expect(run.status).toBe(200);
    const pluginRun = PluginRunResponseSchema.parse(run.payload).run;
    expect(pluginRun.status).toBe('ok');
    expect(pluginRun.kind).toBe('analyzer');
    expect(pluginRun.sessionId).toBe(session.id);
    expect(pluginRun.result).toEqual({
      ok: true,
      stepCount: 1,
      hasProviderKey: false,
      isPlugin: true,
    });

    const runs = await requestJson(`${daemon.url}/api/plugins/${plugin.id}/runs`);
    expect(runs.status).toBe(200);
    expect(PluginRunsResponseSchema.parse(runs.payload).runs).toHaveLength(1);

    const disabled = await patchJson(`${daemon.url}/api/plugins/${plugin.id}`, { enabled: false });
    expect(disabled.status).toBe(200);
    expect(PluginResponseSchema.parse(disabled.payload).plugin.enabled).toBe(false);

    const blocked = await postJson(`${daemon.url}/api/plugins/${plugin.id}/run`, {
      sessionId: session.id,
    });
    expect(blocked.status).toBe(409);

    const enabled = await patchJson(`${daemon.url}/api/plugins/${plugin.id}`, { enabled: true });
    expect(enabled.status).toBe(200);

    const secondRun = await postJson(`${daemon.url}/api/plugins/${plugin.id}/run`, {
      sessionId: session.id,
    });
    expect(secondRun.status).toBe(200);
    expect(
      PluginRunsResponseSchema.parse(
        (await requestJson(`${daemon.url}/api/plugins/${plugin.id}/runs`)).payload,
      ).runs,
    ).toHaveLength(2);

    const reinstalledDirectory = writePlugin(directory, { version: '1.1.0' });
    const reinstall = await postJson(`${daemon.url}/api/plugins`, {
      path: reinstalledDirectory,
    });
    expect(reinstall.status).toBe(201);
    const reinstalled = PluginResponseSchema.parse(reinstall.payload).plugin;
    expect(reinstalled.id).toBe(plugin.id);
    expect(reinstalled.version).toBe('1.1.0');

    const invalidPath = await postJson(`${daemon.url}/api/plugins`, {
      path: path.join(directory, 'missing-plugin'),
    });
    expect(invalidPath.status).toBe(400);

    const escapeDirectory = path.join(directory, 'escape-plugin');
    mkdirSync(escapeDirectory, { recursive: true });
    writeFileSync(path.join(directory, 'escape.mjs'), 'console.log("{}");\n', 'utf8');
    writeFileSync(
      path.join(escapeDirectory, 'cockpit-plugin.json'),
      JSON.stringify({
        apiVersion: 1,
        name: 'escape-plugin',
        version: '1.0.0',
        kind: 'guard',
        entry: '../escape.mjs',
      }),
      'utf8',
    );
    const escape = await postJson(`${daemon.url}/api/plugins`, { path: escapeDirectory });
    expect(escape.status).toBe(400);

    const removed = await requestJson(`${daemon.url}/api/plugins/${plugin.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(RemovePluginResponseSchema.parse(removed.payload)).toEqual({
      removed: true,
      id: plugin.id,
    });

    const missing = await requestJson(`${daemon.url}/api/plugins/${plugin.id}/runs`);
    expect(missing.status).toBe(404);
  });

  it('records a failed plugin run instead of crashing the daemon', async () => {
    const { daemon, repository, directory } = await boot();
    const session = createWorkspaceSession(daemon, repository);
    const pluginDirectory = writePlugin(directory, {
      name: 'phase7-failing',
      source: "console.error('boom'); process.exit(3);\n",
    });

    const install = await postJson(`${daemon.url}/api/plugins`, { path: pluginDirectory });
    const plugin = PluginResponseSchema.parse(install.payload).plugin;
    const run = await postJson(`${daemon.url}/api/plugins/${plugin.id}/run`, {
      sessionId: session.id,
    });
    expect(run.status).toBe(200);
    const pluginRun = PluginRunResponseSchema.parse(run.payload).run;
    expect(pluginRun.status).toBe('error');
    expect(pluginRun.error).toContain('code 3');
    expect(pluginRun.error).toContain('boom');
  });
});
