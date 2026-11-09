let timer: ReturnType<typeof setTimeout> | undefined;

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 3400;

export const toastState = $state<{
  message: string;
  id: number;
  action: ToastAction | null;
}>({
  message: '',
  id: 0,
  action: null,
});

export function toast(message: string, options: ToastOptions = {}): void {
  toastState.message = message;
  toastState.action = options.action ?? null;
  toastState.id += 1;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    dismissToast();
  }, options.durationMs ?? DEFAULT_DURATION_MS);
}

export function dismissToast(): void {
  toastState.message = '';
  toastState.action = null;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}
