# Cockpit security model

Status: Phase 6 (agent control and notifications). Branch `rewrite`.
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
- Notification content, which may be visible on a lock screen.

The main security promise for Phase 6 is narrow: **the daemon can observe and
nudge a terminal the user started, but it cannot start a command, read a
credential store, or put prompts and code into a notification.**

## 2. Trust boundaries

| Boundary | Trusted side | Untrusted side |
| --- | --- | --- |
| Network | The loopback interface and the local browser | Every remote host, every non-loopback origin |
| Process | The user's own account | The agent process and everything it prints |
| Command | The CLI invocation typed by the user | The daemon API and the UI |
| Approval | A human reading the request | Any replayed, late, or cross-session answer |
| Notification | The local daemon | The OS notification surface and any remote push service |

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
- The UI and the API share the daemon origin, so no cross-origin read is needed
  in normal use.

Evidence: `config::tests::rejects_non_loopback_hosts`,
`config::tests::rejects_non_loopback_origins`,
`integration::a_foreign_host_header_is_rejected`.

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

## 4. Tests that gate this phase

Phase 6 is not considered done unless these pass:

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

## 5. Not protected yet

These are known limits of this build. They are not silently accepted; they are
listed so a reviewer can decide whether a later phase must close them.

1. **No remote access and no device authentication.** Remote pairing and bearer
   tokens are Phase 7. Until then the daemon is loopback-only and loopback is
   trusted. Any local process or local user that can reach the port can read the
   API and queue keystrokes. There is no per-user login.
2. **No TLS.** Loopback traffic is plain HTTP/WebSocket. A network attacker cannot
   reach the listener in this build, but a local packet capture or a compromised
   proxy could observe it.
3. **No CSRF token on bodyless POST endpoints.** CORS blocks cross-origin reads
   and JSON preflights from unlisted origins are denied, but a malicious page can
   still send a simple form POST. Endpoints that take no JSON body (for example
   demo seeding, or acknowledging an event id the page already knows) can be
   triggered from another origin. Event ids are unguessable UUIDs, and the
   response is unreadable, but the state change is possible. A CSRF token or a
   required custom header is future work.
4. **No sandbox around the agent.** The agent runs with the user's privileges and
   can read anything the user can read. Cockpit does not inspect the agent binary
   or its environment.
5. **Terminal output is not secret-scanned.** The sanitizer removes control
   sequences, not API keys or passwords. If an agent prints a secret, the live
   session can display it. Output is memory-only and loopback-only, but it is not
   redacted like proxy traffic.
6. **Prompt detection is heuristic.** Even a verified adapter can miss a prompt or
   misclassify one. Unverified adapters intentionally degrade to `needs_you`
   without a typed event. The UI must not be treated as an authoritative
   permission system for the agent itself.
7. **Notifications leave Cockpit.** Once a Windows toast is shown, the OS decides
   where it appears, including the lock screen. The payload is minimal, but agent
   and project names are still visible.
8. **No Android or push notifications.** The companion app is Phase 11. There is
   no FCM/APNs path, no cloud relay, and no background update ping.
9. **No plugin runtime, market installs, or theme execution.** Those surfaces do
   not exist in this build. Themes are validated JSON and are never executed.
10. **Same-user malware wins.** A process running as the user can read the
    database, attach to the daemon, or inspect the terminal. Cockpit is not an
    anti-malware boundary.

## 6. Reporting a problem

Do not open a public issue for a security problem. Report it privately to the
maintainer with the affected version, the platform, reproduction steps, and the
impact. Do not include real API keys, tokens, or private source code in the
report; redact them first.
