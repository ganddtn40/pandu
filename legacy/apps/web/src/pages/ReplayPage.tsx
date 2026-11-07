import type {
  CapturedStep,
  ReplayFileChange,
  ReplayFork,
  ReplaySnapshot,
  ToolCallTrace,
} from '@cockpit/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

import { JsonBlock } from '../components/DataBlocks';
import { ErrorBanner, LoadingRows } from '../components/Messages';
import { StatusBadge } from '../components/StatusBadge';
import { StepTimeline } from '../components/StepTimeline';
import {
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTime,
  pluralize,
} from '../lib/format';
import {
  usePageTitle,
  useReplayForkActions,
  useSessionReplay,
  useSnapshotDetail,
  useStepDetail,
} from '../lib/hooks';
import { shortId } from '../lib/session';

const PLAYBACK_SPEEDS = [
  { label: '0.5×', durationMs: 2400 },
  { label: '1×', durationMs: 1400 },
  { label: '2×', durationMs: 700 },
] as const;

function clipText(text: string, maximum = 60_000): string {
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function stepPrompt(step: CapturedStep | null): string {
  if (!step?.request) return '';
  return step.request.promptText ?? step.request.systemPrompt ?? '';
}

function stepResponse(step: CapturedStep | null): string {
  if (!step) return '';
  return step.response?.text ?? step.response?.error ?? step.error ?? '';
}

function stepError(step: CapturedStep | null): string | undefined {
  return step?.error ?? step?.response?.error;
}

/**
 * Resolve the working-tree state a step ended with. Snapshots are chained after
 * each step, so the newest snapshot at or before the selected step is the file
 * state to show. Base snapshots (no step) qualify for every step.
 */
function resolveSnapshot(
  snapshots: ReplaySnapshot[],
  steps: CapturedStep[],
  step: CapturedStep | null,
): ReplaySnapshot | undefined {
  if (snapshots.length === 0) return undefined;
  if (!step) return snapshots.at(-1);

  const sequenceByStep = new Map(steps.map((candidate) => [candidate.id, candidate.seq]));
  let selected: ReplaySnapshot | undefined;
  for (const snapshot of snapshots) {
    if (!snapshot.stepId) {
      selected ??= snapshot;
      continue;
    }
    const sequence = sequenceByStep.get(snapshot.stepId);
    if (sequence === undefined || sequence > step.seq) continue;
    selected = snapshot;
  }
  return selected ?? snapshots[0];
}

function diffStat(change: ReplayFileChange): string {
  return `+${formatNumber(change.additions)} / −${formatNumber(change.deletions)}`;
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 10) : 'uncommitted';
}

function ToolCalls({ calls, loading }: { calls: ToolCallTrace[]; loading: boolean }) {
  if (loading) {
    return <p className="muted-note">Loading tool calls…</p>;
  }
  if (calls.length === 0) {
    return <p className="muted-note">No tool calls were recorded for this step.</p>;
  }

  return (
    <ul className="replay-tools">
      {calls.map((call) => (
        <li className="replay-tool" key={call.id}>
          <div className="replay-tool-head">
            <span className="tool-name">{call.name}</span>
            <StatusBadge status={call.status} />
            <span className="tool-time">{formatTime(call.startedAt)}</span>
          </div>
          {call.filePaths.length > 0 ? (
            <ul className="path-chips" aria-label={`Files touched by ${call.name}`}>
              {call.filePaths.map((filePath) => (
                <li className="path-chip" key={filePath}>
                  {filePath}
                </li>
              ))}
            </ul>
          ) : null}
          {call.error ? <p className="inline-error">{call.error}</p> : null}
          {call.input !== undefined || call.output !== undefined ? (
            <details className="inspector-details">
              <summary>Input &amp; output</summary>
              <p className="replay-detail-label">Input</p>
              <JsonBlock value={call.input} label={`${call.name} input`} />
              <p className="replay-detail-label">Output</p>
              <JsonBlock value={call.output} label={`${call.name} output`} />
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface DiffListProps {
  fileChanges: ReplayFileChange[];
  loading: boolean;
}

function DiffList({ fileChanges, loading }: DiffListProps) {
  if (loading) {
    return <p className="muted-note">Loading captured diff…</p>;
  }
  if (fileChanges.length === 0) {
    return (
      <p className="muted-note">
        This snapshot recorded no file changes. The working tree may have been clean when Cockpit
        captured it.
      </p>
    );
  }

  return (
    <ol className="diff-list">
      {fileChanges.map((change) => (
        <li key={change.id}>
          <details className="diff-file">
            <summary>
              <span className={`change-type change-${change.changeType}`}>{change.changeType}</span>
              <span className="diff-path" title={change.path}>
                {change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
              </span>
              <span className="diff-stat">{diffStat(change)}</span>
            </summary>
            {change.diff ? (
              <pre className="diff-block" aria-label={`Diff for ${change.path}`}>
                <code>{clipText(change.diff)}</code>
              </pre>
            ) : (
              <p className="muted-note">
                No textual diff was captured for this file. Binary files and files over the per-file
                diff limit appear as stats only.
              </p>
            )}
          </details>
        </li>
      ))}
    </ol>
  );
}

export function ReplayPage() {
  const { id = '' } = useParams<{ id: string }>();
  const location = useLocation();
  const replayResource = useSessionReplay(id);
  const replay = replayResource.replay;
  const session = replay?.session ?? null;

  usePageTitle(session ? `Replay · ${session.title} · Cockpit` : 'Replay · Cockpit');

  const steps = useMemo(() => replay?.steps ?? [], [replay?.steps]);
  const snapshots = useMemo(() => replay?.snapshots ?? [], [replay?.snapshots]);
  const lastIndex = Math.max(0, steps.length - 1);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState<number>(PLAYBACK_SPEEDS[1].durationMs);
  const [branchName, setBranchName] = useState('');
  const [forkNotice, setForkNotice] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const initializedSessionRef = useRef<string | null>(null);

  const activeIndex = Math.min(stepIndex, lastIndex);
  const selectedStep = steps[activeIndex] ?? null;

  const stepDetail = useStepDetail(selectedStep?.id ?? null);
  const snapshot = useMemo(
    () => resolveSnapshot(snapshots, steps, selectedStep),
    [snapshots, steps, selectedStep],
  );
  const snapshotDetail = useSnapshotDetail(snapshot?.id ?? null);

  const forkActions = useReplayForkActions(id, replayResource.refresh);

  useEffect(() => {
    if (!replay) return;
    if (initializedSessionRef.current !== replay.session.id) {
      initializedSessionRef.current = replay.session.id;
      setStepIndex(Math.max(0, replay.steps.length - 1));
      setPlaying(false);
      return;
    }
    setStepIndex((previous) => Math.min(previous, Math.max(0, replay.steps.length - 1)));
  }, [replay]);

  useEffect(() => {
    if (!playing) return;
    if (steps.length <= 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setInterval(() => {
      setStepIndex((previous) => Math.min(previous + 1, steps.length - 1));
    }, speedMs);
    return () => window.clearInterval(timer);
  }, [playing, speedMs, steps.length]);

  useEffect(() => {
    if (playing && activeIndex >= lastIndex) setPlaying(false);
  }, [playing, activeIndex, lastIndex]);

  useEffect(
    () => () => {
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!snapshot?.id) return;
    if (location.hash === '#fork') {
      const target = document.getElementById('fork');
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
      }
    }
  }, [location.hash, snapshot?.id]);

  const goToStep = useCallback((index: number) => {
    setPlaying(false);
    setStepIndex(index);
  }, []);

  const togglePlayback = useCallback(() => {
    if (steps.length <= 1) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (activeIndex >= lastIndex) setStepIndex(0);
    setPlaying(true);
  }, [playing, activeIndex, lastIndex, steps.length]);

  const copyText = async (key: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      setCopiedKey(null);
    }
  };

  const handleCreateFork = async (): Promise<void> => {
    setForkNotice(null);
    setConfirmRemoveId(null);
    const trimmed = branchName.trim();
    const fork = await forkActions.createFork({
      ...(selectedStep ? { stepId: selectedStep.id } : {}),
      ...(trimmed.length > 0 ? { branch: trimmed } : {}),
    });
    if (!fork) return;
    setBranchName('');
    setForkNotice(`Fork ready on ${fork.branch} at ${fork.worktreePath}`);
  };

  const handleRemoveFork = async (fork: ReplayFork): Promise<void> => {
    if (confirmRemoveId !== fork.id) {
      setConfirmRemoveId(fork.id);
      return;
    }
    setConfirmRemoveId(null);
    setForkNotice(null);
    await forkActions.removeFork(fork.id);
  };

  if (replayResource.loading && !replay) {
    return (
      <div className="page page-replay">
        <Link className="back-link" to={`/sessions/${id}`}>
          ← Flight
        </Link>
        <LoadingRows rows={3} label="Loading replay" />
      </div>
    );
  }

  if (!replay || !session) {
    return (
      <div className="page page-replay">
        <Link className="back-link" to="/sessions">
          ← Flight log
        </Link>
        <ErrorBanner
          message={replayResource.error ?? 'The requested replay was not found.'}
          onRetry={replayResource.refresh}
          retrying={replayResource.loading}
        />
      </div>
    );
  }

  const prompt = stepPrompt(selectedStep);
  const responseText = stepResponse(selectedStep);
  const errorText = stepError(selectedStep);
  const snapshotFileChanges = snapshotDetail.data?.fileChanges ?? [];
  const snapshotSummary = snapshotDetail.data?.snapshot ?? snapshot;
  const forks = replay.forks;

  return (
    <div className="page page-replay">
      <div className="detail-top">
        <Link className="back-link" to={`/sessions/${session.id}`}>
          <span aria-hidden="true">←</span> Flight
        </Link>
        <div className="detail-actions">
          <button
            className="ghost-button button-small"
            type="button"
            onClick={replayResource.refresh}
            disabled={replayResource.refreshing}
          >
            {replayResource.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <a
            className="ghost-button button-small"
            href={`/api/sessions/${session.id}/replay`}
            target="_blank"
            rel="noreferrer"
          >
            Raw JSON <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>

      <header className="detail-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Time travel <span className="mono detail-id">{shortId(session.id)}</span>
        </p>
        <div className="detail-title-line">
          <h1>{session.title}</h1>
          <StatusBadge status={session.status} />
        </div>
        <div className="detail-meta">
          <span>{formatNumber(steps.length)} steps</span>
          <span>{formatNumber(replay.snapshots.length)} snapshots</span>
          <span>
            {formatNumber(forks.length)} {pluralize(forks.length, 'fork')}
          </span>
          {session.workspacePath ? (
            <span className="mono detail-path" title={session.workspacePath}>
              {session.workspacePath}
            </span>
          ) : null}
          {session.gitBranch ? <span className="mono">branch {session.gitBranch}</span> : null}
        </div>
      </header>

      {replayResource.error ? (
        <ErrorBanner
          message={replayResource.error}
          onRetry={replayResource.refresh}
          retrying={replayResource.refreshing}
        />
      ) : null}

      <section className="panel replay-console" aria-labelledby="replay-console-title">
        <div className="panel-head panel-head-tight">
          <div>
            <p className="panel-kicker">Scrubber</p>
            <h2 id="replay-console-title">Replay console</h2>
          </div>
          <p className="replay-clock mono">
            {steps.length === 0
              ? 'No steps recorded'
              : `Step ${String(activeIndex + 1)} of ${String(steps.length)}`}
          </p>
        </div>

        <div className="replay-controls">
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => goToStep(Math.max(0, activeIndex - 1))}
            disabled={activeIndex <= 0 || steps.length === 0}
            aria-label="Previous step"
          >
            ◀ Prev
          </button>
          <button
            className="replay-play"
            type="button"
            onClick={togglePlayback}
            disabled={steps.length <= 1}
            aria-label={playing ? 'Pause replay' : 'Play replay'}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => goToStep(Math.min(lastIndex, activeIndex + 1))}
            disabled={activeIndex >= lastIndex || steps.length === 0}
            aria-label="Next step"
          >
            Next ▶
          </button>

          <label className="replay-scrub" htmlFor="replay-scrubber">
            <span className="sr-only">Replay position</span>
            <input
              id="replay-scrubber"
              className="replay-range"
              type="range"
              min={0}
              max={lastIndex}
              step={1}
              value={activeIndex}
              disabled={steps.length === 0}
              onChange={(event) => goToStep(Number(event.target.value))}
              aria-valuetext={
                steps.length === 0
                  ? 'No steps'
                  : `Step ${String(activeIndex + 1)}: ${selectedStep?.model ?? selectedStep?.kind ?? 'step'}`
              }
            />
          </label>

          <label className="replay-speed" htmlFor="replay-speed">
            <span>Speed</span>
            <select
              id="replay-speed"
              value={speedMs}
              onChange={(event) => setSpeedMs(Number(event.target.value))}
            >
              {PLAYBACK_SPEEDS.map((speed) => (
                <option key={speed.durationMs} value={speed.durationMs}>
                  {speed.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {steps.length === 0 ? (
        <section className="panel replay-stage" aria-label="Replay stage">
          <div className="panel-empty">
            <p className="panel-empty-title">No steps recorded in this flight.</p>
            <p className="muted-note">
              Start a run through the Cockpit proxy and steps will appear here. A baseline snapshot
              may still be available for forking below.
            </p>
          </div>
        </section>
      ) : (
        <div className="replay-workbench">
          <section className="panel replay-timeline" aria-labelledby="replay-timeline-title">
            <div className="panel-head panel-head-tight">
              <div>
                <p className="panel-kicker">Sequence</p>
                <h2 id="replay-timeline-title">Steps</h2>
              </div>
              <span className="tiny-count">{formatNumber(steps.length)} total</span>
            </div>
            <StepTimeline
              steps={steps}
              selectedStepId={selectedStep?.id ?? null}
              onSelect={(stepId) => {
                const index = steps.findIndex((step) => step.id === stepId);
                if (index >= 0) goToStep(index);
              }}
            />
          </section>

          <section className="panel replay-stage" aria-labelledby="replay-stage-title">
            <div className="inspector-head">
              <div>
                <p className="panel-kicker">
                  Step {formatNumber(activeIndex + 1)} · {selectedStep?.kind ?? 'step'}
                </p>
                <h2 id="replay-stage-title">
                  {selectedStep?.model ?? selectedStep?.provider ?? 'Recorded step'}
                </h2>
                <p className="inspector-sub">
                  {selectedStep ? formatDateTime(selectedStep.startedAt) : '—'} ·{' '}
                  {formatDuration(selectedStep?.durationMs)}
                  {selectedStep?.costUsd !== undefined
                    ? ` · ${formatCurrency(selectedStep.costUsd)}`
                    : ''}
                </p>
              </div>
              {selectedStep ? <StatusBadge status={selectedStep.status} /> : null}
            </div>

            {stepDetail.error ? (
              <p className="inline-error replay-inline">{stepDetail.error}</p>
            ) : null}

            <div className="tab-panel replay-stage-body">
              <section className="replay-section" aria-labelledby="replay-prompt-title">
                <div className="replay-section-head">
                  <h3 id="replay-prompt-title">Prompt</h3>
                  {selectedStep?.request ? (
                    <span className="mono replay-request-line">
                      {selectedStep.request.method} {selectedStep.request.path}
                      {selectedStep.request.stream ? ' · streamed' : ''}
                      {selectedStep.request.redactionCount > 0
                        ? ` · ${formatNumber(selectedStep.request.redactionCount)} redactions`
                        : ''}
                    </span>
                  ) : null}
                </div>
                {prompt ? (
                  <pre className="response-text replay-transcript">{clipText(prompt)}</pre>
                ) : (
                  <p className="muted-note">
                    No prompt text was captured for this step. The raw request body is available
                    from the flight inspector.
                  </p>
                )}
                {selectedStep?.request?.systemPrompt &&
                selectedStep.request.systemPrompt !== prompt ? (
                  <details className="inspector-details">
                    <summary>System prompt</summary>
                    <pre className="response-text">
                      <code>{clipText(selectedStep.request.systemPrompt)}</code>
                    </pre>
                  </details>
                ) : null}
              </section>

              <section className="replay-section" aria-labelledby="replay-response-title">
                <div className="replay-section-head">
                  <h3 id="replay-response-title">Response</h3>
                  {selectedStep?.response ? (
                    <span className="mono replay-request-line">
                      HTTP {selectedStep.response.status}
                      {selectedStep.response.finishReason
                        ? ` · ${selectedStep.response.finishReason}`
                        : ''}
                      {selectedStep.response.latencyMs !== undefined
                        ? ` · ${formatDuration(selectedStep.response.latencyMs)}`
                        : ''}
                    </span>
                  ) : null}
                </div>
                {responseText ? (
                  <pre className="response-text replay-transcript">{clipText(responseText)}</pre>
                ) : (
                  <p className="muted-note">No response text was captured for this step.</p>
                )}
                {errorText && errorText !== responseText ? (
                  <p className="inline-error">{errorText}</p>
                ) : null}
                {selectedStep?.response?.thinking ? (
                  <details className="inspector-details">
                    <summary>Reasoning trace</summary>
                    <pre className="response-text">
                      <code>{clipText(selectedStep.response.thinking)}</code>
                    </pre>
                  </details>
                ) : null}
              </section>

              <section className="replay-section" aria-labelledby="replay-tools-title">
                <div className="replay-section-head">
                  <h3 id="replay-tools-title">Tool calls</h3>
                  <span className="mono replay-request-line">
                    {formatNumber(stepDetail.data?.toolCalls.length ?? 0)} captured
                  </span>
                </div>
                <ToolCalls
                  calls={stepDetail.data?.toolCalls ?? []}
                  loading={stepDetail.loading && stepDetail.data === null}
                />
              </section>

              <section className="replay-section" aria-labelledby="replay-diff-title">
                <div className="replay-section-head">
                  <h3 id="replay-diff-title">File changes</h3>
                  {snapshotSummary ? (
                    <span className="mono replay-request-line">
                      {shortSha(snapshotSummary.commitSha)} ·{' '}
                      {formatNumber(snapshotSummary.filesChanged)}{' '}
                      {pluralize(snapshotSummary.filesChanged, 'file')} · +
                      {formatNumber(snapshotSummary.insertions)} / −
                      {formatNumber(snapshotSummary.deletions)}
                    </span>
                  ) : null}
                </div>
                {snapshotDetail.error ? (
                  <p className="inline-error replay-inline">
                    {snapshotDetail.error}{' '}
                    <button className="text-button" type="button" onClick={snapshotDetail.refresh}>
                      Retry
                    </button>
                  </p>
                ) : null}
                {snapshot ? (
                  <DiffList
                    fileChanges={snapshotFileChanges}
                    loading={snapshotDetail.loading && snapshotDetail.data === null}
                  />
                ) : (
                  <p className="muted-note">
                    No snapshot covers this point yet. Cockpit captures the workspace before the
                    first step and after each completed step.
                  </p>
                )}
                {snapshot?.worktreePath ? (
                  <p className="muted-note replay-worktree">
                    Snapshot taken in <span className="mono">{snapshot.worktreePath}</span>
                    {snapshot.branch ? ` on ${snapshot.branch}` : ''}.
                  </p>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      )}

      <section className="panel replay-fork-panel" id="fork" aria-labelledby="fork-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Branch point</p>
            <h2 id="fork-title">Fork from here</h2>
            <p className="panel-note">
              Creates a git worktree at the selected snapshot, plus a resume brief you can paste
              into a fresh agent. The original branch is never modified.
            </p>
          </div>
          <span className="tiny-count">
            {snapshot ? `base ${shortSha(snapshot.commitSha)}` : 'no snapshot yet'}
          </span>
        </div>

        <div className="fork-create">
          <label className="fork-branch-field" htmlFor="fork-branch">
            <span>Branch name</span>
            <input
              id="fork-branch"
              type="text"
              value={branchName}
              placeholder="cockpit/fork-auto"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setBranchName(event.target.value)}
            />
          </label>
          <button
            className="button"
            type="button"
            onClick={() => void handleCreateFork()}
            disabled={forkActions.creating || replay.snapshots.length === 0}
          >
            {forkActions.creating ? 'Creating worktree…' : 'Fork from here'}
          </button>
          {replay.snapshots.length === 0 ? (
            <p className="muted-note fork-hint">
              A snapshot is captured before the first step and after each completed step. Forking
              unlocks once a snapshot exists.
            </p>
          ) : (
            <p className="muted-note fork-hint">
              Optional branch name — Cockpit generates one when left blank.
            </p>
          )}
        </div>

        {forkActions.error ? (
          <div className="fork-alert">
            <ErrorBanner message={forkActions.error} />
            <button className="text-button" type="button" onClick={forkActions.clearError}>
              Dismiss
            </button>
          </div>
        ) : null}
        {forkNotice ? (
          <p className="fork-notice" role="status">
            {forkNotice}
          </p>
        ) : null}

        {forks.length === 0 ? (
          <p className="panel-empty muted-note">
            No forks yet. Scrub to a step, then fork to continue the work in an isolated worktree.
          </p>
        ) : (
          <ul className="fork-list" aria-label="Created forks">
            {forks.map((fork) => (
              <li className="fork-card" key={fork.id}>
                <div className="fork-card-head">
                  <span className="fork-branch mono">{fork.branch}</span>
                  <StatusBadge status={fork.status} />
                  <span className="fork-base mono">{shortSha(fork.baseCommit)}</span>
                  <span className="fork-created">{formatDateTime(fork.createdAt)}</span>
                </div>
                <p className="fork-path mono" title={fork.worktreePath}>
                  {fork.worktreePath}
                </p>
                <div className="fork-actions">
                  <button
                    className="ghost-button button-small"
                    type="button"
                    onClick={() => void copyText(`fork-${fork.id}`, fork.worktreePath)}
                  >
                    {copiedKey === `fork-${fork.id}` ? 'Path copied' : 'Copy worktree path'}
                  </button>
                  <button
                    className="ghost-button button-small"
                    type="button"
                    onClick={() => void copyText(`brief-${fork.id}`, fork.resumeBrief)}
                  >
                    {copiedKey === `brief-${fork.id}` ? 'Brief copied' : 'Copy resume brief'}
                  </button>
                  {fork.status !== 'removed' ? (
                    <button
                      className="ghost-button button-small"
                      type="button"
                      onClick={() => void handleRemoveFork(fork)}
                      disabled={forkActions.removingId === fork.id}
                    >
                      {forkActions.removingId === fork.id
                        ? 'Removing…'
                        : confirmRemoveId === fork.id
                          ? 'Confirm remove'
                          : 'Remove worktree'}
                    </button>
                  ) : null}
                </div>
                <details className="inspector-details fork-brief">
                  <summary>Resume brief</summary>
                  <pre className="response-text">
                    <code>{clipText(fork.resumeBrief, 120_000)}</code>
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
