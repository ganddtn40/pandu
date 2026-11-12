import { designState } from '../design/design.svelte';
import type { LanguageId } from '../design/types';
import { loadCatalog, translate, type MessageKey } from './catalog';

export { translate };
export type { MessageKey };

/** Bumped when a draft catalog finishes loading so templates re-render. */
export const catalogState = $state<{ revision: number }>({ revision: 0 });

let requested: LanguageId | null = null;

/** Load a draft catalog once. English is already in the main bundle. */
export function ensureCatalog(language: LanguageId): void {
  if (language === 'en' || requested === language) return;
  requested = language;
  void loadCatalog(language).then(() => {
    catalogState.revision += 1;
  });
}

/** Reactive translation: reading state keeps the template in sync. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  catalogState.revision;
  const language = designState.value.language;
  ensureCatalog(language);
  return translate(language, key, vars);
}
