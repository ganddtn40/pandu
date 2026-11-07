import { z } from 'zod';

import { isRecord, NonNegativeIntSchema } from './common.js';
import type { ProviderProtocol } from './provider.js';

/**
 * Canonical token accounting.
 *
 * `inputTokens` is uncached input only. Cache reads and cache writes are kept
 * separate because providers charge for them at different rates. Reasoning
 * tokens are a subset of `outputTokens` and are tracked for analytics, never
 * added to the output total a second time.
 */
export const TokenUsageSchema = z.object({
  inputTokens: NonNegativeIntSchema.default(0),
  outputTokens: NonNegativeIntSchema.default(0),
  cacheReadTokens: NonNegativeIntSchema.default(0),
  cacheWriteTokens: NonNegativeIntSchema.default(0),
  reasoningTokens: NonNegativeIntSchema.default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

export interface UsageTiming {
  latencyMs?: number;
  ttftMs?: number;
}

export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function totalTokens(usage: TokenUsage): number {
  return totalInputTokens(usage) + usage.outputTokens;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

function readObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/**
 * Convert OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages
 * usage payloads into the canonical shape.
 *
 * OpenAI reports cached tokens inside its input count, while Anthropic reports
 * cache reads and writes separately. We detect the shape and subtract only for
 * OpenAI so tokens are never double counted.
 */
export function normalizeUsage(raw: unknown, protocol?: ProviderProtocol): TokenUsage {
  if (!isRecord(raw)) {
    return { ...ZERO_USAGE };
  }

  if (typeof raw['prompt_tokens'] === 'number' || typeof raw['completion_tokens'] === 'number') {
    const prompt = readNumber(raw, 'prompt_tokens');
    const completion = readNumber(raw, 'completion_tokens');
    const promptDetails = readObject(raw, 'prompt_tokens_details');
    const completionDetails = readObject(raw, 'completion_tokens_details');
    const cached = promptDetails ? readNumber(promptDetails, 'cached_tokens') : 0;

    return {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: completion,
      cacheReadTokens: Math.min(cached, prompt),
      cacheWriteTokens: 0,
      reasoningTokens: completionDetails ? readNumber(completionDetails, 'reasoning_tokens') : 0,
    };
  }

  if (typeof raw['input_tokens'] === 'number' || typeof raw['output_tokens'] === 'number') {
    const input = readNumber(raw, 'input_tokens');
    const output = readNumber(raw, 'output_tokens');
    const cacheRead =
      readNumber(raw, 'cache_read_input_tokens') || readNumber(raw, 'cache_read_tokens');
    const cacheWrite =
      readNumber(raw, 'cache_creation_input_tokens') || readNumber(raw, 'cache_write_tokens');
    const inputDetails = readObject(raw, 'input_tokens_details');
    const outputDetails = readObject(raw, 'output_tokens_details');
    const openAiCached = inputDetails ? readNumber(inputDetails, 'cached_tokens') : 0;

    if (protocol === 'anthropic' || cacheRead > 0 || cacheWrite > 0) {
      return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: 0,
      };
    }

    return {
      inputTokens: Math.max(0, input - openAiCached),
      outputTokens: output,
      cacheReadTokens: openAiCached,
      cacheWriteTokens: 0,
      reasoningTokens: outputDetails ? readNumber(outputDetails, 'reasoning_tokens') : 0,
    };
  }

  return { ...ZERO_USAGE };
}
