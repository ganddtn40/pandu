import { Link } from 'react-router-dom';
import { useState } from 'react';

import type { SessionStatusFilter } from '../lib/api';
import {
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  pluralize,
} from '../lib/format';
import {
  useDebouncedValue,
  useLiveRefresh,
  usePageTitle,
  useSessions,
  useStats,
} from '../lib/hooks';
import { ErrorBanner } from '../components/Messages';
import { SessionsPanel } from '../components/SessionsPanel';

function totalTokensFromStats(stats: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
}

function cachedTokensFromStats(stats: {
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return stats.cacheReadTokens + stats.cacheWriteTokens;
}

export function OverviewPage() {
  usePageTitle('Overview · Cockpit');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<SessionStatusFilter>('all');
  const debouncedSearch = useDebouncedValue(search, 250);
  const statsResource = useStats();
  const sessionsResource = useSessions({ search: debouncedSearch, status });

  useLiveRefresh(() => {
    statsResource.refresh();
    sessionsResource.refresh();
  });

  const { stats, error: statsError, loading: statsLoading, refresh: refreshStats } = statsResource;
  const activeCount = stats?.activeSessionCount ?? 0;
  const errorCount = stats?.errorCount ?? 0;

  return (
    <div className="page page-overview">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            Local flight recorder
          </p>
          <h1>
            Every agent flight,
            <br />
            <em>on the record.</em>
          </h1>
          <p className="hero-lede">
            Cockpit captures model calls, tool runs, tokens, and cost from your coding agents. The
            recorder lives on this machine, and nothing leaves it.
          </p>
        </div>
        <div className="hero-side">
          <div className="hero-instrument" aria-hidden="true">
            <span className="instrument-ring" />
            <span className="instrument-ring instrument-ring-2" />
            <span className="instrument-cross instrument-cross-x" />
            <span className="instrument-cross instrument-cross-y" />
            <span className="instrument-needle" />
          </div>
          <dl className="hero-readout">
            <div>
              <dt>Recorder</dt>
              <dd>{statsLoading && !stats ? 'Checking…' : 'Local'}</dd>
            </div>
            <div>
              <dt>Last flight</dt>
              <dd>
                {stats?.lastSessionAt ? (
                  <time dateTime={stats.lastSessionAt} title={formatDateTime(stats.lastSessionAt)}>
                    {formatRelativeTime(stats.lastSessionAt)}
                  </time>
                ) : (
                  'None yet'
                )}
              </dd>
            </div>
          </dl>
        </div>
      </header>

      {statsError ? (
        <ErrorBanner message={statsError} onRetry={refreshStats} retrying={statsLoading} />
      ) : null}

      <section className="stat-grid" aria-label="Recorded totals">
        <article className="stat-card">
          <p className="stat-label">Flights</p>
          {statsLoading && !stats ? (
            <span className="skeleton skeleton-stat" aria-label="Loading flights" />
          ) : (
            <p className="stat-value">{formatNumber(stats?.sessionCount ?? 0)}</p>
          )}
          <p className="stat-detail">
            {activeCount > 0 ? (
              <>
                <span className="signal signal-live" aria-hidden="true" />
                {activeCount} in flight
              </>
            ) : (
              'Nothing in flight'
            )}
          </p>
        </article>

        <article className="stat-card">
          <p className="stat-label">Steps captured</p>
          {statsLoading && !stats ? (
            <span className="skeleton skeleton-stat" aria-label="Loading steps" />
          ) : (
            <p className="stat-value">{formatCompactNumber(stats?.stepCount ?? 0)}</p>
          )}
          <p className="stat-detail">
            {formatNumber(stats?.toolCallCount ?? 0)}{' '}
            {pluralize(stats?.toolCallCount ?? 0, 'tool call')}
          </p>
        </article>

        <article className="stat-card">
          <p className="stat-label">Tokens metered</p>
          {statsLoading && !stats ? (
            <span className="skeleton skeleton-stat" aria-label="Loading tokens" />
          ) : (
            <p className="stat-value">
              {formatCompactNumber(stats ? totalTokensFromStats(stats) : 0)}
            </p>
          )}
          <p className="stat-detail">
            {formatCompactNumber(stats ? cachedTokensFromStats(stats) : 0)} cached
          </p>
        </article>

        <article className="stat-card stat-card-accent">
          <p className="stat-label">Spend</p>
          {statsLoading && !stats ? (
            <span className="skeleton skeleton-stat" aria-label="Loading spend" />
          ) : (
            <p className="stat-value">{formatCurrency(stats?.totalCostUsd ?? 0)}</p>
          )}
          <p className="stat-detail">
            {stats && stats.unknownCostCalls > 0
              ? `${formatNumber(stats.unknownCostCalls)} unpriced ${pluralize(stats.unknownCostCalls, 'call')}`
              : 'Priced from local tables'}
          </p>
        </article>
      </section>

      {errorCount > 0 ? (
        <p className="error-note">
          <span className="signal signal-danger" aria-hidden="true" />
          {formatNumber(errorCount)} recorded {pluralize(errorCount, 'error')} across flights.
        </p>
      ) : null}

      <section className="panel" id="flight-log" aria-labelledby="flight-log-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Recorder</p>
            <h2 id="flight-log-title">Flight log</h2>
          </div>
          <div className="panel-tools">
            <Link className="text-link" to="/sessions">
              Full log <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        <SessionsPanel
          search={search}
          status={status}
          onSearchChange={setSearch}
          onStatusChange={setStatus}
          resource={sessionsResource}
        />
      </section>

      <footer className="page-foot">
        <span>Cockpit records in a local SQLite database.</span>
        <span aria-hidden="true">·</span>
        <span>No telemetry, no cloud sync.</span>
      </footer>
    </div>
  );
}
