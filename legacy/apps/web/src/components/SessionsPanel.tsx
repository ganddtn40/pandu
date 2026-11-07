import { Link } from 'react-router-dom';

import type { SessionStatusFilter } from '../lib/api';
import {
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelativeTime,
  pluralize,
} from '../lib/format';
import type { SessionsResource } from '../lib/hooks';
import { agentLabel, modelLabel, sessionTokenTotal } from '../lib/session';
import { EmptyState, ErrorBanner, LoadingRows } from './Messages';
import { StatusBadge } from './StatusBadge';

export interface SessionsPanelProps {
  search: string;
  status: SessionStatusFilter;
  onSearchChange: (search: string) => void;
  onStatusChange: (status: SessionStatusFilter) => void;
  resource: SessionsResource;
}

const STATUS_FILTERS: ReadonlyArray<{ value: SessionStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'killed', label: 'Killed' },
];

function statusCountLabel(count: number, hasMore: boolean): string {
  const suffix = hasMore ? '+' : '';
  return `${formatNumber(count)}${suffix} ${pluralize(count, 'flight')}`;
}

export function SessionsPanel({
  search,
  status,
  onSearchChange,
  onStatusChange,
  resource,
}: SessionsPanelProps) {
  const { sessions, nextCursor, error, loading, refreshing, loadingMore } = resource;
  const hasFilters = search.trim().length > 0 || status !== 'all';
  const showSkeleton = loading && sessions.length === 0;
  const loadedLabel = statusCountLabel(sessions.length, nextCursor !== null);

  return (
    <div className="sessions-panel">
      <div className="filter-bar">
        <div className="search-field">
          <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" />
            <path d="M13 13l4 4" stroke="currentColor" strokeLinecap="round" />
          </svg>
          <label htmlFor="session-search" className="sr-only">
            Search flights
          </label>
          <input
            id="session-search"
            type="search"
            value={search}
            placeholder="Search title, workspace, or branch…"
            autoComplete="off"
            onChange={(event) => onSearchChange(event.target.value)}
          />
          {search.length > 0 ? (
            <button
              className="search-clear"
              type="button"
              aria-label="Clear search"
              onClick={() => onSearchChange('')}
            >
              ×
            </button>
          ) : null}
        </div>

        <div className="filter-group" role="group" aria-label="Filter flights by status">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              className="filter-chip"
              type="button"
              aria-pressed={status === filter.value}
              onClick={() => onStatusChange(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <p className="filter-count" aria-live="polite">
          {loading && sessions.length === 0 ? 'Scanning…' : loadedLabel}
          {refreshing ? <span className="filter-sync"> · syncing</span> : null}
        </p>
      </div>

      {error ? (
        <ErrorBanner message={error} onRetry={resource.refresh} retrying={refreshing || loading} />
      ) : null}

      {showSkeleton ? (
        <LoadingRows rows={4} label="Loading recorded flights" />
      ) : sessions.length === 0 ? (
        hasFilters ? (
          <EmptyState
            title="No flights match this filter."
            action={
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  onSearchChange('');
                  onStatusChange('all');
                }}
              >
                Clear filters
              </button>
            }
          >
            <p>
              Try a different status or search term. Cockpit only shows what the daemon recorded.
            </p>
          </EmptyState>
        ) : (
          <EmptyState title="No flights recorded yet.">
            <p>
              Point an agent at the local proxy and Cockpit will capture every model call, tool, and
              token.
            </p>
            <code className="command">cockpit run -- claude</code>
          </EmptyState>
        )
      ) : (
        <div className={`flight-table${loading ? ' is-loading' : ''}`} aria-busy={loading}>
          <div className="flight-head" aria-hidden="true">
            <span>Flight</span>
            <span className="flight-steps">Steps</span>
            <span className="flight-tokens">Tokens</span>
            <span className="flight-cost">Cost</span>
            <span className="flight-time">Started</span>
            <span />
          </div>
          <ol className="flight-list">
            {sessions.map((session) => {
              const startedAt = session.startedAt;
              const branch = session.gitBranch;
              const totals = session.totals;
              return (
                <li key={session.id}>
                  <Link
                    className="flight-row"
                    to={`/sessions/${session.id}`}
                    aria-label={`Open flight ${session.title}`}
                  >
                    <span className="flight-id">
                      <span className="flight-title-line">
                        <span className="flight-title">{session.title}</span>
                        <StatusBadge status={session.status} />
                        {session.source === 'demo' ? (
                          <span className="source-tag">Demo</span>
                        ) : null}
                      </span>
                      <span className="flight-sub">
                        <span>{modelLabel(session)}</span>
                        {session.agent?.name ? <span>{agentLabel(session)}</span> : null}
                        {branch ? <span className="mono">{branch}</span> : null}
                      </span>
                    </span>

                    <span className="flight-metric flight-steps">
                      <span className="metric-label">Steps</span>
                      <span className="metric-value">{formatNumber(totals.stepCount)}</span>
                    </span>
                    <span className="flight-metric flight-tokens">
                      <span className="metric-label">Tokens</span>
                      <span className="metric-value">
                        {formatCompactNumber(sessionTokenTotal(totals))}
                      </span>
                    </span>
                    <span className="flight-metric flight-cost">
                      <span className="metric-label">Cost</span>
                      <span className="metric-value">{formatCurrency(totals.totalCostUsd)}</span>
                    </span>
                    <span className="flight-time">
                      <time dateTime={startedAt} title={formatDateTime(startedAt)}>
                        {formatRelativeTime(startedAt)}
                      </time>
                      <span>
                        {session.durationMs === undefined
                          ? session.status === 'active'
                            ? 'in flight'
                            : '—'
                          : formatDuration(session.durationMs)}
                      </span>
                    </span>
                    <span className="flight-arrow" aria-hidden="true">
                      →
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {nextCursor !== null ? (
        <div className="load-more">
          <button
            className="ghost-button"
            type="button"
            onClick={resource.loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load older flights'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
