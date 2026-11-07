import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';

import type { Device } from '@cockpit/core';

import { isLoopbackAddress } from '../config.js';
import type { PairingService } from '../pairing/service.js';
import { jsonError } from './errors.js';

declare module 'hono' {
  interface ContextVariableMap {
    device: Device | undefined;
    remoteAddress: string | undefined;
  }
}

export interface DeviceAuthOptions {
  pairing: PairingService;
  /**
   * Test seam for environments where the Node connection info is unavailable.
   * Production uses the socket's remote address, never a spoofable header.
   */
  resolveRemoteAddress?: (c: Context) => string | undefined;
}

function socketRemoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function bearerToken(c: Context): string | undefined {
  const header = c.req.header('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

const PUBLIC_PATHS = new Set(['/api/health', '/api/pairing/claim']);

function isLocalOnlyPath(path: string): boolean {
  return (
    path === '/api/pairing/sessions' ||
    path.startsWith('/api/pairing/sessions/') ||
    path === '/api/demo/seed'
  );
}

function requiresDeviceToken(path: string): boolean {
  return path === '/api/ws' || path.startsWith('/api/') || path.startsWith('/s/');
}

/**
 * Loopback stays trusted. Everything reachable from the network must present a
 * device token, except health and the pairing claim endpoint. Pairing-session
 * creation and demo seeding are deliberately local-only so a compromised token
 * cannot mint more devices or pollute the flight log.
 */
export function createDeviceAuthMiddleware(options: DeviceAuthOptions): MiddlewareHandler {
  const resolveRemoteAddress = options.resolveRemoteAddress ?? socketRemoteAddress;

  return async (c, next): Promise<Response | void> => {
    const remoteAddress = resolveRemoteAddress(c);
    c.set('remoteAddress', remoteAddress);
    c.set('device', undefined);

    if (!remoteAddress || isLoopbackAddress(remoteAddress)) {
      await next();
      return;
    }

    const path = new URL(c.req.url).pathname;

    if (isLocalOnlyPath(path)) {
      return jsonError(
        c,
        403,
        'forbidden',
        'Pairing and demo seeding can only be done from the local machine.',
      );
    }

    if (PUBLIC_PATHS.has(path)) {
      await next();
      return;
    }

    if (!requiresDeviceToken(path)) {
      await next();
      return;
    }

    const token = bearerToken(c) ?? (path === '/api/ws' ? c.req.query('token') : undefined);
    if (!token) {
      return jsonError(
        c,
        401,
        'unauthorized',
        'A paired device token is required for remote access. Pair this device from the Cockpit dashboard.',
      );
    }

    const device = options.pairing.authenticate(token);
    if (!device) {
      return jsonError(c, 401, 'unauthorized', 'The device token is invalid or has been revoked.');
    }

    c.set('device', device);
    await next();
  };
}
