import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@cockpit/core';

import { openDatabase, type CockpitDatabaseConnection } from '../src/db/client.js';
import { ApprovalBroker } from '../src/guards/approval.js';
import { GuardService, GuardServiceError } from '../src/guards/service.js';
import { LiveEventBus } from '../src/live/bus.js';
import { createLogger } from '../src/logger.js';
import { Recorder } from '../src/recording/recorder.js';
import { collectNonStreamResponse } from '../src/sse/collector.js';
import { Store } from '../src/store/store.js';

import { waitFor } from './helpers.js';

const PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
const OPENAI_KEY = `sk-${'a'.repeat(32)}`;

function requestBody(content: string): string {
  return JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content }],
  });
}

describe('GuardService', () => {
  let connection: CockpitDatabaseConnection;
  let store: Store;
  let bus: LiveEventBus;
  let broker: ApprovalBroker;
  let guards: GuardService;
  let recorder: Recorder;
  let session: Session;

  beforeEach(() => {
    connection = openDatabase({ databasePath: ':memory:' });
    store = new Store(connection);
    const logger = createLogger('silent');
    bus = new LiveEventBus({
      initialSequence: 0,
      persist: (event) => store.insertLiveEvent(event),
      logger,
    });
    broker = new ApprovalBroker();
    guards = new GuardService({
      store,
      bus,
      logger,
      approvalTimeoutMs: 2_000,
      broker,
    });
    recorder = new Recorder({ store, bus, logger, guards });
    session = store.createSession({ title: 'Guard test', source: 'manual', tags: [] });
  });

  afterEach(() => {
    guards.close();
    store.close();
  });

  it('seeds the built-in rules and protects them from deletion', () => {
    const rules = guards.listRules();
    expect(rules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([
        'builtin-secret-private-key',
        'builtin-secret-api-key',
        'builtin-dangerous-command',
        'builtin-egress',
        'builtin-git-rewrite',
        'builtin-release-command',
        'builtin-loop',
      ]),
    );
    expect(rules.every((rule) => rule.source === 'builtin')).toBe(true);

    expect(() => guards.deleteRule('builtin-secret-api-key')).toThrow(GuardServiceError);
    try {
      guards.deleteRule('builtin-secret-api-key');
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: 'conflict' });
    }
  });

  it('creates, updates, and deletes a custom rule', () => {
    const rule = guards.createRule({
      name: 'No production deploys',
      description: 'Blocks requests that mention the production deploy command.',
      kind: 'custom',
      action: 'block',
      severity: 'high',
      enabled: true,
      priority: 10,
      config: { patterns: ['deploy production'] },
    });

    expect(rule.source).toBe('user');
    expect(guards.listRules().some((candidate) => candidate.id === rule.id)).toBe(true);

    const updated = guards.updateRule(rule.id, { enabled: false });
    expect(updated.enabled).toBe(false);

    guards.deleteRule(rule.id);
    expect(guards.listRules().some((candidate) => candidate.id === rule.id)).toBe(false);
  });

  it('warns once when the same API key appears in consecutive requests', async () => {
    const first = await guards.evaluateRequest({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody(`Use this key: ${OPENAI_KEY}`),
    });

    expect(first.allowed).toBe(true);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      kind: 'secret',
      action: 'warn',
      status: 'warned',
      ruleId: 'secret-scan:openai-api-key',
    });
    expect(first.events[0]?.metadata).toMatchObject({
      secretType: 'openai-api-key',
      location: 'request_body',
    });

    const second = await guards.evaluateRequest({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody(`Use this key: ${OPENAI_KEY}`),
    });

    expect(second.allowed).toBe(true);
    expect(second.events).toHaveLength(0);
  });

  it('holds a private key request until it is approved', async () => {
    const pendingResult = guards.evaluateRequest({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody(PRIVATE_KEY),
    });

    const event = await waitFor(() => guards.pending(session.id)[0], {
      description: 'a pending private-key approval',
    });
    expect(event.action).toBe('pause');
    expect(event.status).toBe('pending');

    guards.resolveEvent(event.id, { decision: 'approve', channel: 'cli' });

    const result = await pendingResult;
    expect(result.allowed).toBe(true);
    expect(result.events[0]?.status).toBe('approved');
    expect(store.getGuardEvent(event.id)?.resolvedBy).toBe('cli');
  });

  it('blocks a private key request when the approval is denied', async () => {
    const pendingResult = guards.evaluateRequest({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody(PRIVATE_KEY),
    });

    const event = await waitFor(() => guards.pending(session.id)[0], {
      description: 'a pending private-key approval',
    });
    guards.resolveEvent(event.id, { decision: 'deny', channel: 'dashboard' });

    const result = await pendingResult;
    expect(result).toMatchObject({
      allowed: false,
      status: 403,
      code: 'guard_blocked',
    });
    expect(store.getGuardEvent(event.id)?.status).toBe('denied');
  });

  it('blocks a request when a custom block rule matches', async () => {
    guards.createRule({
      name: 'No production deploys',
      description: 'Blocks requests that mention the production deploy command.',
      kind: 'custom',
      action: 'block',
      severity: 'high',
      enabled: true,
      priority: 10,
      config: { patterns: ['deploy production'] },
    });

    const result = await guards.evaluateRequest({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody('Please deploy production tonight.'),
    });

    expect(result.allowed).toBe(false);
    expect(result.status).toBe(403);
    expect(result.code).toBe('guard_blocked');
    expect(result.events[0]?.status).toBe('blocked');
  });

  it('refuses new requests while an approval is pending', async () => {
    const pendingResult = guards.evaluateRequest({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody(PRIVATE_KEY),
    });

    const event = await waitFor(() => guards.pending(session.id)[0], {
      description: 'a pending private-key approval',
    });

    const blocked = await guards.evaluateRequest({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody('A harmless follow-up.'),
    });

    expect(blocked).toMatchObject({
      allowed: false,
      status: 403,
      code: 'guard_blocked',
    });

    guards.resolveEvent(event.id, { decision: 'approve', channel: 'cli' });
    await pendingResult;
  });

  it('rescans stored session data without opening a new approval gate', () => {
    const handle = recorder.begin({
      sessionId: session.id,
      protocol: 'openai',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody(`Here is the key: ${OPENAI_KEY}`),
    });
    recorder.finish(handle, {
      status: 'completed',
      responseStatus: 200,
      responseHeaders: {},
      collected: collectNonStreamResponse('openai', '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }),
    });

    const firstScan = guards.scanSession(session.id);
    expect(firstScan.findings.some((finding) => finding.type === 'openai-api-key')).toBe(true);
    expect(firstScan.events.length).toBeGreaterThan(0);
    expect(firstScan.events.every((event) => event.status !== 'pending')).toBe(true);
    expect(firstScan.events[0]?.ruleId).toMatch(/^secret-scan:/);
    expect(firstScan.filesExamined).toBe(1);

    const secondScan = guards.scanSession(session.id);
    expect(secondScan.findings).toEqual(firstScan.findings);
    expect(secondScan.events).toHaveLength(firstScan.events.length);
  });

  it('keeps an approved pending event when a rescan replaces scan events', async () => {
    const pendingResult = guards.evaluateRequest({
      sessionId: session.id,
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {},
      bodyText: requestBody(PRIVATE_KEY),
    });
    const event = await waitFor(() => guards.pending(session.id)[0], {
      description: 'a pending private-key approval',
    });
    guards.resolveEvent(event.id, { decision: 'approve', channel: 'cli' });
    await pendingResult;

    guards.scanSession(session.id);
    expect(store.getGuardEvent(event.id)?.status).toBe('approved');
  });
});
