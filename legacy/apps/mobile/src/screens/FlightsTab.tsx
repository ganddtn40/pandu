import type { Session } from '@cockpit/core';
import { useCallback, useEffect, useState } from 'react';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Feedback';
import { StatusPill } from '../components/StatusPill';
import { describeMobileError, isUnauthorized, type MobileApiClient } from '../lib/api';
import {
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatRelativeTime,
  pluralize,
} from '../lib/format';
import type { MobileSession } from '../lib/session';

type Filter = 'all' | 'active' | 'completed';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
];

export interface FlightsTabProps {
  session: MobileSession;
  client: MobileApiClient;
  onUnauthorized: () => void;
}

export function FlightsTab({ client, onUnauthorized }: FlightsTabProps) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial', signal?: AbortSignal) => {
      if (mode === 'refresh') setRefreshing(true);
      setError(null);
      try {
        const next = await client.listSessions(signal ? { signal } : {});
        setSessions(next);
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

  const visible = (sessions ?? []).filter((session) => {
    if (filter === 'all') return true;
    if (filter === 'active') return session.status === 'active';
    return session.status !== 'active';
  });

  return (
    <div className="tab-stack">
      <div className="list-head">
        <div>
          <p className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            Recent
          </p>
          <h1 className="screen-title">Flights</h1>
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

      <div className="filter-row" role="group" aria-label="Filter sessions">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`filter-chip${filter === option.value ? ' is-active' : ''}`}
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
        {sessions ? (
          <span className="count-note">{pluralize(sessions.length, 'session')}</span>
        ) : null}
      </div>

      {error ? (
        <ErrorBanner message={error} onRetry={() => void load('refresh')} retrying={refreshing} />
      ) : null}

      {loading && !sessions ? (
        <LoadingRows rows={5} label="Loading sessions" />
      ) : visible.length === 0 ? (
        <EmptyState
          title={sessions && sessions.length > 0 ? 'No matching flights' : 'No flights yet'}
        >
          {sessions && sessions.length > 0
            ? 'Change the filter to see the rest of the flight log.'
            : 'Point an agent at the Cockpit proxy and its sessions will appear here.'}
        </EmptyState>
      ) : (
        <ul className="flight-list">
          {visible.map((session) => (
            <li className="flight-card" key={session.id}>
              <div className="flight-head">
                <StatusPill status={session.status} />
                <span className="flight-when">{formatRelativeTime(session.startedAt)}</span>
              </div>
              <h2>{session.title}</h2>
              <p className="flight-meta">
                {session.agent?.name ?? session.source} · {formatDateTime(session.startedAt)}
              </p>
              <div className="flight-totals">
                <span>{pluralize(session.totals.stepCount, 'step')}</span>
                <span>{formatCompactNumber(session.totals.inputTokens)} in</span>
                <span>{formatCompactNumber(session.totals.outputTokens)} out</span>
                <span className="flight-cost">{formatCurrency(session.totals.totalCostUsd)}</span>
              </div>
              {session.totals.errorCount > 0 ? (
                <p className="flight-errors">
                  {pluralize(session.totals.errorCount, 'error')} recorded
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
