import { describe, expect, it } from 'vitest';

import {
  formatCompactNumber,
  formatCurrency,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelativeTime,
  pluralize,
  statusLabel,
  statusTone,
} from '../src/lib/format';

describe('formatNumber', () => {
  it('groups large numbers and clamps negatives', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(-5)).toBe('0');
  });

  it('compacts thousands and millions', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(1500)).toBe('1.5K');
    expect(formatCompactNumber(1_200_000)).toBe('1.2M');
  });
});

describe('formatCurrency', () => {
  it('scales precision with the size of the amount', () => {
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(0.0042)).toBe('$0.0042');
    expect(formatCurrency(0.0184)).toBe('$0.018');
    expect(formatCurrency(12.3456)).toBe('$12.35');
  });

  it('handles invalid input as zero', () => {
    expect(formatCurrency(Number.NaN)).toBe('$0.00');
  });
});

describe('formatDuration', () => {
  it('uses the most useful unit', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(63_000)).toBe('1m 3s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_660_000)).toBe('1h 1m');
  });

  it('returns a dash when duration is unknown', () => {
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-04-05T12:00:00.000Z');

  it('describes recent timestamps', () => {
    expect(formatRelativeTime('2026-04-05T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-04-05T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatRelativeTime('2026-04-05T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-04-03T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('falls back to a date for older timestamps', () => {
    expect(formatRelativeTime('2026-03-01T12:00:00.000Z', now)).toBe('Mar 1, 2026');
  });

  it('treats small clock skew as just now', () => {
    expect(formatRelativeTime('2026-04-05T12:00:20.000Z', now)).toBe('just now');
  });
});

describe('formatDateTime', () => {
  it('returns a readable local timestamp', () => {
    expect(formatDateTime('2026-04-05T06:07:08.000Z')).toContain('2026');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('status helpers', () => {
  it('maps session and step statuses onto tones', () => {
    expect(statusTone('active')).toBe('live');
    expect(statusTone('running')).toBe('live');
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('denied')).toBe('warn');
    expect(statusTone('killed')).toBe('muted');
  });

  it('capitalizes labels', () => {
    expect(statusLabel('completed')).toBe('Completed');
    expect(statusLabel('')).toBe('Unknown');
  });

  it('pluralizes counts', () => {
    expect(pluralize(1, 'flight')).toBe('flight');
    expect(pluralize(2, 'flight')).toBe('flights');
    expect(pluralize(2, 'match', 'matches')).toBe('matches');
  });
});
