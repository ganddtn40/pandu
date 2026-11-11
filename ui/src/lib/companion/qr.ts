/**
 * Parsing for the pairing QR the host shows in Settings → Remote access.
 *
 * The payload is produced by the daemon as
 * `{"v":1,"url":"https://…","code":"…","fingerprint":"…"}`. Nothing here
 * trusts the code: the host still confirms the device and the four-digit
 * verification code.
 */

export interface PairingPayload {
  v: 1;
  url: string;
  code: string;
  fingerprint?: string;
}

/** A pairing payload is a few hundred bytes, never a document. */
const MAX_PAYLOAD = 2_048;
const MAX_HOST = 512;
const MAX_FINGERPRINT = 200;
/** The daemon issues 128 bits of hex: 32 characters. */
const PAIR_CODE_LENGTH = 32;

/**
 * Normalize a host origin. HTTPS is required except for a loopback address,
 * which is the emulator/debug case. Credentials, paths, queries, and fragments
 * are rejected so `origin + /api` can never point somewhere unexpected.
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > MAX_HOST) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search || url.hash) return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.host}`;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    // The Android emulator reaches the development machine here.
    hostname === '10.0.2.2'
  );
}

function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase().replace(/[\s-]+/g, '');
  if (text.length !== PAIR_CODE_LENGTH) return null;
  if (!/^[a-f0-9]+$/.test(text)) return null;
  return text;
}

/** Parse a scanned QR string. Returns `null` for anything unexpected. */
export function parsePairingPayload(raw: string): PairingPayload | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > MAX_PAYLOAD) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  const url = normalizeHost(record.url);
  if (!url) return null;
  const code = normalizeCode(record.code);
  if (!code) return null;
  const fingerprint =
    typeof record.fingerprint === 'string' && record.fingerprint.trim()
      ? record.fingerprint.trim().slice(0, MAX_FINGERPRINT)
      : undefined;
  return { v: 1, url, code, ...(fingerprint ? { fingerprint } : {}) };
}
