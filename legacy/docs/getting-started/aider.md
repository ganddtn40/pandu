# Record Aider with Cockpit

Aider is OpenAI-compatible by default and reads `OPENAI_API_BASE`, which makes
it a one-command integration.

## 1. Install and check

```bash
npx cockpit doctor
```

`cockpit doctor` verifies Node.js 22.11+, the SQLite database, the Cockpit
home directory, git, provider credentials, and whether the daemon is running.

## 2. Run Aider inside a session

```bash
cockpit run --title "Aider: add webhook retries" -- aider --model gpt-4.1
```

Cockpit starts the daemon if needed, creates a session, and exports:

```text
OPENAI_BASE_URL=http://127.0.0.1:4319/s/<session>/openai/v1
OPENAI_API_BASE=http://127.0.0.1:4319/s/<session>/openai/v1
ANTHROPIC_BASE_URL=http://127.0.0.1:4319/s/<session>/anthropic
```

Aider's OpenAI client picks up `OPENAI_API_BASE`; the key already in your
environment is preserved. If you keep the key on the daemon instead:

```bash
export COCKPIT_OPENAI_API_KEY=sk-...
cockpit start
cockpit run -- aider --model gpt-4.1
```

## 3. Use an existing Aider terminal

```bash
cockpit start
export OPENAI_API_BASE=http://127.0.0.1:4319/v1
export OPENAI_API_KEY=sk-...
aider --model gpt-4.1
```

The ambient `/v1` route groups calls into one ambient session per protocol. For
an explicit session, create one and use
`http://127.0.0.1:4319/s/<sessionId>/openai/v1`:

```bash
curl -s -X POST http://127.0.0.1:4319/api/sessions \
  -H "content-type: application/json" \
  -d '{"title":"Aider: docs pass","source":"manual","workspacePath":"/path/to/repo"}'
```

## 4. What gets recorded

- request and response bodies, with secrets redacted before storage
- token usage and cost when the model has a bundled price
- tool calls extracted from the response
- SSE chunks as they arrive, without buffering the client response
- git snapshots before and after steps when the workspace is a git repository

Open the printed review link for the step timeline. Use **Replay** to scrub
through the session and **Trust** to inspect deterministic findings such as
weakened assertions or empty catch blocks.

## Anthropic models

Cockpit proxies `/v1/messages` as well. Aider's Anthropic support depends on
the installed LiteLLM version; if it honors `ANTHROPIC_BASE_URL`, point it at
`http://127.0.0.1:4319/anthropic` or the session-scoped
`/s/<sessionId>/anthropic` route. The OpenAI-compatible path is the
best-tested route for Aider.

## Troubleshooting

- **Aider ignores the proxy** — confirm `OPENAI_API_BASE` is set in Aider's
  process. `cockpit run` sets it for the child process.
- **Cost shows as unknown** — the model is not in the bundled price table.
  Cockpit records the call as unpriced instead of reporting `$0`. Use the
  model's exact upstream id or add an override in your own workflow.
- **No snapshots** — run Aider in the repository root. Cockpit uses
  `git rev-parse --show-toplevel` and skips snapshots outside a repository.
- **Long tool output fills the context** — open **Context** and look for the
  `large_tool_output` insight. It includes an estimated token saving.
