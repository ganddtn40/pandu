import type { ArenaRun, ArenaTarget } from '@cockpit/core';
import { useEffect, useState } from 'react';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { StatusBadge } from '../components/StatusBadge';
import {
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatNumber,
  pluralize,
} from '../lib/format';
import { useArenaRuns, usePageTitle, useSessions, useSessionSteps } from '../lib/hooks';

const MAX_TARGETS = 6;

function parseTargets(values: readonly string[]): { targets: ArenaTarget[]; error: string | null } {
  const targets: ArenaTarget[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0 || separator === trimmed.length - 1) {
      return {
        targets: [],
        error: `“${trimmed}” is not a provider:model target. Use a value like openai:gpt-5.1.`,
      };
    }
    targets.push({
      provider: trimmed.slice(0, separator).trim(),
      model: trimmed.slice(separator + 1).trim(),
    });
  }
  if (targets.length === 0) {
    return { targets: [], error: 'Add at least one provider:model target.' };
  }
  if (targets.length > MAX_TARGETS) {
    return { targets: [], error: `Arena runs accept at most ${String(MAX_TARGETS)} targets.` };
  }
  return { targets, error: null };
}

function RunCard({ run }: { run: ArenaRun }) {
  return (
    <li className="arena-run">
      <div className="arena-run-head">
        <div>
          <p className="arena-run-model mono">
            {run.provider}/{run.model}
          </p>
          <p className="arena-run-meta">
            <StatusBadge status={run.status} />
            <span>{formatDateTime(run.startedAt)}</span>
            {run.latencyMs !== undefined ? <span>{formatDuration(run.latencyMs)}</span> : null}
          </p>
        </div>
        <div className="arena-run-cost">
          <span>{formatCurrency(run.costUsd ?? 0)}</span>
          {!run.costKnown ? <small>unpriced</small> : null}
          {run.savingsPercent !== undefined ? (
            <small className={run.savingsPercent > 0 ? 'savings-good' : 'savings-bad'}>
              {run.savingsPercent > 0 ? '+' : ''}
              {run.savingsPercent}% vs baseline
            </small>
          ) : null}
        </div>
      </div>
      <p className="arena-run-tokens">
        {formatNumber(run.inputTokens)} in · {formatNumber(run.outputTokens)} out
        {run.baselineCostUsd !== undefined
          ? ` · baseline ${formatCurrency(run.baselineCostUsd)}`
          : ''}
      </p>
      {run.error ? <p className="arena-run-error">{run.error}</p> : null}
      {run.outputText || run.diffText ? (
        <details className="arena-details">
          <summary>Output and diff</summary>
          {run.outputText ? (
            <div className="arena-block">
              <p className="arena-block-label">Output</p>
              <pre>{run.outputText}</pre>
            </div>
          ) : null}
          {run.diffText ? (
            <div className="arena-block">
              <p className="arena-block-label">Extracted diff</p>
              <pre>{run.diffText}</pre>
            </div>
          ) : null}
        </details>
      ) : null}
      <p className="arena-run-id mono">{run.id}</p>
    </li>
  );
}

export function ArenaPage() {
  usePageTitle('Model Arena · Cockpit');
  const arena = useArenaRuns(20);
  const sessions = useSessions({ search: '', status: 'all', limit: 50 });

  const [sessionId, setSessionId] = useState('');
  const [stepId, setStepId] = useState('');
  const [targets, setTargets] = useState<string[]>(['']);
  const [localError, setLocalError] = useState<string | null>(null);
  const [latestRuns, setLatestRuns] = useState<ArenaRun[] | null>(null);

  const steps = useSessionSteps(sessionId || null);
  const selectedStep = steps.steps.find((step) => step.id === stepId) ?? null;

  useEffect(() => {
    setStepId('');
    setLatestRuns(null);
  }, [sessionId]);

  const updateTarget = (index: number, value: string): void => {
    setTargets((previous) =>
      previous.map((item, itemIndex) => (itemIndex === index ? value : item)),
    );
  };

  const addTarget = (): void => {
    setTargets((previous) => (previous.length >= MAX_TARGETS ? previous : [...previous, '']));
  };

  const removeTarget = (index: number): void => {
    setTargets((previous) =>
      previous.length <= 1 ? previous : previous.filter((_, itemIndex) => itemIndex !== index),
    );
  };

  const runArena = async (): Promise<void> => {
    const parsed = parseTargets(targets);
    if (parsed.error) {
      setLocalError(parsed.error);
      return;
    }
    if (!sessionId || !stepId) {
      setLocalError('Choose a session and a recorded step first.');
      return;
    }
    setLocalError(null);
    const created = await arena.run(sessionId, { stepId, targets: parsed.targets });
    if (created) setLatestRuns(created);
  };

  return (
    <div className="page page-arena">
      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Replay bench
        </p>
        <h1>
          Model Arena
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          Replay a recorded request against other models and compare cost, latency, and output. The
          stored body is already redacted; upstream keys come from your local config and are never
          written to the arena record.
        </p>
      </header>

      {arena.error ? (
        <ErrorBanner message={arena.error} onRetry={arena.refresh} retrying={arena.loading} />
      ) : null}
      {arena.actionError ? (
        <ErrorBanner message={arena.actionError} onRetry={arena.clearActionError} />
      ) : null}
      {sessions.error ? <ErrorBanner message={sessions.error} /> : null}

      <section className="panel" aria-labelledby="arena-form-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">New comparison</p>
            <h2 id="arena-form-title">Replay a step</h2>
          </div>
        </div>
        <div className="arena-form">
          <div className="arena-form-row">
            <label className="field">
              <span>Session</span>
              <select
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
                aria-label="Source session"
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
              <span>Step</span>
              <select
                value={stepId}
                onChange={(event) => setStepId(event.target.value)}
                disabled={sessionId === '' || steps.loading}
                aria-label="Source step"
              >
                <option value="">
                  {steps.loading ? 'Loading steps…' : 'Choose a model step…'}
                </option>
                {steps.steps
                  .filter((step) => step.kind === 'model' && step.request?.body !== undefined)
                  .map((step) => (
                    <option key={step.id} value={step.id}>
                      #{step.seq + 1} · {step.model ?? step.provider ?? 'model'}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          {selectedStep ? (
            <div className="arena-step-preview">
              <p className="arena-step-meta">
                {selectedStep.provider ?? 'unknown provider'} ·{' '}
                {selectedStep.model ?? 'unknown model'} ·{' '}
                {formatNumber(selectedStep.usage.inputTokens)} in /{' '}
                {formatNumber(selectedStep.usage.outputTokens)} out ·{' '}
                {formatCurrency(selectedStep.costUsd ?? 0)}
              </p>
              {selectedStep.request?.promptText ? (
                <p className="arena-step-prompt">{selectedStep.request.promptText.slice(0, 400)}</p>
              ) : null}
            </div>
          ) : null}

          <fieldset className="arena-targets">
            <legend>Targets</legend>
            {targets.map((target, index) => (
              <div className="arena-target-row" key={index}>
                <label className="field field-grow">
                  <span className="sr-only">Target {index + 1}</span>
                  <input
                    type="text"
                    value={target}
                    placeholder="openai:gpt-5.1"
                    spellCheck={false}
                    onChange={(event) => updateTarget(index, event.target.value)}
                  />
                </label>
                <button
                  className="ghost-button button-small"
                  type="button"
                  onClick={() => removeTarget(index)}
                  disabled={targets.length <= 1}
                  aria-label={`Remove target ${index + 1}`}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="arena-target-actions">
              <button
                className="ghost-button button-small"
                type="button"
                onClick={addTarget}
                disabled={targets.length >= MAX_TARGETS}
              >
                Add target
              </button>
              <span className="muted-note">
                {targets.length}/{MAX_TARGETS}
              </span>
            </div>
          </fieldset>

          {localError ? <p className="form-error">{localError}</p> : null}

          <div className="arena-submit">
            <button
              className="primary-button button-small"
              type="button"
              onClick={() => void runArena()}
              disabled={arena.running || !sessionId || !stepId}
            >
              {arena.running ? 'Replaying…' : 'Run comparison'}
            </button>
            <span className="muted-note">
              The request is sent to each provider once. Results are stored locally.
            </span>
          </div>
        </div>
      </section>

      {latestRuns ? (
        <section className="panel" aria-labelledby="arena-latest-title">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">Just now</p>
              <h2 id="arena-latest-title">Latest comparison</h2>
            </div>
            <span className="count-chip">{latestRuns.length}</span>
          </div>
          <ul className="arena-run-list">
            {latestRuns.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="arena-history-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">History</p>
            <h2 id="arena-history-title">Recent arena runs</h2>
          </div>
          <div className="panel-tools">
            <span className="tiny-count">
              {formatNumber(arena.runs.length)} {pluralize(arena.runs.length, 'run')}
            </span>
            <button
              className="ghost-button button-small"
              type="button"
              onClick={arena.refresh}
              disabled={arena.refreshing}
            >
              {arena.refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {arena.loading && arena.runs.length === 0 ? (
          <LoadingRows rows={2} label="Loading arena runs" />
        ) : arena.runs.length === 0 ? (
          <EmptyState title="No arena runs yet">
            <p>Choose a recorded model step above and run it against at least one target.</p>
          </EmptyState>
        ) : (
          <ul className="arena-run-list">
            {arena.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        )}
      </section>

      <p className="page-foot">
        <span>Stored bodies are redacted</span>
        <span>Streaming is forced off for comparisons</span>
      </p>
    </div>
  );
}
