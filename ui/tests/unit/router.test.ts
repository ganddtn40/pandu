import { describe, expect, it } from 'vitest';
import { ROUTES, normalizePath, resolveRoute, routeLabel } from '../../src/lib/router';

describe('normalizePath', () => {
  it('keeps every declared route', () => {
    for (const route of ROUTES) {
      expect(normalizePath(route)).toBe(route);
    }
  });

  it('normalizes trailing slashes, query strings, and hashes', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/flights/')).toBe('/flights');
    expect(normalizePath('/settings?theme=light')).toBe('/settings');
    expect(normalizePath('/?theme=dark#top')).toBe('/');
  });

  it('resolves the old aliases', () => {
    expect(normalizePath('/home')).toBe('/');
    expect(normalizePath('/approvals')).toBe('/inbox');
  });

  it('falls back to home for unknown routes', () => {
    expect(normalizePath('/settings/extra')).toBe('/');
    expect(normalizePath('/glass-preview/extra')).toBe('/');
    expect(normalizePath('/nope')).toBe('/');
  });

  it('keeps the primary navigation to five tabs', () => {
    const primary = ['/', '/inbox', '/flights', '/market', '/settings'];
    expect(primary).toHaveLength(5);
    for (const route of primary) {
      expect(ROUTES).toContain(route);
    }
  });
});

describe('resolveRoute', () => {
  it('keeps the query so flight deep links survive navigation', () => {
    expect(resolveRoute('/flights?session=abc')).toEqual({
      path: '/flights',
      search: '?session=abc',
    });
  });

  it('resolves aliases and unknown paths to a known route', () => {
    expect(resolveRoute('/approvals?status=pending')).toEqual({
      path: '/inbox',
      search: '?status=pending',
    });
    expect(resolveRoute('/nope?x=1')).toEqual({ path: '/', search: '?x=1' });
  });

  it('hides developer-only routes in production and keeps them in development', () => {
    expect(resolveRoute('/glass-preview')).toEqual({
      path: '/glass-preview',
      search: '',
    });
    expect(resolveRoute('/glass-preview?surface=glass', { production: true })).toEqual({
      path: '/',
      search: '',
    });
  });
});

describe('routeLabel', () => {
  it('labels every route with a catalog key for the window title', () => {
    expect(routeLabel('/')).toBe('nav.home');
    expect(routeLabel('/inbox')).toBe('nav.inbox');
    expect(routeLabel('/flights')).toBe('nav.flights');
    expect(routeLabel('/market')).toBe('nav.market');
    expect(routeLabel('/settings')).toBe('nav.settings');
    expect(routeLabel('/session')).toBe('session.kicker');
    expect(routeLabel('/welcome')).toBe('route.welcome');
    expect(routeLabel('/glass-preview')).toBe('route.glassPreview');
  });
});
