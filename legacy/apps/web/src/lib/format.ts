const numberFormatter = new Intl.NumberFormat('en-US');
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatNumber(value: number): string {
  return numberFormatter.format(Math.max(0, value));
}

export function formatCompactNumber(value: number): string {
  if (Math.abs(value) < 1000) return numberFormatter.format(value);
  return compactFormatter.format(value);
}

export function formatCurrency(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const digits = safe === 0 ? 2 : safe < 0.01 ? 4 : safe < 1 ? 3 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(safe);
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return '—';
  const value = Math.max(0, milliseconds);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${trimDecimal(value / 1000)}s`;
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.round((value % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTimeFormatter.format(date);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormatter.format(date);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return timeFormatter.format(date);
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';

  const delta = now - time;
  if (delta < 0) {
    return Math.abs(delta) < 45_000 ? 'just now' : formatDateTime(iso);
  }

  const seconds = Math.floor(delta / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1m ago';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return formatDate(iso);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export type StatusTone = 'live' | 'ok' | 'danger' | 'warn' | 'muted';

export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'active':
    case 'running':
      return 'live';
    case 'completed':
      return 'ok';
    case 'failed':
      return 'danger';
    case 'blocked':
    case 'denied':
      return 'warn';
    case 'killed':
    case 'cancelled':
      return 'muted';
    default:
      return 'muted';
  }
}

export function statusLabel(status: string): string {
  return status.length === 0 ? 'Unknown' : status.charAt(0).toUpperCase() + status.slice(1);
}

export function prettyJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function countLabel(count: number, singular: string, plural?: string): string {
  return `${formatNumber(count)} ${pluralize(count, singular, plural)}`;
}
