import { designState } from '../design/design.svelte';
import { translate, type MessageKey } from './catalog';

export { translate };
export type { MessageKey };

/** Reactive translation: reading designState keeps the template in sync. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(designState.value.language, key, vars);
}
