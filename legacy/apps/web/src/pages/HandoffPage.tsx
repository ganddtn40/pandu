import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { useHandoffs, usePageTitle, useSessionDetail } from '../lib/hooks';

export function HandoffPage() {
  const { id = '' } = useParams<{ id: string }>();
  const detail = useSessionDetail(id, { stepsLimit: 500 });
  const handoffs = useHandoffs(id);
  const [stepId, setStepId] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  const session = detail.session;
  const selected = handoffs.selected;
  usePageTitle(session ? `Handoff · ${session.title} · Cockpit` : 'Handoff · Cockpit');

  const copyBrief = async (): Promise<void> => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.contentMarkdown);
      setCopied(true);
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  if (detail.loading && !session) {
    return (
      <div className="page page-handoff">
        <Link className="back-link" to={`/sessions/${id}`}>
          ← Flight
        </Link>
        <LoadingRows rows={2} label="Loading handoff" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="page page-handoff">
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

  return (
    <div className="page page-handoff">
      <div className="detail-top">
        <Link className="back-link" to={`/sessions/${session.id}`}>
          <span aria-hidden="true">←</span> Flight
        </Link>
        <div className="detail-actions">
          <Link className="ghost-button button-small" to={`/sessions/${session.id}/replay`}>
            Replay
          </Link>
          <Link className="ghost-button button-small" to={`/sessions/${session.id}/understanding`}>
            Understanding
          </Link>
          <button
            className="ghost-button button-small"
            type="button"
            onClick={handoffs.refresh}
            disabled={handoffs.refreshing}
          >
            {handoffs.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Continuation brief
        </p>
        <h1>
          Handoff
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          A deterministic brief for the next person or agent: what this session set out to do, what
          changed, what is still unreviewed, and where to resume. Built from recorded steps and git
          snapshots, without an LLM call.
        </p>
        <div className="page-actions">
          <label className="field field-inline">
            <span>Resume after</span>
            <select
              value={stepId}
              onChange={(event) => setStepId(event.target.value)}
              aria-label="Generate handoff after a specific step"
            >
              <option value="">End of session</option>
              {detail.steps.map((step) => (
                <option key={step.id} value={step.id}>
                  #{step.seq + 1} · {step.kind} · {step.status}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary-button button-small"
            type="button"
            disabled={handoffs.generating}
            onClick={() => void handoffs.generate(stepId || undefined)}
          >
            {handoffs.generating ? 'Writing…' : 'Generate brief'}
          </button>
        </div>
      </header>

      {detail.error ? (
        <ErrorBanner message={detail.error} onRetry={detail.refresh} retrying={detail.loading} />
      ) : null}
      {handoffs.error ? (
        <ErrorBanner
          message={handoffs.error}
          onRetry={handoffs.refresh}
          retrying={handoffs.loading}
        />
      ) : null}
      {handoffs.actionError ? <ErrorBanner message={handoffs.actionError} /> : null}

      {handoffs.loading && handoffs.briefs.length === 0 ? (
        <LoadingRows rows={2} label="Loading handoff briefs" />
      ) : null}

      {handoffs.briefs.length === 0 && !handoffs.loading ? (
        <EmptyState title="No handoff briefs yet">
          <p>
            Generate one when you pause work or pass the session on. Choose a step above to stop the
            brief at that point.
          </p>
        </EmptyState>
      ) : null}

      {handoffs.briefs.length > 0 ? (
        <div className="journal-layout handoff-layout">
          <section className="panel journal-index" aria-labelledby="handoff-index-title">
            <div className="panel-head panel-head-tight">
              <div>
                <p className="panel-kicker">Briefs</p>
                <h2 id="handoff-index-title">Generated</h2>
              </div>
              <span className="count-chip">{handoffs.briefs.length}</span>
            </div>
            <ul className="journal-list">
              {handoffs.briefs.map((brief) => (
                <li key={brief.id}>
                  <button
                    className={`journal-entry${selected?.id === brief.id ? ' is-active' : ''}`}
                    type="button"
                    aria-current={selected?.id === brief.id ? 'true' : undefined}
                    onClick={() => handoffs.select(brief.id)}
                  >
                    <span className="journal-week mono">
                      {formatRelativeTime(brief.generatedAt)}
                    </span>
                    <span className="journal-title">{brief.title}</span>
                    <span className="journal-meta">{formatDateTime(brief.generatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel journal-document" aria-labelledby="handoff-document-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Ready to paste</p>
                <h2 id="handoff-document-title">{selected?.title ?? 'Handoff brief'}</h2>
              </div>
              <div className="panel-tools">
                <button
                  className="ghost-button button-small"
                  type="button"
                  onClick={() => void copyBrief()}
                  disabled={!selected}
                >
                  {copied ? 'Copied' : 'Copy markdown'}
                </button>
              </div>
            </div>
            {selected ? (
              <>
                <pre className="markdown-block">{selected.contentMarkdown}</pre>
                <p className="journal-footnote">
                  Generated {formatDateTime(selected.generatedAt)} · {selected.id}
                </p>
              </>
            ) : (
              <EmptyState title="Choose a brief">
                <p>Select a generated brief from the index.</p>
              </EmptyState>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
