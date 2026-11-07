import type { ProviderProtocol, StepStatus } from '@cockpit/core';
import type { Context } from 'hono';

import type { CockpitConfig } from '../config.js';
import type { GitSnapshotService } from '../git/snapshots.js';
import type { BudgetService } from '../guards/budget.js';
import type { GuardService } from '../guards/service.js';
import type { Logger } from '../logger.js';
import type { LiveEventBus } from '../live/bus.js';
import type { Recorder, RecordedStep } from '../recording/recorder.js';
import { parseJsonBody, truncateText } from '../recording/text.js';
import type { SessionManager } from '../sessions/manager.js';
import type { Store } from '../store/store.js';
import { collectNonStreamResponse, type CollectedResponse } from '../sse/collector.js';
import { SseParser, type SseEvent } from '../sse/parser.js';
import { detectAgent, providerOverride } from './agent.js';
import {
  buildResponseHeaders,
  buildUpstreamHeaders,
  collectHeaderRecord,
  proxyErrorResponse,
} from './headers.js';
import type { ProxyRouteResult } from './routing.js';

type MatchedProxyRoute = Extract<ProxyRouteResult, { ok: true }>;

export interface ProxyServices {
  config: CockpitConfig;
  store: Store;
  recorder: Recorder;
  sessions: SessionManager;
  bus: LiveEventBus;
  snapshots: GitSnapshotService;
  guards: GuardService;
  budgets: BudgetService;
  logger: Logger;
}

function isRecordablePath(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  const normalized = path.split('?')[0]?.replace(/\/+$/, '') ?? path;
  return (
    normalized.endsWith('/chat/completions') ||
    normalized.endsWith('/responses') ||
    normalized.endsWith('/completions') ||
    normalized.endsWith('/messages') ||
    normalized.endsWith('/embeddings')
  );
}

function sanitizedFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateText(message, 1_000);
}

async function readRequestBytes(c: Context, maximum: number): Promise<Buffer | Response> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maximum) {
    return new Response(null, { status: 413 });
  }

  const buffer = Buffer.from(await c.req.arrayBuffer());
  if (buffer.length > maximum) {
    return new Response(null, { status: 413 });
  }
  return buffer;
}

function upstreamBaseUrl(config: CockpitConfig, protocol: ProviderProtocol): string {
  return protocol === 'anthropic' ? config.anthropic.baseUrl : config.openai.baseUrl;
}

function buildUpstreamUrl(baseUrl: string, path: string, search: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${path}${search}`;
}

function ingestEvents(handle: RecordedStep, events: SseEvent[], services: ProxyServices): void {
  try {
    for (const event of events) {
      services.recorder.recordStreamEvent(handle, event);
    }
  } catch (error) {
    services.logger.error('Failed to record a stream event', error);
  }
}

function safeFinish(
  handle: RecordedStep,
  input: Parameters<Recorder['finish']>[1],
  services: ProxyServices,
): void {
  try {
    services.recorder.finish(handle, input);
  } catch (error) {
    services.logger.error('Failed to finalize a recorded step', error);
  }
}

function completedCollected(collected: CollectedResponse | undefined, status: number): StepStatus {
  if (status >= 400) return 'failed';
  if (collected?.error) return 'failed';
  return 'completed';
}

export async function handleProxyRequest(
  c: Context,
  route: MatchedProxyRoute,
  services: ProxyServices,
): Promise<Response> {
  const { config, store, sessions, recorder } = services;
  const protocol = route.protocol;
  const method = c.req.method;
  const url = new URL(c.req.url);
  const agent = detectAgent(c.req.raw.headers);
  const recordable = isRecordablePath(method, route.upstreamPath);

  let session = route.sessionId ? store.getSession(route.sessionId) : undefined;
  if (route.sessionId && !session) {
    return proxyErrorResponse(protocol, 404, 'The requested Cockpit session does not exist.');
  }
  if (session && session.status !== 'active') {
    return proxyErrorResponse(protocol, 409, 'The requested Cockpit session has already ended.');
  }
  if (!session && recordable) {
    session = sessions.resolveAmbient(protocol, agent);
  }
  if (session) {
    sessions.markUsed(session.id);
    if (recordable) {
      store.touchSession(session.id, {
        ...(agent ? { agent } : {}),
      });
    }
  }

  const bodyResult = await readRequestBytes(c, config.maxBodyBytes);
  if (bodyResult instanceof Response) {
    return proxyErrorResponse(protocol, 413, 'The request body is larger than Cockpit allows.');
  }
  const rawBody = bodyResult;
  const bodyText = rawBody.toString('utf8');
  const provider = providerOverride(c.req.raw.headers) ?? protocol;

  if (recordable && session) {
    try {
      const budget = await services.budgets.check(session.id);
      if (budget.blocked) {
        return proxyErrorResponse(
          protocol,
          402,
          `Cockpit blocked this request: the "${budget.blocked.policy.name}" budget is exhausted (${budget.blocked.status.spentUsd.toFixed(4)} USD of ${budget.blocked.status.limitUsd.toFixed(4)} USD).`,
          'budget_exceeded',
        );
      }

      const guard = await services.guards.evaluateRequest({
        sessionId: session.id,
        protocol,
        method,
        path: route.upstreamPath,
        headers: collectHeaderRecord(c.req.raw.headers),
        bodyText,
      });
      if (!guard.allowed) {
        return proxyErrorResponse(
          protocol,
          guard.status ?? 403,
          guard.message ?? 'Cockpit blocked this request because a guard rule matched.',
          guard.code ?? 'guard_blocked',
        );
      }
    } catch (error) {
      // Failing open keeps the proxy usable if a detector misbehaves; the
      // recorder still redacts secrets and every step is captured.
      services.logger.warn('Cockpit guard evaluation failed', error);
    }
  }

  let handle: RecordedStep | undefined;
  if (recordable && session) {
    await services.snapshots.ensureBaseline(session);
    await services.snapshots.settlePendingStep(session.id);
    handle = recorder.begin({
      sessionId: session.id,
      protocol,
      provider,
      method,
      path: route.upstreamPath,
      headers: collectHeaderRecord(c.req.raw.headers),
      bodyText,
    });
  }

  const upstreamHeaders = buildUpstreamHeaders(c.req.raw.headers, protocol, config);
  const upstreamUrl = buildUpstreamUrl(
    upstreamBaseUrl(config, protocol),
    route.upstreamPath,
    url.search,
  );

  const aborter = handle ? new AbortController() : undefined;
  const onClientAbort = (): void => {
    aborter?.abort();
  };
  const clientSignal = c.req.raw.signal;
  if (aborter) {
    if (clientSignal.aborted) {
      aborter.abort();
    } else {
      clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }
  }
  const cleanup = (): void => {
    if (aborter) clientSignal.removeEventListener('abort', onClientAbort);
  };

  let upstream: Response;
  try {
    const requestInit: RequestInit = {
      method,
      headers: upstreamHeaders,
      redirect: 'manual',
      signal: aborter?.signal ?? clientSignal,
    };
    if (method !== 'GET' && method !== 'HEAD' && rawBody.length > 0) {
      requestInit.body = rawBody;
    }

    upstream = await fetch(upstreamUrl, requestInit);
  } catch (error) {
    cleanup();
    const aborted = aborter?.signal.aborted === true;
    const message = aborted
      ? 'The client disconnected before the upstream responded.'
      : sanitizedFetchError(error);
    if (handle) {
      safeFinish(
        handle,
        {
          status: aborted ? 'cancelled' : 'failed',
          responseStatus: aborted ? 499 : 502,
          responseHeaders: {},
          error: message,
        },
        services,
      );
    }
    if (!aborted) {
      services.logger.warn('Upstream request failed', { message });
    }
    return proxyErrorResponse(protocol, aborted ? 499 : 502, message);
  }

  const responseHeadersForRecorder = collectHeaderRecord(upstream.headers);
  const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
  const isEventStream = contentType.includes('text/event-stream');
  const responseHeaders = buildResponseHeaders(upstream.headers, {
    stream: isEventStream,
    ...(session ? { sessionId: session.id } : {}),
    ...(handle ? { stepId: handle.step.id } : {}),
  });

  if (!handle) {
    cleanup();
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  if (isEventStream) {
    const parser = new SseParser();
    const reader = upstream.body?.getReader();
    let finalized = false;

    if (!reader) {
      safeFinish(
        handle,
        {
          status: upstream.ok ? 'completed' : 'failed',
          responseStatus: upstream.status,
          responseHeaders: responseHeadersForRecorder,
        },
        services,
      );
      cleanup();
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }

    const finalize = (status: StepStatus, error?: string): void => {
      if (finalized) return;
      finalized = true;
      cleanup();
      const snapshot = handle.collector.snapshot();
      const finalStatus = snapshot.error && status === 'completed' ? 'failed' : status;
      safeFinish(
        handle,
        {
          status: finalStatus,
          responseStatus: upstream.status,
          responseHeaders: responseHeadersForRecorder,
          ...(error === undefined ? {} : { error }),
        },
        services,
      );
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            ingestEvents(handle, parser.end(), services);
            const snapshot = handle.collector.snapshot();
            finalize(upstream.ok && !snapshot.error ? 'completed' : 'failed');
            controller.close();
            return;
          }

          if (handle.firstByteAt === undefined) {
            handle.firstByteAt = performance.now();
          }
          controller.enqueue(next.value);
          ingestEvents(handle, parser.feed(next.value), services);
        } catch (error) {
          const message = sanitizedFetchError(error);
          finalize('failed', message);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {
          // The upstream connection may already be gone.
        }
        aborter?.abort();
        finalize('cancelled', 'The client disconnected before the stream completed.');
      },
    });

    return new Response(stream, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  let responseBuffer: Buffer;
  try {
    responseBuffer = Buffer.from(await upstream.arrayBuffer());
  } catch (error) {
    cleanup();
    const message = sanitizedFetchError(error);
    safeFinish(
      handle,
      {
        status: 'failed',
        responseStatus: upstream.status,
        responseHeaders: responseHeadersForRecorder,
        error: message,
      },
      services,
    );
    return proxyErrorResponse(protocol, 502, message);
  }

  const responseText = responseBuffer.toString('utf8');
  const parsed = parseJsonBody(responseText);
  const collected =
    parsed.value === undefined
      ? undefined
      : collectNonStreamResponse(protocol, route.upstreamPath, parsed.value);

  safeFinish(
    handle,
    {
      status: completedCollected(collected, upstream.status),
      responseStatus: upstream.status,
      responseHeaders: responseHeadersForRecorder,
      ...(collected ? { collected } : {}),
      ...(upstream.status >= 400 && !collected?.error
        ? { error: truncateText(responseText, 2_000) }
        : {}),
    },
    services,
  );
  cleanup();

  if (upstream.status === 204 || upstream.status === 304 || method === 'HEAD') {
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }

  return new Response(responseBuffer, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
