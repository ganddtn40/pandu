import type { MiddlewareHandler } from 'hono';

import { isOriginAllowed } from '../config.js';
import { jsonError } from './errors.js';

const EXPOSED_HEADERS = [
  'x-cockpit-session-id',
  'x-cockpit-step-id',
  'request-id',
  'x-request-id',
  'retry-after',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-tokens-limit',
].join(',');

export function createCorsMiddleware(allowedOrigins: readonly string[]): MiddlewareHandler {
  return async (c, next): Promise<Response | void> => {
    const origin = c.req.header('origin');

    if (origin && !isOriginAllowed(origin, allowedOrigins)) {
      return jsonError(c, 403, 'forbidden', 'This origin is not allowed to access Cockpit.');
    }

    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    }

    if (c.req.method === 'OPTIONS') {
      const requestedHeaders = c.req.header('access-control-request-headers');
      return c.body(null, 204, {
        ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
        ...(origin ? { Vary: 'Origin' } : {}),
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers':
          requestedHeaders ??
          'authorization,content-type,x-api-key,anthropic-version,x-cockpit-protocol,x-cockpit-provider',
        'Access-Control-Max-Age': '86400',
      });
    }

    await next();
  };
}
