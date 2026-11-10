import {
  DaemonError,
  remoteDeviceApi,
  remoteSocketUrl,
  remoteToken,
  setRemoteToken,
} from './client';
import { PRODUCT_NAME, WS_SUBPROTOCOL_PREFIX } from '../brand';
import type {
  AgentEvent,
  AgentSession,
  GuardEvent,
  LiveEvent,
  Overview,
  RemoteClaimPoll,
  RemoteClaimTicket,
  RemoteSessionInfo,
  Session,
} from './types';

export type RemotePhase = 'loading' | 'pairing' | 'ready' | 'offline';

/**
 * Everything the paired device knows. The remote listener is the only source:
 * the host management API does not exist there, and the device only ever sees
 * what its scopes allow.
 */
export const remoteState = $state<{
  phase: RemotePhase;
  info: RemoteSessionInfo | null;
  overview: Overview | null;
  sessions: Session[];
  guards: GuardEvent[];
  agents: AgentSession[];
  agentEvents: AgentEvent[];
  error: string | null;
  liveConnected: boolean;
  lastSyncedAt: number | null;
  busy: boolean;
}>({
  phase: 'loading',
  info: null,
  overview: null,
  sessions: [],
  guards: [],
  agents: [],
  agentEvents: [],
  error: null,
  liveConnected: false,
  lastSyncedAt: null,
  busy: false,
});

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let refreshTimer: number | undefined;
let reconnectDelay = 1_000;
let stopped = true;
let refreshing = false;

export function remoteErrorMessage(error: unknown): string {
  if (error instanceof DaemonError) return error.message;
  if (error instanceof Error) return error.message;
  return `${PRODUCT_NAME} could not reach the host.`;
}

function clearSession(error: string | null): void {
  setRemoteToken(null);
  remoteState.phase = 'pairing';
  remoteState.info = null;
  remoteState.overview = null;
  remoteState.sessions = [];
  remoteState.guards = [];
  remoteState.agents = [];
  remoteState.agentEvents = [];
  remoteState.error = error;
  stopRemoteLive();
}

/** Pull every scoped endpoint. A revoked token returns to the pairing gate. */
export async function refreshRemote(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    let info: RemoteSessionInfo;
    try {
      info = await remoteDeviceApi.session();
    } catch (error) {
      if (error instanceof DaemonError && (error.status === 401 || error.status === 403)) {
        clearSession(error.message);
        return;
      }
      remoteState.phase = 'offline';
      remoteState.error = remoteErrorMessage(error);
      return;
    }

    remoteState.info = info;
    remoteState.phase = 'ready';
    remoteState.error = null;

    const [overview, sessions, guards, agents, agentEvents] = await Promise.allSettled([
      remoteDeviceApi.overview(),
      remoteDeviceApi.sessions(100),
      remoteDeviceApi.guards(),
      remoteDeviceApi.agents(),
      remoteDeviceApi.agentEvents(),
    ]);
    if (overview.status === 'fulfilled') remoteState.overview = overview.value;
    if (sessions.status === 'fulfilled') remoteState.sessions = sessions.value.sessions;
    if (guards.status === 'fulfilled') remoteState.guards = guards.value.events;
    if (agents.status === 'fulfilled') remoteState.agents = agents.value.sessions;
    if (agentEvents.status === 'fulfilled') remoteState.agentEvents = agentEvents.value.events;
    remoteState.lastSyncedAt = Date.now();
    connectRemoteLive();
  } finally {
    refreshing = false;
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void openSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.7), 15_000);
}

function handleLiveEvent(event: LiveEvent): void {
  if (event.type === 'stream.chunk' || event.type === 'live.ping') return;
  // The live stream is a hint; scoped reads remain the source of truth.
  if (event.type.startsWith('guard.') || event.type.startsWith('remote.')) {
    void refreshRemote();
  }
}

async function openSocket(): Promise<void> {
  if (stopped) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  let ticket: string;
  try {
    ticket = (await remoteDeviceApi.wsTicket()).ticket;
  } catch (error) {
    if (error instanceof DaemonError && (error.status === 401 || error.status === 403)) {
      clearSession(error.message);
      return;
    }
    scheduleReconnect();
    return;
  }
  let next: WebSocket;
  try {
    // The single-use ticket rides in the subprotocol, never in the URL.
    next = new WebSocket(remoteSocketUrl(), [`${WS_SUBPROTOCOL_PREFIX}${ticket}`]);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = next;
  next.onopen = () => {
    reconnectDelay = 1_000;
    remoteState.liveConnected = true;
  };
  next.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data)) as LiveEvent;
      if (event && typeof event.type === 'string') handleLiveEvent(event);
    } catch {
      // A malformed event must not break the stream.
    }
  };
  next.onerror = () => next.close();
  next.onclose = (event) => {
    remoteState.liveConnected = false;
    if (socket === next) socket = null;
    if (event.code === 1008) {
      // Revoked or scope removed: re-check the token before reconnecting.
      void refreshRemote();
      return;
    }
    scheduleReconnect();
  };
}

export function connectRemoteLive(): void {
  if (typeof window === 'undefined') return;
  void openSocket();
}

export function stopRemoteLive(): void {
  stopped = true;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  socket?.close();
  socket = null;
  remoteState.liveConnected = false;
}

/** Start the remote dashboard. Returns a cleanup function. */
export function initRemoteApp(): () => void {
  stopped = false;
  if (!remoteToken()) {
    remoteState.phase = 'pairing';
  } else {
    remoteState.phase = 'loading';
    void refreshRemote();
  }
  refreshTimer = window.setInterval(() => {
    if (!document.hidden && remoteToken()) void refreshRemote();
  }, 15_000);

  const onVisible = (): void => {
    if (document.hidden || !remoteToken()) return;
    void refreshRemote();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisible);
    if (refreshTimer) window.clearInterval(refreshTimer);
    stopRemoteLive();
  };
}

export function claimPairing(
  code: string,
  deviceName: string,
  pin: string | undefined,
  verificationCode: string,
): Promise<RemoteClaimTicket> {
  return remoteDeviceApi.claim(code, deviceName, pin, verificationCode);
}

export function pollPairing(ticket: RemoteClaimTicket): Promise<RemoteClaimPoll> {
  return remoteDeviceApi.pollClaim(ticket.claimId, ticket.claimSecret);
}

/** Store the one-time token and load the dashboard. */
export function acceptPairingToken(token: string): void {
  setRemoteToken(token);
  remoteState.phase = 'loading';
  remoteState.error = null;
  void refreshRemote();
}

export async function forgetThisDevice(): Promise<void> {
  try {
    await remoteDeviceApi.logout();
  } catch {
    // Even if the host is unreachable, drop the local token.
  }
  clearSession(null);
}

export async function decideRemoteGuard(
  event: GuardEvent,
  decision: 'approve' | 'deny',
  pin?: string,
): Promise<GuardEvent> {
  const result = await remoteDeviceApi.decide(event.id, {
    decision,
    nonce: event.approvalNonce ?? '',
    sessionId: event.sessionId,
    ...(pin ? { pin } : {}),
  });
  const index = remoteState.guards.findIndex((item) => item.id === event.id);
  if (index >= 0) remoteState.guards[index] = result.event;
  void refreshRemote();
  return result.event;
}

export async function sendRemotePrompt(
  sessionId: string,
  text: string,
): Promise<{ status: string; message?: string }> {
  const result = await remoteDeviceApi.prompt(sessionId, text);
  void refreshRemote();
  return result;
}
