import type {
  AgentInfo,
  CreateSessionInput,
  ProviderProtocol,
  Session,
  SessionSource,
} from '@cockpit/core';

import type { SessionSnapshotRecorder } from '../git/snapshots.js';
import type { Logger } from '../logger.js';
import type { LiveEventBus } from '../live/bus.js';
import type { CreateSessionRecordInput, Store } from '../store/store.js';

export interface SessionManagerOptions {
  store: Store;
  bus: LiveEventBus;
  logger: Logger;
  idleTimeoutMs: number;
  snapshots?: SessionSnapshotRecorder;
  onSessionEnded?: (session: Session) => void;
}

interface AmbientSession {
  sessionId: string;
  lastUsedAt: number;
}

function sessionTotalsPayload(session: Session): Record<string, number> {
  return {
    stepCount: session.totals.stepCount,
    modelCallCount: session.totals.modelCallCount,
    toolCallCount: session.totals.toolCallCount,
    inputTokens: session.totals.inputTokens,
    outputTokens: session.totals.outputTokens,
    cacheReadTokens: session.totals.cacheReadTokens,
    cacheWriteTokens: session.totals.cacheWriteTokens,
    reasoningTokens: session.totals.reasoningTokens,
    totalCostUsd: session.totals.totalCostUsd,
    unknownCostCalls: session.totals.unknownCostCalls,
    errorCount: session.totals.errorCount,
  };
}

export class SessionManager {
  readonly #store: Store;
  readonly #bus: LiveEventBus;
  readonly #logger: Logger;
  readonly #idleTimeoutMs: number;
  readonly #snapshots: SessionSnapshotRecorder | undefined;
  readonly #onSessionEnded: ((session: Session) => void) | undefined;
  readonly #ambient = new Map<ProviderProtocol, AmbientSession>();

  constructor(options: SessionManagerOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#logger = options.logger;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#snapshots = options.snapshots;
    this.#onSessionEnded = options.onSessionEnded;
  }

  create(input: CreateSessionInput): Session {
    const protocol = input.protocol;
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 16).replace('T', ' ');
    const protocolLabel =
      protocol === 'anthropic' ? 'Anthropic' : protocol === 'openai' ? 'OpenAI' : 'Cockpit';
    const title = input.title ?? `${protocolLabel} session · ${timestamp}`;

    const recordInput: CreateSessionRecordInput = {
      title,
      source: input.source,
      tags: input.tags,
      startedAt: now,
    };
    if (protocol) recordInput.protocol = protocol;
    if (input.provider) recordInput.provider = input.provider;
    if (input.model) recordInput.model = input.model;
    if (input.agent) recordInput.agent = input.agent;
    if (input.workspacePath) {
      recordInput.workspacePath = input.workspacePath;
      if (!input.projectId) {
        try {
          recordInput.projectId = this.#store.ensureProject(input.workspacePath).id;
        } catch (error) {
          this.#logger.warn('Cockpit could not register the session workspace', error);
        }
      }
    }
    if (input.gitBranch) recordInput.gitBranch = input.gitBranch;
    if (input.gitBaseCommit) recordInput.gitBaseCommit = input.gitBaseCommit;
    if (input.projectId) recordInput.projectId = input.projectId;

    const session = this.#store.createSession(recordInput);
    this.#emitStarted(session);
    return session;
  }

  resolveAmbient(protocol: ProviderProtocol, agent?: AgentInfo): Session {
    const existing = this.#ambient.get(protocol);
    if (existing) {
      const session = this.#store.getSession(existing.sessionId);
      if (session && session.status === 'active') {
        existing.lastUsedAt = Date.now();
        return session;
      }
      this.#ambient.delete(protocol);
    }

    const title = protocol === 'anthropic' ? 'Local Anthropic proxy' : 'Local OpenAI proxy';
    const source: SessionSource = 'proxy';
    const recordInput: CreateSessionRecordInput = {
      title,
      source,
      protocol,
      tags: ['ambient'],
      metadata: { autoCreated: true, protocol },
    };
    if (agent) recordInput.agent = agent;

    const session = this.#store.createSession(recordInput);
    this.#ambient.set(protocol, { sessionId: session.id, lastUsedAt: Date.now() });
    this.#emitStarted(session);
    return session;
  }

  markUsed(sessionId: string): void {
    for (const entry of this.#ambient.values()) {
      if (entry.sessionId === sessionId) {
        entry.lastUsedAt = Date.now();
        return;
      }
    }
  }

  sweep(now = Date.now()): string[] {
    const ended: string[] = [];
    for (const [protocol, entry] of this.#ambient) {
      if (now - entry.lastUsedAt < this.#idleTimeoutMs) continue;
      const session = this.endSession(entry.sessionId, 'completed');
      if (session) ended.push(session.id);
      this.#ambient.delete(protocol);
    }
    return ended;
  }

  endSession(id: string, status: 'completed' | 'failed' | 'killed'): Session | undefined {
    const before = this.#store.getSession(id);
    if (!before) return undefined;
    if (before.status !== 'active') return before;

    const session = this.#store.endSession(id, status);
    if (!session) return undefined;

    this.#bus.emit('session.completed', {
      sessionId: session.id,
      payload: {
        status: session.status,
        ...(session.durationMs === undefined ? {} : { durationMs: session.durationMs }),
        totals: sessionTotalsPayload(session),
      },
    });
    this.#snapshots?.noteSessionEnded(session.id);
    if (this.#onSessionEnded) {
      try {
        this.#onSessionEnded(session);
      } catch (error) {
        this.#logger.warn('Cockpit session-end hook failed', error);
      }
    }
    return session;
  }

  shutdown(): void {
    this.#ambient.clear();
    for (const session of this.#store.listActiveSessions()) {
      try {
        this.endSession(session.id, 'completed');
      } catch (error) {
        this.#logger.error('Failed to end session during shutdown', error);
      }
    }
  }

  #emitStarted(session: Session): void {
    this.#bus.emit('session.started', {
      sessionId: session.id,
      payload: {
        title: session.title,
        source: session.source,
        status: session.status,
        ...(session.modelRef?.provider ? { provider: session.modelRef.provider } : {}),
        ...(session.modelRef?.model ? { model: session.modelRef.model } : {}),
        ...(session.agent?.name ? { agent: session.agent.name } : {}),
      },
    });
  }
}
