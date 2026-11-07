import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BudgetPolicy, BudgetPolicyInput, Session } from '@cockpit/core';

import { openDatabase, type CockpitDatabaseConnection } from '../src/db/client.js';
import { ApprovalBroker } from '../src/guards/approval.js';
import { BudgetService } from '../src/guards/budget.js';
import { GuardService } from '../src/guards/service.js';
import { LiveEventBus } from '../src/live/bus.js';
import { createLogger } from '../src/logger.js';
import { Recorder } from '../src/recording/recorder.js';
import { collectNonStreamResponse } from '../src/sse/collector.js';
import { Store } from '../src/store/store.js';

import { waitFor } from './helpers.js';

function recordStep(store: Store, bus: LiveEventBus, sessionId: string): void {
  const recorder = new Recorder({ store, bus, logger: createLogger('silent') });
  const handle = recorder.begin({
    sessionId,
    protocol: 'openai',
    provider: 'openai',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {},
    bodyText: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Record a billable step.' }],
    }),
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
}

describe('BudgetService', () => {
  let connection: CockpitDatabaseConnection;
  let store: Store;
  let bus: LiveEventBus;
  let broker: ApprovalBroker;
  let guards: GuardService;
  let budgets: BudgetService;
  let session: Session;
  let spent: number;

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
    budgets = new BudgetService({
      store,
      bus,
      logger,
      broker,
      approvalTimeoutMs: 2_000,
    });
    session = store.createSession({ title: 'Budget test', source: 'manual', tags: [] });
    recordStep(store, bus, session.id);
    spent = store.sessionCostUsd(session.id);
  });

  afterEach(() => {
    guards.close();
    store.close();
  });

  function policy(overrides: Partial<BudgetPolicyInput> = {}): BudgetPolicy {
    return store.createBudgetPolicy({
      name: 'Session cap',
      scope: 'session',
      sessionId: session.id,
      period: 'session',
      limitUsd: spent / 0.9,
      enforcement: 'warn',
      enabled: true,
      ...overrides,
    });
  }

  it('returns no statuses when no policy applies', () => {
    expect(budgets.statuses(session.id)).toEqual([]);
    expect(store.sessionCostUsd(session.id)).toBeGreaterThan(0);
  });

  it('reports a warning at eighty percent without blocking', async () => {
    const created = policy();
    const statuses = budgets.statuses(session.id);

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      policyId: created.id,
      warning: true,
      exceeded: false,
      enforcement: 'warn',
      period: 'session',
    });
    expect(statuses[0]?.usageRatio).toBeGreaterThanOrEqual(0.8);
    expect(statuses[0]?.spentUsd).toBeCloseTo(spent, 6);

    const result = await budgets.check(session.id);
    expect(result.blocked).toBeUndefined();

    const events = store.listGuardEvents({ sessionId: session.id, kind: 'budget', limit: 500 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'warn',
      status: 'warned',
      ruleId: `budget:${created.id}`,
    });
    expect(events[0]?.metadata).toMatchObject({ kind: 'warning', policyId: created.id });
  });

  it('blocks when a block policy is exhausted', async () => {
    const created = policy({ enforcement: 'block', limitUsd: spent / 2 });
    const result = await budgets.check(session.id);

    expect(result.blocked?.policy.id).toBe(created.id);
    expect(result.blocked?.status.exceeded).toBe(true);

    const events = store.listGuardEvents({ sessionId: session.id, kind: 'budget', limit: 500 });
    expect(events[0]).toMatchObject({
      action: 'block',
      status: 'blocked',
      ruleId: `budget:${created.id}`,
    });
    expect(events[0]?.metadata).toMatchObject({ kind: 'exceeded' });
  });

  it('holds a pause policy until an approval is granted, then remembers the override', async () => {
    const created = policy({ enforcement: 'pause', limitUsd: spent / 2 });
    const pendingCheck = budgets.check(session.id);

    const event = await waitFor(
      () => store.listGuardEvents({ sessionId: session.id, kind: 'budget', limit: 500 })[0],
      { description: 'a pending budget approval' },
    );
    expect(event).toMatchObject({ action: 'pause', status: 'pending' });

    guards.resolveEvent(event.id, { decision: 'approve', channel: 'cli' });

    const result = await pendingCheck;
    expect(result.blocked).toBeUndefined();
    expect(store.getGuardEvent(event.id)?.status).toBe('approved');

    const repeat = await budgets.check(session.id);
    expect(repeat.blocked).toBeUndefined();
    const events = store.listGuardEvents({ sessionId: session.id, kind: 'budget', limit: 500 });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ policyId: created.id, kind: 'exceeded' });
  });

  it('blocks when a pause policy is denied', async () => {
    policy({ enforcement: 'pause', limitUsd: spent / 2 });
    const pendingCheck = budgets.check(session.id);

    const event = await waitFor(
      () => store.listGuardEvents({ sessionId: session.id, kind: 'budget', limit: 500 })[0],
      { description: 'a pending budget approval' },
    );
    guards.resolveEvent(event.id, { decision: 'deny', channel: 'dashboard' });

    const result = await pendingCheck;
    expect(result.blocked).toBeDefined();
    expect(store.getGuardEvent(event.id)?.status).toBe('denied');
  });
});
