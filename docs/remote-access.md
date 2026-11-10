# Remote access

Status: Phase 7. Remote access is optional, **off by default**, and can be
switched off or revoked at any time from the computer running Pandu.

This guide is written for someone who has never used Tailscale or a Cloudflare
tunnel. Follow one option, then pair your phone. If you only read one section,
read [Safety rules](#safety-rules) and [Pairing a device](#pairing-a-device).

![Remote access is off](screenshots/phase7/01-host-remote-off.png)

## What remote access is

Remote access lets a phone or another computer open a small, separate Pandu
dashboard. It is for checking on work while you are away:

- See recent flights, running agents, and terminal output.
- See pending approvals.
- Approve or deny guarded actions (with the Respond scope).
- Send a prompt into an agent session that is already running (with the Prompt
  scope).

It is **not** a remote desktop, a shell, or a way to start new agents. The
computer still owns the agent process, the terminal, and every decision. A
paired device cannot:

- start, stop, or spawn a process;
- change settings, adapters, rules, or budgets;
- pair another device or manage tokens;
- read the audit log (the host can export it);
- reach the model proxy (`/v1`, `/openai`, `/anthropic`, `/s/...`) — those
  paths return 404 on the remote listener;
- complete a sign-in, password, or two-factor prompt. Those always say
  **"Needs you at the computer."**

The remote listener is a second, separate HTTP listener. The normal Pandu
listener stays on loopback. Turning remote access off removes the second
listener; it does not change how the local app works.

## Safety rules

1. Remote access is off until you turn it on from **Settings → Remote access**
   on the computer. A remote device can never turn it on.
2. New devices start with **Status** only. Content is opt-in and can read code
   and anything your agent printed. You raise scopes per device, one at a time.
3. **Prompt** is the dangerous scope. The host warns you: *"Prompt lets this
   device make your agent run commands."*
4. High-risk approvals require a PIN you set when pairing. If no PIN was set,
   high-risk approvals must happen at the computer.
5. Sign-in and password prompts cannot be answered remotely.
6. The persistent banner at the top of Pandu shows when remote access is on,
   with a one-click **Panic** button. Panic stops the listener, revokes every
   device, and closes open sockets immediately.
7. Pandu never installs, starts, or bundles Tailscale or cloudflared. It only
   detects them and shows the command to run yourself.
8. Plain HTTP is used on loopback and, optionally, inside a tailnet. Use
   `tailscale serve` or a Cloudflare tunnel when you want browser HTTPS.

## Before you start

- Pandu must be running on the computer: `pandu serve` (or `pandu demo`
  for demo data).
- Open the local app at <http://127.0.0.1:4319> and go to
  **Settings → Remote access**.
- The remote listener uses port **4320** by default. If that port is busy,
  start the daemon with another port before enabling remote access:

  ```powershell
  $env:PANDU_REMOTE_PORT = "4321"
  pandu serve
  ```

  `PANDU_REMOTE_PORT=0` disables the remote listener for that daemon.
- If you build Pandu from source, build the UI once so the remote listener can
  serve it: `cd ui; pnpm install; pnpm build`. Packaged builds include it.

## Option A — Tailscale (recommended)

Tailscale creates a private network between your own devices. Pandu binds only
the tailnet address, never `0.0.0.0`, and the traffic is encrypted by
WireGuard. This is the easiest option to use safely.

### A1. Install Tailscale on both devices

1. Create a free account at <https://tailscale.com>.
2. Install Tailscale on the computer that runs Pandu:
   <https://tailscale.com/download>.
3. Install the Tailscale app on your phone from the App Store or Play Store.
4. Sign in to the **same account** on both devices.

### A2. Connect the computer

Open a terminal on the computer and run:

```powershell
tailscale up
```

Follow the sign-in link if Tailscale asks. Then check the address:

```powershell
tailscale ip -4
```

You should see an address starting with `100.`. That is the tailnet address
Pandu will bind.

### A3. Enable Pandu

1. In Pandu, open **Settings → Remote access**.
2. Choose **Tailscale**.
3. The card should show **Detected** and the `100.x` address. If it says
   **Not detected**, install Tailscale, reopen the terminal, and restart
   Pandu.
4. Optional but recommended: run the `tailscale serve` command shown in the
   card. It looks like:

   ```powershell
   tailscale serve --bg http://100.x.y.z:4320
   ```

   Tailscale then prints an HTTPS address such as
   `https://your-computer.your-tailnet.ts.net`. Use that address on your phone.
   If you skip this step, use `http://100.x.y.z:4320`; it is still private to
   the tailnet, but the browser will not show a padlock.
5. Click **Enable remote access**. The status changes to **Listening**.

![Remote access on](screenshots/phase7/02-host-remote-on.png)

> The pairing QR always contains the direct tailnet URL. If you want HTTPS,
> open the `https://…ts.net` address from `tailscale serve` on the phone and
> enter the same pairing code there. The code is not tied to one URL.

### A4. Pair your phone

See [Pairing a device](#pairing-a-device).

## Option B — Cloudflare tunnel (works anywhere, public URL)

Use this when the phone is not on the same tailnet. The tunnel URL is reachable
from the public internet, so Pandu authentication is always required. For
regular use, prefer a **named tunnel with Cloudflare Access** instead of a quick
tunnel.

### B1. Install cloudflared

Install `cloudflared` from the Cloudflare documentation:
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>.

Pandu does not install it for you. After installing, reopen the terminal so
Pandu can detect it on `PATH`.

### B2. Start the tunnel

In a terminal on the computer, run the exact command shown in the Pandu card.
It looks like:

```powershell
cloudflared tunnel --url http://127.0.0.1:4320
```

The tunnel prints a public URL such as
`https://random-words.trycloudflare.com`. Leave this terminal running.

> A quick tunnel is public and temporary. Anyone with the URL can reach the
> Pandu sign-in page, but they still need a paired device token. A named
> tunnel with Cloudflare Access adds an identity check in front of Pandu.

### B3. Enable Pandu

1. In **Settings → Remote access**, choose **Cloudflare tunnel**.
2. Paste the public URL into **Public URL**.
3. Read the warning: *"This URL is reachable from the public internet."*
4. Click **Enable remote access**.
5. Pair your phone using the QR code or the URL and code.

Pandu binds only `127.0.0.1:4320` in this mode; `cloudflared` makes the
outbound connection. Do not expose the remote port directly on your router.

## Option C — Local network (discouraged)

This mode is for a phone on the same Wi-Fi when Tailscale is not an option. It
is the least private choice.

- Pandu binds only the detected LAN address (for example
  `192.168.1.20:4320`), never `0.0.0.0`.
- The listener uses a self-signed TLS certificate. Your phone will show a
  certificate warning.
- Anyone on the same Wi-Fi can reach the sign-in page. They still need a paired
  token, but the page is visible.
- The pairing QR includes the certificate fingerprint. Compare the fingerprint
  in the phone's certificate warning with the one shown on the host before you
  continue.

The certificate and key live under `$PANDU_HOME/remote-tls/`. Deleting them
makes Pandu generate a new certificate and fingerprint the next time LAN mode
starts.

If you can use Tailscale, use Tailscale instead.

## Pairing a device

Pairing is always a two-step flow: the device asks, and the host confirms.

1. On the computer, with remote access on, click **Pair a device**.
2. Pandu shows a **pairing code** and a QR code. The code is 128 bits of
   randomness, works **once**, and expires in **two minutes**.

   ![Pairing code and QR](screenshots/phase7/03-host-pairing-code.png)

3. On the phone, open the remote URL (scan the QR or type the URL).
4. Enter the pairing code and a device name, for example `Pixel 8`.
5. Set a **high-risk PIN** of 6–12 digits. You will need this PIN to approve or
   deny high-risk actions from this device, and the phone keeps only its slow
   Argon2id hash. Without a PIN, high-risk approvals must happen at the computer.
6. Tap **Send pairing request**. The phone shows a **four-digit verification
   code** and says *"Waiting for the host to confirm…"*. Compare that code with
   the one on the computer.
7. On the computer, Pandu shows **Pair Pixel 8?** with the same four-digit
   code, the request IP when it can be trusted, and whether a PIN is set. Choose
   how long the device stays paired — **7, 14, 30, or 90 days** (Tunnel defaults
   to 14 days; Tailscale and LAN default to 30). Type the code and click
   **Confirm pairing**. A tunnel request without a validated forwarded address
   says the client address is unavailable rather than showing the local tunnel
   connector.

   ![Host confirms the device by name and verification code](screenshots/phase7/04-host-pair-confirm.png)

8. The device receives its token exactly once and shows a summary: it starts
   with **Status** only, cannot read content, and explains what the PIN does.
   Open the dashboard from there.

   ![Paired device dashboard](screenshots/phase7/05-remote-paired-dashboard.png)

If the code expires, create a new one. A code cannot be reused, and a denied
request never receives a token. Only one code is active at a time — creating a
new one replaces the old code. Up to three requests can wait for the host at
once; answer or deny one before another device can join the queue.

### What the device stores

The device keeps its bearer token in the browser's local storage for that
origin. The host stores only a SHA-256 hash of the token. The token is sent in
the `Authorization: Bearer …` header, never in a URL or query string. The live
WebSocket uses a 30-second, single-use ticket in the
`Sec-WebSocket-Protocol: pandu.<ticket>` header, never in the URL.

Tokens have a per-device expiry chosen at pairing (7, 14, 30, or 90 days) and
shown in the device list as **Access until …**. The token is also rotated on
use: after the first authenticated request, the host returns a replacement in
the `X-Pandu-Token` response header. The old token stays valid for a short
120-second overlap so in-flight requests cannot race the device out of its
session; after that it stops working. The UI stores the replacement
automatically. You can still rotate or revoke a token at any time from the host.

## Scopes

Scopes are enforced by the daemon, not by hiding buttons in the UI.

| Scope | What it allows | Notes |
| --- | --- | --- |
| **Status** (`view:status`) | See flights, sessions, agents, costs, counts, pending approvals, and inbox events. | Every device starts here. Titles are neutral (`Flight 7 · Claude Code`); prompts, commands, paths, terminal text, tags, and metadata are redacted. |
| **Content** (`view:content`) | Read terminal output, steps, diffs, prompts, and responses. | Opt-in. The host warns: *"Content can read code and anything your agent printed."* |
| **Respond** | Approve or deny guarded actions. | High-risk actions also need the pairing PIN. |
| **Prompt** | Type into an agent session that is already running. | The host warns: *"Prompt lets this device make your agent run commands."* |

Raise scopes per device in **Settings → Remote access → Devices**. Lowering a
scope takes effect on the next request and on the next live message. No scope
grants host management, settings, pairing, token rotation, audit access, or
model-proxy access.

### High-risk approvals

An approval is high risk when its severity is High or Critical, or when it is a
dangerous command. From a remote device:

- If the device has a PIN, the phone asks for it before approve or deny.
- If the device has no PIN, the action must be completed at the computer.
- A wrong PIN is rate-limited and audited. Five wrong PINs lock Respond for
  that device with **423 respond_locked**; the host must click **Reset Respond**
  in the device list to clear the lock.
- Replayed or expired approvals are refused.

Sign-in, password, API-key, and two-factor prompts are never sent to a remote
device as something it can answer. The phone shows **"Needs you at the
computer"** and the host does the sign-in in the agent's terminal.

## Remote prompts

A prompt from a phone is only keystrokes into a session that the Pandu CLI is
already running. It cannot start a new process or choose a working directory.

- Maximum 2,000 characters; NUL is rejected.
- Limited to 6 prompts per minute per device.
- **Require host confirmation for remote prompts** is **on by default**. The
  prompt waits in **Pending remote prompts** on the host until you approve it.
- If you turn confirmation off for a device, the prompt is queued as keystrokes
  plus Enter immediately.
- The host sees **"Remote prompt sent from Pixel 8"**, the byte size, and a
  SHA-256 prefix. The prompt text is held in memory only until you decide, and
  it is never written to the audit log.
- A remote prompt cannot answer a sign-in or password prompt.

## Managing devices

The **Devices** section lists each device by name, its scopes, when it was last
seen, when its access expires, and whether it is active or revoked.

- **Raise/lower scopes** — changes are saved per device. Granting Prompt shows
  the plain-language warning.
- **Change access** — set a new 7, 14, 30, or 90-day expiry. The countdown
  restarts from the moment you save.
- **Rotate token** — creates a new token and stops the old one immediately. The
  new token is shown once; copy it to the device.
- **Revoke** — the device's open tabs and WebSockets stop working immediately.
  Pair again to restore access.
- **Panic** — stops the remote listener, revokes every device, and clears
  pending prompts. Use this if a phone is lost or you are unsure.

Remote access does **not** start automatically when the daemon restarts. Paired
devices stay in the database, but you must turn remote access on again from the
host. This is intentional.

## Audit log

Every sensitive transition is appended to a local audit log:

- pairing code created, requested, confirmed, denied, or failed;
- device revoked, rotated, expired, or scope changed;
- device access expiry changed;
- login failures and expired tokens;
- every approve and deny;
- every remote prompt (size and hash only, never text);
- remote access enabled/disabled, panic, and the revoke-on-disable setting;
- notification settings changed.

The log is viewable and exportable as JSON from **Settings → Remote access**.
It is host-only; a paired device cannot read it. It never contains tokens,
passwords, prompt text, or terminal output.

Each entry also stores the previous entry's hash and its own SHA-256 hash, so the
log forms a chain. Verify it from the computer at any time:

```powershell
pandu audit verify
pandu audit verify --json
pandu audit verify --database C:\path\to\pandu.db
```

The command prints the number of entries and exits with a non-zero status at the
first entry that no longer matches its hash or its predecessor. The chain detects
accidental or casual edits; it cannot stop a process that can rewrite the whole
database, so keep an exported copy if you need an external record.

![Audit log](screenshots/phase7/06-host-audit.png)

## Phone notifications (ntfy)

Pandu can send an optional ntfy ping when a device is waiting for pairing,
sends a prompt for confirmation, or needs a decision. This is **off by
default**.

- The payload is generic: *"A device is waiting for pairing confirmation."*,
  *"A paired device sent a prompt that needs host confirmation."*, or
  *"A paired device needs a decision."* It contains no prompt text, device name,
  project name, or path.
- The topic is 256 bits of random data, not a guessable word.
- **Public ntfy.sh is a third party.** It sees the topic and timing. If that
  matters, self-host ntfy and set the server URL to your own HTTPS server (or
  `http://127.0.0.1` for a local test).
- Configure it under **Settings → Remote access → Phone notifications**. Use
  **Send test** to verify.

## Turning remote access off

- **Turn off remote access** in Settings stops the listener. Paired devices
  remain in the database for next time. Turn on **Revoke all devices when remote
  is turned off** if you want turning it off to revoke every device and token;
  it is off by default.
- **Panic** stops the listener *and* revokes every device. Use Panic when a
  device is lost or you suspect a token leaked.
- Quitting the daemon also stops the remote listener. The next daemon start
  begins with remote access off.
- If you suspect the host itself is compromised, stop Pandu, remove the
  `remote_devices` rows only if you know what you are doing, and review the
  audit export. The supported path is Panic, then pair again.

## Troubleshooting

### The phone cannot reach the URL

- Is the daemon running? Open <http://127.0.0.1:4319> on the computer.
- Is remote access **Listening** in Settings? It does not auto-start after a
  daemon restart.
- Tailscale: are both devices signed in to the same tailnet? Run
  `tailscale status` on the computer and check that the phone is listed.
- Cloudflare: is the `cloudflared` terminal still running? Quick tunnel URLs
  change when it restarts; paste the new URL and enable again.
- LAN: is the phone on the same Wi-Fi? Some guest networks block device-to-
  device traffic.
- Check the firewall. Pandu binds only the chosen address, but the OS may
  still need to allow the port on a private network.

### Tailscale is not detected

- Install it from <https://tailscale.com/download> and reopen the terminal.
- Run `tailscale up` and complete the sign-in.
- Restart Pandu so it re-detects the tool and address.
- If Tailscale is installed but not connected, Pandu refuses to enable
  Tailscale mode; that is deliberate.

### cloudflared is not detected

- Install it and reopen the terminal (or restart Pandu).
- Run the exact command shown in the card. The port must match
  `PANDU_REMOTE_PORT` (default 4320).
- A quick tunnel URL is public. Do not paste it into a chat or screenshot
  without thinking about who can see it.

### The phone shows a certificate warning (LAN mode)

That is expected: LAN mode uses a self-signed certificate. Compare the
fingerprint in the warning with the one shown in Pandu. If they match, you can
continue. If you do not want to see this warning, use Tailscale with
`tailscale serve` or a Cloudflare tunnel.

### The pairing code expired

Codes last two minutes and work once. Click **Pair a device** again and use the
new code. A denied request cannot be retried with the same code.

### The host never shows "Pair <name>?"

- Keep **Settings → Remote access** open on the host.
- Check **Pending pairing requests**; refresh the card.
- The device may have used an expired code, or the request may have been
  rate-limited after too many wrong codes. Create a fresh code.

### The remote page shows a placeholder instead of Pandu

The remote listener serves the built UI from `ui/dist`. Build it with
`pnpm build` in `ui/`, or point `PANDU_UI_DIR` at a built UI directory, then
restart the daemon.

### A remote page returns 404

Only the remote dashboard and `/api/remote/*` exist on the remote listener.
Model proxy paths (`/v1`, `/openai`, `/anthropic`, `/s/...`) and host management
routes are intentionally absent. Use the local Pandu URL for those.

### "Needs you at the computer"

Sign-in, password, API-key, and two-factor prompts cannot be completed from a
remote device. Go to the computer and use the agent's own terminal.

### The device was revoked

Revocation is immediate and closes open sockets. Pair the device again with a
new code. If you did not revoke it, use Panic and review the audit log.

### The remote port is busy

Change `PANDU_REMOTE_PORT` before starting the daemon, then re-enable remote
access. The suggested `tailscale serve` and `cloudflared` commands use the
configured port.

## Command-line pairing (optional)

The Settings screen is the normal path, but `pandu pair` exists for terminals
and scripts.

Host side — issue a code through the local daemon:

```powershell
pandu pair
```

Device side — claim the code from another machine or terminal:

```powershell
pandu pair --claim ABCD-EFGH --url https://your-remote-url --device-name "Phone" --pin 123456
```

The device prints a four-digit verification code; compare it with the host
before confirming. The host still has to confirm the device in **Settings →
Remote access**. The device prints its token once. `--pin` is optional but must
be 6–12 digits; without it, high-risk approvals must happen at the computer.

## Endpoints and scopes

The remote listener exposes only the routes below. The same matrix is shown in
**Settings → Remote access → Endpoints and scopes**.

| Method | Endpoint | Scope | Note |
| --- | --- | --- | --- |
| GET | `/api/remote/health` | view:status | 404 unless loopback or a valid device token; version only when authenticated |
| POST | `/api/remote/pair/claim` | none | Pairing code + device name |
| POST | `/api/remote/pair/claim/{id}` | none | One-time claim secret |
| GET | `/api/remote/session` | view:status | This device's scopes |
| GET | `/api/remote/overview` | view:status | Flights and totals; neutral titles without `view:content` |
| GET | `/api/remote/sessions` | view:status | Flight list; neutral titles without `view:content` |
| GET | `/api/remote/sessions/{id}` | view:status | Flight detail; redacted without `view:content` |
| GET | `/api/remote/sessions/{id}/steps` | view:content | Captured steps, prompts, and responses |
| GET | `/api/remote/guards/events` | view:status | Pending and past approvals; status-only devices get severity, `ruleName`, and `Approval requested` |
| GET | `/api/remote/agents` | view:status | Running agent sessions; `workingDir` requires `view:content` |
| GET | `/api/remote/agents/{id}` | view:content | Sanitized terminal output |
| GET | `/api/remote/agent-events` | view:status | Inbox events; `message` and `metadata` require `view:content` |
| GET | `/api/remote/live` | view:status | WebSocket ticket in `Sec-WebSocket-Protocol`; content events need `view:content`; unknown payloads are dropped |
| POST | `/api/remote/ws-ticket` | view:status | 30-second single-use ticket |
| POST | `/api/remote/guards/events/{id}/decision` | respond | Approve or deny; high risk needs the pairing PIN |
| POST | `/api/remote/agents/{id}/prompt` | prompt | Keystrokes only; host confirmation by default |
| POST | `/api/remote/logout` | view:status | Revoke this device |

Everything else, including `/v1`, `/openai`, `/anthropic`, `/s/...`, and the
host management routes, returns 404 on the remote listener.

![Endpoints and scopes](screenshots/phase7/07-endpoints-scopes.png)

## Security details

The full threat model, per-scope stolen-token impact, revocation steps, and the
endpoints × scopes table live in [`security.md`](security.md). The short
version:

- Remote access is a separate listener and a separate router.
- Host controls stay on the computer and reject cross-site requests: every
  state-changing host call needs the loopback `Origin`, `Content-Type:
  application/json`, and a per-process CSRF token from `GET /api/csrf`. A
  cross-origin form or `no-cors` request cannot enable remote access, create a
  code, confirm a pairing, change scopes, decide an approval, revoke, or panic.
- Pairing is host-confirmed; the host must echo the device's four-digit
  verification code, and codes are single-use and short-lived.
- High-risk PINs are set on the device, must be 6–12 digits, and are stored as
  Argon2id hashes. Five wrong PINs lock Respond until the host resets it.
- Tokens are 256-bit, stored hashed, sent in a header, compared in constant
  time, rotated on use with a 120-second overlap, and expire at the per-device
  deadline (7, 14, 30, or 90 days). Revocation is immediate.
- Scopes are enforced server-side on every request and every live message.
- WebSocket upgrades check `Origin`, use a one-time ticket, and re-check scope
  and revocation.
- Security headers are set on every remote response; no CORS headers are
  emitted, and cookies are not used.
- `/api/remote/health` is not an unauthenticated fingerprint: it returns 404
  unless called from loopback or with a valid device token.
- Rate limits, exponential lockout, a connection cap, and a body-size limit
  apply to the remote listener.
- The audit log records sensitive transitions without secrets or prompt text,
  and every entry is chained to the previous entry's hash. Run
  `pandu audit verify` to check it.
