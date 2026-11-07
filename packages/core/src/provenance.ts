import { z } from 'zod';

import { IsoDateTimeSchema, NonNegativeIntSchema } from './common.js';
import { IdSchema } from './ids.js';

export const ContentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest.');

export const ProvenanceEntrySchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    sessionId: IdSchema.optional(),
    stepId: IdSchema.optional(),
    filePath: z.string().trim().min(1).max(4096),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    commitSha: z.string().max(100).optional(),
    contentHash: ContentHashSchema,
    provider: z.string().max(64).optional(),
    model: z.string().max(200).optional(),
    promptExcerpt: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1),
    capturedAt: IsoDateTimeSchema,
  })
  .refine((entry) => entry.lineEnd >= entry.lineStart, {
    message: 'lineEnd must be greater than or equal to lineStart.',
    path: ['lineEnd'],
  });
export type ProvenanceEntry = z.infer<typeof ProvenanceEntrySchema>;

export const ProvenanceFileSchema = z.object({
  path: z.string().min(1).max(4096),
  aiLines: NonNegativeIntSchema,
  lineRanges: NonNegativeIntSchema,
  entries: NonNegativeIntSchema,
  providers: z.array(z.string().min(1).max(64)).default([]),
  models: z.array(z.string().min(1).max(200)).default([]),
  lastCapturedAt: IsoDateTimeSchema,
});
export type ProvenanceFile = z.infer<typeof ProvenanceFileSchema>;

export const ProvenanceTotalsSchema = z.object({
  entries: NonNegativeIntSchema,
  files: NonNegativeIntSchema,
  aiLines: NonNegativeIntSchema,
  steps: NonNegativeIntSchema,
});
export type ProvenanceTotals = z.infer<typeof ProvenanceTotalsSchema>;

export const SessionProvenanceResponseSchema = z.object({
  sessionId: IdSchema,
  projectId: IdSchema.optional(),
  entries: z.array(ProvenanceEntrySchema),
  files: z.array(ProvenanceFileSchema),
  totals: ProvenanceTotalsSchema,
});
export type SessionProvenanceResponse = z.infer<typeof SessionProvenanceResponseSchema>;
