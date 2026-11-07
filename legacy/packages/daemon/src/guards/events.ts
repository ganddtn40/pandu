import type { GuardEvent } from '@cockpit/core';

import type { LiveEventBus } from '../live/bus.js';
import type { Logger } from '../logger.js';
import type { InsertGuardEventInput, Store, UpdateGuardEventInput } from '../store/store.js';

export interface GuardEventRecorderOptions {
  store: Store;
  bus: LiveEventBus;
  logger: Logger;
}

function eventPayload(event: GuardEvent): Record<string, string | number> {
  return {
    ruleId: event.ruleId,
    kind: event.kind,
    action: event.action,
    severity: event.severity,
    status: event.status,
    title: event.title,
    evidenceCount: event.evidence.length,
  };
}

export class GuardEventRecorder {
  readonly #store: Store;
  readonly #bus: LiveEventBus;
  readonly #logger: Logger;

  constructor(options: GuardEventRecorderOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#logger = options.logger;
  }

  record(input: InsertGuardEventInput): GuardEvent {
    const event = this.#store.insertGuardEvent(input);
    this.#bus.emit('guard.triggered', {
      sessionId: event.sessionId,
      ...(event.stepId ? { stepId: event.stepId } : {}),
      payload: eventPayload(event),
    });
    return event;
  }

  resolve(
    eventId: string,
    patch: UpdateGuardEventInput,
    options: { actor?: string; note?: string } = {},
  ): GuardEvent | undefined {
    const event = this.#store.updateGuardEvent(eventId, {
      ...patch,
      ...(options.actor ? { resolvedBy: options.actor } : {}),
      ...(options.note ? { resolutionNote: options.note } : {}),
    });
    if (!event) return undefined;

    this.#bus.emit('guard.resolved', {
      sessionId: event.sessionId,
      ...(event.stepId ? { stepId: event.stepId } : {}),
      payload: {
        ...eventPayload(event),
        ...(event.resolvedBy ? { resolvedBy: event.resolvedBy } : {}),
      },
    });
    return event;
  }

  expire(eventId: string): GuardEvent | undefined {
    return this.resolve(
      eventId,
      { status: 'expired', resolvedAt: new Date() },
      { actor: 'cockpit', note: 'The approval window elapsed.' },
    );
  }

  logFailure(message: string, error: unknown): void {
    this.#logger.warn(message, error);
  }
}
