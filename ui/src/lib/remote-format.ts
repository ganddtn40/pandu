import type { MessageKey } from './i18n/catalog';
import type { GuardEvent, RemoteMode, RemoteScope } from './api/types';

export function remoteModeKey(mode: RemoteMode): MessageKey {
  switch (mode) {
    case 'tailscale':
      return 'remote.modeTailscale';
    case 'tunnel':
      return 'remote.modeTunnel';
    case 'lan':
      return 'remote.modeLan';
    default:
      return 'remote.off';
  }
}

export function remoteScopeKey(scope: RemoteScope): MessageKey {
  switch (scope) {
    case 'respond':
      return 'remote.scopeRespond';
    case 'prompt':
      return 'remote.scopePrompt';
    default:
      return 'remote.scopeView';
  }
}

export function remoteScopeNoteKey(scope: RemoteScope): MessageKey {
  switch (scope) {
    case 'respond':
      return 'remote.scopeRespondNote';
    case 'prompt':
      return 'remote.scopePromptNote';
    default:
      return 'remote.scopeViewNote';
  }
}

/** Group audit rows without translating every daemon event name. */
export function remoteAuditKindKey(event: string): MessageKey {
  if (event.startsWith('pair.')) return 'remote.auditKindPairing';
  if (event.startsWith('device.')) return 'remote.auditKindDevice';
  if (event.startsWith('approval.')) return 'remote.auditKindApproval';
  if (event.startsWith('prompt.')) return 'remote.auditKindPrompt';
  if (event.startsWith('remote.')) return 'remote.auditKindRemote';
  if (event.startsWith('auth.')) return 'remote.auditKindAuth';
  if (event.startsWith('notification.')) return 'remote.auditKindNotification';
  return 'remote.auditKindOther';
}

/**
 * The daemon refuses auth/login prompts from remote devices. The UI mirrors
 * that rule so the card explains it before a device tries to answer.
 */
export function isAuthPrompt(event: GuardEvent): boolean {
  const text = [
    event.title,
    event.description,
    event.ruleId,
    event.command ?? '',
    ...event.evidence.map((entry) => entry.excerpt ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  return [
    'password',
    'passcode',
    '2fa',
    'two-factor',
    'one-time code',
    'login',
    'log in',
    'sign in',
    'authenticate',
    'authentication',
  ].some((needle) => text.includes(needle));
}

export function isHighRisk(event: GuardEvent): boolean {
  return (
    event.severity === 'high' ||
    event.severity === 'critical' ||
    event.kind === 'dangerous_command'
  );
}
