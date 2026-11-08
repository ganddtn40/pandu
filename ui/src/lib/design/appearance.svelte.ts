export const appearanceState = $state<{ open: boolean }>({ open: false });

export function openAppearance(): void {
  appearanceState.open = true;
}

export function closeAppearance(): void {
  appearanceState.open = false;
}

export function toggleAppearance(): void {
  appearanceState.open = !appearanceState.open;
}
