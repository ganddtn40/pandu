import { describe, expect, it } from 'vitest';

import {
  ContextSnapshotDetailResponseSchema,
  SessionContextResponseSchema,
  estimateJsonTokens,
  estimateTokens,
  resolveContextWindow,
} from '../src/index.js';
import { createId } from '../src/ids.js';

describe('estimateTokens', () => {
  it('uses four characters per token and rounds up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('estimates JSON payloads deterministically', () => {
    const value = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] };
    const serialized = JSON.stringify(value);
    expect(estimateJsonTokens(value)).toBe(Math.ceil(serialized.length / 4));
    expect(estimateJsonTokens(value)).toBe(estimateJsonTokens(value));
  });

  it('returns zero for values JSON cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(estimateJsonTokens(circular)).toBe(0);
  });
});

describe('resolveContextWindow', () => {
  it('resolves bundled model families', () => {
    expect(resolveContextWindow('gpt-4.1')).toBe(1_047_576);
    expect(resolveContextWindow('gpt-4.1-mini')).toBe(1_047_576);
    expect(resolveContextWindow('gpt-4o-mini')).toBe(128_000);
    expect(resolveContextWindow('claude-sonnet-4-20250514')).toBe(200_000);
    expect(resolveContextWindow('gemini-2.5-pro')).toBe(1_048_576);
    expect(resolveContextWindow('deepseek-chat')).toBe(128_000);
    expect(resolveContextWindow('qwen3-coder')).toBe(131_072);
  });

  it('leaves unknown or empty models unknown', () => {
    expect(resolveContextWindow(undefined)).toBeUndefined();
    expect(resolveContextWindow('')).toBeUndefined();
    expect(resolveContextWindow('mystery-model-9')).toBeUndefined();
    expect(resolveContextWindow('   ')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(resolveContextWindow('GPT-4O-MINI')).toBe(128_000);
    expect(resolveContextWindow('Claude-3.5-Sonnet')).toBe(200_000);
  });
});

describe('context response schemas', () => {
  it('accepts a nullable latest snapshot and validates percentages', () => {
    const sessionId = createId();
    expect(SessionContextResponseSchema.parse({ sessionId, snapshots: [], latest: null })).toEqual({
      sessionId,
      snapshots: [],
      latest: null,
    });

    const snapshot = {
      id: createId(),
      sessionId,
      stepId: createId(),
      provider: 'openai',
      model: 'gpt-4o-mini',
      totalTokens: 3200,
      contextWindow: 128_000,
      utilizationPercent: 2.5,
      measuredAt: '2026-04-05T06:07:00.000Z',
    };
    expect(
      ContextSnapshotDetailResponseSchema.parse({
        snapshot,
        segments: [
          {
            id: createId(),
            snapshotId: snapshot.id,
            category: 'history',
            label: 'User message 1',
            tokens: 3200,
            percent: 100,
            preview: 'Fix the retry loop.',
          },
        ],
        insights: [],
      }).segments,
    ).toHaveLength(1);

    expect(() =>
      ContextSnapshotDetailResponseSchema.parse({
        snapshot: { ...snapshot, utilizationPercent: -1 },
        segments: [],
        insights: [],
      }),
    ).toThrow();
  });
});
