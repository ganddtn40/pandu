import { z } from 'zod';

import { IsoDateTimeSchema } from './common.js';
import { IdSchema } from './ids.js';

export const HandoffBriefSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  title: z.string().trim().min(1).max(300),
  contentMarkdown: z.string().max(500_000),
  generatedAt: IsoDateTimeSchema,
  model: z.string().max(200).optional(),
});
export type HandoffBrief = z.infer<typeof HandoffBriefSchema>;

export const HandoffGenerateInputSchema = z.object({
  stepId: IdSchema.optional(),
});
export type HandoffGenerateInput = z.infer<typeof HandoffGenerateInputSchema>;

export const HandoffBriefResponseSchema = z.object({
  brief: HandoffBriefSchema,
});
export type HandoffBriefResponse = z.infer<typeof HandoffBriefResponseSchema>;

export const HandoffBriefsResponseSchema = z.object({
  briefs: z.array(HandoffBriefSchema),
});
export type HandoffBriefsResponse = z.infer<typeof HandoffBriefsResponseSchema>;
