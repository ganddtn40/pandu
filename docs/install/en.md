# Install Pandu

Pandu is a local flight recorder and control tower for AI coding agents. It
runs on your computer, records what your agents do, and keeps every flight,
setting, and paired device on your machine. There is no account, no cloud sync,
and no telemetry.

This guide covers the Windows desktop app, the Android companion, and the
installable web app (PWA). Pick the part you need. Every command is safe to
copy and paste.

**Contents**

- [What you need](#what-you-need)
- [Windows desktop app](#windows-desktop-app)
- [Android companion](#android-companion)
- [Installable web app (PWA)](#installable-web-app-pwa)
- [Command-line tool](#command-line-tool)
- [Troubleshooting](#troubleshooting)

## What you need

| Part | Requirements |
| --- | --- |
| Windows app | Windows 10 or 11, 64-bit. Microsoft Edge WebView2 (included with current Windows; the installer can download it). |
| Android companion | Android 10 or newer. A network path from the phone to your computer: `tailscale serve` or another HTTPS tunnel. |
| PWA | A current Chrome, Edge, Safari, or Firefox. The page must be served over HTTPS. |
| Computer running Pandu | Windows, macOS, or Linux for the daemon and CLI. The desktop shell is Windows-only in this release. |

You do **not** need administrator rights for the recommended Windows
installer, and you do **not** need an account anywhere.

## Windows desktop app

### Choose the file

Download these from the same GitHub release page. Do not mix files from
different releases.

| File | Use it when |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **Recommended.** Per-user install, no administrator prompt. |
| `Pandu_0.2.0_x64_en-US.msi` | You deploy software for an organisation. Per-machine install; needs administrator rights. |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | You want no installer at all. Extract and run. |

The version number in the file name changes with each release. Use the newest
stable release unless the release notes say otherwise.

### Verify the download first

Every release includes a file named `SHA256SUMS`. Download it next to the
installer, then open PowerShell in that folder:

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

The two hashes must match exactly. If they do not, delete the file and download
it again. Do not run a file whose hash does not match, even if the page looks
official.

### Install (recommended, per-user)

1. Double-click `Pandu_0.2.0_x64-setup.exe`.
2. If Windows shows **Windows protected your PC**, choose **More info**, then
   **Run anyway**. Only do this when the file came from the official release
   page and its SHA-256 matched in the previous step. Release builds are
   unsigned unless the release notes say an Authenticode certificate was used.
3. Follow the installer. It installs for your user account and does not ask for
   administrator rights.
4. If WebView2 is missing, the installer downloads Microsoft's Evergreen
   bootstrapper. This is the only time the installer needs the internet.
5. Start Pandu from the Start menu.

The installer does not add a startup entry. Autostart is **off by default**.

### First run

The Pandu window opens and starts the local daemon. The daemon listens on a
free loopback port, so it is reachable only from your computer. The UI is
bundled inside the app; Pandu does not load remote web content.

- **Closing the window does not quit.** Pandu keeps running in the notification
  area so it can keep recording. Use the tray icon to reopen it.
- **Quitting is explicit.** Right-click the tray icon and choose **Quit
  Pandu**. If you quit, agents are no longer recorded until you start Pandu
  again.
- **Autostart.** Right-click the tray icon and tick **Start Pandu with
  Windows** if you want it to start at sign-in. Untick it to turn autostart
  off again.
- **Your data** lives in `%USERPROFILE%\.pandu`. The database is
  `%USERPROFILE%\.pandu\v2\pandu.db`; settings, snapshots, and backups are in
  the same tree.

### Deep links

Pandu registers the `pandu://` URL scheme. A link such as

```text
pandu://flights/<flight-id>
```

opens the desktop app on that flight. Links from other apps are validated
before use: unknown paths and unsafe segments are ignored. Pandu never opens
arbitrary remote pages from a link.

### MSI for managed deployment

The MSI is a per-machine install. It is intended for IT departments that
already deploy software with Group Policy, Intune, or another package manager.

- It needs administrator rights.
- It installs for every user on the computer.
- User data still lives in each user's `%USERPROFILE%\.pandu`.
- The NSIS uninstall question about deleting data does not apply to the MSI.
  After uninstalling the MSI, delete `%USERPROFILE%\.pandu` manually only if
  you also want to remove flights and settings.

### Portable build

1. Extract `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` to a folder you
   control.
2. Run `Pandu.exe`. No installer and no administrator rights are required.
3. WebView2 must already be installed. Current Windows includes it; if Pandu
   does not start, install the Evergreen Runtime from
   <https://developer.microsoft.com/microsoft-edge/webview2/>.
4. To remove it, quit from the tray, delete the folder, then delete
   `%USERPROFILE%\.pandu` only if you also want to remove your data.

### Uninstall

1. Quit Pandu from the tray.
2. Open **Settings > Apps > Installed apps**, find **Pandu**, and choose
   **Uninstall**.
3. The uninstaller asks whether to delete `%USERPROFILE%\.pandu`. The default
   is **No**. Choose **No** to keep your flights, settings, snapshots, backups,
   and paired devices. Choose **Yes** only if you want them permanently gone.
4. Silent uninstalls always keep the data folder.

## Android companion

The companion is a small, scoped dashboard for your phone. It can watch flights
and answer approval requests, but it cannot start agents or change settings.
It is optional.

The short version:

1. On the computer, open **Settings > Remote access** and turn remote access
   on. Choose the Tailscale mode and run the `tailscale serve` command Pandu
   shows you.
2. Download the signed APK from the same release page.
3. Allow your browser or file manager to install unknown apps, then open the
   APK.
4. Open Pandu on the phone and scan the pairing QR code shown on the computer.
5. Approve the device on the computer. New devices start with **Status** only.

The full guide, including permissions, battery settings, notification
channels, and `apksigner` verification, is in
[android.md](android.md).

## Installable web app (PWA)

The PWA is the same remote dashboard, installed from a browser. It needs an
HTTPS URL that reaches your computer, normally from `tailscale serve`.

The short version:

1. Turn on remote access on the computer and start `tailscale serve`.
2. Open the HTTPS URL on your phone or another computer.
3. Use the browser menu and choose **Install app** or **Add to Home Screen**.
4. Pair the device with the code shown on the computer.

The full guide, including the caching rules and limitations, is in
[pwa.md](pwa.md).

## Command-line tool

The `pandu` CLI is separate from the desktop app. Install it if you want to run
the daemon yourself, use `pandu run -- <agent>`, or run diagnostics.

1. Download `pandu-cli-x86_64-pc-windows-msvc.zip` and `SHA256SUMS`.
2. Verify the archive with `Get-FileHash`, as shown above.
3. Extract it. The zip contains a `pandu-cli-x86_64-pc-windows-msvc` folder
   with `pandu.exe`.
4. Put that folder on your `PATH`, or run `pandu.exe` by full path.

The release also includes `pandu-cli-installer.ps1`, which installs the CLI for
the current user. Read the script before running it if you want to know exactly
where it writes.

Useful first commands:

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` checks the database, adapters, log watcher, and a running
daemon. It prints only local information. `pandu pair` prints a short-lived
pairing code and the remote URL to use on the phone.

## Troubleshooting

If something does not work, read
[troubleshooting.md](troubleshooting.md). It covers SmartScreen, WebView2, port
conflicts, firewall prompts, pairing failures, notification problems, and how
to reset Pandu without losing your data.

## Privacy in one paragraph

Pandu records locally. The desktop app talks only to the daemon on loopback.
Remote access is off by default and can only be enabled from the computer.
Update checks are one HTTPS request to GitHub at most once every 24 hours and
can be turned off. There is no telemetry, no cloud sync, and no background
upload. See [privacy.md](../privacy.md) for the full statement.
