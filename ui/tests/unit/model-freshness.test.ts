import { describe, expect, it } from 'vitest';
import { PRICE_FRESHNESS_DAYS, priceIsStale } from '../../src/lib/model-freshness';

const DAY_MS = 24 * 60 * 60 * 1_000;
const VERIFIED = '2026-11-10';
const VERIFIED_AT = Date.parse(VERIFIED);

describe('priceIsStale', () => {
  it('keeps a row inside the freshness window fresh', () => {
    expect(priceIsStale(VERIFIED, VERIFIED_AT)).toBe(false);
    expect(priceIsStale(VERIFIED, VERIFIED_AT + 59 * DAY_MS)).toBe(false);
    expect(priceIsStale(VERIFIED, VERIFIED_AT + PRICE_FRESHNESS_DAYS * DAY_MS)).toBe(false);
  });

  it('marks a row older than the window as stale', () => {
    expect(priceIsStale(VERIFIED, VERIFIED_AT + (PRICE_FRESHNESS_DAYS + 1) * DAY_MS)).toBe(true);
    expect(priceIsStale(VERIFIED, VERIFIED_AT + 365 * DAY_MS)).toBe(true);
  });

  it('does not call a missing or malformed date stale', () => {
    expect(priceIsStale(undefined)).toBe(false);
    expect(priceIsStale('')).toBe(false);
    expect(priceIsStale('not-a-date')).toBe(false);
  });
});
