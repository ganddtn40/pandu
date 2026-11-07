import type { ProviderProtocol } from '@cockpit/core';

import type { CockpitConfig } from '../config.js';
import { PROXY_KEY_SENTINEL } from '../config.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'accept-encoding',
  'authorization',
  'x-api-key',
  'cookie',
  'origin',
  'referer',
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isSentinel(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  const token = trimmed.toLowerCase().startsWith('bearer ')
    ? trimmed.slice('bearer '.length).trim()
    : trimmed;
  return token.toLowerCase() === PROXY_KEY_SENTINEL;
}

export function collectHeaderRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of headers) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

export function buildUpstreamHeaders(
  incoming: Headers,
  protocol: ProviderProtocol,
  config: CockpitConfig,
): Headers {
  const headers = new Headers();

  for (const [name, value] of incoming) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP.has(lowerName)) continue;
    if (STRIPPED_REQUEST_HEADERS.has(lowerName)) continue;
    if (lowerName.startsWith('x-cockpit-')) continue;
    if (lowerName.startsWith('sec-')) continue;
    headers.set(name, value);
  }

  headers.set('accept-encoding', 'identity');

  const incomingAuthorization = incoming.get('authorization');
  const incomingApiKey = incoming.get('x-api-key');

  if (protocol === 'anthropic') {
    if (incomingApiKey && !isSentinel(incomingApiKey)) {
      headers.set('x-api-key', incomingApiKey);
    } else if (config.anthropic.apiKey) {
      headers.set('x-api-key', config.anthropic.apiKey);
    }

    if (incomingAuthorization && !isSentinel(incomingAuthorization)) {
      headers.set('authorization', incomingAuthorization);
    }

    if (!headers.has('anthropic-version')) {
      headers.set('anthropic-version', config.anthropic.version);
    }
  } else {
    if (incomingApiKey && !isSentinel(incomingApiKey)) {
      headers.set('x-api-key', incomingApiKey);
    }

    if (incomingAuthorization && !isSentinel(incomingAuthorization)) {
      headers.set('authorization', incomingAuthorization);
    } else if (config.openai.apiKey) {
      headers.set('authorization', `Bearer ${config.openai.apiKey}`);
    }
  }

  return headers;
}

export interface ResponseHeaderOptions {
  sessionId?: string;
  stepId?: string;
  stream: boolean;
}

export function buildResponseHeaders(upstream: Headers, options: ResponseHeaderOptions): Headers {
  const headers = new Headers();

  for (const [name, value] of upstream) {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  if (options.stream) {
    headers.set('cache-control', 'no-cache, no-transform');
    headers.set('x-accel-buffering', 'no');
  }
  if (options.sessionId) {
    headers.set('x-cockpit-session-id', options.sessionId);
  }
  if (options.stepId) {
    headers.set('x-cockpit-step-id', options.stepId);
  }

  return headers;
}

function anthropicErrorType(status: number): string {
  if (status === 429) return 'rate_limit_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

function openAiErrorType(status: number): string {
  if (status === 429) return 'rate_limit_error';
  if (status === 401) return 'authentication_error';
  if (status >= 500) return 'proxy_error';
  return 'invalid_request_error';
}

export function proxyErrorResponse(
  protocol: ProviderProtocol,
  status: number,
  message: string,
  code?: 'guard_blocked' | 'budget_exceeded',
): Response {
  const body =
    protocol === 'anthropic'
      ? {
          type: 'error',
          error: {
            type: anthropicErrorType(status),
            message,
            ...(code ? { code } : {}),
          },
        }
      : {
          error: {
            message,
            type: openAiErrorType(status),
            code: code ?? (status === 413 ? 'payload_too_large' : 'proxy_error'),
          },
        };

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
