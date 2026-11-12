/**
 * Companion boot and the hooks `RemoteApp` uses when it runs on Android.
 *
 * Order matters: the host origin must be restored before any module calls the
 * API, and the token must move from the Android Keystore into memory before
 * `initRemoteApp` asks whether a device is paired.
 */

import { setDaemonOverride, useRemoteTokenStore } from '../api/client';
import { t } from '../i18n/i18n.svelte';
import {
  cancelScan,
  configureHost,
  confirmWithBiometrics,
  initNotificationChannels,
  loadHost,
  loadToken,
  nativeAvailable,
  requestNotificationPermission,
  saveToken,
  scanPairingQr,
  scheduleWatch,
} from './bridge';
import { normalizeHost, parsePairingPayload, type PairingPayload } from './qr';

export interface CompanionHooks {
  /** The stored host origin, or an empty string before one is chosen. */
  readonly host: string;
  /** Validate and store a host, then point the API at it. */
  adoptHost(raw: string): Promise<string>;
  /** Open the camera and parse one pairing QR. */
  scan(): Promise<PairingPayload>;
  /** Close the scanner without a result. */
  cancelScan(): Promise<void>;
  /** Ask for BiometricPrompt or the device PIN before a high-risk decision. */
  confirmHighRisk(title: string): Promise<boolean>;
  /** After the host confirms: channels, notification permission, watch. */
  completePairing(): Promise<void>;
}

let host: string | null = null;
let booted = false;

export function companionNative(): boolean {
  return nativeAvailable();
}

export function companionHost(): string | null {
  return host;
}

/**
 * Restore the host and token. Safe to call once per page load; failures leave
 * the companion on the pairing screen instead of blocking startup.
 */
export async function bootCompanion(): Promise<void> {
  if (!nativeAvailable() || booted) return;
  booted = true;

  const [tokenResult, hostResult] = await Promise.allSettled([loadToken(), loadHost()]);
  const token = tokenResult.status === 'fulfilled' ? tokenResult.value : null;
  const storedHost = hostResult.status === 'fulfilled' ? hostResult.value : null;

  useRemoteTokenStore(
    {
      save(value) {
        void saveToken(value).catch(() => {
          // A failed write leaves the in-memory token usable for this page.
        });
      },
    },
    token,
  );

  const origin = normalizeHost(storedHost);
  if (!origin) {
    if (token) {
      // A token without a host can never reach anything. Drop it so the user
      // gets the pairing screen instead of an endless offline state.
      void saveToken(null).catch(() => {});
    }
    return;
  }

  host = origin;
  setDaemonOverride(origin);
  void initNotificationChannels().catch(() => {
    // Channels are recreated on the next configure call.
  });
}

export async function adoptHost(raw: string): Promise<string> {
  const origin = normalizeHost(raw);
  if (!origin) throw new Error(t('companion.hostInvalid'));
  if (nativeAvailable()) await configureHost(origin);
  host = origin;
  setDaemonOverride(origin);
  return origin;
}

async function scan(): Promise<PairingPayload> {
  const raw = await scanPairingQr();
  if (!raw) throw new Error(t('companion.qrCancelled'));
  const payload = parsePairingPayload(raw);
  if (!payload) throw new Error(t('companion.qrInvalid'));
  return payload;
}

async function confirmHighRisk(title: string): Promise<boolean> {
  if (!nativeAvailable()) return true;
  // No enrolled biometric is not fatal: `allowDeviceCredential` lets the
  // device PIN or pattern stand in. If the device has no secure lock screen
  // the prompt rejects and the decision is not sent.
  return confirmWithBiometrics(
    t('companion.biometricReason', { title }),
    t('companion.biometricTitle'),
    t('companion.biometricSubtitle'),
    t('common.cancel'),
  );
}

async function completePairing(): Promise<void> {
  if (!nativeAvailable()) return;
  await initNotificationChannels().catch(() => {});
  await requestNotificationPermission().catch(() => false);
  await scheduleWatch(true).catch(() => {});
}

export const companionHooks: CompanionHooks = {
  get host() {
    return host ?? '';
  },
  adoptHost,
  scan,
  cancelScan,
  confirmHighRisk,
  completePairing,
};
