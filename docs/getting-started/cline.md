# Record Cline with Cockpit

Cline runs inside VS Code, so there is no child process for `cockpit run` to
wrap. Point Cline's OpenAI-compatible provider at the local proxy instead.

## 1. Start the daemon

```bash
npx cockpit start --detach
npx cockpit doctor
```

The daemon listens on `http://127.0.0.1:4319` by default. It never needs an
account, and it does not contact a Cockpit-hosted service.

## 2. Create a session

Cline will keep using the same base URL for every request, so create one
explicit session per task. The API returns the session id:

```bash
curl -s -X POST http://127.0.0.1:4319/api/sessions \
  -H "content-type: application/json" \
  -d '{"title":"Cline: fix checkout","source":"manual","workspacePath":"/absolute/path/to/repo"}'
```

Copy the `id` from the response, or open the dashboard and use the session URL.
For quick experiments you can skip this step and use the ambient proxy at
`http://127.0.0.1:4319/v1`; all OpenAI-compatible traffic is grouped into one
ambient session that ends after 30 minutes of inactivity.

## 3. Configure Cline

In Cline's settings:

1. Set **API Provider** to **OpenAI Compatible**.
2. Set **Base URL** to
   `http://127.0.0.1:4319/s/<sessionId>/openai/v1`.
3. Set **API Key** to your real provider key, or to `cockpit-proxy` when the
   daemon has a key configured with `COCKPIT_OPENAI_API_KEY`.
4. Set the model to the exact upstream model name, for example `gpt-4.1`.

Cline sends the key as a bearer token. Cockpit forwards real client
credentials untouched and only injects a daemon-side key when the client used
the sentinel.

## 4. Review the flight

Open `http://127.0.0.1:4319/sessions/<sessionId>` while Cline works. The
timeline updates over the live WebSocket feed. After the task:

- open **Replay** to inspect each prompt, response, tool call, and file diff;
- open **Trust** to see deterministic findings from the snapshot diffs;
- open **Context** to see what filled the context window.

Cockpit records a git snapshot before the first step and after every completed
step when the workspace is a git repository. It uses a temporary index, so your
staging area, HEAD, and branch are untouched.

## Anthropic models

Cline can also use an Anthropic-compatible endpoint. Create the session the
same way and set the base URL to
`http://127.0.0.1:4319/s/<sessionId>/anthropic`. Keep `anthropic-version` in
the request; Cockpit supplies `2023-06-01` when the client omits it.

## Troubleshooting

- **Cline reports a 404** — the base URL must include `/v1` for OpenAI and
  `/v1` for Anthropic messages (`/anthropic/v1/messages` is accepted; the
  session route is `/s/<id>/anthropic`).
- **Cline reports a 401** — set a real key in Cline or configure
  `COCKPIT_OPENAI_API_KEY` / `COCKPIT_ANTHROPIC_API_KEY` before starting the
  daemon.
- **Requests appear in one giant session** — use the session-scoped URL from
  step 2 instead of the ambient `/v1` route.
- **No snapshots** — open the repository folder itself in VS Code, not a parent
  directory, and confirm `git rev-parse --show-toplevel` succeeds.
