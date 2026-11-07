import { Link, useParams } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ErrorBanner, LoadingRows } from '../components/Messages';
import { StatusBadge } from '../components/StatusBadge';
import { StepInspector } from '../components/StepInspector';
import { StepTimeline } from '../components/StepTimeline';
import {
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTime,
  pluralize,
} from '../lib/format';
import { usePageTitle, useSessionDetail, useStepDetail } from '../lib/hooks';
import { useLiveStatus, useLiveSubscription, useRecentLiveEvents } from '../lib/live';
import { agentLabel, eventTypeLabel, modelLabel, sessionTokenTotal, shortId } from '../lib/session';

const MAX_LIVE_TEXT = 40_000;

export function SessionPage() {
  const { id = '' } = useParams<{ id: string }>();
  const detail = useSessionDetail(id);
  const session = detail.session;
  usePageTitle(session ? `${session.title} · Cockpit` : 'Flight · Cockpit');

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [liveText, setLiveText] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  const stepDetail = useStepDetail(selectedStepId);
  const selectedStep = detail.steps.find((step) => step.id === selectedStepId) ?? null;
  const liveEvents = useRecentLiveEvents((event) => event.sessionId === id, 7);
  const liveStatus = useLiveStatus();

  const refreshTimer = useRef<number | undefined>(undefined);
  const refreshDetail = detail.refresh;
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== undefined) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = undefined;
      refreshDetail();
    }, 350);
  }, [refreshDetail]);

  useEffect(() => {
    const last = detail.steps.at(-1);
    if (!last) return;
    if (selectedStepId === null || (followLatest && selectedStepId !== last.id)) {
      setSelectedStepId(last.id);
    }
  }, [detail.steps, followLatest, selectedStepId]);

  useEffect(() => {
    setLiveText('');
  }, [selectedStepId]);

  useEffect(
    () => () => {
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLiveSubscription((event) => {
    if (event.sessionId !== id) return;

    if (event.type === 'stream.chunk') {
      if (event.stepId !== selectedStepId) return;
      const delta = event.payload['deltaText'];
      if (typeof delta !== 'string' || delta.length === 0) return;
      setLiveText((previous) => (previous + delta).slice(-MAX_LIVE_TEXT));
      return;
    }

    if (event.type === 'step.completed' && event.stepId === selectedStepId) {
      setLiveText('');
      stepDetail.refresh();
    }

    if (
      event.type.startsWith('step.') ||
      event.type === 'tool.completed' ||
      event.type.startsWith('session.')
    ) {
      scheduleRefresh();
    }
  });

  const copySessionId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  if (detail.loading && !session) {
    return (
      <div className="page page-session">
        <Link className="back-link" to="/sessions">
          ← Flight log
        </Link>
        <LoadingRows rows={2} label="Loading flight" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="page page-session">
        <Link className="back-link" to="/sessions">
          ← Flight log
        </Link>
        <ErrorBanner
          message={detail.error ?? 'The requested flight was not found.'}
          onRetry={detail.refresh}
          retrying={detail.loading}
        />
      </div>
    );
  }

  const totals = session.totals;
  const duration =
    session.durationMs !== undefined
      ? formatDuration(session.durationMs)
      : session.status === 'active'
        ? 'In flight'
        : '—';

  return (
    <div className="page page-session">
      <div className="detail-top">
        <Link className="back-link" to="/sessions">
          <span aria-hidden="true">←</span> Flight log
        </Link>
        <div className="detail-actions">
          <Link className="ghost-button button-small" to={`/sessions/${session.id}/replay`}>
            Replay
          </Link>
          <Link className="ghost-button button-small" to={`/sessions/${session.id}/replay#fork`}>
            Fork
          </Link>
          <Link className="ghost-button button-small" to={`/sessions/${session.id}/trust`}>
            Trust
          </Link>
          <Link className="ghost-button button-small" to={`/sessions/${session.id}/understanding`}>
            Understanding
          </Link>
          <Link className="ghost-button button-small" to={`/sessions/${session.id}/context`}>
            Context
          </Link>
          <Link className="ghost-button button-small" to={`/sessions/${session.id}/handoff`}>
            Handoff
          </Link>
          <button className="ghost-button button-small" type="button" onClick={copySessionId}>
            {copied ? 'Copied' : 'Copy ID'}
          </button>
          <a
            className="ghost-button button-small"
            href={`/api/sessions/${session.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Raw JSON <span aria-hidden="true">↗</span>
          </a>
          <span className="sr-only" role="status">
            {copied ? 'Session ID copied to the clipboard.' : ''}
          </span>
        </div>
      </div>

      <header className="detail-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Flight record <span className="mono detail-id">{shortId(session.id)}</span>
        </p>
        <div className="detail-title-line">
          <h1>{session.title}</h1>
          <StatusBadge status={session.status} />
        </div>
        <div className="detail-meta">
          <span>{modelLabel(session)}</span>
          {session.agent?.name ? <span>{agentLabel(session)}</span> : null}
          <span>
            Started{' '}
            <time dateTime={session.startedAt} title={formatDateTime(session.startedAt)}>
              {formatDateTime(session.startedAt)}
            </time>
          </span>
          <span>{duration}</span>
          <span className="tag">{session.source}</span>
          {session.workspacePath ? (
            <span className="mono detail-path" title={session.workspacePath}>
              {session.workspacePath}
            </span>
          ) : null}
          {session.gitBranch ? <span className="mono">branch {session.gitBranch}</span> : null}
        </div>
      </header>

      {detail.error ? (
        <ErrorBanner message={detail.error} onRetry={detail.refresh} retrying={detail.loading} />
      ) : null}

      <section className="live-tape" aria-label="Recent live activity">
        <p className="tape-label">
          <span
            className={`signal ${liveStatus === 'live' ? 'signal-live' : 'signal-muted'}`}
            aria-hidden="true"
          />
          Activity
        </p>
        {liveEvents.length === 0 ? (
          <p className="tape-empty">
            {liveStatus === 'live'
              ? 'Listening for the next event…'
              : `Live feed ${liveStatus}. Pull updates with retry or reload.`}
          </p>
        ) : (
          <ol className="tape-events">
            {liveEvents.map((event) => (
              <li key={event.sequence} className="tape-event">
                <time dateTime={event.at}>{formatTime(event.at)}</time>
                <span>{eventTypeLabel(event.type)}</span>
              </li>
            ))}
          </ol>
        )}
        <p className={`tape-sync${detail.refreshing ? ' is-syncing' : ''}`}>
          {detail.refreshing ? 'Syncing…' : 'Synced'}
        </p>
      </section>

      <dl className="totals" aria-label="Session totals">
        <div>
          <dt>Steps</dt>
          <dd>{formatNumber(totals.stepCount)}</dd>
          <p>{formatNumber(totals.modelCallCount)} model calls</p>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{formatNumber(totals.toolCallCount)}</dd>
          <p>{pluralize(totals.toolCallCount, 'call')} captured</p>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{formatCompactNumber(sessionTokenTotal(totals))}</dd>
          <p>
            {formatCompactNumber(
              totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
            )}{' '}
            in · {formatCompactNumber(totals.outputTokens)} out
          </p>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>{formatCurrency(totals.totalCostUsd)}</dd>
          <p>
            {totals.unknownCostCalls > 0
              ? `${formatNumber(totals.unknownCostCalls)} unpriced`
              : 'Fully priced'}
          </p>
        </div>
        <div>
          <dt>Cache</dt>
          <dd>{formatCompactNumber(totals.cacheReadTokens + totals.cacheWriteTokens)}</dd>
          <p>
            {formatCompactNumber(totals.cacheReadTokens)} read ·{' '}
            {formatCompactNumber(totals.cacheWriteTokens)} write
          </p>
        </div>
        <div className={totals.errorCount > 0 ? 'has-error' : undefined}>
          <dt>Errors</dt>
          <dd>{formatNumber(totals.errorCount)}</dd>
          <p>{totals.errorCount > 0 ? 'Needs review' : 'Clean flight'}</p>
        </div>
      </dl>

      <div className="workbench">
        <section className="panel timeline-panel" aria-labelledby="timeline-title">
          <div className="panel-head panel-head-tight">
            <div>
              <p className="panel-kicker">Sequence</p>
              <h2 id="timeline-title">Timeline</h2>
            </div>
            <div className="panel-tools">
              <span className="tiny-count">{formatNumber(detail.steps.length)} steps</span>
              <button
                className="follow-button"
                type="button"
                aria-pressed={followLatest}
                onClick={() => setFollowLatest((value) => !value)}
              >
                <span className={`follow-dot${followLatest ? ' is-on' : ''}`} aria-hidden="true" />
                Follow latest
              </button>
            </div>
          </div>
          <StepTimeline
            steps={detail.steps}
            selectedStepId={selectedStepId}
            onSelect={(stepId) => {
              setFollowLatest(false);
              setSelectedStepId(stepId);
            }}
          />
        </section>

        <section className="panel inspector-panel" aria-label="Step inspector">
          <StepInspector step={selectedStep} detail={stepDetail} liveText={liveText} />
        </section>
      </div>
    </div>
  );
}
