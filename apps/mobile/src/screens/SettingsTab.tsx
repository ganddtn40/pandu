import type { HealthResponse } from '@cockpit/core';
import { useState } from 'react';

import { ErrorBanner } from '../components/Feedback';
import { describeMobileError, type MobileApiClient } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { MobileSession } from '../lib/session';

export interface SettingsTabProps {
  session: MobileSession;
  client: MobileApiClient;
  onUnpair: () => void;
}

export function SettingsTab({ session, client, onUnpair }: SettingsTabProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  const checkConnection = async (): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      setHealth(await client.health());
    } catch (checkError) {
      setHealth(null);
      setError(describeMobileError(checkError));
    } finally {
      setChecking(false);
    }
  };

  const unpair = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await client.revokeDevice(session.device.id);
    } catch {
      // The token may already be revoked or the daemon unreachable. Forget the
      // local session either way; a stale token is useless without the server.
    } finally {
      setBusy(false);
      onUnpair();
    }
  };

  return (
    <div className="tab-stack">
      <div>
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          This phone
        </p>
        <h1 className="screen-title">Settings</h1>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <section className="panel" aria-labelledby="device-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Paired device</p>
            <h2 id="device-title">{session.device.name}</h2>
          </div>
          <span className="count-chip">Android</span>
        </div>
        <dl className="fact-list">
          <div>
            <dt>Daemon</dt>
            <dd className="mono break-all">{session.baseUrl}</dd>
          </div>
          <div>
            <dt>Device ID</dt>
            <dd className="mono break-all">{session.device.id}</dd>
          </div>
          <div>
            <dt>Paired</dt>
            <dd>{formatDateTime(session.pairedAt)}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>
              {session.device.lastSeenAt
                ? formatDateTime(session.device.lastSeenAt)
                : 'This device'}
            </dd>
          </div>
        </dl>
        <div className="panel-actions">
          <button
            className="ghost-button button-small"
            type="button"
            onClick={() => void checkConnection()}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Check connection'}
          </button>
          {health ? (
            <span className="inline-note" role="status">
              Daemon {health.version} · database {health.database}
            </span>
          ) : null}
        </div>
      </section>

      <section className="panel" aria-labelledby="security-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Security</p>
            <h2 id="security-title">What this device can do</h2>
          </div>
        </div>
        <ul className="plain-list">
          <li>Read the flight log, analytics, guards, and live feed.</li>
          <li>It cannot create pairing codes or pair other devices.</li>
          <li>The bearer token is stored only on this phone and is never shown in the UI.</li>
          <li>Revoking the device in the dashboard cuts access immediately.</li>
        </ul>
      </section>

      <section className="panel danger-panel" aria-labelledby="unpair-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Disconnect</p>
            <h2 id="unpair-title">Unpair this phone</h2>
          </div>
        </div>
        <p className="panel-note">
          This removes the saved token from this phone and revokes it on the daemon. You will need a
          new pairing code to reconnect.
        </p>
        {confirming ? (
          <div className="confirm-row">
            <button
              className="danger-button"
              type="button"
              onClick={() => void unpair()}
              disabled={busy}
            >
              {busy ? 'Unpairing…' : 'Yes, unpair'}
            </button>
            <button
              className="ghost-button button-small"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Keep paired
            </button>
          </div>
        ) : (
          <button
            className="ghost-button danger-text"
            type="button"
            onClick={() => setConfirming(true)}
          >
            Unpair this device
          </button>
        )}
      </section>

      <p className="device-foot">Cockpit Mobile · local-first · no telemetry</p>
    </div>
  );
}
