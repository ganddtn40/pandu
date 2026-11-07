import type { GuardEvent, GuardRule } from '@cockpit/core';
import { Link } from 'react-router-dom';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { StatusBadge } from '../components/StatusBadge';
import { formatCurrency, formatDateTime, formatRelativeTime } from '../lib/format';
import { useGuards, useLiveRefresh, usePageTitle } from '../lib/hooks';

function SeverityChip({ severity }: { severity: string }) {
  return <span className={`severity-chip severity-${severity}`}>{severity}</span>;
}

function Evidence({ event }: { event: GuardEvent }) {
  const items = event.evidence.slice(0, 3);
  if (items.length === 0) return null;

  return (
    <ul className="guard-evidence">
      {items.map((evidence, index) => (
        <li key={`${event.id}-${String(index)}`}>
          {evidence.field ? <span className="mono">{evidence.field}</span> : null}
          {evidence.excerpt ? <code>{evidence.excerpt}</code> : null}
        </li>
      ))}
    </ul>
  );
}

function RuleRow({
  rule,
  busy,
  onToggle,
}: {
  rule: GuardRule;
  busy: boolean;
  onToggle: (rule: GuardRule) => void;
}) {
  return (
    <li className={`guard-rule${rule.enabled ? '' : ' is-disabled'}`}>
      <div className="guard-rule-main">
        <div className="guard-rule-title">
          <span className="mono">{rule.id}</span>
          {rule.source === 'builtin' ? <span className="tag">built-in</span> : null}
          <SeverityChip severity={rule.severity} />
        </div>
        <p className="guard-rule-name">{rule.name}</p>
        {rule.description ? <p className="guard-rule-description">{rule.description}</p> : null}
        <p className="guard-rule-meta">
          {rule.kind} · action <span className="mono">{rule.action}</span> · priority{' '}
          {rule.priority}
        </p>
      </div>
      <button
        className="ghost-button button-small"
        type="button"
        disabled={busy}
        onClick={() => onToggle(rule)}
      >
        {rule.enabled ? 'Disable' : 'Enable'}
      </button>
    </li>
  );
}

export function GuardsPage() {
  usePageTitle('Guards · Cockpit');
  const guards = useGuards();
  useLiveRefresh(
    guards.refresh,
    500,
    (event) =>
      event.type.startsWith('guard.') ||
      event.type.startsWith('budget.') ||
      event.type === 'analysis.updated',
  );

  const pending = guards.events.filter((event) => event.status === 'pending');
  const recent = guards.events.filter((event) => event.status !== 'pending').slice(0, 40);

  return (
    <div className="page page-guards">
      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Control tower
        </p>
        <h1>
          Guards
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          Run Guard inspects prompts, tool calls, and stored output before they leave or after they
          land. Pause rules hold the request until you approve or deny it.
        </p>
        <div className="page-actions">
          <button
            className="ghost-button button-small"
            type="button"
            onClick={guards.refresh}
            disabled={guards.refreshing}
          >
            {guards.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {guards.error ? (
        <ErrorBanner message={guards.error} onRetry={guards.refresh} retrying={guards.loading} />
      ) : null}
      {guards.actionError ? (
        <ErrorBanner message={guards.actionError} onRetry={guards.clearActionError} />
      ) : null}

      {guards.loading && guards.rules.length === 0 ? (
        <LoadingRows rows={3} label="Loading guards" />
      ) : null}

      <section className="panel" aria-labelledby="approvals-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Held requests</p>
            <h2 id="approvals-title">Pending approvals</h2>
          </div>
          <span className="count-chip">{pending.length}</span>
        </div>

        {pending.length === 0 ? (
          <EmptyState title="Nothing is waiting">
            <p>Pause rules appear here the moment a request is held. No action is required now.</p>
          </EmptyState>
        ) : (
          <ul className="approval-list">
            {pending.map((event) => (
              <li className="approval-card" key={event.id}>
                <div className="approval-head">
                  <SeverityChip severity={event.severity} />
                  <h3>{event.title}</h3>
                  <span className="approval-time">{formatRelativeTime(event.requestedAt)}</span>
                </div>
                <p>{event.description}</p>
                <Evidence event={event} />
                <div className="approval-actions">
                  <button
                    className="primary-button button-small"
                    type="button"
                    disabled={guards.busyId === event.id}
                    onClick={() => void guards.decideEvent(event.id, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    className="ghost-button button-small"
                    type="button"
                    disabled={guards.busyId === event.id}
                    onClick={() => void guards.decideEvent(event.id, 'deny')}
                  >
                    Deny
                  </button>
                  <span className="muted-note">Requested {formatDateTime(event.requestedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="rules-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Policy</p>
            <h2 id="rules-title">Guard rules</h2>
          </div>
          <span className="count-chip">{guards.rules.length}</span>
        </div>
        {guards.rules.length === 0 ? (
          <EmptyState title="No rules installed">
            <p>Built-in rules are seeded when the daemon starts.</p>
          </EmptyState>
        ) : (
          <ul className="guard-rule-list">
            {guards.rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                busy={guards.busyId === rule.id}
                onToggle={(candidate) => void guards.toggleRule(candidate)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="events-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Flight tape</p>
            <h2 id="events-title">Recent guard events</h2>
          </div>
          <span className="count-chip">{guards.events.length}</span>
        </div>
        {recent.length === 0 ? (
          <EmptyState title="No events yet">
            <p>Warnings, redactions, and resolved approvals will show up here.</p>
          </EmptyState>
        ) : (
          <ul className="guard-event-list">
            {recent.map((event) => (
              <li className="guard-event" key={event.id}>
                <div className="guard-event-main">
                  <div className="guard-event-title">
                    <StatusBadge status={event.status} />
                    <SeverityChip severity={event.severity} />
                    <span>{event.title}</span>
                  </div>
                  <p className="guard-event-meta">
                    {event.kind} · <span className="mono">{event.ruleId}</span> ·{' '}
                    {formatDateTime(event.requestedAt)}
                  </p>
                </div>
                {event.sessionId ? (
                  <Link className="ghost-button button-small" to={`/sessions/${event.sessionId}`}>
                    Open flight
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="budgets-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Spending</p>
            <h2 id="budgets-title">Budget policies</h2>
          </div>
          <span className="count-chip">{guards.policies.length}</span>
        </div>
        {guards.policies.length === 0 ? (
          <EmptyState title="No budgets configured">
            <p>
              Add a policy with <span className="mono">cockpit budget add</span> to warn, pause, or
              block a session once spending reaches the limit.
            </p>
          </EmptyState>
        ) : (
          <ul className="budget-list">
            {guards.policies.map((policy) => (
              <li className="budget-row" key={policy.id}>
                <div>
                  <p className="budget-name">{policy.name}</p>
                  <p className="budget-meta">
                    {policy.scope} · {policy.period} · {policy.enforcement} ·{' '}
                    {formatCurrency(policy.limitUsd)}
                    {policy.sessionId ? (
                      <>
                        {' '}
                        · <span className="mono">{policy.sessionId}</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <button
                  className="ghost-button button-small"
                  type="button"
                  disabled={guards.busyId === policy.id}
                  onClick={() => void guards.removePolicy(policy.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
