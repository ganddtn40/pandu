# Record OpenCode with Cockpit

OpenCode is the fastest path to a recorded flight because `cockpit run` starts the
daemon, creates an explicit session, and points OpenCode at the proxy.

## 1. Install Cockpit

```bash
npx cockpit demo        # optional: see the dashboard with demo data first
npx cockpit doctor      # checks Node, the database, git, and the daemon
```

From a source checkout:

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js doctor
```

## 2. Run OpenCode inside a session

```bash
cockpit run --title "Add checkout rate limiting" -- opencode
```

Cockpit creates a session, prints its dashboard URL, and starts OpenCode with:

| Variable             | Value                                         |
| -------------------- | --------------------------------------------- |
| `OPENAI_BASE_URL`    | `http://127.0.0.1:4319/s/<session>/openai/v1` |
| `OPENAI_API_BASE`    | the same OpenAI-compatible base URL           |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4319/s/<session>/anthropic` |
| `COCKPIT_SESSION_ID` | the session id                                |

Existing `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN`
values are preserved. When a key is missing, Cockpit supplies the
`cockpit-proxy` sentinel and substitutes a daemon-side key if one is configured.

```bash
# Keep provider keys on the daemon instead of in the agent environment.
export COCKPIT_OPENAI_API_KEY=sk-...
cockpit start
cockpit run -- opencode
```

## 3. Review the flight

The terminal prints a `Review:` link. The same session is available at:

- `/sessions/<id>` — step timeline and request/response inspector
- `/sessions/<id>/replay` — scrub through prompts, tools, and file diffs
- `/sessions/<id>/trust` — deterministic trust score from snapshot diffs
- `/sessions/<id>/context` — context composition and insights

When the OpenCode process exits, Cockpit ends the session as `completed`,
`failed`, or `killed` based on the exit status.

## Use OpenCode without the wrapper

If you launch OpenCode from another terminal, start the daemon and use the
ambient proxy. Calls are grouped into one ambient session per protocol and end
after 30 minutes of inactivity.

```bash
cockpit start

# In the OpenCode environment:
export OPENAI_BASE_URL=http://127.0.0.1:4319/v1
export OPENAI_API_BASE=http://127.0.0.1:4319/v1
export ANTHROPIC_BASE_URL=http://127.0.0.1:4319/anthropic
opencode
```

For an explicit session, create one through the API and use the session-scoped
routes:

```bash
curl -s -X POST http://127.0.0.1:4319/api/sessions \
  -H "content-type: application/json" \
  -d '{"title":"OpenCode: fix auth","source":"manual","workspacePath":"/path/to/repo"}'
```

Use `/s/<sessionId>/openai/v1` or `/s/<sessionId>/anthropic` as the base URL.
The dashboard's session page is the canonical place to copy the URL.

## Troubleshooting

- **`cockpit: A command is required after "cockpit run --"`** — pass the agent
  after the separator: `cockpit run -- opencode`.
- **The dashboard is empty** — OpenCode may not be using the environment
  variables. Check its provider configuration and confirm the base URL ends in
  `/v1` for OpenAI-compatible traffic.
- **401 from the provider** — the client key was not forwarded or the
  daemon-side key is missing. Run `cockpit doctor` and check the Credentials
  line.
- **No git snapshots** — install `git` and run OpenCode inside a git repository.
  Recording still works without snapshots; replay and trust analysis need them.
