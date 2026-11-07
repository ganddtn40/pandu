const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'Active',
  completed: 'Completed',
  failed: 'Failed',
  killed: 'Killed',
  ok: 'Healthy',
  degraded: 'Degraded',
  live: 'Live',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

const STATUS_TONES: Readonly<Record<string, string>> = {
  active: 'live',
  completed: 'ok',
  failed: 'danger',
  killed: 'warn',
  ok: 'ok',
  degraded: 'warn',
  live: 'live',
  connecting: 'warn',
  reconnecting: 'warn',
  offline: 'muted',
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONES[status] ?? 'muted';
  return (
    <span className={`status-pill tone-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {label ?? STATUS_LABELS[status] ?? status}
    </span>
  );
}
