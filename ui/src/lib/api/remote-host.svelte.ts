import { DaemonError, remoteApi } from './client';
import type {
  RemoteAuditEntry,
  RemoteDevice,
  RemoteEndpointScope,
  RemotePendingPairing,
  RemotePendingPrompt,
  RemoteStatus,
} from './types';

/**
 * Host-only remote access state. Shared by the persistent banner and the
 * Settings card so both stay in sync without two pollers.
 */
export const remoteHostState = $state<{
  status: RemoteStatus | null;
  devices: RemoteDevice[];
  pairings: RemotePendingPairing[];
  prompts: RemotePendingPrompt[];
  audit: RemoteAuditEntry[];
  auditTotal: number;
  matrix: RemoteEndpointScope[];
  loading: boolean;
  error: string | null;
  lastSyncedAt: number | null;
}>({
  status: null,
  devices: [],
  pairings: [],
  prompts: [],
  audit: [],
  auditTotal: 0,
  matrix: [],
  loading: false,
  error: null,
  lastSyncedAt: null,
});

let watchers = 0;
let timer: number | undefined;
let ticking = false;
let tickCount = 0;

export function remoteHostErrorMessage(error: unknown): string {
  if (error instanceof DaemonError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Cockpit could not update remote access.';
}

export async function refreshRemoteStatus(): Promise<void> {
  try {
    remoteHostState.status = await remoteApi.status();
    remoteHostState.error = null;
  } catch (error) {
    remoteHostState.error = remoteHostErrorMessage(error);
  }
}

/** Pull the host view. Audit rows are opt-in so the banner stays cheap. */
export async function refreshRemoteHost(
  options: { audit?: boolean; matrix?: boolean } = {},
): Promise<void> {
  if (ticking) return;
  ticking = true;
  remoteHostState.loading = remoteHostState.status === null;
  try {
    const status = await remoteApi.status();
    remoteHostState.status = status;
    remoteHostState.error = null;

    if (!status.enabled) {
      remoteHostState.devices = [];
      remoteHostState.pairings = [];
      remoteHostState.prompts = [];
      remoteHostState.lastSyncedAt = Date.now();
      return;
    }

    const tasks: Array<Promise<unknown>> = [
      remoteApi.devices().then((result) => {
        remoteHostState.devices = result.devices;
      }),
      remoteApi.pendingPairings().then((result) => {
        remoteHostState.pairings = result.pairings;
      }),
      remoteApi.prompts().then((result) => {
        remoteHostState.prompts = result.prompts;
      }),
    ];
    if (options.audit) {
      tasks.push(
        remoteApi.audit(100, 0).then((result) => {
          remoteHostState.audit = result.entries;
          remoteHostState.auditTotal = result.total;
        }),
      );
    }
    if (options.matrix || remoteHostState.matrix.length === 0) {
      tasks.push(
        remoteApi.matrix().then((result) => {
          remoteHostState.matrix = result.endpoints;
        }),
      );
    }
    await Promise.allSettled(tasks);
    remoteHostState.lastSyncedAt = Date.now();
  } catch (error) {
    remoteHostState.error = remoteHostErrorMessage(error);
  } finally {
    remoteHostState.loading = false;
    ticking = false;
  }
}

async function tick(): Promise<void> {
  tickCount += 1;
  await refreshRemoteHost({ audit: tickCount % 4 === 0 });
}

/**
 * Start the host watcher. The banner and the Settings card can both ask for a
 * watcher; the poller stops when the last one unsubscribes.
 */
export function startRemoteHostWatch(): () => void {
  if (typeof window === 'undefined') return () => {};
  watchers += 1;
  if (watchers === 1) {
    void tick();
    timer = window.setInterval(() => {
      if (!document.hidden) void tick();
    }, 5_000);
  }
  return () => {
    watchers = Math.max(0, watchers - 1);
    if (watchers === 0 && timer) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}
