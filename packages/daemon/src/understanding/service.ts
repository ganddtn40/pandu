import {
  QuizSubmitResponseSchema,
  UnderstandingDebtSummarySchema,
  UnderstandingDetailResponseSchema,
  UnderstandingFileViewSchema,
  UnderstandingListResponseSchema,
  computeUnderstandingDebt,
  scoreUnderstandingFile,
  type ComprehensionQuiz,
  type ProvenanceEntry,
  type QuizQuestion,
  type QuizSubmitInput,
  type QuizView,
  type UnderstandingDebtSummary,
  type UnderstandingFile,
  type UnderstandingFileView,
  type UnderstandingListQueryInput,
  type UnderstandingStatus,
} from '@cockpit/core';

import type { Logger } from '../logger.js';
import type { LiveEventBus } from '../live/bus.js';
import { countAttributedLines } from '../provenance/service.js';
import type { Store } from '../store/store.js';

const MAX_PROMPT_EXCERPT = 160;

export class UnderstandingServiceError extends Error {
  readonly status: 400 | 404;
  readonly code: 'bad_request' | 'not_found';

  constructor(status: 400 | 404, code: 'bad_request' | 'not_found', message: string) {
    super(message);
    this.name = 'UnderstandingServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface UnderstandingServiceOptions {
  store: Store;
  logger: Logger;
  bus?: LiveEventBus;
}

function clip(text: string, maximum: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function makeChoices(correct: string, candidates: readonly string[]) {
  const texts = uniqueStrings([correct, ...candidates]).slice(0, 4);
  if (texts.length < 2) texts.push('No other answer is recorded.');
  const ids = ['a', 'b', 'c', 'd'] as const;
  return {
    choices: texts.map((text, index) => ({ id: ids[index] ?? 'd', text: text.slice(0, 1000) })),
    correctChoiceId: 'a',
  };
}

function questionFrom(
  id: string,
  prompt: string,
  correct: string,
  candidates: readonly string[],
  explanation: string,
): QuizQuestion {
  const { choices, correctChoiceId } = makeChoices(correct, candidates);
  return {
    id,
    prompt,
    choices,
    correctChoiceId,
    explanation,
  };
}

export function toQuizView(quiz: ComprehensionQuiz): QuizView {
  return {
    id: quiz.id,
    understandingFileId: quiz.understandingFileId,
    questions: quiz.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      choices: question.choices,
    })),
    generatedAt: quiz.generatedAt,
    ...(quiz.completedAt ? { completedAt: quiz.completedAt } : {}),
    ...(quiz.score === undefined ? {} : { score: quiz.score }),
  };
}

export function toFileView(file: UnderstandingFile): UnderstandingFileView {
  const reviewedLines =
    file.status === 'acknowledged'
      ? file.aiLines
      : Math.min(file.reviewedLines, Math.max(0, file.aiLines));
  return UnderstandingFileViewSchema.parse({
    ...file,
    reviewedLines,
    unreviewedLines: Math.max(0, file.aiLines - reviewedLines),
    fileScore: scoreUnderstandingFile(file),
  });
}

export function buildDebtSummary(files: readonly UnderstandingFile[]): UnderstandingDebtSummary {
  const result = computeUnderstandingDebt(
    files.map((file) => ({
      path: file.path,
      aiLines: file.aiLines,
      reviewedLines: file.reviewedLines,
      status: file.status,
    })),
  );
  return UnderstandingDebtSummarySchema.parse(result);
}

export class UnderstandingService {
  readonly #store: Store;
  readonly #logger: Logger;
  readonly #bus: LiveEventBus | undefined;

  constructor(options: UnderstandingServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#bus = options.bus;
  }

  #emit(sessionId: string, payload: Record<string, string>): void {
    this.#bus?.emit('understanding.updated', { sessionId, payload });
  }

  /**
   * Derive understanding debt from recorded provenance. AI line counts are the
   * union of attributed ranges, so repeated edits to the same lines do not
   * inflate the debt. New AI lines downgrade acknowledged files to opened.
   */
  syncSession(sessionId: string): UnderstandingFile[] {
    const session = this.#store.getSession(sessionId);
    if (!session) return [];
    const projectId = session.projectId ?? this.#projectFromProvenance(sessionId);
    if (!projectId) return [];

    const entries = this.#store.listProvenanceEntries({ sessionId, limit: 20_000 });
    const byPath = new Map<string, ProvenanceEntry[]>();
    for (const entry of entries) {
      const list = byPath.get(entry.filePath);
      if (list) list.push(entry);
      else byPath.set(entry.filePath, [entry]);
    }

    const touched: UnderstandingFile[] = [];
    for (const [filePath, fileEntries] of byPath) {
      const aiLines = countAttributedLines(fileEntries);
      const capturedTimes = fileEntries
        .map((entry) => entry.capturedAt)
        .sort((a, b) => a.localeCompare(b));
      const firstTouchedAt = new Date(capturedTimes[0] ?? new Date().toISOString());
      const lastTouchedAt = new Date(
        capturedTimes[capturedTimes.length - 1] ?? new Date().toISOString(),
      );

      const existing = this.#store.getUnderstandingFileByPath(projectId, filePath);
      if (!existing) {
        touched.push(
          this.#store.createUnderstandingFile({
            projectId,
            sessionId,
            path: filePath,
            aiLines,
            reviewedLines: 0,
            status: 'unseen',
            firstTouchedAt,
            lastTouchedAt,
          }),
        );
        continue;
      }

      const status: UnderstandingStatus =
        existing.status === 'acknowledged' && aiLines > existing.aiLines
          ? 'opened'
          : existing.status;
      const updated = this.#store.updateUnderstandingFile(existing.id, {
        sessionId,
        aiLines,
        reviewedLines: Math.min(existing.reviewedLines, aiLines),
        status,
        lastTouchedAt,
      });
      if (updated) touched.push(updated);
    }

    if (touched.length > 0) {
      this.#emit(sessionId, { action: 'synced', files: String(touched.length) });
    }
    return touched;
  }

  syncProject(projectId: string): UnderstandingFile[] {
    const files = this.#store.listUnderstandingFiles({ projectId, limit: 500 });
    return files;
  }

  list(query: UnderstandingListQueryInput) {
    let files: UnderstandingFile[];
    if (query.sessionId) {
      files = this.#filesForSession(query.sessionId, query.status);
    } else {
      files = this.#store.listUnderstandingFiles({
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
    }

    return UnderstandingListResponseSchema.parse({
      files: files.map(toFileView),
      summary: buildDebtSummary(files),
    });
  }

  detail(id: string) {
    const file = this.#store.getUnderstandingFile(id);
    if (!file) return undefined;

    return UnderstandingDetailResponseSchema.parse({
      file: toFileView(file),
      events: this.#store.listUnderstandingEvents(id),
      quizzes: this.#store.listComprehensionQuizzes(id).map(toQuizView),
      provenance: this.#store.listProvenanceEntries({
        projectId: file.projectId,
        filePath: file.path,
        limit: 1000,
      }),
    });
  }

  open(id: string): UnderstandingFileView | undefined {
    const file = this.#store.getUnderstandingFile(id);
    if (!file) return undefined;

    const now = new Date();
    const updated = this.#store.updateUnderstandingFile(id, {
      lastOpenedAt: now,
      ...(file.status === 'unseen' ? { status: 'opened' as const } : {}),
    });
    if (!updated) return undefined;

    this.#store.insertUnderstandingEvent({
      understandingFileId: id,
      type: 'opened',
      occurredAt: now,
    });
    if (updated.sessionId) this.#emit(updated.sessionId, { action: 'opened', fileId: id });
    return toFileView(updated);
  }

  acknowledge(id: string): UnderstandingFileView | undefined {
    const file = this.#store.getUnderstandingFile(id);
    if (!file) return undefined;

    const now = new Date();
    const updated = this.#store.updateUnderstandingFile(id, {
      status: 'acknowledged',
      reviewedLines: file.aiLines,
      acknowledgedAt: now,
    });
    if (!updated) return undefined;

    this.#store.insertUnderstandingEvent({
      understandingFileId: id,
      type: 'acknowledged',
      occurredAt: now,
      metadata: { aiLines: String(file.aiLines) },
    });
    if (updated.sessionId) this.#emit(updated.sessionId, { action: 'acknowledged', fileId: id });
    return toFileView(updated);
  }

  explain(id: string): { explanation: string; generatedAt: string } | undefined {
    const file = this.#store.getUnderstandingFile(id);
    if (!file) return undefined;

    const provenance = this.#store.listProvenanceEntries({
      projectId: file.projectId,
      filePath: file.path,
      limit: 50,
    });
    const now = new Date();
    const explanation = this.#explainFile(file, provenance);

    this.#store.updateUnderstandingFile(id, { explanation });
    this.#store.insertUnderstandingEvent({
      understandingFileId: id,
      type: 'explanation_viewed',
      occurredAt: now,
    });
    if (file.sessionId) this.#emit(file.sessionId, { action: 'explained', fileId: id });
    return { explanation, generatedAt: now.toISOString() };
  }

  startQuiz(id: string): QuizView | undefined {
    const file = this.#store.getUnderstandingFile(id);
    if (!file) return undefined;

    const latest = this.#store.getLatestComprehensionQuiz(id);
    if (latest && !latest.completedAt) return toQuizView(latest);

    const provenance = this.#store.listProvenanceEntries({
      projectId: file.projectId,
      filePath: file.path,
      limit: 50,
    });
    const quiz = this.#store.createComprehensionQuiz({
      understandingFileId: id,
      questions: this.#buildQuestions(file, provenance),
    });
    this.#store.insertUnderstandingEvent({
      understandingFileId: id,
      type: 'quiz_started',
      occurredAt: new Date(),
      metadata: { quizId: quiz.id },
    });
    if (file.sessionId) this.#emit(file.sessionId, { action: 'quiz_started', fileId: id });
    return toQuizView(quiz);
  }

  submitQuiz(quizId: string, input: QuizSubmitInput) {
    const quiz = this.#store.getComprehensionQuiz(quizId);
    if (!quiz) {
      throw new UnderstandingServiceError(
        404,
        'not_found',
        'The comprehension quiz was not found.',
      );
    }

    const answers = new Map(input.answers.map((answer) => [answer.questionId, answer.choiceId]));
    if (quiz.questions.some((question) => !answers.has(question.id))) {
      throw new UnderstandingServiceError(
        400,
        'bad_request',
        'Every quiz question must be answered before submitting.',
      );
    }

    const results = quiz.questions.map((question) => {
      const choiceId = answers.get(question.id) ?? '';
      return {
        questionId: question.id,
        choiceId,
        correct: choiceId === question.correctChoiceId,
        correctChoiceId: question.correctChoiceId,
        explanation: question.explanation,
      };
    });
    const correctCount = results.filter((result) => result.correct).length;
    const score = Math.round((correctCount / quiz.questions.length) * 100) / 100;
    const completed = this.#store.completeComprehensionQuiz(quiz.id, score) ?? {
      ...quiz,
      score,
      completedAt: new Date().toISOString(),
    };

    this.#store.insertUnderstandingEvent({
      understandingFileId: quiz.understandingFileId,
      type: 'quiz_completed',
      occurredAt: new Date(),
      metadata: {
        quizId: quiz.id,
        score: String(score),
        correctCount: String(correctCount),
      },
    });
    const quizFile = this.#store.getUnderstandingFile(quiz.understandingFileId);
    if (quizFile?.sessionId) {
      this.#emit(quizFile.sessionId, {
        action: 'quiz_completed',
        fileId: quiz.understandingFileId,
        score: String(score),
      });
    }

    return QuizSubmitResponseSchema.parse({
      quiz: completed,
      results,
      score,
      correctCount,
      total: quiz.questions.length,
    });
  }

  #filesForSession(sessionId: string, status?: UnderstandingStatus): UnderstandingFile[] {
    const session = this.#store.getSession(sessionId);
    if (!session) return [];
    const projectId = session.projectId ?? this.#projectFromProvenance(sessionId);
    if (!projectId) return [];

    const paths = new Set(
      this.#store
        .listProvenanceEntries({ sessionId, limit: 20_000 })
        .map((entry) => entry.filePath),
    );
    return [...paths]
      .map((filePath) => this.#store.getUnderstandingFileByPath(projectId, filePath))
      .filter((file): file is UnderstandingFile => file !== undefined)
      .filter((file) => status === undefined || file.status === status)
      .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt));
  }

  #projectFromProvenance(sessionId: string): string | undefined {
    return this.#store.listProvenanceEntries({ sessionId, limit: 1 })[0]?.projectId;
  }

  #explainFile(file: UnderstandingFile, provenance: readonly ProvenanceEntry[]): string {
    const ranges = provenance.length;
    const models = uniqueStrings(provenance.flatMap((entry) => (entry.model ? [entry.model] : [])));
    const steps = new Set(provenance.flatMap((entry) => (entry.stepId ? [entry.stepId] : [])));
    const first = provenance[provenance.length - 1];
    const latest = provenance[0];
    const reviewLine =
      file.status === 'acknowledged'
        ? 'You acknowledged this file. New AI lines will reopen the review.'
        : file.status === 'opened'
          ? `You opened this file but have not acknowledged it (${file.reviewedLines}/${file.aiLines} lines reviewed).`
          : `This file has not been opened yet (0/${file.aiLines} lines reviewed).`;

    const lines = [
      `${file.path} contains ${file.aiLines} AI-attributed lines across ${ranges} recorded change range${ranges === 1 ? '' : 's'}.`,
      models.length > 0
        ? `The changes were produced by ${models.join(', ')} across ${steps.size} step${steps.size === 1 ? '' : 's'}.`
        : `No model metadata was recorded for these changes.`,
      reviewLine,
      first
        ? `The earliest recorded range is lines ${first.lineStart}-${first.lineEnd}${first.promptExcerpt ? `, prompted by "${clip(first.promptExcerpt, 240)}"` : ''}.`
        : 'No provenance ranges are stored yet.',
      latest && latest !== first
        ? `The latest range is lines ${latest.lineStart}-${latest.lineEnd}${latest.promptExcerpt ? `, prompted by "${clip(latest.promptExcerpt, 240)}"` : ''}.`
        : '',
      '',
      'Review advice: start with the largest ranges, then trace each range back to its prompt in the Replay view. Cockpit derives this explanation deterministically from stored provenance; it does not call a model.',
    ].filter((line) => line.length > 0);

    return lines.join('\n').slice(0, 20_000);
  }

  #buildQuestions(file: UnderstandingFile, provenance: readonly ProvenanceEntry[]): QuizQuestion[] {
    const latest = provenance[0];
    const models = uniqueStrings(provenance.flatMap((entry) => (entry.model ? [entry.model] : [])));
    const correctModel = latest?.model ?? 'No model recorded';
    const promptCandidates = uniqueStrings(
      provenance
        .slice(0, 5)
        .flatMap((entry) =>
          entry.promptExcerpt ? [clip(entry.promptExcerpt, MAX_PROMPT_EXCERPT)] : [],
        ),
    );
    const correctPrompt =
      latest?.promptExcerpt !== undefined
        ? clip(latest.promptExcerpt, MAX_PROMPT_EXCERPT)
        : 'No prompt was recorded for this change.';

    return [
      questionFrom(
        'q1',
        `How many AI-authored lines does Cockpit attribute to ${file.path}?`,
        `${file.aiLines} line${file.aiLines === 1 ? '' : 's'}`,
        [`${file.aiLines + 5} lines`, `${Math.max(0, file.aiLines - 1)} lines`],
        `Cockpit unions the added line ranges recorded in git snapshots, so ${file.path} has ${file.aiLines} attributed line${file.aiLines === 1 ? '' : 's'}.`,
      ),
      questionFrom(
        'q2',
        `Which model most recently wrote attributed lines in ${file.path}?`,
        correctModel,
        [...models.filter((model) => model !== correctModel), 'No model recorded', 'Unknown model'],
        latest?.model
          ? `The newest provenance range records model ${latest.model}.`
          : 'The newest provenance range has no model metadata.',
      ),
      questionFrom(
        'q3',
        `Which prompt best matches the most recent attributed change?`,
        correctPrompt,
        [
          ...promptCandidates.filter((prompt) => prompt !== correctPrompt),
          'The file was changed outside a recorded request.',
          'No prompt was recorded for this change.',
        ],
        latest?.promptExcerpt
          ? `The prompt excerpt is stored on the same provenance entry as the newest range (lines ${latest.lineStart}-${latest.lineEnd}).`
          : 'No prompt excerpt is stored on the newest provenance entry.',
      ),
    ];
  }
}
