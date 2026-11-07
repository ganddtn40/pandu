import { formatPairingCode, normalizePairingCode, type PairingClaimResponse } from '@cockpit/core';
import { useEffect, useState, type FormEvent } from 'react';

import { describeMobileError, type ClaimDeviceInput } from '../lib/api';
import type { PairingPrefill } from '../lib/deep-link';
import { normalizeBaseUrl, type MobileSession } from '../lib/session';

export interface PairScreenProps {
  initial?: PairingPrefill | null;
  notice?: string | null;
  claim: (input: ClaimDeviceInput) => Promise<PairingClaimResponse>;
  onPaired: (session: MobileSession) => void;
}

export function PairScreen({ initial, notice, claim, onPaired }: PairScreenProps) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!initial) return;
    setBaseUrl(initial.baseUrl);
    setCode(initial.code);
  }, [initial]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);

    const normalizedBase = normalizeBaseUrl(baseUrl);
    if (!normalizedBase) {
      setError('Enter a valid daemon address, for example http://192.168.1.20:4319.');
      return;
    }

    const normalizedCode = normalizePairingCode(code);
    if (!normalizedCode) {
      setError('Enter the eight-character code shown in the dashboard. Letters and numbers only.');
      return;
    }
    setCode(formatPairingCode(normalizedCode) ?? normalizedCode);

    setBusy(true);
    try {
      const response = await claim({
        baseUrl: normalizedBase,
        code: normalizedCode,
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      });
      onPaired({
        baseUrl: normalizeBaseUrl(response.baseUrl) ?? normalizedBase,
        token: response.token,
        device: response.device,
        pairedAt: new Date().toISOString(),
      });
    } catch (claimError) {
      setError(describeMobileError(claimError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pair-screen">
      <header className="pair-hero">
        <div className="brand-lockup">
          <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="15.5" fill="none" stroke="currentColor" />
            <circle cx="20" cy="20" r="8" fill="none" stroke="currentColor" />
            <path d="M20 2v6M20 32v6M2 20h6M32 20h6" stroke="currentColor" />
            <path d="M20 20l7-7" stroke="currentColor" />
            <circle cx="20" cy="20" r="2.5" fill="currentColor" stroke="none" />
          </svg>
          <div>
            <p className="brand-name">Cockpit</p>
            <p className="brand-tag">Flight recorder</p>
          </div>
        </div>

        <p className="eyebrow">
          <span className="eyebrow-line" aria-hidden="true" />
          Device pairing
        </p>
        <h1>
          Connect to your daemon<span className="title-dot">.</span>
        </h1>
        <p className="lede">
          Pair this phone with the Cockpit daemon running on your computer. Open{' '}
          <strong>Pair a device</strong> in the dashboard, then enter the one-time code here.
        </p>
      </header>

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <form className="pair-form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field">
          <span>Daemon address</span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://192.168.1.20:4319"
            required
          />
        </label>

        <label className="field">
          <span>Pairing code</span>
          <input
            className="code-input"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={9}
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            required
          />
        </label>

        <label className="field">
          <span>Device name (optional)</span>
          <input
            type="text"
            autoComplete="off"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="Pixel 9"
          />
        </label>

        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? 'Pairing…' : 'Pair this device'}
        </button>
      </form>

      <section className="how-card" aria-labelledby="how-title">
        <h2 id="how-title">Where do I find the code?</h2>
        <ol>
          <li>
            Run <code>cockpit start</code> on your computer.
          </li>
          <li>
            Open the dashboard and go to <strong>Pair a device</strong>.
          </li>
          <li>Create a code, then type it here or scan the QR code with your camera.</li>
        </ol>
        <p>
          Codes expire after a few minutes and work once. The daemon must be reachable from this
          phone: same Wi-Fi network, Tailscale, or your own reverse proxy.
        </p>
      </section>

      <p className="pair-foot">
        The token stays on this device. Cockpit sends no telemetry and never uploads your sessions.
      </p>
    </main>
  );
}
