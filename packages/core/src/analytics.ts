import { z } from 'zod';

import {
  DateOnlySchema,
  IsoDateTimeSchema,
  NonNegativeIntSchema,
  NonNegativeNumberSchema,
} from './common.js';
import { IdSchema } from './ids.js';

export const AnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  projectId: IdSchema.optional(),
  agent: z.string().trim().max(100).optional(),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

export const AnalyticsTotalsSchema = z.object({
  sessionCount: NonNegativeIntSchema,
  stepCount: NonNegativeIntSchema,
  toolCallCount: NonNegativeIntSchema,
  inputTokens: NonNegativeIntSchema,
  outputTokens: NonNegativeIntSchema,
  cacheReadTokens: NonNegativeIntSchema,
  cacheWriteTokens: NonNegativeIntSchema,
  totalCostUsd: NonNegativeNumberSchema,
  unknownCostCalls: NonNegativeIntSchema,
  errorCount: NonNegativeIntSchema,
});
export type AnalyticsTotals = z.infer<typeof AnalyticsTotalsSchema>;

export const AnalyticsDailyPointSchema = z.object({
  date: DateOnlySchema,
  sessionCount: NonNegativeIntSchema,
  stepCount: NonNegativeIntSchema,
  inputTokens: NonNegativeIntSchema,
  outputTokens: NonNegativeIntSchema,
  totalCostUsd: NonNegativeNumberSchema,
  errorCount: NonNegativeIntSchema,
});
export type AnalyticsDailyPoint = z.infer<typeof AnalyticsDailyPointSchema>;

export const AnalyticsModelBreakdownSchema = z.object({
  provider: z.string().max(64).optional(),
  model: z.string().max(200),
  sessionCount: NonNegativeIntSchema,
  stepCount: NonNegativeIntSchema,
  inputTokens: NonNegativeIntSchema,
  outputTokens: NonNegativeIntSchema,
  totalCostUsd: NonNegativeNumberSchema,
});
export type AnalyticsModelBreakdown = z.infer<typeof AnalyticsModelBreakdownSchema>;

export const AnalyticsAgentBreakdownSchema = z.object({
  agent: z.string().max(100),
  sessionCount: NonNegativeIntSchema,
  stepCount: NonNegativeIntSchema,
  totalCostUsd: NonNegativeNumberSchema,
});
export type AnalyticsAgentBreakdown = z.infer<typeof AnalyticsAgentBreakdownSchema>;

export const AnalyticsResponseSchema = z.object({
  range: z.object({
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    days: NonNegativeIntSchema,
  }),
  totals: AnalyticsTotalsSchema,
  daily: z.array(AnalyticsDailyPointSchema),
  models: z.array(AnalyticsModelBreakdownSchema),
  agents: z.array(AnalyticsAgentBreakdownSchema),
});
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;
