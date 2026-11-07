import type {
  AnalyticsAgentBreakdown,
  AnalyticsDailyPoint,
  AnalyticsModelBreakdown,
  AnalyticsQuery,
  AnalyticsResponse,
  AnalyticsTotals,
  Session,
} from '@cockpit/core';

import type { Store } from '../store/store.js';

export interface AnalyticsServiceOptions {
  store: Store;
}

function utcStartOfDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0),
  );
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function emptyTotals(): AnalyticsTotals {
  return {
    sessionCount: 0,
    stepCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    unknownCostCalls: 0,
    errorCount: 0,
  };
}

function addSession(totals: AnalyticsTotals, session: Session): void {
  totals.sessionCount += 1;
  totals.stepCount += session.totals.stepCount;
  totals.toolCallCount += session.totals.toolCallCount;
  totals.inputTokens += session.totals.inputTokens;
  totals.outputTokens += session.totals.outputTokens;
  totals.cacheReadTokens += session.totals.cacheReadTokens;
  totals.cacheWriteTokens += session.totals.cacheWriteTokens;
  totals.totalCostUsd += session.totals.totalCostUsd;
  totals.unknownCostCalls += session.totals.unknownCostCalls;
  totals.errorCount += session.totals.errorCount;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class AnalyticsService {
  readonly #store: Store;

  constructor(options: AnalyticsServiceOptions) {
    this.#store = options.store;
  }

  query(query: AnalyticsQuery): AnalyticsResponse {
    const now = new Date();
    const to = now;
    const from = utcStartOfDay(addUtcDays(now, -(query.days - 1)));
    const sessions = this.#store.listSessionsBetween(from, to, query.projectId, query.agent);

    const totals = emptyTotals();
    const daily = new Map<string, AnalyticsDailyPoint>();
    for (let index = 0; index < query.days; index += 1) {
      const key = dateKey(addUtcDays(from, index));
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

    const models = new Map<string, AnalyticsModelBreakdown>();
    const agents = new Map<string, AnalyticsAgentBreakdown>();

    for (const session of sessions) {
      addSession(totals, session);

      const day = daily.get(session.startedAt.slice(0, 10));
      if (day) {
        day.sessionCount += 1;
        day.stepCount += session.totals.stepCount;
        day.inputTokens += session.totals.inputTokens;
        day.outputTokens += session.totals.outputTokens;
        day.totalCostUsd = roundUsd(day.totalCostUsd + session.totals.totalCostUsd);
        day.errorCount += session.totals.errorCount;
      }

      const model = session.modelRef?.model ?? 'unknown';
      const provider = session.modelRef?.provider;
      const modelKey = `${provider ?? ''}\u0000${model}`;
      const modelEntry = models.get(modelKey) ?? {
        ...(provider ? { provider } : {}),
        model,
        sessionCount: 0,
        stepCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      };
      modelEntry.sessionCount += 1;
      modelEntry.stepCount += session.totals.stepCount;
      modelEntry.inputTokens += session.totals.inputTokens;
      modelEntry.outputTokens += session.totals.outputTokens;
      modelEntry.totalCostUsd = roundUsd(modelEntry.totalCostUsd + session.totals.totalCostUsd);
      models.set(modelKey, modelEntry);

      const agentName = session.agent?.name ?? 'unknown';
      const agentEntry = agents.get(agentName) ?? {
        agent: agentName,
        sessionCount: 0,
        stepCount: 0,
        totalCostUsd: 0,
      };
      agentEntry.sessionCount += 1;
      agentEntry.stepCount += session.totals.stepCount;
      agentEntry.totalCostUsd = roundUsd(agentEntry.totalCostUsd + session.totals.totalCostUsd);
      agents.set(agentName, agentEntry);
    }

    totals.totalCostUsd = roundUsd(totals.totalCostUsd);

    return {
      range: {
        from: from.toISOString(),
        to: to.toISOString(),
        days: query.days,
      },
      totals,
      daily: [...daily.values()],
      models: [...models.values()].sort(
        (a, b) => b.totalCostUsd - a.totalCostUsd || a.model.localeCompare(b.model),
      ),
      agents: [...agents.values()].sort(
        (a, b) => b.sessionCount - a.sessionCount || a.agent.localeCompare(b.agent),
      ),
    };
  }
}
