import { z } from 'zod';

export const IdSchema = z.string().uuid();
export type Id = z.infer<typeof IdSchema>;

export function createId(): Id {
  return globalThis.crypto.randomUUID();
}

export const SessionIdSchema = IdSchema;
export type SessionId = Id;
export const StepIdSchema = IdSchema;
export type StepId = Id;
export const ProjectIdSchema = IdSchema;
export type ProjectId = Id;
