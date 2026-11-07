import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveCockpitPaths } from '../src/config.js';

describe('resolveCockpitPaths', () => {
  it('uses an absolute deterministic default home', () => {
    const paths = resolveCockpitPaths({});
    expect(path.isAbsolute(paths.home)).toBe(true);
    expect(paths.databasePath.endsWith('cockpit.db')).toBe(true);
    expect(paths.snapshotsDirectory.endsWith('snapshots')).toBe(true);
  });

  it('honors COCKPIT_HOME and resolves relative paths', () => {
    const paths = resolveCockpitPaths({ COCKPIT_HOME: '.cockpit-test' });
    expect(path.isAbsolute(paths.home)).toBe(true);
    expect(paths.home.endsWith('.cockpit-test')).toBe(true);
    expect(paths.databasePath).toBe(path.join(paths.home, 'cockpit.db'));
  });

  it('falls back to the default home for an empty COCKPIT_HOME value', () => {
    const empty = resolveCockpitPaths({ COCKPIT_HOME: '  ' });
    const fallback = resolveCockpitPaths({});
    expect(empty.home).toBe(fallback.home);
  });
});
