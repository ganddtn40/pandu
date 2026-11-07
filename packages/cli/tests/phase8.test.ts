import { describe, expect, it, vi } from 'vitest';
import type { Device, PairingSession, PairingSessionStatus } from '@cockpit/core';

import { createProgram } from '../src/cli.js';
import type { DaemonClient } from '../src/daemon-client.js';
import { DaemonRequestError } from '../src/daemon-client.js';
import {
  formatDevices,
  formatPairingSession,
  runDeviceList,
  runDeviceRevoke,
  runPair,
} from '../src/phase8.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-04-05T06:00:00.000Z';

const SESSION: PairingSession = {
  id: SESSION_ID,
  code: 'ABCD-EFGH',
  expiresAt: '2026-04-05T06:05:00.000Z',
  ttlSeconds: 300,
  name: 'Pixel 9',
  urls: ['http://192.168.1.20:4319'],
  deepLink: 'cockpit://pair?url=http%3A%2F%2F192.168.1.20%3A4319&code=ABCD-EFGH',
};

const DEVICE: Device = {
  id: DEVICE_ID,
  name: 'Pixel 9',
  platform: 'android',
  createdAt: NOW,
};

function fakeClient(overrides: Partial<Record<keyof DaemonClient, unknown>>): DaemonClient {
  return overrides as unknown as DaemonClient;
}

describe('phase 8 formatting', () => {
  it('shows the code, URLs, and deep link for a pairing session', () => {
    const text = formatPairingSession(SESSION);
    expect(text).toContain('ABCD-EFGH');
    expect(text).toContain('http://192.168.1.20:4319');
    expect(text).toContain('cockpit://pair?');
    expect(text).toContain('Pixel 9');
  });

  it('explains an empty device list', () => {
    expect(formatDevices([])).toContain('No paired devices');
  });

  it('prints active and revoked devices', () => {
    const text = formatDevices([
      { ...DEVICE, lastSeenAt: NOW },
      { ...DEVICE, id: '33333333-3333-4333-8333-333333333333', revokedAt: NOW },
    ]);
    expect(text).toContain('active');
    expect(text).toContain('revoked');
    expect(text).toContain('android');
  });
});

describe('pair command helpers', () => {
  it('creates a pairing session and returns JSON when requested', async () => {
    const createPairing = vi.fn().mockResolvedValue(SESSION);
    const output = await runPair(
      fakeClient({ createPairing }),
      { ttlSeconds: 300, name: 'Pixel 9' },
      { wait: false, json: true },
    );

    expect(createPairing).toHaveBeenCalledWith({ ttlSeconds: 300, name: 'Pixel 9' });
    expect(JSON.parse(output)).toMatchObject({ code: 'ABCD-EFGH' });
  });

  it('streams the session to the caller before waiting for a claim', async () => {
    const onSession = vi.fn();
    const status: PairingSessionStatus = {
      id: SESSION_ID,
      expiresAt: SESSION.expiresAt,
      usedAt: NOW,
      expired: false,
      claimed: true,
    };
    const output = await runPair(
      fakeClient({
        createPairing: vi.fn().mockResolvedValue(SESSION),
        pairingStatus: vi.fn().mockResolvedValue(status),
      }),
      { ttlSeconds: 300 },
      { wait: true, json: false, onSession, pollIntervalMs: 1 },
    );

    expect(onSession).toHaveBeenCalledWith(SESSION);
    expect(output).toContain('Paired');
  });

  it('reports an expired session', async () => {
    const output = await runPair(
      fakeClient({
        createPairing: vi.fn().mockResolvedValue(SESSION),
        pairingStatus: vi.fn().mockResolvedValue({
          id: SESSION_ID,
          expiresAt: SESSION.expiresAt,
          expired: true,
          claimed: false,
        }),
      }),
      { ttlSeconds: 60 },
      { wait: true, json: false, pollIntervalMs: 1 },
    );

    expect(output).toContain('expired');
  });

  it('reports a cancelled session when the daemon returns 404', async () => {
    const output = await runPair(
      fakeClient({
        createPairing: vi.fn().mockResolvedValue(SESSION),
        pairingStatus: vi
          .fn()
          .mockRejectedValue(new DaemonRequestError('missing', { status: 404 })),
      }),
      { ttlSeconds: 60 },
      { wait: true, json: false, pollIntervalMs: 1 },
    );

    expect(output).toContain('cancelled');
  });
});

describe('devices command helpers', () => {
  it('lists devices as JSON', async () => {
    const output = await runDeviceList(
      fakeClient({ listDevices: vi.fn().mockResolvedValue([DEVICE]) }),
      true,
    );
    expect(JSON.parse(output)).toEqual([DEVICE]);
  });

  it('revokes a device and confirms', async () => {
    const revoked: Device = { ...DEVICE, revokedAt: NOW };
    const output = await runDeviceRevoke(
      fakeClient({ revokeDevice: vi.fn().mockResolvedValue(revoked) }),
      DEVICE_ID,
      false,
    );
    expect(output).toContain('Revoked Pixel 9');
    expect(output).toContain(DEVICE_ID);
  });
});

describe('command registration', () => {
  it('registers pair and devices commands', () => {
    const program = createProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toContain('pair');
    expect(names).toContain('devices');

    const devices = program.commands.find((command) => command.name() === 'devices');
    expect(devices?.commands.map((command) => command.name())).toEqual(['list', 'revoke']);
  });
});
