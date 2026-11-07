export type ApprovalOutcome = 'approved' | 'denied' | 'expired';

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds the HTTP request only while a pause rule is being decided. Timers are
 * unref'd so a forgotten approval can never keep the daemon process alive.
 */
export class ApprovalBroker {
  readonly #pending = new Map<string, PendingApproval>();

  waitFor(eventId: string, timeoutMs: number): Promise<ApprovalOutcome> {
    this.cancel(eventId, 'expired');

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(eventId);
          resolve('expired');
        },
        Math.max(1, timeoutMs),
      );
      timer.unref();

      this.#pending.set(eventId, { resolve, timer });
    });
  }

  resolve(eventId: string, decision: 'approve' | 'deny'): boolean {
    const pending = this.#pending.get(eventId);
    if (!pending) return false;
    this.#pending.delete(eventId);
    clearTimeout(pending.timer);
    pending.resolve(decision === 'approve' ? 'approved' : 'denied');
    return true;
  }

  cancel(eventId: string, outcome: ApprovalOutcome = 'expired'): boolean {
    const pending = this.#pending.get(eventId);
    if (!pending) return false;
    this.#pending.delete(eventId);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
    return true;
  }

  isPending(eventId: string): boolean {
    return this.#pending.has(eventId);
  }

  clear(): void {
    for (const [eventId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve('expired');
      this.#pending.delete(eventId);
    }
  }
}
