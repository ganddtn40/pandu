import { describe, expect, it } from 'vitest';
import {
  BudgetPolicySchema,
  BudgetStatusSchema,
  CheatAnalysisSchema,
  GuardEventSchema,
  GuardRuleSchema,
} from '@cockpit/core';

import {
  formatBudgetPolicies,
  formatBudgetStatuses,
  formatGuardEvents,
  formatGuardRules,
  formatSecretScan,
  formatTrust,
} from '../src/guards.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const POLICY_ID = '33333333-3333-4333-8333-333333333333';

const RULE = GuardRuleSchema.parse({
  id: 'builtin-secret-api-key',
  name: 'API key in prompt',
  description: 'Warns when a provider token appears.',
  kind: 'secret',
  action: 'warn',
  severity: 'high',
  source: 'builtin',
  enabled: false,
  priority: 10,
  config: { patterns: ['openai-api-key'] },
});

describe('guard CLI formatting', () => {
  it('formats rules with state and action', () => {
    const text = formatGuardRules([RULE]);
    expect(text).toContain('builtin-secret-api-key');
    expect(text).toContain('warn');
    expect(text).toContain('off');
    expect(text).toContain('API key in prompt');
    expect(formatGuardRules([])).toContain('No guard rules');
  });

  it('formats events and resolution notes', () => {
    const event = GuardEventSchema.parse({
      id: EVENT_ID,
      sessionId: SESSION_ID,
      ruleId: 'builtin-secret-private-key',
      kind: 'secret',
      action: 'pause',
      severity: 'critical',
      status: 'approved',
      title: 'Private key in prompt',
      description: 'Held for review.',
      requestedAt: '2026-04-05T06:12:00.000Z',
      resolvedAt: '2026-04-05T06:13:00.000Z',
      resolvedBy: 'cli',
      resolutionNote: 'Reviewed locally.',
    });

    const text = formatGuardEvents([event]);
    expect(text).toContain(EVENT_ID);
    expect(text).toContain('approved');
    expect(text).toContain('note: Reviewed locally.');
    expect(formatGuardEvents([])).toContain('No guard events');
  });
});

describe('budget CLI formatting', () => {
  const policy = BudgetPolicySchema.parse({
    id: POLICY_ID,
    name: 'Monthly lab budget',
    scope: 'global',
    period: 'month',
    limitUsd: 25,
    enforcement: 'warn',
    enabled: true,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  });

  it('formats policies with scope, limit, and enforcement', () => {
    const text = formatBudgetPolicies([policy]);
    expect(text).toContain(POLICY_ID);
    expect(text).toContain('$25.00');
    expect(text).toContain('global');
    expect(formatBudgetPolicies([])).toContain('No budget policies');
  });

  it('formats statuses with warning and exceeded states', () => {
    const status = BudgetStatusSchema.parse({
      policyId: POLICY_ID,
      name: 'Monthly lab budget',
      limitUsd: 25,
      spentUsd: 21,
      remainingUsd: 4,
      usageRatio: 0.84,
      warning: true,
      exceeded: false,
      enforcement: 'warn',
      period: 'month',
      periodStart: '2026-04-01T00:00:00.000Z',
    });

    const text = formatBudgetStatuses([status]);
    expect(text).toContain('warning');
    expect(text).toContain('84%');
    expect(text).toContain('$21.0000');
    expect(formatBudgetStatuses([])).toContain('No budget policies apply');
  });
});

describe('trust and secret CLI formatting', () => {
  it('explains when no trust analysis exists', () => {
    expect(formatTrust(null)).toContain('No trust analysis');
  });

  it('formats findings with evidence and suggestions', () => {
    const analysis = CheatAnalysisSchema.parse({
      sessionId: SESSION_ID,
      trustScore: 64,
      grade: 'D',
      filesExamined: 3,
      generatedAt: '2026-04-05T06:20:00.000Z',
      findings: [
        {
          id: EVENT_ID,
          sessionId: SESSION_ID,
          category: 'deleted_test',
          severity: 'critical',
          title: 'Test file deleted: tests/auth.test.ts',
          detail: 'A test file was removed in this step.',
          detector: 'deleted-test',
          confidence: 1,
          evidence: [
            {
              filePath: 'tests/auth.test.ts',
              startLine: 1,
              excerpt: 'File deleted.',
              explanation: 'The snapshot reports this test file as deleted.',
            },
          ],
          suggestion: 'Restore the test file.',
          createdAt: '2026-04-05T06:20:00.000Z',
        },
      ],
    });

    const text = formatTrust(analysis);
    expect(text).toContain('Trust score: 64/100 (grade D)');
    expect(text).toContain('[CRITICAL] Test file deleted');
    expect(text).toContain('tests/auth.test.ts:1');
    expect(text).toContain('fix: Restore the test file.');
  });

  it('formats clean and populated secret scans', () => {
    const clean = formatSecretScan({
      sessionId: SESSION_ID,
      scannedAt: '2026-04-05T06:20:00.000Z',
      findings: [],
      events: [],
      filesExamined: 2,
    });
    expect(clean).toContain('No secrets found');

    const found = formatSecretScan({
      sessionId: SESSION_ID,
      scannedAt: '2026-04-05T06:20:00.000Z',
      findings: [
        {
          type: 'openai-api-key',
          confidence: 0.95,
          preview: 'sk-a…aaaa',
          location: 'request_body',
          action: 'warn',
        },
      ],
      events: [],
      filesExamined: 2,
    });
    expect(found).toContain('1 finding');
    expect(found).toContain('openai-api-key');
    expect(found).toContain('95%');
  });
});
