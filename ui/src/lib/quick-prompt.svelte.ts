export const quickPromptState = $state<{ open: boolean }>({ open: false });

export function openQuickPrompt(): void {
  quickPromptState.open = true;
}

export function closeQuickPrompt(): void {
  quickPromptState.open = false;
}
