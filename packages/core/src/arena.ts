import { z } from 'zod';

import { IsoDateTimeSchema, NonNegativeIntSchema, NonNegativeNumberSchema } from './common.js';
import { IdSchema } from './ids.js';
import { ProviderIdSchema } from './provider.js';

export const ArenaRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type ArenaRunStatus = z.infer<typeof ArenaRunStatusSchema>;

export const ArenaTargetSchema = z.object({
  provider: ProviderIdSchema.default('openai'),
  model: z.string().trim().min(1).max(200),
});
export type ArenaTarget = z.infer<typeof ArenaTargetSchema>;

export const ArenaRunInputSchema = z.object({
  stepId: IdSchema,
  targets: z.array(ArenaTargetSchema).min(1).max(6),
});
export type ArenaRunInput = z.infer<typeof ArenaRunInputSchema>;

export const ArenaRunSchema = z.object({
  id: IdSchema,
  sourceSessionId: IdSchema.optional(),
  sourceStepId: IdSchema.optional(),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  status: ArenaRunStatusSchema,
  outputText: z.string().max(2_000_000).optional(),
  diffText: z.string().max(2_000_000).optional(),
  inputTokens: NonNegativeIntSchema.default(0),
  outputTokens: NonNegativeIntSchema.default(0),
  costUsd: NonNegativeNumberSchema.optional(),
  costKnown: z.boolean().default(false),
  latencyMs: NonNegativeIntSchema.optional(),
  ttftMs: NonNegativeIntSchema.optional(),
  testsPassed: z.boolean().optional(),
  trustScore: z.number().int().min(0).max(100).optional(),
  baselineCostUsd: NonNegativeNumberSchema.optional(),
  savingsPercent: z.number().optional(),
  error: z.string().max(100_000).optional(),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type ArenaRun = z.infer<typeof ArenaRunSchema>;

export const ArenaRunQuerySchema = z.object({
  sessionId: IdSchema.optional(),
  stepId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ArenaRunQuery = z.infer<typeof ArenaRunQuerySchema>;

export const ArenaRunsResponseSchema = z.object({
  runs: z.array(ArenaRunSchema),
});
export type ArenaRunsResponse = z.infer<typeof ArenaRunsResponseSchema>;

export const ArenaRunResponseSchema = z.object({
  run: ArenaRunSchema,
});
export type ArenaRunResponse = z.infer<typeof ArenaRunResponseSchema>;
