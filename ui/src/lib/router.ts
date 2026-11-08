export const ROUTES = [
  '/',
  '/inbox',
  '/flights',
  '/market',
  '/settings',
  '/welcome',
  '/glass-preview',
] as const;

export type RoutePath = (typeof ROUTES)[number];

const ALIASES: Record<string, RoutePath> = {
  '/home': '/',
  '/approvals': '/inbox',
};

/** Normalize a browser pathname to a known route. Unknown paths go home. */
export function normalizePath(pathname: string): RoutePath {
  const clean = pathname.split('?')[0]?.split('#')[0]?.replace(/\/+$/, '') || '/';
  if ((ROUTES as readonly string[]).includes(clean)) return clean as RoutePath;
  return ALIASES[clean] ?? '/';
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
    case '/welcome':
      return 'Welcome';
    case '/glass-preview':
      return 'Glass preview';
    default:
      return 'Home';
  }
}
