# Install the Pandu web app (PWA)

The Pandu web app is the same remote dashboard as the Android companion, opened
in a browser. You can install it to your home screen or desktop so it opens in
its own window. It is optional, and it is not a replacement for the desktop app
on the computer that records your agents.

**Contents**

- [What you need](#what-you-need)
- [Turn on HTTPS](#turn-on-https)
- [Open and install](#open-and-install)
- [Pair the device](#pair-the-device)
- [What the service worker caches](#what-the-service-worker-caches)
- [Limitations](#limitations)
- [Update and remove](#update-and-remove)

## What you need

- A computer running Pandu with remote access enabled.
- An HTTPS URL that reaches the computer. `tailscale serve` is the supported
  default.
- A current browser: Chrome, Edge, Safari, or Firefox. Installation prompts
  are available in Chromium-based browsers and Safari; Firefox can still use
  the page without installing it.

The PWA does **not** work over plain HTTP, except on `localhost` during
development. Browsers require a secure context for service workers and
installation.

## Turn on HTTPS

1. On the computer, open **Settings > Remote access**.
2. Choose **Tailscale** and run the command Pandu shows:

   ```powershell
   tailscale serve --bg http://<tailnet-ip>:4320
   ```

3. Copy the HTTPS URL. It looks like
   `https://<machine>.<tailnet>.ts.net`.
4. Open that URL on the phone or the other computer.

Pandu serves the remote dashboard and its assets from the local `ui/dist`
directory. The host listener on port `4319` stays on loopback; the remote
listener on port `4320` is the one Tailscale forwards to.

A Cloudflare tunnel or another trusted HTTPS reverse proxy works the same way.
Do not expose port `4320` directly to the public internet.

## Open and install

### Android or iOS

1. Open the HTTPS URL in Chrome (Android) or Safari (iOS).
2. **Android Chrome:** tap the three-dot menu and choose **Install app** or
   **Add to Home screen**.
3. **iOS Safari:** tap **Share**, then **Add to Home Screen**. iOS does not show
   a browser install prompt.
4. Open the new icon. It runs in its own window without browser chrome.

Pandu also shows a small install prompt inside the app when the browser fires
`beforeinstallprompt`. Choosing **Install** there does the same thing. Choosing
**Not now** hides the prompt until the next launch.

### Desktop

1. Open the HTTPS URL in Chrome or Edge.
2. Click the install icon in the address bar, or use the three-dot menu >
   **Install Pandu**.
3. The app opens in its own window.

## Pair the device

1. On the computer, open **Settings > Remote access > Pair a device**.
2. On the PWA, enter the HTTPS host and the 32-character pairing code, or scan
   the QR code if your browser and device support it.
3. Optionally set a 6–12 digit PIN for high-risk approvals.
4. Confirm the device on the computer and compare the verification code.

The PWA has no Android Keystore. The device token is kept in the browser's
storage for that origin and is cleared when you clear site data or choose
**Forget this device**. Treat a browser profile like a password: anyone with
access to it can use the paired scopes. On a shared computer, do not pair the
PWA.

## What the service worker caches

The service worker caches the **app shell only**:

- the HTML entry points,
- the compiled JavaScript and CSS,
- the icons and the web manifest.

It never caches API responses, flight content, prompts, terminal output,
screenshots, or anything under the daemon's API paths. When the network is
unavailable, the app shell may open, but every data request fails visibly. Pandu
does not show stale flights as if they were current.

To update the shell, close every Pandu tab and reopen the app. The service
worker fetches a new shell in the background and activates it on the next
launch.

## Limitations

- **Remote access must already be on.** The PWA cannot enable it.
- **The computer must be reachable.** Tailscale or another tunnel must be
  running. If the computer sleeps, the PWA cannot connect.
- **No background notifications.** A browser tab must be open to receive live
  updates. For background notifications, use the Android companion.
- **No agent control.** The PWA can watch flights and answer approvals within
  its scopes. It cannot start agents, change settings, or manage devices.
- **No offline flight history.** Only the shell is cached.
- **Browser storage can be cleared.** Clearing site data unpairs the browser;
  pair it again from the computer.

## Update and remove

- **Update:** reload the page. The new service worker takes over on the next
  launch.
- **Remove the installed app:** uninstall it from the home screen or the
  browser's app list. This removes the shortcut, not the pairing.
- **Unpair:** choose **Forget this device** in the app, then revoke the device
  on the computer under **Settings > Remote access**. Clearing site data alone
  does not revoke the token on the host.
