import { IdSchema, ProviderProtocolSchema, type ProviderProtocol } from '@cockpit/core';

export type ProxyRouteResult =
  | {
      ok: true;
      sessionId?: string;
      protocol: ProviderProtocol;
      upstreamPath: string;
      forcedProtocol: boolean;
    }
  | {
      ok: false;
      reason: 'not_proxy' | 'invalid_session' | 'invalid_path';
    };

function protocolFromHeader(value: string | undefined): ProviderProtocol | undefined {
  if (!value) return undefined;
  const parsed = ProviderProtocolSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

function detectPathProtocol(path: string): ProviderProtocol {
  if (
    path === '/v1/messages' ||
    path.startsWith('/v1/messages/') ||
    path === '/v1/complete' ||
    path.startsWith('/v1/complete/')
  ) {
    return 'anthropic';
  }
  return 'openai';
}

function stripForcedPrefix(path: string, prefix: '/openai' | '/anthropic'): string | undefined {
  if (path === prefix) return '/v1';
  if (path.startsWith(`${prefix}/v1`)) return path.slice(prefix.length);
  return undefined;
}

export function parseProxyRoute(pathname: string, protocolHeader?: string): ProxyRouteResult {
  let remainder = pathname;
  let sessionId: string | undefined;

  const sessionMatch = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname);
  if (sessionMatch) {
    const rawSessionId = sessionMatch[1];
    if (!rawSessionId) return { ok: false, reason: 'invalid_session' };
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSessionId);
    } catch {
      return { ok: false, reason: 'invalid_session' };
    }
    if (!IdSchema.safeParse(decoded).success) {
      return { ok: false, reason: 'invalid_session' };
    }
    sessionId = decoded;
    remainder = sessionMatch[2] ?? '/';
  }

  let forcedProtocol: ProviderProtocol | undefined;
  const openAiPath = stripForcedPrefix(remainder, '/openai');
  if (openAiPath !== undefined) {
    forcedProtocol = 'openai';
    remainder = openAiPath;
  }
  const anthropicPath = stripForcedPrefix(remainder, '/anthropic');
  if (anthropicPath !== undefined) {
    forcedProtocol = 'anthropic';
    remainder = anthropicPath;
  }

  if (!remainder.startsWith('/v1/') && remainder !== '/v1') {
    return { ok: false, reason: 'not_proxy' };
  }
  if (remainder === '/v1') {
    return { ok: false, reason: 'invalid_path' };
  }

  const headerProtocol = protocolFromHeader(protocolHeader);
  const protocol = forcedProtocol ?? headerProtocol ?? detectPathProtocol(remainder);

  return {
    ok: true,
    ...(sessionId ? { sessionId } : {}),
    protocol,
    upstreamPath: remainder,
    forcedProtocol: forcedProtocol !== undefined,
  };
}
