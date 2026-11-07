import {
  estimateUsageCost,
  type CapturedStep,
  type FinishReason,
  type JsonValue,
  type ProviderProtocol,
  type StepStatus,
  type TokenUsage,
} from '@cockpit/core';

import type { StepContextCapture } from '../context/doctor.js';
import type { StepSnapshotRecorder } from '../git/snapshots.js';
import type { Logger } from '../logger.js';
import type { Store, StreamChunkInput } from '../store/store.js';
import type { LiveEventBus } from '../live/bus.js';
import { ProtocolCollector, type CollectedResponse, type IngestedEvent } from '../sse/collector.js';
import type { SseEvent } from '../sse/parser.js';
import {
  MAX_RESPONSE_CHARS,
  MAX_STREAM_DATA_CHARS,
  MAX_STREAM_DELTA_CHARS,
  parseJsonBody,
  truncateText,
} from './text.js';
import { RedactionCollector, redactHeaders, redactJson, redactText } from './redact.js';
import { extractRequestMetadata } from '../proxy/request-meta.js';

export interface BeginRecordedStepInput {
  sessionId: string;
  protocol: ProviderProtocol;
  provider?: string;
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
}

export interface RecordedStep {
  step: CapturedStep;
  collector: ProtocolCollector;
  redactions: RedactionCollector;
  startedAtMono: number;
  model?: string;
  stream: boolean;
  firstByteAt?: number;
  chunkSeq: number;
  pendingChunks: StreamChunkInput[];
  flushTimer: NodeJS.Timeout | undefined;
  finalized: boolean;
}

export interface FinishRecordedStepInput {
  status: StepStatus;
  responseStatus: number;
  responseHeaders: Readonly<Record<string, string>>;
  collected?: CollectedResponse;
  error?: string;
  ttftMs?: number;
}

export interface RecordedStepGuardInput {
  sessionId: string;
  stepId: string;
  protocol: ProviderProtocol;
  path: string;
  responseStatus: number;
  responseText?: string;
  responseThinking?: string;
  toolCalls: ReadonlyArray<{ name: string; input?: JsonValue }>;
}

export interface StepGuardEvaluator {
  evaluateStep(input: RecordedStepGuardInput): unknown;
}

export interface RecorderOptions {
  store: Store;
  bus: LiveEventBus;
  logger: Logger;
  snapshots?: StepSnapshotRecorder;
  guards?: StepGuardEvaluator;
  contextDoctor?: StepContextCapture;
}

interface CostResult {
  costUsd?: number;
  costKnown: boolean;
}

function resolveCost(usage: TokenUsage, model: string | undefined, provider?: string): CostResult {
  if (!model) return { costKnown: false };

  const primary = estimateUsageCost(usage, model, provider);
  if (primary.known) {
    return { costUsd: primary.usd, costKnown: true };
  }
  if (provider) {
    const fallback = estimateUsageCost(usage, model);
    if (fallback.known) {
      return { costUsd: fallback.usd, costKnown: true };
    }
  }
  return { costKnown: false };
}

function responseFinishReason(
  collected: CollectedResponse,
  status: StepStatus,
): FinishReason | undefined {
  if (collected.finishReason) return collected.finishReason;
  if (status === 'failed') return 'error';
  if (status === 'cancelled') return 'cancelled';
  return undefined;
}

export class Recorder {
  readonly #store: Store;
  readonly #bus: LiveEventBus;
  readonly #logger: Logger;
  readonly #snapshots: StepSnapshotRecorder | undefined;
  readonly #guards: StepGuardEvaluator | undefined;
  readonly #contextDoctor: StepContextCapture | undefined;

  constructor(options: RecorderOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#logger = options.logger;
    this.#snapshots = options.snapshots;
    this.#guards = options.guards;
    this.#contextDoctor = options.contextDoctor;
  }

  begin(input: BeginRecordedStepInput): RecordedStep {
    const redactions = new RedactionCollector();
    const capturedHeaders = redactHeaders(input.headers, redactions, 'request_headers');
    const parsedBody = parseJsonBody(input.bodyText);

    let capturedBody: JsonValue | undefined;
    if (parsedBody.value !== undefined) {
      capturedBody = redactJson(parsedBody.value, redactions, 'request_body');
    } else if (parsedBody.text.length > 0) {
      capturedBody = redactText(parsedBody.text, redactions, 'request_body');
    }

    const metadata = extractRequestMetadata(input.protocol, input.path, capturedBody);
    const model = metadata.model;
    const requestRedactionCount =
      redactions.total('request_headers') + redactions.total('request_body');

    const request = {
      protocol: input.protocol,
      method: input.method.slice(0, 16),
      path: input.path.slice(0, 2048),
      ...(model ? { model } : {}),
      stream: metadata.stream,
      headers: capturedHeaders,
      ...(capturedBody === undefined ? {} : { body: capturedBody }),
      ...(metadata.systemPrompt ? { systemPrompt: metadata.systemPrompt } : {}),
      ...(metadata.promptText ? { promptText: metadata.promptText } : {}),
      redactionCount: requestRedactionCount,
    };

    const step = this.#store.beginStep({
      sessionId: input.sessionId,
      kind: 'model',
      ...(input.provider ? { provider: input.provider } : {}),
      ...(model ? { model } : {}),
      request,
    });

    this.#bus.emit('step.started', {
      sessionId: input.sessionId,
      stepId: step.id,
      payload: {
        seq: step.seq,
        kind: step.kind,
        protocol: input.protocol,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(model ? { model } : {}),
        stream: metadata.stream,
      },
    });

    this.#snapshots?.noteStepStarted(input.sessionId, step.id);

    try {
      this.#contextDoctor?.capture({
        sessionId: input.sessionId,
        stepId: step.id,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(model ? { model } : {}),
        ...(capturedBody === undefined ? {} : { body: capturedBody }),
        ...(metadata.systemPrompt ? { systemPrompt: metadata.systemPrompt } : {}),
        ...(metadata.promptText ? { promptText: metadata.promptText } : {}),
      });
    } catch (error) {
      this.#logger.warn('Cockpit could not capture a context snapshot', error);
    }

    return {
      step,
      collector: new ProtocolCollector(input.protocol, input.path),
      redactions,
      startedAtMono: performance.now(),
      ...(model ? { model } : {}),
      stream: metadata.stream,
      chunkSeq: 0,
      pendingChunks: [],
      flushTimer: undefined,
      finalized: false,
    };
  }

  recordStreamEvent(handle: RecordedStep, event: SseEvent): IngestedEvent {
    const ingested = handle.collector.ingest(event);
    const seq = handle.chunkSeq;
    handle.chunkSeq += 1;

    handle.pendingChunks.push({
      stepId: handle.step.id,
      seq,
      kind: ingested.kind,
      data: truncateText(event.raw, MAX_STREAM_DATA_CHARS),
      receivedAt: new Date(),
      ...(ingested.deltaText
        ? { deltaText: truncateText(ingested.deltaText, MAX_STREAM_DELTA_CHARS) }
        : {}),
    });

    if (handle.pendingChunks.length >= 25) {
      this.flushChunks(handle);
    } else if (!handle.flushTimer) {
      handle.flushTimer = setTimeout(() => {
        handle.flushTimer = undefined;
        try {
          this.flushChunks(handle);
        } catch (error) {
          this.#logger.error('Failed to flush stream chunks', error);
        }
      }, 250);
      handle.flushTimer.unref();
    }

    this.#bus.emit('stream.chunk', {
      sessionId: handle.step.sessionId,
      stepId: handle.step.id,
      persist: false,
      payload: {
        seq,
        kind: ingested.kind,
        ...(ingested.deltaText ? { deltaText: truncateText(ingested.deltaText, 20_000) } : {}),
      },
    });

    return ingested;
  }

  flushChunks(handle: RecordedStep): void {
    if (handle.flushTimer) {
      clearTimeout(handle.flushTimer);
      handle.flushTimer = undefined;
    }
    if (handle.pendingChunks.length === 0) return;

    const chunks = handle.pendingChunks;
    handle.pendingChunks = [];
    this.#store.insertStreamChunks(chunks);
  }

  finish(handle: RecordedStep, input: FinishRecordedStepInput): boolean {
    if (handle.finalized) return false;
    handle.finalized = true;

    this.flushChunks(handle);

    const collected = input.collected ?? handle.collector.snapshot();
    const model = collected.model ?? handle.model ?? handle.step.model;
    const responseText = truncateText(
      redactText(collected.text, handle.redactions, 'response_body'),
      MAX_RESPONSE_CHARS,
    );
    const responseThinking = truncateText(
      redactText(collected.thinking, handle.redactions, 'response_body'),
      2_000_000,
    );
    const responseHeaders = redactHeaders(
      input.responseHeaders,
      handle.redactions,
      'response_headers',
    );

    const errorText =
      input.error ??
      collected.error ??
      (input.responseStatus >= 400 ? `HTTP ${input.responseStatus}` : undefined);
    const normalizedError =
      errorText === undefined
        ? undefined
        : redactText(errorText, handle.redactions, 'response_body');

    const latencyMs = Math.round(performance.now() - handle.startedAtMono);
    const ttftMs =
      input.ttftMs ??
      (handle.firstByteAt === undefined
        ? undefined
        : Math.max(0, Math.round(handle.firstByteAt - handle.startedAtMono)));

    const cost = resolveCost(collected.usage, model, handle.step.provider);
    const finishReason = responseFinishReason(collected, input.status);
    const toolCalls = collected.toolCalls.map((call) => ({
      ...(call.providerToolCallId ? { providerToolCallId: call.providerToolCallId } : {}),
      name: call.name,
      ...(call.input === undefined
        ? {}
        : { input: redactJson(call.input, handle.redactions, 'response_body') }),
    }));

    const responseRedactionCount =
      handle.redactions.total('response_headers') + handle.redactions.total('response_body');

    const completed = this.#store.completeStep(
      handle.step.id,
      {
        status: input.status,
        responseStatus: input.responseStatus,
        responseHeaders,
        usage: collected.usage,
        costKnown: cost.costKnown,
        ...(model ? { model } : {}),
        ...(responseText.length > 0 ? { responseText } : {}),
        ...(responseThinking.length > 0 ? { responseThinking } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(normalizedError === undefined ? {} : { error: normalizedError }),
        ...(cost.costUsd === undefined ? {} : { costUsd: cost.costUsd }),
        ...(ttftMs === undefined ? {} : { ttftMs }),
        latencyMs,
        ...(responseRedactionCount > 0 ? { metadata: { responseRedactionCount } } : {}),
      },
      toolCalls,
    );

    if (!completed) {
      this.#logger.warn('Step was already finalized', { stepId: handle.step.id });
      return false;
    }

    this.#evaluateGuards(handle, collected, input.responseStatus);

    try {
      this.#store.insertRedactions(handle.step.id, handle.redactions.rows());
    } catch (error) {
      this.#logger.error('Failed to persist redaction metadata', error);
    }

    for (const call of toolCalls) {
      this.#bus.emit('tool.completed', {
        sessionId: handle.step.sessionId,
        stepId: handle.step.id,
        payload: {
          name: call.name,
          status: 'completed',
          ...(call.providerToolCallId ? { providerToolCallId: call.providerToolCallId } : {}),
        },
      });
    }

    this.#bus.emit('step.completed', {
      sessionId: handle.step.sessionId,
      stepId: handle.step.id,
      payload: {
        status: input.status,
        durationMs: latencyMs,
        usage: {
          inputTokens: collected.usage.inputTokens,
          outputTokens: collected.usage.outputTokens,
          cacheReadTokens: collected.usage.cacheReadTokens,
          cacheWriteTokens: collected.usage.cacheWriteTokens,
          reasoningTokens: collected.usage.reasoningTokens,
        },
        costKnown: cost.costKnown,
        ...(cost.costUsd === undefined ? {} : { costUsd: cost.costUsd }),
        ...(finishReason ? { finishReason } : {}),
        ...(model ? { model } : {}),
      },
    });

    const session = this.#store.getSession(handle.step.sessionId);
    if (session) {
      this.#bus.emit('session.updated', {
        sessionId: session.id,
        payload: {
          totals: {
            stepCount: session.totals.stepCount,
            modelCallCount: session.totals.modelCallCount,
            toolCallCount: session.totals.toolCallCount,
            inputTokens: session.totals.inputTokens,
            outputTokens: session.totals.outputTokens,
            totalCostUsd: session.totals.totalCostUsd,
            unknownCostCalls: session.totals.unknownCostCalls,
            errorCount: session.totals.errorCount,
          },
        },
      });
    }

    return true;
  }

  #evaluateGuards(
    handle: RecordedStep,
    collected: CollectedResponse,
    responseStatus: number,
  ): void {
    if (!this.#guards) return;
    try {
      this.#guards.evaluateStep({
        sessionId: handle.step.sessionId,
        stepId: handle.step.id,
        protocol: handle.step.request?.protocol ?? 'openai',
        path: handle.step.request?.path ?? '',
        responseStatus,
        ...(collected.text ? { responseText: collected.text } : {}),
        ...(collected.thinking ? { responseThinking: collected.thinking } : {}),
        toolCalls: collected.toolCalls.map((call) => ({
          name: call.name,
          ...(call.input === undefined ? {} : { input: call.input }),
        })),
      });
    } catch (error) {
      this.#logger.warn('Post-step guard evaluation failed', error);
    }
  }
}
