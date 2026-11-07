import type { HealthResponse, OverviewStats } from '@cockpit/core';
import { useCallback, useEffect, useState } from 'react';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Feedback';
import { StatusPill } from '../components/StatusPill';
import { describeMobileError, isUnauthorized, type MobileApiClient } from '../lib/api';
import {
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  pluralize,
} from '../lib/format';
import type { LiveState } from '../lib/live';
import type { MobileSession } from '../lib/session';

export interface OverviewTabProps {
  session: MobileSession;
  client: MobileApiClient;
  live: LiveState;
  onUnauthorized: () => void;
}

export function OverviewTab({ session, client, live, onUnauthorized }: OverviewTabProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial', signal?: AbortSignal) => {
      if (mode === 'refresh') setRefreshing(true);
      setError(null);
      try {
        const [nextHealth, nextStats] = await Promise.all([
          client.health(signal ? { signal } : {}),
          client.stats(signal ? { signal } : {}),
        ]);
        setHealth(nextHealth);
        setStats(nextStats);
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === 'AbortError') return;
        if (isUnauthorized(loadError)) {
          onUnauthorized();
          return;
        }
        setError(describeMobileError(loadError));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, onUnauthorized],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load('initial', controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (live.eventCount === 0) return undefined;
    const timer = window.setTimeout(() => void load('refresh'), 1_500);
    return () => window.clearTimeout(timer);
  }, [live.eventCount, load]);

  if (loading && !stats) {
    return <LoadingRows rows={4} label="Loading cockpit overview" />;
  }

  return (
    <div className="tab-stack">
      {error ? (
        <ErrorBanner message={error} onRetry={() => void load('refresh')} retrying={refreshing} />
      ) : null}

      <section className="stats-grid" aria-label="Overview totals">
        <article className="stat-card">
          <p className="stat-label">Sessions</p>
          <p className="stat-value">{formatCompactNumber(stats?.sessionCount ?? 0)}</p>
          <p className="stat-note">
            {stats && stats.activeSessionCount > 0
              ? `${formatNumber(stats.activeSessionCount)} active now`
              : 'No sessions running'}
          </p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Steps</p>
          <p className="stat-value">{formatCompactNumber(stats?.stepCount ?? 0)}</p>
          <p className="stat-note">{pluralize(stats?.toolCallCount ?? 0, 'tool call')}</p>
        </article>
        <article className="stat-card accent">
          <p className="stat-label">Spend</p>
          <p className="stat-value">{formatCurrency(stats?.totalCostUsd ?? 0)}</p>
          <p className="stat-note">
            {stats && stats.unknownCostCalls > 0
              ? `${formatNumber(stats.unknownCostCalls)} unpriced calls`
              : 'All calls priced'}
          </p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Errors</p>
          <p className="stat-value">{formatCompactNumber(stats?.errorCount ?? 0)}</p>
          <p className="stat-note">
            {stats?.lastSessionAt
              ? `Last session ${formatRelativeTime(stats.lastSessionAt)}`
              : 'Nothing recorded yet'}
          </p>
        </article>
      </section>

      <section className="panel" aria-labelledby="daemon-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Connection</p>
            <h2 id="daemon-title">Daemon</h2>
          </div>
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => void load('refresh')}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {health ? (
          <>
            <dl className="fact-list">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusPill status={health.database} />
                </dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd className="mono">{health.version}</dd>
              </div>
              <div>
                <dt>Uptime</dt>
                <dd>{formatUptime(health.uptimeSeconds)}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{health.demoMode ? 'Demo data' : 'Live capture'}</dd>
              </div>
            </dl>
            <p className="panel-note">
              OpenAI protocol {health.protocol.openai ? 'enabled' : 'off'} · Anthropic protocol{' '}
              {health.protocol.anthropic ? 'enabled' : 'off'} · connected to{' '}
              <span className="mono">{session.baseUrl}</span>
            </p>
          </>
        ) : (
          <EmptyState title="Daemon details unavailable">
            Pull to refresh or check that the daemon is still running.
          </EmptyState>
        )}
      </section>

      <section className="panel" aria-labelledby="live-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Stream</p>
            <h2 id="live-title">Live feed</h2>
          </div>
          <StatusPill status={live.status} />
        </div>
        {live.lastEvent ? (
          <dl className="fact-list">
            <div>
              <dt>Last event</dt>
              <dd className="mono">{live.lastEvent.type}</dd>
            </div>
            <div>
              <dt>When</dt>
              <dd>{formatDateTime(live.lastEvent.at)}</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>{pluralize(live.eventCount, 'event')}</dd>
            </div>
          </dl>
        ) : (
          <p className="panel-note">
            Waiting for activity. Events appear here as your agents work; the stream reconnects
            automatically if the daemon restarts.
          </p>
        )}
      </section>

      <p className="device-foot">
        Paired as {session.device.name} · {formatRelativeTime(session.pairedAt)}
      </p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (hours > 0) return `${formatNumber(hours)}h ${formatNumber(minutes)}m`;
  if (minutes > 0) return `${formatNumber(minutes)}m`;
  return `${formatNumber(total)}s`;
}
