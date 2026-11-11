/**
 * Thin wrappers over the native plugins the companion uses.
 *
 * The UI bundle never imports `@tauri-apps/*` packages: the companion is one
 * extra page in the same bundle, and the desktop shell does not need those
 * dependencies. Every call goes through `invoke`, which is only available when
 * the page runs inside the native webview.
 */

import { invoke, tauri } from '../tauri';

export type PermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'prompt-with-rationale';

interface CameraPermission {
  camera: PermissionState;
}

interface Scanned {
  content?: string;
}

export function nativeAvailable(): boolean {
  return tauri() !== null;
}

export async function loadToken(): Promise<string | null> {
  if (!nativeAvailable()) return null;
  const result = await invoke<{ token?: string }>('plugin:keystore|load');
  return result.token && result.token.length > 0 ? result.token : null;
}

export async function saveToken(token: string | null): Promise<void> {
  if (!nativeAvailable()) return;
  if (token) await invoke('plugin:keystore|save', { token });
  else await invoke('plugin:keystore|clear');
}

export async function loadHost(): Promise<string | null> {
  if (!nativeAvailable()) return null;
  const result = await invoke<{ host?: string }>('plugin:keystore|host');
  return result.host && result.host.length > 0 ? result.host : null;
}

export async function configureHost(host: string): Promise<void> {
  if (!nativeAvailable()) return;
  await invoke('plugin:keystore|configure', { host });
}

export async function scheduleWatch(enabled: boolean): Promise<void> {
  if (!nativeAvailable()) return;
  await invoke('plugin:keystore|schedule_watch', { enabled });
}

export async function initNotificationChannels(): Promise<void> {
  if (!nativeAvailable()) return;
  await invoke('plugin:keystore|notifications_init');
}

/**
 * Ask for the camera only when the user presses Scan. A denied or unavailable
 * camera returns `null`; pairing by code still works.
 */
export async function scanPairingQr(): Promise<string | null> {
  if (!nativeAvailable()) return null;
  const status = await invoke<CameraPermission>('plugin:barcode-scanner|check_permissions');
  let camera = status.camera;
  if (camera === 'prompt' || camera === 'prompt-with-rationale') {
    camera = (await invoke<CameraPermission>('plugin:barcode-scanner|request_permissions')).camera;
  }
  if (camera !== 'granted') throw new Error('camera_denied');
  const scanned = await invoke<Scanned>('plugin:barcode-scanner|scan', {
    cameraDirection: 'back',
    formats: ['QR_CODE'],
    windowed: true,
  });
  return scanned.content && scanned.content.trim() ? scanned.content : null;
}

/**
 * Ask for notification permission after pairing, when the user has just chosen
 * to receive approvals on this device. Android 13+ shows the system prompt once.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!nativeAvailable()) return false;
  const granted = await invoke<boolean | null>('plugin:notification|is_permission_granted');
  if (granted === true) return true;
  // `false` means "not granted yet", not "blocked": Android 13+ only shows the
  // system prompt from request_permission. A permanently denied permission
  // simply comes back denied here.
  const state = await invoke<PermissionState>('plugin:notification|request_permission');
  return state === 'granted';
}

/**
 * Gate a high-risk decision behind BiometricPrompt. `allowDeviceCredential`
 * lets a device PIN or pattern stand in when no biometric is enrolled; if the
 * device has no secure lock screen the prompt fails and nothing is sent.
 */
export async function confirmWithBiometrics(
  reason: string,
  title: string,
  subtitle: string,
  cancelTitle: string,
): Promise<boolean> {
  if (!nativeAvailable()) return true;
  try {
    await invoke('plugin:biometric|authenticate', {
      reason,
      title,
      subtitle,
      cancelTitle,
      allowDeviceCredential: true,
      confirmationRequired: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function biometricStatus(): Promise<{
  isAvailable: boolean;
  error?: string;
} | null> {
  if (!nativeAvailable()) return null;
  try {
    return await invoke<{ isAvailable: boolean; error?: string }>('plugin:biometric|status');
  } catch {
    return null;
  }
}
