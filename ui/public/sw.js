/**
 * Pandu's app-shell service worker.
 *
 * It caches the HTML, the built JavaScript and CSS, the icons, and the
 * manifest. It never caches API responses, flight content, terminal output,
 * prompts, snapshots, or anything carrying a bearer token. Those requests are
 * left to the network untouched.
 */
const VERSION = 'pandu-shell-v2';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/logo.svg',
  '/logo-small.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isApi(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/remote/') ||
    url.pathname === '/health'
  );
}

function isShellAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    /\.(css|js|mjs|png|svg|ico|webmanifest|woff2?)$/.test(url.pathname)
  );
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const url = new URL(request.url);
    // Only the app shell may replace `/index.html`. The companion is a
    // separate document; caching it here would serve the wrong page offline.
    if (
      url.pathname !== '/companion.html' &&
      !url.pathname.startsWith('/companion/') &&
      response.ok &&
      response.headers.get('content-type')?.includes('text/html')
    ) {
      const cache = await caches.open(VERSION);
      await cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match('/index.html');
    if (cached) return cached;
    throw new Error('offline');
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
      const cache = await caches.open(VERSION);
      await cache.put(request, response.clone());
    }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Bearer tokens and pairing requests never touch a cache.
  if (isApi(url)) return;
  if (request.headers.has('authorization')) return;
  if (request.destination === 'document') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});
