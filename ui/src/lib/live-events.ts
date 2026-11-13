import type { MessageKey } from './i18n/catalog';

/**
 * The daemon sends live event types as dotted strings. They are stable, but
 * they are not sentences, so the UI maps them to catalog keys instead of
 * showing `agent.needs_you` to a person.
 */
const LIVE_EVENT_KEYS: Record<string, MessageKey> = {
  'agent.started': 'live.started',
  'agent.output': 'live.output',
  'agent.needs_you': 'live.needsYou',
  'agent.awaiting_prompt': 'live.awaitingPrompt',
  'agent.ended': 'live.ended',
  'agent.event': 'live.event',
  'agent.event.acknowledged': 'live.acknowledged',
  'tool.completed': 'live.toolCompleted',
};

export function liveEventKey(type: string): MessageKey {
  return LIVE_EVENT_KEYS[type] ?? 'live.activity';
}
