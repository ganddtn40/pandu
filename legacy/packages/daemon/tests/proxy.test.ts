import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { IdSchema, SessionResponseSchema, type Session } from '@cockpit/core';
import type { StartedDaemon } from '../src/index.js';

import {
  createDeferred,
  startTestDaemon,
  startUpstream,
  waitFor,
  type FakeUpstream,
  type UpstreamHandler,
} from './helpers.js';

const OPENAI_MODEL = 'gpt-4o-mini';
const ANTHROPIC_MODEL = 'claude-sonnet-4';

interface TestContext {
  tempDirectory: string;
  upstream: FakeUpstream;
  daemon: StartedDaemon;
}

const contexts: TestContext[] = [];

async function boot(handler: UpstreamHandler, env: NodeJS.ProcessEnv = {}): Promise<TestContext> {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'cockpit-proxy-'));
  const upstream = await startUpstream(handler);
  const daemon = await startTestDaemon({
    home: path.join(tempDirectory, 'home'),
    openAiUpstream: upstream.url,
    env,
  });
  const context = { tempDirectory, upstream, daemon };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    await context.daemon.close().catch(() => undefined);
    await context.upstream.close().catch(() => undefined);
    rmSync(context.tempDirectory, { recursive: true, force: true });
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
  expect(response.status).toBe(201);
  return SessionResponseSchema.parse(await response.json()).session;
}

function jsonSuccess(body: unknown): UpstreamHandler {
  return (_request, response: ServerResponse) => {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'x-upstream-request-id': 'up_1',
    });
    response.end(JSON.stringify(body));
  };
}

function openAiCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: OPENAI_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

describe('proxy', () => {
  it('forwards an OpenAI request byte-for-byte and records the call', async () => {
    const completion = openAiCompletion('Hello from upstream');
    const { daemon, upstream } = await boot(jsonSuccess(completion));
    const session = await createSession(daemon, { title: 'Non-stream OpenAI' });
    const requestBody = JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
    });

    const response = await fetch(`${daemon.url}/s/${session.id}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer cockpit-proxy',
        'user-agent': 'opencode/1.0',
      },
      body: requestBody,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(completion));

    const stepId = response.headers.get('x-cockpit-step-id');
    expect(response.headers.get('x-cockpit-session-id')).toBe(session.id);
    expect(stepId).not.toBeNull();
    expect(() => IdSchema.parse(stepId)).not.toThrow();

    const captured = upstream.requests[0];
    expect(captured).toBeDefined();
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('/v1/chat/completions');
    expect(captured?.body.toString('utf8')).toBe(requestBody);
    expect(captured?.headers['authorization']).toBe('Bearer sk-test-openai');
    expect(captured?.headers['accept-encoding']).toBe('identity');
    expect(captured?.headers['user-agent']).toBe('opencode/1.0');
    expect(captured?.headers['x-cockpit-agent-name']).toBeUndefined();

    const step = await waitFor(
      () => {
        const current = daemon.store.getStep(stepId ?? '');
        return current?.status === 'completed' ? current : undefined;
      },
      { description: 'the recorded OpenAI step' },
    );

    expect(step.request?.protocol).toBe('openai');
    expect(step.request?.stream).toBe(false);
    expect(step.request?.systemPrompt).toBe('You are terse.');
    expect(step.request?.promptText).toBe('user: hi');
    expect(step.model).toBe(OPENAI_MODEL);
    expect(step.response?.status).toBe(200);
    expect(step.response?.text).toBe('Hello from upstream');
    expect(step.response?.headers['x-upstream-request-id']).toBe('up_1');
    expect(step.response?.finishReason).toBe('stop');
    expect(step.usage.inputTokens).toBe(5);
    expect(step.usage.outputTokens).toBe(2);
    expect(step.costKnown).toBe(true);
    expect(step.costUsd).toBeGreaterThan(0);

    const updated = daemon.store.getSession(session.id);
    expect(updated?.totals.stepCount).toBe(1);
    expect(updated?.totals.inputTokens).toBe(5);
    expect(updated?.totals.outputTokens).toBe(2);
    expect(updated?.totals.totalCostUsd).toBeGreaterThan(0);

    const detailResponse = await fetch(`${daemon.url}/api/steps/${stepId ?? ''}`);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      chunks: unknown[];
      toolCalls: unknown[];
    };
    expect(detail.chunks).toEqual([]);
    expect(detail.toolCalls).toEqual([]);
  });

  it('passes SSE bytes through immediately without buffering until completion', async () => {
    const firstEvent = `data: ${JSON.stringify({
      id: 'chatcmpl-stream',
      object: 'chat.completion.chunk',
      model: OPENAI_MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'first' } }],
    })}\n\n`;
    const secondEvent = `data: ${JSON.stringify({
      id: 'chatcmpl-stream',
      object: 'chat.completion.chunk',
      model: OPENAI_MODEL,
      choices: [{ index: 0, delta: { content: ' second' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })}\n\ndata: [DONE]\n\n`;

    const gate = createDeferred<void>();
    let upstreamReleased = false;

    const { daemon } = await boot(async (_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      response.write(firstEvent);
      await gate.promise;
      upstreamReleased = true;
      response.end(secondEvent);
    });

    const session = await createSession(daemon, { title: 'Streaming OpenAI' });
    const response = await fetch(`${daemon.url}/s/${session.id}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'stream please' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const stepId = response.headers.get('x-cockpit-step-id');
    expect(stepId).not.toBeNull();

    const body = response.body;
    if (!body) throw new Error('The proxy response did not include a body.');
    const reader = body.getReader();
    const chunks: Buffer[] = [];

    try {
      const firstRead = await reader.read();
      expect(firstRead.done).toBe(false);
      if (firstRead.value) chunks.push(Buffer.from(firstRead.value));

      // If Cockpit buffered the stream, this read would still be blocked here.
      expect(upstreamReleased).toBe(false);
      expect(Buffer.concat(chunks).toString('utf8')).toBe(firstEvent);

      gate.resolve();

      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value) chunks.push(Buffer.from(next.value));
      }
    } finally {
      gate.resolve();
      reader.releaseLock();
    }

    expect(Buffer.concat(chunks).toString('utf8')).toBe(firstEvent + secondEvent);

    const step = await waitFor(
      () => {
        const current = daemon.store.getStep(stepId ?? '');
        return current?.status === 'completed' ? current : undefined;
      },
      { description: 'the recorded streaming step' },
    );

    expect(step.request?.stream).toBe(true);
    expect(step.response?.text).toBe('first second');
    expect(step.response?.finishReason).toBe('stop');
    expect(step.usage.inputTokens).toBe(10);
    expect(step.usage.outputTokens).toBe(2);
    expect(step.response?.ttftMs).toBeDefined();
    expect(step.costKnown).toBe(true);

    const recordedChunks = daemon.store.listStreamChunks(step.id);
    expect(recordedChunks.map((chunk) => chunk.kind)).toEqual(['text', 'text', 'done']);
    expect(recordedChunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    expect(recordedChunks[0]?.deltaText).toBe('first');
    expect(recordedChunks[1]?.deltaText).toBe(' second');
  });

  it('auto-detects Anthropic routing and records streamed messages', async () => {
    const stream = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_test',
          model: ANTHROPIC_MODEL,
          usage: { input_tokens: 12 },
        },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 4 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');

    const { daemon, upstream } = await boot((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(stream);
    });

    const session = await createSession(daemon, { title: 'Anthropic stream' });
    const response = await fetch(`${daemon.url}/s/${session.id}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'cockpit-proxy',
        'anthropic-version': '2024-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(stream);

    const captured = upstream.requests[0];
    expect(captured?.url).toBe('/v1/messages');
    expect(captured?.headers['x-api-key']).toBe('sk-ant-test-anthropic');
    expect(captured?.headers['anthropic-version']).toBe('2024-06-01');
    expect(captured?.headers['authorization']).toBeUndefined();

    const stepId = response.headers.get('x-cockpit-step-id');
    const step = await waitFor(
      () => {
        const current = daemon.store.getStep(stepId ?? '');
        return current?.status === 'completed' ? current : undefined;
      },
      { description: 'the recorded Anthropic step' },
    );

    expect(step.request?.protocol).toBe('anthropic');
    expect(step.provider).toBe('anthropic');
    expect(step.model).toBe(ANTHROPIC_MODEL);
    expect(step.response?.text).toBe('Hello');
    expect(step.response?.finishReason).toBe('stop');
    expect(step.usage.inputTokens).toBe(12);
    expect(step.usage.outputTokens).toBe(4);
    expect(step.costKnown).toBe(true);
  });

  it('creates an ambient session for unrouted calls and rejects ended sessions', async () => {
    const { daemon } = await boot(jsonSuccess(openAiCompletion('ambient reply')));
    const requestBody = JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
    });

    const ambientResponse = await fetch(`${daemon.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });

    expect(ambientResponse.status).toBe(200);
    const sessionIdHeader = ambientResponse.headers.get('x-cockpit-session-id');
    expect(sessionIdHeader).not.toBeNull();
    const sessionId = IdSchema.parse(sessionIdHeader);

    const session = daemon.store.getSession(sessionId);
    expect(session?.source).toBe('proxy');
    expect(session?.title).toBe('Local OpenAI proxy');
    expect(session?.status).toBe('active');

    const ended = await fetch(`${daemon.url}/api/sessions/${sessionId}/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(ended.status).toBe(200);

    const rejected = await fetch(`${daemon.url}/s/${sessionId}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });
    expect(rejected.status).toBe(409);
    const rejectedBody = (await rejected.json()) as {
      error: { message: string; type: string };
    };
    expect(rejectedBody.error.message).toContain('already ended');
    expect(rejectedBody.error.type).toBe('invalid_request_error');

    const unknownSession = await fetch(
      `${daemon.url}/s/00000000-0000-4000-8000-000000000000/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      },
    );
    expect(unknownSession.status).toBe(404);
    expect(await unknownSession.json()).toMatchObject({
      error: { message: expect.stringContaining('does not exist') },
    });

    const invalidSession = await fetch(`${daemon.url}/s/not-a-uuid/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });
    expect(invalidSession.status).toBe(400);
    expect(await invalidSession.json()).toMatchObject({
      error: { code: 'bad_request' },
    });
  });

  it('rejects request bodies larger than the configured maximum', async () => {
    const { daemon, upstream } = await boot(jsonSuccess(openAiCompletion('too large')), {
      COCKPIT_MAX_BODY_BYTES: '16',
    });
    const session = await createSession(daemon, { title: 'Body limit' });

    const response = await fetch(`${daemon.url}/s/${session.id}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: 'this is too large' }],
      }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('larger than Cockpit allows') },
    });
    expect(upstream.requests).toHaveLength(0);
  });
});
