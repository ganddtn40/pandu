import { formatNumber, prettyJson } from '../lib/format';

const MAX_JSON_CHARS = 100_000;

export interface JsonBlockProps {
  value: unknown;
  label: string;
  emptyLabel?: string;
}

export function JsonBlock({ value, label, emptyLabel = 'Not recorded.' }: JsonBlockProps) {
  if (value === undefined) {
    return <p className="muted-note">{emptyLabel}</p>;
  }

  const rendered = prettyJson(value);
  const truncated = rendered.length > MAX_JSON_CHARS;

  return (
    <>
      <pre className="code-block" aria-label={label}>
        <code>{truncated ? `${rendered.slice(0, MAX_JSON_CHARS)}…` : rendered}</code>
      </pre>
      {truncated ? (
        <p className="muted-note">
          Preview truncated at {formatNumber(MAX_JSON_CHARS)} of {formatNumber(rendered.length)}{' '}
          characters. The full payload remains in the local database.
        </p>
      ) : null}
    </>
  );
}

export interface HeadersListProps {
  headers: Record<string, string>;
}

export function HeadersList({ headers }: HeadersListProps) {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    return <p className="muted-note">No headers recorded.</p>;
  }

  return (
    <dl className="kv-grid">
      {entries.map(([name, value]) => (
        <div className="kv-row" key={name}>
          <dt>{name}</dt>
          <dd className="mono">{value.length > 0 ? value : '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
