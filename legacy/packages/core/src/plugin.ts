import { z } from 'zod';

import { IsoDateTimeSchema, JsonObjectSchema, JsonValueSchema } from './common.js';
import { IdSchema } from './ids.js';

export const PluginKindSchema = z.enum(['guard', 'analyzer']);
export type PluginKind = z.infer<typeof PluginKindSchema>;

export const PluginManifestSchema = z.object({
  apiVersion: z.literal(1).default(1),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/,
      'Plugin names may contain lowercase letters, numbers, dots, underscores, and dashes.',
    ),
  version: z.string().trim().min(1).max(50),
  description: z.string().max(2000).optional(),
  kind: PluginKindSchema,
  entry: z.string().trim().min(1).max(500),
  permissions: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(100),
  version: z.string().trim().min(1).max(50),
  description: z.string().max(2000).optional(),
  manifest: JsonObjectSchema,
  path: z.string().min(1).max(4096),
  enabled: z.boolean().default(true),
  installedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Plugin = z.infer<typeof PluginSchema>;

export const PluginInstallInputSchema = z.object({
  path: z.string().trim().min(1).max(4096),
});
export type PluginInstallInput = z.infer<typeof PluginInstallInputSchema>;

export const PluginPatchSchema = z.object({
  enabled: z.boolean(),
});
export type PluginPatch = z.infer<typeof PluginPatchSchema>;

export const PluginRunInputSchema = z.object({
  sessionId: IdSchema,
  stepId: IdSchema.optional(),
});
export type PluginRunInput = z.infer<typeof PluginRunInputSchema>;

export const PluginRunStatusSchema = z.enum(['ok', 'error', 'timeout']);
export type PluginRunStatus = z.infer<typeof PluginRunStatusSchema>;

export const PluginRunSchema = z.object({
  id: IdSchema,
  pluginId: IdSchema,
  sessionId: IdSchema.optional(),
  kind: PluginKindSchema,
  status: PluginRunStatusSchema,
  result: JsonValueSchema.optional(),
  error: z.string().max(100_000).optional(),
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
});
export type PluginRun = z.infer<typeof PluginRunSchema>;

export const PluginsResponseSchema = z.object({
  plugins: z.array(PluginSchema),
});
export type PluginsResponse = z.infer<typeof PluginsResponseSchema>;

export const PluginResponseSchema = z.object({
  plugin: PluginSchema,
});
export type PluginResponse = z.infer<typeof PluginResponseSchema>;

export const PluginRunResponseSchema = z.object({
  run: PluginRunSchema,
});
export type PluginRunResponse = z.infer<typeof PluginRunResponseSchema>;

export const PluginRunsResponseSchema = z.object({
  runs: z.array(PluginRunSchema),
});
export type PluginRunsResponse = z.infer<typeof PluginRunsResponseSchema>;

export const RemovePluginResponseSchema = z.object({
  removed: z.boolean(),
  id: z.string(),
});
export type RemovePluginResponse = z.infer<typeof RemovePluginResponseSchema>;
