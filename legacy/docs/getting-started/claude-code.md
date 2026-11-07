# Record Claude Code with Cockpit

Claude Code reads `ANTHROPIC_BASE_URL`, so `cockpit run` can wrap it without a
plugin or a custom build.

## 1. Install and check

```bash
npx cockpit doctor
```

## 2. Run Claude Code inside a session

```bash
cockpit run --title "Claude Code: fix auth refresh" -- claude
```

The wrapper starts the daemon when needed and creates an explicit session. It
sets `ANTHROPIC_BASE_URL` to:

```text
http://127.0.0.1:4319/s/<session>/anthropic
```

Existing `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` values are preserved.
If neither is present, Cockpit sets `ANTHROPIC_API_KEY` to the
`cockpit-proxy` sentinel and substitutes `COCKPIT_ANTHROPIC_API_KEY` on the
daemon side.

```bash
# Recommended: keep the key on the daemon.
export COCKPIT_ANTHROPIC_API_KEY=sk-ant-...
cockpit start
cockpit run -- claude
```

Claude Code may use its own login session instead of an API key. Cockpit
forwards the `authorization` header untouched, so either authentication style
works as long as the upstream accepts it.

## 3. Use an existing Claude Code terminal

```bash
cockpit start

export ANTHROPIC_BASE_URL=http://127.0.0.1:4319/anthropic
claude
```

The ambient route groups calls into one ambient session. To isolate a task,
create an explicit session first:

```bash
curl -s -X POST http://127.0.0.1:4319/api/sessions \
  -H "content-type: application/json" \
  -d '{"title":"Claude Code: checkout","source":"manual","workspacePath":"/path/to/repo"}'
```

Then set `ANTHROPIC_BASE_URL` to
`http://127.0.0.1:4319/s/<sessionId>/anthropic`.

## 4. Review and guard

The dashboard exposes the same data for every agent:

- **Flight log** — filter by status, agent, project, and free text.
- **Session detail** — request, response, tool calls, and stream chunks.
- **Replay** — scrub the timeline and inspect per-file diffs.
- **Trust** — deterministic score and evidence from snapshot diffs.
- **Guards** — pending approvals, rules, and budget events.
- **Context** — token composition and context-doctor insights.

Run Guard pauses private keys and unambiguous destructive commands by default.
A paused request waits for a local decision in the dashboard or CLI:

```bash
cockpit guard events --status pending
cockpit guard approve <eventId> --note "Reviewed locally."
cockpit guard deny <eventId>
```

## What is not recorded

Only traffic sent to the Cockpit proxy is recorded. Claude Code's own
telemetry, update checks, and non-model API calls do not pass through
`ANTHROPIC_BASE_URL` and are not captured. Cockpit itself has zero telemetry.

## Troubleshooting

- **Claude Code shows an authentication error** — set a real
  `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, or configure
  `COCKPIT_ANTHROPIC_API_KEY` on the daemon. Run `cockpit doctor` to confirm.
- **Requests land in an ambient session** — you launched `claude` directly.
  Use `cockpit run -- claude` or the session-scoped base URL.
- **The response is slow** — Cockpit streams SSE bytes as they arrive and does
  not buffer the client response. Check the step's `ttftMs` and the provider's
  status in the inspector.
- **No snapshots or trust score** — start Claude Code in a git repository and
  make sure `git` is on `PATH`.
