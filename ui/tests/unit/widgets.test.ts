import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WIDGETS,
  WIDGET_IDS,
  moveWidget,
  normalizeWidgets,
  reorderWidget,
  showAllWidgets,
  toggleWidget,
  visibleWidgets,
  type WidgetLayout,
} from '../../src/lib/design/widgets';

describe('normalizeWidgets', () => {
  it('keeps a valid layout untouched', () => {
    expect(normalizeWidgets(DEFAULT_WIDGETS)).toEqual(DEFAULT_WIDGETS);
  });

  it('drops unknown ids and duplicates, then appends missing widgets', () => {
    const layout = normalizeWidgets({
      order: ['spend', 'nope', 'spend', 'live'],
      hidden: ['guards', 'guards', 'bogus'],
    });
    expect(layout.order.slice(0, 2)).toEqual(['spend', 'live']);
    expect(new Set(layout.order)).toEqual(new Set(WIDGET_IDS));
    expect(layout.hidden).toEqual(['guards']);
  });

  it('falls back to the default order for untrusted values', () => {
    expect(normalizeWidgets(null)).toEqual(DEFAULT_WIDGETS);
    expect(normalizeWidgets('live')).toEqual(DEFAULT_WIDGETS);
    expect(normalizeWidgets([])).toEqual(DEFAULT_WIDGETS);
    expect(normalizeWidgets({ order: 'live' }).order).toEqual(DEFAULT_WIDGETS.order);
  });

  it('appends a widget added by a newer app version', () => {
    const layout = normalizeWidgets({ order: ['live'], hidden: [] });
    expect(layout.order).toEqual(['live', ...WIDGET_IDS.filter((id) => id !== 'live')]);
  });
});

describe('visibleWidgets', () => {
  it('filters hidden widgets without changing order', () => {
    const layout: WidgetLayout = { order: ['spend', 'live', 'guards'], hidden: ['live'] };
    expect(visibleWidgets(layout)).toEqual(['spend', 'guards']);
  });
});

describe('moveWidget', () => {
  it('moves a widget one step in each direction', () => {
    expect(moveWidget(DEFAULT_WIDGETS, 'spend', -1).order[0]).toBe('spend');
    expect(moveWidget(DEFAULT_WIDGETS, 'live', 1).order[1]).toBe('live');
  });

  it('ignores unknown widgets and edges', () => {
    expect(moveWidget(DEFAULT_WIDGETS, 'live', -1)).toBe(DEFAULT_WIDGETS);
    expect(moveWidget(DEFAULT_WIDGETS, 'agents', 1)).toBe(DEFAULT_WIDGETS);
    expect(moveWidget(DEFAULT_WIDGETS, 'nope' as never, 1)).toBe(DEFAULT_WIDGETS);
  });
});

describe('reorderWidget', () => {
  it('moves a widget in front of another widget', () => {
    const next = reorderWidget(DEFAULT_WIDGETS, 'agents', 'live');
    expect(next.order[0]).toBe('agents');
    expect(next.order[1]).toBe('live');
  });

  it('moves forward correctly too', () => {
    const next = reorderWidget(DEFAULT_WIDGETS, 'live', 'recent');
    expect(next.order.indexOf('live')).toBe(next.order.indexOf('recent') - 1);
  });

  it('is a no-op for the same or unknown widgets', () => {
    expect(reorderWidget(DEFAULT_WIDGETS, 'live', 'live')).toBe(DEFAULT_WIDGETS);
    expect(reorderWidget(DEFAULT_WIDGETS, 'nope' as never, 'live')).toBe(DEFAULT_WIDGETS);
    expect(reorderWidget(DEFAULT_WIDGETS, 'live', 'nope' as never)).toBe(DEFAULT_WIDGETS);
  });
});

describe('hide and reset', () => {
  it('toggles a widget hidden and back', () => {
    const hidden = toggleWidget(DEFAULT_WIDGETS, 'spend');
    expect(hidden.hidden).toContain('spend');
    expect(toggleWidget(hidden, 'spend').hidden).not.toContain('spend');
  });

  it('shows every widget again without changing order', () => {
    const layout = toggleWidget(toggleWidget(DEFAULT_WIDGETS, 'live'), 'agents');
    expect(showAllWidgets(layout).hidden).toEqual([]);
    expect(showAllWidgets(layout).order).toEqual(DEFAULT_WIDGETS.order);
  });
});
