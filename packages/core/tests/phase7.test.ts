import { describe, expect, it } from 'vitest';

import {
  AnalyticsQuerySchema,
  AnalyticsResponseSchema,
  ArenaRunInputSchema,
  ArenaRunSchema,
  ArenaTargetSchema,
  BRAIN_FORMATS,
  BRAIN_FORMAT_LABELS,
  BRAIN_FORMAT_PATHS,
  BrainOutputViewSchema,
  BrainSyncInputSchema,
  BrainSyncResponseSchema,
  HandoffBriefSchema,
  HandoffGenerateInputSchema,
  JournalEntrySchema,
  JournalGenerateInputSchema,
  PluginManifestSchema,
  PluginRunSchema,
  ProjectSchema,
} from '../src/index.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const STEP_ID = '33333333-3333-4333-8333-333333333333';
const OUTPUT_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const NOW = '2026-04-05T06:00:00.000Z';

describe('Project Brain schemas', () => {
  it('keeps every format mapped to a label and a project-relative path', () => {
    for (const format of BRAIN_FORMATS) {
      expect(BRAIN_FORMAT_LABELS[format].length).toBeGreaterThan(0);
      expect(BRAIN_FORMAT_PATHS[format]).not.toMatch(/^([/\\]|[A-Za-z]:)/);
      expect(BRAIN_FORMAT_PATHS[format].includes('..')).toBe(false);
    }
  });

  it('defaults sync to a non-forcing dry-run-safe request', () => {
    const input = BrainSyncInputSchema.parse({});
    expect(input.force).toBe(false);
    expect(input.dryRun).toBe(false);
    expect(input.formats).toBeUndefined();
  });

  it('rejects unknown formats and empty format lists', () => {
    expect(BrainSyncInputSchema.safeParse({ formats: ['unknown'] }).success).toBe(false);
    expect(BrainSyncInputSchema.safeParse({ formats: [] }).success).toBe(false);
  });

  it('parses output views with disk state and drift', () => {
    const output = BrainOutputViewSchema.parse({
      id: OUTPUT_ID,
      projectId: PROJECT_ID,
      format: 'agents_md',
      path: 'AGENTS.md',
      content: '# Agent Instructions\n',
      checksum: HASH,
      sourceChecksum: HASH,
      driftDetected: true,
      existsOnDisk: true,
      diskChecksum: 'b'.repeat(64),
      drifted: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(output.drifted).toBe(true);
    expect(output.diskChecksum).toBe('b'.repeat(64));
  });

  it('validates the sync response shape', () => {
    const response = BrainSyncResponseSchema.parse({
      results: [
        {
          format: 'claude_md',
          path: 'CLAUDE.md',
          action: 'written',
          checksum: HASH,
        },
      ],
      status: {
        project: ProjectSchema.parse({
          id: PROJECT_ID,
          name: 'cockpit',
          rootPath: 'C:\\work\\cockpit',
          createdAt: NOW,
          updatedAt: NOW,
        }),
        sources: [],
        outputs: [],
        drift: [],
      },
    });
    expect(response.results[0]?.action).toBe('written');
  });
});

describe('Model Arena schemas', () => {
  it('defaults an arena target provider to openai', () => {
    expect(ArenaTargetSchema.parse({ model: 'gpt-5.1' })).toEqual({
      provider: 'openai',
      model: 'gpt-5.1',
    });
  });

  it('requires between one and six targets', () => {
    expect(ArenaRunInputSchema.safeParse({ stepId: STEP_ID, targets: [] }).success).toBe(false);
    expect(
      ArenaRunInputSchema.safeParse({
        stepId: STEP_ID,
        targets: Array.from({ length: 7 }, () => ({ provider: 'openai', model: 'gpt-5.1' })),
      }).success,
    ).toBe(false);
  });

  it('defaults usage counters on stored runs', () => {
    const run = ArenaRunSchema.parse({
      id: OUTPUT_ID,
      sourceSessionId: SESSION_ID,
      sourceStepId: STEP_ID,
      provider: 'openai',
      model: 'gpt-5.1',
      status: 'completed',
      startedAt: NOW,
      createdAt: NOW,
    });
    expect(run.inputTokens).toBe(0);
    expect(run.outputTokens).toBe(0);
    expect(run.costKnown).toBe(false);
  });

  it('rejects negative costs and unknown statuses', () => {
    const base = {
      id: OUTPUT_ID,
      provider: 'openai',
      model: 'gpt-5.1',
      status: 'completed',
      startedAt: NOW,
      createdAt: NOW,
    };
    expect(ArenaRunSchema.safeParse({ ...base, costUsd: -1 }).success).toBe(false);
    expect(ArenaRunSchema.safeParse({ ...base, status: 'paused' }).success).toBe(false);
  });
});

describe('analytics and journal schemas', () => {
  it('coerces the analytics window and caps it at a year', () => {
    expect(AnalyticsQuerySchema.parse({}).days).toBe(30);
    expect(AnalyticsQuerySchema.parse({ days: '7' }).days).toBe(7);
    expect(AnalyticsQuerySchema.safeParse({ days: '0' }).success).toBe(false);
    expect(AnalyticsQuerySchema.safeParse({ days: '366' }).success).toBe(false);
  });

  it('requires UTC date-only week starts', () => {
    expect(JournalGenerateInputSchema.parse({}).weekStart).toBeUndefined();
    expect(JournalGenerateInputSchema.parse({ weekStart: '2026-03-30' }).weekStart).toBe(
      '2026-03-30',
    );
    expect(JournalGenerateInputSchema.safeParse({ weekStart: '2026-3-30' }).success).toBe(false);
    expect(
      JournalGenerateInputSchema.safeParse({ weekStart: '2026-03-30T00:00:00Z' }).success,
    ).toBe(false);
  });

  it('parses a weekly journal entry', () => {
    const entry = JournalEntrySchema.parse({
      id: OUTPUT_ID,
      projectId: PROJECT_ID,
      weekStart: '2026-03-30',
      title: 'Week of 2026-03-30 — cockpit',
      markdown: '# Week of 2026-03-30\n',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(entry.weekStart).toBe('2026-03-30');
  });

  it('rejects an analytics response with a malformed day bucket', () => {
    const response = {
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
      daily: [
        {
          date: 'April 5',
          sessionCount: 0,
          stepCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: 0,
          errorCount: 0,
        },
      ],
      models: [],
      agents: [],
    };
    expect(AnalyticsResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe('handoff and plugin schemas', () => {
  it('allows a handoff to stop at an optional step', () => {
    expect(HandoffGenerateInputSchema.parse({})).toEqual({});
    expect(HandoffGenerateInputSchema.parse({ stepId: STEP_ID })).toEqual({ stepId: STEP_ID });
    expect(HandoffGenerateInputSchema.safeParse({ stepId: 'step-1' }).success).toBe(false);
  });

  it('parses a handoff brief', () => {
    const brief = HandoffBriefSchema.parse({
      id: OUTPUT_ID,
      sessionId: SESSION_ID,
      title: 'Handoff — Auth hardening',
      contentMarkdown: '# Handoff\n',
      generatedAt: NOW,
    });
    expect(brief.sessionId).toBe(SESSION_ID);
  });

  it('defaults manifest api version and permissions', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'example-guard',
      version: '0.1.0',
      kind: 'guard',
      entry: 'index.mjs',
    });
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.permissions).toEqual([]);
  });

  it('rejects unsafe plugin names and unknown kinds', () => {
    const base = { version: '0.1.0', kind: 'guard', entry: 'index.mjs' };
    expect(PluginManifestSchema.safeParse({ ...base, name: 'Example Guard' }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, name: '../escape' }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, name: 'ok', kind: 'shell' }).success).toBe(
      false,
    );
  });

  it('validates plugin run statuses and JSON results', () => {
    const run = PluginRunSchema.parse({
      id: OUTPUT_ID,
      pluginId: PROJECT_ID,
      sessionId: SESSION_ID,
      kind: 'analyzer',
      status: 'ok',
      result: { findings: [], score: 3 },
      startedAt: NOW,
      endedAt: NOW,
    });
    expect(run.status).toBe('ok');
    expect(PluginRunSchema.safeParse({ ...run, status: 'done' }).success).toBe(false);
  });
});
