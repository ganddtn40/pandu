import { SLUG } from './brand';

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

export function routeLabel(path: RoutePath): string {
  switch (path) {
    case '/inbox':
      return 'Inbox';
    case '/flights':
      return 'Flights';
    case '/market':
      return 'Market';
    case '/settings':
      return 'Settings';
    case '/session':
      return 'Live session';
    case '/welcome':
      return 'Welcome';
    case '/glass-preview':
      return 'Glass preview';
    default:
      return 'Home';
  }
}
