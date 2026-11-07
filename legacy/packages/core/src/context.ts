import { z } from 'zod';

import { IsoDateTimeSchema, NonNegativeIntSchema, NonNegativeNumberSchema } from './common.js';
import { IdSchema } from './ids.js';

export const ContextSegmentCategorySchema = z.enum([
  'system',
  'rules',
  'files',
  'history',
  'tool_output',
  'other',
]);
export type ContextSegmentCategory = z.infer<typeof ContextSegmentCategorySchema>;

export const ContextInsightTypeSchema = z.enum([
  'duplicate_instruction',
  'conflicting_instruction',
  'stale_file',
  'large_tool_output',
  'history_bloat',
  'unused_rule',
  'compaction',
]);
export type ContextInsightType = z.infer<typeof ContextInsightTypeSchema>;

export const ContextInsightSeveritySchema = z.enum(['info', 'low', 'medium', 'high']);
export type ContextInsightSeverity = z.infer<typeof ContextInsightSeveritySchema>;

export const ContextSnapshotSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  stepId: IdSchema.optional(),
  provider: z.string().max(64).optional(),
  model: z.string().max(200).optional(),
  totalTokens: NonNegativeIntSchema,
  contextWindow: NonNegativeIntSchema.optional(),
  utilizationPercent: NonNegativeNumberSchema.optional(),
  measuredAt: IsoDateTimeSchema,
});
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

export const ContextSegmentSchema = z.object({
  id: IdSchema,
  snapshotId: IdSchema,
  category: ContextSegmentCategorySchema,
  label: z.string().min(1).max(500),
  tokens: NonNegativeIntSchema,
  percent: z.number().min(0).max(100),
  sourcePath: z.string().max(4096).optional(),
  preview: z.string().max(2000).optional(),
});
export type ContextSegment = z.infer<typeof ContextSegmentSchema>;

export const ContextInsightSchema = z.object({
  id: IdSchema,
  snapshotId: IdSchema,
  type: ContextInsightTypeSchema,
  severity: ContextInsightSeveritySchema,
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(5000),
  paths: z.array(z.string().max(4096)).default([]),
  estimatedSavingsTokens: NonNegativeIntSchema.optional(),
});
export type ContextInsight = z.infer<typeof ContextInsightSchema>;

export const SessionContextResponseSchema = z.object({
  sessionId: IdSchema,
  snapshots: z.array(ContextSnapshotSchema),
  latest: ContextSnapshotSchema.nullable(),
});
export type SessionContextResponse = z.infer<typeof SessionContextResponseSchema>;

export const ContextSnapshotDetailResponseSchema = z.object({
  snapshot: ContextSnapshotSchema,
  segments: z.array(ContextSegmentSchema),
  insights: z.array(ContextInsightSchema),
});
export type ContextSnapshotDetailResponse = z.infer<typeof ContextSnapshotDetailResponseSchema>;

/**
 * Deterministic, provider-agnostic token estimate. Four characters per token is
 * deliberately conservative: it is good enough for relative context budgets and
 * never claims billing accuracy. Recorded provider usage stays authoritative.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

interface ContextWindowRule {
  readonly pattern: RegExp;
  readonly tokens: number;
}

/**
 * Bundled context-window hints. Unknown models intentionally return undefined
 * rather than guessing; the Context Doctor then reports an unknown budget.
 */
const CONTEXT_WINDOW_RULES: readonly ContextWindowRule[] = [
  { pattern: /^gpt-4\.1(?:-|$)/i, tokens: 1_047_576 },
  { pattern: /^gpt-4o(?:-|$)/i, tokens: 128_000 },
  { pattern: /^gpt-4-turbo(?:-|$)/i, tokens: 128_000 },
  { pattern: /^gpt-4(?:-|$)/i, tokens: 8_192 },
  { pattern: /^gpt-3\.5(?:-|$)/i, tokens: 16_385 },
  { pattern: /^o[134](?:-|$)/i, tokens: 200_000 },
  { pattern: /^claude-(?:opus|sonnet|haiku)-4/i, tokens: 200_000 },
  { pattern: /^claude-3[-.]7/i, tokens: 200_000 },
  { pattern: /^claude-3[-.]5/i, tokens: 200_000 },
  { pattern: /^claude-3(?:-|$)/i, tokens: 200_000 },
  { pattern: /^gemini-2\.5/i, tokens: 1_048_576 },
  { pattern: /^gemini-2\.0/i, tokens: 1_048_576 },
  { pattern: /^gemini-1\.5/i, tokens: 1_048_576 },
  { pattern: /^deepseek-(?:chat|reasoner)/i, tokens: 128_000 },
  { pattern: /^qwen/i, tokens: 131_072 },
  { pattern: /^llama/i, tokens: 131_072 },
  { pattern: /^mistral|^mixtral/i, tokens: 131_072 },
];

export function resolveContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const normalized = model.trim();
  if (normalized.length === 0) return undefined;
  for (const rule of CONTEXT_WINDOW_RULES) {
    if (rule.pattern.test(normalized)) return rule.tokens;
  }
  return undefined;
}
