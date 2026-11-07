import { Link, useParams } from 'react-router-dom';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { formatDateTime, formatNumber } from '../lib/format';
import { useContextDoctor, useLiveRefresh, usePageTitle } from '../lib/hooks';

export function ContextPage() {
  const { id = '' } = useParams<{ id: string }>();
  const doctor = useContextDoctor(id);
  usePageTitle('Context Doctor · Cockpit');
  useLiveRefresh(
    doctor.refresh,
    700,
    (event) => event.type === 'step.completed' || event.type === 'session.updated',
  );

  const context = doctor.context;
  const detail = doctor.detail;
  const latest = context?.latest ?? null;

  return (
    <div className="page page-context">
      <div className="detail-top">
        <Link className="back-link" to={`/sessions/${id}`}>
          <span aria-hidden="true">←</span> Flight
        </Link>
        <div className="detail-actions">
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => void doctor.recompute()}
            disabled={doctor.recomputing}
          >
            {doctor.recomputing ? 'Recomputing…' : 'Recompute'}
          </button>
          <Link className="ghost-button button-small" to={`/sessions/${id}/understanding`}>
            Understanding
          </Link>
          <Link className="ghost-button button-small" to={`/sessions/${id}/replay`}>
            Replay
          </Link>
        </div>
      </div>

      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Context Doctor
        </p>
        <h1>
          What did the agent actually read
          <span className="title-dot" aria-hidden="true">
            ?
          </span>
        </h1>
        <p className="page-lede">
          Token estimates are deterministic (four characters per token) and provider usage stays
          authoritative. Use the shape, not the decimals: what dominates, what repeats, and what
          went stale.
        </p>
      </header>

      {doctor.error ? (
        <ErrorBanner message={doctor.error} onRetry={doctor.refresh} retrying={doctor.loading} />
      ) : null}
      {doctor.actionError ? (
        <ErrorBanner message={doctor.actionError} onRetry={doctor.refresh} />
      ) : null}

      {doctor.loading && !context ? (
        <LoadingRows rows={2} label="Loading context snapshots" />
      ) : null}

      {context ? (
        <>
          <section className="context-hero" aria-label="Latest context usage">
            <div className="context-gauge">
              <span className="context-total">
                {latest ? formatNumber(latest.totalTokens) : '—'}
              </span>
              <span className="context-caption">estimated tokens</span>
              {latest?.contextWindow ? (
                <span className="context-window">
                  {latest.utilizationPercent}% of {formatNumber(latest.contextWindow)}
                </span>
              ) : (
                <span className="context-window">context window unknown</span>
              )}
            </div>
            <dl className="context-facts">
              <div>
                <dt>Snapshots</dt>
                <dd>{context.snapshots.length}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{latest?.model ?? 'unknown'}</dd>
              </div>
              <div>
                <dt>Measured</dt>
                <dd>{latest ? formatDateTime(latest.measuredAt) : 'Not measured'}</dd>
              </div>
            </dl>
          </section>

          <section className="panel" aria-labelledby="snapshots-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Timeline</p>
                <h2 id="snapshots-title">Requests</h2>
              </div>
              <span className="count-chip">{context.snapshots.length}</span>
            </div>
            {context.snapshots.length === 0 ? (
              <EmptyState title="No context snapshots yet">
                <p>
                  Cockpit captures one snapshot when each recorded model step begins. Recompute to
                  rebuild them from the stored requests.
                </p>
              </EmptyState>
            ) : (
              <ul className="context-snapshot-list">
                {context.snapshots.map((snapshot, index) => {
                  const selected = snapshot.id === doctor.selectedSnapshotId;
                  return (
                    <li key={snapshot.id}>
                      <button
                        type="button"
                        className={`context-snapshot${selected ? ' is-selected' : ''}`}
                        onClick={() => doctor.selectSnapshot(snapshot.id)}
                        aria-pressed={selected}
                      >
                        <span className="context-snapshot-index mono">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="context-snapshot-main">
                          <span>{formatNumber(snapshot.totalTokens)} tokens</span>
                          <span className="context-snapshot-meta">
                            {formatDateTime(snapshot.measuredAt)}
                            {snapshot.model ? ` · ${snapshot.model}` : ''}
                            {snapshot.utilizationPercent !== undefined
                              ? ` · ${snapshot.utilizationPercent}%`
                              : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {detail ? (
            <>
              <section className="panel" aria-labelledby="segments-title">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">Composition</p>
                    <h2 id="segments-title">Where the tokens went</h2>
                  </div>
                  <span className="count-chip">{detail.segments.length}</span>
                </div>
                {detail.segments.length === 0 ? (
                  <EmptyState title="No segments attributed">
                    <p>The stored request had no messages Cockpit could classify.</p>
                  </EmptyState>
                ) : (
                  <ul className="context-segment-list">
                    {detail.segments.map((segment) => (
                      <li key={segment.id}>
                        <div className="context-segment-head">
                          <span className={`context-category context-${segment.category}`}>
                            {segment.category}
                          </span>
                          <span className="context-segment-label">{segment.label}</span>
                          <span className="context-segment-tokens mono">
                            {formatNumber(segment.tokens)} · {segment.percent}%
                          </span>
                        </div>
                        <div className="context-bar" aria-hidden="true">
                          <span
                            className={`context-bar-fill context-${segment.category}`}
                            style={{ width: `${String(Math.min(100, segment.percent))}%` }}
                          />
                        </div>
                        {segment.sourcePath ? (
                          <p className="context-source mono">{segment.sourcePath}</p>
                        ) : null}
                        {segment.preview ? (
                          <p className="context-preview">{segment.preview}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel" aria-labelledby="insights-title">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">Diagnosis</p>
                    <h2 id="insights-title">Context insights</h2>
                  </div>
                  <span className="count-chip">{detail.insights.length}</span>
                </div>
                {detail.insights.length === 0 ? (
                  <EmptyState title="No context problems detected">
                    <p>
                      No duplicate or conflicting instructions, stale files, oversized tool output,
                      or history bloat crossed the current thresholds.
                    </p>
                  </EmptyState>
                ) : (
                  <ul className="context-insight-list">
                    {detail.insights.map((insight) => (
                      <li
                        key={insight.id}
                        className={`context-insight severity-${insight.severity}`}
                      >
                        <div className="context-insight-head">
                          <span className={`severity-chip severity-${insight.severity}`}>
                            {insight.severity}
                          </span>
                          <h3>{insight.title}</h3>
                          <span className="context-insight-type mono">{insight.type}</span>
                        </div>
                        <p>{insight.detail}</p>
                        {insight.paths.length > 0 ? (
                          <p className="context-insight-paths mono">{insight.paths.join(', ')}</p>
                        ) : null}
                        {insight.estimatedSavingsTokens !== undefined ? (
                          <p className="context-insight-savings">
                            Estimated savings: {formatNumber(insight.estimatedSavingsTokens)} tokens
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
