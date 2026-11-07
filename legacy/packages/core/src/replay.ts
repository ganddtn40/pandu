import { z } from 'zod';

import { IsoDateTimeSchema, NonNegativeIntSchema } from './common.js';
import { IdSchema } from './ids.js';
import { SessionSchema } from './session.js';
import { CapturedStepSchema } from './step.js';

export const GitSnapshotKindSchema = z.enum(['before', 'after', 'fork', 'checkpoint']);
export type GitSnapshotKind = z.infer<typeof GitSnapshotKindSchema>;

export const FileChangeTypeSchema = z.enum(['added', 'modified', 'deleted', 'renamed']);
export type FileChangeType = z.infer<typeof FileChangeTypeSchema>;

export const ReplayFileChangeSchema = z.object({
  id: IdSchema,
  snapshotId: IdSchema,
  path: z.string().min(1).max(8192),
  oldPath: z.string().min(1).max(8192).optional(),
  changeType: FileChangeTypeSchema,
  additions: NonNegativeIntSchema.default(0),
  deletions: NonNegativeIntSchema.default(0),
  diff: z.string().max(1_000_000).optional(),
  aiAuthored: z.boolean().optional(),
});
export type ReplayFileChange = z.infer<typeof ReplayFileChangeSchema>;

export const ReplaySnapshotSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  stepId: IdSchema.optional(),
  kind: GitSnapshotKindSchema,
  commitSha: z.string().max(100).optional(),
  parentCommitSha: z.string().max(100).optional(),
  branch: z.string().max(500).optional(),
  worktreePath: z.string().min(1).max(4096).optional(),
  patch: z.string().max(2_000_000).optional(),
  filesChanged: NonNegativeIntSchema.default(0),
  insertions: NonNegativeIntSchema.default(0),
  deletions: NonNegativeIntSchema.default(0),
  createdAt: IsoDateTimeSchema,
});
export type ReplaySnapshot = z.infer<typeof ReplaySnapshotSchema>;

export const ReplayForkStatusSchema = z.enum(['creating', 'ready', 'error', 'removed']);
export type ReplayForkStatus = z.infer<typeof ReplayForkStatusSchema>;

export const ReplayForkSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  stepId: IdSchema.optional(),
  branch: z.string().min(1).max(500),
  worktreePath: z.string().min(1).max(4096),
  baseCommit: z.string().max(100).optional(),
  resumeBrief: z.string().max(500_000),
  status: ReplayForkStatusSchema.default('ready'),
  createdAt: IsoDateTimeSchema,
});
export type ReplayFork = z.infer<typeof ReplayForkSchema>;

export const SessionReplayResponseSchema = z.object({
  session: SessionSchema,
  steps: z.array(CapturedStepSchema),
  snapshots: z.array(ReplaySnapshotSchema),
  forks: z.array(ReplayForkSchema),
});
export type SessionReplayResponse = z.infer<typeof SessionReplayResponseSchema>;

export const SnapshotDetailResponseSchema = z.object({
  snapshot: ReplaySnapshotSchema,
  fileChanges: z.array(ReplayFileChangeSchema),
});
export type SnapshotDetailResponse = z.infer<typeof SnapshotDetailResponseSchema>;

export const CreateReplayForkInputSchema = z.object({
  stepId: IdSchema.optional(),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(
      /^[A-Za-z0-9._/-]+$/,
      'Branch names may contain letters, numbers, dots, slashes, and dashes.',
    )
    .optional(),
});
export type CreateReplayForkInput = z.infer<typeof CreateReplayForkInputSchema>;

export const CreateReplayForkResponseSchema = z.object({
  fork: ReplayForkSchema,
});
export type CreateReplayForkResponse = z.infer<typeof CreateReplayForkResponseSchema>;

export const ReplayForksResponseSchema = z.object({
  forks: z.array(ReplayForkSchema),
});
export type ReplayForksResponse = z.infer<typeof ReplayForksResponseSchema>;

export const RemoveReplayForkResponseSchema = z.object({
  fork: ReplayForkSchema,
});
export type RemoveReplayForkResponse = z.infer<typeof RemoveReplayForkResponseSchema>;
