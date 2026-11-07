import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BudgetPoliciesResponseSchema,
  BudgetPolicyResponseSchema,
  BudgetStatusResponseSchema,
  GuardEventResponseSchema,
  GuardEventsResponseSchema,
  GuardRuleResponseSchema,
  GuardRulesResponseSchema,
  RemoveBudgetPolicyResponseSchema,
  RemoveGuardRuleResponseSchema,
  SecretScanResponseSchema,
  SessionResponseSchema,
  TrustResponseSchema,
  type Session,
} from '@cockpit/core';

import type { StartedDaemon } from '../src/index.js';
import { collectNonStreamResponse } from '../src/sse/collector.js';

import { startTestDaemon, startUpstream, type FakeUpstream } from './helpers.js';

const CONTEXT: Array<{
  directory: string;
  upstream: FakeUpstream;
  daemon: StartedDaemon;
}> = [];

async function boot(): Promise<StartedDaemon> {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-guards',
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    );
  });

  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-guards-api-'));
  const daemon = await startTestDaemon({
    home: path.join(directory, 'home'),
    openAiUpstream: upstream.url,
  });
  CONTEXT.push({ directory, upstream, daemon });
  return daemon;
}

async function createSession(daemon: StartedDaemon, title = 'Guards API'): Promise<Session> {
  const response = await fetch(`${daemon.url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'manual', title }),
  });
  return SessionResponseSchema.parse(await response.json()).session;
}

afterEach(async () => {
  while (CONTEXT.length > 0) {
    const context = CONTEXT.pop();
    if (!context) continue;
    await context.daemon.close().catch(() => undefined);
    await context.upstream.close().catch(() => undefined);
    rmSync(context.directory, { recursive: true, force: true });
  }
});

describe('guard REST API', () => {
  it('lists, creates, updates, and deletes guard rules', async () => {
    const daemon = await boot();

    const listResponse = await fetch(`${daemon.url}/api/guards/rules`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get('cache-control')).toBe('no-store');
    const listed = GuardRulesResponseSchema.parse(await listResponse.json());
    expect(listed.rules.map((rule) => rule.id)).toContain('builtin-secret-private-key');

    const createResponse = await fetch(`${daemon.url}/api/guards/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'No production deploys',
        description: 'Blocks production deploys.',
        kind: 'custom',
        action: 'block',
        severity: 'high',
        config: { patterns: ['deploy production'] },
      }),
    });
    expect(createResponse.status).toBe(201);
    expect(createResponse.headers.get('location')).toMatch(/^\/api\/guards\/rules\//);
    const created = GuardRuleResponseSchema.parse(await createResponse.json()).rule;
    expect(created.source).toBe('user');
    expect(created.enabled).toBe(true);

    const patchResponse = await fetch(
      `${daemon.url}/api/guards/rules/${encodeURIComponent(created.id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, priority: 3 }),
      },
    );
    expect(patchResponse.status).toBe(200);
    const patched = GuardRuleResponseSchema.parse(await patchResponse.json()).rule;
    expect(patched.enabled).toBe(false);
    expect(patched.priority).toBe(3);

    const deleteResponse = await fetch(
      `${daemon.url}/api/guards/rules/${encodeURIComponent(created.id)}`,
      { method: 'DELETE' },
    );
    expect(deleteResponse.status).toBe(200);
    expect(RemoveGuardRuleResponseSchema.parse(await deleteResponse.json()).removed).toBe(true);

    const builtinDelete = await fetch(`${daemon.url}/api/guards/rules/builtin-secret-api-key`, {
      method: 'DELETE',
    });
    expect(builtinDelete.status).toBe(409);
    expect(await builtinDelete.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('rejects an invalid rule payload', async () => {
    const daemon = await boot();
    const response = await fetch(`${daemon.url}/api/guards/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', kind: 'custom' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('lists and resolves pending guard events exactly once', async () => {
    const daemon = await boot();
    const session = await createSession(daemon);

    const event = daemon.store.insertGuardEvent({
      sessionId: session.id,
      ruleId: 'builtin-secret-private-key',
      kind: 'secret',
      action: 'pause',
      severity: 'critical',
      status: 'pending',
      title: 'Private key in prompt',
      description: 'A private key is about to leave the machine.',
    });

    const listResponse = await fetch(
      `${daemon.url}/api/guards/events?sessionId=${session.id}&status=pending`,
    );
    expect(listResponse.status).toBe(200);
    const listed = GuardEventsResponseSchema.parse(await listResponse.json());
    expect(listed.events).toHaveLength(1);
    expect(listed.events[0]?.id).toBe(event.id);

    const decisionResponse = await fetch(`${daemon.url}/api/guards/events/${event.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', channel: 'cli', note: 'Reviewed locally.' }),
    });
    expect(decisionResponse.status).toBe(200);
    const decided = GuardEventResponseSchema.parse(await decisionResponse.json()).event;
    expect(decided.status).toBe('approved');
    expect(decided.resolvedBy).toBe('cli');
    expect(decided.resolutionNote).toBe('Reviewed locally.');

    const repeat = await fetch(`${daemon.url}/api/guards/events/${event.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(repeat.status).toBe(409);
  });
});

describe('budget REST API', () => {
  it('creates, patches, lists, and removes budget policies', async () => {
    const daemon = await boot();

    const createResponse = await fetch(`${daemon.url}/api/budgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Monthly lab budget',
        scope: 'global',
        period: 'month',
        limitUsd: 25,
        enforcement: 'warn',
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = BudgetPolicyResponseSchema.parse(await createResponse.json()).policy;

    const listResponse = await fetch(`${daemon.url}/api/budgets`);
    const listed = BudgetPoliciesResponseSchema.parse(await listResponse.json());
    expect(listed.policies.map((policy) => policy.id)).toContain(created.id);

    const patchResponse = await fetch(
      `${daemon.url}/api/budgets/${encodeURIComponent(created.id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limitUsd: 10, enforcement: 'block' }),
      },
    );
    expect(patchResponse.status).toBe(200);
    const patched = BudgetPolicyResponseSchema.parse(await patchResponse.json()).policy;
    expect(patched.limitUsd).toBe(10);
    expect(patched.enforcement).toBe('block');

    const invalidPatch = await fetch(
      `${daemon.url}/api/budgets/${encodeURIComponent(created.id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'session' }),
      },
    );
    expect(invalidPatch.status).toBe(400);

    const removeResponse = await fetch(
      `${daemon.url}/api/budgets/${encodeURIComponent(created.id)}`,
      { method: 'DELETE' },
    );
    expect(removeResponse.status).toBe(200);
    expect(RemoveBudgetPolicyResponseSchema.parse(await removeResponse.json()).removed).toBe(true);

    const missing = await fetch(`${daemon.url}/api/budgets/${encodeURIComponent(created.id)}`, {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
  });

  it('reports the budget status for a session', async () => {
    const daemon = await boot();
    const session = await createSession(daemon);

    daemon.store.createBudgetPolicy({
      name: 'Session cap',
      scope: 'session',
      sessionId: session.id,
      period: 'session',
      limitUsd: 1,
      enforcement: 'warn',
      enabled: true,
    });

    const response = await fetch(`${daemon.url}/api/sessions/${session.id}/budgets`);
    expect(response.status).toBe(200);
    const statuses = BudgetStatusResponseSchema.parse(await response.json()).statuses;
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      name: 'Session cap',
      limitUsd: 1,
      spentUsd: 0,
      warning: false,
      exceeded: false,
      period: 'session',
    });
  });
});

describe('scan and trust REST API', () => {
  it('scans stored session data and returns the latest trust analysis', async () => {
    const daemon = await boot();
    const session = await createSession(daemon, 'Scan and trust');

    const handle = daemon.recorder.begin({
      sessionId: session.id,
      protocol: 'openai',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: `Use ${'sk-'}${'a'.repeat(32)}` }],
      }),
    });
    daemon.recorder.finish(handle, {
      status: 'completed',
      responseStatus: 200,
      responseHeaders: {},
      collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }),
    });

    const scanResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/scan`, {
      method: 'POST',
    });
    expect(scanResponse.status).toBe(200);
    const scan = SecretScanResponseSchema.parse(await scanResponse.json());
    expect(scan.filesExamined).toBe(1);
    expect(scan.findings.some((finding) => finding.type === 'openai-api-key')).toBe(true);
    expect(scan.events.every((event) => event.status !== 'pending')).toBe(true);

    const emptyTrust = await fetch(`${daemon.url}/api/sessions/${session.id}/trust`);
    expect(TrustResponseSchema.parse(await emptyTrust.json()).analysis).toBeNull();

    daemon.store.insertSnapshot({
      sessionId: session.id,
      kind: 'after',
      filesChanged: 1,
      insertions: 0,
      deletions: 4,
      fileChanges: [
        { path: 'tests/auth.test.ts', changeType: 'deleted', additions: 0, deletions: 4 },
      ],
    });

    const analyzeResponse = await fetch(`${daemon.url}/api/sessions/${session.id}/trust`, {
      method: 'POST',
    });
    expect(analyzeResponse.status).toBe(200);
    const analysis = TrustResponseSchema.parse(await analyzeResponse.json()).analysis;
    expect(analysis?.findings[0]?.category).toBe('deleted_test');
    expect(analysis?.trustScore).toBeLessThan(100);

    const latest = await fetch(`${daemon.url}/api/sessions/${session.id}/trust`);
    expect(TrustResponseSchema.parse(await latest.json()).analysis?.trustScore).toBe(
      analysis?.trustScore,
    );
  });

  it('returns not found for unknown sessions', async () => {
    const daemon = await boot();
    const missingId = '11111111-1111-4111-8111-111111111111';

    const trust = await fetch(`${daemon.url}/api/sessions/${missingId}/trust`);
    expect(trust.status).toBe(404);

    const scan = await fetch(`${daemon.url}/api/sessions/${missingId}/scan`, { method: 'POST' });
    expect(scan.status).toBe(404);

    const budgets = await fetch(`${daemon.url}/api/sessions/${missingId}/budgets`);
    expect(budgets.status).toBe(404);
  });
});
