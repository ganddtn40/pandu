import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAIRING_TTL_SECONDS,
  DEVICE_TOKEN_PATTERN,
  DeviceSchema,
  LiveEventTypeSchema,
  PairingClaimInputSchema,
  PairingSessionInputSchema,
  buildPairingDeepLink,
  formatPairingCode,
  isPairingCode,
  normalizePairingCode,
  parsePairingDeepLink,
} from '../src/index.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-04-05T06:00:00.000Z';

describe('pairing codes', () => {
  it('normalizes lowercase, spaces, and the display hyphen', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode('abcd efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode('ABCD-EFGH')).toBe('ABCDEFGH');
  });

  it('rejects ambiguous or malformed codes', () => {
    expect(normalizePairingCode('ABCD-EFGI')).toBeUndefined();
    expect(normalizePairingCode('ABCD-EFG0')).toBeUndefined();
    expect(normalizePairingCode('ABCD-EFG')).toBeUndefined();
    expect(isPairingCode('ABCD-EFGH')).toBe(true);
    expect(isPairingCode('not-a-code')).toBe(false);
  });

  it('formats compact codes for humans', () => {
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(formatPairingCode('abcd-efgh')).toBe('ABCD-EFGH');
    expect(formatPairingCode('bad')).toBeUndefined();
  });
});

describe('pairing deep links', () => {
  it('round-trips a URL and code through the cockpit scheme', () => {
    const link = buildPairingDeepLink('http://192.168.1.20:4319/', 'ABCD-EFGH');
    expect(link).toBeDefined();
    expect(link).toContain('cockpit://pair?');
    expect(parsePairingDeepLink(link ?? '')).toEqual({
      baseUrl: 'http://192.168.1.20:4319',
      code: 'ABCDEFGH',
    });
  });

  it('refuses non-http URLs and credentials', () => {
    expect(buildPairingDeepLink('file:///tmp/cockpit', 'ABCDEFGH')).toBeUndefined();
    expect(buildPairingDeepLink('http://user:secret@localhost:4319', 'ABCDEFGH')).toBeUndefined();
  });

  it('ignores links with another scheme, host, or missing parameters', () => {
    expect(
      parsePairingDeepLink('https://example.com/pair?url=http%3A%2F%2Fx&code=ABCDEFGH'),
    ).toBeUndefined();
    expect(
      parsePairingDeepLink('cockpit://other?url=http%3A%2F%2Fx&code=ABCDEFGH'),
    ).toBeUndefined();
    expect(parsePairingDeepLink('cockpit://pair?code=ABCDEFGH')).toBeUndefined();
    expect(parsePairingDeepLink('cockpit://pair?url=http%3A%2F%2Fx&code=BAD')).toBeUndefined();
  });
});

describe('pairing schemas', () => {
  it('defaults the pairing TTL to five minutes and validates its range', () => {
    expect(PairingSessionInputSchema.parse({})).toEqual({
      ttlSeconds: DEFAULT_PAIRING_TTL_SECONDS,
    });
    expect(PairingSessionInputSchema.safeParse({ ttlSeconds: 59 }).success).toBe(false);
    expect(PairingSessionInputSchema.safeParse({ ttlSeconds: 901 }).success).toBe(false);
    expect(PairingSessionInputSchema.parse({ ttlSeconds: 60 }).ttlSeconds).toBe(60);
    expect(PairingSessionInputSchema.parse({ ttlSeconds: 900 }).ttlSeconds).toBe(900);
  });

  it('defaults claims to Android and requires a code', () => {
    expect(PairingClaimInputSchema.parse({ code: 'ABCD-EFGH' })).toEqual({
      code: 'ABCD-EFGH',
      platform: 'android',
    });
    expect(PairingClaimInputSchema.safeParse({ code: '' }).success).toBe(false);
  });

  it('accepts paired device tokens with the ckp prefix', () => {
    const token = `ckp_${'a'.repeat(43)}`;
    expect(DEVICE_TOKEN_PATTERN.test(token)).toBe(true);
    expect(DEVICE_TOKEN_PATTERN.test('ckp_short')).toBe(false);
    expect(DEVICE_TOKEN_PATTERN.test(`bearer_${'a'.repeat(43)}`)).toBe(false);
  });

  it('keeps device timestamps optional and validated', () => {
    const device = DeviceSchema.parse({
      id: DEVICE_ID,
      name: 'Pixel 9',
      platform: 'android',
      createdAt: CREATED_AT,
    });
    expect(device.lastSeenAt).toBeUndefined();
    expect(device.revokedAt).toBeUndefined();
    expect(DeviceSchema.safeParse({ ...device, createdAt: 'yesterday' }).success).toBe(false);
    expect(DeviceSchema.safeParse({ ...device, platform: 'toaster' }).success).toBe(false);
  });
});

describe('live events', () => {
  it('includes pairing completion and device revocation', () => {
    expect(LiveEventTypeSchema.options).toContain('pairing.requested');
    expect(LiveEventTypeSchema.options).toContain('pairing.completed');
    expect(LiveEventTypeSchema.options).toContain('device.revoked');
  });
});
