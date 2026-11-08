import { resolveRoute, type RoutePath } from './router';

const production = import.meta.env.PROD;
const initial = resolveRoute(`${window.location.pathname}${window.location.search}`, {
  production,
});

export const routeState = $state<{ path: RoutePath; search: string }>({
  path: initial.path,
  search: initial.search,
});

/**
 * Navigate without a reload. A query on the target wins; otherwise the current
 * query is preserved so deep links like `?session=<id>` survive a tab change.
 */
export function navigate(
  target: string,
  options: { replace?: boolean; keepSearch?: boolean } = {},
): void {
  const keepSearch = options.keepSearch ?? true;
  const hasQuery = target.includes('?');
  const input =
    hasQuery || !keepSearch ? target : `${target}${window.location.search}`;
  const resolved = resolveRoute(input, { production });
  const url = `${resolved.path}${resolved.search}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (url !== current) {
    if (options.replace) {
      window.history.replaceState({}, '', url);
    } else {
      window.history.pushState({}, '', url);
    }
  }
  routeState.path = resolved.path;
  routeState.search = resolved.search;
  document.querySelector<HTMLElement>('.panel')?.scrollTo({ top: 0, behavior: 'instant' });
}

/** Read one query parameter from the current route. */
export function routeParam(name: string): string | null {
  return new URLSearchParams(routeState.search).get(name);
}

/** Intercept same-origin route links and keep back/forward working. */
export function initRouter(): () => void {
  const onClick = (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>('a[data-route]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('//')) return;
    event.preventDefault();
    navigate(href);
  };

  const onPopState = (): void => {
    const next = resolveRoute(`${window.location.pathname}${window.location.search}`, {
      production,
    });
    routeState.path = next.path;
    routeState.search = next.search;
  };

  document.addEventListener('click', onClick);
  window.addEventListener('popstate', onPopState);
  return () => {
    document.removeEventListener('click', onClick);
    window.removeEventListener('popstate', onPopState);
  };
}
