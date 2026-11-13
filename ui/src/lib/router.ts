import { SLUG } from './brand';
import type { MessageKey } from './i18n/catalog';

export const ROUTES = [
  '/',
  '/inbox',
  '/flights',
  '/market',
  '/settings',
  '/session',
  '/welcome',
  '/glass-preview',
] as const;

export type RoutePath = (typeof ROUTES)[number];

/** Renderer diagnostics are only reachable in development builds. */
export const DEV_ONLY_ROUTES: readonly RoutePath[] = ['/glass-preview'];

const ALIASES: Record<string, RoutePath> = {
  '/home': '/',
  '/approvals': '/inbox',
};

export interface RouteLocation {
  path: RoutePath;
  search: string;
}

/** Normalize a browser pathname to a known route. Unknown paths go home. */
export function normalizePath(pathname: string): RoutePath {
  const clean = pathname.split('?')[0]?.split('#')[0]?.replace(/\/+$/, '') || '/';
  if ((ROUTES as readonly string[]).includes(clean)) return clean as RoutePath;
  return ALIASES[clean] ?? '/';
}

export function isDevOnlyRoute(path: RoutePath): boolean {
  return DEV_ONLY_ROUTES.includes(path);
}

/** Resolve a path and its query, hiding developer-only routes in production. */
export function resolveRoute(
  input: string,
  options: { production?: boolean } = {},
): RouteLocation {
  let pathname = input;
  let search = '';
  try {
    const url = new URL(input, `http://${SLUG}.local`);
    pathname = url.pathname;
    search = url.search;
  } catch {
    // Fall back to treating the input as a path.
  }
  const path = normalizePath(pathname);
  if (options.production && isDevOnlyRoute(path)) {
    return { path: '/', search: '' };
  }
  return { path, search };
}

/** The catalog key for a route name, so the window title follows the language. */
export function routeLabel(path: RoutePath): MessageKey {
  switch (path) {
    case '/inbox':
      return 'nav.inbox';
    case '/flights':
      return 'nav.flights';
    case '/market':
      return 'nav.market';
    case '/settings':
      return 'nav.settings';
    case '/session':
      return 'session.kicker';
    case '/welcome':
      return 'route.welcome';
    case '/glass-preview':
      return 'route.glassPreview';
    default:
      return 'nav.home';
  }
}
