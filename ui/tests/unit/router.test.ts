import { describe, expect, it } from 'vitest';
import { ROUTES, normalizePath, routeLabel } from '../../src/lib/router';

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

describe('routeLabel', () => {
  it('labels every route for the window title', () => {
    expect(routeLabel('/')).toBe('Home');
    expect(routeLabel('/inbox')).toBe('Inbox');
    expect(routeLabel('/flights')).toBe('Flights');
    expect(routeLabel('/market')).toBe('Market');
    expect(routeLabel('/settings')).toBe('Settings');
    expect(routeLabel('/welcome')).toBe('Welcome');
    expect(routeLabel('/glass-preview')).toBe('Glass preview');
  });
});
