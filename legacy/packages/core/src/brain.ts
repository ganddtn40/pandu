import { z } from 'zod';

import { IsoDateTimeSchema } from './common.js';
import { IdSchema } from './ids.js';
import { ContentHashSchema } from './provenance.js';
import { ProjectSchema } from './project.js';

export const BRAIN_FORMATS = [
  'agents_md',
  'claude_md',
  'cursorrules',
  'gemini_md',
  'copilot_instructions',
] as const;

export const BrainFormatSchema = z.enum(BRAIN_FORMATS);
export type BrainFormat = z.infer<typeof BrainFormatSchema>;

export const BRAIN_FORMAT_LABELS: Readonly<Record<BrainFormat, string>> = {
  agents_md: 'AGENTS.md',
  claude_md: 'CLAUDE.md',
  cursorrules: '.cursorrules',
  gemini_md: 'GEMINI.md',
  copilot_instructions: 'Copilot instructions',
};

/**
 * Generated files are always written relative to the project root. Keeping the
 * mapping in core lets the daemon, CLI, and dashboard agree on one list.
 */
export const BRAIN_FORMAT_PATHS: Readonly<Record<BrainFormat, string>> = {
  agents_md: 'AGENTS.md',
  claude_md: 'CLAUDE.md',
  cursorrules: '.cursorrules',
  gemini_md: 'GEMINI.md',
  copilot_instructions: '.github/copilot-instructions.md',
};

export const BrainSourceSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  path: z.string().trim().min(1).max(4096),
  content: z.string().max(2_000_000),
  checksum: ContentHashSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type BrainSource = z.infer<typeof BrainSourceSchema>;

export const BrainSourceSummarySchema = BrainSourceSchema.pick({
  id: true,
  path: true,
  checksum: true,
  updatedAt: true,
});
export type BrainSourceSummary = z.infer<typeof BrainSourceSummarySchema>;

export const BrainOutputSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  format: BrainFormatSchema,
  path: z.string().trim().min(1).max(4096),
  content: z.string().max(2_000_000),
  checksum: ContentHashSchema,
  sourceChecksum: ContentHashSchema,
  syncedAt: IsoDateTimeSchema.optional(),
  driftDetected: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type BrainOutput = z.infer<typeof BrainOutputSchema>;

export const BrainOutputViewSchema = BrainOutputSchema.extend({
  existsOnDisk: z.boolean(),
  diskChecksum: ContentHashSchema.optional(),
  drifted: z.boolean(),
});
export type BrainOutputView = z.infer<typeof BrainOutputViewSchema>;

export const BrainDriftEventSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  outputId: IdSchema,
  detectedAt: IsoDateTimeSchema,
  expectedChecksum: ContentHashSchema,
  actualChecksum: ContentHashSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
});
export type BrainDriftEvent = z.infer<typeof BrainDriftEventSchema>;

export const BrainProjectStatusSchema = z.object({
  project: ProjectSchema,
  sources: z.array(BrainSourceSummarySchema),
  outputs: z.array(BrainOutputViewSchema),
  drift: z.array(BrainDriftEventSchema),
});
export type BrainProjectStatus = z.infer<typeof BrainProjectStatusSchema>;

export const BrainGenerateInputSchema = z.object({
  formats: z.array(BrainFormatSchema).min(1).max(BRAIN_FORMATS.length).optional(),
});
export type BrainGenerateInput = z.infer<typeof BrainGenerateInputSchema>;

export const BrainSyncInputSchema = z.object({
  formats: z.array(BrainFormatSchema).min(1).max(BRAIN_FORMATS.length).optional(),
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
export type BrainSyncInput = z.infer<typeof BrainSyncInputSchema>;

export const BrainSyncActionSchema = z.enum(['written', 'unchanged', 'drift', 'missing']);
export type BrainSyncAction = z.infer<typeof BrainSyncActionSchema>;

export const BrainSyncResultSchema = z.object({
  format: BrainFormatSchema,
  path: z.string().min(1).max(4096),
  action: BrainSyncActionSchema,
  checksum: ContentHashSchema.optional(),
  message: z.string().max(2000).optional(),
});
export type BrainSyncResult = z.infer<typeof BrainSyncResultSchema>;

export const BrainSyncResponseSchema = z.object({
  results: z.array(BrainSyncResultSchema),
  status: BrainProjectStatusSchema,
});
export type BrainSyncResponse = z.infer<typeof BrainSyncResponseSchema>;
