import type { CapturedStep, CapturedStreamChunk, TokenUsage, ToolCallTrace } from '@cockpit/core';
import { useRef, useState, type KeyboardEvent } from 'react';

import {
  formatCurrency,
  formatDuration,
  formatNumber,
  formatTime,
  statusLabel,
} from '../lib/format';
import type { StepDetailResource } from '../lib/hooks';
import { providerLabel } from '../lib/session';
import { HeadersList, JsonBlock } from './DataBlocks';
import { ErrorBanner } from './Messages';
import { StatusBadge } from './StatusBadge';

type InspectorTab = 'request' | 'response' | 'tools' | 'stream';

const TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'request', label: 'Request' },
  { id: 'response', label: 'Response' },
  { id: 'tools', label: 'Tools' },
  { id: 'stream', label: 'Stream' },
];

const MAX_TEXT_CHARS = 60_000;
const MAX_CHUNKS = 200;

export interface StepInspectorProps {
  step: CapturedStep | null;
  detail: StepDetailResource;
  liveText: string;
}

export function StepInspector({ step, detail, liveText }: StepInspectorProps) {
  const [active, setActive] = useState<InspectorTab>('request');
  const tabButtons = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({});

  if (!step) {
    return (
      <div className="panel-empty inspector-empty">
        <p className="panel-empty-title">Select a step.</p>
        <p className="muted-note">
          Choose an entry in the timeline to inspect its request, response, tool calls, and stream.
        </p>
      </div>
    );
  }

  const data = detail.data;
  const toolCalls = data?.toolCalls ?? [];
  const chunks = data?.chunks ?? [];

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | undefined;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % TABS.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + TABS.length) % TABS.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = TABS.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = TABS[nextIndex];
    if (!nextTab) return;
    setActive(nextTab.id);
    tabButtons.current[nextTab.id]?.focus();
  };

  return (
    <div className="inspector">
      <header className="inspector-head">
        <div>
          <p className="panel-kicker">Inspector</p>
          <h2>Step {step.seq + 1}</h2>
          <p className="inspector-sub">
            {formatTime(step.startedAt)}
            {step.provider ? ` · ${providerLabel(step.provider)}` : ''}
            {step.model ? ` · ${step.model}` : ''}
          </p>
        </div>
        <div className="inspector-meta">
          <StatusBadge status={step.status} label={statusLabel(step.status)} />
          <span>{formatDuration(step.durationMs)}</span>
          <span>{step.costKnown ? formatCurrency(step.costUsd ?? 0) : 'Unpriced'}</span>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Step detail">
        {TABS.map((tab, index) => {
          const count =
            tab.id === 'tools' ? toolCalls.length : tab.id === 'stream' ? chunks.length : null;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabButtons.current[tab.id] = node;
              }}
              id={`inspector-tab-${tab.id}`}
              className={`tab${active === tab.id ? ' is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              aria-controls={`inspector-panel-${tab.id}`}
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {tab.label}
              {count !== null && count > 0 ? <span className="tab-count">{count}</span> : null}
            </button>
          );
        })}
      </div>

      {detail.error ? <ErrorBanner message={detail.error} onRetry={detail.refresh} /> : null}

      <div
        className="tab-panel"
        id={`inspector-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`inspector-tab-${active}`}
        tabIndex={0}
      >
        {active === 'request' ? <RequestPanel step={step} /> : null}
        {active === 'response' ? <ResponsePanel step={step} /> : null}
        {active === 'tools' ? (
          <ToolsPanel toolCalls={toolCalls} loading={detail.loading && data === null} />
        ) : null}
        {active === 'stream' ? (
          <StreamPanel
            chunks={chunks}
            liveText={liveText}
            loading={detail.loading && data === null}
          />
        ) : null}
      </div>
    </div>
  );
}

function RequestPanel({ step }: { step: CapturedStep }) {
  const request = step.request;
  if (!request) {
    return <p className="muted-note">No request was recorded for this step.</p>;
  }

  return (
    <div className="inspector-stack">
      <div className="request-line">
        <span className="method-badge">{request.method}</span>
        <code className="request-path">{request.path}</code>
        <span className="tag">{request.protocol}</span>
        {request.stream ? <span className="tag">stream</span> : null}
      </div>

      {request.redactionCount > 0 ? (
        <p className="redaction-note">
          {formatNumber(request.redactionCount)}{' '}
          {request.redactionCount === 1 ? 'secret was' : 'secrets were'} redacted before storage.
        </p>
      ) : null}

      <JsonBlock value={request.body} label="Request body" emptyLabel="No request body recorded." />

      {request.systemPrompt ? (
        <TextDetails summary={`System prompt · ${formatNumber(request.systemPrompt.length)} chars`}>
          {request.systemPrompt}
        </TextDetails>
      ) : null}

      {request.promptText ? (
        <TextDetails summary={`Prompt text · ${formatNumber(request.promptText.length)} chars`}>
          {request.promptText}
        </TextDetails>
      ) : null}

      <details className="inspector-details">
        <summary>Headers · {Object.keys(request.headers).length}</summary>
        <HeadersList headers={request.headers} />
      </details>

      {step.metadata ? (
        <details className="inspector-details">
          <summary>Step metadata</summary>
          <JsonBlock value={step.metadata} label="Step metadata" />
        </details>
      ) : null}
    </div>
  );
}

function ResponsePanel({ step }: { step: CapturedStep }) {
  const response = step.response;
  if (!response) {
    return (
      <p className="muted-note">
        {step.status === 'running'
          ? 'The step is still in flight. The response will appear when it completes.'
          : 'No response was recorded for this step.'}
      </p>
    );
  }

  return (
    <div className="inspector-stack">
      <div className="response-line">
        <span className={`status-code${response.status >= 400 ? ' is-error' : ''}`}>
          {response.status}
        </span>
        {response.finishReason ? <span className="tag">{response.finishReason}</span> : null}
        {response.ttftMs !== undefined ? (
          <span className="tag">TTFT {formatDuration(response.ttftMs)}</span>
        ) : null}
        {response.latencyMs !== undefined ? (
          <span className="tag">Total {formatDuration(response.latencyMs)}</span>
        ) : null}
      </div>

      {response.error ? <p className="inline-error">{response.error}</p> : null}

      {response.text ? (
        <TextBlock label="Response text" text={response.text} />
      ) : (
        <p className="muted-note">No text was captured in the response.</p>
      )}

      <UsageGrid usage={response.usage} costUsd={step.costUsd} costKnown={step.costKnown} />

      {response.thinking ? (
        <TextDetails
          summary={`Thinking · ${formatNumber(response.thinking.length)} chars`}
          defaultOpen={false}
        >
          {response.thinking}
        </TextDetails>
      ) : null}

      <details className="inspector-details">
        <summary>Response headers · {Object.keys(response.headers).length}</summary>
        <HeadersList headers={response.headers} />
      </details>
    </div>
  );
}

function ToolsPanel({ toolCalls, loading }: { toolCalls: ToolCallTrace[]; loading: boolean }) {
  if (loading) {
    return <p className="muted-note">Loading tool calls…</p>;
  }

  if (toolCalls.length === 0) {
    return (
      <p className="muted-note">
        No tool calls were captured for this step. Cockpit records tool calls that appear in model
        responses.
      </p>
    );
  }

  return (
    <ul className="tool-list">
      {toolCalls.map((call) => (
        <li className="tool-card" key={call.id}>
          <header className="tool-head">
            <span className="tool-name mono">{call.name}</span>
            <StatusBadge status={call.status} />
            {call.endedAt ? (
              <span className="tool-time">
                {formatDuration(Date.parse(call.endedAt) - Date.parse(call.startedAt))}
              </span>
            ) : (
              <span className="tool-time">open</span>
            )}
          </header>

          {call.filePaths.length > 0 ? (
            <ul className="path-chips" aria-label="Touched files">
              {call.filePaths.map((filePath) => (
                <li key={filePath} className="path-chip mono">
                  {filePath}
                </li>
              ))}
            </ul>
          ) : null}

          {call.error ? <p className="inline-error">{call.error}</p> : null}

          {call.input === undefined ? null : (
            <details className="inspector-details">
              <summary>Input</summary>
              <JsonBlock value={call.input} label={`${call.name} input`} />
            </details>
          )}
          {call.output === undefined ? null : (
            <details className="inspector-details">
              <summary>Output</summary>
              <JsonBlock value={call.output} label={`${call.name} output`} />
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function StreamPanel({
  chunks,
  liveText,
  loading,
}: {
  chunks: CapturedStreamChunk[];
  liveText: string;
  loading: boolean;
}) {
  const visible = chunks.slice(-MAX_CHUNKS);

  return (
    <div className="inspector-stack">
      {liveText.length > 0 ? (
        <section className="live-preview" aria-label="Live stream preview">
          <header>
            <span className="signal signal-live" aria-hidden="true" />
            Live preview
          </header>
          <pre className="response-text">{liveText}</pre>
        </section>
      ) : null}

      {loading ? (
        <p className="muted-note">Loading stream chunks…</p>
      ) : chunks.length === 0 ? (
        liveText.length > 0 ? null : (
          <p className="muted-note">
            No streamed chunks were recorded. Non-streaming calls arrive as a single response.
          </p>
        )
      ) : (
        <>
          {chunks.length > MAX_CHUNKS ? (
            <p className="muted-note">
              Showing the last {MAX_CHUNKS} of {formatNumber(chunks.length)} chunks.
            </p>
          ) : null}
          <ol className="chunk-list" aria-label="Stream chunks">
            {visible.map((chunk) => (
              <li className="chunk" key={chunk.id}>
                <span className="chunk-seq mono">{chunk.seq}</span>
                <span className={`chunk-kind tone-${chunkKindTone(chunk.kind)}`}>{chunk.kind}</span>
                <span className="chunk-text">{clip(chunk.deltaText ?? chunk.data, 2000)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function UsageGrid({
  usage,
  costUsd,
  costKnown,
}: {
  usage: TokenUsage;
  costUsd: number | undefined;
  costKnown: boolean;
}) {
  const entries = [
    ['Input', usage.inputTokens],
    ['Output', usage.outputTokens],
    ['Cache read', usage.cacheReadTokens],
    ['Cache write', usage.cacheWriteTokens],
    ['Reasoning', usage.reasoningTokens],
  ] as const;

  return (
    <div className="usage-block">
      <dl className="usage-grid">
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{formatNumber(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="usage-cost">
        {costKnown ? formatCurrency(costUsd ?? 0) : 'Cost unavailable for this model.'}
      </p>
    </div>
  );
}

function TextBlock({ text, label }: { text: string; label: string }) {
  const truncated = text.length > MAX_TEXT_CHARS;
  return (
    <>
      <pre className="response-text" aria-label={label}>
        {truncated ? text.slice(0, MAX_TEXT_CHARS) : text}
      </pre>
      {truncated ? (
        <p className="muted-note">
          Preview truncated at {formatNumber(MAX_TEXT_CHARS)} of {formatNumber(text.length)}{' '}
          characters. The full text remains in the local database.
        </p>
      ) : null}
    </>
  );
}

function TextDetails({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className="inspector-details" open={defaultOpen}>
      <summary>{summary}</summary>
      <pre className="response-text">{clip(children, MAX_TEXT_CHARS)}</pre>
    </details>
  );
}

function clip(text: string, maximum: number): string {
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function chunkKindTone(kind: CapturedStreamChunk['kind']): string {
  switch (kind) {
    case 'text':
      return 'ok';
    case 'thinking':
      return 'warn';
    case 'tool_call':
      return 'live';
    case 'usage':
      return 'muted';
    case 'event':
      return 'muted';
    case 'done':
      return 'ok';
  }
}
