import { z } from 'zod';

import { IsoDateTimeSchema, NonNegativeIntSchema } from './common.js';
import { IdSchema } from './ids.js';
import { ProvenanceEntrySchema } from './provenance.js';

export const UnderstandingStatusSchema = z.enum(['unseen', 'opened', 'acknowledged']);
export type UnderstandingStatus = z.infer<typeof UnderstandingStatusSchema>;

export const UnderstandingFileSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  sessionId: IdSchema.optional(),
  path: z.string().trim().min(1).max(4096),
  aiLines: NonNegativeIntSchema,
  reviewedLines: NonNegativeIntSchema,
  status: UnderstandingStatusSchema,
  firstTouchedAt: IsoDateTimeSchema,
  lastTouchedAt: IsoDateTimeSchema,
  lastOpenedAt: IsoDateTimeSchema.optional(),
  acknowledgedAt: IsoDateTimeSchema.optional(),
  explanation: z.string().max(20_000).optional(),
});
export type UnderstandingFile = z.infer<typeof UnderstandingFileSchema>;

export const UnderstandingEventTypeSchema = z.enum([
  'opened',
  'acknowledged',
  'explanation_viewed',
  'quiz_started',
  'quiz_completed',
]);
export type UnderstandingEventType = z.infer<typeof UnderstandingEventTypeSchema>;

export const UnderstandingEventSchema = z.object({
  id: IdSchema,
  understandingFileId: IdSchema,
  type: UnderstandingEventTypeSchema,
  occurredAt: IsoDateTimeSchema,
  metadata: z.record(z.string(), z.string()).default({}),
});
export type UnderstandingEvent = z.infer<typeof UnderstandingEventSchema>;

export const QuizChoiceSchema = z.object({
  id: z.string().min(1).max(10),
  text: z.string().min(1).max(1000),
});
export type QuizChoice = z.infer<typeof QuizChoiceSchema>;

export const QuizQuestionSchema = z.object({
  id: z.string().min(1).max(100),
  prompt: z.string().min(1).max(2000),
  choices: z.array(QuizChoiceSchema).min(2).max(6),
  correctChoiceId: z.string().min(1).max(10),
  explanation: z.string().min(1).max(5000),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const ComprehensionQuizSchema = z.object({
  id: IdSchema,
  understandingFileId: IdSchema,
  questions: z.array(QuizQuestionSchema).length(3),
  generatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  score: z.number().min(0).max(1).optional(),
});
export type ComprehensionQuiz = z.infer<typeof ComprehensionQuizSchema>;

export const UnderstandingFileViewSchema = UnderstandingFileSchema.extend({
  unreviewedLines: NonNegativeIntSchema,
  fileScore: z.number().min(0).max(100),
});
export type UnderstandingFileView = z.infer<typeof UnderstandingFileViewSchema>;

export const UnderstandingHotspotViewSchema = z.object({
  path: z.string().min(1).max(4096),
  status: UnderstandingStatusSchema,
  aiLines: NonNegativeIntSchema,
  unreviewedLines: NonNegativeIntSchema,
  fileScore: z.number().min(0).max(100),
});
export type UnderstandingHotspotView = z.infer<typeof UnderstandingHotspotViewSchema>;

export const UnderstandingDebtSummarySchema = z.object({
  reviewedPercent: z.number().min(0).max(100),
  debtPercent: z.number().min(0).max(100),
  totalAiLines: NonNegativeIntSchema,
  reviewedAiLines: NonNegativeIntSchema,
  fileCount: NonNegativeIntSchema,
  unseenFiles: NonNegativeIntSchema,
  acknowledgedFiles: NonNegativeIntSchema,
  hotspots: z.array(UnderstandingHotspotViewSchema),
  neverReviewedHotspots: z.array(UnderstandingHotspotViewSchema),
});
export type UnderstandingDebtSummary = z.infer<typeof UnderstandingDebtSummarySchema>;

export const UnderstandingListQuerySchema = z.object({
  projectId: IdSchema.optional(),
  sessionId: IdSchema.optional(),
  status: UnderstandingStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type UnderstandingListQuery = z.infer<typeof UnderstandingListQuerySchema>;
export type UnderstandingListQueryInput = {
  projectId?: string | undefined;
  sessionId?: string | undefined;
  status?: UnderstandingStatus | undefined;
  limit?: number | undefined;
};

export const UnderstandingListResponseSchema = z.object({
  files: z.array(UnderstandingFileViewSchema),
  summary: UnderstandingDebtSummarySchema,
});
export type UnderstandingListResponse = z.infer<typeof UnderstandingListResponseSchema>;

export const QuizViewQuestionSchema = z.object({
  id: z.string().min(1).max(100),
  prompt: z.string().min(1).max(2000),
  choices: z.array(QuizChoiceSchema).min(2).max(6),
});
export type QuizViewQuestion = z.infer<typeof QuizViewQuestionSchema>;

export const QuizViewSchema = z.object({
  id: IdSchema,
  understandingFileId: IdSchema,
  questions: z.array(QuizViewQuestionSchema).length(3),
  generatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  score: z.number().min(0).max(1).optional(),
});
export type QuizView = z.infer<typeof QuizViewSchema>;

export const UnderstandingDetailResponseSchema = z.object({
  file: UnderstandingFileViewSchema,
  events: z.array(UnderstandingEventSchema),
  quizzes: z.array(QuizViewSchema),
  provenance: z.array(ProvenanceEntrySchema),
});
export type UnderstandingDetailResponse = z.infer<typeof UnderstandingDetailResponseSchema>;

export const AcknowledgeUnderstandingResponseSchema = z.object({
  file: UnderstandingFileViewSchema,
});
export type AcknowledgeUnderstandingResponse = z.infer<
  typeof AcknowledgeUnderstandingResponseSchema
>;

export const ExplainUnderstandingResponseSchema = z.object({
  explanation: z.string().max(20_000),
  generatedAt: IsoDateTimeSchema,
});
export type ExplainUnderstandingResponse = z.infer<typeof ExplainUnderstandingResponseSchema>;

export const QuizStartResponseSchema = z.object({
  quiz: QuizViewSchema,
});
export type QuizStartResponse = z.infer<typeof QuizStartResponseSchema>;

export const QuizSubmitInputSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1).max(100),
        choiceId: z.string().min(1).max(10),
      }),
    )
    .min(1)
    .max(10),
});
export type QuizSubmitInput = z.infer<typeof QuizSubmitInputSchema>;

export const QuizAnswerResultSchema = z.object({
  questionId: z.string().min(1).max(100),
  choiceId: z.string().min(1).max(10),
  correct: z.boolean(),
  correctChoiceId: z.string().min(1).max(10),
  explanation: z.string().min(1).max(5000),
});
export type QuizAnswerResult = z.infer<typeof QuizAnswerResultSchema>;

export const QuizSubmitResponseSchema = z.object({
  quiz: ComprehensionQuizSchema,
  results: z.array(QuizAnswerResultSchema),
  score: z.number().min(0).max(1),
  correctCount: NonNegativeIntSchema,
  total: NonNegativeIntSchema,
});
export type QuizSubmitResponse = z.infer<typeof QuizSubmitResponseSchema>;
