import {
  estimateUsageCost,
  type ArenaRun,
  type ArenaRunInput,
  type ArenaTarget,
  type JsonValue,
  type ProviderProtocol,
  type TokenUsage,
  ZERO_USAGE,
} from '@cockpit/core';

import type { CockpitConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { parseJsonBody } from '../recording/text.js';
import { collectNonStreamResponse } from '../sse/collector.js';
import type { Store } from '../store/store.js';

export class ArenaServiceError extends Error {
  readonly status: number;
  readonly code: 'bad_request' | 'not_found' | 'conflict';

  constructor(status: number, code: ArenaServiceError['code'], message: string) {
    super(message);
    this.name = 'ArenaServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface ArenaServiceOptions {
  store: Store;
  config: CockpitConfig;
  logger: Logger;
}

const ARENA_TIMEOUT_MS = 60_000;

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function upstreamBaseUrl(config: CockpitConfig, protocol: ProviderProtocol): string {
  return (protocol === 'anthropic' ? config.anthropic.baseUrl : config.openai.baseUrl).replace(
    /\/+$/,
    '',
  );
}

function buildHeaders(config: CockpitConfig, protocol: ProviderProtocol): Headers {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');

  if (protocol === 'anthropic') {
    if (config.anthropic.apiKey) headers.set('x-api-key', config.anthropic.apiKey);
    headers.set('anthropic-version', config.anthropic.version);
  } else if (config.openai.apiKey) {
    headers.set('authorization', `Bearer ${config.openai.apiKey}`);
  }

  return headers;
}

function overrideModel(body: Record<string, JsonValue>, model: string): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = { ...body, model, stream: false };
  delete next['stream_options'];
  return next;
}

function extractDiff(text: string): string | undefined {
  const blocks: string[] = [];
  const pattern = /```diff\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const block = match[1]?.trim();
    if (block) blocks.push(block);
  }
  if (blocks.length > 0) return blocks.join('\n');
  if (text.trimStart().startsWith('diff --git ')) return text;
  return undefined;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function savingsPercent(
  baseline: number | undefined,
  cost: number | undefined,
): number | undefined {
  if (baseline === undefined || baseline <= 0 || cost === undefined) return undefined;
  return roundPercent(((baseline - cost) / baseline) * 100);
}

export class ArenaService {
  readonly #store: Store;
  readonly #config: CockpitConfig;
  readonly #logger: Logger;

  constructor(options: ArenaServiceOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#logger = options.logger;
  }

  async run(sessionId: string, input: ArenaRunInput): Promise<ArenaRun[]> {
    const session = this.#store.getSession(sessionId);
    if (!session) {
      throw new ArenaServiceError(404, 'not_found', 'The requested session was not found.');
    }

    const step = this.#store.getStep(input.stepId);
    if (!step || step.sessionId !== sessionId) {
      throw new ArenaServiceError(404, 'not_found', 'The requested step was not found.');
    }

    const request = step.request;
    const body = request?.body;
    if (!request || !isRecord(body)) {
      throw new ArenaServiceError(
        400,
        'bad_request',
        'This step has no captured JSON request body to replay.',
      );
    }
    if (request.method !== 'POST') {
      throw new ArenaServiceError(400, 'bad_request', 'Only POST requests can be replayed.');
    }

    const baselineCostUsd = step.costKnown && step.costUsd !== undefined ? step.costUsd : undefined;
    const runs = input.targets.map((target) =>
      this.#store.insertArenaRun({
        sourceSessionId: sessionId,
        sourceStepId: step.id,
        provider: target.provider,
        model: target.model,
        status: 'queued',
      }),
    );

    const settled = await Promise.all(
      runs.map((run, index) =>
        this.#runOne(
          run,
          input.targets[index]!,
          { protocol: request.protocol, path: request.path, body },
          baselineCostUsd,
        ),
      ),
    );
    return settled;
  }

  list(query: { sessionId?: string; stepId?: string; limit: number }): ArenaRun[] {
    return this.#store.listArenaRuns(query);
  }

  get(id: string): ArenaRun | undefined {
    return this.#store.getArenaRun(id);
  }

  async #runOne(
    run: ArenaRun,
    target: ArenaTarget,
    request: { protocol: ProviderProtocol; path: string; body: JsonValue },
    baselineCostUsd: number | undefined,
  ): Promise<ArenaRun> {
    if (!isRecord(request.body)) {
      return (
        this.#store.updateArenaRun(run.id, {
          status: 'failed',
          error: 'The captured request body is not a JSON object.',
          completedAt: new Date(),
        }) ?? run
      );
    }

    this.#store.updateArenaRun(run.id, { status: 'running' });
    const startedAt = performance.now();

    try {
      const url = `${upstreamBaseUrl(this.#config, request.protocol)}${request.path}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(this.#config, request.protocol),
        body: JSON.stringify(overrideModel(request.body, target.model)),
        signal: AbortSignal.timeout(ARENA_TIMEOUT_MS),
        redirect: 'manual',
      });
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      const text = await response.text();
      const parsed = parseJsonBody(text);

      let outputText = '';
      let usage: TokenUsage = { ...ZERO_USAGE };
      let error: string | undefined;

      if (parsed.value !== undefined) {
        const collected = collectNonStreamResponse(request.protocol, request.path, parsed.value);
        outputText = collected.text;
        usage = collected.usage;
        error = collected.error;
      } else {
        outputText = text;
      }

      if (!response.ok && error === undefined) {
        error =
          text.trim().length > 0 ? text.slice(0, 2000) : `Upstream returned ${response.status}.`;
      }

      const cost = estimateUsageCost(usage, target.model, target.provider);
      const costUsd = cost.known ? cost.usd : undefined;
      const diffText = extractDiff(outputText);
      const savings = savingsPercent(baselineCostUsd, costUsd);

      const updated = this.#store.updateArenaRun(run.id, {
        status: error === undefined ? 'completed' : 'failed',
        outputText: outputText.slice(0, 2_000_000),
        ...(diffText === undefined ? {} : { diffText: diffText.slice(0, 2_000_000) }),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(costUsd === undefined ? {} : { costUsd }),
        costKnown: cost.known,
        latencyMs,
        ...(baselineCostUsd === undefined ? {} : { baselineCostUsd }),
        ...(savings === undefined ? {} : { savingsPercent: savings }),
        ...(error === undefined ? {} : { error }),
        completedAt: new Date(),
      });
      return updated ?? run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('Arena target failed', { model: target.model, message });
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      return (
        this.#store.updateArenaRun(run.id, {
          status: 'failed',
          error: message.slice(0, 100_000),
          latencyMs,
          ...(baselineCostUsd === undefined ? {} : { baselineCostUsd }),
          completedAt: new Date(),
        }) ?? run
      );
    }
  }
}
