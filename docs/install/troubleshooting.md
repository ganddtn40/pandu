# Troubleshooting Pandu

This page covers the problems people hit most often. Start with the symptom,
then follow the numbered steps. Commands are safe to copy.

If nothing here helps, run `pandu doctor` and attach its output to your issue.
It contains local paths and counts, never prompt text or API keys. See
[privacy.md](../privacy.md) for exactly what a diagnostic report contains.

**Contents**

- [Double-clicking the setup does nothing](#double-clicking-the-setup-does-nothing)
- [Windows says “Windows protected your PC”](#windows-says-windows-protected-your-pc)
- [The app does not start, or shows a blank window](#the-app-does-not-start-or-shows-a-blank-window)
- [WebView2 is missing](#webview2-is-missing)
- [The app says the daemon could not start](#the-app-says-the-daemon-could-not-start)
- [The window closed but Pandu is still running](#the-window-closed-but-pandu-is-still-running)
- [A deep link does nothing](#a-deep-link-does-nothing)
- [The firewall asks about Pandu](#the-firewall-asks-about-pandu)
- [Remote access does not work](#remote-access-does-not-work)
- [QR pairing fails](#qr-pairing-fails)
- [Notifications do not arrive on Android](#notifications-do-not-arrive-on-android)
- [The PWA does not install](#the-pwa-does-not-install)
- [The phone says the connection is not private](#the-phone-says-the-connection-is-not-private)
- [Reset Pandu without losing your data](#reset-pandu-without-losing-your-data)
- [Find the data directory](#find-the-data-directory)
- [Collect a diagnostic report](#collect-a-diagnostic-report)

## Double-clicking the setup does nothing

The Windows installer is not code-signed, and Windows tags files downloaded from
a browser. SmartScreen can hold the launch before the wizard draws its window,
so a double-click can end with no window, no tray icon, and no error.

1. Open **Downloads**, right-click `Pandu_<version>_x64-setup.exe`, and choose
   **Properties**. If a **Security** line says the file came from another
   computer, tick **Unblock**, then **Apply**.
2. Start the installer from PowerShell and watch for the wizard:

   ```powershell
   Start-Process "$env:USERPROFILE\Downloads\Pandu_0.2.0_x64-setup.exe" -Wait
   ```

   A normal window appears. If you see nothing, check the taskbar before
   assuming the launch failed.
3. Install silently and check the result:

   ```powershell
   Start-Process "$env:USERPROFILE\Downloads\Pandu_0.2.0_x64-setup.exe" -ArgumentList /S -Wait
   Test-Path "$env:LOCALAPPDATA\Pandu\Pandu.exe"
   ```

   `True` means the files are on disk even though no window appeared. `False`
   means the installer never ran; go back to step 2 and read the message it
   shows.
4. If the NSIS installer still refuses to run, use the MSI from the same
   release. It installs for all users, so Windows shows a UAC prompt and the
   account needs administrator rights.

The installer is 64-bit and needs Windows 10 or newer with the WebView2
Runtime, which the installer fetches when it is missing.

## Windows says “Windows protected your PC”

This is Microsoft SmartScreen, not a Pandu error. It appears for files that
are new or not code-signed.

1. Confirm you downloaded the file from the official GitHub release page.
2. Verify its SHA-256 against `SHA256SUMS` (see [en.md](en.md#verify-the-download-first)).
3. Only if the hash matches, choose **More info**, then **Run anyway**.
4. If the hash does not match, delete the file. Do not bypass the warning.

Release builds are unsigned unless the release notes say an Authenticode
certificate was used. The project does not buy a certificate just to silence
the prompt, and it will never ask you to disable SmartScreen.

## The app does not start, or shows a blank window

1. Wait five seconds. The first launch starts the embedded daemon and creates
   the database; a cold start can take a moment.
2. Start Pandu from the Start menu again. A second launch focuses the existing
   window instead of starting a second copy.
3. Check the tray. The window may be hidden there.
4. If the window is blank, press `Ctrl+R` to reload the bundled UI. The UI is
   local; a reload does not download anything.
5. Launch Pandu from PowerShell to see the log on stderr:

   ```powershell
   & "$env:LOCALAPPDATA\Pandu\Pandu.exe"
   ```

   That is the default location for the NSIS installer. If you used the MSI or
   moved the app, right-click the Start menu shortcut and open its file
   location.
6. Set `PANDU_LOG=debug` before launching to get more detail:

   ```powershell
   $env:PANDU_LOG = "debug"
   & ".\Pandu.exe"
   ```

7. If the app still exits, install the WebView2 Runtime (next section).

## WebView2 is missing

The Tauri shell uses Microsoft Edge WebView2. Current Windows 10 and 11 include
it. The NSIS installer downloads the Evergreen bootstrapper when it is missing,
so the install needs the internet once.

To check or repair it manually:

1. Open **Settings > Apps > Installed apps** and search for **Microsoft Edge
   WebView2 Runtime**.
2. If it is missing, install the Evergreen Runtime from
   <https://developer.microsoft.com/microsoft-edge/webview2/>.
3. Restart Pandu.

The portable build cannot download WebView2. Install the runtime first, then
run `Pandu.exe`.

## The app says the daemon could not start

The desktop app starts the daemon in-process. It can fail for three common
reasons.

### Another Pandu already uses the port and data directory

If you run `pandu serve` on the same port and home, the app attaches to it
instead of starting a second writer. If the app cannot confirm that the
listener is a compatible Pandu daemon, it refuses to attach.

- Quit the other daemon, or
- Start the app with a different port:

  ```powershell
  $env:PANDU_PORT = "4321"
  & ".\Pandu.exe"
  ```

### Another program owns the port

Check the default port:

```powershell
Get-NetTCPConnection -LocalPort 4319 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
```

If something else owns it, either stop that program or set `PANDU_PORT` to a
free port before launching Pandu. The desktop app uses an ephemeral port by
default, so this mainly affects an explicit `PANDU_PORT`.

### The data directory is not writable

Pandu needs to create `%USERPROFILE%\.pandu` and its database. Check that your
user account can write there:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.pandu" | Out-Null
Test-Path "$env:USERPROFILE\.pandu"
```

If the folder is on a read-only drive or blocked by security software, move it
with `PANDU_HOME`:

```powershell
$env:PANDU_HOME = "D:\PanduData"
& ".\Pandu.exe"
```

Keep the path local. Do not put the database on a network share; SQLite locking
is unreliable there.

## The window closed but Pandu is still running

That is intentional. Closing the window hides it to the notification area so
the recorder keeps working.

- Double-click the tray icon, or right-click and choose **Open Pandu**.
- To stop recording, right-click the tray icon and choose **Quit Pandu**.
- If the tray icon is hidden, open the overflow arrow in the taskbar and drag
  the Pandu icon onto the visible tray.

## A deep link does nothing

1. Confirm Pandu is installed, not only extracted as a portable build. The
   `pandu://` scheme is registered by the installer.
2. Check the link shape: `pandu://flights/<id>`. Unknown paths are ignored on
   purpose.
3. If you just installed Pandu, sign out and back in, or restart Explorer, so
   Windows refreshes the URL association.
4. For a portable build, run Pandu first, then use the link.

## The firewall asks about Pandu

Pandu listens on loopback by default. Windows may still show a firewall prompt
the first time the remote listener starts.

- If you do not use remote access, choose **Cancel**. Loopback recording keeps
  working.
- If you use Tailscale, allow **Private networks** only. Do not expose the
  listener to **Public networks**.
- Never forward port `4320` on your router. Use `tailscale serve` or another
  authenticated tunnel.

## Remote access does not work

1. Confirm remote access is on: the host UI shows a persistent banner and a
   **Panic** button.
2. Confirm the remote listener is running:

   ```powershell
   Get-NetTCPConnection -LocalPort 4320 -ErrorAction SilentlyContinue |
     Select-Object LocalAddress, LocalPort, State
   ```

3. From the computer, test the listener directly:

   ```powershell
   Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4320/remote/health
   ```

   A JSON response means the listener is up. `404` can mean remote access is
   off or the path is wrong.
4. From the phone's browser, open the HTTPS URL. If it does not load, the
   tunnel is the problem, not Pandu.
5. Check that the tunnel points at port `4320`, not `4319`. Port `4319` is the
   loopback host listener and is not meant to be exposed.
6. If you changed networks, restart `tailscale serve` and copy the new URL.
7. Press **Panic** if you suspect a device is compromised. It stops the
   listener, revokes every device, and closes open sockets.

## QR pairing fails

The QR payload must contain an HTTPS URL, a 32-character lowercase hex code,
and an optional fingerprint.

- **“Invalid pairing code”**: the code expired or was already used. Generate a
  new one on the computer. Codes are single use.
- **“Host must be HTTPS”**: use the `tailscale serve` URL. Release builds block
  cleartext HTTP. The Android emulator may use `10.0.2.2` or `127.0.0.1` in a
  debug build only.
- **“Fingerprint does not match”**: you may be pairing with a different host,
  or a proxy is rewriting the connection. Stop and compare the host and
  fingerprint on both screens.
- **Camera does not open**: grant camera permission in **Settings > Apps >
  Pandu > Permissions**, or type the host and code manually.
- **The phone waits forever**: confirm the computer shows the same verification
  code. If it does not, the phone cannot reach the host; test the HTTPS URL in
  the phone browser.
- **Pairing is denied on the computer**: the host rejected the request. Start
  again and confirm the device name and verification code.

## Notifications do not arrive on Android

1. Open **Settings > Apps > Pandu > Notifications** and confirm the channel you
   need is not muted. Channels are `pandu_guard_critical`,
   `pandu_guard_high`, `pandu_guard_normal`, and `pandu_pairing`.
2. On Android 13+, confirm the app has the notification permission.
3. Set battery usage to **Unrestricted** (see
   [android.md](android.md#battery-optimisation)).
4. Remember the background check runs at most every 15 minutes. A notification
   can be delayed. Keep the app open for live updates.
5. If the phone was rebooted, WorkManager reschedules itself. Open the app once
   after a reboot to confirm the pairing is still valid.
6. If the device token was revoked on the computer, the app cannot fetch
   approvals. Pair again.

## The PWA does not install

- The page must be served over HTTPS. `http://` pages cannot register a service
  worker or show an install prompt.
- Use Chrome or Edge on Android/desktop, or Safari on iOS. Firefox does not
  show the install prompt, but the page still works.
- If you cleared site data, reload once and wait for the service worker to
  install.
- On iOS, installation is always manual: **Share > Add to Home Screen**.
- If the manifest fails to load, check the browser console. A reverse proxy
  that rewrites paths can break `manifest.webmanifest` and the icons.

## The phone says the connection is not private

This usually means the tunnel certificate does not match the hostname.

- Use the exact HTTPS URL Tailscale printed, including the MagicDNS name.
- Do not use the machine's LAN IP over HTTPS; the certificate is for the
  tailnet name.
- Check the phone's clock. A large clock skew breaks certificate validation.
- If you use a self-signed certificate, install the CA on the phone or switch
  to `tailscale serve`. Pandu does not add certificate exceptions.
- Do not tap through a certificate warning on a network you do not control.

## Reset Pandu without losing your data

Stop Pandu first, then try the least destructive step.

1. **Reload the UI:** close and reopen the window, or press `Ctrl+R`.
2. **Restart the daemon:** quit from the tray, then start Pandu again.
3. **Keep a backup:** run `pandu backup --out <folder>` before changing
   anything. The backup contains the database and settings.
4. **Reset only settings:** settings live in the database, not in a separate
   file. Change them back in **Settings**, or restore a backup with
   `pandu restore <archive>`. Flights are not affected by a settings change.
5. **Reset everything:** close Pandu, rename `%USERPROFILE%\.pandu` to
   `%USERPROFILE%\.pandu.old`, then start Pandu. It creates a fresh database.
   Delete the old folder only after you confirm you do not need it.

Do not delete the database while Pandu is running. SQLite may be mid-write.

## Find the data directory

The default is:

```text
%USERPROFILE%\.pandu
```

The active database is `%USERPROFILE%\.pandu\v2\pandu.db`. Settings, snapshots,
backups, adapters, and update state live under the same tree.

If you set `PANDU_HOME`, that path is used instead. To see the exact path:

```powershell
pandu doctor
```

The output starts with the version and then a `home` line. That is the active
data directory.

## Collect a diagnostic report

`pandu doctor` prints a short local summary. `pandu report` writes a fuller
Markdown or JSON report:

```powershell
pandu doctor
pandu report --out .\pandu-report.md
```

The report contains paths, versions, counts, adapter status, and warnings. It
does not contain prompt text, terminal output, API keys, or device tokens.
Nothing is uploaded. Read it before sharing it; local paths can still identify
your machine.
