/**
 * PWA plumbing. The service worker caches the app shell only: API responses,
 * flights, sessions and live streams are never stored.
 */

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.PROD) return;
  if (window.__panduDesktop) return;
  if (!('serviceWorker' in navigator)) return;
  const { protocol, hostname } = window.location;
  const secure = protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
  if (!secure) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // An unavailable worker must not change how the app works.
    });
  });
}

export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
