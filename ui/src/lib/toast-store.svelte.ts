let timer: ReturnType<typeof setTimeout> | undefined;

export const toastState = $state<{ message: string; id: number }>({
  message: '',
  id: 0,
});

export function toast(message: string): void {
  toastState.message = message;
  toastState.id += 1;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    toastState.message = '';
  }, 3400);
}
