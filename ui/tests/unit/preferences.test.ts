import { describe, expect, it } from 'vitest';
import { readPreferences } from '../../src/lib/preferences';

describe('readPreferences', () => {
  it('uses the glass renderer by default', () => {
    expect(readPreferences('', false)).toEqual({ performance: false, forceFallback: false });
  });

  it('honors the ?glass=off override', () => {
    expect(readPreferences('?glass=off', false)).toEqual({
      performance: false,
      forceFallback: true,
    });
  });

  it('honors the stored performance preference', () => {
    expect(readPreferences('', true)).toEqual({ performance: true, forceFallback: true });
  });

  it('honors the ?perf=1 override and clears nothing else', () => {
    expect(readPreferences('?perf=1', false)).toEqual({ performance: true, forceFallback: true });
    expect(readPreferences('?perf=0', false)).toEqual({ performance: false, forceFallback: false });
  });

  it('does not force the fallback for unrelated query strings', () => {
    expect(readPreferences('?theme=light', false)).toEqual({
      performance: false,
      forceFallback: false,
    });
  });
});
