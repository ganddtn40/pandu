import { describe, expect, it, vi } from 'vitest';
import {
  AnalyticsResponseSchema,
  ArenaRunSchema,
  BrainProjectStatusSchema,
  BrainSyncResponseSchema,
  HandoffBriefSchema,
  JournalEntrySchema,
  PluginManifestSchema,
  PluginRunSchema,
  PluginSchema,
  ProjectSchema,
  type AnalyticsResponse,
  type ArenaRun,
  type BrainProjectStatus,
  type BrainSyncResponse,
  type HandoffBrief,
  type JournalEntry,
  type Plugin,
  type PluginRun,
  type Project,
} from '@cockpit/core';

import type { DaemonClient } from '../src/daemon-client.js';
import {
  collectArenaTarget,
  formatAnalytics,
  formatArenaRuns,
  formatBrainStatus,
  formatBrainSync,
  formatHandoffList,
  formatJournalList,
  formatPluginRun,
  formatPlugins,
  parseArenaTarget,
  runAnalytics,
  runArenaList,
  runArenaRun,
  runArenaShow,
  runBrainGenerate,
  runBrainStatus,
  runBrainSync,
  runHandoffGenerate,
  runHandoffList,
  runHandoffShow,
  runJournalGenerate,
  runJournalList,
  runJournalShow,
  runPluginInstall,
  runPluginRemove,
  runPluginRun,
  runPluginRuns,
  runPluginsList,
  runPluginToggle,
  runProjectsList,
} from '../src/phase7.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const STEP_ID = '33333333-3333-4333-8333-333333333333';
const OUTPUT_ID = '44444444-4444-4444-8444-444444444444';
const DRIFT_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const BRIEF_ID = '77777777-7777-4777-8777-777777777777';
const JOURNAL_ID = '88888888-8888-4888-8888-888888888888';
const PLUGIN_ID = '99999999-9999-4999-8999-999999999999';
const PLUGIN_RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HASH = 'a'.repeat(64);
const NOW = '2026-04-05T06:00:00.000Z';

function fakeClient(overrides: Partial<Record<keyof DaemonClient, unknown>>): DaemonClient {
  return overrides as unknown as DaemonClient;
}

function project(): Project {
  return ProjectSchema.parse({
    id: PROJECT_ID,
    name: 'cockpit',
    rootPath: 'C:\\work\\cockpit',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function brainStatus(): BrainProjectStatus {
  return BrainProjectStatusSchema.parse({
    project: project(),
    sources: [{ id: OUTPUT_ID, path: 'README.md', checksum: HASH, updatedAt: NOW }],
    outputs: [
      {
        id: OUTPUT_ID,
        projectId: PROJECT_ID,
        format: 'agents_md',
        path: 'AGENTS.md',
        content: '# Agent Instructions\n',
        checksum: HASH,
        sourceChecksum: HASH,
        syncedAt: NOW,
        driftDetected: false,
        existsOnDisk: true,
        drifted: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: DRIFT_ID,
        projectId: PROJECT_ID,
        format: 'claude_md',
        path: 'CLAUDE.md',
        content: '# Claude Instructions\n',
        checksum: HASH,
        sourceChecksum: HASH,
        driftDetected: true,
        existsOnDisk: true,
        diskChecksum: 'b'.repeat(64),
        drifted: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    drift: [
      {
        id: DRIFT_ID,
        projectId: PROJECT_ID,
        outputId: DRIFT_ID,
        expectedChecksum: HASH,
        actualChecksum: 'b'.repeat(64),
        detectedAt: NOW,
      },
    ],
  });
}

function brainSync(): BrainSyncResponse {
  return BrainSyncResponseSchema.parse({
    results: [
      {
        format: 'agents_md',
        path: 'AGENTS.md',
        action: 'written',
        checksum: HASH,
        message: 'Wrote 120 bytes.',
      },
      { format: 'claude_md', path: 'CLAUDE.md', action: 'unchanged', checksum: HASH },
    ],
    status: brainStatus(),
  });
}

function arenaRun(overrides: Partial<ArenaRun> = {}): ArenaRun {
  return ArenaRunSchema.parse({
    id: RUN_ID,
    sourceSessionId: SESSION_ID,
    sourceStepId: STEP_ID,
    provider: 'openai',
    model: 'gpt-5.1',
    status: 'completed',
    outputText: 'Done.\n```diff\n+export const retry = 3;\n```',
    diffText: '+export const retry = 3;',
    inputTokens: 500,
    outputTokens: 120,
    costUsd: 0.03,
    costKnown: true,
    latencyMs: 1200,
    baselineCostUsd: 0.05,
    savingsPercent: 40,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    ...overrides,
  });
}

function handoffBrief(overrides: Partial<HandoffBrief> = {}): HandoffBrief {
  return HandoffBriefSchema.parse({
    id: BRIEF_ID,
    sessionId: SESSION_ID,
    title: 'Handoff — Auth hardening',
    contentMarkdown: '# Handoff\n\n## Objective\n\nResume at step 3.\n',
    generatedAt: NOW,
    ...overrides,
  });
}

function analytics(): AnalyticsResponse {
  return AnalyticsResponseSchema.parse({
    range: { from: '2026-03-30T00:00:00.000Z', to: NOW, days: 7 },
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
  });
}

function journalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return JournalEntrySchema.parse({
    id: JOURNAL_ID,
    projectId: PROJECT_ID,
    weekStart: '2026-03-30',
    title: 'Week of 2026-03-30 — cockpit',
    markdown: '# Week of 2026-03-30 — cockpit\n\n- Sessions: 2\n',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function plugin(overrides: Partial<Plugin> = {}): Plugin {
  const manifest = PluginManifestSchema.parse({
    apiVersion: 1,
    name: 'example-guard',
    version: '0.1.0',
    kind: 'guard',
    entry: 'index.mjs',
    permissions: [],
  });
  return PluginSchema.parse({
    id: PLUGIN_ID,
    name: 'example-guard',
    version: '0.1.0',
    description: 'Flags risky shell commands.',
    manifest,
    path: 'C:\\work\\plugins\\example-guard',
    enabled: true,
    installedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function pluginRun(overrides: Partial<PluginRun> = {}): PluginRun {
  return PluginRunSchema.parse({
    id: PLUGIN_RUN_ID,
    pluginId: PLUGIN_ID,
    sessionId: SESSION_ID,
    kind: 'guard',
    status: 'ok',
    result: { findings: [{ rule: 'rm-rf' }] },
    startedAt: NOW,
    endedAt: NOW,
    ...overrides,
  });
}

describe('arena target parsing', () => {
  it('parses provider:model pairs and trims whitespace', () => {
    expect(parseArenaTarget('openai:gpt-5.1')).toEqual({ provider: 'openai', model: 'gpt-5.1' });
    expect(parseArenaTarget(' anthropic : claude-sonnet-4 ')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });
    expect(parseArenaTarget('openai:ft:gpt-4o-mini:org')).toEqual({
      provider: 'openai',
      model: 'ft:gpt-4o-mini:org',
    });
  });

  it('rejects values without a valid provider or model', () => {
    expect(() => parseArenaTarget('gpt-5.1')).toThrow(/provider:model/);
    expect(() => parseArenaTarget(':gpt-5.1')).toThrow(/provider:model/);
    expect(() => parseArenaTarget('openai:')).toThrow(/provider:model/);
    expect(() => parseArenaTarget('OpenAI:gpt-5.1')).toThrow(/Invalid provider/);
    expect(() => parseArenaTarget('open ai:gpt-5.1')).toThrow(/Invalid provider/);
  });

  it('collects repeatable targets in order', () => {
    const collected = collectArenaTarget('openai:gpt-5.1', []);
    expect(collected).toEqual([{ provider: 'openai', model: 'gpt-5.1' }]);
    expect(collectArenaTarget('openai:gpt-4o', collected)).toEqual([
      { provider: 'openai', model: 'gpt-5.1' },
      { provider: 'openai', model: 'gpt-4o' },
    ]);
  });
});

describe('Phase 7 CLI formatting', () => {
  it('formats brain status, outputs, and unresolved drift', () => {
    const text = formatBrainStatus(brainStatus());
    expect(text).toContain('Project: cockpit');
    expect(text).toContain('Root:    C:\\work\\cockpit');
    expect(text).toContain('Sources: 1');
    expect(text).toContain('AGENTS.md              AGENTS.md [synced]');
    expect(text).toContain('CLAUDE.md              CLAUDE.md [drift — edit or run sync --force]');
    expect(text).toContain('Unresolved drift events: 1');

    const empty = formatBrainStatus(
      BrainProjectStatusSchema.parse({ project: project(), sources: [], outputs: [], drift: [] }),
    );
    expect(empty).toContain('(no generated outputs yet — run cockpit brain generate)');
  });

  it('formats sync results followed by the refreshed status', () => {
    const text = formatBrainSync(brainSync());
    expect(text).toContain('written    AGENTS.md — Wrote 120 bytes.');
    expect(text).toContain('unchanged  CLAUDE.md');
    expect(text).toContain('Project: cockpit');
  });

  it('formats arena runs with latency, savings, output, diff, and errors', () => {
    const text = formatArenaRuns([arenaRun()]);
    expect(text).toContain('openai/gpt-5.1 — completed');
    expect(text).toContain(`Run: ${RUN_ID}`);
    expect(text).toContain('Latency: 1200ms');
    expect(text).toContain('Tokens: 500 in / 120 out · cost: $0.030');
    expect(text).toContain('Baseline: $0.050 · savings: 40%');
    expect(text).toContain('+export const retry = 3;');

    const failed = formatArenaRuns([
      arenaRun({
        status: 'failed',
        costUsd: undefined,
        costKnown: false,
        latencyMs: undefined,
        baselineCostUsd: undefined,
        savingsPercent: undefined,
        outputText: undefined,
        diffText: undefined,
        error: 'Upstream rejected the request.',
      }),
    ]);
    expect(failed).toContain('cost: Unpriced (unpriced)');
    expect(failed).toContain('Error: Upstream rejected the request.');

    expect(formatArenaRuns([])).toBe('No arena runs were recorded.\n');
  });

  it('formats handoff lists and empty states', () => {
    expect(formatHandoffList([])).toContain('No handoff briefs were generated');
    const text = formatHandoffList([handoffBrief()]);
    expect(text).toContain(`${BRIEF_ID}  ${NOW}  Handoff — Auth hardening`);
  });

  it('formats analytics totals, daily buckets, models, and agents', () => {
    const text = formatAnalytics(analytics());
    expect(text).toContain('Cockpit analytics — 7 day(s)');
    expect(text).toContain('Sessions:   2');
    expect(text).toContain('Tokens:     1200 in / 400 out');
    expect(text).toContain('(2 unpriced calls)');
    expect(text).toContain('2026-04-04    1 session(s)      5 step(s)');
    expect(text).toContain('openai/gpt-4.1 — 2 session(s), 8 step(s), $0.420');
    expect(text).toContain('opencode — 2 session(s), 8 step(s), $0.420');

    const empty = formatAnalytics(
      AnalyticsResponseSchema.parse({
        range: { from: NOW, to: NOW, days: 1 },
        totals: {
          sessionCount: 0,
          stepCount: 0,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalCostUsd: 0,
          unknownCostCalls: 0,
          errorCount: 0,
        },
        daily: [],
        models: [],
        agents: [],
      }),
    );
    expect(empty).toContain('Models:\n  (none)');
    expect(empty).toContain('Agents:\n  (none)');
  });

  it('formats journal entries and empty states', () => {
    expect(formatJournalList([])).toContain('No journal entries yet');
    const text = formatJournalList([journalEntry()]);
    expect(text).toContain(`2026-03-30  Week of 2026-03-30 — cockpit (${JOURNAL_ID})`);
  });

  it('formats plugins, runs, and empty states', () => {
    expect(formatPlugins([])).toContain('No plugins are installed');
    const text = formatPlugins([plugin()]);
    expect(text).toContain('enabled   example-guard@0.1.0  [guard]');
    expect(text).toContain(PLUGIN_ID);

    const disabled = formatPlugins([plugin({ enabled: false })]);
    expect(disabled).toContain('disabled  example-guard@0.1.0');

    const unknownKind = formatPlugins([
      plugin({ manifest: { ...plugin().manifest, kind: 'unknown-kind' } }),
    ]);
    expect(unknownKind).toContain('[unknown]');

    const run = formatPluginRun(pluginRun());
    expect(run).toContain(`Plugin run ${PLUGIN_RUN_ID} — ok`);
    expect(run).toContain('"rule": "rm-rf"');

    const failed = formatPluginRun(
      pluginRun({ status: 'error', result: undefined, error: 'boom' }),
    );
    expect(failed).toContain('Plugin run');
    expect(failed).toContain('Error: boom');
  });
});

describe('Phase 7 CLI runners', () => {
  it('lists projects and supports JSON output', async () => {
    const listProjects = vi.fn(async () => [project()]);
    const client = fakeClient({ listProjects });

    expect(await runProjectsList(client, false)).toBe(
      `cockpit — C:\\work\\cockpit (${PROJECT_ID})\n`,
    );
    const parsed = JSON.parse(await runProjectsList(client, true)) as { projects: Project[] };
    expect(parsed.projects[0]?.id).toBe(PROJECT_ID);

    expect(await runProjectsList(fakeClient({ listProjects: async () => [] }), false)).toContain(
      'No projects have been recorded yet',
    );
  });

  it('drives brain status, generate, and sync with explicit options', async () => {
    const getBrainStatus = vi.fn(async () => brainStatus());
    const generateBrain = vi.fn(async () => brainStatus());
    const syncBrain = vi.fn(async () => brainSync());

    expect(await runBrainStatus(fakeClient({ getBrainStatus }), PROJECT_ID, false)).toContain(
      'Project: cockpit',
    );
    expect(getBrainStatus).toHaveBeenCalledWith(PROJECT_ID);

    const generated = await runBrainGenerate(
      fakeClient({ generateBrain }),
      PROJECT_ID,
      ['agents_md', 'claude_md'],
      false,
    );
    expect(generated).toContain('AGENTS.md');
    expect(generateBrain).toHaveBeenCalledWith(PROJECT_ID, ['agents_md', 'claude_md']);

    const synced = await runBrainSync(
      fakeClient({ syncBrain }),
      PROJECT_ID,
      undefined,
      { force: true, dryRun: true },
      false,
    );
    expect(synced).toContain('written    AGENTS.md');
    expect(syncBrain).toHaveBeenCalledWith(PROJECT_ID, { force: true, dryRun: true });
  });

  it('requires at least one arena target and passes replay input through', async () => {
    const runArena = vi.fn(async () => [arenaRun()]);
    const client = fakeClient({ runArena });

    await expect(runArenaRun(client, SESSION_ID, STEP_ID, [], false)).rejects.toThrow(
      /At least one --target/,
    );
    const text = await runArenaRun(
      client,
      SESSION_ID,
      STEP_ID,
      [{ provider: 'openai', model: 'gpt-5.1' }],
      false,
    );
    expect(text).toContain('openai/gpt-5.1 — completed');
    expect(runArena).toHaveBeenCalledWith(SESSION_ID, {
      stepId: STEP_ID,
      targets: [{ provider: 'openai', model: 'gpt-5.1' }],
    });
  });

  it('lists and shows arena runs with optional filters', async () => {
    const listArenaRuns = vi.fn(async () => [arenaRun()]);
    const getArenaRun = vi.fn(async () => arenaRun());

    const listed = await runArenaList(
      fakeClient({ listArenaRuns }),
      { sessionId: SESSION_ID, limit: 5 },
      false,
    );
    expect(listed).toContain('openai/gpt-5.1');
    expect(listArenaRuns).toHaveBeenCalledWith({ sessionId: SESSION_ID, limit: 5 });

    const shown = await runArenaShow(fakeClient({ getArenaRun }), RUN_ID, false);
    expect(shown).toContain(`Run: ${RUN_ID}`);
    expect(getArenaRun).toHaveBeenCalledWith(RUN_ID);
  });

  it('generates, lists, and shows handoffs', async () => {
    const generateHandoff = vi.fn(async () => handoffBrief());
    const listHandoffs = vi.fn(async () => [handoffBrief()]);
    const getHandoff = vi.fn(async () => handoffBrief());

    const generated = await runHandoffGenerate(
      fakeClient({ generateHandoff }),
      SESSION_ID,
      STEP_ID,
      false,
    );
    expect(generated).toBe(handoffBrief().contentMarkdown);
    expect(generateHandoff).toHaveBeenCalledWith(SESSION_ID, { stepId: STEP_ID });

    await runHandoffGenerate(fakeClient({ generateHandoff }), SESSION_ID, undefined, true);
    expect(generateHandoff).toHaveBeenLastCalledWith(SESSION_ID, {});

    expect(await runHandoffList(fakeClient({ listHandoffs }), SESSION_ID, false)).toContain(
      'Handoff — Auth hardening',
    );
    expect(await runHandoffShow(fakeClient({ getHandoff }), BRIEF_ID, false)).toBe(
      handoffBrief().contentMarkdown,
    );
  });

  it('queries analytics and journals with JSON output', async () => {
    const getAnalytics = vi.fn(async () => analytics());
    const analyticsText = await runAnalytics(
      fakeClient({ getAnalytics }),
      { days: 7, projectId: PROJECT_ID },
      false,
    );
    expect(analyticsText).toContain('Cockpit analytics — 7 day(s)');
    expect(getAnalytics).toHaveBeenCalledWith({ days: 7, projectId: PROJECT_ID });

    const listJournal = vi.fn(async () => [journalEntry()]);
    const generateJournal = vi.fn(async () => journalEntry());
    const getJournalEntry = vi.fn(async () => journalEntry());

    expect(await runJournalList(fakeClient({ listJournal }), { limit: 4 }, false)).toContain(
      'Week of 2026-03-30',
    );
    expect(listJournal).toHaveBeenCalledWith({ limit: 4 });

    const generated = await runJournalGenerate(
      fakeClient({ generateJournal }),
      { projectId: PROJECT_ID, weekStart: '2026-03-30' },
      false,
    );
    expect(generated).toBe(journalEntry().markdown);
    expect(generateJournal).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      weekStart: '2026-03-30',
    });

    await runJournalGenerate(fakeClient({ generateJournal }), {}, true);
    expect(generateJournal).toHaveBeenLastCalledWith({});

    expect(await runJournalShow(fakeClient({ getJournalEntry }), JOURNAL_ID, false)).toBe(
      journalEntry().markdown,
    );
  });

  it('installs, toggles, removes, runs, and lists plugin history', async () => {
    const listPlugins = vi.fn(async () => [plugin()]);
    const installPlugin = vi.fn(async () => plugin());
    const updatePlugin = vi.fn(async () => plugin({ enabled: false }));
    const removePlugin = vi.fn(async () => true);
    const runPlugin = vi.fn(async () => pluginRun());
    const listPluginRuns = vi.fn(async () => [pluginRun()]);

    expect(await runPluginsList(fakeClient({ listPlugins }), false)).toContain(
      'example-guard@0.1.0',
    );
    expect(
      await runPluginInstall(
        fakeClient({ installPlugin }),
        'C:\\work\\plugins\\example-guard',
        false,
      ),
    ).toContain(`Installed example-guard@0.1.0 (${PLUGIN_ID}).`);
    expect(installPlugin).toHaveBeenCalledWith({ path: 'C:\\work\\plugins\\example-guard' });

    expect(await runPluginToggle(fakeClient({ updatePlugin }), PLUGIN_ID, false, false)).toContain(
      'example-guard is now disabled.',
    );
    expect(updatePlugin).toHaveBeenCalledWith(PLUGIN_ID, { enabled: false });

    expect(await runPluginRemove(fakeClient({ removePlugin }), PLUGIN_ID, false)).toBe(
      `Plugin ${PLUGIN_ID} removed.\n`,
    );

    const run = await runPluginRun(
      fakeClient({ runPlugin }),
      PLUGIN_ID,
      SESSION_ID,
      STEP_ID,
      false,
    );
    expect(run).toContain(`Plugin run ${PLUGIN_RUN_ID} — ok`);
    expect(runPlugin).toHaveBeenCalledWith(PLUGIN_ID, { sessionId: SESSION_ID, stepId: STEP_ID });

    await runPluginRun(fakeClient({ runPlugin }), PLUGIN_ID, SESSION_ID, undefined, true);
    expect(runPlugin).toHaveBeenLastCalledWith(PLUGIN_ID, { sessionId: SESSION_ID });

    const runs = await runPluginRuns(fakeClient({ listPluginRuns }), PLUGIN_ID, 10, false);
    expect(runs).toContain(`Plugin run ${PLUGIN_RUN_ID}`);
    expect(listPluginRuns).toHaveBeenCalledWith(PLUGIN_ID, 10);

    expect(
      await runPluginRuns(fakeClient({ listPluginRuns: async () => [] }), PLUGIN_ID, 10, false),
    ).toContain('No runs were recorded for this plugin.');
  });
});
