import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_SEED_VERSION, DemoSeedResponseSchema, type DemoSeedResponse } from '@cockpit/core';
import { DEMO_MAIN_TITLE, type StartedDaemon } from '../src/index.js';

import { startTestDaemon, startUpstream, type FakeUpstream } from './helpers.js';

interface DemoContext {
  directory: string;
  upstream: FakeUpstream;
  daemon: StartedDaemon;
}

const CONTEXTS: DemoContext[] = [];

async function bootDemoDaemon(): Promise<StartedDaemon> {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-demo-'));
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const daemon = await startTestDaemon({
    home: path.join(directory, 'home'),
    openAiUpstream: upstream.url,
    resolveRemoteAddress: (c) => c.req.header('x-test-remote-address') ?? '127.0.0.1',
  });
  CONTEXTS.push({ directory, upstream, daemon });
  return daemon;
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

async function seed(daemon: StartedDaemon): Promise<{ status: number; body: DemoSeedResponse }> {
  const response = await fetch(`${daemon.url}/api/demo/seed`, { method: 'POST' });
  return {
    status: response.status,
    body: DemoSeedResponseSchema.parse(await response.json()),
  };
}

describe('demo seeding', () => {
  it('seeds a realistic flight with every dashboard surface populated', async () => {
    const daemon = await bootDemoDaemon();
    const { status, body } = await seed(daemon);

    expect(status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.seedVersion).toBe(DEMO_SEED_VERSION);
    expect(body.sessions).toHaveLength(3);
    expect(body.sessions.map((session) => session.title)).toContain(DEMO_MAIN_TITLE);
    expect(body.totals.steps).toBeGreaterThanOrEqual(8);
    expect(body.totals.toolCalls).toBeGreaterThanOrEqual(8);
    expect(body.totals.guardEvents).toBe(2);

    const main = daemon.store.getSession(body.sessionId);
    expect(main).toBeDefined();
    if (!main) throw new Error('The demo main session is missing.');
    expect(main.source).toBe('demo');
    expect(main.status).toBe('completed');
    expect(main.agent?.name).toBe('opencode');
    expect(main.endedAt).toBeDefined();

    const steps = daemon.store.listSteps(main.id);
    expect(steps).toHaveLength(5);
    const failed = steps.filter((step) => step.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.response?.status).toBe(529);
    expect(failed[0]?.error).toContain('529');

    const toolCalls = steps.flatMap((step) => daemon.store.listToolCalls(step.id));
    expect(toolCalls).toHaveLength(9);
    expect(toolCalls.every((call) => call.status === 'completed')).toBe(true);

    const streamed = steps.find((step) => step.status === 'completed');
    expect(streamed).toBeDefined();
    if (streamed) {
      const chunks = daemon.store.listStreamChunks(streamed.id);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.deltaText).toBeTruthy();
    }

    const guardEvents = daemon.store.listGuardEvents({ sessionId: main.id, limit: 50 });
    expect(guardEvents).toHaveLength(2);
    expect(guardEvents.map((event) => event.status).sort()).toEqual(['approved', 'redacted']);

    const analysis = daemon.store.getLatestCheatAnalysis(main.id);
    expect(analysis).toBeDefined();
    expect(analysis?.trustScore).toBe(88);
    expect(analysis?.grade).toBe('B');
    expect(analysis?.findings).toHaveLength(2);

    const snapshot = daemon.store.getLatestContextSnapshot(main.id);
    expect(snapshot).toBeDefined();
    if (snapshot) {
      const segments = daemon.store.listContextSegments(snapshot.id);
      const insights = daemon.store.listContextInsights(snapshot.id);
      expect(segments).toHaveLength(5);
      expect(insights).toHaveLength(3);
      expect(snapshot.totalTokens).toBe(92_480);
    }

    const snapshots = daemon.store.listSnapshots(main.id);
    expect(snapshots.map((entry) => entry.kind).sort()).toEqual(['after', 'before']);
    const after = snapshots.find((entry) => entry.kind === 'after');
    expect(after).toBeDefined();
    if (after) {
      expect(daemon.store.listSnapshotFileChanges(after.id)).toHaveLength(3);
    }

    const projectId = main.projectId;
    expect(projectId).toBeDefined();
    if (projectId) {
      const provenance = daemon.store.listProvenanceEntries({ sessionId: main.id, limit: 50 });
      expect(provenance).toHaveLength(3);
      const files = daemon.store.listUnderstandingFiles({ projectId, limit: 50 });
      expect(files).toHaveLength(3);
      expect(files.map((file) => file.status).sort()).toEqual(['acknowledged', 'opened', 'unseen']);

      const testFile = files.find((file) => file.path === 'tests/checkout.test.ts');
      expect(testFile).toBeDefined();
      if (testFile) {
        const quiz = daemon.store.getLatestComprehensionQuiz(testFile.id);
        expect(quiz?.questions).toHaveLength(3);
      }
    }
  });

  it('is idempotent and reuses the existing demo flight', async () => {
    const daemon = await bootDemoDaemon();
    const first = await seed(daemon);
    const second = await seed(daemon);

    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(second.body.totals).toEqual(first.body.totals);
    expect(daemon.store.listSessions({ search: 'Demo flight:', limit: 50 }).sessions).toHaveLength(
      3,
    );
  });

  it('refuses to seed from a non-loopback address', async () => {
    const daemon = await bootDemoDaemon();
    const response = await fetch(`${daemon.url}/api/demo/seed`, {
      method: 'POST',
      headers: { 'x-test-remote-address': '203.0.113.9' },
    });

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe('forbidden');
    expect(daemon.store.listSessions({ search: 'Demo flight:', limit: 10 }).sessions).toHaveLength(
      0,
    );
  });
});
