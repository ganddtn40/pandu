import { Link, useParams } from 'react-router-dom';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { formatNumber, formatRelativeTime, pluralize } from '../lib/format';
import { useDebt, useLiveRefresh, usePageTitle } from '../lib/hooks';

function DebtMeter({ reviewedPercent }: { reviewedPercent: number }) {
  const clamped = Math.max(0, Math.min(100, reviewedPercent));
  return (
    <div className="debt-meter" role="img" aria-label={`${reviewedPercent}% of AI lines reviewed`}>
      <span className="debt-meter-fill" style={{ width: `${String(clamped)}%` }} />
    </div>
  );
}

export function DebtPage() {
  const { id } = useParams<{ id: string }>();
  const debt = useDebt(id);
  usePageTitle(id ? 'Session understanding · Cockpit' : 'Understanding debt · Cockpit');
  useLiveRefresh(
    debt.refresh,
    500,
    (event) =>
      event.type === 'understanding.updated' ||
      event.type === 'session.updated' ||
      event.type === 'analysis.updated',
  );

  const summary = debt.summary;

  return (
    <div className="page page-debt">
      <div className="detail-top">
        {id ? (
          <Link className="back-link" to={`/sessions/${id}`}>
            <span aria-hidden="true">←</span> Flight
          </Link>
        ) : (
          <span className="back-link is-muted" aria-hidden="true">
            Understanding
          </span>
        )}
        <div className="detail-actions">
          <button
            className="ghost-button button-small"
            type="button"
            onClick={debt.refresh}
            disabled={debt.refreshing}
          >
            {debt.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {id ? (
            <Link className="ghost-button button-small" to={`/sessions/${id}/context`}>
              Context Doctor
            </Link>
          ) : null}
        </div>
      </div>

      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Understanding {id ? '· this flight' : '· workspace'}
        </p>
        <h1>
          {id ? 'Session debt' : 'Understanding debt'}
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          AI-authored lines are attributed from git snapshots, not from the agent&apos;s summary.
          Debt is what you have not read yet. Acknowledge a file only when you could explain it to
          someone else.
        </p>
      </header>

      {debt.error ? (
        <ErrorBanner message={debt.error} onRetry={debt.refresh} retrying={debt.loading} />
      ) : null}

      {debt.loading && !summary ? (
        <LoadingRows rows={2} label="Loading understanding debt" />
      ) : null}

      {summary ? (
        <>
          <section className="debt-hero" aria-label="Understanding debt summary">
            <div className="debt-score">
              <span className="debt-number">{summary.debtPercent}%</span>
              <span className="debt-label">unreviewed</span>
              <DebtMeter reviewedPercent={summary.reviewedPercent} />
            </div>
            <dl className="debt-facts">
              <div>
                <dt>AI lines</dt>
                <dd>{formatNumber(summary.totalAiLines)}</dd>
              </div>
              <div>
                <dt>Reviewed</dt>
                <dd>{formatNumber(summary.reviewedAiLines)}</dd>
              </div>
              <div>
                <dt>Files</dt>
                <dd>{formatNumber(summary.fileCount)}</dd>
              </div>
              <div>
                <dt>Unseen</dt>
                <dd>{formatNumber(summary.unseenFiles)}</dd>
              </div>
              <div>
                <dt>Acknowledged</dt>
                <dd>{formatNumber(summary.acknowledgedFiles)}</dd>
              </div>
            </dl>
          </section>

          {summary.neverReviewedHotspots.length > 0 ? (
            <section className="panel" aria-labelledby="hotspots-title">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">Start here</p>
                  <h2 id="hotspots-title">Never-reviewed hotspots</h2>
                </div>
                <span className="count-chip">{summary.neverReviewedHotspots.length}</span>
              </div>
              <ul className="debt-hotspots">
                {summary.neverReviewedHotspots.map((hotspot) => (
                  <li key={hotspot.path}>
                    <span className="mono debt-path">{hotspot.path}</span>
                    <span className="debt-hotspot-meta">
                      {formatNumber(hotspot.unreviewedLines)}{' '}
                      {pluralize(hotspot.unreviewedLines, 'line')} unreviewed · score{' '}
                      {hotspot.fileScore}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel" aria-labelledby="debt-files-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Ledger</p>
                <h2 id="debt-files-title">AI-authored files</h2>
              </div>
              <span className="count-chip">{debt.files.length}</span>
            </div>
            {debt.files.length === 0 ? (
              <EmptyState title="No AI-authored files yet">
                <p>
                  Cockpit records provenance from git snapshots. Run an agent through the proxy and
                  this ledger fills itself.
                </p>
              </EmptyState>
            ) : (
              <ul className="debt-file-list">
                {debt.files.map((file) => (
                  <li key={file.id} className={`debt-file debt-status-${file.status}`}>
                    <div className="debt-file-main">
                      <Link className="debt-file-path mono" to={`/understanding/${file.id}`}>
                        {file.path}
                      </Link>
                      <p className="debt-file-meta">
                        <span className={`status-chip debt-chip-${file.status}`}>
                          {file.status}
                        </span>
                        <span>
                          {formatNumber(file.reviewedLines)}/{formatNumber(file.aiLines)} AI lines
                          reviewed
                        </span>
                        <span>score {file.fileScore}</span>
                        <span>touched {formatRelativeTime(file.lastTouchedAt)}</span>
                      </p>
                    </div>
                    <div className="debt-file-progress" aria-hidden="true">
                      <span
                        className="debt-file-progress-fill"
                        style={{
                          width: `${String(
                            file.aiLines === 0
                              ? 100
                              : Math.round((file.reviewedLines / file.aiLines) * 100),
                          )}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
