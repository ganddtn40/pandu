import { normalizePath, type RoutePath } from './router';

export const routeState = $state<{ path: RoutePath }>({
  path: normalizePath(window.location.pathname),
});

export function navigate(path: string): void {
  const next = normalizePath(path);
  if (next !== normalizePath(window.location.pathname)) {
    window.history.pushState({}, '', next);
  }
  routeState.path = next;
  document.querySelector<HTMLElement>('.panel')?.scrollTo({ top: 0, behavior: 'instant' });
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
    routeState.path = normalizePath(window.location.pathname);
  };

  document.addEventListener('click', onClick);
  window.addEventListener('popstate', onPopState);
  return () => {
    document.removeEventListener('click', onClick);
    window.removeEventListener('popstate', onPopState);
  };
}
