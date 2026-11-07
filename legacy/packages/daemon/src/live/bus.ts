import { nowIso, type JsonObject, type LiveEvent, type LiveEventType } from '@cockpit/core';

import type { Logger } from '../logger.js';

export interface LiveEventDetails {
  sessionId?: string;
  stepId?: string;
  payload?: JsonObject;
  persist?: boolean;
}

export type LiveEventListener = (event: LiveEvent) => void;

export interface LiveEventBusOptions {
  initialSequence: number;
  persist?: (event: LiveEvent) => void;
  logger: Logger;
}

export class LiveEventBus {
  #sequence: number;
  readonly #persist: ((event: LiveEvent) => void) | undefined;
  readonly #logger: Logger;
  readonly #listeners = new Set<LiveEventListener>();

  constructor(options: LiveEventBusOptions) {
    this.#sequence = options.initialSequence;
    this.#persist = options.persist;
    this.#logger = options.logger;
  }

  get sequence(): number {
    return this.#sequence;
  }

  subscribe(listener: LiveEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(type: LiveEventType, details: LiveEventDetails = {}): LiveEvent {
    this.#sequence += 1;
    const event: LiveEvent = {
      sequence: this.#sequence,
      type,
      at: nowIso(),
      payload: details.payload ?? {},
      ...(details.sessionId ? { sessionId: details.sessionId } : {}),
      ...(details.stepId ? { stepId: details.stepId } : {}),
    };

    if (this.#persist && details.persist !== false) {
      try {
        this.#persist(event);
      } catch (error) {
        this.#logger.error('Failed to persist live event', error);
      }
    }

    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#logger.error('Live event listener failed', error);
      }
    }

    return event;
  }
}
