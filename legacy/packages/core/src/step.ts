import { z } from 'zod';

import {
  IsoDateTimeSchema,
  JsonObjectSchema,
  JsonValueSchema,
  NonNegativeIntSchema,
  NonNegativeNumberSchema,
} from './common.js';
import { IdSchema } from './ids.js';
import { ProviderIdSchema, ProviderProtocolSchema } from './provider.js';
import { TokenUsageSchema } from './usage.js';

export const StepKindSchema = z.enum(['model', 'tool', 'guard', 'snapshot', 'system']);
export type StepKind = z.infer<typeof StepKindSchema>;

export const StepStatusSchema = z.enum(['running', 'completed', 'failed', 'blocked', 'cancelled']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
  'cancelled',
  'unknown',
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const CapturedRequestSchema = z.object({
  protocol: ProviderProtocolSchema,
  method: z.string().trim().min(1).max(16),
  path: z.string().min(1).max(2048),
  model: z.string().max(200).optional(),
  stream: z.boolean().default(false),
  headers: z.record(z.string(), z.string()).default({}),
  body: JsonValueSchema.optional(),
  systemPrompt: z.string().max(2_000_000).optional(),
  promptText: z.string().max(2_000_000).optional(),
  redactionCount: NonNegativeIntSchema.default(0),
});
export type CapturedRequest = z.infer<typeof CapturedRequestSchema>;

export const CapturedResponseSchema = z.object({
  status: NonNegativeIntSchema,
  headers: z.record(z.string(), z.string()).default({}),
  finishReason: FinishReasonSchema.optional(),
  text: z.string().max(20_000_000).optional(),
  thinking: z.string().max(2_000_000).optional(),
  usage: TokenUsageSchema,
  ttftMs: NonNegativeIntSchema.optional(),
  latencyMs: NonNegativeIntSchema.optional(),
  error: z.string().max(100_000).optional(),
});
export type CapturedResponse = z.infer<typeof CapturedResponseSchema>;

export const CapturedStepSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  parentStepId: IdSchema.optional(),
  seq: NonNegativeIntSchema,
  kind: StepKindSchema,
  status: StepStatusSchema,
  provider: ProviderIdSchema.optional(),
  model: z.string().max(200).optional(),
  request: CapturedRequestSchema.optional(),
  response: CapturedResponseSchema.optional(),
  usage: TokenUsageSchema,
  costUsd: NonNegativeNumberSchema.optional(),
  costKnown: z.boolean().default(false),
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
  durationMs: NonNegativeIntSchema.optional(),
  error: z.string().max(100_000).optional(),
  metadata: JsonObjectSchema.optional(),
});
export type CapturedStep = z.infer<typeof CapturedStepSchema>;

export const StreamChunkKindSchema = z.enum([
  'text',
  'thinking',
  'tool_call',
  'usage',
  'event',
  'done',
]);
export type StreamChunkKind = z.infer<typeof StreamChunkKindSchema>;

export const CapturedStreamChunkSchema = z.object({
  id: IdSchema,
  stepId: IdSchema,
  seq: NonNegativeIntSchema,
  kind: StreamChunkKindSchema,
  data: z.string().max(1_000_000),
  deltaText: z.string().max(200_000).optional(),
  receivedAt: IsoDateTimeSchema,
});
export type CapturedStreamChunk = z.infer<typeof CapturedStreamChunkSchema>;

export const ToolCallStatusSchema = z.enum(['running', 'completed', 'failed', 'denied']);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolCallTraceSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  stepId: IdSchema.optional(),
  providerToolCallId: z.string().max(500).optional(),
  name: z.string().trim().min(1).max(200),
  status: ToolCallStatusSchema,
  input: JsonValueSchema.optional(),
  output: JsonValueSchema.optional(),
  error: z.string().max(100_000).optional(),
  filePaths: z.array(z.string().max(4096)).default([]),
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
});
export type ToolCallTrace = z.infer<typeof ToolCallTraceSchema>;
