export const addAgentState = $state<{ open: boolean }>({ open: false });

export function openAddAgent(): void {
  addAgentState.open = true;
}

export function closeAddAgent(): void {
  addAgentState.open = false;
}
