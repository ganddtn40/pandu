import { describe, expect, it } from 'vitest';
import { normalizeHost, parsePairingPayload } from '../../src/lib/companion/qr';

const CODE = '0123456789abcdef0123456789abcdef';

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    url: 'https://host.tailnet.ts.net',
    code: CODE,
    fingerprint: 'AB:CD:EF',
    ...overrides,
  });
}

describe('normalizeHost', () => {
  it('keeps an HTTPS origin and drops the trailing slash', () => {
    expect(normalizeHost('https://host.tailnet.ts.net/')).toBe('https://host.tailnet.ts.net');
    expect(normalizeHost(' https://host.tailnet.ts.net:8443 ')).toBe(
      'https://host.tailnet.ts.net:8443',
    );
  });

  it('accepts loopback HTTP for the emulator', () => {
    expect(normalizeHost('http://10.0.2.2:4319')).toBe('http://10.0.2.2:4319');
    expect(normalizeHost('http://127.0.0.1:4319')).toBe('http://127.0.0.1:4319');
    expect(normalizeHost('http://localhost:4319')).toBe('http://localhost:4319');
  });

  it('refuses plain HTTP outside loopback', () => {
    expect(normalizeHost('http://host.tailnet.ts.net')).toBeNull();
    expect(normalizeHost('http://10.0.2.2.example.com')).toBeNull();
  });

  it('refuses paths, queries, fragments, and credentials', () => {
    expect(normalizeHost('https://host/path')).toBeNull();
    expect(normalizeHost('https://host/?x=1')).toBeNull();
    expect(normalizeHost('https://host/#fragment')).toBeNull();
    expect(normalizeHost('https://user:pass@host')).toBeNull();
    expect(normalizeHost('file:///etc/passwd')).toBeNull();
    expect(normalizeHost('not a url')).toBeNull();
    expect(normalizeHost('')).toBeNull();
  });
});

describe('parsePairingPayload', () => {
  it('parses the host payload', () => {
    expect(parsePairingPayload(payload())).toEqual({
      v: 1,
      url: 'https://host.tailnet.ts.net',
      code: CODE,
      fingerprint: 'AB:CD:EF',
    });
  });

  it('normalizes an uppercase or spaced code', () => {
    const raw = payload({ code: `${CODE.toUpperCase().slice(0, 16)} ${CODE.slice(16)}` });
    expect(parsePairingPayload(raw)?.code).toBe(CODE);
  });

  it('rejects a wrong version or shape', () => {
    expect(parsePairingPayload(payload({ v: 2 }))).toBeNull();
    expect(parsePairingPayload('[]')).toBeNull();
    expect(parsePairingPayload('null')).toBeNull();
    expect(parsePairingPayload('not json')).toBeNull();
    expect(parsePairingPayload('')).toBeNull();
    expect(parsePairingPayload('x'.repeat(4096))).toBeNull();
  });

  it('rejects an invalid code or host', () => {
    expect(parsePairingPayload(payload({ code: 'abc' }))).toBeNull();
    expect(parsePairingPayload(payload({ code: 'z'.repeat(32) }))).toBeNull();
    expect(parsePairingPayload(payload({ url: 'http://public.example' }))).toBeNull();
    expect(parsePairingPayload(payload({ url: 'https://host/path' }))).toBeNull();
  });

  it('drops an empty fingerprint', () => {
    const parsed = parsePairingPayload(payload({ fingerprint: '   ' }));
    expect(parsed?.fingerprint).toBeUndefined();
  });
});
