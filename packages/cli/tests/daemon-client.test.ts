import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createId } from '@cockpit/core';
import { loadConfig, startDaemon, type StartedDaemon } from '@cockpit/daemon';

import { DaemonClient, DaemonRequestError } from '../src/daemon-client.js';

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
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-cli-client-'));
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

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The probe server did not report a port.');
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not report a port.');
  }
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe('DaemonClient', () => {
  it('talks to a real daemon and validates responses', async () => {
    const daemon = await startTestDaemon();
    const client = new DaemonClient(daemon.url);

    const health = await client.health();
    expect(health?.ok).toBe(true);
    expect(health?.service).toBe('cockpit-daemon');

    const session = await client.createSession({
      source: 'manual',
      title: 'CLI client',
      tags: ['test'],
    });
    expect(session.title).toBe('CLI client');
    expect(session.status).toBe('active');

    const fetched = await client.getSession(session.id);
    expect(fetched.id).toBe(session.id);
    expect(fetched.tags).toEqual(['test']);

    const steps = await client.listSteps(session.id);
    expect(steps.steps).toEqual([]);

    const ended = await client.endSession(session.id, 'completed');
    expect(ended.status).toBe('completed');
    expect(ended.endedAt).toBeDefined();
  });

  it('surfaces daemon errors with status and code', async () => {
    const daemon = await startTestDaemon();
    const client = new DaemonClient(daemon.url);

    const missing = createId();
    const error = await client.getSession(missing).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DaemonRequestError);
    if (!(error instanceof DaemonRequestError)) throw error;
    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('not found');
  });

  it('returns undefined health when the daemon is unreachable', async () => {
    const port = await unusedPort();
    const client = new DaemonClient(`http://127.0.0.1:${port}`, { timeoutMs: 500 });
    await expect(client.health()).resolves.toBeUndefined();
  });

  it('reports invalid JSON from a reachable server', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not-json');
    });
    const port = await listen(server);
    registerCleanup(() => closeServer(server));

    const client = new DaemonClient(`http://127.0.0.1:${port}`, { timeoutMs: 2_000 });
    const error = await client
      .createSession({ source: 'manual', title: 'Invalid', tags: [] })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DaemonRequestError);
    if (!(error instanceof DaemonRequestError)) throw error;
    expect(error.message).toContain('invalid JSON');
    expect(error.status).toBe(200);
  });

  it('includes the daemon URL when a request cannot connect', async () => {
    const port = await unusedPort();
    const client = new DaemonClient(`http://127.0.0.1:${port}`, { timeoutMs: 500 });
    const error = await client
      .createSession({ source: 'manual', title: 'Unreachable', tags: [] })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DaemonRequestError);
    if (!(error instanceof DaemonRequestError)) throw error;
    expect(error.message).toContain(`http://127.0.0.1:${port}`);
  });
});
