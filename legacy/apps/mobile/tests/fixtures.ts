import {
  DeviceSchema,
  HealthResponseSchema,
  SessionSchema,
  StatsResponseSchema,
  type Device,
  type HealthResponse,
  type OverviewStats,
  type Session,
} from '@cockpit/core';

import type { MobileApiClient } from '../src/lib/api';
import type { MobileSession } from '../src/lib/session';

export const DEVICE: Device = DeviceSchema.parse({
  id: '24242424-2424-4424-8424-242424242424',
  name: 'Pixel 9',
  platform: 'android',
  createdAt: '2026-04-05T06:00:00.000Z',
  lastSeenAt: '2026-04-05T06:10:00.000Z',
});

export const MOBILE_SESSION: MobileSession = {
  baseUrl: 'http://192.168.1.20:4319',
  token: `ckp_${'a'.repeat(43)}`,
  device: DEVICE,
  pairedAt: '2026-04-05T06:00:00.000Z',
};

export const HEALTH: HealthResponse = HealthResponseSchema.parse({
  ok: true,
  service: 'cockpit-daemon',
  version: '0.1.0',
  uptimeSeconds: 3_725,
  database: 'ok',
  demoMode: false,
  protocol: { openai: true, anthropic: true },
});

export const STATS: OverviewStats = StatsResponseSchema.parse({
  stats: {
    sessionCount: 42,
    activeSessionCount: 1,
    stepCount: 512,
    toolCallCount: 128,
    inputTokens: 1_200_000,
    outputTokens: 240_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 3.42,
    unknownCostCalls: 0,
    errorCount: 3,
    lastSessionAt: '2026-04-05T06:10:00.000Z',
  },
}).stats;

export const ACTIVE_SESSION: Session = SessionSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Fix auth regression',
  source: 'proxy',
  status: 'active',
  agent: { name: 'Claude Code' },
  startedAt: '2026-04-05T06:00:00.000Z',
  totals: {
    stepCount: 12,
    modelCallCount: 6,
    toolCallCount: 9,
    inputTokens: 21_000,
    outputTokens: 4_000,
    totalCostUsd: 0.42,
    errorCount: 1,
  },
});

export const COMPLETED_SESSION: Session = SessionSchema.parse({
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Ship dashboard filters',
  source: 'proxy',
  status: 'completed',
  agent: { name: 'Codex' },
  startedAt: '2026-04-04T18:00:00.000Z',
  endedAt: '2026-04-04T18:40:00.000Z',
  totals: {
    stepCount: 33,
    modelCallCount: 14,
    toolCallCount: 20,
    inputTokens: 61_000,
    outputTokens: 12_000,
    totalCostUsd: 1.25,
    errorCount: 0,
  },
});

export function testClient(overrides: Partial<MobileApiClient> = {}): MobileApiClient {
  return {
    health: async () => HEALTH,
    stats: async () => STATS,
    listSessions: async () => [ACTIVE_SESSION, COMPLETED_SESSION],
    claimPairing: async () => ({
      device: DEVICE,
      token: MOBILE_SESSION.token,
      baseUrl: MOBILE_SESSION.baseUrl,
    }),
    revokeDevice: async () => ({ ...DEVICE, revokedAt: '2026-04-05T06:30:00.000Z' }),
    ...overrides,
  };
}
