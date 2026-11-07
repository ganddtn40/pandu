import { statusLabel, statusTone } from '../lib/format';

export interface StatusBadgeProps {
  status: string;
  label?: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`status-badge tone-${statusTone(status)}`}>
      <span className="status-dot" aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  );
}
