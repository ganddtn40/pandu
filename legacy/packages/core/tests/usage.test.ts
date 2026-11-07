import { describe, expect, it } from 'vitest';

import { addUsage, normalizeUsage, totalInputTokens, totalTokens } from '../src/index.js';

describe('normalizeUsage', () => {
  it('normalizes OpenAI chat completions usage without double-counting cache', () => {
    const result = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 50 },
    });

    expect(result).toEqual({
      inputTokens: 600,
      outputTokens: 200,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      reasoningTokens: 50,
    });
  });

  it('normalizes OpenAI Responses usage', () => {
    const result = normalizeUsage({
      input_tokens: 2000,
      output_tokens: 300,
      input_tokens_details: { cached_tokens: 500 },
      output_tokens_details: { reasoning_tokens: 120 },
    });

    expect(result.inputTokens).toBe(1500);
    expect(result.cacheReadTokens).toBe(500);
    expect(result.outputTokens).toBe(300);
    expect(result.reasoningTokens).toBe(120);
  });

  it('normalizes Anthropic usage including cache writes', () => {
    const result = normalizeUsage(
      {
        input_tokens: 100,
        output_tokens: 250,
        cache_creation_input_tokens: 800,
        cache_read_input_tokens: 1200,
      },
      'anthropic',
    );

    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 250,
      cacheReadTokens: 1200,
      cacheWriteTokens: 800,
      reasoningTokens: 0,
    });
  });

  it('returns zeroed usage for malformed data', () => {
    expect(normalizeUsage(null).inputTokens).toBe(0);
    expect(normalizeUsage('garbage').outputTokens).toBe(0);
    expect(normalizeUsage({ input_tokens: -2 }).outputTokens).toBe(0);
  });

  it('adds usage and totals correctly', () => {
    const total = addUsage(
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        reasoningTokens: 4,
      },
      {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        reasoningTokens: 5,
      },
    );

    expect(total.inputTokens).toBe(11);
    expect(totalTokens(total)).toBe(48);
    expect(totalInputTokens(total)).toBe(26);
  });
});
