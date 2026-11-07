import { z } from 'zod';

import { JsonObjectSchema, NonNegativeIntSchema, NonNegativeNumberSchema } from './common.js';
import { IdSchema } from './ids.js';
import {
  AgentInfoSchema,
  ModelRefSchema,
  ProviderIdSchema,
  ProviderProtocolSchema,
} from './provider.js';

export const SessionStatusSchema = z.enum(['active', 'completed', 'failed', 'killed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSourceSchema = z.enum(['proxy', 'demo', 'manual']);
export type SessionSource = z.infer<typeof SessionSourceSchema>;

export const SessionTotalsSchema = z.object({
  stepCount: NonNegativeIntSchema.default(0),
  modelCallCount: NonNegativeIntSchema.default(0),
  toolCallCount: NonNegativeIntSchema.default(0),
  inputTokens: NonNegativeIntSchema.default(0),
  outputTokens: NonNegativeIntSchema.default(0),
  cacheReadTokens: NonNegativeIntSchema.default(0),
  cacheWriteTokens: NonNegativeIntSchema.default(0),
  reasoningTokens: NonNegativeIntSchema.default(0),
  totalCostUsd: NonNegativeNumberSchema.default(0),
  unknownCostCalls: NonNegativeIntSchema.default(0),
  errorCount: NonNegativeIntSchema.default(0),
});
export type SessionTotals = z.infer<typeof SessionTotalsSchema>;

export const SessionSchema = z.object({
  id: IdSchema,
  projectId: IdSchema.optional(),
  title: z.string().trim().min(1).max(200),
  source: SessionSourceSchema.default('proxy'),
  status: SessionStatusSchema.default('active'),
  agent: AgentInfoSchema.optional(),
  modelRef: ModelRefSchema.optional(),
  workspacePath: z.string().min(1).max(4096).optional(),
  gitBranch: z.string().max(500).optional(),
  gitBaseCommit: z.string().max(100).optional(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).optional(),
  durationMs: NonNegativeIntSchema.optional(),
  totals: SessionTotalsSchema,
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  metadata: JsonObjectSchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionInputSchema = z.object({
  projectId: IdSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  provider: ProviderIdSchema.optional(),
  protocol: ProviderProtocolSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  agent: AgentInfoSchema.optional(),
  workspacePath: z.string().max(4096).optional(),
  gitBranch: z.string().max(500).optional(),
  gitBaseCommit: z.string().max(100).optional(),
  source: SessionSourceSchema.default('proxy'),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const SessionListQuerySchema = z.object({
  projectId: IdSchema.optional(),
  status: SessionStatusSchema.optional(),
  agent: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;
