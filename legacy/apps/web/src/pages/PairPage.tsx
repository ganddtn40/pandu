import {
  DEFAULT_PAIRING_TTL_SECONDS,
  MAX_PAIRING_TTL_SECONDS,
  MIN_PAIRING_TTL_SECONDS,
  type DevicePlatform,
} from '@cockpit/core';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { EmptyState, ErrorBanner, LoadingRows } from '../components/Messages';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { useDevices, useLiveRefresh, usePageTitle, usePairing } from '../lib/hooks';

const TTL_OPTIONS = [60, 120, 300, 600, 900] as const;

const PLATFORM_LABELS: Readonly<Record<DevicePlatform, string>> = {
  android: 'Android',
  ios: 'iOS',
  desktop: 'Desktop',
  web: 'Browser',
  cli: 'CLI',
};

interface QrState {
  dataUrl: string | null;
  failed: boolean;
}

function useQrDataUrl(value: string | undefined): QrState {
  const [state, setState] = useState<QrState>({ dataUrl: null, failed: false });

  useEffect(() => {
    if (!value) {
      setState({ dataUrl: null, failed: false });
      return undefined;
    }

    let cancelled = false;
    QRCode.toString(value, {
      type: 'svg',
      margin: 1,
      width: 240,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1016', light: '#ffffff' },
    })
      .then((svg) => {
        if (cancelled) return;
        setState({
          dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          failed: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ dataUrl: null, failed: true });
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  return state;
}

function useRemainingSeconds(expiresAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return 0;
  const target = Date.parse(expiresAt);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.ceil((target - now) / 1_000));
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`;
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      // Clipboard access can be denied. The text stays selectable by hand.
    }
  };

  return (
    <button className="ghost-button button-small" type="button" onClick={() => void copy()}>
      {copied ? 'Copied' : label}
    </button>
  );
}

export function PairPage() {
  usePageTitle('Pair a device · Cockpit');
  const pairing = usePairing();
  const devices = useDevices();
  const refreshDevices = devices.refresh;

  const [name, setName] = useState('');
  const [ttlSeconds, setTtlSeconds] = useState<number>(DEFAULT_PAIRING_TTL_SECONDS);

  const session = pairing.session;
  const status = pairing.status;
  const remaining = useRemainingSeconds(session?.expiresAt);
  const qr = useQrDataUrl(session?.deepLink);

  const claimed = status?.claimed === true;
  const expired = status?.expired === true || (session !== null && remaining === 0);
  const waiting = session !== null && !claimed && !expired;

  useLiveRefresh(
    refreshDevices,
    400,
    (event) => event.type === 'pairing.completed' || event.type === 'device.revoked',
  );

  useEffect(() => {
    if (claimed) refreshDevices();
  }, [claimed, refreshDevices]);

  const activeDevices = devices.devices.filter((device) => !device.revokedAt).length;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = name.trim();
    void pairing.create({
      ...(trimmed.length > 0 ? { name: trimmed } : {}),
      ttlSeconds,
    });
  };

  return (
    <div className="page page-pair">
      <header className="page-head">
        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Remote access
        </p>
        <h1>
          Pair a device
          <span className="title-dot" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="page-lede">
          Give your phone or desktop app a scoped token for this Cockpit daemon. Codes are created
          on this machine only, expire quickly, and work once. Paired devices can read the flight
          log and live feed; they can never create another pairing code.
        </p>
      </header>

      {pairing.error ? <ErrorBanner message={pairing.error} /> : null}
      {devices.error ? (
        <ErrorBanner message={devices.error} onRetry={devices.refresh} retrying={devices.loading} />
      ) : null}
      {devices.actionError ? <ErrorBanner message={devices.actionError} /> : null}

      <div className="pairing-layout">
        {session ? (
          <section className="panel pairing-panel" aria-labelledby="pair-code-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">One-time code</p>
                <h2 id="pair-code-title">
                  {claimed ? 'Device paired' : expired ? 'Code expired' : 'Waiting for a device'}
                </h2>
              </div>
              <StatusBadge
                status={claimed ? 'active' : expired ? 'failed' : 'pending'}
                label={claimed ? 'Paired' : expired ? 'Expired' : 'Waiting'}
              />
            </div>

            <div className="pairing-session">
              <div className="pairing-code-block">
                <p className="pairing-code mono" aria-label="Pairing code">
                  {session.code}
                </p>
                <div className="pairing-code-actions">
                  <CopyButton value={session.code} label="Copy code" />
                  {waiting ? (
                    <button
                      className="ghost-button button-small danger-button"
                      type="button"
                      onClick={() => void pairing.cancel()}
                      disabled={pairing.busy}
                    >
                      {pairing.busy ? 'Cancelling…' : 'Cancel code'}
                    </button>
                  ) : (
                    <button
                      className="ghost-button button-small"
                      type="button"
                      onClick={pairing.reset}
                    >
                      Create another code
                    </button>
                  )}
                </div>
                <p className="pairing-state" aria-live="polite">
                  {claimed ? (
                    <>
                      The code was claimed. The new device now appears in the list below and can
                      reach this daemon with its token.
                    </>
                  ) : expired ? (
                    <>
                      This code expired at {formatDateTime(session.expiresAt)}. Create another code
                      to try again.
                    </>
                  ) : (
                    <>
                      Expires in <strong>{formatRemaining(remaining)}</strong> at{' '}
                      {formatDateTime(session.expiresAt)}. Keep this code private until it is used.
                    </>
                  )}
                </p>
              </div>

              <div className="pairing-qr">
                {qr.dataUrl ? (
                  <img
                    src={qr.dataUrl}
                    width={220}
                    height={220}
                    alt={`QR code containing the Cockpit pairing link for ${session.urls[0] ?? 'this daemon'}`}
                  />
                ) : (
                  <div className="pairing-qr-placeholder" role="status">
                    {qr.failed
                      ? 'QR code unavailable. Use the code or deep link.'
                      : 'Generating QR…'}
                  </div>
                )}
                <p className="pairing-qr-caption">Scan with the Cockpit mobile app</p>
              </div>
            </div>

            <div className="pairing-details">
              <div>
                <h3>Reachable addresses</h3>
                <ul className="pairing-urls">
                  {session.urls.map((url) => (
                    <li key={url}>
                      <span className="mono">{url}</span>
                      <CopyButton value={url} label="Copy" />
                    </li>
                  ))}
                </ul>
                <p className="panel-note">
                  A phone must be on the same network, or reach the daemon through your own
                  Tailscale or reverse proxy. Cockpit does not open a tunnel.
                </p>
              </div>
              <div>
                <h3>Deep link</h3>
                <code className="pairing-deeplink">{session.deepLink}</code>
                <CopyButton value={session.deepLink} label="Copy link" />
                <p className="panel-note">
                  The <span className="mono">cockpit://pair</span> link opens the mobile or desktop
                  app with the address and code already filled in.
                </p>
              </div>
            </div>
          </section>
        ) : (
          <section className="panel pairing-panel" aria-labelledby="pair-create-title">
            <div className="panel-head">
              <div>
                <p className="panel-kicker">Step 1</p>
                <h2 id="pair-create-title">Create a pairing code</h2>
              </div>
              <span className="count-chip">Local only</span>
            </div>

            <form className="pairing-form" onSubmit={submit}>
              <label className="field field-grow">
                <span>Device name (optional)</span>
                <input
                  type="text"
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Pixel 9"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>Code lifetime</span>
                <select
                  value={ttlSeconds}
                  onChange={(event) => setTtlSeconds(Number(event.target.value))}
                  aria-label="Pairing code lifetime"
                >
                  {TTL_OPTIONS.map((seconds) => (
                    <option key={seconds} value={seconds}>
                      {seconds / 60} {seconds === 60 ? 'minute' : 'minutes'}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary-button button-small" type="submit" disabled={pairing.busy}>
                {pairing.busy ? 'Creating…' : 'Create code'}
              </button>
            </form>

            <p className="panel-note">
              Codes last between {MIN_PAIRING_TTL_SECONDS / 60} and {MAX_PAIRING_TTL_SECONDS / 60}{' '}
              minutes. Cockpit stores only a SHA-256 hash of the code and of the device token it
              produces.
            </p>
          </section>
        )}

        <aside className="panel pairing-help" aria-labelledby="pair-help-title">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">How it works</p>
              <h2 id="pair-help-title">Three steps</h2>
            </div>
          </div>
          <ol className="pairing-steps">
            <li>
              <span className="pairing-step-index mono">01</span>
              <div>
                <h3>Open the app</h3>
                <p>Launch Cockpit on the device you want to connect.</p>
              </div>
            </li>
            <li>
              <span className="pairing-step-index mono">02</span>
              <div>
                <h3>Scan or type</h3>
                <p>Scan the QR code, follow the deep link, or enter the eight-character code.</p>
              </div>
            </li>
            <li>
              <span className="pairing-step-index mono">03</span>
              <div>
                <h3>Confirm</h3>
                <p>The device stores its token and appears below. Revoke it here at any time.</p>
              </div>
            </li>
          </ol>
          <div className="pairing-security">
            <h3>Security model</h3>
            <ul>
              <li>Pairing sessions are local-only; a remote token cannot mint more tokens.</li>
              <li>Every remote API and live-feed request needs a paired bearer token.</li>
              <li>Codes are single-use, expiring, and rate-limited against guessing.</li>
              <li>Revocation takes effect immediately and is recorded in the live feed.</li>
            </ul>
          </div>
        </aside>
      </div>

      <section className="panel" aria-labelledby="pair-devices-title">
        <div className="panel-head">
          <div>
            <p className="panel-kicker">Paired</p>
            <h2 id="pair-devices-title">Devices</h2>
          </div>
          <div className="panel-tools">
            <span className="count-chip">
              {activeDevices} active {activeDevices === 1 ? 'device' : 'devices'}
            </span>
            <button
              className="ghost-button button-small"
              type="button"
              onClick={devices.refresh}
              disabled={devices.refreshing}
            >
              {devices.refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {devices.loading && devices.devices.length === 0 ? (
          <LoadingRows rows={2} label="Loading paired devices" />
        ) : devices.devices.length === 0 ? (
          <EmptyState title="No paired devices">
            <p>
              Create a pairing code above, then claim it from the Cockpit mobile or desktop app.
              Nothing is paired until a device completes the handshake.
            </p>
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table pairing-devices-table">
              <caption className="sr-only">Devices paired with this Cockpit daemon</caption>
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Paired</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {devices.devices.map((device) => (
                  <tr key={device.id}>
                    <th scope="row">
                      <span className="pairing-device-name">{device.name}</span>
                      <span className="mono pairing-device-id">{device.id.slice(0, 8)}</span>
                    </th>
                    <td>{PLATFORM_LABELS[device.platform]}</td>
                    <td>{formatDateTime(device.createdAt)}</td>
                    <td>{device.lastSeenAt ? formatRelativeTime(device.lastSeenAt) : 'Never'}</td>
                    <td>
                      <StatusBadge
                        status={device.revokedAt ? 'revoked' : 'active'}
                        label={device.revokedAt ? 'Revoked' : 'Active'}
                      />
                    </td>
                    <td>
                      {device.revokedAt ? (
                        <span className="muted-note">No access</span>
                      ) : (
                        <button
                          className="ghost-button button-small danger-button"
                          type="button"
                          onClick={() => void devices.revoke(device.id)}
                          disabled={devices.busyId === device.id}
                          aria-label={`Revoke ${device.name}`}
                        >
                          {devices.busyId === device.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="page-foot">
        <span>Local-only pairing</span>
        <span>Single-use codes</span>
        <span>SHA-256 at rest</span>
      </p>
    </div>
  );
}
