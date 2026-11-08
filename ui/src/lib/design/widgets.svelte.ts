import {
  DEFAULT_WIDGETS,
  WIDGET_STORAGE_KEY,
  moveWidget,
  normalizeWidgets,
  reorderWidget,
  showAllWidgets,
  toggleWidget,
  type WidgetId,
  type WidgetLayout,
} from './widgets';

function readLayout(): WidgetLayout {
  if (typeof localStorage === 'undefined') {
    return { order: [...DEFAULT_WIDGETS.order], hidden: [] };
  }
  try {
    const raw = localStorage.getItem(WIDGET_STORAGE_KEY);
    if (!raw) return { order: [...DEFAULT_WIDGETS.order], hidden: [] };
    return normalizeWidgets(JSON.parse(raw) as unknown);
  } catch {
    return { order: [...DEFAULT_WIDGETS.order], hidden: [] };
  }
}

export const widgetState = $state<WidgetLayout>(readLayout());

function persist(next: WidgetLayout): void {
  try {
    localStorage.setItem(WIDGET_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The layout still applies for this session.
  }
  window.dispatchEvent(new CustomEvent<WidgetLayout>('cockpit:widgets', { detail: next }));
}

function apply(next: WidgetLayout): void {
  widgetState.order = next.order;
  widgetState.hidden = next.hidden;
  persist(next);
}

export function moveWidgetBy(id: WidgetId, direction: -1 | 1): void {
  apply(moveWidget(widgetState, id, direction));
}

export function reorderWidgetBefore(id: WidgetId, beforeId: WidgetId): void {
  apply(reorderWidget(widgetState, id, beforeId));
}

export function toggleWidgetHidden(id: WidgetId): void {
  apply(toggleWidget(widgetState, id));
}

export function showAllWidgetsAgain(): void {
  apply(showAllWidgets(widgetState));
}

export function resetWidgetLayout(): void {
  apply({ order: [...DEFAULT_WIDGETS.order], hidden: [] });
}
