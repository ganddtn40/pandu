import { afterEach, describe, expect, it } from 'vitest';

import { ContextDoctor, Store, createLogger, openDatabase } from '../src/index.js';
import type { CockpitDatabaseConnection } from '../src/db/client.js';

const connections: CockpitDatabaseConnection[] = [];

function setup() {
  const connection = openDatabase({ databasePath: ':memory:' });
  connections.push(connection);
  const store = new Store(connection);
  const doctor = new ContextDoctor({ store, logger: createLogger('silent') });
  return { store, doctor };
}

afterEach(() => {
  while (connections.length > 0) {
    connections.pop()?.close();
  }
});

function modelRequest(content = 'hello') {
  return {
    protocol: 'openai' as const,
    method: 'POST',
    path: '/v1/chat/completions',
    stream: false,
    headers: {},
    redactionCount: 0,
    body: {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content }],
    },
  };
}

describe('context doctor segments', () => {
  it('classifies system, rules, history, tool output, and request overhead', () => {
    const { doctor } = setup();
    const analysis = doctor.analyze({
      sessionId: 'session-1',
      stepId: 'step-1',
      provider: 'openai',
      model: 'gpt-4.1',
      systemPrompt: 'You are a careful coding agent.',
      body: {
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: 'Follow the repository rules.' },
          { role: 'user', content: 'Read file: src/auth.ts and fix the race.' },
          { role: 'assistant', content: 'I will inspect the file.' },
          { role: 'tool', content: 'export const auth = true;' },
        ],
        tools: [{ type: 'function', function: { name: 'read_file' } }],
      },
    });

    const categories = new Set(analysis.segments.map((segment) => segment.category));
    expect(categories).toContain('system');
    expect(categories).toContain('rules');
    expect(categories).toContain('history');
    expect(categories).toContain('tool_output');
    expect(categories).toContain('other');

    expect(analysis.totalTokens).toBeGreaterThan(0);
    expect(analysis.contextWindow).toBe(1_047_576);
    expect(
      analysis.segments.every((segment) => segment.percent >= 0 && segment.percent <= 100),
    ).toBe(true);
    expect(analysis.segments.some((segment) => segment.sourcePath === 'src/auth.ts')).toBe(true);
    expect(analysis.insights).toEqual([]);
  });
});

describe('context doctor insights', () => {
  it('flags duplicate instructions in system context', () => {
    const { doctor } = setup();
    const analysis = doctor.analyze({
      sessionId: 'session-1',
      stepId: 'step-1',
      systemPrompt:
        'Always run the full test suite before committing. Always run the full test suite before committing.',
    });

    const duplicate = analysis.insights.find((insight) => insight.type === 'duplicate_instruction');
    expect(duplicate).toBeDefined();
    expect(duplicate?.severity).toBe('low');
    expect(duplicate?.detail).toContain('appears 2 times');
    expect(duplicate?.estimatedSavingsTokens).toBeGreaterThan(0);
  });

  it('flags contradictory instructions in system context', () => {
    const { doctor } = setup();
    const analysis = doctor.analyze({
      sessionId: 'session-1',
      stepId: 'step-1',
      systemPrompt:
        'Always write tests for every new function. Never write tests for every new function.',
    });

    const conflict = analysis.insights.find(
      (insight) => insight.type === 'conflicting_instruction',
    );
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe('high');
    expect(conflict?.detail).toContain('both required and forbidden');
  });

  it('flags oversized tool output with an estimated saving', () => {
    const { doctor } = setup();
    const analysis = doctor.analyze({
      sessionId: 'session-1',
      stepId: 'step-1',
      body: {
        model: 'gpt-4.1',
        messages: [{ role: 'tool', content: 't'.repeat(20_000) }],
      },
    });

    const large = analysis.insights.find((insight) => insight.type === 'large_tool_output');
    expect(large).toBeDefined();
    expect(large?.severity).toBe('medium');
    expect(large?.detail).toContain('5,000 estimated tokens');
    expect(large?.estimatedSavingsTokens).toBe(2_500);
  });

  it('flags conversation history that dominates the request', () => {
    const { doctor } = setup();
    const analysis = doctor.analyze({
      sessionId: 'session-1',
      stepId: 'step-1',
      body: {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'h'.repeat(88_000) }],
      },
    });

    const bloat = analysis.insights.find((insight) => insight.type === 'history_bloat');
    expect(bloat).toBeDefined();
    expect(bloat?.severity).toBe('high');
    expect(bloat?.detail).toContain('22,000 estimated tokens');
    expect(bloat?.estimatedSavingsTokens).toBe(5_500);
  });

  it('flags a request close to a known context window', () => {
    const { doctor } = setup();
    const analysis = doctor.analyze({
      sessionId: 'session-1',
      stepId: 'step-1',
      model: 'gpt-4.1',
      body: {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'c'.repeat(4_000_000) }],
      },
    });

    const compaction = analysis.insights.find((insight) => insight.type === 'compaction');
    expect(compaction).toBeDefined();
    expect(compaction?.severity).toBe('high');
    expect(compaction?.title).toBe('Context window is nearly full');
    expect(compaction?.estimatedSavingsTokens).toBeGreaterThan(0);
  });

  it('reports an unknown window instead of guessing for a huge request', () => {
    const { doctor } = setup();
    const analysis = doctor.analyze({
      sessionId: 'session-1',
      stepId: 'step-1',
      model: 'mystery-model',
      body: {
        model: 'mystery-model',
        messages: [{ role: 'user', content: 'u'.repeat(500_000) }],
      },
    });

    expect(analysis.contextWindow).toBeUndefined();
    const compaction = analysis.insights.find((insight) => insight.type === 'compaction');
    expect(compaction).toBeDefined();
    expect(compaction?.severity).toBe('medium');
    expect(compaction?.title).toBe('Very large request with an unknown context window');
  });

  it('flags a file that changed again after the analyzed step', () => {
    const { store, doctor } = setup();
    const session = store.createSession({ title: 'Stale fixture', source: 'manual' });
    const first = store.beginStep({
      sessionId: session.id,
      kind: 'model',
      provider: 'openai',
      model: 'gpt-4.1',
      request: modelRequest(),
    });
    const second = store.beginStep({
      sessionId: session.id,
      kind: 'model',
      provider: 'openai',
      model: 'gpt-4.1',
      request: modelRequest(),
    });
    store.insertSnapshot({
      sessionId: session.id,
      stepId: second.id,
      kind: 'after',
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      fileChanges: [{ path: 'src/auth.ts', changeType: 'modified', additions: 1, deletions: 0 }],
    });

    const analysis = doctor.analyze({
      sessionId: session.id,
      stepId: first.id,
      provider: 'openai',
      model: 'gpt-4.1',
      body: {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Read file: src/auth.ts and fix the race.' }],
      },
    });

    const stale = analysis.insights.find((insight) => insight.type === 'stale_file');
    expect(stale).toBeDefined();
    expect(stale?.paths).toEqual(['src/auth.ts']);
    expect(stale?.detail).toContain('changed again later in the session');
  });
});

describe('context doctor persistence', () => {
  it('captures a snapshot and returns segments and insights from the store', () => {
    const { store, doctor } = setup();
    const session = store.createSession({ title: 'Capture fixture', source: 'manual' });
    const step = store.beginStep({
      sessionId: session.id,
      kind: 'model',
      provider: 'openai',
      model: 'gpt-4.1',
      request: modelRequest(),
    });

    const snapshot = doctor.capture({
      sessionId: session.id,
      stepId: step.id,
      provider: 'openai',
      model: 'gpt-4.1',
      systemPrompt:
        'Always run the full test suite before committing. Always run the full test suite before committing.',
      body: {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Ship it.' }],
      },
    });

    const list = doctor.list(session.id);
    expect(list.latest?.id).toBe(snapshot.id);
    expect(list.snapshots).toHaveLength(1);

    const detail = doctor.detail(snapshot.id);
    expect(detail).toBeDefined();
    expect(detail?.segments.length).toBeGreaterThan(0);
    expect(detail?.insights.some((insight) => insight.type === 'duplicate_instruction')).toBe(true);
    expect(detail?.snapshot.totalTokens).toBe(snapshot.totalTokens);
  });
});
