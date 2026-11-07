import { totalTokens, type CapturedStep, type StepKind } from '@cockpit/core';

import {
  formatCurrency,
  formatDuration,
  formatNumber,
  formatTime,
  statusLabel,
  statusTone,
} from '../lib/format';
import { StatusBadge } from './StatusBadge';

const KIND_LABELS: Readonly<Record<StepKind, string>> = {
  model: 'Model call',
  tool: 'Tool',
  guard: 'Guard',
  snapshot: 'Snapshot',
  system: 'System',
};

export interface StepTimelineProps {
  steps: CapturedStep[];
  selectedStepId: string | null;
  onSelect: (stepId: string) => void;
}

function clip(text: string, maximum = 140): string {
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

export function StepTimeline({ steps, selectedStepId, onSelect }: StepTimelineProps) {
  if (steps.length === 0) {
    return (
      <div className="panel-empty">
        <p className="panel-empty-title">No steps recorded yet.</p>
        <p className="muted-note">
          Start a run with <code>cockpit run -- claude</code> and the timeline will fill in as the
          agent works.
        </p>
      </div>
    );
  }

  return (
    <ol className="step-list" aria-label="Recorded steps">
      {steps.map((step) => {
        const selected = step.id === selectedStepId;
        const tokenCount = totalTokens(step.usage);
        const cost = step.costKnown ? formatCurrency(step.costUsd ?? 0) : 'unpriced';

        return (
          <li key={step.id}>
            <button
              className={`step-item${selected ? ' is-selected' : ''}`}
              type="button"
              aria-current={selected ? 'step' : undefined}
              aria-label={`Step ${step.seq + 1}: ${KIND_LABELS[step.kind]}${step.model ? `, ${step.model}` : ''}`}
              onClick={() => onSelect(step.id)}
            >
              <span className="step-index mono" aria-hidden="true">
                {String(step.seq + 1).padStart(2, '0')}
              </span>
              <span className={`step-marker tone-${statusTone(step.status)}`} aria-hidden="true" />

              <span className="step-body">
                <span className="step-title">
                  {KIND_LABELS[step.kind]}
                  {step.model ? <span className="step-model">{step.model}</span> : null}
                </span>
                <span className="step-sub">
                  <span>{formatTime(step.startedAt)}</span>
                  <span>{formatDuration(step.durationMs)}</span>
                  <span>{formatNumber(tokenCount)} tokens</span>
                  {step.error ? <span className="step-error-inline">error</span> : null}
                </span>
                {step.error ? <span className="step-error">{clip(step.error)}</span> : null}
              </span>

              <span className="step-side">
                <StatusBadge status={step.status} label={statusLabel(step.status)} />
                <span className="step-cost">{cost}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
