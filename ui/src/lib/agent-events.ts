import type { AgentEventType } from './api/types';
import type { MessageKey } from './i18n/catalog';

const EVENT_KEYS: Record<AgentEventType, MessageKey> = {
  'agent.started': 'event.agent.started',
  done: 'event.done',
  permission: 'event.permission',
  question: 'event.question',
  choice: 'event.choice',
  auth_required: 'event.auth_required',
  error: 'event.error',
  stuck: 'event.stuck',
  'budget.warn': 'event.budget.warn',
  'context.high': 'event.context.high',
};

export function agentEventKey(type: AgentEventType): MessageKey {
  return EVENT_KEYS[type] ?? 'event.agent.started';
}

/** Events that genuinely wait for a human at the computer. */
export function agentEventNeedsYou(type: AgentEventType): boolean {
  return (
    type === 'permission' ||
    type === 'question' ||
    type === 'choice' ||
    type === 'auth_required' ||
    type === 'stuck'
  );
}

/**
 * Open events that belong in the Inbox count. Finished and informational
 * signals stay visible in the list without claiming the user's attention.
 */
export function agentEventIsAttention(type: AgentEventType): boolean {
  return agentEventNeedsYou(type) || type === 'error';
}

/** Status pill tone for an event type. */
export function agentEventTone(type: AgentEventType): string {
  if (type === 'error') return 'status-pill--danger';
  if (type === 'done') return 'status-pill--ok';
  if (type === 'budget.warn' || type === 'context.high') return 'status-pill--warn';
  if (type === 'auth_required') return 'status-pill--warn';
  if (agentEventNeedsYou(type)) return 'status-pill--accent';
  return '';
}
