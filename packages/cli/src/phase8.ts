import { setTimeout as delay } from 'node:timers/promises';

import type {
  Device,
  PairingSession,
  PairingSessionInput,
  PairingSessionStatus,
} from '@cockpit/core';

import { DaemonRequestError, type DaemonClient } from './daemon-client.js';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export function formatPairingSession(session: PairingSession): string {
  const lines = [
    `Pairing code  ${session.code}`,
    `Expires       ${session.expiresAt}`,
    ...(session.name ? [`Device name   ${session.name}`] : []),
    '',
    'Reachable URLs',
    ...session.urls.map((url) => `  ${url}`),
    '',
    'Deep link',
    `  ${session.deepLink}`,
    '',
    'Open the Cockpit mobile app and enter the code, or scan the QR code from',
    'the dashboard at /pair. The code can be used once and expires quickly.',
    '',
  ];
  return lines.join('\n');
}

export function formatDevices(devices: Device[]): string {
  if (devices.length === 0) {
    return 'No paired devices. Run `cockpit pair` to add one.\n';
  }

  const rows = devices.map((device) => {
    const status = device.revokedAt ? 'revoked' : 'active';
    return [
      device.id,
      truncate(device.name, 24).padEnd(24),
      device.platform.padEnd(8),
      (device.lastSeenAt ?? 'never').padEnd(24),
      status,
    ].join('  ');
  });

  return [
    'ID                                    NAME                      PLATFORM  LAST SEEN                 STATUS',
    ...rows,
  ]
    .join('\n')
    .concat('\n');
}

export interface PairRunOptions {
  wait: boolean;
  json: boolean;
  onSession?: (session: PairingSession) => void;
  pollIntervalMs?: number;
}

async function waitForClaim(
  client: DaemonClient,
  session: PairingSession,
  pollIntervalMs: number,
): Promise<PairingSessionStatus | undefined> {
  const deadline = new Date(session.expiresAt).getTime() + 5_000;

  for (;;) {
    try {
      const status = await client.pairingStatus(session.id);
      if (status.claimed || status.expired) return status;
    } catch (error) {
      if (error instanceof DaemonRequestError && error.status === 404) return undefined;
      throw error;
    }

    if (Date.now() >= deadline) {
      return {
        id: session.id,
        expiresAt: session.expiresAt,
        expired: true,
        claimed: false,
      };
    }
    await delay(pollIntervalMs);
  }
}

export async function runPair(
  client: DaemonClient,
  input: PairingSessionInput,
  options: PairRunOptions,
): Promise<string> {
  const session = await client.createPairing(input);

  if (!options.json) {
    if (options.onSession) options.onSession(session);
  }

  if (!options.wait) {
    return options.json ? json(session) : options.onSession ? '' : formatPairingSession(session);
  }

  const status = await waitForClaim(client, session, options.pollIntervalMs ?? 2_000);

  if (options.json) {
    return json({ pairing: session, status: status ?? null });
  }

  if (status?.claimed) return 'Paired. The device can now reach Cockpit with its token.\n';
  if (status?.expired) return 'The pairing session expired. Run `cockpit pair` again.\n';
  return 'The pairing session was cancelled.\n';
}

export async function runDeviceList(client: DaemonClient, asJson: boolean): Promise<string> {
  const devices = await client.listDevices();
  return asJson ? json(devices) : formatDevices(devices);
}

export async function runDeviceRevoke(
  client: DaemonClient,
  id: string,
  asJson: boolean,
): Promise<string> {
  const device = await client.revokeDevice(id);
  if (asJson) return json(device);
  return `Revoked ${device.name} (${device.id}). Its token no longer works.\n`;
}
