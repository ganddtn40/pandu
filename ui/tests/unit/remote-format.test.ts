import { describe, expect, it } from 'vitest';
import { isAuthPrompt, isHighRisk } from '../../src/lib/remote-format';
import type { GuardEvent } from '../../src/lib/api/types';

function event(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    ruleId: 'test.rule',
    kind: 'dangerous_command',
    action: 'pause',
    severity: 'critical',
    status: 'pending',
    title: 'Approval requested',
    description: '',
    requestedAt: '2026-01-01T00:00:00Z',
    evidence: [],
    ...overrides,
  };
}

describe('remote guard formatting', () => {
  it('treats a status-only guard event without evidence as safe to render', () => {
    // Status-only devices receive the redacted shape: no evidence array.
    const redacted = event({ evidence: undefined });
    expect(() => isAuthPrompt(redacted)).not.toThrow();
    expect(isAuthPrompt(redacted)).toBe(false);
  });

  it('still detects auth prompts from the title or command', () => {
    expect(isAuthPrompt(event({ title: 'Sign in to continue' }))).toBe(true);
    expect(isAuthPrompt(event({ command: 'gh auth login' }))).toBe(true);
    expect(isAuthPrompt(event({ evidence: [{ excerpt: 'Enter your password' }] }))).toBe(true);
  });

  it('keeps high-risk detection based on severity and rule kind', () => {
    expect(isHighRisk(event())).toBe(true);
    expect(isHighRisk(event({ kind: 'loop', severity: 'medium' }))).toBe(false);
    expect(isHighRisk(event({ kind: 'loop', severity: 'high' }))).toBe(true);
  });
});
