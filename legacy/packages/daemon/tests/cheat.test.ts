import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@cockpit/core';

import { CheatDetector } from '../src/cheat/detector.js';
import { openDatabase, type CockpitDatabaseConnection } from '../src/db/client.js';
import { LiveEventBus } from '../src/live/bus.js';
import { createLogger } from '../src/logger.js';
import { Recorder } from '../src/recording/recorder.js';
import { collectNonStreamResponse } from '../src/sse/collector.js';
import { Store } from '../src/store/store.js';

function recordStep(store: Store, bus: LiveEventBus, sessionId: string, responseText: string) {
  const recorder = new Recorder({ store, bus, logger: createLogger('silent') });
  const handle = recorder.begin({
    sessionId,
    protocol: 'openai',
    provider: 'openai',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {},
    bodyText: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Fix the auth tests.' }],
    }),
  });
  recorder.finish(handle, {
    status: 'completed',
    responseStatus: 200,
    responseHeaders: {},
    collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { content: responseText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }),
  });
  return handle.step;
}

describe('CheatDetector', () => {
  let connection: CockpitDatabaseConnection;
  let store: Store;
  let bus: LiveEventBus;
  let detector: CheatDetector;
  let session: Session;

  beforeEach(() => {
    connection = openDatabase({ databasePath: ':memory:' });
    store = new Store(connection);
    const logger = createLogger('silent');
    bus = new LiveEventBus({
      initialSequence: 0,
      persist: (event) => store.insertLiveEvent(event),
      logger,
    });
    detector = new CheatDetector({ store, bus, logger });
    session = store.createSession({ title: 'Trust test', source: 'manual', tags: [] });
  });

  afterEach(() => {
    detector.dispose();
    store.close();
  });

  it('finds deleted tests, skipped tests, weakened assertions, and stubs', () => {
    const step = recordStep(store, bus, session.id, 'The implementation is complete and done.');
    const eventTypes: string[] = [];
    bus.subscribe((event) => eventTypes.push(event.type));

    store.insertSnapshot({
      sessionId: session.id,
      stepId: step.id,
      kind: 'after',
      filesChanged: 5,
      insertions: 12,
      deletions: 9,
      fileChanges: [
        {
          path: 'tests/auth.test.ts',
          changeType: 'deleted',
          additions: 0,
          deletions: 12,
        },
        {
          path: 'tests/login.test.ts',
          changeType: 'added',
          additions: 1,
          deletions: 0,
          diff: ['@@ -0,0 +1,1 @@', '+it.skip("login", () => {})'].join('\n'),
        },
        {
          path: 'tests/session.test.ts',
          changeType: 'modified',
          additions: 1,
          deletions: 2,
          diff: [
            '@@ -1,3 +1,2 @@',
            ' describe("session", () => {',
            '-  expect(result).toBe(true);',
            '-  expect(other).toBe(false);',
            '+  expect(result).toBe(true);',
            ' });',
          ].join('\n'),
        },
        {
          path: 'src/auth.ts',
          changeType: 'modified',
          additions: 8,
          deletions: 2,
          diff: [
            '@@ -1,4 +1,10 @@',
            ' export function login() {',
            '-  return true;',
            '+  // eslint-disable-next-line',
            "+  if (process.env.NODE_ENV === 'test') {",
            '+    return true;',
            '+  }',
            '+  try {',
            '+    return checkPassword();',
            '+  } catch {}',
            '+  throw new Error("Not implemented");',
            ' }',
          ].join('\n'),
        },
        {
          path: 'src/__mocks__/db.ts',
          changeType: 'added',
          additions: 1,
          deletions: 0,
          diff: ['@@ -0,0 +1,1 @@', "+vi.mock('./db')"].join('\n'),
        },
      ],
    });

    const analysis = detector.analyzeSession(session.id);
    expect(analysis).toBeDefined();
    expect(analysis?.filesExamined).toBe(5);
    expect(analysis?.trustScore).toBeLessThan(100);
    expect(analysis?.grade).not.toBe('A');

    const categories = analysis?.findings.map((finding) => finding.category) ?? [];
    expect(categories).toEqual(
      expect.arrayContaining([
        'deleted_test',
        'skipped_test',
        'weakened_test',
        'suppression',
        'empty_catch',
        'hardcoded_expectation',
        'mock_replacement',
        'stub_presented_as_done',
      ]),
    );

    expect(eventTypes).toContain('analysis.updated');
    expect(store.getLatestCheatAnalysis(session.id)?.trustScore).toBe(analysis?.trustScore);
  });

  it('replaces the previous analysis instead of stacking findings', () => {
    store.insertSnapshot({
      sessionId: session.id,
      kind: 'after',
      filesChanged: 1,
      insertions: 0,
      deletions: 4,
      fileChanges: [
        { path: 'tests/auth.test.ts', changeType: 'deleted', additions: 0, deletions: 4 },
      ],
    });

    const first = detector.analyzeSession(session.id);
    expect(first?.findings).toHaveLength(1);
    expect(first?.findings[0]?.category).toBe('deleted_test');

    const second = detector.analyzeSession(session.id);
    expect(second?.findings).toHaveLength(1);
    expect(store.getLatestCheatAnalysis(session.id)?.findings).toHaveLength(1);
  });

  it('returns a clean grade when no suspicious change exists', () => {
    store.insertSnapshot({
      sessionId: session.id,
      kind: 'after',
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
      fileChanges: [
        {
          path: 'src/auth.ts',
          changeType: 'modified',
          additions: 2,
          deletions: 0,
          diff: [
            '@@ -1,1 +1,3 @@',
            ' export function login() {',
            '+  return checkPassword();',
            ' }',
          ].join('\n'),
        },
      ],
    });

    const analysis = detector.analyzeSession(session.id);
    expect(analysis?.findings).toEqual([]);
    expect(analysis?.trustScore).toBe(100);
    expect(analysis?.grade).toBe('A');
  });
});
