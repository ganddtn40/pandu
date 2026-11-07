import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildWebSocketUrl, liveStatusLabel } from '../src/lib/live';

const HTTP_LOCATION = { protocol: 'http:', host: '127.0.0.1:4319' } as const;
const HTTPS_LOCATION = { protocol: 'https:', host: 'cockpit.example:8443' } as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildWebSocketUrl', () => {
  it('derives a ws:// URL from an http origin', () => {
    expect(buildWebSocketUrl(undefined, HTTP_LOCATION)).toBe('ws://127.0.0.1:4319/api/ws');
  });

  it('derives a wss:// URL from an https origin', () => {
    expect(buildWebSocketUrl(undefined, HTTPS_LOCATION)).toBe('wss://cockpit.example:8443/api/ws');
  });

  it('adds the session filter as a query parameter', () => {
    const url = new URL(buildWebSocketUrl('session-1', HTTP_LOCATION));
    expect(url.pathname).toBe('/api/ws');
    expect(url.searchParams.get('sessionId')).toBe('session-1');
  });

  it('honors an explicit VITE_COCKPIT_WS_URL override', () => {
    vi.stubEnv('VITE_COCKPIT_WS_URL', 'ws://127.0.0.1:9000/custom/ws');

    expect(buildWebSocketUrl('session-2', HTTP_LOCATION)).toBe(
      'ws://127.0.0.1:9000/custom/ws?sessionId=session-2',
    );
  });
});

describe('liveStatusLabel', () => {
  it('labels every feed state', () => {
    expect(liveStatusLabel('live')).toBe('Live');
    expect(liveStatusLabel('connecting')).toBe('Connecting');
    expect(liveStatusLabel('reconnecting')).toBe('Reconnecting');
    expect(liveStatusLabel('offline')).toBe('Offline');
  });
});
