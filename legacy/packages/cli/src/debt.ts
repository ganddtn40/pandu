import {
  type ContextSnapshotDetailResponse,
  type QuizSubmitResponse,
  type QuizView,
  type SessionContextResponse,
  type SessionProvenanceResponse,
  type UnderstandingDetailResponse,
  type UnderstandingListResponse,
} from '@cockpit/core';

import type { DaemonClient } from './daemon-client.js';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width);
}

function truncate(value: string, maximum: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

function statusLabel(status: string): string {
  return status.toUpperCase();
}

export function formatProvenance(response: SessionProvenanceResponse): string {
  const lines = [
    `Provenance for session ${response.sessionId}`,
    `Files: ${response.totals.files}  AI lines: ${response.totals.aiLines}  Ranges: ${response.totals.entries}  Steps: ${response.totals.steps}`,
  ];

  if (response.files.length === 0) {
    lines.push('');
    lines.push('No provenance has been captured yet. Provenance is derived from git snapshots.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('');
  lines.push(`${pad('FILE', 48)} ${pad('AI LINES', 8)} ${pad('RANGES', 7)} MODEL`);
  for (const file of response.files) {
    lines.push(
      `${pad(truncate(file.path, 48), 48)} ${pad(String(file.aiLines), 8)} ${pad(String(file.lineRanges), 7)} ${file.models.join(', ') || '—'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatUnderstandingList(response: UnderstandingListResponse): string {
  const summary = response.summary;
  const lines = [
    `Understanding debt: ${summary.debtPercent}% (${summary.reviewedAiLines}/${summary.totalAiLines} AI lines reviewed)`,
    `Files: ${summary.fileCount}  Unseen: ${summary.unseenFiles}  Acknowledged: ${summary.acknowledgedFiles}`,
  ];

  if (summary.neverReviewedHotspots.length > 0) {
    lines.push('');
    lines.push('Never-reviewed hotspots:');
    for (const hotspot of summary.neverReviewedHotspots.slice(0, 10)) {
      lines.push(
        `  ${truncate(hotspot.path, 60)} — ${hotspot.unreviewedLines} unreviewed line(s), score ${hotspot.fileScore}`,
      );
    }
  }

  if (response.files.length === 0) {
    lines.push('');
    lines.push('No AI-authored files are recorded for this scope yet.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('');
  lines.push(
    `${pad('ID', 36)} ${pad('STATUS', 12)} ${pad('AI', 6)} ${pad('REVIEWED', 8)} SCORE PATH`,
  );
  for (const file of response.files) {
    lines.push(
      `${pad(file.id, 36)} ${pad(statusLabel(file.status), 12)} ${pad(String(file.aiLines), 6)} ${pad(String(file.reviewedLines), 8)} ${pad(String(file.fileScore), 5)} ${truncate(file.path, 80)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatUnderstandingDetail(detail: UnderstandingDetailResponse): string {
  const file = detail.file;
  const lines = [
    `${file.path}`,
    `Status: ${file.status}  AI lines: ${file.aiLines}  Reviewed: ${file.reviewedLines}  Score: ${file.fileScore}/100`,
    `ID: ${file.id}`,
    `First touched: ${file.firstTouchedAt}  Last touched: ${file.lastTouchedAt}`,
  ];

  if (file.explanation) {
    lines.push('');
    lines.push('Explanation:');
    for (const line of file.explanation.split('\n')) lines.push(`  ${line}`);
  }

  lines.push('');
  lines.push(`Provenance ranges (${detail.provenance.length}):`);
  for (const entry of detail.provenance.slice(0, 20)) {
    lines.push(
      `  lines ${entry.lineStart}-${entry.lineEnd}  ${entry.model ?? 'unknown model'}  ${entry.capturedAt}`,
    );
    if (entry.promptExcerpt) lines.push(`    prompt: ${truncate(entry.promptExcerpt, 140)}`);
  }
  if (detail.provenance.length > 20) {
    lines.push(`  … ${detail.provenance.length - 20} more range(s)`);
  }

  if (detail.quizzes.length > 0) {
    lines.push('');
    lines.push('Quizzes:');
    for (const quiz of detail.quizzes) {
      lines.push(
        `  ${quiz.id}  ${quiz.completedAt ? `score ${Math.round((quiz.score ?? 0) * 100)}%` : 'not completed'}  generated ${quiz.generatedAt}`,
      );
    }
  }

  if (detail.events.length > 0) {
    lines.push('');
    lines.push('Recent events:');
    for (const event of detail.events.slice(0, 10)) {
      lines.push(`  ${event.occurredAt}  ${event.type}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatQuiz(quiz: QuizView): string {
  const lines = [`Quiz ${quiz.id} for ${quiz.understandingFileId}`, ''];
  quiz.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.prompt}`);
    for (const choice of question.choices) {
      lines.push(`   ${choice.id}) ${choice.text}`);
    }
    lines.push('');
  });
  lines.push('Submit with: cockpit debt quiz <id> --answers a,b,c');
  return `${lines.join('\n')}\n`;
}

export function formatQuizResults(result: QuizSubmitResponse): string {
  const lines = [
    `Score: ${Math.round(result.score * 100)}% (${result.correctCount}/${result.total})`,
    '',
  ];
  for (const answer of result.results) {
    lines.push(
      `${answer.correct ? '✓' : '✗'} ${answer.questionId}: chose ${answer.choiceId}, correct ${answer.correctChoiceId}`,
    );
    lines.push(`  ${answer.explanation}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatContext(response: SessionContextResponse): string {
  const lines = [
    `Context snapshots for session ${response.sessionId}: ${response.snapshots.length}`,
  ];
  if (!response.latest) {
    lines.push('No context snapshots have been captured yet.');
    return `${lines.join('\n')}\n`;
  }

  const latest = response.latest;
  lines.push(
    `Latest: ${latest.totalTokens.toLocaleString()} estimated tokens${latest.contextWindow ? ` of ${latest.contextWindow.toLocaleString()} (${latest.utilizationPercent}%)` : ' (window unknown)'}`,
  );
  lines.push(`Measured: ${latest.measuredAt}`);
  lines.push('');
  lines.push(`${pad('MEASURED', 24)} ${pad('TOKENS', 10)} ${pad('WINDOW', 10)} MODEL`);
  for (const snapshot of response.snapshots.slice(-10)) {
    lines.push(
      `${pad(snapshot.measuredAt, 24)} ${pad(snapshot.totalTokens.toLocaleString(), 10)} ${pad(snapshot.contextWindow ? snapshot.contextWindow.toLocaleString() : 'unknown', 10)} ${snapshot.model ?? '—'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatContextDetail(detail: ContextSnapshotDetailResponse): string {
  const snapshot = detail.snapshot;
  const lines = [
    `Context snapshot ${snapshot.id}`,
    `Tokens: ${snapshot.totalTokens.toLocaleString()}${snapshot.contextWindow ? ` / ${snapshot.contextWindow.toLocaleString()} (${snapshot.utilizationPercent}%)` : ' (window unknown)'}`,
    `Model: ${snapshot.model ?? 'unknown'}  Provider: ${snapshot.provider ?? 'unknown'}`,
    `Measured: ${snapshot.measuredAt}`,
    '',
    'Segments:',
  ];

  for (const segment of detail.segments) {
    lines.push(
      `  ${pad(segment.category, 12)} ${pad(segment.tokens.toLocaleString(), 10)} ${pad(`${segment.percent}%`, 7)} ${truncate(segment.label, 60)}${segment.sourcePath ? ` (${segment.sourcePath})` : ''}`,
    );
  }

  if (detail.insights.length > 0) {
    lines.push('');
    lines.push('Insights:');
    for (const insight of detail.insights) {
      lines.push(`  [${insight.severity}] ${insight.title}`);
      lines.push(`    ${truncate(insight.detail, 200)}`);
      if (insight.estimatedSavingsTokens) {
        lines.push(
          `    estimated savings: ${insight.estimatedSavingsTokens.toLocaleString()} tokens`,
        );
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function runProvenance(
  client: DaemonClient,
  sessionId: string,
  recompute: boolean,
  json: boolean,
): Promise<string> {
  const response = recompute
    ? await client.recomputeSessionProvenance(sessionId)
    : await client.getSessionProvenance(sessionId);
  return json ? `${JSON.stringify(response, null, 2)}\n` : formatProvenance(response);
}

export async function runDebt(
  client: DaemonClient,
  sessionId: string | undefined,
  json: boolean,
): Promise<string> {
  const response = sessionId
    ? await client.listSessionUnderstanding(sessionId)
    : await client.listUnderstanding();
  return json ? `${JSON.stringify(response, null, 2)}\n` : formatUnderstandingList(response);
}

export async function runDebtDetail(
  client: DaemonClient,
  understandingId: string,
  json: boolean,
): Promise<string> {
  const detail = await client.getUnderstanding(understandingId);
  return json ? `${JSON.stringify(detail, null, 2)}\n` : formatUnderstandingDetail(detail);
}

export async function runDebtOpen(
  client: DaemonClient,
  understandingId: string,
  json: boolean,
): Promise<string> {
  const response = await client.openUnderstanding(understandingId);
  return json
    ? `${JSON.stringify(response, null, 2)}\n`
    : `${response.file.path} is now ${response.file.status}.\n`;
}

export async function runDebtAck(
  client: DaemonClient,
  understandingId: string,
  json: boolean,
): Promise<string> {
  const response = await client.acknowledgeUnderstanding(understandingId);
  return json
    ? `${JSON.stringify(response, null, 2)}\n`
    : `${response.file.path} acknowledged (${response.file.reviewedLines}/${response.file.aiLines} AI lines).\n`;
}

export async function runDebtExplain(
  client: DaemonClient,
  understandingId: string,
  json: boolean,
): Promise<string> {
  const response = await client.explainUnderstanding(understandingId);
  return json ? `${JSON.stringify(response, null, 2)}\n` : `${response.explanation}\n`;
}

export async function runDebtQuiz(
  client: DaemonClient,
  understandingId: string,
  answers: string | undefined,
  json: boolean,
): Promise<string> {
  const started = await client.startUnderstandingQuiz(understandingId);
  const quiz = started.quiz;

  if (!answers) {
    return json ? `${JSON.stringify(started, null, 2)}\n` : formatQuiz(quiz);
  }

  const choiceIds = answers
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (choiceIds.length !== quiz.questions.length) {
    throw new Error(
      `Expected ${quiz.questions.length} answers, received ${choiceIds.length}. Use --answers a,b,c.`,
    );
  }

  const result = await client.submitUnderstandingQuiz(quiz.id, {
    answers: quiz.questions.map((question, index) => ({
      questionId: question.id,
      choiceId: choiceIds[index] ?? '',
    })),
  });
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatQuizResults(result);
}

export async function runContext(
  client: DaemonClient,
  sessionId: string,
  recompute: boolean,
  json: boolean,
): Promise<string> {
  const response = recompute
    ? await client.recomputeSessionContext(sessionId)
    : await client.getSessionContext(sessionId);

  if (json) {
    const detail = response.latest ? await client.getContextSnapshot(response.latest.id) : null;
    return `${JSON.stringify({ ...response, detail }, null, 2)}\n`;
  }

  const summary = formatContext(response);
  if (!response.latest) return summary;

  const detail = await client.getContextSnapshot(response.latest.id);
  return `${summary}\n${formatContextDetail(detail)}`;
}
