import {
  BRAIN_FORMATS,
  BRAIN_FORMAT_LABELS,
  BRAIN_FORMAT_PATHS,
  type BrainFormat,
} from '@cockpit/core';
import { useState } from 'react';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { useBrain, usePageTitle, useProjects } from '../lib/hooks';

function outputState(output: {
  drifted: boolean;
  existsOnDisk: boolean;
  syncedAt?: string | undefined;
}): { label: string; tone: string } {
  if (output.drifted) return { label: 'drift', tone: 'warn' };
  if (output.existsOnDisk && output.syncedAt) return { label: 'synced', tone: 'ok' };
  if (output.existsOnDisk) return { label: 'on disk', tone: 'muted' };
  return { label: 'not written', tone: 'muted' };
}

export function BrainPage() {
  usePageTitle('Project Brain · Cockpit');
  const projects = useProjects();
  const [projectChoice, setProjectChoice] = useState('');
  const [formats, setFormats] = useState<BrainFormat[]>([...BRAIN_FORMATS]);
  const [force, setForce] = useState(false);

  const activeProjectId = projectChoice || projects.projects[0]?.id || null;
  const brain = useBrain(activeProjectId);
  const status = brain.status;

  const toggleFormat = (format: BrainFormat): void => {
    setFormats((previous) =>
      previous.includes(format)
        ? previous.filter((item) => item !== format)
        : [...previous, format],
    );
  };

  return (
    <div className="page page-brain">
      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Instruction layer
        </p>
        <h1>
          Project Brain
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          Cockpit reads the repository — manifests, scripts, languages, and directory markers — and
          generates the instruction files agents expect. Nothing is sent to a model. Sync refuses to
          overwrite a file you edited unless you ask it to.
        </p>
        <div className="page-actions">
          <label className="field field-inline">
            <span>Project</span>
            <select
              value={activeProjectId ?? ''}
              onChange={(event) => setProjectChoice(event.target.value)}
              aria-label="Project to generate a brain for"
            >
              {projects.projects.length === 0 ? <option value="">No projects yet</option> : null}
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
            onClick={brain.refresh}
            disabled={brain.refreshing || activeProjectId === null}
          >
            {brain.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {projects.error ? (
        <ErrorBanner
          message={projects.error}
          onRetry={projects.refresh}
          retrying={projects.loading}
        />
      ) : null}
      {brain.error ? (
        <ErrorBanner message={brain.error} onRetry={brain.refresh} retrying={brain.loading} />
      ) : null}
      {brain.actionError ? (
        <ErrorBanner message={brain.actionError} onRetry={brain.clearActionError} />
      ) : null}

      {projects.loading && projects.projects.length === 0 ? (
        <LoadingRows rows={2} label="Loading projects" />
      ) : null}

      {!projects.loading && projects.projects.length === 0 ? (
        <EmptyState title="No projects recorded">
          <p>
            Run an agent through Cockpit once. The workspace path becomes a project, and Project
            Brain can then read it.
          </p>
        </EmptyState>
      ) : null}

      {activeProjectId && brain.loading && !status ? (
        <LoadingRows rows={3} label="Reading the project" />
      ) : null}

      {status ? (
        <>
          <section className="panel" aria-labelledby="brain-generate-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Generate</p>
                <h2 id="brain-generate-title">Instruction files</h2>
              </div>
              <span className="count-chip">{formats.length} formats</span>
            </div>
            <div className="brain-controls">
              <fieldset className="brain-formats">
                <legend>Formats</legend>
                {BRAIN_FORMATS.map((format) => (
                  <label className="checkbox-field" key={format}>
                    <input
                      type="checkbox"
                      checked={formats.includes(format)}
                      onChange={() => toggleFormat(format)}
                    />
                    <span>{BRAIN_FORMAT_LABELS[format]}</span>
                    <code>{BRAIN_FORMAT_PATHS[format]}</code>
                  </label>
                ))}
              </fieldset>
              <div className="brain-actions">
                <button
                  className="primary-button button-small"
                  type="button"
                  disabled={brain.generating || formats.length === 0}
                  onClick={() => void brain.generate(formats)}
                >
                  {brain.generating ? 'Generating…' : 'Generate'}
                </button>
                <button
                  className="ghost-button button-small"
                  type="button"
                  disabled={brain.syncing || formats.length === 0}
                  onClick={() => void brain.sync({ formats, dryRun: true, force })}
                >
                  {brain.syncing ? 'Checking…' : 'Dry run'}
                </button>
                <button
                  className="ghost-button button-small"
                  type="button"
                  disabled={brain.syncing || formats.length === 0}
                  onClick={() => void brain.sync({ formats, dryRun: false, force })}
                >
                  Write to disk
                </button>
                <label className="checkbox-field checkbox-inline">
                  <input
                    type="checkbox"
                    checked={force}
                    onChange={(event) => setForce(event.target.checked)}
                  />
                  <span>Overwrite drifted files</span>
                </label>
              </div>
            </div>
            {brain.syncResult ? (
              <ul className="sync-results">
                {brain.syncResult.results.map((result) => (
                  <li className={`sync-result sync-${result.action}`} key={result.path}>
                    <span className="sync-action">{result.action}</span>
                    <span className="mono">{result.path}</span>
                    {result.message ? <span className="sync-message">{result.message}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="panel" aria-labelledby="brain-outputs-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Generated</p>
                <h2 id="brain-outputs-title">Outputs</h2>
              </div>
              <span className="count-chip">{status.outputs.length}</span>
            </div>
            {status.outputs.length === 0 ? (
              <EmptyState title="No outputs yet">
                <p>Pick formats above and press Generate. Nothing touches disk until you sync.</p>
              </EmptyState>
            ) : (
              <ul className="brain-output-list">
                {status.outputs.map((output) => {
                  const state = outputState(output);
                  return (
                    <li className="brain-output" key={output.id}>
                      <div className="brain-output-main">
                        <p className="brain-output-title">
                          {BRAIN_FORMAT_LABELS[output.format]}
                          <span className={`status-chip brain-state-${state.tone}`}>
                            {state.label}
                          </span>
                        </p>
                        <p className="brain-output-path mono">{output.path}</p>
                        <p className="brain-output-meta">
                          {output.existsOnDisk
                            ? 'Present on disk'
                            : 'Generated in Cockpit, not written yet'}
                          {output.syncedAt
                            ? ` · synced ${formatRelativeTime(output.syncedAt)}`
                            : ''}
                        </p>
                      </div>
                      <code className="brain-checksum" title={output.checksum}>
                        {output.checksum.slice(0, 12)}
                      </code>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="analytics-columns">
            <section className="panel" aria-labelledby="brain-sources-title">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">Inputs</p>
                  <h2 id="brain-sources-title">Sources</h2>
                </div>
                <span className="count-chip">{status.sources.length}</span>
              </div>
              {status.sources.length === 0 ? (
                <EmptyState title="No sources read">
                  <p>Generate once to record the files and checksums this brain was built from.</p>
                </EmptyState>
              ) : (
                <ul className="brain-source-list">
                  {status.sources.map((source) => (
                    <li key={source.id}>
                      <span className="mono brain-source-path">{source.path}</span>
                      <span className="brain-source-meta">
                        {formatRelativeTime(source.updatedAt)} · {source.checksum.slice(0, 10)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel" aria-labelledby="brain-drift-title">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">Changed outside Cockpit</p>
                  <h2 id="brain-drift-title">Drift</h2>
                </div>
                <span className="count-chip">
                  {status.drift.filter((event) => event.resolvedAt === undefined).length}
                </span>
              </div>
              {status.drift.length === 0 ? (
                <EmptyState title="No drift recorded">
                  <p>Generated files still match the checksums Cockpit wrote.</p>
                </EmptyState>
              ) : (
                <ul className="brain-drift-list">
                  {status.drift.map((event) => (
                    <li key={event.id} className={event.resolvedAt ? 'is-resolved' : undefined}>
                      <p className="brain-drift-title">
                        {event.resolvedAt ? 'Resolved' : 'Unresolved'} drift
                      </p>
                      <p className="brain-drift-meta mono">
                        expected {event.expectedChecksum.slice(0, 10)} · actual{' '}
                        {event.actualChecksum.slice(0, 10)}
                      </p>
                      <p className="brain-drift-meta">
                        Detected {formatDateTime(event.detectedAt)}
                        {event.resolvedAt ? ` · resolved ${formatDateTime(event.resolvedAt)}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <p className="page-foot">
            <span>{status.project.rootPath}</span>
            <span>Deterministic generation</span>
          </p>
        </>
      ) : null}
    </div>
  );
}
