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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${daemonOrigin()}/api${path}`, {
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
      const body = (await response.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      code = body.code;
    } catch {
      // Keep the status-based message.
    }
    throw new DaemonError(message, response.status, code);
  }

  return (await response.json()) as T;
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
