import { useState } from 'react';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import {
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatNumber,
  pluralize,
} from '../lib/format';
import { useAnalytics, usePageTitle, useProjects } from '../lib/hooks';

const DAY_OPTIONS = [7, 14, 30, 90, 365] as const;

function DailyChart({
  daily,
}: {
  daily: { date: string; stepCount: number; totalCostUsd: number; errorCount: number }[];
}) {
  const maxSteps = Math.max(1, ...daily.map((point) => point.stepCount));

  return (
    <div className="analytics-chart" role="img" aria-label="Steps and spend per UTC day">
      {daily.map((point) => {
        const height = Math.max(2, Math.round((point.stepCount / maxSteps) * 100));
        return (
          <div className="analytics-bar-column" key={point.date}>
            <div className="analytics-bar-track">
              <span
                className={`analytics-bar${point.errorCount > 0 ? ' has-errors' : ''}`}
                style={{ height: `${String(height)}%` }}
                title={`${point.date}: ${formatNumber(point.stepCount)} ${pluralize(
                  point.stepCount,
                  'step',
                )}, ${formatCurrency(point.totalCostUsd)}${
                  point.errorCount > 0 ? `, ${formatNumber(point.errorCount)} errors` : ''
                }`}
              />
            </div>
            <span className="analytics-bar-label mono">{point.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AnalyticsPage() {
  usePageTitle('Analytics · Cockpit');
  const [days, setDays] = useState<number>(30);
  const [projectId, setProjectId] = useState('');
  const projects = useProjects();
  const analytics = useAnalytics({
    days,
    ...(projectId ? { projectId } : {}),
  });

  const data = analytics.data;
  const totalTokens = data
    ? data.totals.inputTokens +
      data.totals.outputTokens +
      data.totals.cacheReadTokens +
      data.totals.cacheWriteTokens
    : 0;

  return (
    <div className="page page-analytics">
      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Flight data
        </p>
        <h1>
          Analytics
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          Sessions, steps, tokens, and spend grouped by UTC day. Every number comes from the local
          SQLite ledger; nothing is sampled or sent anywhere.
        </p>
        <div className="page-actions">
          <label className="field field-inline">
            <span>Window</span>
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              aria-label="Analytics window in days"
            >
              {DAY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} days
                </option>
              ))}
            </select>
          </label>
          <label className="field field-inline">
            <span>Project</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-label="Filter analytics by project"
            >
              <option value="">All projects</option>
              {projects.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-button button-small"
            type="button"
            onClick={analytics.refresh}
            disabled={analytics.refreshing}
          >
            {analytics.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {analytics.error ? (
        <ErrorBanner
          message={analytics.error}
          onRetry={analytics.refresh}
          retrying={analytics.loading}
        />
      ) : null}
      {projects.error ? <ErrorBanner message={projects.error} /> : null}

      {analytics.loading && !data ? <LoadingRows rows={3} label="Loading analytics" /> : null}

      {data ? (
        <>
          <dl className="totals analytics-totals" aria-label="Analytics totals">
            <div>
              <dt>Sessions</dt>
              <dd>{formatNumber(data.totals.sessionCount)}</dd>
              <p>In the selected window</p>
            </div>
            <div>
              <dt>Steps</dt>
              <dd>{formatNumber(data.totals.stepCount)}</dd>
              <p>{formatNumber(data.totals.toolCallCount)} tool calls</p>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{formatCompactNumber(totalTokens)}</dd>
              <p>
                {formatCompactNumber(data.totals.inputTokens)} in ·{' '}
                {formatCompactNumber(data.totals.outputTokens)} out
              </p>
            </div>
            <div>
              <dt>Cache</dt>
              <dd>
                {formatCompactNumber(data.totals.cacheReadTokens + data.totals.cacheWriteTokens)}
              </dd>
              <p>
                {formatCompactNumber(data.totals.cacheReadTokens)} read ·{' '}
                {formatCompactNumber(data.totals.cacheWriteTokens)} write
              </p>
            </div>
            <div>
              <dt>Spend</dt>
              <dd>{formatCurrency(data.totals.totalCostUsd)}</dd>
              <p>
                {data.totals.unknownCostCalls > 0
                  ? `${formatNumber(data.totals.unknownCostCalls)} unpriced`
                  : 'Fully priced'}
              </p>
            </div>
            <div className={data.totals.errorCount > 0 ? 'has-error' : undefined}>
              <dt>Errors</dt>
              <dd>{formatNumber(data.totals.errorCount)}</dd>
              <p>{data.totals.errorCount > 0 ? 'Needs review' : 'Clean window'}</p>
            </div>
          </dl>

          <section className="panel" aria-labelledby="daily-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">UTC calendar</p>
                <h2 id="daily-title">Daily activity</h2>
              </div>
              <span className="count-chip">{data.range.days} days</span>
            </div>
            <div className="analytics-chart-wrap">
              <p className="analytics-range mono">
                {data.range.from.slice(0, 10)} → {data.range.to.slice(0, 10)}
              </p>
              {data.daily.length === 0 ? (
                <EmptyState title="No daily buckets">
                  <p>The daemon returned an empty range.</p>
                </EmptyState>
              ) : (
                <DailyChart daily={data.daily} />
              )}
            </div>
            {data.daily.length > 0 ? (
              <div className="table-scroll">
                <table className="data-table analytics-table">
                  <caption className="sr-only">Steps, tokens, and spend per UTC day</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Sessions</th>
                      <th scope="col">Steps</th>
                      <th scope="col">Tokens in</th>
                      <th scope="col">Tokens out</th>
                      <th scope="col">Spend</th>
                      <th scope="col">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily.map((point) => (
                      <tr key={point.date}>
                        <th scope="row" className="mono">
                          {point.date}
                        </th>
                        <td>{formatNumber(point.sessionCount)}</td>
                        <td>{formatNumber(point.stepCount)}</td>
                        <td>{formatCompactNumber(point.inputTokens)}</td>
                        <td>{formatCompactNumber(point.outputTokens)}</td>
                        <td>{formatCurrency(point.totalCostUsd)}</td>
                        <td className={point.errorCount > 0 ? 'cell-error' : undefined}>
                          {formatNumber(point.errorCount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <div className="analytics-columns">
            <section className="panel" aria-labelledby="models-title">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">By model</p>
                  <h2 id="models-title">Models</h2>
                </div>
                <span className="count-chip">{data.models.length}</span>
              </div>
              {data.models.length === 0 ? (
                <EmptyState title="No model calls yet">
                  <p>Route an agent through the proxy and model usage appears here.</p>
                </EmptyState>
              ) : (
                <ul className="breakdown-list">
                  {data.models.map((model) => (
                    <li
                      className="breakdown-row"
                      key={`${model.provider ?? 'unknown'}/${model.model}`}
                    >
                      <div className="breakdown-main">
                        <p className="breakdown-name mono">
                          {model.provider ? `${model.provider}/${model.model}` : model.model}
                        </p>
                        <p className="breakdown-meta">
                          {formatNumber(model.sessionCount)}{' '}
                          {pluralize(model.sessionCount, 'session')} ·{' '}
                          {formatNumber(model.stepCount)} {pluralize(model.stepCount, 'step')} ·{' '}
                          {formatCompactNumber(model.inputTokens + model.outputTokens)} tokens
                        </p>
                      </div>
                      <span className="breakdown-value">{formatCurrency(model.totalCostUsd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel" aria-labelledby="agents-title">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">By agent</p>
                  <h2 id="agents-title">Agents</h2>
                </div>
                <span className="count-chip">{data.agents.length}</span>
              </div>
              {data.agents.length === 0 ? (
                <EmptyState title="No agents detected">
                  <p>Agent headers are captured with every proxied request.</p>
                </EmptyState>
              ) : (
                <ul className="breakdown-list">
                  {data.agents.map((agent) => (
                    <li className="breakdown-row" key={agent.agent}>
                      <div className="breakdown-main">
                        <p className="breakdown-name">{agent.agent}</p>
                        <p className="breakdown-meta">
                          {formatNumber(agent.sessionCount)}{' '}
                          {pluralize(agent.sessionCount, 'session')} ·{' '}
                          {formatNumber(agent.stepCount)} {pluralize(agent.stepCount, 'step')}
                        </p>
                      </div>
                      <span className="breakdown-value">{formatCurrency(agent.totalCostUsd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <p className="page-foot">
            <span>Window ends {formatDateTime(data.range.to)}</span>
            <span>UTC buckets</span>
            <span>Zero telemetry</span>
          </p>
        </>
      ) : null}
    </div>
  );
}
