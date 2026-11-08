import type {
  AdapterList,
  AgentEvent,
  AgentOutput,
  AgentSession,
  ApprovalDecision,
  DemoSeedResponse,
  GuardEvent,
  GuardRule,
  Health,
  Overview,
  RemoteAuditResponse,
  RemoteClaimPoll,
  RemoteClaimTicket,
  RemoteDevice,
  RemoteEndpointScope,
  RemoteHealth,
  RemoteMode,
  RemoteNotificationStatus,
  RemotePairingCode,
  RemotePendingPairing,
  RemotePendingPrompt,
  RemoteScope,
  RemoteSessionInfo,
  RemoteStatus,
  RemoteTools,
  ReplayResponse,
  Session,
  SessionList,
  SettingsResponse,
  SnapshotDetailResponse,
  StepDetail,
  Step,
} from './types';

declare global {
  interface Window {
    /** Test and development hook: point the UI at another daemon. */
    __cockpitDaemonUrl?: string;
  }
}

const DEV_PORTS = new Set(['5174', '4174']);
const DEFAULT_DAEMON = 'http://127.0.0.1:4319';
const REMOTE_TOKEN_KEY = 'cockpit.remote.token';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Resolve the daemon origin without hiding where the UI is pointed. */
export function daemonOrigin(): string {
  if (typeof window === 'undefined') return DEFAULT_DAEMON;
  const override = window.__cockpitDaemonUrl;
  if (override && override.trim()) return trimTrailingSlash(override.trim());
  const { protocol, hostname, port, origin } = window.location;
  if (DEV_PORTS.has(port) && (hostname === '127.0.0.1' || hostname === 'localhost')) {
    return DEFAULT_DAEMON;
  }
  return trimTrailingSlash(origin);
}

export function liveSocketUrl(replay = 100): string {
  const base = daemonOrigin().replace(/^http/, 'ws');
  return `${base}/api/live?replay=${replay}`;
}

/** The remote listener's live socket. The ticket travels in the subprotocol. */
export function remoteSocketUrl(): string {
  return `${daemonOrigin().replace(/^http/, 'ws')}/api/remote/live`;
}

export class DaemonError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: string | { code?: string; message?: string };
  code?: string;
  message?: string;
}

function readErrorBody(body: ApiErrorBody): { message?: string; code?: string } {
  const { error } = body;
  if (typeof error === 'string') return { message: error, code: body.code };
  if (error && typeof error === 'object') {
    return { message: error.message, code: error.code };
  }
  return { message: body.message, code: body.code };
}

async function requestAt<T>(origin: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${trimTrailingSlash(origin)}/api${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new DaemonError(
      'The Cockpit daemon is not reachable. Start it with `cockpit serve`.',
      0,
      'daemon_unreachable',
    );
  }

  if (!response.ok) {
    let message = `The daemon returned ${response.status}.`;
    let code: string | undefined;
    try {
      const parsed = readErrorBody((await response.json()) as ApiErrorBody);
      if (parsed.message) message = parsed.message;
      code = parsed.code;
    } catch {
      // Keep the status-based message.
    }
    throw new DaemonError(message, response.status, code);
  }

  return (await response.json()) as T;
}

let hostCsrfToken: string | null = null;
let hostCsrfPending: Promise<string> | null = null;

/**
 * The daemon hands its per-process CSRF token only to the UI it serves. Fetch
 * it once per page, and fetch again after a failed call so a daemon restart is
 * recovered without a manual reload.
 */
async function hostCsrf(): Promise<string> {
  if (hostCsrfToken) return hostCsrfToken;
  if (!hostCsrfPending) {
    hostCsrfPending = (async () => {
      const response = await fetch(`${daemonOrigin()}/api/csrf`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new DaemonError(
          'Cockpit could not issue a CSRF token. Reload the page and try again.',
          response.status,
          'csrf_unavailable',
        );
      }
      const body = (await response.json()) as { token?: string };
      if (!body.token) {
        throw new DaemonError(
          'Cockpit did not return a CSRF token. Reload the page and try again.',
          response.status,
          'csrf_unavailable',
        );
      }
      hostCsrfToken = body.token;
      return body.token;
    })().finally(() => {
      hostCsrfPending = null;
    });
  }
  return hostCsrfPending;
}

function isStateChanging(init: RequestInit): boolean {
  const method = (init.method ?? 'GET').toUpperCase();
  return !['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isStateChanging(init)) return requestAt<T>(daemonOrigin(), path, init);
  const token = await hostCsrf();
  try {
    return await requestAt<T>(daemonOrigin(), path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-cockpit-csrf': token,
        ...init.headers,
      },
    });
  } catch (error) {
    // A daemon restart rotates the token. Drop the stale one so the next
    // state-changing call fetches the new token instead of failing forever.
    if (
      error instanceof DaemonError &&
      (error.code === 'csrf_invalid' || error.code === 'csrf_missing')
    ) {
      hostCsrfToken = null;
    }
    throw error;
  }
}

/** The pairing/remote token is shown once and stored only on this device. */
export function remoteToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(REMOTE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setRemoteToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(REMOTE_TOKEN_KEY, token);
    else window.localStorage.removeItem(REMOTE_TOKEN_KEY);
  } catch {
    // Storage can be unavailable in private windows.
  }
}

async function remoteRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = remoteToken();
  return requestAt<T>(daemonOrigin(), path, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
}

/**
 * Probe the origin before the app boots. Only the remote listener answers
 * `/api/remote/health`; the host listener returns a JSON 404 there.
 */
export async function detectRemoteListener(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const origin = daemonOrigin();
  try {
    const response = await fetch(`${origin}/api/remote/health`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as Partial<RemoteHealth>;
    return body.remote === true;
  } catch {
    return false;
  }
}

export const daemonApi = {
  health: () => request<Health>('/health'),
  overview: () => request<Overview>('/overview'),
  sessions: (limit = 50) => request<SessionList>(`/sessions?limit=${limit}`),
  session: (id: string) => request<Session>(`/sessions/${encodeURIComponent(id)}`),
  steps: (id: string) =>
    request<{ steps: Step[] }>(`/sessions/${encodeURIComponent(id)}/steps`),
  step: (id: string) => request<StepDetail>(`/steps/${encodeURIComponent(id)}`),
  replay: (id: string) => request<ReplayResponse>(`/sessions/${encodeURIComponent(id)}/replay`),
  snapshot: (id: string) =>
    request<SnapshotDetailResponse>(`/snapshots/${encodeURIComponent(id)}`),
  guards: (status?: string) =>
    request<{ events: GuardEvent[] }>(
      `/guards/events?limit=100${status ? `&status=${encodeURIComponent(status)}` : ''}`,
    ),
  decide: (id: string, decision: ApprovalDecision) =>
    request<{ event: GuardEvent }>(`/guards/events/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body: JSON.stringify(decision),
    }),
  rules: () => request<{ rules: GuardRule[] }>('/guards/rules'),
  adapters: () => request<AdapterList>('/adapters'),
  settings: () => request<SettingsResponse>('/settings'),
  updateSettings: (patch: Record<string, string>) =>
    request<SettingsResponse>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  seedDemo: () => request<DemoSeedResponse>('/demo/seed', { method: 'POST' }),
  agents: () => request<{ sessions: AgentSession[] }>('/agents'),
  agent: (id: string) =>
    request<AgentOutput>(`/agents/${encodeURIComponent(id)}`),
  agentInput: (id: string, data: string) =>
    request<{ sequence: number }>(`/agents/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),
  agentEvents: (status?: string) =>
    request<{ events: AgentEvent[]; openCount: number }>(
      `/agent-events?limit=200${status ? `&status=${encodeURIComponent(status)}` : ''}`,
    ),
  ackAgentEvent: (id: string) =>
    request<{ event: AgentEvent }>(`/agent-events/${encodeURIComponent(id)}/ack`, {
      method: 'POST',
    }),
};

/**
 * Host-only remote access management. These calls only exist on the loopback
 * listener; the remote listener returns 404 for every one of them.
 */
export const remoteApi = {
  status: () => request<RemoteStatus>('/remote/status'),
  enable: (mode: Exclude<RemoteMode, 'loopback'>, publicUrl?: string) =>
    request<RemoteStatus>('/remote/enable', {
      method: 'POST',
      body: JSON.stringify({ mode, ...(publicUrl ? { publicUrl } : {}) }),
    }),
  disable: () => request<RemoteStatus>('/remote/disable', { method: 'POST' }),
  panic: () =>
    request<{ stopped: boolean; revokedDevices: number; status: RemoteStatus }>('/remote/panic', {
      method: 'POST',
    }),
  pairCode: () => request<RemotePairingCode>('/remote/pair/code', { method: 'POST' }),
  pendingPairings: () =>
    request<{ pairings: RemotePendingPairing[] }>('/remote/pair/pending'),
  confirmPairing: (id: string, verificationCode: string) =>
    request<{ pairing: { deviceId: string; deviceName: string; createdAt: string } }>(
      `/remote/pair/pending/${encodeURIComponent(id)}/confirm`,
      { method: 'POST', body: JSON.stringify({ verificationCode }) },
    ),
  denyPairing: (id: string) =>
    request<{ denied: boolean }>(`/remote/pair/pending/${encodeURIComponent(id)}/deny`, {
      method: 'POST',
    }),
  devices: () => request<{ devices: RemoteDevice[] }>('/remote/devices'),
  updateDevice: (
    id: string,
    patch: { scopes?: RemoteScope[]; requireHostConfirmation?: boolean },
  ) =>
    request<{ device: RemoteDevice }>(`/remote/devices/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  revokeDevice: (id: string) =>
    request<{ revoked: boolean }>(`/remote/devices/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    }),
  resetRespond: (id: string) =>
    request<{ device: RemoteDevice }>(
      `/remote/devices/${encodeURIComponent(id)}/reset-respond`,
      { method: 'POST' },
    ),
  rotateDevice: (id: string) =>
    request<{ token: string; device: RemoteDevice; note: string }>(
      `/remote/devices/${encodeURIComponent(id)}/rotate`,
      { method: 'POST' },
    ),
  audit: (limit = 100, offset = 0) =>
    request<RemoteAuditResponse>(`/remote/audit?limit=${limit}&offset=${offset}`),
  auditExportUrl: () => `${daemonOrigin()}/api/remote/audit/export`,
  prompts: () => request<{ prompts: RemotePendingPrompt[] }>('/remote/prompts'),
  approvePrompt: (id: string) =>
    request<{ sent: boolean; sequence?: number; promptId: string }>(
      `/remote/prompts/${encodeURIComponent(id)}/approve`,
      { method: 'POST' },
    ),
  denyPrompt: (id: string) =>
    request<{ denied: boolean }>(`/remote/prompts/${encodeURIComponent(id)}/deny`, {
      method: 'POST',
    }),
  tools: () => request<RemoteTools>('/remote/tools'),
  matrix: () => request<{ endpoints: RemoteEndpointScope[] }>('/remote/matrix'),
  notifications: () => request<RemoteNotificationStatus>('/remote/notifications'),
  updateNotifications: (enabled: boolean, server?: string) =>
    request<RemoteNotificationStatus>('/remote/notifications', {
      method: 'PUT',
      body: JSON.stringify({ enabled, ...(server ? { server } : {}) }),
    }),
  testNotification: () =>
    request<{ sent: boolean }>('/remote/notifications/test', { method: 'POST' }),
};

/**
 * The scoped API a paired device talks to. Every call carries the bearer token
 * in the Authorization header; no token ever appears in a URL.
 */
export const remoteDeviceApi = {
  claim: (code: string, deviceName: string, pin: string | undefined, verificationCode: string) =>
    requestAt<RemoteClaimTicket>(daemonOrigin(), '/remote/pair/claim', {
      method: 'POST',
      body: JSON.stringify({
        code,
        deviceName,
        verificationCode,
        ...(pin ? { pin } : {}),
      }),
    }),
  pollClaim: (id: string, secret: string) =>
    requestAt<RemoteClaimPoll>(
      daemonOrigin(),
      `/remote/pair/claim/${encodeURIComponent(id)}`,
      { method: 'POST', headers: { 'x-pairing-secret': secret } },
    ),
  session: () => remoteRequest<RemoteSessionInfo>('/remote/session'),
  overview: () => remoteRequest<Overview>('/remote/overview'),
  sessions: (limit = 50) => remoteRequest<SessionList>(`/remote/sessions?limit=${limit}`),
  sessionDetail: (id: string) =>
    remoteRequest<Session>(`/remote/sessions/${encodeURIComponent(id)}`),
  steps: (id: string) =>
    remoteRequest<{ steps: Step[] }>(`/remote/sessions/${encodeURIComponent(id)}/steps`),
  guards: (status?: string) =>
    remoteRequest<{ events: GuardEvent[] }>(
      `/remote/guards/events?limit=100${status ? `&status=${encodeURIComponent(status)}` : ''}`,
    ),
  decide: (
    id: string,
    input: { decision: 'approve' | 'deny'; nonce: string; sessionId: string; pin?: string },
  ) =>
    remoteRequest<{ event: GuardEvent }>(
      `/remote/guards/events/${encodeURIComponent(id)}/decision`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  agents: () => remoteRequest<{ sessions: AgentSession[] }>('/remote/agents'),
  agent: (id: string) => remoteRequest<AgentOutput>(`/remote/agents/${encodeURIComponent(id)}`),
  prompt: (id: string, text: string) =>
    remoteRequest<{ status: string; promptId: string; message?: string; sequence?: number }>(
      `/remote/agents/${encodeURIComponent(id)}/prompt`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),
  agentEvents: () =>
    remoteRequest<{ events: AgentEvent[]; openCount: number }>('/remote/agent-events?limit=200'),
  wsTicket: () =>
    remoteRequest<{ ticket: string; expiresInSeconds: number; protocol: string }>(
      '/remote/ws-ticket',
      { method: 'POST' },
    ),
  logout: () => remoteRequest<{ revoked: boolean }>('/remote/logout', { method: 'POST' }),
};
