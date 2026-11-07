import { Capacitor } from '@capacitor/core';
import type { PairingClaimResponse } from '@cockpit/core';
import { useCallback, useEffect, useState } from 'react';

import { StatusPill } from './components/StatusPill';
import {
  claimDevice,
  createMobileClient,
  type ClaimDeviceInput,
  type MobileApiClient,
} from './lib/api';
import {
  parsePairingInput,
  readPairingLinkFromLocation,
  type PairingPrefill,
} from './lib/deep-link';
import { useLiveFeed } from './lib/live';
import { clearSession, loadSession, saveSession, type MobileSession } from './lib/session';
import { FlightsTab } from './screens/FlightsTab';
import { OverviewTab } from './screens/OverviewTab';
import { PairScreen } from './screens/PairScreen';
import { SettingsTab } from './screens/SettingsTab';

type Tab = 'overview' | 'flights' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'flights', label: 'Flights' },
  { id: 'settings', label: 'Settings' },
];

export interface AppProps {
  initialSession?: MobileSession | null;
  clientFactory?: (session: MobileSession) => MobileApiClient;
  claim?: (input: ClaimDeviceInput) => Promise<PairingClaimResponse>;
}

export function App({ initialSession, clientFactory, claim = claimDevice }: AppProps) {
  const [session, setSession] = useState<MobileSession | null>(() =>
    initialSession === undefined ? loadSession() : initialSession,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<PairingPrefill | null>(null);

  const makeClient = useCallback(
    (value: MobileSession) =>
      clientFactory
        ? clientFactory(value)
        : createMobileClient({ baseUrl: value.baseUrl, token: value.token }),
    [clientFactory],
  );

  useEffect(() => {
    const link = readPairingLinkFromLocation();
    if (!link) return;
    setPrefill(link);
    try {
      const url = new URL(window.location.href);
      url.search = '';
      window.history.replaceState({}, '', `${url.pathname}${url.hash}`);
    } catch {
      // Keeping the query string is harmless; the form is prefilled either way.
    }
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    let disposed = false;
    let removeListener: (() => Promise<void>) | undefined;

    void import('@capacitor/app')
      .then(({ App: CapacitorApp }) =>
        CapacitorApp.addListener('appUrlOpen', (event) => {
          const link = parsePairingInput(event.url);
          if (!link) return;
          setPrefill(link);
        }),
      )
      .then((handle) => {
        if (disposed) {
          void handle.remove();
          return;
        }
        removeListener = () => handle.remove();
      })
      .catch(() => {
        // The app still supports manual entry when the plugin is unavailable.
      });

    return () => {
      disposed = true;
      void removeListener?.();
    };
  }, []);

  const handlePaired = useCallback((next: MobileSession) => {
    saveSession(next);
    setSession(next);
    setPrefill(null);
    setNotice(null);
  }, []);

  const handleUnauthorized = useCallback(() => {
    clearSession();
    setSession(null);
    setNotice('This device was revoked or its token expired. Pair it again to reconnect.');
  }, []);

  const handleUnpair = useCallback(() => {
    clearSession();
    setSession(null);
    setNotice('This phone is no longer paired. Create a new code to reconnect.');
  }, []);

  if (!session) {
    return <PairScreen initial={prefill} notice={notice} claim={claim} onPaired={handlePaired} />;
  }

  return (
    <PairedShell
      key={session.device.id}
      session={session}
      client={makeClient(session)}
      onUnauthorized={handleUnauthorized}
      onUnpair={handleUnpair}
    />
  );
}

interface PairedShellProps {
  session: MobileSession;
  client: MobileApiClient;
  onUnauthorized: () => void;
  onUnpair: () => void;
}

function PairedShell({ session, client, onUnauthorized, onUnpair }: PairedShellProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const live = useLiveFeed(session.baseUrl, session.token);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup small">
          <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="15.5" fill="none" stroke="currentColor" />
            <circle cx="20" cy="20" r="8" fill="none" stroke="currentColor" />
            <path d="M20 2v6M20 32v6M2 20h6M32 20h6" stroke="currentColor" />
            <path d="M20 20l7-7" stroke="currentColor" />
            <circle cx="20" cy="20" r="2.5" fill="currentColor" stroke="none" />
          </svg>
          <div>
            <p className="brand-name">Cockpit</p>
            <p className="brand-tag">{hostLabel(session.baseUrl)}</p>
          </div>
        </div>
        <StatusPill status={live.status} />
      </header>

      <main className="app-main" id="main">
        {tab === 'overview' ? (
          <section role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
            <OverviewTab
              session={session}
              client={client}
              live={live}
              onUnauthorized={onUnauthorized}
            />
          </section>
        ) : null}
        {tab === 'flights' ? (
          <section role="tabpanel" id="panel-flights" aria-labelledby="tab-flights">
            <FlightsTab session={session} client={client} onUnauthorized={onUnauthorized} />
          </section>
        ) : null}
        {tab === 'settings' ? (
          <section role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
            <SettingsTab session={session} client={client} onUnpair={onUnpair} />
          </section>
        ) : null}
      </main>

      <nav className="tab-bar" aria-label="Main">
        <div className="tab-bar-inner" role="tablist" aria-label="Cockpit sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`tab-${item.id}`}
              className={`tab-button${tab === item.id ? ' is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              onClick={() => setTab(item.id)}
            >
              <TabIcon tab={item.id} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function TabIcon({ tab }: { tab: Tab }) {
  if (tab === 'overview') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="tab-icon">
        <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (tab === 'flights') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="tab-icon">
        <path
          d="M4 6h16M4 12h16M4 18h10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="tab-icon">
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
