import { PluginManifestSchema, type Plugin, type PluginRun } from '@cockpit/core';
import { useEffect, useState } from 'react';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime, prettyJson } from '../lib/format';
import { usePageTitle, usePlugins, useSessions, useSessionSteps } from '../lib/hooks';

function pluginKind(plugin: Plugin): string {
  const manifest = PluginManifestSchema.safeParse(plugin.manifest);
  return manifest.success ? manifest.data.kind : 'unknown';
}

function PluginRunView({ run }: { run: PluginRun }) {
  return (
    <li className="plugin-run">
      <div className="plugin-run-head">
        <StatusBadge status={run.status} />
        <span className="mono plugin-run-id">{run.id.slice(0, 8)}</span>
        <span className="plugin-run-time">{formatDateTime(run.startedAt)}</span>
      </div>
      {run.error ? <p className="plugin-run-error">{run.error}</p> : null}
      {run.result !== undefined ? (
        <pre className="plugin-run-result">{prettyJson(run.result)}</pre>
      ) : null}
    </li>
  );
}

export function PluginsPage() {
  usePageTitle('Plugins · Cockpit');
  const plugins = usePlugins();
  const sessions = useSessions({ search: '', status: 'all', limit: 50 });

  const [installPath, setInstallPath] = useState('');
  const [pluginChoice, setPluginChoice] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [stepId, setStepId] = useState('');
  const [lastRun, setLastRun] = useState<PluginRun | null>(null);

  const steps = useSessionSteps(sessionId || null);
  const activePlugin =
    plugins.plugins.find((plugin) => plugin.id === pluginChoice) ??
    plugins.plugins.find((plugin) => plugin.enabled) ??
    plugins.plugins[0] ??
    null;

  useEffect(() => {
    setStepId('');
    setLastRun(null);
  }, [sessionId]);

  const install = async (): Promise<void> => {
    if (installPath.trim().length === 0) return;
    const installed = await plugins.install(installPath.trim());
    if (installed) setInstallPath('');
  };

  const runPlugin = async (): Promise<void> => {
    if (!activePlugin || !sessionId) return;
    const run = await plugins.run(activePlugin.id, {
      sessionId,
      ...(stepId ? { stepId } : {}),
    });
    if (run) setLastRun(run);
  };

  return (
    <div className="page page-plugins">
      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Local extensions
        </p>
        <h1>
          Plugins
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          Guard and analyzer plugins are local Node programs you install yourself. Cockpit runs them
          on demand with a minimal environment, a 15 second timeout, and output caps. Plugin code is
          trusted local code: install only what you have read.
        </p>
      </header>

      {plugins.error ? (
        <ErrorBanner message={plugins.error} onRetry={plugins.refresh} retrying={plugins.loading} />
      ) : null}
      {plugins.actionError ? (
        <ErrorBanner message={plugins.actionError} onRetry={plugins.clearActionError} />
      ) : null}
      {sessions.error ? <ErrorBanner message={sessions.error} /> : null}

      <section className="panel" aria-labelledby="plugin-install-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Install</p>
            <h2 id="plugin-install-title">Add a local plugin</h2>
          </div>
        </div>
        <form
          className="plugin-install"
          onSubmit={(event) => {
            event.preventDefault();
            void install();
          }}
        >
          <label className="field field-grow">
            <span>Plugin directory or cockpit-plugin.json path</span>
            <input
              type="text"
              value={installPath}
              onChange={(event) => setInstallPath(event.target.value)}
              placeholder="C:\work\cockpit-plugin-example"
              spellCheck={false}
            />
          </label>
          <button
            className="primary-button button-small"
            type="submit"
            disabled={plugins.busy === 'install' || installPath.trim().length === 0}
          >
            {plugins.busy === 'install' ? 'Installing…' : 'Install'}
          </button>
        </form>
        <p className="panel-note">
          The manifest must be named <span className="mono">cockpit-plugin.json</span> and its entry
          must stay inside the plugin directory.
        </p>
      </section>

      <section className="panel" aria-labelledby="plugin-list-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Installed</p>
            <h2 id="plugin-list-title">Plugin library</h2>
          </div>
          <div className="panel-tools">
            <span className="count-chip">{plugins.plugins.length}</span>
            <button
              className="ghost-button button-small"
              type="button"
              onClick={plugins.refresh}
              disabled={plugins.refreshing}
            >
              {plugins.refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {plugins.loading && plugins.plugins.length === 0 ? (
          <LoadingRows rows={2} label="Loading plugins" />
        ) : plugins.plugins.length === 0 ? (
          <EmptyState title="No plugins installed">
            <p>
              Install a directory that contains a manifest. Cockpit never downloads or executes
              plugins on its own.
            </p>
          </EmptyState>
        ) : (
          <ul className="plugin-list">
            {plugins.plugins.map((plugin) => {
              const runs = plugins.runs[plugin.id];
              return (
                <li
                  className={`plugin-card${plugin.enabled ? '' : ' is-disabled'}`}
                  key={plugin.id}
                >
                  <div className="plugin-card-head">
                    <div className="plugin-card-title">
                      <p className="plugin-name">
                        {plugin.name}
                        <span className="tag mono">v{plugin.version}</span>
                        <span className="tag">{pluginKind(plugin)}</span>
                        <span className={`status-chip plugin-${plugin.enabled ? 'on' : 'off'}`}>
                          {plugin.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </p>
                      {plugin.description ? (
                        <p className="plugin-description">{plugin.description}</p>
                      ) : null}
                      <p className="plugin-path mono">{plugin.path}</p>
                    </div>
                    <div className="plugin-card-actions">
                      <button
                        className="ghost-button button-small"
                        type="button"
                        disabled={plugins.busy === plugin.id}
                        onClick={() => void plugins.toggle(plugin)}
                      >
                        {plugin.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="ghost-button button-small"
                        type="button"
                        disabled={plugins.busy === plugin.id}
                        onClick={() => void plugins.loadRuns(plugin.id)}
                      >
                        History
                      </button>
                      <button
                        className="ghost-button button-small danger-button"
                        type="button"
                        disabled={plugins.busy === plugin.id}
                        onClick={() => void plugins.remove(plugin.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {runs !== undefined ? (
                    runs.length === 0 ? (
                      <p className="plugin-empty-runs">No runs recorded for this plugin.</p>
                    ) : (
                      <ul className="plugin-run-list">
                        {runs.map((run) => (
                          <PluginRunView key={run.id} run={run} />
                        ))}
                      </ul>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="plugin-run-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">On demand</p>
            <h2 id="plugin-run-title">Run against a session</h2>
          </div>
        </div>
        {plugins.plugins.length === 0 ? (
          <EmptyState title="Nothing to run">
            <p>Install and enable a plugin first.</p>
          </EmptyState>
        ) : (
          <div className="plugin-run-form">
            <div className="arena-form-row">
              <label className="field">
                <span>Plugin</span>
                <select
                  value={activePlugin?.id ?? ''}
                  onChange={(event) => setPluginChoice(event.target.value)}
                  aria-label="Plugin to run"
                >
                  {plugins.plugins.map((plugin) => (
                    <option key={plugin.id} value={plugin.id} disabled={!plugin.enabled}>
                      {plugin.name} {plugin.enabled ? '' : '(disabled)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Session</span>
                <select
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                  aria-label="Session for the plugin"
                >
                  <option value="">Choose a session…</option>
                  {sessions.sessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Step (optional)</span>
                <select
                  value={stepId}
                  onChange={(event) => setStepId(event.target.value)}
                  disabled={!sessionId || steps.loading}
                  aria-label="Step limit for the plugin"
                >
                  <option value="">Whole session</option>
                  {steps.steps.map((step) => (
                    <option key={step.id} value={step.id}>
                      #{step.seq + 1} · {step.kind}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="arena-submit">
              <button
                className="primary-button button-small"
                type="button"
                onClick={() => void runPlugin()}
                disabled={
                  plugins.busy !== null ||
                  !activePlugin ||
                  !activePlugin.enabled ||
                  sessionId === ''
                }
              >
                {activePlugin && plugins.busy === activePlugin.id ? 'Running…' : 'Run plugin'}
              </button>
              <span className="muted-note">
                Runs in a child Node process with no provider API keys in the environment.
              </span>
            </div>
            {lastRun ? (
              <div className="plugin-last-run">
                <p className="panel-kicker">Latest result</p>
                <ul className="plugin-run-list">
                  <PluginRunView run={lastRun} />
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <p className="page-foot">
        <span>15s timeout</span>
        <span>1 MB stdout cap</span>
        <span>Entry containment enforced</span>
      </p>
    </div>
  );
}
