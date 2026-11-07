import {
  budgetPeriodStart,
  type BudgetPolicy,
  type BudgetStatus,
  type Session,
} from '@cockpit/core';

import type { LiveEventBus } from '../live/bus.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';
import type { ApprovalBroker } from './approval.js';
import { GuardEventRecorder } from './events.js';

export interface BudgetCheckResult {
  statuses: BudgetStatus[];
  blocked?: {
    policy: BudgetPolicy;
    status: BudgetStatus;
  };
}

export interface BudgetServiceOptions {
  store: Store;
  bus: LiveEventBus;
  logger: Logger;
  broker: ApprovalBroker;
  approvalTimeoutMs: number;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Budget checks are local arithmetic over recorded costs, not estimates. The
 * warning threshold is 80%; the hard limit follows the policy enforcement.
 */
export class BudgetService {
  readonly #store: Store;
  readonly #bus: LiveEventBus;
  readonly #logger: Logger;
  readonly #broker: ApprovalBroker;
  readonly #approvalTimeoutMs: number;
  readonly #events: GuardEventRecorder;
  readonly #warned = new Set<string>();

  constructor(options: BudgetServiceOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#logger = options.logger;
    this.#broker = options.broker;
    this.#approvalTimeoutMs = options.approvalTimeoutMs;
    this.#events = new GuardEventRecorder({
      store: options.store,
      bus: options.bus,
      logger: options.logger,
    });
  }

  statuses(sessionId: string): BudgetStatus[] {
    const session = this.#store.getSession(sessionId);
    if (!session) return [];
    return this.#store
      .listBudgetPolicies()
      .filter((policy) => policy.enabled && this.#applies(policy, session))
      .map((policy) => this.#statusFor(policy, session));
  }

  async check(sessionId: string): Promise<BudgetCheckResult> {
    const session = this.#store.getSession(sessionId);
    if (!session) return { statuses: [] };

    const policies = this.#store
      .listBudgetPolicies()
      .filter((policy) => policy.enabled && this.#applies(policy, session));
    const statuses = policies.map((policy) => this.#statusFor(policy, session));

    for (const status of statuses) {
      const policy = policies.find((candidate) => candidate.id === status.policyId);
      if (!policy) continue;

      if (!status.exceeded) {
        if (status.warning) this.#recordWarning(sessionId, policy, status);
        continue;
      }

      if (this.#hasOverride(policy, status.periodStart)) continue;

      if (policy.enforcement === 'block') {
        this.#recordExceeded(sessionId, policy, status, 'block');
        return { statuses, blocked: { policy, status } };
      }

      if (policy.enforcement === 'pause') {
        const event = this.#recordExceeded(sessionId, policy, status, 'pause');
        const outcome = await this.#broker.waitFor(event.id, this.#approvalTimeoutMs);
        const current = this.#store.getGuardEvent(event.id);
        if (current?.status === 'pending') {
          this.#events.resolve(
            event.id,
            {
              status:
                outcome === 'approved' ? 'approved' : outcome === 'denied' ? 'denied' : 'expired',
              resolvedAt: new Date(),
            },
            {
              actor: 'cockpit',
              ...(outcome === 'expired' ? { note: 'The approval window elapsed.' } : {}),
            },
          );
        }
        if (outcome !== 'approved') {
          return { statuses, blocked: { policy, status } };
        }
        continue;
      }

      this.#recordWarning(sessionId, policy, status, true);
    }

    return { statuses };
  }

  #applies(policy: BudgetPolicy, session: Session): boolean {
    if (policy.scope === 'session') return policy.sessionId === session.id;
    if (policy.scope === 'project') {
      return policy.projectId !== undefined && policy.projectId === session.projectId;
    }
    return true;
  }

  #statusFor(policy: BudgetPolicy, session: Session): BudgetStatus {
    const periodStart = budgetPeriodStart(policy.period, new Date(), new Date(session.startedAt));
    const spent =
      policy.period === 'session'
        ? session.totals.totalCostUsd
        : policy.scope === 'session' && policy.sessionId
          ? this.#store.sessionCostUsd(policy.sessionId)
          : this.#store.spendSince(
              periodStart,
              policy.scope === 'project' ? policy.projectId : undefined,
            );

    const limit = Math.max(0, policy.limitUsd);
    const usageRatio = limit <= 0 ? (spent > 0 ? 1 : 0) : spent / limit;
    const exceeded = limit <= 0 ? spent > 0 : spent >= limit;

    return {
      policyId: policy.id,
      name: policy.name,
      limitUsd: roundUsd(limit),
      spentUsd: roundUsd(spent),
      remainingUsd: roundUsd(Math.max(0, limit - spent)),
      usageRatio: Math.round(usageRatio * 1000) / 1000,
      warning: !exceeded && usageRatio >= 0.8,
      exceeded,
      enforcement: policy.enforcement,
      period: policy.period,
      periodStart: periodStart.toISOString(),
    };
  }

  #hasOverride(policy: BudgetPolicy, periodStart: string): boolean {
    const events = this.#store.listGuardEvents({
      kind: 'budget',
      status: 'approved',
      limit: 500,
    });
    return events.some(
      (event) =>
        event.metadata?.['policyId'] === policy.id &&
        event.metadata?.['periodStart'] === periodStart &&
        event.metadata?.['kind'] === 'exceeded',
    );
  }

  #recordWarning(
    sessionId: string,
    policy: BudgetPolicy,
    status: BudgetStatus,
    exceeded = false,
  ): void {
    const key = `${policy.id}:${status.periodStart}:${exceeded ? 'exceeded' : 'warning'}`;
    if (this.#warned.has(key)) return;
    this.#warned.add(key);

    const event = this.#events.record({
      sessionId,
      ruleId: `budget:${policy.id}`,
      kind: 'budget',
      action: 'warn',
      severity: exceeded ? 'high' : 'medium',
      status: 'warned',
      title: `${exceeded ? 'Budget exceeded' : 'Budget warning'}: ${policy.name}`,
      description: `${status.spentUsd.toFixed(4)} USD of ${status.limitUsd.toFixed(4)} USD used (${Math.round(status.usageRatio * 100)}%).`,
      metadata: {
        kind: exceeded ? 'exceeded' : 'warning',
        policyId: policy.id,
        periodStart: status.periodStart,
        spentUsd: status.spentUsd,
        limitUsd: status.limitUsd,
        usageRatio: status.usageRatio,
      },
    });

    this.#bus.emit(exceeded ? 'budget.exceeded' : 'budget.warning', {
      sessionId: event.sessionId,
      payload: {
        policyId: policy.id,
        name: policy.name,
        spentUsd: status.spentUsd,
        limitUsd: status.limitUsd,
        usageRatio: status.usageRatio,
        enforcement: policy.enforcement,
      },
    });
  }

  #recordExceeded(
    sessionId: string,
    policy: BudgetPolicy,
    status: BudgetStatus,
    action: 'block' | 'pause',
  ): ReturnType<GuardEventRecorder['record']> {
    const event = this.#events.record({
      sessionId,
      ruleId: `budget:${policy.id}`,
      kind: 'budget',
      action,
      severity: 'high',
      status: action === 'block' ? 'blocked' : 'pending',
      title: `Budget exceeded: ${policy.name}`,
      description: `${status.spentUsd.toFixed(4)} USD of ${status.limitUsd.toFixed(4)} USD used. Enforcement: ${policy.enforcement}.`,
      metadata: {
        kind: 'exceeded',
        policyId: policy.id,
        periodStart: status.periodStart,
        spentUsd: status.spentUsd,
        limitUsd: status.limitUsd,
        usageRatio: status.usageRatio,
      },
    });

    this.#bus.emit('budget.exceeded', {
      sessionId: event.sessionId,
      payload: {
        policyId: policy.id,
        name: policy.name,
        spentUsd: status.spentUsd,
        limitUsd: status.limitUsd,
        usageRatio: status.usageRatio,
        enforcement: policy.enforcement,
      },
    });

    this.#logger.debug('Budget policy exceeded', {
      policyId: policy.id,
      enforcement: policy.enforcement,
    });
    return event;
  }
}
