import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRecord } from '@cockpit/core';

import { openDatabase, type CockpitDatabaseConnection } from '../src/db/client.js';
import { LiveEventBus } from '../src/live/bus.js';
import { createLogger } from '../src/logger.js';
import { Recorder } from '../src/recording/recorder.js';
import { SessionManager } from '../src/sessions/manager.js';
import { collectNonStreamResponse } from '../src/sse/collector.js';
import { Store } from '../src/store/store.js';

describe('Recorder', () => {
  let connection: CockpitDatabaseConnection;
  let store: Store;
  let bus: LiveEventBus;
  let sessions: SessionManager;
  let recorder: Recorder;

  beforeEach(() => {
    connection = openDatabase({ databasePath: ':memory:' });
    store = new Store(connection);
    const logger = createLogger('silent');
    bus = new LiveEventBus({
      initialSequence: 0,
      persist: (event) => store.insertLiveEvent(event),
      logger,
    });
    sessions = new SessionManager({
      store,
      bus,
      logger,
      idleTimeoutMs: 60_000,
    });
    recorder = new Recorder({ store, bus, logger });
  });

  afterEach(() => {
    store.close();
  });

  it('redacts, records, costs, and finalizes a model call exactly once', () => {
    const eventTypes: string[] = [];
    bus.subscribe((event) => eventTypes.push(event.type));

    const session = sessions.create({ source: 'manual', title: 'Recorder test', tags: [] });
    const openAiKey = `sk-${'a'.repeat(32)}`;

    const handle = recorder.begin({
      sessionId: session.id,
      protocol: 'openai',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer sk-real-secret',
        'x-api-key': 'another-secret',
        'content-type': 'application/json',
      },
      bodyText: JSON.stringify({
        model: 'gpt-4o-mini',
        stream: false,
        messages: [
          { role: 'system', content: 'Be terse' },
          { role: 'user', content: 'hi' },
        ],
        api_key: openAiKey,
      }),
    });

    expect(handle.step.status).toBe('running');
    expect(handle.step.request?.headers['authorization']).toBe('[REDACTED]');
    expect(handle.step.request?.headers['x-api-key']).toBe('[REDACTED]');
    expect(handle.step.request?.systemPrompt).toBe('Be terse');
    expect(handle.step.request?.promptText).toBe('user: hi');
    expect(handle.step.request?.stream).toBe(false);
    expect(handle.step.request?.redactionCount).toBe(3);
    expect(handle.step.request?.body).toMatchObject({
      model: 'gpt-4o-mini',
      api_key: '[REDACTED]',
    });

    const collected = collectNonStreamResponse('openai', '/v1/chat/completions', {
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });

    expect(
      recorder.finish(handle, {
        status: 'completed',
        responseStatus: 200,
        responseHeaders: { 'set-cookie': 'session=secret', 'x-request-id': 'req_1' },
        collected,
      }),
    ).toBe(true);
    expect(
      recorder.finish(handle, {
        status: 'completed',
        responseStatus: 200,
        responseHeaders: {},
      }),
    ).toBe(false);

    const step = store.getStep(handle.step.id);
    expect(step).toBeDefined();
    expect(step?.status).toBe('completed');
    expect(step?.response?.text).toBe('ok');
    expect(step?.response?.headers['set-cookie']).toBe('[REDACTED]');
    expect(step?.response?.headers['x-request-id']).toBe('req_1');
    expect(step?.response?.finishReason).toBe('tool_calls');
    expect(step?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    expect(step?.costKnown).toBe(true);
    expect(step?.costUsd).toBeGreaterThan(0);

    const toolCalls = store.listToolCalls(handle.step.id);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('read_file');
    expect(toolCalls[0]?.input).toEqual({ path: 'src/a.ts' });
    expect(toolCalls[0]?.filePaths).toEqual([path.normalize('src/a.ts')]);

    const redactions = connection.raw
      .prepare('SELECT rule_id AS ruleId, location, occurrences FROM redactions')
      .all() as Array<{ ruleId: string; location: string; occurrences: number }>;
    const requestHeaderCount = redactions
      .filter((row) => row.ruleId === 'sensitive-header' && row.location === 'request_headers')
      .reduce((sum, row) => sum + row.occurrences, 0);
    expect(requestHeaderCount).toBe(2);
    expect(redactions).toContainEqual({
      ruleId: 'sensitive-header',
      location: 'response_headers',
      occurrences: 1,
    });

    const updated = store.getSession(session.id);
    expect(updated?.totals.stepCount).toBe(1);
    expect(updated?.totals.modelCallCount).toBe(1);
    expect(updated?.totals.toolCallCount).toBe(1);
    expect(updated?.totals.inputTokens).toBe(10);
    expect(updated?.totals.outputTokens).toBe(2);
    expect(updated?.totals.unknownCostCalls).toBe(0);
    expect(updated?.totals.totalCostUsd).toBeGreaterThan(0);

    expect(eventTypes).toContain('step.started');
    expect(eventTypes).toContain('tool.completed');
    expect(eventTypes).toContain('step.completed');
    expect(eventTypes).toContain('session.updated');
    expect(store.maxLiveEventSequence()).toBeGreaterThan(0);
  });

  it('keeps unpriced models unknown instead of reporting a fake zero cost', () => {
    const session = sessions.create({ source: 'manual', title: 'Unknown model', tags: [] });
    const handle = recorder.begin({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: JSON.stringify({
        model: 'custom-model-without-pricing',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    recorder.finish(handle, {
      status: 'completed',
      responseStatus: 200,
      responseHeaders: {},
      collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
        model: 'custom-model-without-pricing',
        choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    });

    const step = store.getStep(handle.step.id);
    expect(step?.costKnown).toBe(false);
    expect(step?.costUsd).toBeUndefined();

    const sessionAfter = store.getSession(session.id);
    expect(sessionAfter?.totals.unknownCostCalls).toBe(1);
    expect(sessionAfter?.totals.totalCostUsd).toBe(0);
  });

  it('stores non-JSON request bodies and failed responses without inventing usage', () => {
    const session = sessions.create({ source: 'manual', title: 'Failure', tags: [] });
    const handle = recorder.begin({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: 'not json at all',
    });

    expect(handle.step.request?.body).toBe('not json at all');
    expect(handle.step.request?.stream).toBe(false);

    recorder.finish(handle, {
      status: 'failed',
      responseStatus: 500,
      responseHeaders: {},
      error: 'upstream exploded',
    });

    const step = store.getStep(handle.step.id);
    expect(step?.status).toBe('failed');
    expect(step?.error).toBe('upstream exploded');
    expect(step?.response?.error).toBe('upstream exploded');
    expect(step?.response?.finishReason).toBe('error');
    expect(step?.usage.inputTokens).toBe(0);
    expect(step?.costKnown).toBe(false);

    const requestBody = handle.step.request?.body;
    expect(isRecord(requestBody)).toBe(false);
  });
});
