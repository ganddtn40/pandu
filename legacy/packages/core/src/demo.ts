import { z } from 'zod';

import { IsoDateTimeSchema, NonNegativeIntSchema } from './common.js';
import { IdSchema } from './ids.js';
import { SessionSourceSchema, SessionStatusSchema } from './session.js';

/** Bump this when the demo story or seeded entities change materially. */
export const DEMO_SEED_VERSION = '1';

export const DemoSessionSummarySchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1).max(200),
  status: SessionStatusSchema,
  source: SessionSourceSchema,
  startedAt: IsoDateTimeSchema,
});
export type DemoSessionSummary = z.infer<typeof DemoSessionSummarySchema>;

export const DemoSeedResponseSchema = z.object({
  created: z.boolean(),
  seedVersion: z.string().min(1).max(50),
  sessionId: IdSchema,
  workspacePath: z.string().min(1).max(4096),
  sessions: z.array(DemoSessionSummarySchema).min(1).max(20),
  totals: z.object({
    steps: NonNegativeIntSchema,
    toolCalls: NonNegativeIntSchema,
    guardEvents: NonNegativeIntSchema,
  }),
});
export type DemoSeedResponse = z.infer<typeof DemoSeedResponseSchema>;
