import { DEVICE_TOKEN_PATTERN, DeviceSchema } from '@cockpit/core';
import { z } from 'zod';

export const MOBILE_SESSION_STORAGE_KEY = 'cockpit.mobile.session.v1';

export const MobileSessionSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'Expected an http(s) URL.'),
  token: z.string().regex(DEVICE_TOKEN_PATTERN),
  device: DeviceSchema,
  pairedAt: z.string().datetime({ offset: true }),
});
export type MobileSession = z.infer<typeof MobileSessionSchema>;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function loadSession(storage: StorageLike | null = defaultStorage()): MobileSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(MOBILE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const result = MobileSessionSchema.safeParse(parsed);
    if (!result.success) {
      storage.removeItem(MOBILE_SESSION_STORAGE_KEY);
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

export function saveSession(
  session: MobileSession,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  storage.setItem(MOBILE_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  storage.removeItem(MOBILE_SESSION_STORAGE_KEY);
}
