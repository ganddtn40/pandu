import { describe, expect, it } from 'vitest';

import {
  computeCostFromPrice,
  estimateUsageCost,
  formatUsd,
  normalizeModelId,
  resolveModelPricing,
  type TokenUsage,
} from '../src/index.js';

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...overrides,
});

describe('normalizeModelId', () => {
  it('normalizes provider prefixes, dated snapshots, and local latest tags', () => {
    expect(normalizeModelId('openai/gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(normalizeModelId('anthropic/claude-sonnet-4-20250514')).toBe('claude-sonnet-4');
    expect(normalizeModelId('  Llama3.2:latest ')).toBe('llama3.2');
  });
});

describe('resolveModelPricing', () => {
  it('resolves known models with or without a provider hint', () => {
    const hinted = resolveModelPricing({ model: 'gpt-4.1' });
    expect(hinted.found).toBe(true);

    const known = resolveModelPricing({ model: 'gpt-4.1', provider: 'openai' });
    expect(known.found).toBe(true);
    if (known.found) {
      expect(known.pricing.outputPerMTok).toBe(8);
      expect(known.source).toBe('builtin');
    }
  });

  it('never invents a price for an unknown model', () => {
    const result = resolveModelPricing({ model: 'mystery-model', provider: 'openai' });
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe('model_not_found');
    }
  });

  it('lets overrides win over bundled rates', () => {
    const result = resolveModelPricing({
      model: 'gpt-4.1',
      provider: 'openai',
      overrides: [
        {
          provider: 'openai',
          model: 'gpt-4.1',
          aliases: [],
          inputPerMTok: 100,
          outputPerMTok: 200,
          currency: 'USD',
          source: 'test override',
        },
      ],
    });

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.source).toBe('override');
      expect(result.pricing.inputPerMTok).toBe(100);
    }
  });
});

describe('cost math', () => {
  const pricing = {
    provider: 'openai',
    model: 'gpt-4.1',
    aliases: [],
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.5,
    currency: 'USD' as const,
    source: 'test',
  };

  it('accounts for input, output, and cache reads separately', () => {
    const result = computeCostFromPrice(
      usage({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000 }),
      pricing,
    );

    expect(result.usd).toBe(7);
    expect(result.breakdown.inputUsd).toBe(2);
    expect(result.breakdown.outputUsd).toBe(4);
    expect(result.breakdown.cacheReadUsd).toBe(1);
    expect(result.breakdown.cacheWriteUsd).toBe(0);
  });

  it('uses the input rate for cache reads when no cache price is declared', () => {
    const { cacheReadPerMTok: _cacheReadPerMTok, ...withoutCachePrice } = pricing;
    const result = computeCostFromPrice(usage({ cacheReadTokens: 1_000_000 }), withoutCachePrice);
    expect(result.usd).toBe(2);
  });

  it('returns an unpriced result instead of zero for unknown models', () => {
    const result = estimateUsageCost(usage({ inputTokens: 1000 }), 'not-a-model', 'openai');
    expect(result.known).toBe(false);
    expect(result.usd).toBeNull();
  });

  it('prices zero-cost local usage correctly when an override declares zero', () => {
    const result = estimateUsageCost(usage({ inputTokens: 1_000_000 }), 'local-coder', 'ollama', [
      {
        provider: 'ollama',
        model: 'local-coder',
        aliases: [],
        inputPerMTok: 0,
        outputPerMTok: 0,
        currency: 'USD',
        source: 'local runtime',
      },
    ]);
    expect(result.known).toBe(true);
    expect(result.usd).toBe(0);
  });

  it('formats prices without hiding small values', () => {
    expect(formatUsd(null)).toBe('Unpriced');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.00042)).toBe('$0.0004');
    expect(formatUsd(0.42)).toBe('$0.420');
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});
