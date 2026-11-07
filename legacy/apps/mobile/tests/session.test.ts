import { describe, expect, it } from 'vitest';

import {
  MOBILE_SESSION_STORAGE_KEY,
  clearSession,
  loadSession,
  normalizeBaseUrl,
  saveSession,
  type StorageLike,
} from '../src/lib/session';
import { MOBILE_SESSION } from './fixtures';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe('normalizeBaseUrl', () => {
  it('adds http and reduces to an origin', () => {
    expect(normalizeBaseUrl('192.168.1.20:4319/path')).toBe('http://192.168.1.20:4319');
    expect(normalizeBaseUrl('https://cockpit.example.com/')).toBe('https://cockpit.example.com');
  });

  it('rejects empty, malformed, and credentialed URLs', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('ftp://host')).toBeNull();
    expect(normalizeBaseUrl('http://user:pass@host:4319')).toBeNull();
  });
});

describe('session storage', () => {
  it('round-trips a paired session', () => {
    const storage = memoryStorage();
    saveSession(MOBILE_SESSION, storage);

    expect(storage.values.has(MOBILE_SESSION_STORAGE_KEY)).toBe(true);
    expect(loadSession(storage)).toEqual(MOBILE_SESSION);
  });

  it('clears an invalid stored payload instead of crashing', () => {
    const storage = memoryStorage({ [MOBILE_SESSION_STORAGE_KEY]: '{"token":"nope"}' });

    expect(loadSession(storage)).toBeNull();
    expect(storage.values.has(MOBILE_SESSION_STORAGE_KEY)).toBe(false);
  });

  it('returns null for malformed JSON and missing storage', () => {
    expect(loadSession(memoryStorage({ [MOBILE_SESSION_STORAGE_KEY]: '{' }))).toBeNull();
    expect(loadSession(null)).toBeNull();
  });

  it('removes the session on clear', () => {
    const storage = memoryStorage();
    saveSession(MOBILE_SESSION, storage);
    clearSession(storage);

    expect(storage.values.has(MOBILE_SESSION_STORAGE_KEY)).toBe(false);
  });
});
