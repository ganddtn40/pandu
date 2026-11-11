import { navigate } from './router.svelte';
import { URL_SCHEME } from './brand';
import { invoke } from './tauri';

/** The native shell bridge injected before the UI bundle boots. */
export interface DesktopBridge {
  mode: 'desktop';
  platform: string;
  openExternal(url: string): Promise<boolean>;
  takeDeepLink(): Promise<string | null>;
  setAutostart(enabled: boolean): Promise<boolean>;
  autostartEnabled(): Promise<boolean>;
}

export interface DesktopInfo {
  origin: string;
  version: string;
  platform: string;
  autostart: boolean;
  attached: boolean;
}

declare global {
  interface Window {
    __panduDesktop?: DesktopBridge;
  }
}

/** The native bridge, or `null` in a normal browser and in the PWA. */
export function desktop(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.__panduDesktop ?? null;
}

export function isDesktop(): boolean {
  return desktop() !== null;
}

let listening = false;

/**
 * Listen for deep links and deliver one that arrived while the app was closed.
 *
 * Returns the route that was opened, if any, so the caller can skip the
 * first-run redirect for a link the user explicitly chose.
 */
export async function initDesktop(): Promise<string | null> {
  const bridge = desktop();
  if (!bridge) return null;
  if (!listening) {
    listening = true;
    window.addEventListener(`${URL_SCHEME}:deep-link`, () => {
      void consumeDeepLink();
    });
  }
  return consumeDeepLink();
}

async function consumeDeepLink(): Promise<string | null> {
  const bridge = desktop();
  if (!bridge) return null;
  try {
    const route = await bridge.takeDeepLink();
    if (route) navigate(route, { keepSearch: false });
    return route;
  } catch {
    // A malformed link is refused in Rust; never break the running app.
    return null;
  }
}

/** Ask the shell to confirm and open an HTTPS link in the system browser. */
export async function openExternal(url: string): Promise<boolean> {
  const bridge = desktop();
  if (bridge) return bridge.openExternal(url);
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol !== 'https:') return false;
    window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}

export async function desktopInfo(): Promise<DesktopInfo | null> {
  if (!desktop()) return null;
  try {
    return await invoke<DesktopInfo>('desktop_info');
  } catch {
    return null;
  }
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  const bridge = desktop();
  if (!bridge) return false;
  return bridge.setAutostart(enabled);
}
