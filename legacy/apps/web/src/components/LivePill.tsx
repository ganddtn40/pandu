import { liveStatusLabel, useLiveStatus } from '../lib/live';

const STATUS_TONES = {
  live: 'ok',
  connecting: 'warn',
  reconnecting: 'warn',
  offline: 'muted',
} as const;

export function LivePill() {
  const status = useLiveStatus();
  const label = liveStatusLabel(status);

  return (
    <span
      className={`live-pill tone-${STATUS_TONES[status]}`}
      data-status={status}
      title={`Live feed: ${label.toLowerCase()}`}
    >
      <span className="live-orb" aria-hidden="true" />
      <span className="sr-only">Live feed: </span>
      {label}
    </span>
  );
}
