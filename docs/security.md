# Cockpit security model

Status: Phase 7 (remote access). Branch `rewrite`.
This document describes what the current build protects, how, and what it does
not protect yet. It is a working threat model, not a certification.

## 1. Scope and assets

Cockpit runs on the user's computer. It records agent activity, holds live
terminal sessions, asks the user for approvals, and can send a notification when
an agent needs attention.

Assets worth protecting:

- Agent terminal output, prompts, code, file paths, and project names.
- API keys, OAuth tokens, passwords, and other secrets used by agents.
- Recorded flights in the local SQLite database, including redacted request
  metadata and git snapshots.
- The authority to approve a paused request or send keystrokes to a live agent.
- Paired-device bearer tokens, pairing PINs, and the pairing codes that create
  them.
- The remote audit log, which records who did what and when.
- Notification content, which may be visible on a lock screen.

The main security promise is narrow: **the daemon can observe and nudge a
terminal the user started, but it cannot start a command, read a credential
store, or put prompts and code into a notification.** Remote access is opt-in
and host-controlled: a paired device can see, respond, or prompt within its
scopes, but it can never manage the host, reach the model proxy, or complete an
authentication prompt.

## 2. Trust boundaries

| Boundary | Trusted side | Untrusted side |
| --- | --- | --- |
| Local network | The loopback interface and the local browser | Every non-loopback origin |
| Remote listener | The host UI that enables it and a paired token with explicit scopes | Every network peer, every unpaired device, every stolen token |
| Process | The user's own account | The agent process and everything it prints |
| Command | The CLI invocation typed by the user | The daemon API and the UI |
| Approval | A human reading the request | Any replayed, late, or cross-session answer |
| Notification | The local daemon | The OS notification surface and any remote push service |
| Audit | The local SQLite database | Anything outside the host process, including a paired device |

The daemon is not a sandbox. The agent runs as the user, in the user's chosen
working directory, with the user's environment. Cockpit observes that process;
it does not contain it.

## 3. Protected now

### 3.1 Loopback-only network surface

- `COCKPIT_HOST` must be a loopback address. `Config::from_env` rejects anything
  else, and `server::bind` checks again before binding.
- `COCKPIT_ALLOWED_ORIGINS` only accepts loopback origins.
- CORS is an explicit allowlist: the daemon port, the Vite dev and preview ports
  (`5174`, `4174`), and configured loopback origins. The old permissive CORS
  layer is gone.
- A `Host` header middleware rejects requests whose host is not `localhost` or a
  loopback IP literal. This blocks DNS-rebinding pages that resolve an attacker
  hostname to `127.0.0.1`.
- Every state-changing host route (`POST`, `PATCH`, `DELETE` under `/api`) must
  carry an allowed loopback `Origin`, `Content-Type: application/json`, and the
  per-process CSRF token in `X-Cockpit-CSRF`. The token is generated at startup,
  served only by the host listener at `GET /api/csrf`, and compared in constant
  time. A missing or foreign `Origin` is `origin_required`/`forbidden_origin`; a
  form or `text/plain` post is `content_type_required` (415); a missing or wrong
  token is `csrf_missing`/`csrf_invalid`. A `no-cors` page cannot set the header
  or the JSON content type, so it cannot reach enable, pairing, scope, approval,
  revoke, or panic endpoints. The `/v1` model proxy is unaffected.
- The UI and the API share the daemon origin, so no cross-origin read is needed
  in normal use. The UI fetches the CSRF token once, caches it, and retries after
  a stale-token error; the CLI does the same for `cockpit pair` and the PTY
  control plane.
- This section describes the host listener. The optional remote listener is a
  separate listener and router; see section 3.9.

Evidence: `config::tests::rejects_non_loopback_hosts`,
`config::tests::rejects_non_loopback_origins`,
`integration::a_foreign_host_header_is_rejected`,
`remote::host_mutations_reject_cross_origin_forms_and_require_csrf`.

### 3.2 The PTY command boundary

`cockpit run -- <agent>` is the only thing that creates a live session.

- The CLI spawns exactly the program and arguments the user typed, in the
  directory the user ran Cockpit from. There is no shell interpolation and no
  API-supplied command or working directory.
- The daemon never spawns a process. It stores session metadata, queues
  keystrokes, and reads sanitized output.
- The API can only append keystrokes to an already-running session. Input is
  rejected when it contains NUL, is larger than 4,096 characters per batch, or
  would exceed a 64 KiB queue.
- The CLI reads queued input and writes it to the PTY. It does not pass API input
  to a shell.
- If the daemon disappears, the agent keeps running; the control plane is
  optional for the terminal.
- If registration fails, the CLI kills the spawned child instead of leaving an
  orphan.
- Closing the PTY master or killing the child tears down the pseudoconsole. On
  Windows, ConPTY's cursor-position query (`ESC[6n`) is answered so the agent
  cannot hang before producing output.

Evidence: `cockpit-cli::pty::tests::the_pty_runs_a_command_and_returns_its_output`,
`cockpit-cli::pty::tests::killing_the_child_closes_the_pty_without_waiting_for_it`,
`integration::agent_control_relays_sanitized_output_and_queues_input`.

### 3.3 Agent output is untrusted text

The daemon sanitizes every chunk it receives, even though the CLI also owns a
real terminal.

- ANSI CSI, OSC, DCS, SOS, PM, and APC sequences are removed, including
  hyperlinks and window-title changes.
- Other control characters, including NUL, backspace, and bidi overrides, are
  removed. Carriage returns become newlines so a line cannot overwrite what the
  user already saw.
- Each line is capped at 2,000 characters; the retained terminal buffer is
  capped at 256 KiB and trimmed from the front with a visible marker.
- The UI renders output as text inside a `<pre>`. It does not interpret HTML,
  auto-open links, or write to the clipboard.
- The Inbox displays agent-provided event messages as text, never as markup.
- Output lives in daemon memory, not in SQLite. Session metadata and agent
  events are persisted; terminal content is not.

Evidence: `agents::tests::strips_ansi_colors_and_cursor_movement`,
`agents::tests::drops_incomplete_and_malformed_sequences`,
`agents::tests::removes_bidi_and_control_characters`,
`agents::tests::caps_line_length`, `agents::tests::caps_output_buffer`.

### 3.4 Approvals are bound and single use

Guard approvals are not a boolean the UI can replay.

- A pending guard event gets a 256-bit random nonce and an expiry timestamp. The
  default window is 120 seconds (`COCKPIT_GUARD_APPROVAL_MS`).
- A decision must match the event id, the nonce, and the session id.
- Resolution is atomic: the store clears the nonce only when it still matches,
  so a second answer cannot resolve the same event.
- Expired events are marked `expired` and their nonce is cleared. Late answers
  are rejected. Replayed answers are rejected.
- The UI sends the nonce and session id with every decision. It never
  auto-approves, and high-risk approvals require typing `approve`; the Deny
  button takes focus first.

Evidence: `guards::tests::approvals_are_bound_to_nonce_and_session`,
`guards::tests::a_replayed_approval_is_rejected`,
`guards::tests::an_expired_approval_is_rejected_and_marked_expired`,
`guards::tests::the_expiry_sweep_only_touches_elapsed_events`.

### 3.5 Prompt detection does not guess

- Detection is per adapter, with fixture tests for Claude Code, Codex, and Gemini
  prompts, plus explicit auth patterns.
- All 15 shipped adapters have `verified = false`. For an unverified adapter,
  detection can only mark the session `needs_you`; it never creates a guessed
  typed event such as `permission` or `auth_required`.
- A verified adapter may emit the typed event. Until an adapter has fixture
  evidence, the UI says prompt detection is unverified.
- Repeated detections are debounced for four seconds.
- The UI shows `Needs you` rather than claiming it knows what the prompt means.

Evidence: `agents::tests::detects_claude_permission_fixture`,
`agents::tests::detects_codex_and_gemini_fixtures`,
`agents::tests::detects_auth_fixtures_without_guessing`,
`agents::tests::detects_question_only_when_verified`,
`agents::tests::ignores_ordinary_output`.

### 3.6 Auth prompts stay at the computer

- An `auth_required` event is shown as "Needs you at the computer".
- While that event is open, the session screen hides the free-text answer box and
  offers only "I signed in at the computer".
- Cockpit never asks for a password, API key, or OAuth token, and never stores or
  forwards one as a Cockpit credential.
- The user signs in in the agent's own terminal. Cockpit only sees the sanitized
  terminal output.

This is a product boundary, not a claim that terminal output can never contain a
secret. See section 5.

### 3.7 Notifications carry no content

- The notification payload type has exactly three fields: event type, agent
  name, and project name. It has no message, prompt, code, path, or token field.
- Windows toasts are emitted by the local daemon. Other platforms log at debug
  level and do not pretend a toast was shown.
- Demo mode never sends a desktop toast.
- `agent.started` never sends a toast. Toasts are limited to attention events
  (`permission`, `question`, `choice`, `auth_required`, `stuck`) plus `done` and
  `error`.
- In-app alerts use the same three-field text.
- The Web Notification API is used only when the user enables it and only while
  the page is hidden. It is never used for remote push.
- The toast setting is stored locally as `notify.toast`; the browser preferences
  are stored on the device.

Evidence: `agents::tests::notification_payload_has_no_content_fields`.

### 3.8 Local data and redaction

- The database lives under `$COCKPIT_HOME` (default `~/.cockpit/v2`) and is
  opened with SQLite WAL mode.
- Proxy capture redacts sensitive headers and provider-token patterns before
  storage. Forwarded bytes are never modified.
- Agent terminal output is not written to SQLite.
- Demo data is marked `demo: true` and labeled in the UI; it is never presented
  as real work.
- Clipboard writes only happen through an explicit copy button.

### 3.9 Remote access is a separate, host-controlled listener

Remote access is off by default and can only be enabled from the loopback UI.
A remote device cannot enable it, disable it, pair another device, rotate a
token, or read the audit log.

- **Separate listener and router.** The local listener is unchanged. When remote
  access is on, a second listener serves only the remote dashboard, the scoped
  `/api/remote/*` routes, and the live WebSocket. Model proxy paths (`/v1`,
  `/openai`, `/anthropic`, `/s/...`) and host-management routes are not mounted
  there; they return 404 before the UI fallback. Host control (enable, disable,
  pairing, scopes, revoke, panic) stays on the loopback listener and requires the
  loopback `Origin`, a JSON content type, and the per-process CSRF token, so a
  paired device or a web page cannot drive it.
- **Health is not a fingerprint.** `/api/remote/health` answers only a trusted
  loopback caller or a request with a valid device token; everyone else gets the
  same 404 as an unknown path. The version is included only for an authenticated
  device. The remote UI is detected by the `X-Cockpit-Remote: 1` marker header
  instead of an unauthenticated health probe.
- **Bind rules.** `Loopback` means off. Tailscale binds only the detected
  tailnet IPv4. Tunnel binds only `127.0.0.1` and requires an explicit public
  URL. LAN binds only the detected LAN IPv4 and always uses TLS. No mode binds
  `0.0.0.0` by default. A daemon started with `COCKPIT_REMOTE_PORT=0` refuses to
  start a remote listener.
- **No auto-install or auto-start.** Cockpit only detects Tailscale and
  cloudflared and prints the command to run. It never installs, starts, or
  bundles them. The remote listener does not restart after a daemon restart; the
  host must enable it again. Paired devices persist.
- **Pairing.** A host-created code is 128 bits, single-use, and expires in two
  minutes. The QR payload contains the URL, the code, and the TLS fingerprint
  when one exists. The device generates a four-digit verification code, sends a
  name, that code, and an optional high-risk PIN. The host must compare the
  four-digit code and echo it in **Confirm pairing** before a token exists; a
  mismatched code leaves the claim pending. The PIN is set on the device during
  pairing, must be 6–12 digits, and is stored as an Argon2id hash (legacy salted
  SHA-256 PINs still verify). A denied or expired claim never receives a token,
  and wrong codes are rate-limited and lock out.
- **Tokens.** A token is 256 bits, delivered to the device once, and stored by
  the host only as a SHA-256 hash. It is accepted only in the
  `Authorization: Bearer` header, compared in constant time, and expires after
  30 days without use. Rotation invalidates the old token immediately.
  Revocation closes open WebSockets immediately.
- **Scopes.** Status (`view:status`), Content (`view:content`), Respond, and
  Prompt are enforced by the daemon on every request and every live message. New
  devices get Status only. Content is opt-in and can read terminal output,
  steps, diffs, prompts, and responses — code and anything an agent printed.
  Prompt grants keystroke injection into a running session and is presented with
  the warning "Prompt lets this device make your agent run commands."
- **High-risk approvals.** Severity High/Critical or a dangerous command needs
  the PIN set at pairing. Without a PIN, the decision must happen at the
  computer. Approve and deny both require the PIN. Replayed, late, and expired
  decisions are refused. Five wrong PINs lock Respond for that device; only the
  host can clear the lock with **Reset Respond** in the device list.
- **Auth prompts.** Sign-in, password, API-key, and two-factor text is refused
  with `needs_host`; the device is told to go to the computer.
- **Remote prompts.** The endpoint requires the Prompt scope, accepts at most
  2,000 characters (no NUL), and is limited to 6 per minute per device. A prompt
  is only keystrokes into an already-running Cockpit-owned session; it cannot
  spawn a process or choose a directory. Host confirmation is on by default.
  The audit log stores only the size and a SHA-256 hash, never the text.
- **WebSocket.** The live route is outside bearer auth and validates its own
  30-second single-use ticket from
  `Sec-WebSocket-Protocol: cockpit.<ticket>`. It checks `Origin` on upgrade,
  re-checks scope and revocation on every message, and is closed by revocation
  or panic. Tokens never appear in the URL.
- **Headers and origins.** Every remote response sets CSP,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS
  when HTTPS. The listener emits no CORS headers, so cross-origin reads are not
  possible. `Host` and `Origin` are checked against the mode (tunnel public host
  plus loopback, `.ts.net`/tailnet IPs, or LAN IPs/`.local`). Cookies are not
  used.
- **Abuse limits.** Pairing claims are keyed per claim, authenticated requests
  per device, and unauthenticated attempts per trusted client IP. At most three
  claims can wait for the host and only one pairing code is active at a time.
  Exponential lockout, a bounded connection semaphore, request body limits, and
  heartbeat timeouts also apply. In Tunnel mode the TCP peer is always the local
  connector, so `cf-connecting-ip` is the only client identity and is trusted
  only when the peer is loopback and the value parses as an IP; otherwise the
  request shares an `untrusted` bucket and no address is shown to the host. A
  valid bearer token bypasses an IP lockout, so unauthenticated brute force
  cannot cut off an already-paired device.
- **Audit.** Pair, confirm, verification failures, deny, revoke, rotate, scope
  changes, login failures, every approve/deny, wrong PINs, Respond lock/reset,
  every remote prompt (size/hash only), remote on/off, and notification changes
  are appended to a host-only audit log. The log is exportable as JSON and never
  contains tokens, passwords, PINs, prompt text, or terminal output.
- **Panic.** Stops the listener, bumps the revocation epoch, revokes every
  device, and clears pending prompts.

Evidence: `crates/cockpit-daemon/tests/remote.rs`:
`remote_listener_never_mounts_proxy_routes_or_host_management`,
`every_remote_endpoint_enforces_its_scope`,
`revocation_closes_a_live_socket_immediately`,
`pairing_is_single_use_host_confirmed_and_brute_force_limited`,
`pairing_queue_is_capped_at_three_claims`,
`tunnel_identity_trusts_only_forwarded_addresses`,
`a_valid_token_bypasses_an_untrusted_ip_lockout`,
`host_origin_cors_and_security_headers_are_enforced`,
`host_mutations_reject_cross_origin_forms_and_require_csrf`,
`remote_approvals_need_the_pin_and_cannot_be_replayed`,
`respond_locks_after_five_wrong_pins_until_the_host_resets_it`,
`expired_remote_approvals_are_refused`,
`remote_prompts_are_bounded_rate_limited_and_never_audited_verbatim`,
`remote_prompts_require_an_explicit_awaiting_state`,
`auto_approve_sessions_always_wait_for_the_host`,
`live_events_hide_content_from_status_only_devices`,
`host_confirmation_is_required_for_remote_prompts_by_default`,
`authentication_prompts_must_be_completed_at_the_computer`,
`audit_log_records_sensitive_transitions_and_exports`,
`malformed_requests_are_rejected_without_a_crash`,
`panic_stops_the_listener_and_revokes_every_device`, and
`remote_access_refuses_unauthenticated_configurations`. Unit tests:
`remote::auth::tests::constant_time_comparison_matches_normal_equality`,
`remote::auth::tests::pins_are_salted_and_verified`,
`remote::auth::tests::legacy_sha256_pins_still_verify`,
`remote::auth::tests::scopes_always_include_status_and_legacy_view_is_status`,
`remote::auth::tests::rate_limiter_blocks_after_the_budget`,
`remote::auth::tests::failures_lock_out_exponentially`,
`remote::pairing::tests::a_claim_waits_for_the_host_and_the_code_is_single_use`,
`remote::pairing::tests::a_denied_claim_never_issues_a_token`,
`remote::pairing::tests::a_wrong_code_is_limited_and_locks_the_code`,
`remote::pairing::tests::an_expired_code_is_refused`,
`remote::pairing::tests::malformed_codes_pins_and_verification_codes_are_rejected`,
`remote::pairing::tests::a_new_code_replaces_the_old_one`, and
`remote::pairing::tests::only_three_claims_wait_for_the_host_at_once`.

## 4. Tests that gate this phase

Phase 7 is not considered done unless these pass:

- The remote listener never mounts proxy or host-management routes.
- Every remote endpoint enforces its scope; the test iterates the same matrix
  the UI displays.
- Revoking a device closes a live WebSocket immediately.
- Pairing codes are single-use, expire, and lock out after wrong attempts; the
  host must echo the device's four-digit verification code.
- Five wrong PINs lock Respond until the host resets the device.
- `Host`, `Origin`, CORS, CSP, and security headers are enforced.
- `/api/remote/health` returns 404 to unauthenticated remote callers and leaks no
  version.
- Remote approvals need the PIN and cannot be replayed; expired approvals are
  refused.
- Remote prompts are bounded, rate-limited, and never audited verbatim; host
  confirmation is on by default.
- Authentication prompts are refused with `needs_host`.
- The audit log records sensitive transitions and exports without secrets.
- Malformed remote requests are rejected without a crash.
- Panic stops the listener and revokes every device.
- The daemon refuses to start a remote listener with an unauthenticated
  configuration.
- Token comparison is constant-time, PINs are salted, and lockout grows
  exponentially.
- Replayed, expired, wrong-nonce, and wrong-session approvals are rejected.
- Malformed and incomplete ANSI sequences do not swallow later output.
- Oversized lines and output buffers are capped.
- PTY exit and kill paths leave no orphaned child.
- Windows ConPTY output works, including the cursor-position query.
- Notification payloads contain no message or content fields.
- A foreign `Host` header is rejected.
- The agent control endpoint sanitizes output and queues input without spawning
  anything.

The full suite is `cargo test --workspace`, `cargo clippy --workspace
--all-targets`, `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm e2e`.

## 5. Remote access: stolen tokens, revocation, and endpoint scopes

### 5.1 Stolen token impact by scope

A paired-device token is a bearer credential. Anyone who copies it can act as
that device until it is revoked or expires after 30 days without use. Scopes
bound the damage, but they do not make a stolen token harmless.

| Token scope | What an attacker can do | What they still cannot do |
| --- | --- | --- |
| **Status** (`view:status`) | Read flights, sessions, agent lists, costs, counts, pending approvals, and inbox events. Open the live socket and watch new activity. Revoke the device (self-logout). | Read terminal output, steps, diffs, prompts, or responses. Approve or deny anything, send prompts, pair devices, change scopes, rotate tokens, read the audit log, or reach the model proxy. |
| **Status + Content** (`view:content`) | Everything Status can do, plus read captured steps, terminal output, diffs, prompts, and responses. This can expose source code, file paths, project names, and anything an agent printed. | Approve or deny anything, send prompts, pair devices, change scopes, rotate tokens, read the audit log, or reach the model proxy. |
| **Status + Respond** | Everything Status can do, plus approve or deny guarded actions that are not high risk. A destructive action that the guard did not classify as High/Critical or dangerous could be approved. Denying is also a denial-of-service. | High-risk approvals without the pairing PIN. Content, prompts, host management, pairing, or the audit log. |
| **Status + Content + Respond + Prompt** | Everything above, plus send up to 2,000 characters as keystrokes into an already-running agent session. If host confirmation is off for that device, the text is queued immediately with Enter. The agent may then run commands with the user's privileges. | Start a new process, choose a working directory, or bypass the CLI-owned PTY. High-risk approvals still need the PIN. |
| **Any scope + PIN** | High-risk approve/deny, subject to rate limits and lockout. | Everything outside the granted scopes; the PIN is not a host login. |

A token with no scopes cannot exist: every device always has Status. Content is
opt-in and can read code and anything an agent printed. The safest response to a
lost or exposed device is **Panic**, not just lowering scopes, because a stolen
token can still read status until it is revoked.

### 5.2 Revocation steps

1. **Revoke the device.** Settings → Remote access → Devices → **Revoke**. The
   token stops working on the next request, and open WebSockets close
   immediately.
2. **Rotate instead of revoke** if you want to keep the device but suspect the
   token leaked. Rotation invalidates the old token immediately and shows the
   replacement once.
3. **Use Panic** if the device is lost or you are unsure which device is
   affected. Panic stops the listener, revokes every device, and clears pending
   prompts.
4. **Turn remote access off** to stop the listener without revoking devices.
   Paired devices remain in the database and work again if you re-enable remote
   access.
5. **Restart the daemon** to guarantee the remote listener is gone. Remote
   access does not auto-start after a restart.
6. **Review the audit export** for pairing, scope changes, approvals, prompts,
   login failures, and revocations. Export it before clearing state if you need
   evidence.
7. **If the host itself is compromised**, treat it as full local compromise:
   stop Cockpit, rotate agent and provider credentials, and review what the
   agent could reach. Remote revocation alone is not enough.

### 5.3 Endpoints and scopes

The remote listener exposes exactly these routes. The UI displays the same
matrix, and the integration test iterates it.

| Method | Endpoint | Scope | Note |
| --- | --- | --- | --- |
| POST | `/api/remote/pair/claim` | none | Pairing code + device name |
| POST | `/api/remote/pair/claim/{id}` | none | One-time claim secret |
| GET | `/api/remote/session` | view:status | This device's scopes |
| GET | `/api/remote/overview` | view:status | Flights and totals |
| GET | `/api/remote/sessions` | view:status | Flight list |
| GET | `/api/remote/sessions/{id}` | view:status | Flight detail |
| GET | `/api/remote/sessions/{id}/steps` | view:content | Captured steps, prompts, and responses |
| GET | `/api/remote/guards/events` | view:status | Pending and past approvals |
| GET | `/api/remote/agents` | view:status | Running agent sessions |
| GET | `/api/remote/agents/{id}` | view:content | Sanitized terminal output |
| GET | `/api/remote/agent-events` | view:status | Inbox events |
| GET | `/api/remote/live` | view:status | WebSocket ticket in `Sec-WebSocket-Protocol`; content events need `view:content` |
| POST | `/api/remote/ws-ticket` | view:status | 30-second single-use ticket |
| POST | `/api/remote/guards/events/{id}/decision` | respond | Approve or deny; high risk needs the pairing PIN |
| POST | `/api/remote/agents/{id}/prompt` | prompt | Keystrokes only; host confirmation by default |
| POST | `/api/remote/logout` | view:status | Revoke this device |

`/api/remote/health` is an unauthenticated liveness probe that returns only
`ok`, `remote`, and the version. It is not a data route.

Everything else returns 404 on the remote listener, including `/v1`, `/openai`,
`/anthropic`, `/s/...`, `/api/health`, `/api/settings`, `/api/rules`,
`/api/adapters`, snapshots, replay, and every host-only `/api/remote/*`
management route (`status`, `enable`, `disable`, `panic`, `devices`, `pair/code`,
`audit`, `matrix`, notifications).

## 6. Not protected yet

These are known limits of this build. They are not silently accepted; they are
listed so a reviewer can decide whether a later phase must close them.

1. **A stolen device token is powerful within its scopes.** Remote access is
   opt-in, but a bearer token needs no further user presence. Status can leak
   project names and activity; Content can leak source code, paths, and terminal
   output; Respond can approve non-high-risk actions; Prompt can drive the
   running agent. See section 5.1 for the full impact table. Revoke or Panic
   immediately; lowering scopes is not enough while the token is still valid.
2. **Transport depends on the mode.** Loopback is plain HTTP/WebSocket.
   Tailscale direct access is plain HTTP inside WireGuard; use
   `tailscale serve` when you want browser HTTPS. Tunnel mode relies on
   `cloudflared` for public TLS, and a quick tunnel URL is public. LAN mode uses
   a self-signed certificate. Cockpit does not pin or verify the Tailscale or
   cloudflared binaries; a compromised tool can observe the traffic it carries.
3. **No CSRF token on bodyless host POST endpoints.** CORS blocks cross-origin
   reads and JSON preflights from unlisted origins are denied, but a malicious
   page can still send a simple form POST to the loopback listener. Endpoints
   that take no JSON body can be triggered from another origin. Event ids are
   unguessable UUIDs, and the response is unreadable, but the state change is
   possible. The remote listener uses bearer tokens and no cookies, so browser
   CSRF does not apply there. A CSRF token or a required custom header on the
   host listener is future work.
4. **No sandbox around the agent.** The agent runs with the user's privileges and
   can read anything the user can read. Cockpit does not inspect the agent binary
   or its environment.
5. **Terminal output is not secret-scanned.** The sanitizer removes control
   sequences, not API keys or passwords. If an agent prints a secret, the live
   session can display it, and a Content-scoped remote device can read it. Output
   is memory-only, but it is not redacted like proxy traffic.
6. **Prompt detection is heuristic.** Even a verified adapter can miss a prompt or
   misclassify one. Unverified adapters intentionally degrade to `needs_you`
   without a typed event. The UI must not be treated as an authoritative
   permission system for the agent itself.
7. **Notifications leave Cockpit.** Once a Windows toast is shown, the OS decides
   where it appears, including the lock screen. The payload is minimal, but agent
   and project names are still visible. The optional ntfy ping is generic, but
   public ntfy.sh is a third party that sees the random topic and timing. Use a
   self-hosted ntfy server if that metadata matters.
8. **No Android or push notifications.** The companion app is Phase 11. There is
   no FCM/APNs path, no cloud relay, and no background update ping. ntfy is a
   user-configured third-party notification path, not a companion app.
9. **No plugin runtime, market installs, or theme execution.** Those surfaces do
   not exist in this build. Themes are validated JSON and are never executed.
10. **Same-user malware wins.** A process running as the user can read the
    database, attach to the daemon, inspect the terminal, or read the remote
    device token from the browser's local storage. The audit log is append-only
    at the application layer, not cryptographically tamper-evident; same-user
    malware can alter or delete it. Cockpit is not an anti-malware boundary.
11. **Remote rate limits are in-memory and device identity is self-asserted.**
    Lockouts and connection budgets reset when the daemon restarts, and there is
    no distributed brute-force protection. Device names are supplied by the
    device, and PIN strength is the user's choice. The 128-bit pairing code and
    short expiry are the main defenses against guessing; do not treat a weak PIN
    as a strong second factor.
12. **Tokens persist across remote-off and daemon restarts.** Turning remote
    access off stops the listener but does not revoke devices. After a restart,
    remote access starts off, but a previously paired token works again as soon
    as the host re-enables the listener, until it is revoked or expires after 30
    days without use. Review the device list before re-enabling.

## 7. Reporting a problem

Do not open a public issue for a security problem. Report it privately to the
maintainer with the affected version, the platform, reproduction steps, and the
impact. Do not include real API keys, tokens, or private source code in the
report; redact them first.
