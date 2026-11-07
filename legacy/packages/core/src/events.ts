import { z } from 'zod';

import { IsoDateTimeSchema, JsonObjectSchema } from './common.js';
import { IdSchema } from './ids.js';

export const LiveEventTypeSchema = z.enum([
  'session.started',
  'session.updated',
  'session.completed',
  'session.killed',
  'step.started',
  'step.completed',
  'stream.chunk',
  'tool.started',
  'tool.completed',
  'guard.triggered',
  'guard.resolved',
  'budget.warning',
  'budget.exceeded',
  'understanding.updated',
  'analysis.updated',
  'pairing.requested',
  'pairing.completed',
  'device.revoked',
]);
export type LiveEventType = z.infer<typeof LiveEventTypeSchema>;

export const LiveEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: LiveEventTypeSchema,
  sessionId: IdSchema.optional(),
  stepId: IdSchema.optional(),
  at: IsoDateTimeSchema,
  payload: JsonObjectSchema,
});
export type LiveEvent = z.infer<typeof LiveEventSchema>;

export const WebSocketClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    sessionId: IdSchema.optional(),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    sessionId: IdSchema.optional(),
  }),
  z.object({
    type: z.literal('ping'),
  }),
]);
export type WebSocketClientMessage = z.infer<typeof WebSocketClientMessageSchema>;

export const WebSocketServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('subscribed'),
    sessionId: IdSchema.optional(),
  }),
  z.object({
    type: z.literal('event'),
    event: LiveEventSchema,
  }),
  z.object({
    type: z.literal('pong'),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
]);
export type WebSocketServerMessage = z.infer<typeof WebSocketServerMessageSchema>;
