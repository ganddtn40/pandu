# Install the Pandu Android companion

The Android companion lets you watch your flights and answer approval requests
from your phone. It is optional. The computer still owns the agent process and
every decision, and a paired phone cannot start agents or change settings.

> **Experimental status.** Verified on an Android 17 emulator (API 37) on
> 2026-11-12: build, launch, pairing, Keystore token persistence, notification
> channels, WorkManager background checks, scope changes, and the high-risk
> approval gate. A release APK signed with a throwaway test key was verified
> with `apksigner`. It has **not** been verified on a physical phone, and the QR
> camera decode has only been checked for permission and cancellation, not for
> a successful scan. Its APK is not attached to releases and its CI job is
> allowed to fail. Build the APK from source to test it.

This guide is written for someone who has never installed an APK from outside
the Play Store. Follow it in order.

**Contents**

- [What you need](#what-you-need)
- [Turn on remote access on the computer](#turn-on-remote-access-on-the-computer)
- [Download and verify the APK](#download-and-verify-the-apk)
- [Allow installs from your browser or file manager](#allow-installs-from-your-browser-or-file-manager)
- [Install the APK](#install-the-apk)
- [Pair the phone](#pair-the-phone)
- [Permissions explained](#permissions-explained)
- [Notifications and background checks](#notifications-and-background-checks)
- [Battery optimisation](#battery-optimisation)
- [Networking and HTTPS](#networking-and-https)
- [Verify the signature with apksigner](#verify-the-signature-with-apksigner)
- [Update and uninstall](#update-and-uninstall)

## What you need

- Android 7.0 or newer (`minSdk 24`). Verified on Android 17 (API 37).
- An APK built from this repository until the first verified release.
- A computer running Pandu with remote access enabled.
- An HTTPS address that reaches the computer. The supported default is
  `tailscale serve`; a Cloudflare tunnel or another trusted HTTPS tunnel also
  works. Plain HTTP to a LAN address is **not** accepted by the release build.
- The phone and the computer do not need to be on the same network if Tailscale
  is used.

## Turn on remote access on the computer

Remote access is off by default and can only be turned on from the computer's
loopback UI.

1. Open Pandu on the computer.
2. Go to **Settings > Remote access**.
3. Choose **Tailscale** and follow the command Pandu shows. It is normally:

   ```powershell
   tailscale serve --bg http://<tailnet-ip>:4320
   ```

   Pandu does not install, start, or bundle Tailscale. It only detects it and
   shows the command.
4. Copy the HTTPS URL Pandu shows. It looks like
   `https://<machine>.<tailnet>.ts.net`.
5. Leave remote access on. You can turn it off or press **Panic** at any time.

The remote listener is a separate service on port `4320`. The normal daemon
listener stays on loopback port `4319`.

## Build and verify the APK

The companion is experimental, so no APK is attached to releases yet. Build one
from source with JDK 17, the Android SDK, and the NDK installed:

```powershell
node app/scripts/android-init.mjs
node app/scripts/android-build.mjs --out dist/android
```

The default build is a release APK. Add `--debug` for a debuggable build. The
unsigned APK is written under `dist/android`.

For a throwaway verification signature, create a keystore **outside the
repository**, export all four secrets, and ask the script to sign and verify:

```powershell
$env:PANDU_ANDROID_KEYSTORE = "$env:TEMP\pandu-test.keystore"
$env:PANDU_ANDROID_KEYSTORE_PASSWORD = "<store password>"
$env:PANDU_ANDROID_KEY_ALIAS = "pandu-test"
$env:PANDU_ANDROID_KEY_PASSWORD = "<key password>"
node app/scripts/android-build.mjs --sign --require-sign
```

The script runs `apksigner sign` and `apksigner verify --verbose --print-certs`.
Never reuse a test keystore for a real release and never commit a keystore. The
production keystore is supplied by CI secrets and is not provisioned yet.

A universal build carries all four ABIs and is about 25.7 MB. Phones only need
arm64, so build and measure that one:

```powershell
node app/scripts/android-build.mjs --target aarch64 --out dist/android-arm64
```

Add `--sign --require-sign` to sign it. The signed arm64 release APK is about
9.2 MB, under the 15 MB budget. A single-target build is named `-arm64-` even
though Gradle writes it under its `universal` directory.

Once an APK is attached to a release, the release also includes `SHA256SUMS`.
Verify it on a computer before copying it to the phone:

```powershell
Get-FileHash .\pandu-0.2.0-android-universal-release-signed.apk -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'pandu-0.2.0-android-universal-release-signed.apk'
```

On macOS or Linux:

```bash
shasum -a 256 pandu-0.2.0-android-universal-release-signed.apk
grep 'pandu-0.2.0-android-universal-release-signed.apk' SHA256SUMS
```

The hashes must match. Do not install an APK from a mirror, a chat attachment,
or a file-sharing link.

## Allow installs from your browser or file manager

Android blocks APK installs until you allow the app that opens the file. This
is a per-app permission, not a system-wide switch.

1. Download the APK with Chrome, Firefox, or your file manager.
2. Open the downloaded file. Android shows a message such as **For your
   security, your phone is not allowed to install unknown apps from this
   source**.
3. Tap **Settings** in that message.
4. Turn on **Allow from this source**.
5. Go back and tap the APK again.

The exact labels vary by manufacturer:

- **Samsung:** Settings > Apps > Special access > Install unknown apps.
- **Pixel / stock Android:** Settings > Apps > Special app access > Install
  unknown apps.
- **Xiaomi / Redmi:** Settings > Privacy protection > Special permissions >
  Install unknown apps. MIUI may also show a separate confirmation.
- **OnePlus / Oppo:** Settings > Apps > Special app access > Install unknown
  apps.

Only grant this to the app you actually use to open the APK. You can turn it
off again after installing.

## Install the APK

1. Tap **Install**.
2. If Play Protect says the app was not scanned, choose **Install anyway** only
   when the SHA-256 matched and the file came from the official release page.
3. Tap **Open**.

The app starts on the pairing screen. It does not ask for an account.

## Pair the phone

1. On the computer, open **Settings > Remote access > Pair a device**.
2. Pandu shows a QR code and a 32-character pairing code. The code is
   short-lived and single use.
3. On the phone, tap **Scan QR**. Android asks for camera permission at this
   moment, not at launch.
4. Point the camera at the QR code.
5. Check that the host and fingerprint on the phone match the computer. The QR
   payload includes the HTTPS URL, the pairing code, and the host fingerprint.
6. Optionally enter a 6–12 digit PIN. The PIN is required later for high-risk
   approvals. If you skip it, high-risk approvals must happen at the computer.
7. Tap **Pair**.
8. On the computer, confirm the device and compare the verification code shown
   on both screens.
9. The phone starts with **Status** only. Raise scopes on the computer, one at
   a time, when you need them.

If the camera is denied or unavailable, type the HTTPS host and the pairing
code manually. The phone accepts only `https://` URLs, except for the Android
emulator loopback addresses `10.0.2.2` and `127.0.0.1` in debug builds.

### The device token

After pairing, the device token is stored with AES-256-GCM under a key in the
Android Keystore (alias `pandu.remote.token.v1`). The encrypted token and IV
live in the app's private storage. The token is **not** kept in WebView
`localStorage`, and it is not copied into Android cloud backups.

## Permissions explained

The release APK declares only what it uses. The audit below is from
`aapt2 dump permissions` on the built APK:

| Permission | When it is requested | Why |
| --- | --- | --- |
| `CAMERA` | Only when you tap **Scan QR** | Read the pairing QR code. Manual entry works without it. |
| `POST_NOTIFICATIONS` | After pairing, on Android 13+ | Show approval and pairing notifications. You can deny it and still use the app while it is open. |
| `INTERNET` | Install time | Reach the paired host. |
| `ACCESS_NETWORK_STATE` | Install time | Let WorkManager wait for a network connection before polling. |
| `VIBRATE` | Install time | Vibrate for high-importance approval channels. |
| `RECEIVE_BOOT_COMPLETED` | Install time | Re-arm the 15-minute approval check after a reboot. |
| `WAKE_LOCK` | Install time | Keep the short WorkManager check alive long enough to finish. |
| `FOREGROUND_SERVICE` | Install time | Declared by the notification stack; Pandu does not start a permanent foreground service. |
| `USE_BIOMETRIC`, `USE_FINGERPRINT` | On demand | Gate high-risk approvals behind the system BiometricPrompt. |
| `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | Install time | Android's app-private dynamic receiver permission; not a user-visible capability. |

The app does not request location, contacts, SMS, storage, microphone, or
background location. It does not read your files. It does not request
`REQUEST_INSTALL_PACKAGES`; installing an update is left to Android's package
installer.

You can review or revoke permissions at any time in **Settings > Apps >
Pandu > Permissions**.

## Notifications and background checks

Android notification channels are created per event type:

- `pandu_guard_critical` — critical approvals, high importance.
- `pandu_guard_high` — high-risk approvals, high importance.
- `pandu_guard_normal` — normal approvals, default importance.
- `pandu_pairing` — pairing and connectivity problems, default importance.

You can mute any channel in **Settings > Apps > Pandu > Notifications**
without turning off the others.

### How background updates work

While the app is open, it keeps a live WebSocket to the host. When the app is
in the background, a WorkManager periodic job checks for pending approvals at
most every **15 minutes** (the Android minimum). It runs only when the phone
has a network connection, survives a reboot, and needs no permanent
foreground-service notification.

This is a deliberate choice. A permanent foreground service is unreliable and
often non-compliant for approval polling:

- Android 12+ restricts starting a foreground service from the background.
- Android 15 caps `dataSync` foreground services at six hours in any 24-hour
  period.
- Google Play policy treats a `specialUse` service used for polling as review
  bait.

The trade-off is latency: a background approval notification can arrive up to
about 15 minutes after the request. If you need immediate notifications, keep
the app open, or use the push alternative below.

### Push alternative: ntfy or UnifiedPush

Pandu does not bundle a push service and does not send your data to one. If you
need instant background notifications, run your own
[ntfy](https://ntfy.sh/) server or use an
[UnifiedPush](https://unifiedpush.org/) distributor, and forward the host's
approval events to it. Treat the push payload as sensitive: send an event type
and an opaque flight id, never prompt text or command output. This is optional
and not configured by the app.

## Battery optimisation

Some manufacturers kill background work aggressively. If notifications stop
arriving when the app is closed:

1. Open **Settings > Apps > Pandu > Battery**.
2. Choose **Unrestricted** or **Allow background activity**.
3. On Samsung, also check **Settings > Battery > Background usage limits** and
   make sure Pandu is not in **Sleeping apps**.
4. On Xiaomi/MIUI, enable **Autostart** for Pandu and set battery saver to
   **No restrictions**.
5. On OnePlus/Oppo, enable **Allow background activity** and disable
   **Optimise battery use**.

Android may still delay WorkManager jobs. That is normal. The app never asks
for a blanket battery-optimisation exemption.

## Networking and HTTPS

Release builds set `android:usesCleartextTraffic="false"` and use a network
security config with no cleartext exemption. This means:

- `https://` and `wss://` work.
- `http://` and `ws://` are blocked, including LAN addresses.
- There is no “just this once” cleartext switch in the app.

Use `tailscale serve` for a tailnet:

```powershell
tailscale serve --bg http://<tailnet-ip>:4320
```

Tailscale terminates HTTPS with a MagicDNS certificate and forwards to the
plain-HTTP remote listener on your machine. The phone only ever sees HTTPS.
The same pattern works with a Cloudflare tunnel or another trusted reverse
proxy. Do not expose port `4320` directly to the public internet.

Debug builds are different: they allow cleartext only to `10.0.2.2`,
`127.0.0.1`, and `localhost`, so the Android emulator can reach a development
daemon. Release builds never include that exemption.

## Verify the signature with apksigner

If you have the Android SDK build tools, verify the APK before installing:

```bash
apksigner verify --verbose --print-certs pandu-0.2.0-android-universal-release-signed.apk
```

On Windows:

```powershell
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --verbose --print-certs `
  .\pandu-0.2.0-android-universal-release-signed.apk
```

The output must say `Verifies` and list the release certificate. If it says
`DOES NOT VERIFY`, do not install the file.

When the companion is promoted out of experimental, the release workflow will
sign the APK with the CI keystore and run `apksigner verify` before uploading
it. The keystore is supplied through repository secrets and is never committed.
Until then the Android job is non-blocking and its APK is not a release asset.

## What was verified on the emulator

Verified on 2026-11-12 with the `Medium_Phone_API_37.0` AVD (Android 17,
API 37, 1080x2400) and a debug APK built from this repository. The captures are
in [`docs/screenshots/phase11b`](../screenshots/phase11b):

- **Build and launch.** The debug APK installed, launched, and rendered the
  companion at `http://tauri.localhost` without a WebView crash.
- **Pairing.** A loopback HTTP pairing request (debug-only exception) reached
  the host, the host confirmed the four-digit verification code, and the device
  received a Status-only token.
- **Token storage.** Force-stopping and cold-launching the app restored the
  session from the Android Keystore without pairing again.
- **Permissions.** Camera was requested only when scanning, and
  `POST_NOTIFICATIONS` was requested after pairing; both were granted.
- **Notification channels.** `dumpsys notification --noredact` showed
  `pandu_guard_critical` (importance 4), `pandu_guard_high` (4),
  `pandu_guard_normal` (3), and `pandu_pairing` (3).
- **Background checks.** `dumpsys jobscheduler` showed the periodic
  `GuardWatchWorker` job with a 15-minute interval, a `NetworkType.CONNECTED`
  constraint, and reboot persistence. It completed several runs, including a
  forced run.
- **High-risk gate.** A real `rm -rf /` request was paused by the guard. The
  inbox pushed the event over the live socket, demanded the pairing PIN, and
  the system BiometricPrompt appeared. Fingerprint authentication succeeded,
  an empty PIN was rejected with `409 pin_required` and the event stayed
  pending, and the correct pairing PIN approved it. The paused proxy request
  then resumed and reached upstream.
- **Scopes.** Raising the device from Status to Respond on the host changed
  what the app could do without re-pairing.
- **Packaging.** In the debug APK the adaptive icon is present at
  `res/mipmap-anydpi-v26/ic_launcher.xml`, and `aapt2 dump permissions`
  matches the table above.
- **Signed release APK.** A throwaway test key (never committed) signed the
  release build, and `apksigner verify --verbose --print-certs` reported valid
  v2 and v3 signatures from one signer. The arm64 APK is 9.21 MB and contains
  only `arm64-v8a`; the universal APK is 25.68 MB. `aapt2 dump badging` reports
  `minSdkVersion 24`, `targetSdkVersion 37`, and the release manifest declares
  the same permission set. The adaptive icon survives resource shrinking as an
  `adaptive-icon` XML. The release APK was not installed on the emulator
  because its test signature differs from the debug build's; the runtime checks
  above used the debug APK.

Not verified on an emulator or phone:

- A successful QR **decode**. The camera permission, scanner overlay, and
  cancel path were checked, but no real QR code was scanned.
- Device-credential authentication. The emulator's system prompt verified the
  device PIN but did not issue an auth token (`mTokenEscrow is null`), so the
  successful path used an enrolled fingerprint and the emulator's virtual
  sensor.
- A physical phone, including OEM battery managers and a real camera.
- An upgrade from one signed release to the next.

## Update and uninstall

### Update

Install the newer APK over the old one. Android keeps the app data and the
paired device token when the signing key is the same. If Android refuses the
update, the signing key changed; uninstall and pair again.

### Uninstall

1. Long-press the Pandu icon and choose **App info**.
2. Tap **Uninstall**. This removes the app, the Keystore key, and the encrypted
   token.
3. On the computer, open **Settings > Remote access** and revoke the device if
   it is still listed. Uninstalling the phone app does not automatically revoke
   the token on the host.

If you only want to unpair, use **Forget this device** in the app, then revoke
the device on the computer.
