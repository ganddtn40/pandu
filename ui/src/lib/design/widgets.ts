export const WIDGET_IDS = [
  'live',
  'spend',
  'tokens',
  'guards',
  'approvals',
  'activity',
  'recent',
  'agents',
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

export interface WidgetLayout {
  order: WidgetId[];
  hidden: WidgetId[];
}

export const DEFAULT_WIDGETS: WidgetLayout = {
  order: [...WIDGET_IDS],
  hidden: [],
};

import { storageKey } from '../brand';

export const WIDGET_STORAGE_KEY = storageKey('widgets');

function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === 'string' && (WIDGET_IDS as readonly string[]).includes(value);
}

/**
 * Stored layouts are untrusted. Keep known ids, drop duplicates and unknown
 * values, and append any widget added by a newer app version.
 */
export function normalizeWidgets(value: unknown): WidgetLayout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { order: [...DEFAULT_WIDGETS.order], hidden: [] };
  }
  const record = value as { order?: unknown; hidden?: unknown };
  const order: WidgetId[] = [];
  if (Array.isArray(record.order)) {
    for (const id of record.order) {
      if (isWidgetId(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const id of WIDGET_IDS) {
    if (!order.includes(id)) order.push(id);
  }
  const hidden: WidgetId[] = [];
  if (Array.isArray(record.hidden)) {
    for (const id of record.hidden) {
      if (isWidgetId(id) && !hidden.includes(id)) hidden.push(id);
    }
  }
  return { order, hidden };
}

export function visibleWidgets(layout: WidgetLayout): WidgetId[] {
  return layout.order.filter((id) => !layout.hidden.includes(id));
}

export function moveWidget(layout: WidgetLayout, id: WidgetId, direction: -1 | 1): WidgetLayout {
  const index = layout.order.indexOf(id);
  if (index < 0) return layout;
  const target = index + direction;
  if (target < 0 || target >= layout.order.length) return layout;
  const order = [...layout.order];
  const [item] = order.splice(index, 1);
  if (!item) return layout;
  order.splice(target, 0, item);
  return { ...layout, order };
}

/** Move a widget in front of another widget, used by pointer drag and drop. */
export function reorderWidget(layout: WidgetLayout, id: WidgetId, beforeId: WidgetId): WidgetLayout {
  if (id === beforeId) return layout;
  const index = layout.order.indexOf(id);
  const target = layout.order.indexOf(beforeId);
  if (index < 0 || target < 0) return layout;
  const order = [...layout.order];
  const [item] = order.splice(index, 1);
  if (!item) return layout;
  const insertAt = order.indexOf(beforeId);
  order.splice(insertAt < 0 ? order.length : insertAt, 0, item);
  return { ...layout, order };
}

export function toggleWidget(layout: WidgetLayout, id: WidgetId): WidgetLayout {
  const hidden = layout.hidden.includes(id)
    ? layout.hidden.filter((entry) => entry !== id)
    : [...layout.hidden, id];
  return { ...layout, hidden };
}

export function showAllWidgets(layout: WidgetLayout): WidgetLayout {
  return { ...layout, hidden: [] };
}
