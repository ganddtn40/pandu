import { z } from 'zod';

import { JsonObjectSchema } from './common.js';
import { IdSchema } from './ids.js';

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  rootPath: z.string().min(1).max(4096),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  lastOpenedAt: z.string().datetime({ offset: true }).optional(),
  metadata: JsonObjectSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
});
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

export const ProjectResponseSchema = z.object({
  project: ProjectSchema,
});
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
