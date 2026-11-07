import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, Hono } from 'hono';

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function hasIndex(directory: string): boolean {
  return existsSync(path.join(directory, 'index.html'));
}

/**
 * Find the built dashboard. The order covers a bundled CLI (`dist/web`), a
 * daemon build (`dist/web`), and the development checkout (`apps/web/dist`).
 */
export function resolveWebRoot(
  env: NodeJS.ProcessEnv = process.env,
  startDirectory = path.dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  const explicit = env['COCKPIT_WEB_ROOT'];
  if (explicit !== undefined && explicit.trim().length > 0) {
    const resolved = path.resolve(explicit);
    return hasIndex(resolved) ? resolved : undefined;
  }

  let current = path.resolve(startDirectory);
  for (;;) {
    for (const candidate of [
      path.join(current, 'web'),
      path.join(current, 'apps', 'web', 'dist'),
    ]) {
      if (hasIndex(candidate)) return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function applyDashboardHeaders(c: Context, cacheControl: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(name, value);
  }
  c.header('cache-control', cacheControl);
}

function dashboardFile(root: string, cacheControl: string, filePath?: string) {
  return serveStatic({
    root,
    ...(filePath === undefined ? {} : { path: filePath }),
    onFound: (_foundPath, c) => {
      applyDashboardHeaders(c, cacheControl);
    },
  });
}

/** Client-side routes that all resolve to the dashboard's index.html. */
const SPA_ROUTES = [
  '/',
  '/sessions',
  '/sessions/*',
  '/guards',
  '/debt',
  '/understanding/*',
  '/analytics',
  '/brain',
  '/arena',
  '/journal',
  '/plugins',
  '/pair',
] as const;

export function mountDashboard(app: Hono, webRoot: string): void {
  const index = dashboardFile(webRoot, 'no-store', 'index.html');

  for (const route of SPA_ROUTES) {
    app.get(route, index);
  }

  app.get('/assets/*', dashboardFile(webRoot, 'public, max-age=31536000, immutable'));
  app.get('/favicon.svg', dashboardFile(webRoot, 'public, max-age=86400'));
  app.get('/robots.txt', dashboardFile(webRoot, 'public, max-age=86400'));
}

function renderDashboardMissingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Cockpit dashboard is not built</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #080b0f;
        color: #e8eef4;
        font: 16px/1.6 "Segoe UI", system-ui, sans-serif;
      }
      main { max-width: 42rem; padding: 3rem; }
      .eyebrow { color: #f3a712; font: 600 11px/1.4 Consolas, monospace; letter-spacing: .14em; text-transform: uppercase; }
      h1 { font-size: clamp(2rem, 6vw, 3.5rem); line-height: 1.05; margin: 1rem 0; letter-spacing: -.04em; }
      p { color: #a9b8c6; }
      code { display: block; margin-top: 1.5rem; padding: 1rem 1.25rem; border: 1px solid #24313d; background: #111820; color: #f3a712; font-family: Consolas, monospace; overflow-x: auto; }
      a { color: #f3a712; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Cockpit · dashboard</div>
      <h1>The dashboard has not been built yet.</h1>
      <p>The daemon and recording API are running, but the static dashboard bundle is missing.</p>
      <code>pnpm --filter @cockpit/web build</code>
      <p>Reload this page after the build finishes. API health remains available at <a href="/api/health">/api/health</a>.</p>
    </main>
  </body>
</html>`;
}

export function mountDashboardFallback(app: Hono): void {
  const respond = (c: Context): Response => {
    applyDashboardHeaders(c, 'no-store');
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(renderDashboardMissingPage(), 200);
  };

  for (const route of SPA_ROUTES) {
    app.get(route, respond);
  }
}
