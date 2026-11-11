import { daemonApi, DaemonError, liveSocketUrl, updateApi } from './client';
import { PRODUCT_NAME } from '../brand';
import type {
  AdapterStatus,
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  GuardEvent,
  GuardRule,
  Health,
  LiveEvent,
  MigrationRecord,
  Overview,
  Session,
  UpdateStatus,
} from './types';
import { agentEventIsAttention } from '../agent-events';
import { notifyAgentEvent, notifyUpdateAvailable } from '../notify.svelte';

export type DaemonStatus = 'connecting' | 'online' | 'offline';

export const daemonState = $state<{
  health: Health | null;
  overview: Overview | null;
  sessions: Session[];
  guards: GuardEvent[];
  rules: GuardRule[];
  adapters: AdapterStatus[];
  settings: Record<string, string>;
  agents: AgentSession[];
  agentEvents: AgentEvent[];
  agentOpenCount: number;
  liveEvents: LiveEvent[];
  update: UpdateStatus | null;
  migration: MigrationRecord | null;
  status: DaemonStatus;
  liveConnected: boolean;
  loading: boolean;
  error: string | null;
  lastSyncedAt: number | null;
}>({
  health: null,
  overview: null,
  sessions: [],
  guards: [],
  rules: [],
  adapters: [],
  settings: {},
  agents: [],
  agentEvents: [],
  agentOpenCount: 0,
  liveEvents: [],
  update: null,
  migration: null,
  status: 'connecting',
  liveConnected: false,
  loading: false,
  error: null,
  lastSyncedAt: null,
});

const MAX_LIVE_EVENTS = 500;
const knownAgentEventIds = new Set<string>();
let agentEventsInitialized = false;
let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let refreshTimer: number | undefined;
let refreshDebounce: number | undefined;
// A user action (snooze, skip, toggle, check now) wins over a status request
// that started before it. Without this, an in-flight page refresh could put a
// skipped update back on screen until the next poll.
let updateRevision = 0;
let reconnectDelay = 800;
let started = false;
let refreshing = false;
let refreshAgain = false;

function errorMessage(error: unknown): string {
  if (error instanceof DaemonError) return error.message;
  if (error instanceof Error) return error.message;
  return `The ${PRODUCT_NAME} daemon is not reachable.`;
}

/**
 * Emit one notification per newly arrived attention event. The first refresh
 * only records what already exists so opening the app does not replay history.
 */
function trackAgentEvents(events: AgentEvent[]): void {
  const fresh = events.filter(
    (event) => event.status === 'open' && !knownAgentEventIds.has(event.id),
  );
  for (const event of events) knownAgentEventIds.add(event.id);
  if (!agentEventsInitialized) {
    agentEventsInitialized = true;
    return;
  }
  for (const event of fresh) {
    if (event.metadata?.demo === true) continue;
    // Match the daemon: attention events and finished agents are worth a
    // notification; starting a session is not.
    if (!agentEventIsAttention(event.type) && event.type !== 'done') continue;
    notifyAgentEvent({
      type: event.type,
      agentName: event.agentName,
      projectName: event.projectName,
    });
  }
}

/** Apply a status returned by a user action and invalidate older polls. */
export function applyUpdateStatus(status: UpdateStatus): void {
  updateRevision += 1;
  daemonState.update = status;
}

/** Pull every screen's data in one pass. Individual endpoints may fail. */
export async function refreshDaemon(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  daemonState.loading = daemonState.overview === null;
  try {
    const health = await daemonApi.health();
    daemonState.health = health;
    daemonState.status = health.ok ? 'online' : 'offline';
    daemonState.error = health.ok ? null : 'The daemon database is unavailable.';

    const updateRevisionAtStart = updateRevision;
    const [
      overview,
      sessions,
      guards,
      rules,
      adapters,
      settings,
      agents,
      agentEvents,
      update,
      migrations,
    ] = await Promise.allSettled([
      daemonApi.overview(),
      daemonApi.sessions(100),
      daemonApi.guards(),
      daemonApi.rules(),
      daemonApi.adapters(),
      daemonApi.settings(),
      daemonApi.agents(),
      daemonApi.agentEvents(),
      updateApi.status(),
      updateApi.migrations(),
    ]);

    if (overview.status === 'fulfilled') daemonState.overview = overview.value;
    if (sessions.status === 'fulfilled') daemonState.sessions = sessions.value.sessions;
    if (guards.status === 'fulfilled') daemonState.guards = guards.value.events;
    if (rules.status === 'fulfilled') daemonState.rules = rules.value.rules;
    if (adapters.status === 'fulfilled') daemonState.adapters = adapters.value.adapters;
    if (settings.status === 'fulfilled') daemonState.settings = settings.value.settings;
    if (agents.status === 'fulfilled') daemonState.agents = agents.value.sessions;
    if (agentEvents.status === 'fulfilled') {
      trackAgentEvents(agentEvents.value.events);
      daemonState.agentEvents = agentEvents.value.events;
      daemonState.agentOpenCount = agentEvents.value.openCount;
    }
    if (update.status === 'fulfilled' && updateRevisionAtStart === updateRevision) {
      daemonState.update = update.value;
    }
    if (migrations.status === 'fulfilled') daemonState.migration = migrations.value.migration;
    daemonState.lastSyncedAt = Date.now();
  } catch (error) {
    daemonState.status = 'offline';
    daemonState.error = errorMessage(error);
  } finally {
    daemonState.loading = false;
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refreshDaemon();
    }
  }
}

function scheduleRefresh(): void {
  if (refreshDebounce) window.clearTimeout(refreshDebounce);
  refreshDebounce = window.setTimeout(() => {
    refreshDebounce = undefined;
    void refreshDaemon();
  }, 320);
}

function rememberEvent(event: LiveEvent): void {
  if (daemonState.liveEvents.some((known) => known.sequence === event.sequence)) return;
  daemonState.liveEvents.push(event);
  if (daemonState.liveEvents.length > MAX_LIVE_EVENTS) {
    daemonState.liveEvents.splice(0, daemonState.liveEvents.length - MAX_LIVE_EVENTS);
  }
}

function handleLiveEvent(event: LiveEvent): void {
  rememberEvent(event);
  if (event.type === 'stream.chunk') return;
  if (event.type === 'update.available') {
    // The daemon emits this once per version. A reconnect can replay it, so
    // the notification layer dedupes by version on this device.
    const version = typeof event.payload.version === 'string' ? event.payload.version : '';
    if (version) {
      notifyUpdateAvailable({
        version,
        notesSummary:
          typeof event.payload.notesSummary === 'string' ? event.payload.notesSummary : '',
      });
    }
  }
  scheduleRefresh();
}

/** Refresh only the update status, without pulling every screen. */
export async function refreshUpdate(): Promise<void> {
  const revision = updateRevision;
  try {
    const next = await updateApi.status();
    if (revision === updateRevision) daemonState.update = next;
  } catch {
    // Keep the last known status; the next poll recovers.
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connectLive();
  }, reconnectDelay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.7), 15_000);
}

export function connectLive(): void {
  if (typeof window === 'undefined') return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  let next: WebSocket;
  try {
    next = new WebSocket(liveSocketUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = next;

  next.onopen = () => {
    reconnectDelay = 800;
    daemonState.liveConnected = true;
  };
  next.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data)) as LiveEvent;
      if (event && typeof event.type === 'string') handleLiveEvent(event);
    } catch {
      // A malformed event must not break the stream.
    }
  };
  next.onerror = () => {
    next.close();
  };
  next.onclose = () => {
    daemonState.liveConnected = false;
    if (socket === next) socket = null;
    scheduleReconnect();
  };
}

/** Initialize polling and the live socket. Returns a cleanup function. */
export function initDaemon(): () => void {
  if (started) return () => undefined;
  started = true;
  void refreshDaemon();
  connectLive();
  refreshTimer = window.setInterval(() => {
    if (!document.hidden) void refreshDaemon();
  }, 15_000);

  const onVisible = (): void => {
    if (document.hidden) return;
    void refreshDaemon();
    connectLive();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    started = false;
    document.removeEventListener('visibilitychange', onVisible);
    if (refreshTimer) window.clearInterval(refreshTimer);
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (refreshDebounce) window.clearTimeout(refreshDebounce);
    socket?.close();
    socket = null;
    daemonState.liveConnected = false;
  };
}

export function pendingGuards(): GuardEvent[] {
  return daemonState.guards.filter((event) => event.status === 'pending');
}

export function resolvedGuards(): GuardEvent[] {
  return daemonState.guards
    .filter((event) => event.status !== 'pending')
    .slice()
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
}

/** Open agent events, newest first. */
export function openAgentEvents(): AgentEvent[] {
  return daemonState.agentEvents
    .filter((event) => event.status === 'open')
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function acknowledgedAgentEvents(): AgentEvent[] {
  return daemonState.agentEvents
    .filter((event) => event.status === 'acknowledged')
    .slice()
    .sort((a, b) =>
      (a.acknowledgedAt ?? a.createdAt) < (b.acknowledgedAt ?? b.createdAt) ? 1 : -1,
    );
}

/** Open events that actually wait on a human, plus errors. */
export function agentAttentionCount(): number {
  return openAgentEvents().filter((event) => agentEventIsAttention(event.type)).length;
}

/** The badge number shared by the rail, tab bar, and top bar. */
export function inboxAttentionCount(): number {
  return pendingGuards().length + agentAttentionCount();
}

export function agentById(id: string): AgentSession | undefined {
  return daemonState.agents.find((session) => session.sessionId === id);
}

export function openAgentEventsFor(sessionId: string): AgentEvent[] {
  return openAgentEvents().filter((event) => event.sessionId === sessionId);
}

export function hasAuthPrompt(sessionId: string): boolean {
  return openAgentEventsFor(sessionId).some((event) => event.type === 'auth_required');
}

export function sessionById(id: string): Session | undefined {
  return daemonState.sessions.find((session) => session.id === id);
}

export function guardById(id: string): GuardEvent | undefined {
  return daemonState.guards.find((event) => event.id === id);
}

export function activeSessions(): Session[] {
  return daemonState.sessions.filter((session) => session.status === 'active');
}

export function installedAdapters(): AdapterStatus[] {
  return daemonState.adapters.filter((adapter) => adapter.installed);
}

export function liveTextFor(sessionId: string): string {
  return daemonState.liveEvents
    .filter((event) => event.type === 'stream.chunk' && event.sessionId === sessionId)
    .map((event) => {
      const delta = event.payload.deltaText;
      return typeof delta === 'string' ? delta : '';
    })
    .join('');
}

export async function decideGuard(
  id: string,
  decision: ApprovalDecision,
): Promise<GuardEvent> {
  const guard = guardById(id);
  const result = await daemonApi.decide(id, {
    actor: 'local-ui',
    channel: 'web',
    // The daemon binds the answer to this request, nonce, and session. A late
    // or replayed answer is rejected even if the UI sends it by mistake.
    nonce: guard?.approvalNonce,
    sessionId: guard?.sessionId,
    ...decision,
  });
  const index = daemonState.guards.findIndex((event) => event.id === id);
  if (index >= 0) daemonState.guards[index] = result.event;
  scheduleRefresh();
  return result.event;
}

export async function acknowledgeAgentEvent(id: string): Promise<AgentEvent> {
  const result = await daemonApi.ackAgentEvent(id);
  const index = daemonState.agentEvents.findIndex((event) => event.id === id);
  if (index >= 0) daemonState.agentEvents[index] = result.event;
  scheduleRefresh();
  return result.event;
}

export async function seedDemoData(): Promise<number> {
  const result = await daemonApi.seedDemo();
  await refreshDaemon();
  return result.sessions.length;
}

export function daemonErrorMessage(error: unknown): string {
  return errorMessage(error);
}
