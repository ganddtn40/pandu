import { describe, expect, it } from 'vitest';

import {
  ApprovalDecisionSchema,
  BudgetPolicyInputSchema,
  GuardEventSchema,
  GuardRuleSchema,
  budgetPeriodStart,
} from '../src/index.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';

describe('guard schemas', () => {
  it('applies safe defaults to guard rules', () => {
    const rule = GuardRuleSchema.parse({
      id: 'project-rule',
      name: 'No production deploys',
      kind: 'custom',
      action: 'block',
      severity: 'high',
      source: 'project',
    });

    expect(rule.description).toBe('');
    expect(rule.enabled).toBe(true);
    expect(rule.priority).toBe(100);
    expect(rule.config).toEqual({});
  });

  it('defaults approval decisions to the dashboard channel', () => {
    const decision = ApprovalDecisionSchema.parse({ decision: 'approve' });
    expect(decision.channel).toBe('dashboard');
  });

  it('parses a pending guard event with evidence', () => {
    const event = GuardEventSchema.parse({
      id: EVENT_ID,
      sessionId: SESSION_ID,
      ruleId: 'builtin-dangerous-command',
      kind: 'dangerous_command',
      action: 'pause',
      severity: 'high',
      status: 'pending',
      title: 'Dangerous command requested',
      requestedAt: '2026-04-05T06:12:00.000Z',
      evidence: [{ field: 'prompt', excerpt: 'rm -rf build' }],
    });

    expect(event.status).toBe('pending');
    expect(event.description).toBe('');
    expect(event.evidence[0]?.field).toBe('prompt');
  });
});

describe('budget policy validation', () => {
  it('requires a session id for session scope', () => {
    const result = BudgetPolicyInputSchema.safeParse({
      name: 'Session cap',
      scope: 'session',
      period: 'session',
      limitUsd: 1,
      enforcement: 'warn',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['sessionId']);
    }
  });

  it('requires a project id for project scope', () => {
    const result = BudgetPolicyInputSchema.safeParse({
      name: 'Project cap',
      scope: 'project',
      period: 'month',
      limitUsd: 10,
      enforcement: 'block',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['projectId']);
    }
  });

  it('accepts a global policy without extra identifiers', () => {
    const policy = BudgetPolicyInputSchema.parse({
      name: 'Global cap',
      scope: 'global',
      period: 'day',
      limitUsd: 5,
      enforcement: 'pause',
    });

    expect(policy.enabled).toBe(true);
    expect(policy.projectId).toBeUndefined();
    expect(policy.sessionId).toBeUndefined();
  });
});

describe('budgetPeriodStart', () => {
  const now = new Date('2026-04-08T15:42:11.000Z');

  it('starts session periods at the session start', () => {
    const startedAt = new Date('2026-04-05T06:07:00.000Z');
    expect(budgetPeriodStart('session', now, startedAt).toISOString()).toBe(
      '2026-04-05T06:07:00.000Z',
    );
  });

  it('starts day periods at UTC midnight', () => {
    expect(budgetPeriodStart('day', now).toISOString()).toBe('2026-04-08T00:00:00.000Z');
  });

  it('starts week periods on Monday UTC midnight', () => {
    expect(budgetPeriodStart('week', now).toISOString()).toBe('2026-04-06T00:00:00.000Z');
  });

  it('starts month periods on the first UTC day', () => {
    expect(budgetPeriodStart('month', now).toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
});
