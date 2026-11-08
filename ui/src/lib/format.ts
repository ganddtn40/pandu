import type { MessageKey } from './i18n/catalog';

export type Translator = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

export function formatUsd(value: number, unknownCalls = 0): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0 && unknownCalls > 0) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatElapsed(startedAt: string | undefined, now = Date.now()): string {
  if (!startedAt) return '—';
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '—';
  return formatDuration(Math.max(0, now - started));
}

export function timeAgo(iso: string | undefined, tr: Translator, now = Date.now()): string {
  if (!iso) return tr('common.unknown');
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return tr('common.unknown');
  const seconds = Math.max(0, Math.round((now - then) / 1_000));
  if (seconds < 45) return tr('common.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return tr('common.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return tr('common.hoursAgo', { count: hours });
  return tr('common.daysAgo', { count: Math.round(hours / 24) });
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export function formatUptime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  return `${hours}h ${minutes % 60}m`;
}

const STATUS_KEYS: Record<string, MessageKey> = {
  active: 'common.active',
  completed: 'common.completed',
  failed: 'common.failed',
  killed: 'common.killed',
  pending: 'common.pending',
  approved: 'common.approved',
  denied: 'common.denied',
  blocked: 'common.blocked',
  expired: 'common.expired',
  warned: 'common.warned',
  redacted: 'common.redacted',
  running: 'common.active',
  cancelled: 'common.denied',
};

export function statusKey(status: string): MessageKey {
  return STATUS_KEYS[status] ?? 'common.unknown';
}

export function sessionAgentLabel(agentName: string | undefined, fallback: string): string {
  return agentName?.trim() || fallback;
}
