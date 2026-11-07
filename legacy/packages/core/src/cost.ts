import { z } from 'zod';

import { NonNegativeNumberSchema } from './common.js';
import { ProviderIdSchema } from './provider.js';
import type { TokenUsage } from './usage.js';

export const ModelPricingSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  inputPerMTok: NonNegativeNumberSchema,
  outputPerMTok: NonNegativeNumberSchema,
  cacheReadPerMTok: NonNegativeNumberSchema.optional(),
  cacheWritePerMTok: NonNegativeNumberSchema.optional(),
  currency: z.literal('USD').default('USD'),
  source: z.string().trim().min(1).max(1000),
  reviewedAt: z.string().date().optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

/**
 * Bundled rates are estimates, not a billing authority. They were reviewed
 * against public list prices in June 2025. Providers change prices and custom
 * endpoints add markups, so unknown models deliberately resolve to "unknown"
 * instead of silently costing $0. A user-supplied override always wins.
 */
export const BUILT_IN_PRICING: readonly ModelPricing[] = [
  {
    provider: 'openai',
    model: 'gpt-4.1',
    displayName: 'GPT-4.1',
    aliases: [],
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.5,
    currency: 'USD',
    source: 'https://openai.com/api/pricing/',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    aliases: [],
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    cacheReadPerMTok: 0.1,
    currency: 'USD',
    source: 'https://openai.com/api/pricing/',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 nano',
    aliases: [],
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cacheReadPerMTok: 0.025,
    currency: 'USD',
    source: 'https://openai.com/api/pricing/',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    displayName: 'GPT-4o',
    aliases: [],
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 1.25,
    currency: 'USD',
    source: 'https://openai.com/api/pricing/',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    aliases: [],
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0.075,
    currency: 'USD',
    source: 'https://openai.com/api/pricing/',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'openai',
    model: 'o3',
    displayName: 'o3',
    aliases: [],
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.5,
    currency: 'USD',
    source: 'https://openai.com/api/pricing/',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'openai',
    model: 'o4-mini',
    displayName: 'o4-mini',
    aliases: [],
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.275,
    currency: 'USD',
    source: 'https://openai.com/api/pricing/',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4',
    displayName: 'Claude Opus 4',
    aliases: [],
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
    currency: 'USD',
    source: 'https://www.anthropic.com/pricing',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    aliases: [],
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    currency: 'USD',
    source: 'https://www.anthropic.com/pricing',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    displayName: 'Claude 3.7 Sonnet',
    aliases: [],
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    currency: 'USD',
    source: 'https://www.anthropic.com/pricing',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    aliases: [],
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    currency: 'USD',
    source: 'https://www.anthropic.com/pricing',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku',
    displayName: 'Claude 3.5 Haiku',
    aliases: [],
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1,
    currency: 'USD',
    source: 'https://www.anthropic.com/pricing',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'deepseek',
    model: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    aliases: ['deepseek-v3'],
    inputPerMTok: 0.27,
    outputPerMTok: 1.1,
    cacheReadPerMTok: 0.07,
    currency: 'USD',
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    reviewedAt: '2025-06-01',
  },
  {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    aliases: ['deepseek-r1'],
    inputPerMTok: 0.55,
    outputPerMTok: 2.19,
    cacheReadPerMTok: 0.14,
    currency: 'USD',
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    reviewedAt: '2025-06-01',
  },
];

const DATE_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;
const PROVIDER_PREFIX = /^[a-z0-9][a-z0-9._-]*\//;

export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(PROVIDER_PREFIX, '')
    .replace(/:latest$/, '')
    .replace(DATE_SUFFIX, '');
}

export interface ResolvePricingInput {
  model: string;
  provider?: string;
  overrides?: readonly ModelPricing[];
}

export type PricingResolution =
  | {
      found: true;
      pricing: ModelPricing;
      normalizedModel: string;
      source: 'override' | 'builtin';
    }
  | {
      found: false;
      normalizedModel: string;
      reason: 'model_not_found' | 'ambiguous_provider';
    };

function findWithin(
  entries: readonly ModelPricing[],
  normalizedModel: string,
  provider: string | undefined,
): ModelPricing[] {
  return entries.filter((entry) => {
    if (provider && entry.provider !== provider) {
      return false;
    }
    const candidates = [normalizeModelId(entry.model), ...entry.aliases.map(normalizeModelId)];
    return candidates.includes(normalizedModel);
  });
}

export function resolveModelPricing(input: ResolvePricingInput): PricingResolution {
  const normalizedModel = normalizeModelId(input.model);
  const provider = input.provider?.trim().toLowerCase() || undefined;
  const overrideMatches = findWithin(input.overrides ?? [], normalizedModel, provider);

  if (overrideMatches.length === 1) {
    const match = overrideMatches[0];
    if (match) {
      return { found: true, pricing: match, normalizedModel, source: 'override' };
    }
  }
  if (overrideMatches.length > 1) {
    return { found: false, normalizedModel, reason: 'ambiguous_provider' };
  }

  const builtInMatches = findWithin(BUILT_IN_PRICING, normalizedModel, provider);
  if (builtInMatches.length === 1) {
    const match = builtInMatches[0];
    if (match) {
      return { found: true, pricing: match, normalizedModel, source: 'builtin' };
    }
  }
  if (builtInMatches.length > 1) {
    return { found: false, normalizedModel, reason: 'ambiguous_provider' };
  }

  return { found: false, normalizedModel, reason: 'model_not_found' };
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
}

export interface CostEstimate {
  usd: number;
  known: true;
  breakdown: CostBreakdown;
  pricing: ModelPricing;
}

export interface UnpricedUsage {
  usd: null;
  known: false;
  reason: 'model_not_found' | 'ambiguous_provider';
  normalizedModel: string;
}

export type UsageCost = CostEstimate | UnpricedUsage;

function perMillion(tokens: number, rate: number): number {
  return (tokens / 1_000_000) * rate;
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function computeCostFromPrice(usage: TokenUsage, pricing: ModelPricing): CostEstimate {
  const cacheReadRate = pricing.cacheReadPerMTok ?? pricing.inputPerMTok;
  const cacheWriteRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;
  const breakdown: CostBreakdown = {
    inputUsd: perMillion(usage.inputTokens, pricing.inputPerMTok),
    outputUsd: perMillion(usage.outputTokens, pricing.outputPerMTok),
    cacheReadUsd: perMillion(usage.cacheReadTokens, cacheReadRate),
    cacheWriteUsd: perMillion(usage.cacheWriteTokens, cacheWriteRate),
  };
  const usd =
    breakdown.inputUsd + breakdown.outputUsd + breakdown.cacheReadUsd + breakdown.cacheWriteUsd;

  return {
    usd: roundUsd(usd),
    known: true,
    breakdown,
    pricing,
  };
}

export function estimateUsageCost(
  usage: TokenUsage,
  model: string,
  provider?: string,
  overrides: readonly ModelPricing[] = [],
): UsageCost {
  const resolution = resolveModelPricing({
    model,
    ...(provider === undefined ? {} : { provider }),
    overrides,
  });

  if (!resolution.found) {
    return {
      usd: null,
      known: false,
      reason: resolution.reason,
      normalizedModel: resolution.normalizedModel,
    };
  }

  return computeCostFromPrice(usage, resolution.pricing);
}

export function formatUsd(value: number | null): string {
  if (value === null) {
    return 'Unpriced';
  }
  if (value === 0) {
    return '$0.00';
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (value < 1) {
    return `$${value.toFixed(3)}`;
  }
  return `$${value.toFixed(2)}`;
}
