import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DiscoverResponseSchema,
  HealthResponseSchema,
  SessionListResponseSchema,
  SessionResponseSchema,
  SessionStepsResponseSchema,
  StatsResponseSchema,
  StepDetailResponseSchema,
  WebSocketServerMessageSchema,
  createId,
  type Session,
  type WebSocketClientMessage,
  type WebSocketServerMessage,
} from '@cockpit/core';
import type { StartedDaemon } from '../src/index.js';
import { collectNonStreamResponse } from '../src/sse/collector.js';

import {
  startTestDaemon,
  startUpstream,
  waitFor,
  type FakeUpstream,
  type UpstreamHandler,
} from './helpers.js';

const CONTEXT: Array<{
  directory: string;
  upstream: FakeUpstream;
  daemon: StartedDaemon;
}> = [];

async function boot(
  options: {
    webRoot?: string;
  } = {},
): Promise<{ daemon: StartedDaemon; upstream: FakeUpstream }> {
  const handler: UpstreamHandler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-api',
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    );
  };

  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-api-'));
  const upstream = await startUpstream(handler);
  const daemon = await startTestDaemon({
    home: path.join(directory, 'home'),
    openAiUpstream: upstream.url,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
  });
  CONTEXT.push({ directory, upstream, daemon });
  return { daemon, upstream };
}

afterEach(async () => {
  while (CONTEXT.length > 0) {
    const context = CONTEXT.pop();
    if (!context) continue;
    await context.daemon.close().catch(() => undefined);
    await context.upstream.close().catch(() => undefined);
    rmSync(context.directory, { recursive: true, force: true });
  }
});

async function createSession(
  daemon: StartedDaemon,
  input: Record<string, unknown> = {},
): Promise<Session> {
  const response = await fetch(`${daemon.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'manual', ...input }),
  });
  return SessionResponseSchema.parse(await response.json()).session;
}

describe('REST API', () => {
  it('serves health and protocol discovery', async () => {
    const { daemon } = await boot();

    const healthResponse = await fetch(`${daemon.url}/api/health`);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get('cache-control')).toBe('no-store');
    const health = HealthResponseSchema.parse(await healthResponse.json());
    expect(health.ok).toBe(true);
    expect(health.service).toBe('cockpit-daemon');
    expect(health.database).toBe('ok');
    expect(health.demoMode).toBe(false);
    expect(health.protocol).toEqual({ openai: true, anthropic: true });

    const discoverResponse = await fetch(`${daemon.url}/api/discover`);
    expect(discoverResponse.status).toBe(200);
    const discover = DiscoverResponseSchema.parse(await discoverResponse.json());
    expect(discover.providers).toEqual([
      { id: 'openai', protocol: 'openai', baseUrl: `${daemon.url}/openai/v1` },
      { id: 'anthropic', protocol: 'anthropic', baseUrl: `${daemon.url}/anthropic` },
    ]);

    const session = await createSession(daemon, { title: 'Discovery' });
    const scoped = DiscoverResponseSchema.parse(
      await (await fetch(`${daemon.url}/api/discover?sessionId=${session.id}`)).json(),
    );
    expect(scoped.providers[0]?.baseUrl).toBe(`${daemon.url}/s/${session.id}/openai/v1`);
    expect(scoped.providers[1]?.baseUrl).toBe(`${daemon.url}/s/${session.id}/anthropic`);
  });

  it('reports overview stats from recorded sessions and steps', async () => {
    const { daemon } = await boot();

    const emptyResponse = await fetch(`${daemon.url}/api/stats`);
    expect(emptyResponse.status).toBe(200);
    expect(emptyResponse.headers.get('cache-control')).toBe('no-store');
    const empty = StatsResponseSchema.parse(await emptyResponse.json());
    expect(empty.stats).toEqual({
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
    });

    const active = await createSession(daemon, { title: 'Active stats' });
    const lastSessionAt = new Date(Date.now() + 60_000);
    const finished = daemon.store.createSession({
      title: 'Finished stats',
      source: 'manual',
      tags: [],
      startedAt: lastSessionAt,
    });
    daemon.store.endSession(finished.id, 'completed');

    const handle = daemon.recorder.begin({
      sessionId: active.id,
      protocol: 'openai',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'stats' }],
      }),
    });
    daemon.recorder.finish(handle, {
      status: 'completed',
      responseStatus: 200,
      responseHeaders: {},
      collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }),
    });

    const response = await fetch(`${daemon.url}/api/stats`);
    const { stats } = StatsResponseSchema.parse(await response.json());
    expect(stats.sessionCount).toBe(2);
    expect(stats.activeSessionCount).toBe(1);
    expect(stats.stepCount).toBe(1);
    expect(stats.toolCallCount).toBe(0);
    expect(stats.inputTokens).toBe(4);
    expect(stats.outputTokens).toBe(1);
    expect(stats.totalCostUsd).toBeGreaterThan(0);
    expect(stats.unknownCostCalls).toBe(0);
    expect(stats.errorCount).toBe(0);
    expect(stats.lastSessionAt).toBe(lastSessionAt.toISOString());
  });

  it('serves the built dashboard with SPA fallback and immutable assets', async () => {
    const webRoot = mkdtempSync(path.join(tmpdir(), 'cockpit-web-root-'));
    mkdirSync(path.join(webRoot, 'assets'));
    writeFileSync(
      path.join(webRoot, 'index.html'),
      '<!doctype html><title>Cockpit test dashboard</title><main>dashboard root</main>',
      'utf8',
    );
    writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'console.log("cockpit");', 'utf8');
    writeFileSync(path.join(webRoot, 'favicon.svg'), '<svg></svg>', 'utf8');

    try {
      const { daemon } = await boot({ webRoot });

      const indexResponse = await fetch(`${daemon.url}/`);
      expect(indexResponse.status).toBe(200);
      expect(indexResponse.headers.get('content-type')).toContain('text/html');
      expect(indexResponse.headers.get('cache-control')).toBe('no-store');
      expect(indexResponse.headers.get('x-frame-options')).toBe('DENY');
      expect(indexResponse.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(await indexResponse.text()).toContain('dashboard root');

      const deepLink = await fetch(`${daemon.url}/sessions/11111111-1111-4111-8111-111111111111`);
      expect(deepLink.status).toBe(200);
      expect(await deepLink.text()).toContain('dashboard root');

      const trustLink = await fetch(
        `${daemon.url}/sessions/11111111-1111-4111-8111-111111111111/trust`,
      );
      expect(trustLink.status).toBe(200);
      expect(await trustLink.text()).toContain('dashboard root');

      const guardsPage = await fetch(`${daemon.url}/guards`);
      expect(guardsPage.status).toBe(200);
      expect(await guardsPage.text()).toContain('dashboard root');

      for (const route of [
        '/analytics',
        '/brain',
        '/arena',
        '/journal',
        '/plugins',
        '/sessions/11111111-1111-4111-8111-111111111111/handoff',
      ]) {
        const page = await fetch(`${daemon.url}${route}`);
        expect(page.status, route).toBe(200);
        expect(page.headers.get('content-type'), route).toContain('text/html');
        expect(await page.text(), route).toContain('dashboard root');
      }

      const assetResponse = await fetch(`${daemon.url}/assets/app.js`);
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(await assetResponse.text()).toBe('console.log("cockpit");');

      const health = await fetch(`${daemon.url}/api/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get('content-type')).toContain('application/json');
    } finally {
      rmSync(webRoot, { recursive: true, force: true });
    }
  });

  it('creates, reads, ends, and validates sessions', async () => {
    const { daemon } = await boot();

    const created = await createSession(daemon, {
      title: 'Session lifecycle',
      agent: { name: 'OpenCode', version: '1.0.0', detectedFrom: 'wrapper' },
      tags: ['test'],
      workspacePath: 'C:\\work\\demo',
      gitBranch: 'main',
    });
    expect(created.status).toBe('active');
    expect(created.title).toBe('Session lifecycle');
    expect(created.agent?.name).toBe('OpenCode');
    expect(created.tags).toEqual(['test']);

    const fetched = SessionResponseSchema.parse(
      await (await fetch(`${daemon.url}/api/sessions/${created.id}`)).json(),
    );
    expect(fetched.session.id).toBe(created.id);
    expect(fetched.session.workspacePath).toBe('C:\\work\\demo');

    const endedResponse = await fetch(`${daemon.url}/api/sessions/${created.id}/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'failed' }),
    });
    expect(endedResponse.status).toBe(200);
    const ended = SessionResponseSchema.parse(await endedResponse.json()).session;
    expect(ended.status).toBe('failed');
    expect(ended.endedAt).toBeDefined();

    const endedAgain = SessionResponseSchema.parse(
      await (
        await fetch(`${daemon.url}/api/sessions/${created.id}/end`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'completed' }),
        })
      ).json(),
    ).session;
    expect(endedAgain.status).toBe('failed');

    const invalidBody = await fetch(`${daemon.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toMatchObject({
      error: { code: 'bad_request' },
    });

    const malformedJson = await fetch(`${daemon.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformedJson.status).toBe(400);

    const missing = await fetch(`${daemon.url}/api/sessions/${createId()}`);
    expect(missing.status).toBe(404);

    const invalidId = await fetch(`${daemon.url}/api/sessions/not-a-uuid`);
    expect(invalidId.status).toBe(400);

    const invalidPage = await fetch(`${daemon.url}/api/sessions?limit=0`);
    expect(invalidPage.status).toBe(400);
  });

  it('paginates sessions without duplicates', async () => {
    const { daemon } = await boot();
    const base = Date.parse('2026-01-02T00:00:00.000Z');

    for (let index = 0; index < 3; index += 1) {
      daemon.store.createSession({
        title: `Page ${index}`,
        source: 'manual',
        startedAt: new Date(base + index * 1_000),
      });
    }

    const firstResponse = await fetch(`${daemon.url}/api/sessions?limit=2`);
    expect(firstResponse.status).toBe(200);
    const first = SessionListResponseSchema.parse(await firstResponse.json());
    expect(first.sessions.map((session) => session.title)).toEqual(['Page 2', 'Page 1']);
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await fetch(
      `${daemon.url}/api/sessions?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(secondResponse.status).toBe(200);
    const second = SessionListResponseSchema.parse(await secondResponse.json());
    expect(second.sessions.map((session) => session.title)).toEqual(['Page 0']);
    expect(second.nextCursor).toBeNull();

    const invalidCursor = await fetch(`${daemon.url}/api/sessions?cursor=not-a-cursor`);
    expect(invalidCursor.status).toBe(400);
  });

  it('exposes recorded steps and their details', async () => {
    const { daemon } = await boot();
    const session = await createSession(daemon, { title: 'Steps' });

    const handle = daemon.recorder.begin({
      sessionId: session.id,
      protocol: 'openai',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'step detail' }],
      }),
    });
    daemon.recorder.finish(handle, {
      status: 'completed',
      responseStatus: 200,
      responseHeaders: { 'content-type': 'application/json' },
      collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }),
    });

    const stepsResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/steps`);
    expect(stepsResponse.status).toBe(200);
    const steps = SessionStepsResponseSchema.parse(await stepsResponse.json());
    expect(steps.steps).toHaveLength(1);
    expect(steps.steps[0]?.status).toBe('completed');
    expect(steps.steps[0]?.request?.promptText).toBe('user: step detail');

    const detailResponse = await fetch(`${daemon.url}/api/steps/${handle.step.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = StepDetailResponseSchema.parse(await detailResponse.json());
    expect(detail.step.id).toBe(handle.step.id);
    expect(detail.chunks).toEqual([]);
    expect(detail.toolCalls).toEqual([]);

    const missingSession = await fetch(`${daemon.url}/api/sessions/${createId()}/steps`);
    expect(missingSession.status).toBe(404);

    const missingStep = await fetch(`${daemon.url}/api/steps/${createId()}`);
    expect(missingStep.status).toBe(404);
  });
});

describe('CORS', () => {
  it('handles preflight and allows loopback origins', async () => {
    const { daemon } = await boot();

    const preflight = await fetch(`${daemon.url}/api/health`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'authorization,content-type',
    );

    const loopback = await fetch(`${daemon.url}/api/health`, {
      headers: { origin: 'http://127.0.0.1:5555' },
    });
    expect(loopback.status).toBe(200);
    expect(loopback.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5555');
    expect(loopback.headers.get('access-control-expose-headers')).toContain('x-cockpit-session-id');

    const forbidden = await fetch(`${daemon.url}/api/health`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: 'forbidden' },
    });
  });
});

interface WsWaiter {
  resolve: (message: WebSocketServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WsHarness {
  next: (timeoutMs?: number) => Promise<WebSocketServerMessage>;
  send: (message: WebSocketClientMessage) => void;
  close: () => Promise<void>;
}

function wsText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part)))),
    ).toString('utf8');
  }
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data);
}

async function connectWebSocket(baseUrl: string): Promise<WsHarness> {
  const socketUrl = `${baseUrl.replace(/^http/, 'ws')}/api/ws`;
  const socket = new WebSocket(socketUrl);
  const queue: WebSocketServerMessage[] = [];
  const waiters: WsWaiter[] = [];
  let failure: Error | undefined;

  const failAll = (error: Error): void => {
    failure = error;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  socket.on('message', (data) => {
    try {
      const parsed = WebSocketServerMessageSchema.parse(JSON.parse(wsText(data)));
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      } else {
        queue.push(parsed);
      }
    } catch (error) {
      failAll(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on('error', (error) => failAll(error));
  socket.on('close', () => {
    failAll(new Error('The WebSocket closed before the expected message arrived.'));
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return {
    next(timeoutMs = 3_000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (failure) return Promise.reject(failure);

      return new Promise<WebSocketServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for a WebSocket message.'));
        }, timeoutMs);
        timer.unref();

        waiters.push({ resolve, reject, timer });
      });
    },
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      return new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
        socket.close();
      });
    },
  };
}

describe('WebSocket live feed', () => {
  it('streams only subscribed session events with ordered sequences', async () => {
    const { daemon } = await boot();
    const target = await createSession(daemon, { title: 'WS target' });
    await createSession(daemon, { title: 'WS other' });

    const harness = await connectWebSocket(daemon.url);
    try {
      const ready = await harness.next();
      expect(ready.type).toBe('ready');

      harness.send({ type: 'ping' });
      expect((await harness.next()).type).toBe('pong');

      harness.send({ type: 'subscribe', sessionId: target.id });
      const subscribed = await harness.next();
      expect(subscribed).toMatchObject({
        type: 'subscribed',
        sessionId: target.id,
      });

      const proxyResponse = await fetch(`${daemon.url}/s/${target.id}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'live feed' }],
        }),
      });
      expect(proxyResponse.status).toBe(200);
      await proxyResponse.text();

      const started = await harness.next();
      expect(started.type).toBe('event');
      if (started.type !== 'event') throw new Error('Expected a step.started event.');
      expect(started.event.type).toBe('step.started');
      expect(started.event.sessionId).toBe(target.id);

      const completed = await harness.next();
      expect(completed.type).toBe('event');
      if (completed.type !== 'event') throw new Error('Expected a step.completed event.');
      expect(completed.event.type).toBe('step.completed');
      expect(completed.event.sessionId).toBe(target.id);

      const updated = await harness.next();
      expect(updated.type).toBe('event');
      if (updated.type !== 'event') throw new Error('Expected a session.updated event.');
      expect(updated.event.type).toBe('session.updated');
      expect(updated.event.sessionId).toBe(target.id);
      expect(updated.event.payload).toMatchObject({
        totals: { stepCount: 1, inputTokens: 3, outputTokens: 1 },
      });

      expect(started.event.sequence).toBeLessThan(completed.event.sequence);
      expect(completed.event.sequence).toBeLessThan(updated.event.sequence);

      const step = await waitFor(
        () => {
          const current = daemon.store.getStep(
            completed.type === 'event' ? (completed.event.stepId ?? '') : '',
          );
          return current?.status === 'completed' ? current : undefined;
        },
        { description: 'the WebSocket-recorded step' },
      );
      expect(step.id).toBe(completed.type === 'event' ? completed.event.stepId : undefined);

      await createSession(daemon, { title: 'Filtered noise' });
      await expect(harness.next(250)).rejects.toThrow('Timed out waiting for a WebSocket message.');
    } finally {
      await harness.close();
    }
  });
});
