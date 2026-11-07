import { z } from 'zod';

import { DateOnlySchema, IsoDateTimeSchema } from './common.js';
import { IdSchema } from './ids.js';

export const JournalEntrySchema = z.object({
  id: IdSchema,
  projectId: IdSchema.optional(),
  weekStart: DateOnlySchema,
  title: z.string().trim().min(1).max(300),
  markdown: z.string().max(500_000),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export const JournalListQuerySchema = z.object({
  projectId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(12),
});
export type JournalListQuery = z.infer<typeof JournalListQuerySchema>;

export const JournalGenerateInputSchema = z.object({
  projectId: IdSchema.optional(),
  weekStart: DateOnlySchema.optional(),
});
export type JournalGenerateInput = z.infer<typeof JournalGenerateInputSchema>;

export const JournalEntryResponseSchema = z.object({
  entry: JournalEntrySchema,
});
export type JournalEntryResponse = z.infer<typeof JournalEntryResponseSchema>;

export const JournalEntriesResponseSchema = z.object({
  entries: z.array(JournalEntrySchema),
});
export type JournalEntriesResponse = z.infer<typeof JournalEntriesResponseSchema>;
