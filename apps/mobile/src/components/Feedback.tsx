import type { ReactNode } from 'react';

export function ErrorBanner({
  message,
  onRetry,
  retrying = false,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
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

export function LoadingRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="loading-rows" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <span className="loading-row" key={index} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-rule" aria-hidden="true" />
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
