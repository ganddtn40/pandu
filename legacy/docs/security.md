# Security model

Cockpit records sensitive material: prompts, model responses, file diffs,
provider credentials in transit, and a local device registry. This document
describes what is protected, how, and where the limits are.

## Assets

- prompts, responses, tool calls, and streamed text;
- provider API keys and authorization headers;
- the SQLite database, migrations, and git snapshots/patches;
- pairing codes and device tokens;
- plugin source and plugin run output;
- the local daemon port and dashboard origin.

## Trust boundaries

1. **Agent → proxy.** The agent is untrusted input. Cockpit forwards its bytes
   but validates and redacts only the stored copy.
2. **Browser → dashboard/API.** The dashboard is served from the daemon origin.
   CORS is restricted to loopback origins by default.
3. **Remote device → API.** Non-loopback requests must present a paired device
   token.
4. **Plugin process → daemon.** Plugins are separate Node processes with a
   reduced environment and capped output.
5. **Daemon → provider.** Provider credentials leave the machine only in the
   upstream request the agent already intended to make.

## Defaults

- The daemon binds to `127.0.0.1:4319`. It does not listen on the network until
  you change `COCKPIT_HOST` or pass `--host`.
- Loopback requests are trusted. Non-loopback `/api/*` and `/s/*` requests
  require `Authorization: Bearer <device token>`.
- `GET /api/health` and `POST /api/pairing/claim` are the only public remote
  routes.
- Pairing-session management and `POST /api/demo/seed` are local-only.
- A remote device may only revoke itself.
- WebSocket clients pass the device token as `?token=`.

## Pairing

- Codes use `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, are displayed as `XXXX-XXXX`,
  and are single-use.
- The default lifetime is 300 seconds; the allowed range is 60–900 seconds.
- Codes are hashed with SHA-256 before storage. A successful claim deletes the
  pairing record.
- Failed claims are rate-limited to 10 attempts per five minutes per remote
  address.
- Device tokens are `ckp_` plus 32 random bytes (base64url), hashed at rest.
  They are never written to logs or the live event feed.
- Revoking a device takes effect immediately for REST and WebSocket access.

## Redaction

The proxy forwards request bodies unchanged and redacts the stored copy.
Sensitive headers and fields are replaced with `[REDACTED]`, and recognizable
provider key patterns are scrubbed from free text. Redaction is pattern-based.
It reduces accidental exposure but is not a data-loss-prevention guarantee.
Novel secret formats can pass through. Treat the database as sensitive even
after redaction.

## Data at rest

- SQLite lives in `COCKPIT_HOME` (platform home directory by default).
- The database is **not encrypted at rest** by Cockpit. Use operating-system
  account protection and full-disk encryption.
- Git snapshots are stored in SQLite as patches and as unreferenced commits.
  Cockpit uses a temporary `GIT_INDEX_FILE`; it does not change your index,
  HEAD, branch, or reflog.
- Deleting the database file removes recorded flights. Demo data lives in the
  same database; `cockpit demo` prints the path.
- There is no cloud backup, sync, or telemetry upload.

## Transport

Cockpit does not terminate TLS. When remote access is enabled:

- bind to the narrowest address that works;
- use a TLS-terminating reverse proxy or a private network such as Tailscale;
- set `COCKPIT_PUBLIC_URL` so pairing links use the reachable HTTPS origin;
- do not expose the daemon directly to the public internet.

The Android client permits cleartext HTTP because it talks to a LAN daemon. Use
it only on a trusted network, or put the daemon behind TLS.

## Plugins

Plugins run in a child Node process with:

- a reduced environment (no provider keys or Cockpit secrets);
- a 15-second timeout;
- a 1 MB stdout cap and 64 KB stderr cap;
- an entry file that must resolve inside the plugin directory.

Plugins are **not** a sandbox. A malicious plugin can read files your user can
read. Install only code you trust, review the manifest, and keep the plugin
directory under version control.

## Dashboard and desktop

- The dashboard sends a strict CSP (`default-src 'self'`, no inline scripts,
  no object embeds, `frame-ancestors 'none'`).
- The Tauri shell restricts `connect-src` and `frame-src` to loopback origins.
- The mobile app stores the device token in local storage, which is protected
  by the Android app sandbox.
- No client contains telemetry or contacts a Cockpit-hosted service.

## Supply chain

- Dependencies are pinned by `pnpm-lock.yaml`.
- CI runs lint, typecheck, formatting, and the full test suite.
- Release builds run from tags and publish with npm provenance.
- The desktop and Android workflows build from the same lockfile.
- No install script from a plugin runs automatically.

## Limits and non-goals

- A local user with access to your account can read the database and the
  daemon's memory. Cockpit is not a defense against a compromised workstation.
- Provider-side retention and logging are outside Cockpit's control.
- Redaction is best-effort; it does not classify arbitrary business secrets.
- Loopback trust assumes the local machine is not running hostile software.
- The mobile client's cleartext mode is for trusted LANs only.

## Hardening checklist

- Keep `COCKPIT_HOST=127.0.0.1` unless remote access is required.
- Prefer daemon-side keys over putting long-lived keys in agent environments.
- Pair devices deliberately and revoke them when they are lost.
- Run `cockpit doctor` after upgrades and check the database path.
- Back up the database only to encrypted storage.
- Review plugin source before installing it.
- Use full-disk encryption and a locked OS account.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Follow
[SECURITY.md](../SECURITY.md) and use GitHub's private vulnerability reporting
for this repository. Include the affected version, a reproduction, and the
impact you observed.
