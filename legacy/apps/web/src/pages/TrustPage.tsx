import type { CheatFinding } from '@cockpit/core';
import { Link, useParams } from 'react-router-dom';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { formatCurrency, formatDateTime } from '../lib/format';
import { usePageTitle, useTrust } from '../lib/hooks';
import { shortId } from '../lib/session';

function SeverityChip({ severity }: { severity: string }) {
  return <span className={`severity-chip severity-${severity}`}>{severity}</span>;
}

function FindingCard({ finding }: { finding: CheatFinding }) {
  return (
    <li className="finding-card">
      <div className="finding-head">
        <SeverityChip severity={finding.severity} />
        <h3>{finding.title}</h3>
        <span className="finding-category">{finding.category}</span>
      </div>
      <p>{finding.detail}</p>
      <p className="finding-meta">
        Detector <span className="mono">{finding.detector}</span> · confidence{' '}
        {Math.round(finding.confidence * 100)}%
      </p>
      {finding.evidence.length > 0 ? (
        <ul className="finding-evidence">
          {finding.evidence.slice(0, 4).map((evidence, index) => (
            <li key={`${finding.id}-${String(index)}`}>
              <span className="mono">
                {evidence.filePath}
                {evidence.startLine ? `:${evidence.startLine}` : ''}
              </span>
              <code>{evidence.excerpt}</code>
              {evidence.explanation ? <p>{evidence.explanation}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {finding.suggestion ? <p className="finding-fix">Fix: {finding.suggestion}</p> : null}
    </li>
  );
}

export function TrustPage() {
  const { id = '' } = useParams<{ id: string }>();
  const trust = useTrust(id);
  usePageTitle('Trust report · Cockpit');

  const analysis = trust.analysis;
  const score = analysis?.trustScore ?? 100;

  return (
    <div className="page page-trust">
      <div className="detail-top">
        <Link className="back-link" to={`/sessions/${id}`}>
          <span aria-hidden="true">←</span> Flight
        </Link>
        <div className="detail-actions">
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => void trust.recompute()}
            disabled={trust.analyzing}
          >
            {trust.analyzing ? 'Analyzing…' : 'Re-analyze'}
          </button>
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => void trust.scan()}
            disabled={trust.scanning}
          >
            {trust.scanning ? 'Scanning…' : 'Scan for secrets'}
          </button>
          <Link className="ghost-button button-small" to={`/sessions/${id}/replay`}>
            Replay
          </Link>
        </div>
      </div>

      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Trust report <span className="mono detail-id">{shortId(id)}</span>
        </p>
        <h1>
          Did the agent earn it
          <span className="title-dot" aria-hidden="true">
            ?
          </span>
        </h1>
        <p className="page-lede">
          Cheat Detector reads the recorded diffs, not the agent&apos;s claims. Every deduction
          points at a concrete line you can inspect in the replay.
        </p>
      </header>

      {trust.error ? (
        <ErrorBanner message={trust.error} onRetry={trust.refresh} retrying={trust.loading} />
      ) : null}
      {trust.actionError ? (
        <ErrorBanner message={trust.actionError} onRetry={trust.refresh} />
      ) : null}

      {trust.loading && !analysis ? <LoadingRows rows={2} label="Loading trust report" /> : null}

      <section className="trust-hero" aria-label="Trust score">
        <div className={`trust-score grade-${analysis?.grade ?? 'A'}`}>
          <span className="trust-number">{analysis ? score : '—'}</span>
          <span className="trust-scale">/ 100</span>
          <span className="trust-grade">Grade {analysis?.grade ?? '—'}</span>
        </div>
        <dl className="trust-facts">
          <div>
            <dt>Findings</dt>
            <dd>{analysis ? analysis.findings.length : 0}</dd>
          </div>
          <div>
            <dt>Files examined</dt>
            <dd>{analysis?.filesExamined ?? 0}</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>{analysis ? formatDateTime(analysis.generatedAt) : 'Not analyzed'}</dd>
          </div>
        </dl>
      </section>

      <section className="panel" aria-labelledby="findings-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Evidence</p>
            <h2 id="findings-title">Findings</h2>
          </div>
          <span className="count-chip">{analysis?.findings.length ?? 0}</span>
        </div>
        {!analysis ? (
          <EmptyState title="No analysis yet">
            <p>
              Re-analyze the session to inspect its diffs for deleted tests, skipped assertions, and
              stubs presented as done.
            </p>
          </EmptyState>
        ) : analysis.findings.length === 0 ? (
          <EmptyState title="No cheating detected">
            <p>
              No deleted or skipped tests, empty catches, suppressions, hardcoded expectations, or
              stub-as-done patterns were found in the recorded diffs.
            </p>
          </EmptyState>
        ) : (
          <ul className="finding-list">
            {analysis.findings.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="secret-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Secret scanner</p>
            <h2 id="secret-title">Stored secrets</h2>
          </div>
        </div>
        {trust.scanResult ? (
          trust.scanResult.findings.length === 0 ? (
            <EmptyState title="Clean scan">
              <p>
                {trust.scanResult.filesExamined} recorded step(s) were scanned. No recognizable
                secret patterns were found.
              </p>
            </EmptyState>
          ) : (
            <ul className="secret-list">
              {trust.scanResult.findings.map((finding, index) => (
                <li key={`${finding.type}-${String(index)}`}>
                  <SeverityChip severity={finding.action === 'pause' ? 'critical' : 'high'} />
                  <span className="mono">{finding.type}</span>
                  <span>{finding.location}</span>
                  <code>{finding.preview}</code>
                </li>
              ))}
            </ul>
          )
        ) : (
          <EmptyState title="Not scanned in this view">
            <p>Run a scan to look for secrets in recorded prompts, responses, and tool calls.</p>
          </EmptyState>
        )}
      </section>

      <section className="panel" aria-labelledby="budget-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Spending</p>
            <h2 id="budget-title">Budget status</h2>
          </div>
        </div>
        {trust.budgets.length === 0 ? (
          <EmptyState title="No budgets apply">
            <p>
              Create a policy from the Guards page or the CLI to track this session&apos;s spend.
            </p>
          </EmptyState>
        ) : (
          <ul className="budget-status-list">
            {trust.budgets.map((status) => {
              const state = status.exceeded ? 'exceeded' : status.warning ? 'warning' : 'ok';
              return (
                <li key={status.policyId}>
                  <div className="budget-status-head">
                    <span>{status.name}</span>
                    <span className={`budget-state budget-${state}`}>{state}</span>
                  </div>
                  <p className="budget-meta">
                    {formatCurrency(status.spentUsd)} of {formatCurrency(status.limitUsd)} ·{' '}
                    {Math.round(status.usageRatio * 100)}% · {status.period}
                  </p>
                  <div
                    className="budget-bar"
                    role="progressbar"
                    aria-label={`${status.name} budget used`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, Math.round(status.usageRatio * 100))}
                  >
                    <span style={{ width: `${Math.min(100, status.usageRatio * 100)}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
