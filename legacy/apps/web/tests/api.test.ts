import { describe, expect, it } from 'vitest';

import { ApiRequestError, createApiClient } from '../src/lib/api';
import {
  EMPTY_STATS,
  OTHER_SESSION_ID,
  SESSION_ID,
  makePairingSession,
  makeSession,
  makeStep,
} from './fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createApiClient', () => {
  it('reads daemon stats from a relative API route', async () => {
    const requests: string[] = [];
    const client = createApiClient({
      baseUrl: 'http://daemon.test/',
      fetchImpl: async (input) => {
        requests.push(String(input));
        return jsonResponse({ stats: EMPTY_STATS });
      },
    });

    const response = await client.stats();

    expect(requests).toEqual(['http://daemon.test/api/stats']);
    expect(response.stats.sessionCount).toBe(0);
  });

  it('builds session filters, cursors, and limits', async () => {
    const requests: string[] = [];
    const client = createApiClient({
      fetchImpl: async (input) => {
        requests.push(String(input));
        return jsonResponse({
          sessions: [makeSession()],
          nextCursor: 'cursor-2',
        });
      },
    });

    const response = await client.listSessions({
      search: 'auth race',
      status: 'completed',
      cursor: 'cursor-1',
      limit: 25,
    });

    const url = new URL(requests[0] ?? '', 'http://daemon.test');
    expect(url.pathname).toBe('/api/sessions');
    expect(url.searchParams.get('search')).toBe('auth race');
    expect(url.searchParams.get('status')).toBe('completed');
    expect(url.searchParams.get('cursor')).toBe('cursor-1');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(response.sessions).toHaveLength(1);
    expect(response.nextCursor).toBe('cursor-2');
  });

  it('omits the status filter when it is "all"', async () => {
    const requests: string[] = [];
    const client = createApiClient({
      fetchImpl: async (input) => {
        requests.push(String(input));
        return jsonResponse({ sessions: [], nextCursor: null });
      },
    });

    await client.listSessions({ status: 'all' });

    expect(requests[0]).toBe('/api/sessions?limit=50');
  });

  it('requests step detail with encoded ids', async () => {
    const requests: string[] = [];
    const client = createApiClient({
      fetchImpl: async (input) => {
        requests.push(String(input));
        return String(input).includes('/steps?')
          ? jsonResponse({ steps: [makeStep()] })
          : jsonResponse({ step: makeStep(), chunks: [], toolCalls: [] });
      },
    });

    await client.getStep(OTHER_SESSION_ID);
    await client.getSessionSteps(SESSION_ID, { limit: 2000 });

    expect(requests[0]).toBe(`/api/steps/${OTHER_SESSION_ID}`);
    expect(requests[1]).toBe(`/api/sessions/${SESSION_ID}/steps?limit=2000`);
  });

  it('maps daemon error envelopes onto ApiRequestError', async () => {
    const client = createApiClient({
      fetchImpl: async () =>
        jsonResponse(
          {
            error: {
              code: 'not_found',
              message: 'The requested session was not found.',
            },
          },
          404,
        ),
    });

    const error = await client.getSession(SESSION_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'The requested session was not found.',
    });
  });

  it('reports an unreachable daemon clearly', async () => {
    const client = createApiClient({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(client.stats()).rejects.toThrow(
      'The Cockpit daemon is unreachable. Check that it is running on this machine.',
    );
  });

  it('rejects payloads that do not match the schema', async () => {
    const client = createApiClient({
      fetchImpl: async () => jsonResponse({ unexpected: true }),
    });

    await expect(client.getSessionSteps(SESSION_ID)).rejects.toMatchObject({
      name: 'ApiRequestError',
      message: 'The daemon returned a response Cockpit could not understand.',
    });
  });

  it('supports aborting requests', async () => {
    const controller = new AbortController();
    const client = createApiClient({
      fetchImpl: async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });

    await expect(client.stats({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('creates and cancels pairing sessions', async () => {
    const requests: { url: string; method: string; body?: string }[] = [];
    const session = makePairingSession();

    const client = createApiClient({
      fetchImpl: async (input, init) => {
        const method = init?.method ?? 'GET';
        requests.push({
          url: String(input),
          method,
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return jsonResponse({ pairing: session });
      },
    });

    const created = await client.createPairing({ name: 'Pixel 9', ttlSeconds: 120 });
    await client.cancelPairing(created.id);

    expect(created).toEqual(session);
    expect(requests[0]).toMatchObject({ url: '/api/pairing/sessions', method: 'POST' });
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      name: 'Pixel 9',
      ttlSeconds: 120,
    });
    expect(requests[1]).toEqual({
      url: `/api/pairing/sessions/${session.id}`,
      method: 'DELETE',
    });
  });
});
