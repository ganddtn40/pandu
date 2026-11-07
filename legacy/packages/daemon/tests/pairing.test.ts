import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVICE_TOKEN_PATTERN,
  DevicesResponseSchema,
  PairingClaimResponseSchema,
  PairingSessionResponseSchema,
  PairingSessionStatusResponseSchema,
  type LiveEvent,
} from '@cockpit/core';

import {
  PairingService,
  PairingServiceError,
  createLogger,
  loadConfig,
  openDatabase,
  Store,
  LiveEventBus,
  type StartedDaemon,
} from '../src/index.js';

import { startTestDaemon, startUpstream, type FakeUpstream } from './helpers.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface UnitContext {
  service: PairingService;
  store: Store;
  events: LiveEvent[];
  close: () => void;
  setNow: (value: Date) => void;
}

function createUnit(options: { host?: string; publicUrl?: string } = {}): UnitContext {
  const connection = openDatabase({ databasePath: ':memory:' });
  const store = new Store(connection);
  const logger = createLogger('silent');
  const bus = new LiveEventBus({ initialSequence: 0, logger });
  const events: LiveEvent[] = [];
  bus.subscribe((event) => events.push(event));

  let now = new Date('2026-04-05T06:00:00.000Z');
  let codeIndex = 0;
  let tokenIndex = 0;
  const config = loadConfig({
    COCKPIT_HOST: options.host ?? '127.0.0.1',
    COCKPIT_PORT: '4319',
    ...(options.publicUrl ? { COCKPIT_PUBLIC_URL: options.publicUrl } : {}),
    COCKPIT_LOG_LEVEL: 'silent',
  });
  const service = new PairingService({
    store,
    bus,
    logger,
    config,
    now: () => now,
    codeGenerator: () => `ABCDEFG${'HJKLMNPQ'.charAt(codeIndex++)}`,
    tokenGenerator: () => `ckp_${String(tokenIndex++).padStart(43, '0')}`,
  });
  service.setBaseUrl('http://127.0.0.1:4319');

  return {
    service,
    store,
    events,
    close: () => store.close(),
    setNow: (value) => {
      now = value;
    },
  };
}

describe('PairingService', () => {
  it('stores only hashes and returns a formatted code with a deep link', () => {
    const context = createUnit();
    try {
      const session = context.service.createSession({ ttlSeconds: 300, name: 'Pixel' });

      expect(session.code).toBe('ABCD-EFGH');
      expect(session.ttlSeconds).toBe(300);
      expect(session.urls).toEqual(['http://127.0.0.1:4319']);
      expect(session.deepLink).toContain('cockpit://pair?');
      expect(session.deepLink).toContain('ABCD-EFGH');
      expect(context.store.getPairingTokenByHash(sha256('ABCDEFGH'))).toBeDefined();
      expect(context.store.getPairingTokenByHash('ABCDEFGH')).toBeUndefined();
      expect(context.events.map((event) => event.type)).toContain('pairing.requested');
      expect(JSON.stringify(context.events)).not.toContain('ABCD-EFGH');
    } finally {
      context.close();
    }
  });

  it('claims a code once, hashes the device token, and emits completion', () => {
    const context = createUnit();
    try {
      const session = context.service.createSession({ ttlSeconds: 300 });
      const claim = context.service.claim(
        { code: 'abcd-efgh', name: 'Pixel 9', platform: 'android' },
        '203.0.113.9',
      );

      expect(claim.device.name).toBe('Pixel 9');
      expect(claim.device.platform).toBe('android');
      expect(DEVICE_TOKEN_PATTERN.test(claim.token)).toBe(true);
      expect(claim.baseUrl).toBe('http://127.0.0.1:4319');
      expect(context.store.getDeviceByTokenHash(sha256(claim.token))?.id).toBe(claim.device.id);
      expect(context.store.getDeviceByTokenHash(claim.token)).toBeUndefined();
      expect(context.events.map((event) => event.type)).toContain('pairing.completed');

      expect(() =>
        context.service.claim({ code: session.code, platform: 'android' }, '203.0.113.9'),
      ).toThrowError(PairingServiceError);
    } finally {
      context.close();
    }
  });

  it('expires sessions and reports their status', () => {
    const context = createUnit();
    try {
      const session = context.service.createSession({ ttlSeconds: 60 });
      expect(context.service.getSession(session.id)).toMatchObject({
        expired: false,
        claimed: false,
      });

      context.setNow(new Date('2026-04-05T06:01:01.000Z'));
      expect(context.service.getSession(session.id)).toMatchObject({
        expired: true,
        claimed: false,
      });
      expect(() =>
        context.service.claim({ code: session.code, platform: 'android' }, '203.0.113.9'),
      ).toThrowError(/invalid or has expired/);
    } finally {
      context.close();
    }
  });

  it('rate limits repeated failed claims per address', () => {
    const context = createUnit();
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect(() =>
          context.service.claim({ code: 'ZZZZ-ZZZZ', platform: 'android' }, '203.0.113.9'),
        ).toThrowError(/invalid or has expired/);
      }

      expect(() =>
        context.service.claim({ code: 'ZZZZ-ZZZZ', platform: 'android' }, '203.0.113.9'),
      ).toThrowError(/Too many pairing attempts/);
    } finally {
      context.close();
    }
  });

  it('only lets a paired device revoke itself and revokes its token', () => {
    const context = createUnit();
    try {
      const firstSession = context.service.createSession({ ttlSeconds: 300 });
      const first = context.service.claim(
        { code: firstSession.code, platform: 'android' },
        '203.0.113.9',
      );
      const secondSession = context.service.createSession({ ttlSeconds: 300 });
      const second = context.service.claim(
        { code: secondSession.code, platform: 'ios' },
        '203.0.113.10',
      );

      expect(() =>
        context.service.revokeDevice(first.device.id, { actorDeviceId: second.device.id }),
      ).toThrowError(/only revoke itself/);

      const revoked = context.service.revokeDevice(first.device.id);
      expect(revoked.revokedAt).toBeDefined();
      expect(context.service.authenticate(first.token)).toBeUndefined();
      expect(context.service.authenticate(second.token)?.id).toBe(second.device.id);
      expect(context.events.map((event) => event.type)).toContain('device.revoked');
    } finally {
      context.close();
    }
  });

  it('touches last-seen at most once per minute', () => {
    const context = createUnit();
    try {
      const session = context.service.createSession({ ttlSeconds: 300 });
      const claim = context.service.claim({ code: session.code, platform: 'android' });
      expect(claim.device.lastSeenAt).toBeUndefined();

      context.setNow(new Date('2026-04-05T06:00:30.000Z'));
      expect(context.service.authenticate(claim.token)?.lastSeenAt).toBe(
        '2026-04-05T06:00:30.000Z',
      );

      context.setNow(new Date('2026-04-05T06:00:40.000Z'));
      expect(context.service.authenticate(claim.token)?.lastSeenAt).toBe(
        '2026-04-05T06:00:30.000Z',
      );

      context.setNow(new Date('2026-04-05T06:01:31.000Z'));
      expect(context.service.authenticate(claim.token)?.lastSeenAt).toBe(
        '2026-04-05T06:01:31.000Z',
      );
    } finally {
      context.close();
    }
  });

  it('prefers a configured public URL and advertises LAN URLs for non-loopback binds', () => {
    const publicContext = createUnit({ publicUrl: 'https://cockpit.example.com' });
    try {
      expect(publicContext.service.baseUrls()).toEqual(['https://cockpit.example.com']);
    } finally {
      publicContext.close();
    }

    const lanContext = createUnit({ host: '0.0.0.0' });
    try {
      lanContext.service.setBaseUrl('http://127.0.0.1:4319');
      const urls = lanContext.service.baseUrls();
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url.startsWith('http://')).toBe(true);
    } finally {
      lanContext.close();
    }
  });
});

interface HttpContext {
  directory: string;
  upstream: FakeUpstream;
  daemon: StartedDaemon;
}

const HTTP_CONTEXTS: HttpContext[] = [];

async function bootHttp(): Promise<StartedDaemon> {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-pairing-'));
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const daemon = await startTestDaemon({
    home: path.join(directory, 'home'),
    openAiUpstream: upstream.url,
    resolveRemoteAddress: (c) => c.req.header('x-test-remote-address') ?? '127.0.0.1',
  });
  HTTP_CONTEXTS.push({ directory, upstream, daemon });
  return daemon;
}

afterEach(async () => {
  while (HTTP_CONTEXTS.length > 0) {
    const context = HTTP_CONTEXTS.pop();
    if (!context) continue;
    await context.daemon.close().catch(() => undefined);
    await context.upstream.close().catch(() => undefined);
    rmSync(context.directory, { recursive: true, force: true });
  }
});

function remoteHeaders(
  address: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { 'content-type': 'application/json', 'x-test-remote-address': address, ...extra };
}

async function createPairing(daemon: StartedDaemon): Promise<{
  id: string;
  code: string;
  deepLink: string;
  urls: string[];
}> {
  const response = await fetch(`${daemon.url}/api/pairing/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pixel 9' }),
  });
  expect(response.status).toBe(201);
  return PairingSessionResponseSchema.parse(await response.json()).pairing;
}

async function claim(
  daemon: StartedDaemon,
  code: string,
  address: string,
): Promise<{ device: { id: string; name: string }; token: string }> {
  const response = await fetch(`${daemon.url}/api/pairing/claim`, {
    method: 'POST',
    headers: remoteHeaders(address),
    body: JSON.stringify({ code, platform: 'android' }),
  });
  expect(response.status).toBe(200);
  return PairingClaimResponseSchema.parse(await response.json());
}

describe('pairing HTTP API', () => {
  it('creates local pairing sessions and blocks remote creation', async () => {
    const daemon = await bootHttp();
    const pairing = await createPairing(daemon);

    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(pairing.deepLink).toContain('cockpit://pair?');
    expect(pairing.urls[0]).toBe(daemon.url);

    const status = await fetch(`${daemon.url}/api/pairing/sessions/${pairing.id}`);
    expect(status.status).toBe(200);
    expect(PairingSessionStatusResponseSchema.parse(await status.json()).pairing.claimed).toBe(
      false,
    );

    const remote = await fetch(`${daemon.url}/api/pairing/sessions`, {
      method: 'POST',
      headers: remoteHeaders('203.0.113.9'),
      body: JSON.stringify({}),
    });
    expect(remote.status).toBe(403);
  });

  it('keeps health and claim public while gating the rest of the API', async () => {
    const daemon = await bootHttp();

    const health = await fetch(`${daemon.url}/api/health`, {
      headers: remoteHeaders('203.0.113.9'),
    });
    expect(health.status).toBe(200);

    const stats = await fetch(`${daemon.url}/api/stats`, {
      headers: remoteHeaders('203.0.113.9'),
    });
    expect(stats.status).toBe(401);

    const pairing = await createPairing(daemon);
    const claimed = await claim(daemon, pairing.code, '203.0.113.9');

    const authorized = await fetch(`${daemon.url}/api/stats`, {
      headers: remoteHeaders('203.0.113.9', {
        authorization: `Bearer ${claimed.token}`,
      }),
    });
    expect(authorized.status).toBe(200);

    const me = await fetch(`${daemon.url}/api/devices/me`, {
      headers: remoteHeaders('203.0.113.9', {
        authorization: `Bearer ${claimed.token}`,
      }),
    });
    expect(me.status).toBe(200);

    const devices = await fetch(`${daemon.url}/api/devices`, {
      headers: remoteHeaders('203.0.113.9', {
        authorization: `Bearer ${claimed.token}`,
      }),
    });
    expect(DevicesResponseSchema.parse(await devices.json()).devices).toHaveLength(1);

    const status = await fetch(`${daemon.url}/api/pairing/sessions/${pairing.id}`);
    expect(PairingSessionStatusResponseSchema.parse(await status.json()).pairing.claimed).toBe(
      true,
    );

    const reused = await fetch(`${daemon.url}/api/pairing/claim`, {
      method: 'POST',
      headers: remoteHeaders('203.0.113.9'),
      body: JSON.stringify({ code: pairing.code, platform: 'android' }),
    });
    expect(reused.status).toBe(401);
  });

  it('revokes devices locally or by the device itself, never by another device', async () => {
    const daemon = await bootHttp();
    const firstPairing = await createPairing(daemon);
    const first = await claim(daemon, firstPairing.code, '203.0.113.9');
    const secondPairing = await createPairing(daemon);
    const second = await claim(daemon, secondPairing.code, '203.0.113.10');

    const forbidden = await fetch(`${daemon.url}/api/devices/${first.device.id}`, {
      method: 'DELETE',
      headers: remoteHeaders('203.0.113.10', {
        authorization: `Bearer ${second.token}`,
      }),
    });
    expect(forbidden.status).toBe(403);

    const revoked = await fetch(`${daemon.url}/api/devices/${first.device.id}`, {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);

    const rejected = await fetch(`${daemon.url}/api/stats`, {
      headers: remoteHeaders('203.0.113.9', {
        authorization: `Bearer ${first.token}`,
      }),
    });
    expect(rejected.status).toBe(401);

    const selfRevoked = await fetch(`${daemon.url}/api/devices/${second.device.id}`, {
      method: 'DELETE',
      headers: remoteHeaders('203.0.113.10', {
        authorization: `Bearer ${second.token}`,
      }),
    });
    expect(selfRevoked.status).toBe(200);

    const afterSelfRevoke = await fetch(`${daemon.url}/api/stats`, {
      headers: remoteHeaders('203.0.113.10', {
        authorization: `Bearer ${second.token}`,
      }),
    });
    expect(afterSelfRevoke.status).toBe(401);
  });

  it('cancels an unused pairing session', async () => {
    const daemon = await bootHttp();
    const pairing = await createPairing(daemon);

    const cancelled = await fetch(`${daemon.url}/api/pairing/sessions/${pairing.id}`, {
      method: 'DELETE',
    });
    expect(cancelled.status).toBe(204);

    const status = await fetch(`${daemon.url}/api/pairing/sessions/${pairing.id}`);
    expect(status.status).toBe(404);
  });

  it('accepts a device token on the WebSocket endpoint', async () => {
    const daemon = await bootHttp();
    const pairing = await createPairing(daemon);
    const claimed = await claim(daemon, pairing.code, '203.0.113.9');
    const wsUrl = `${daemon.url.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(claimed.token)}`;

    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        headers: { 'x-test-remote-address': '203.0.113.9' },
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('Timed out waiting for the WebSocket ready message.'));
      }, 5_000);
      socket.once('message', (data) => {
        clearTimeout(timer);
        resolve(data.toString());
        socket.close();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(JSON.parse(message)).toMatchObject({ type: 'ready' });
  });
});
