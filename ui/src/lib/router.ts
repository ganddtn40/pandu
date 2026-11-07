export type RoutePath = '/' | '/glass-preview';

/** Normalize a browser pathname to one of the two Phase 4 routes. */
export function normalizePath(pathname: string): RoutePath {
  const clean = pathname.split('?')[0]?.split('#')[0]?.replace(/\/+$/, '') || '/';
  return clean === '/glass-preview' ? '/glass-preview' : '/';
}
