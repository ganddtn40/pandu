import type { ReactNode } from 'react';

export interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}

export function ErrorBanner({ message, onRetry, retrying = false }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <span className="error-mark" aria-hidden="true">
        !
      </span>
      <p>{message}</p>
      {onRetry ? (
        <button className="text-button" type="button" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      ) : null}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-rule" aria-hidden="true" />
      <h3>{title}</h3>
      {children ? <div className="empty-copy">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export interface LoadingRowsProps {
  rows?: number;
  label?: string;
}

export function LoadingRows({ rows = 3, label = 'Loading recordings' }: LoadingRowsProps) {
  return (
    <div className="skeleton-stack" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-meta" />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
