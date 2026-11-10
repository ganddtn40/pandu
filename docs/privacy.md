# Privacy

Status: Phase 9. Branch `rewrite`.

Cockpit is a local tool. There is no account, no cloud sync, no telemetry, and no
background upload. The daemon binds to a loopback address, records flights in
SQLite under `$COCKPIT_HOME`, and sends a network request only when the user asks
for one: a proxied model request, an explicit market refresh or install, or the
optional ntfy notification the user configured.

This document describes what is stored, what is derived, what can leave the
machine, and how to delete it.

## 1. What is stored locally

| Data | Where | Notes |
| --- | --- | --- |
| Flight metadata | SQLite `sessions` | Title, source, capture mode, protocol, provider, model, workspace path, branch, timestamps, tags, and free-form metadata. |
| Steps | SQLite `steps` | Kind, status, model, provider, latency, token usage, cost, errors, and step metadata (including the context meter and override record). |
| Request and response bodies | SQLite step columns | The recorded body after header and secret redaction. May contain prompts, code, file paths, tool output, and anything the agent sent or received. |
| Stream chunks | SQLite chunks | Captured response chunks for replay. Terminal output is not stored here. |
| Git snapshots and diffs | SQLite snapshots | Branch, base commit, file list, and patch text for flights that captured a snapshot. |
| Guard events and decisions | SQLite | Request, rule, severity, nonce (cleared on resolution), and who decided. |
| Agent events | SQLite | Attention events such as permission, question, auth required, done, and error. The message is stored; terminal output is not. |
| Remote audit log | SQLite | Hash-chained entries for pairing, scopes, approvals, prompts (size and hash only), model overrides and switches, and remote on/off. |
| Market state | SQLite and files under `$COCKPIT_HOME` | Registry cache, install manifests, backups, and settings. Installed skills and MCP configuration are written to the paths the user previewed. |
| Appearance and UI preferences | Browser `localStorage` | Theme, wallpaper, language, widget layout, onboarding flag, and notification preferences. The wallpaper is stored on this device only. |
| Remote device token | Browser `localStorage` on the remote device | The host stores only a SHA-256 hash. |

The database is not encrypted at rest. It is protected by the operating system's
file permissions for the user's account. A process running as the same user can
read it; see `docs/security.md`.

## 2. Request capture and redaction

- The proxy records the request and response after redacting sensitive headers
  and provider-token patterns. Redaction is pattern-based; it is not a guarantee
  that every secret in a prompt or a response is removed.
- The recorder always stores the **original** request body. A host model override
  changes only the forwarded copy; the recorded body, replay, and export show
  what the agent actually sent.
- Redaction happens before storage, not at display time. If a body was stored
  before a pattern was added, the old row keeps the old value.
- Terminal output from a PTY session is held in daemon memory, capped, and never
  written to SQLite. It is still visible to the host UI and, with the Content
  scope, to a paired device.
- Demo data is marked `demo: true` and labeled in the UI. It is generated locally
  and is never presented as real work.

## 3. Context meter

The context meter is derived from data Cockpit already has:

- The provider's reported prompt usage, when the response includes it.
- Otherwise an estimate from the recorded request body: system/instructions,
  tools, messages, input items, and file or image blocks.
- The model window and prices from the compiled `models.json`.

It makes no extra provider call and sends nothing anywhere. The breakdown
(`system`, `tools`, `history`, `files`, `other`) is an estimate even when the
total is provider-reported, because providers report a single prompt total. The
meter is stored in step metadata so it can be shown after the flight ends.

`context.high` is a local notification. It uses the same pipeline as other agent
events: a stored agent event, a live UI event, an in-app toast, and — only if the
user configured it — an ntfy ping. The ntfy payload is generic and contains no
prompt, code, path, or token count.

## 4. Model table and overrides

`models.json` is compiled into the binary. Cockpit does not fetch model prices or
limits at runtime, and it does not send the table anywhere.

A model override is:

- In-memory only. It is not written to the database.
- Cleared when the flight ends or the daemon restarts.
- Host-only. A paired device cannot set or clear one.
- Audited with the session, provider, from/to model and effort, and mode. The
  audit entry does not contain the request body, the prompt, or credentials.

The relative-cost preview is computed locally from the verified prices. It
prices this flight's recorded input, cached-input, cache-write, and output
tokens at the current and target models, applies long-context tiers, and prices
the first request after a switch against the current context. It is labeled as
an estimate, not a quote.

## 5. What can leave the machine

| Path | What is sent | When |
| --- | --- | --- |
| Model proxy | The agent's request, or the rewritten request when an override is active | Whenever the agent makes a model call. The destination is the provider the agent configured. |
| Market refresh | A request to the signed registry URL | On an explicit refresh or install, or the opt-in daily check. No install count or telemetry. |
| Market download | A pinned GitHub archive request | During an install, after the user previews it. |
| ntfy | A generic event type, agent name, and project name, to the topic the user configured | Only when the user enables ntfy and the event matches the notification rules. |
| Remote listener | The scoped remote dashboard and API, over the configured mode | Only while remote access is on. |
| Desktop toast | Event type, agent name, and project name, to the OS notification surface | Only for attention events, done, and error, and only when toasts are enabled. Demo mode never sends one. |

Cockpit does not send analytics, crash reports, usage counts, or a heartbeat. It
does not proxy through a Cockpit-operated server. There is no Cockpit account.

## 6. Remote access

Remote access is off by default and is enabled only from the host UI.

- A paired device always has the Status scope. Status is a redacted view:
  neutral flight titles built from creation order and agent name, no workspace
  path, branch, tags, metadata, terminal output, or step bodies. Guard events are
  reduced to severity and rule class.
- Content, Respond, and Prompt are opt-in. Content can read code and terminal
  output. Prompt can type into a running agent.
- The status view includes `contextPercent` only. It does not include token
  counts, the model window, the breakdown, or the model's source URL.
- A remote device cannot change the model or send a PTY model switch. Both routes
  return `403 host_only` and are audited.
- The audit log stores prompt size and a SHA-256 hash, never the prompt text. It
  stores no tokens, passwords, PINs, or terminal output.
- Revoking a device closes its live socket immediately. Panic revokes every
  device and stops the listener.

The full threat model and the endpoints × scopes table are in
`docs/security.md`. The user-facing setup guide is `docs/remote-access.md`.

## 7. Retention and deletion

This build does not prune flights automatically. To delete everything Cockpit
stores:

1. Stop the daemon and any running agent.
2. Remove `$COCKPIT_HOME` (default `~/.cockpit/v2`). This deletes the SQLite
   database, market cache, install manifests, and backups.
3. Remove installed market files and configuration entries first if you want to
   keep the agent configuration clean; uninstalling from the Market screen removes
   only files Cockpit can prove it created.
4. Clear the site's `localStorage` in the browser to remove appearance,
   onboarding, and any remote token on that device.
5. If remote access was enabled, revoke devices or use Panic before deleting the
   database; deleting the database also deletes the device hashes, so old tokens
   stop authenticating, but the listener configuration is gone with it.

Deleting a single flight is not exposed in this build. Use the database backup
you keep, or remove `$COCKPIT_HOME` and start fresh.

## 8. Children and sensitive data

Cockpit is a developer tool. It is not designed for children's data, health data,
or regulated data. Because request bodies and terminal output can contain
anything the agent sees, treat the Cockpit database with the same care as the
repositories and credentials the agent can reach.
