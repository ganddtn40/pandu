import { storageKey } from './brand';

export const ONBOARDED_KEY = storageKey('onboarded');

export const onboardingState = $state<{ open: boolean; step: number }>({
  open: false,
  step: 0,
});

export function isOnboarded(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function openOnboarding(): void {
  onboardingState.step = 0;
  onboardingState.open = true;
}

export function closeOnboarding(): void {
  onboardingState.open = false;
}

export function completeOnboarding(): void {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    // Storage is optional; the tour still closes.
  }
  onboardingState.open = false;
}
