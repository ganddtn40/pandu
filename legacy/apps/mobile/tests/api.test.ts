import { describe, expect, it } from 'vitest';

import {
  MobileApiError,
  createMobileClient,
  describeMobileError,
  isUnauthorized,
} from '../src/lib/api';
import { COMPLETED_SESSION, DEVICE, HEALTH, MOBILE_SESSION, STATS } from './fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createMobileClient', () => {
  it('claims a pairing code without sending a bearer token', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = createMobileClient({
      baseUrl: 'http://192.168.1.20:4319/',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return jsonResponse({
          device: DEVICE,
          token: MOBILE_SESSION.token,
          baseUrl: 'http://192.168.1.20:4319',
        });
      },
    });

    const claim = await client.claimPairing({ code: 'abcd efgh', name: ' Pixel 9 ' });

    expect(claim.device.id).toBe(DEVICE.id);
    expect(requests[0]?.url).toBe('http://192.168.1.20:4319/api/pairing/claim');
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      code: 'ABCDEFGH',
      platform: 'android',
      name: 'Pixel 9',
    });
  });

  it('rejects an invalid code before making a request', async () => {
    let called = false;
    const client = createMobileClient({
      baseUrl: 'http://127.0.0.1:4319',
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    });

    await expect(client.claimPairing({ code: 'nope' })).rejects.toMatchObject({
      name: 'MobileApiError',
      code: 'bad_request',
    });
    expect(called).toBe(false);
  });

  it('adds the bearer token to authenticated requests', async () => {
    const requests: RequestInit[] = [];
    const client = createMobileClient({
      baseUrl: 'http://127.0.0.1:4319',
      token: MOBILE_SESSION.token,
      fetchImpl: async (_input, init) => {
        requests.push(init ?? {});
        return jsonResponse({ stats: STATS });
      },
    });

    const stats = await client.stats();

    expect(stats.sessionCount).toBe(STATS.sessionCount);
    expect(requests[0]?.headers).toMatchObject({
      authorization: `Bearer ${MOBILE_SESSION.token}`,
      accept: 'application/json',
    });
  });

  it('loads health without a token and sessions with one', async () => {
    const urls: string[] = [];
    const client = createMobileClient({
      baseUrl: 'http://127.0.0.1:4319',
      token: MOBILE_SESSION.token,
      fetchImpl: async (input) => {
        urls.push(String(input));
        if (String(input).endsWith('/api/health')) return jsonResponse(HEALTH);
        return jsonResponse({ sessions: [COMPLETED_SESSION], nextCursor: null });
      },
    });

    expect((await client.health()).version).toBe('0.1.0');
    expect((await client.listSessions()).map((session) => session.id)).toEqual([
      COMPLETED_SESSION.id,
    ]);
    expect(urls).toEqual([
      'http://127.0.0.1:4319/api/health',
      'http://127.0.0.1:4319/api/sessions?limit=50',
    ]);
  });

  it('revokes a device with DELETE', async () => {
    const requests: RequestInit[] = [];
    const client = createMobileClient({
      baseUrl: 'http://127.0.0.1:4319',
      token: MOBILE_SESSION.token,
      fetchImpl: async (_input, init) => {
        requests.push(init ?? {});
        return jsonResponse({ device: { ...DEVICE, revokedAt: '2026-04-05T06:30:00.000Z' } });
      },
    });

    const device = await client.revokeDevice(DEVICE.id);

    expect(device.revokedAt).toBe('2026-04-05T06:30:00.000Z');
    expect(requests[0]?.method).toBe('DELETE');
  });

  it('surfaces daemon errors with status and code', async () => {
    const client = createMobileClient({
      baseUrl: 'http://127.0.0.1:4319',
      token: MOBILE_SESSION.token,
      fetchImpl: async () =>
        jsonResponse(
          { error: { code: 'unauthorized', message: 'This device token was revoked.' } },
          401,
        ),
    });

    const error = await client.stats().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MobileApiError);
    expect(error).toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'This device token was revoked.',
    });
    expect(isUnauthorized(error)).toBe(true);
    expect(describeMobileError(error)).toBe('This device token was revoked.');
  });

  it('reports an unreachable daemon clearly', async () => {
    const client = createMobileClient({
      baseUrl: 'http://127.0.0.1:4319',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.health()).rejects.toThrow(/could not reach the daemon/i);
  });

  it('rejects payloads that do not match the schema', async () => {
    const client = createMobileClient({
      baseUrl: 'http://127.0.0.1:4319',
      fetchImpl: async () => jsonResponse({ unexpected: true }),
    });

    await expect(client.health()).rejects.toMatchObject({
      name: 'MobileApiError',
      status: 200,
    });
  });
});
