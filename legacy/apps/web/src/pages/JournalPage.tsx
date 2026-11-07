import { useRef, useState } from 'react';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { useJournal, usePageTitle, useProjects } from '../lib/hooks';

function currentWeekStart(): string {
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday),
  );
  return monday.toISOString().slice(0, 10);
}

export function JournalPage() {
  usePageTitle('Journal · Cockpit');
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const [weekStart, setWeekStart] = useState(currentWeekStart);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  const journal = useJournal(projectId || undefined);
  const selected = journal.selected;

  const copyMarkdown = async (): Promise<void> => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.markdown);
      setCopied(true);
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="page page-journal">
      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Engineering log
        </p>
        <h1>
          Journal
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          A weekly record generated from what actually happened: sessions, spend, files touched,
          guard findings, and understanding debt. Weeks start on Monday in UTC. Regenerating a week
          updates the same entry instead of duplicating it.
        </p>
        <div className="page-actions">
          <label className="field field-inline">
            <span>Project</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-label="Journal project filter"
            >
              <option value="">Workspace</option>
              {projects.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-inline">
            <span>Week start</span>
            <input
              type="date"
              value={weekStart}
              onChange={(event) => setWeekStart(event.target.value)}
              aria-label="Journal week start"
            />
          </label>
          <button
            className="primary-button button-small"
            type="button"
            disabled={journal.generating || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)}
            onClick={() =>
              void journal.generate({
                ...(projectId ? { projectId } : {}),
                weekStart,
              })
            }
          >
            {journal.generating ? 'Writing…' : 'Generate week'}
          </button>
          <button
            className="ghost-button button-small"
            type="button"
            onClick={journal.refresh}
            disabled={journal.refreshing}
          >
            {journal.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {projects.error ? <ErrorBanner message={projects.error} /> : null}
      {journal.error ? (
        <ErrorBanner message={journal.error} onRetry={journal.refresh} retrying={journal.loading} />
      ) : null}
      {journal.actionError ? <ErrorBanner message={journal.actionError} /> : null}

      {journal.loading && journal.entries.length === 0 ? (
        <LoadingRows rows={2} label="Loading journal entries" />
      ) : null}

      {journal.entries.length === 0 && !journal.loading ? (
        <EmptyState title="No journal entries yet">
          <p>
            Generate this week to turn the flight recorder into a readable engineering log. Nothing
            is generated automatically.
          </p>
        </EmptyState>
      ) : null}

      {journal.entries.length > 0 ? (
        <div className="journal-layout">
          <section className="panel journal-index" aria-labelledby="journal-index-title">
            <div className="panel-head panel-head-tight">
              <div>
                <p className="panel-kicker">Weeks</p>
                <h2 id="journal-index-title">Entries</h2>
              </div>
              <span className="count-chip">{journal.entries.length}</span>
            </div>
            <ul className="journal-list">
              {journal.entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    className={`journal-entry${selected?.id === entry.id ? ' is-active' : ''}`}
                    type="button"
                    aria-current={selected?.id === entry.id ? 'true' : undefined}
                    onClick={() => journal.select(entry.id)}
                  >
                    <span className="journal-week mono">{entry.weekStart}</span>
                    <span className="journal-title">{entry.title}</span>
                    <span className="journal-meta">
                      updated {formatRelativeTime(entry.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel journal-document" aria-labelledby="journal-document-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Week of {selected?.weekStart}</p>
                <h2 id="journal-document-title">{selected?.title ?? 'Journal entry'}</h2>
              </div>
              <div className="panel-tools">
                <button
                  className="ghost-button button-small"
                  type="button"
                  onClick={() => void copyMarkdown()}
                  disabled={!selected}
                >
                  {copied ? 'Copied' : 'Copy markdown'}
                </button>
              </div>
            </div>
            {selected ? (
              <>
                <pre className="markdown-block">{selected.markdown}</pre>
                <p className="journal-footnote">
                  Generated {formatDateTime(selected.createdAt)} · updated{' '}
                  {formatDateTime(selected.updatedAt)}
                </p>
              </>
            ) : (
              <EmptyState title="Choose an entry">
                <p>Select a week from the index to read it.</p>
              </EmptyState>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
