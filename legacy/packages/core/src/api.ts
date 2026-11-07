import { z } from 'zod';

import { IsoDateTimeSchema, NonNegativeIntSchema, NonNegativeNumberSchema } from './common.js';
import { SessionSchema } from './session.js';
import { CapturedStepSchema, CapturedStreamChunkSchema, ToolCallTraceSchema } from './step.js';

export const ApiErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'provider_error',
  'guard_blocked',
  'budget_exceeded',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal('cockpit-daemon'),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  database: z.enum(['ok', 'degraded']),
  demoMode: z.boolean(),
  protocol: z.object({
    openai: z.boolean(),
    anthropic: z.boolean(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const DiscoverResponseSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      protocol: z.enum(['openai', 'anthropic']),
      baseUrl: z.string().url(),
    }),
  ),
});
export type DiscoverResponse = z.infer<typeof DiscoverResponseSchema>;

export const SessionResponseSchema = z.object({
  session: SessionSchema,
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSchema),
  nextCursor: z.string().nullable(),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export const OverviewStatsSchema = z.object({
  sessionCount: NonNegativeIntSchema,
  activeSessionCount: NonNegativeIntSchema,
  stepCount: NonNegativeIntSchema,
  toolCallCount: NonNegativeIntSchema,
  inputTokens: NonNegativeIntSchema,
  outputTokens: NonNegativeIntSchema,
  cacheReadTokens: NonNegativeIntSchema,
  cacheWriteTokens: NonNegativeIntSchema,
  totalCostUsd: NonNegativeNumberSchema,
  unknownCostCalls: NonNegativeIntSchema,
  errorCount: NonNegativeIntSchema,
  lastSessionAt: IsoDateTimeSchema.optional(),
});
export type OverviewStats = z.infer<typeof OverviewStatsSchema>;

export const StatsResponseSchema = z.object({
  stats: OverviewStatsSchema,
});
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const SessionStepsResponseSchema = z.object({
  steps: z.array(CapturedStepSchema),
});
export type SessionStepsResponse = z.infer<typeof SessionStepsResponseSchema>;

export const StepDetailResponseSchema = z.object({
  step: CapturedStepSchema,
  chunks: z.array(CapturedStreamChunkSchema),
  toolCalls: z.array(ToolCallTraceSchema),
});
export type StepDetailResponse = z.infer<typeof StepDetailResponseSchema>;
