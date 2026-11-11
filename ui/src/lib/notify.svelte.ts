import type { AgentEventType } from './api/types';
import { agentEventKey } from './agent-events';
import { t } from './i18n/i18n.svelte';
import { toast } from './toast-store.svelte';

import { SLUG, storageKey } from './brand';

const IN_APP_KEY = storageKey('notify.inApp');
const WEB_KEY = storageKey('notify.web');
const UPDATE_NOTIFIED_KEY = storageKey('update.notified');

export type WebPermission = NotificationPermission | 'unsupported';

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const value = window.localStorage.getItem(key);
    if (value === null) return fallback;
    return value === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // A blocked storage area only means the preference is per-session.
  }
}

function currentPermission(): WebPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission;
}

export const notifyState = $state<{
  inApp: boolean;
  web: boolean;
  webPermission: WebPermission;
}>({
  inApp: readFlag(IN_APP_KEY, true),
  web: readFlag(WEB_KEY, false),
  webPermission: currentPermission(),
});

export function setInAppNotifications(enabled: boolean): void {
  notifyState.inApp = enabled;
  writeFlag(IN_APP_KEY, enabled);
}

/**
 * Ask the browser for notification permission only when the user turns the
 * preference on. A blocked or unsupported browser is reported honestly rather
 * than silently pretending the toggle works.
 */
export async function setWebNotifications(enabled: boolean): Promise<void> {
  if (!enabled) {
    notifyState.web = false;
    writeFlag(WEB_KEY, false);
    return;
  }
  const permission = currentPermission();
  notifyState.webPermission = permission;
  if (permission === 'unsupported') {
    notifyState.web = false;
    writeFlag(WEB_KEY, false);
    return;
  }
  if (permission === 'default') {
    try {
      notifyState.webPermission = await window.Notification.requestPermission();
    } catch {
      notifyState.webPermission = currentPermission();
    }
  }
  notifyState.web = notifyState.webPermission === 'granted';
  writeFlag(WEB_KEY, notifyState.web);
}

export function refreshWebPermission(): void {
  notifyState.webPermission = currentPermission();
  if (notifyState.webPermission !== 'granted' && notifyState.web) {
    notifyState.web = false;
    writeFlag(WEB_KEY, false);
  }
}

function updateAlreadyNotified(version: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(UPDATE_NOTIFIED_KEY) === version;
  } catch {
    return false;
  }
}

function markUpdateNotified(version: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UPDATE_NOTIFIED_KEY, version);
  } catch {
    // A blocked storage area only means the dedupe is per-session.
  }
}

/**
 * Tell the user once per version that a verified update is available. The
 * daemon has already sanitized the release notes; this only carries the
 * version and a short summary, never a URL or a file name.
 */
export function notifyUpdateAvailable(event: {
  version: string;
  notesSummary?: string;
}): void {
  if (updateAlreadyNotified(event.version)) return;
  markUpdateNotified(event.version);
  const label = t('update.notificationTitle', { version: event.version });
  if (notifyState.inApp) {
    toast(event.notesSummary ? `${label} · ${event.notesSummary}` : label);
  }
  if (
    notifyState.web &&
    notifyState.webPermission === 'granted' &&
    typeof document !== 'undefined' &&
    document.hidden
  ) {
    try {
      new window.Notification(label, {
        body: event.notesSummary || t('update.notificationBody'),
        tag: `${SLUG}:update:${event.version}`,
      });
    } catch {
      // A browser that rejects the notification must not break the app.
    }
  }
}

/**
 * Show one notification for an agent event. The payload is deliberately
 * limited to the event type, agent name, and project name; see docs/security.md.
 */
export function notifyAgentEvent(event: {
  type: AgentEventType;
  agentName: string;
  projectName: string;
}): void {
  const label = t(agentEventKey(event.type));
  if (notifyState.inApp) {
    toast(`${label} · ${event.agentName} · ${event.projectName}`);
  }
  if (
    notifyState.web &&
    notifyState.webPermission === 'granted' &&
    typeof document !== 'undefined' &&
    document.hidden
  ) {
    try {
      new window.Notification(label, {
        body: `${event.agentName} · ${event.projectName}`,
        tag: `pandu:${event.agentName}:${event.projectName}:${event.type}`,
      });
    } catch {
      // A browser that rejects the notification must not break the app.
    }
  }
}
