import { useState } from 'react';

import type { SessionStatusFilter } from '../lib/api';
import { useDebouncedValue, useLiveRefresh, usePageTitle, useSessions } from '../lib/hooks';
import { SessionsPanel } from '../components/SessionsPanel';

export function SessionsPage() {
  usePageTitle('Flight log · Cockpit');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<SessionStatusFilter>('all');
  const debouncedSearch = useDebouncedValue(search, 250);
  const sessionsResource = useSessions({ search: debouncedSearch, status, limit: 100 });

  useLiveRefresh(sessionsResource.refresh);

  return (
    <div className="page page-sessions">
      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Archive
        </p>
        <h1>
          Flight log
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          Every recorded agent run, newest first. Search by title, workspace, or branch, then open a
          flight to inspect its steps.
        </p>
      </header>

      <section className="panel" aria-labelledby="all-flights-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">All recordings</p>
            <h2 id="all-flights-title">Flights</h2>
          </div>
        </div>
        <SessionsPanel
          search={search}
          status={status}
          onSearchChange={setSearch}
          onStatusChange={setStatus}
          resource={sessionsResource}
        />
      </section>
    </div>
  );
}
