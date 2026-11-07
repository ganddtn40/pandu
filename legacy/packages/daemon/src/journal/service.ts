import {
  formatUsd,
  type AnalyticsDailyPoint,
  type JournalEntry,
  type JournalGenerateInput,
  type JournalListQuery,
  type Session,
} from '@cockpit/core';

import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';

export class JournalServiceError extends Error {
  readonly status: number;
  readonly code: 'bad_request' | 'not_found';

  constructor(status: number, code: JournalServiceError['code'], message: string) {
    super(message);
    this.name = 'JournalServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface JournalServiceOptions {
  store: Store;
  logger: Logger;
}

function utcStartOfDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0),
  );
}

export function weekStartFor(value = new Date()): string {
  const start = utcStartOfDay(value);
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start.toISOString().slice(0, 10);
}

function parseWeekStart(weekStart: string): Date {
  const parsed = new Date(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== weekStart) {
    throw new JournalServiceError(400, 'bad_request', 'weekStart must be a valid YYYY-MM-DD date.');
  }
  return parsed;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class JournalService {
  readonly #store: Store;
  readonly #logger: Logger;

  constructor(options: JournalServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
  }

  list(query: JournalListQuery): JournalEntry[] {
    return this.#store.listJournalEntries({
      limit: query.limit,
      ...(query.projectId ? { projectId: query.projectId } : {}),
    });
  }

  generate(input: JournalGenerateInput): JournalEntry {
    const weekStart = input.weekStart ?? weekStartFor();
    const from = parseWeekStart(weekStart);
    const to = new Date(from.getTime() + 7 * 86_400_000 - 1);

    const project = input.projectId ? this.#store.getProject(input.projectId) : undefined;
    if (input.projectId && !project) {
      throw new JournalServiceError(404, 'not_found', 'The requested project was not found.');
    }

    const sessions = this.#store.listSessionsBetween(from, to, input.projectId);
    const provenance = this.#store.listProvenanceEntries({
      ...(input.projectId ? { projectId: input.projectId } : {}),
      limit: 5000,
    });
    const understanding = this.#store.listUnderstandingFiles({
      ...(input.projectId ? { projectId: input.projectId } : {}),
      limit: 500,
    });

    const sessionIds = new Set(sessions.map((session) => session.id));
    const guardEvents = this.#store
      .listGuardEvents({ limit: 500 })
      .filter((event) => sessionIds.has(event.sessionId) && event.action !== 'allow');

    const files = new Map<string, { path: string; aiLines: number; unreviewedLines: number }>();
    for (const entry of provenance) {
      const capturedAt = Date.parse(entry.capturedAt);
      if (capturedAt < from.getTime() || capturedAt > to.getTime()) continue;
      const current = files.get(entry.filePath) ?? {
        path: entry.filePath,
        aiLines: 0,
        unreviewedLines: 0,
      };
      current.aiLines += Math.max(1, entry.lineEnd - entry.lineStart + 1);
      files.set(entry.filePath, current);
    }
    for (const file of understanding) {
      if (
        Date.parse(file.lastTouchedAt) < from.getTime() ||
        Date.parse(file.lastTouchedAt) > to.getTime()
      ) {
        continue;
      }
      const current = files.get(file.path) ?? {
        path: file.path,
        aiLines: file.aiLines,
        unreviewedLines: 0,
      };
      current.aiLines = Math.max(current.aiLines, file.aiLines);
      current.unreviewedLines = Math.max(0, file.aiLines - file.reviewedLines);
      files.set(file.path, current);
    }

    const daily = new Map<string, AnalyticsDailyPoint>();
    for (let index = 0; index < 7; index += 1) {
      const key = new Date(from.getTime() + index * 86_400_000).toISOString().slice(0, 10);
      daily.set(key, {
        date: key,
        sessionCount: 0,
        stepCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        errorCount: 0,
      });
    }
    for (const session of sessions) {
      const point = daily.get(session.startedAt.slice(0, 10));
      if (!point) continue;
      point.sessionCount += 1;
      point.stepCount += session.totals.stepCount;
      point.inputTokens += session.totals.inputTokens;
      point.outputTokens += session.totals.outputTokens;
      point.totalCostUsd = roundUsd(point.totalCostUsd + session.totals.totalCostUsd);
      point.errorCount += session.totals.errorCount;
    }

    const totals = sessions.reduce(
      (accumulator, session) => {
        accumulator.stepCount += session.totals.stepCount;
        accumulator.toolCallCount += session.totals.toolCallCount;
        accumulator.totalCostUsd += session.totals.totalCostUsd;
        accumulator.unknownCostCalls += session.totals.unknownCostCalls;
        accumulator.errorCount += session.totals.errorCount;
        return accumulator;
      },
      { stepCount: 0, toolCallCount: 0, totalCostUsd: 0, unknownCostCalls: 0, errorCount: 0 },
    );

    const name = project?.name ?? 'Workspace';
    const title = `Week of ${weekStart} — ${name}`.slice(0, 300);
    const markdown = this.#render({
      weekStart,
      name,
      sessions,
      totals: { ...totals, totalCostUsd: roundUsd(totals.totalCostUsd) },
      daily: [...daily.values()],
      files: [...files.values()]
        .filter((file) => file.aiLines > 0)
        .sort((a, b) => b.aiLines - a.aiLines || a.path.localeCompare(b.path))
        .slice(0, 20),
      guardEvents,
      understanding,
    });

    const entry = this.#store.upsertJournalEntry({
      ...(input.projectId ? { projectId: input.projectId } : {}),
      weekStart,
      title,
      markdown,
    });
    this.#logger.debug('Generated a journal entry', { weekStart, projectId: input.projectId });
    return entry;
  }

  #render(input: {
    weekStart: string;
    name: string;
    sessions: readonly Session[];
    totals: {
      stepCount: number;
      toolCallCount: number;
      totalCostUsd: number;
      unknownCostCalls: number;
      errorCount: number;
    };
    daily: readonly AnalyticsDailyPoint[];
    files: readonly { path: string; aiLines: number; unreviewedLines: number }[];
    guardEvents: ReturnType<Store['listGuardEvents']>;
    understanding: ReturnType<Store['listUnderstandingFiles']>;
  }): string {
    const lines: string[] = [`# Week of ${input.weekStart} — ${input.name}`, ''];

    lines.push('## Summary', '');
    lines.push(`- Sessions: ${input.sessions.length}`);
    lines.push(`- Steps: ${input.totals.stepCount}`);
    lines.push(`- Tool calls: ${input.totals.toolCallCount}`);
    lines.push(`- Cost: ${formatUsd(input.totals.totalCostUsd)}`);
    lines.push(`- Errors: ${input.totals.errorCount}`);
    if (input.totals.unknownCostCalls > 0) {
      lines.push(`- Unpriced calls: ${input.totals.unknownCostCalls}`);
    }
    lines.push('');

    lines.push('## Activity by day', '');
    lines.push('| Day | Sessions | Steps | Cost | Errors |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const point of input.daily) {
      lines.push(
        `| ${point.date} | ${point.sessionCount} | ${point.stepCount} | ${formatUsd(point.totalCostUsd)} | ${point.errorCount} |`,
      );
    }
    lines.push('');

    lines.push('## Files touched by AI', '');
    if (input.files.length === 0) {
      lines.push('No AI-authored lines were attributed this week.', '');
    } else {
      for (const file of input.files) {
        const debt = file.unreviewedLines > 0 ? `, ${file.unreviewedLines} awaiting review` : '';
        lines.push(`- \`${file.path}\` — ${file.aiLines} AI line(s)${debt}`);
      }
      lines.push('');
    }

    const agents = new Map<string, number>();
    const models = new Map<string, number>();
    for (const session of input.sessions) {
      const agent = session.agent?.name ?? 'unknown';
      agents.set(agent, (agents.get(agent) ?? 0) + 1);
      const model = session.modelRef?.model ?? 'unknown';
      models.set(model, (models.get(model) ?? 0) + 1);
    }

    lines.push('## Agents and models', '');
    if (agents.size === 0) {
      lines.push('No sessions were recorded this week.', '');
    } else {
      for (const [agent, count] of [...agents.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )) {
        lines.push(`- Agent \`${agent}\`: ${count} session(s)`);
      }
      for (const [model, count] of [...models.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )) {
        lines.push(`- Model \`${model}\`: ${count} session(s)`);
      }
      lines.push('');
    }

    const debt = input.understanding
      .map((file) => ({
        ...file,
        unreviewedLines: Math.max(0, file.aiLines - file.reviewedLines),
      }))
      .filter((file) => file.unreviewedLines > 0)
      .sort((a, b) => b.unreviewedLines - a.unreviewedLines || a.path.localeCompare(b.path));

    lines.push('## Review debt', '');
    if (debt.length === 0) {
      lines.push('Nothing is waiting for review.', '');
    } else {
      for (const file of debt.slice(0, 20)) {
        lines.push(`- \`${file.path}\` — ${file.unreviewedLines} unreviewed line(s)`);
      }
      lines.push('');
    }

    lines.push('## Guard findings', '');
    if (input.guardEvents.length === 0) {
      lines.push('No guard findings were recorded this week.', '');
    } else {
      for (const event of input.guardEvents.slice(0, 20)) {
        lines.push(`- [${event.severity}] ${event.title} — ${event.action}/${event.status}`);
      }
      lines.push('');
    }

    lines.push('## Next week', '');
    lines.push('- Review the highest-debt files before starting new work.');
    lines.push('- Re-run the full test suite on the current branch.');
    lines.push('- Regenerate this journal with `cockpit journal generate` after the week closes.');
    lines.push('');

    return lines.join('\n');
  }
}
