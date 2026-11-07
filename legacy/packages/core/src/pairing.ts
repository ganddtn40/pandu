import { z } from 'zod';

import { IsoDateTimeSchema } from './common.js';
import { IdSchema } from './ids.js';

export const DEVICE_PLATFORMS = ['android', 'ios', 'desktop', 'web', 'cli'] as const;
export const DevicePlatformSchema = z.enum(DEVICE_PLATFORMS);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(100),
  platform: DevicePlatformSchema,
  lastSeenAt: IsoDateTimeSchema.optional(),
  revokedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type Device = z.infer<typeof DeviceSchema>;

export const DevicesResponseSchema = z.object({
  devices: z.array(DeviceSchema),
});
export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;

export const DeviceResponseSchema = z.object({
  device: DeviceSchema,
});
export type DeviceResponse = z.infer<typeof DeviceResponseSchema>;

/**
 * Codes omit characters that are easy to confuse when read from a screen or
 * typed on a phone: I, O, 0, and 1.
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
export const PAIRING_CODE_DISPLAY_PATTERN =
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export const MIN_PAIRING_TTL_SECONDS = 60;
export const MAX_PAIRING_TTL_SECONDS = 900;
export const DEFAULT_PAIRING_TTL_SECONDS = 300;

export const DEVICE_TOKEN_PREFIX = 'ckp_';
export const DEVICE_TOKEN_PATTERN = /^ckp_[A-Za-z0-9_-]{43}$/;

/**
 * Normalize user input (lowercase, spaces, or a display hyphen) into the
 * compact eight-character form used for hashing.
 */
export function normalizePairingCode(value: string): string | undefined {
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  return PAIRING_CODE_PATTERN.test(compact) ? compact : undefined;
}

/** Render a compact code as `XXXX-XXXX` for display. */
export function formatPairingCode(value: string): string | undefined {
  const compact = normalizePairingCode(value);
  if (!compact) return undefined;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function isPairingCode(value: string): boolean {
  return normalizePairingCode(value) !== undefined;
}

function parseHttpBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/** Build the `cockpit://pair` link encoded in pairing QR codes. */
export function buildPairingDeepLink(baseUrl: string, code: string): string | undefined {
  const origin = parseHttpBaseUrl(baseUrl);
  const formatted = formatPairingCode(code);
  if (!origin || !formatted) return undefined;
  const params = new URLSearchParams({ url: origin, code: formatted });
  return `cockpit://pair?${params.toString()}`;
}

export interface ParsedPairingDeepLink {
  baseUrl: string;
  code: string;
}

/** Parse a pairing deep link, accepting both `cockpit://pair?...` and `cockpit:pair?...`. */
export function parsePairingDeepLink(value: string): ParsedPairingDeepLink | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'cockpit:') return undefined;
  const host = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
  if (host !== 'pair') return undefined;

  const baseUrl = parseHttpBaseUrl(parsed.searchParams.get('url') ?? '');
  const code = normalizePairingCode(parsed.searchParams.get('code') ?? '');
  if (!baseUrl || !code) return undefined;
  return { baseUrl, code };
}

export const PairingSessionInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  ttlSeconds: z
    .number()
    .int()
    .min(MIN_PAIRING_TTL_SECONDS)
    .max(MAX_PAIRING_TTL_SECONDS)
    .default(DEFAULT_PAIRING_TTL_SECONDS),
});
export type PairingSessionInput = z.infer<typeof PairingSessionInputSchema>;

export const PairingSessionSchema = z.object({
  id: IdSchema,
  code: z.string().regex(PAIRING_CODE_DISPLAY_PATTERN),
  expiresAt: IsoDateTimeSchema,
  ttlSeconds: z.number().int().positive(),
  name: z.string().min(1).max(100).optional(),
  urls: z.array(z.string().url()).min(1),
  deepLink: z.string().min(1),
});
export type PairingSession = z.infer<typeof PairingSessionSchema>;

export const PairingSessionResponseSchema = z.object({
  pairing: PairingSessionSchema,
});
export type PairingSessionResponse = z.infer<typeof PairingSessionResponseSchema>;

export const PairingSessionStatusSchema = z.object({
  id: IdSchema,
  expiresAt: IsoDateTimeSchema,
  usedAt: IsoDateTimeSchema.optional(),
  expired: z.boolean(),
  claimed: z.boolean(),
});
export type PairingSessionStatus = z.infer<typeof PairingSessionStatusSchema>;

export const PairingSessionStatusResponseSchema = z.object({
  pairing: PairingSessionStatusSchema,
});
export type PairingSessionStatusResponse = z.infer<typeof PairingSessionStatusResponseSchema>;

export const PairingClaimInputSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100).optional(),
  platform: DevicePlatformSchema.default('android'),
});
export type PairingClaimInput = z.infer<typeof PairingClaimInputSchema>;

export const PairingClaimResponseSchema = z.object({
  device: DeviceSchema,
  token: z.string().regex(DEVICE_TOKEN_PATTERN),
  baseUrl: z.string().url(),
});
export type PairingClaimResponse = z.infer<typeof PairingClaimResponseSchema>;
