import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DemoSeedResponse } from '@cockpit/core';
import { loadConfig, startDaemon, type StartedDaemon } from '@cockpit/daemon';

import { createProgram } from '../src/cli.js';
import { DaemonClient } from '../src/daemon-client.js';
import { formatDemoResult, type DemoCommandResult } from '../src/demo.js';

const cleanupTasks: Array<() => Promise<void>> = [];

function registerCleanup(task: () => Promise<void>): void {
  cleanupTasks.push(task);
}

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) await task().catch(() => undefined);
  }
});

async function startTestDaemon(): Promise<StartedDaemon> {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-cli-demo-'));
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
  registerCleanup(async () => {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return daemon;
}

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = '2026-04-05T06:00:00.000Z';

const SEED: DemoSeedResponse = {
  created: true,
  seedVersion: '1',
  sessionId: SESSION_ID,
  workspacePath: 'C:\\Users\\demo\\projects\\aurora-notes',
  sessions: [
    {
      id: SESSION_ID,
      title: 'Demo flight: add checkout rate limiting',
      status: 'completed',
      source: 'demo',
      startedAt: STARTED_AT,
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Demo flight: stabilize the auth refresh test',
      status: 'completed',
      source: 'demo',
      startedAt: STARTED_AT,
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      title: 'Demo flight: document webhook retries',
      status: 'completed',
      source: 'demo',
      startedAt: STARTED_AT,
    },
  ],
  totals: { steps: 8, toolCalls: 11, guardEvents: 2 },
};

function result(overrides: Partial<DemoCommandResult> = {}): DemoCommandResult {
  return {
    seed: SEED,
    dashboardUrl: 'http://127.0.0.1:4319/',
    sessionUrl: `http://127.0.0.1:4319/sessions/${SESSION_ID}`,
    reused: false,
    url: 'http://127.0.0.1:4319',
    databasePath: 'C:\\Users\\demo\\.cockpit\\cockpit.db',
    ...overrides,
  };
}

describe('DaemonClient.seedDemo', () => {
  it('seeds the demo through a real daemon and is idempotent', async () => {
    const daemon = await startTestDaemon();
    const client = new DaemonClient(daemon.url);

    const first = await client.seedDemo();
    expect(first.created).toBe(true);
    expect(first.sessions).toHaveLength(3);
    expect(first.totals.steps).toBeGreaterThan(0);

    const second = await client.seedDemo();
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.totals).toEqual(first.totals);
  });
});

describe('formatDemoResult', () => {
  it('prints the dashboard, flight, and local-only promise', () => {
    const text = formatDemoResult(result());

    expect(text).toContain('Cockpit demo seeded.');
    expect(text).toContain('http://127.0.0.1:4319/');
    expect(text).toContain(`/sessions/${SESSION_ID}`);
    expect(text).toContain('3 demo flights');
    expect(text).toContain('8 steps, 11 tool calls, 2 guard events');
    expect(text).toContain('Cockpit daemon started');
    expect(text).toContain('No agent, provider, or telemetry service was contacted.');
  });

  it('explains when an existing daemon and seed are reused', () => {
    const text = formatDemoResult(result({ reused: true, seed: { ...SEED, created: false } }));

    expect(text).toContain('already seeded');
    expect(text).toContain('Using the Cockpit daemon already running');
  });

  it('prints machine-readable JSON with resolved URLs', () => {
    const parsed = JSON.parse(formatDemoResult(result(), true)) as Record<string, unknown>;

    expect(parsed['sessionId']).toBe(SESSION_ID);
    expect(parsed['dashboardUrl']).toBe('http://127.0.0.1:4319/');
    expect(parsed['sessionUrl']).toBe(`http://127.0.0.1:4319/sessions/${SESSION_ID}`);
    expect(parsed['daemonUrl']).toBe('http://127.0.0.1:4319');
    expect(parsed['reused']).toBe(false);
    expect(parsed['totals']).toEqual(SEED.totals);
  });
});

describe('demo command registration', () => {
  it('registers the demo command with a JSON flag', () => {
    const program = createProgram();
    const demo = program.commands.find((command) => command.name() === 'demo');

    expect(demo).toBeDefined();
    expect(demo?.description()).toContain('demo flight');
    expect(demo?.options.map((option) => option.long)).toContain('--json');
  });
});
