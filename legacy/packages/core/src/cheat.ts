import { z } from 'zod';

import { IsoDateTimeSchema } from './common.js';
import { IdSchema } from './ids.js';

export const CheatCategorySchema = z.enum([
  'deleted_test',
  'skipped_test',
  'weakened_test',
  'empty_catch',
  'hardcoded_expectation',
  'mock_replacement',
  'suppression',
  'stub_presented_as_done',
]);
export type CheatCategory = z.infer<typeof CheatCategorySchema>;

export const CheatSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type CheatSeverity = z.infer<typeof CheatSeveritySchema>;

export const CheatEvidenceSchema = z.object({
  filePath: z.string().trim().min(1).max(4096),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  excerpt: z.string().max(20_000),
  explanation: z.string().max(5000).optional(),
});
export type CheatEvidence = z.infer<typeof CheatEvidenceSchema>;

export const CheatFindingSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  stepId: IdSchema.optional(),
  category: CheatCategorySchema,
  severity: CheatSeveritySchema,
  title: z.string().trim().min(1).max(300),
  detail: z.string().max(5000),
  detector: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1).default(1),
  evidence: z.array(CheatEvidenceSchema).min(1).max(20),
  suggestion: z.string().max(5000).optional(),
  createdAt: IsoDateTimeSchema,
});
export type CheatFinding = z.infer<typeof CheatFindingSchema>;

export const TrustGradeSchema = z.enum(['A', 'B', 'C', 'D', 'F']);
export type TrustGrade = z.infer<typeof TrustGradeSchema>;

export const CheatAnalysisSchema = z.object({
  sessionId: IdSchema,
  trustScore: z.number().int().min(0).max(100),
  grade: TrustGradeSchema,
  findings: z.array(CheatFindingSchema),
  filesExamined: z.number().int().nonnegative(),
  generatedAt: IsoDateTimeSchema,
});
export type CheatAnalysis = z.infer<typeof CheatAnalysisSchema>;

export const TrustResponseSchema = z.object({
  analysis: CheatAnalysisSchema.nullable(),
});
export type TrustResponse = z.infer<typeof TrustResponseSchema>;
