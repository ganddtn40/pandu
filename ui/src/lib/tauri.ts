/** The tiny slice of the Tauri IPC surface the companion uses. */
export interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export function tauri(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI_INTERNALS__ ?? null;
}

export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const internals = tauri();
  if (!internals) throw new Error('The native bridge is unavailable.');
  return internals.invoke<T>(command, args);
}
