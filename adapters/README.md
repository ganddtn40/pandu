# Agent adapters

Adapters tell Cockpit how to detect an agent, how to wrap it with proxy
environment variables, and where its local session files live. They are
data-driven TOML files so adding an agent is a one-file pull request, not a
daemon change.

> **Status:** the loader and shipped adapters land in Phase 2. This document is
> the contract those files will follow. Every adapter starts with
> `verified = false` until its commands and paths are checked against current
> vendor documentation.

## Principles

- **No TLS interception. No credential capture.** Cockpit never proxies HTTPS
  by installing a certificate and never reads an agent's keychain or token
  store.
- **Observe or redirect, never modify.** Proxy mode changes only the base URL
  and API key the agent is told to use. Log-watch mode is read-only.
- **Fail open.** A missing session file or a parser error must not break the
  agent. It produces a warning in `cockpit doctor` and the UI.
- **Data, not code.** The daemon ships named parsers; adapters select one and
  describe where files are. Arbitrary scripts in adapter files are forbidden.
- **Honest labels.** A flight recorded through the proxy says `Recorded via
  proxy`. A flight read from disk says `Observed from logs`. Hook/OTel flights
  say `Observed via hook`.

## File shape

One file per agent: `adapters/<id>.toml`.

```toml
schema_version = 1
id = "example-agent"
name = "Example Agent"
verified = false
docs_url = "https://example.com/docs/agent"

# One or more of: "proxy", "log_watch", "hook_otel".
capture = ["proxy", "log_watch"]

[detect]
# Executable name checked on PATH. No shell interpolation.
command = "example"
# Arguments used to print a version. Optional.
version_args = ["--version"]

[proxy]
# Protocols the agent speaks through this endpoint.
protocols = ["openai-chat"] # openai-chat | openai-responses | anthropic | gemini
# Environment variables Cockpit sets when running the agent.
base_url_env = ["OPENAI_BASE_URL"]
api_key_env = ["OPENAI_API_KEY"]
# Human-readable setup note shown in the wizard.
setup_note = "Point the agent at Cockpit's local base URL."
# Anything still unconfirmed must stay false.
verified = false

[log_watch]
# Directories to watch. `~` and `${ENV_VAR}` are expanded; no globs here.
roots = ["~/.example-agent/sessions"]
# Glob patterns relative to each root.
include = ["**/*.jsonl"]
# A named parser implemented in cockpit-daemon. Unknown names are rejected.
parser = "example-jsonl"
verified = false

[hook_otel]
# Optional: OTLP/HTTP endpoint the agent can export to.
otlp_http = true
hooks = ["session_start", "tool_call"]
verified = false
```

### Field rules

| Field | Required | Notes |
| --- | --- | --- |
| `schema_version` | yes | Must be `1` for now |
| `id` | yes | Lowercase, `[a-z0-9-]`, unique, matches the filename |
| `name` | yes | Display name, sentence case |
| `verified` | yes | Top-level summary; any unverified section keeps it `false` |
| `capture` | yes | Non-empty subset of the three modes |
| `docs_url` | yes | Vendor documentation, not a blog post |
| `detect.command` | yes | Executable name only, no arguments |
| `proxy.protocols` | if proxy | At least one supported protocol |
| `proxy.base_url_env` | if proxy | One or more env var names |
| `log_watch.roots` | if log-watch | At least one path |
| `log_watch.parser` | if log-watch | Must exist in the daemon's parser registry |
| `hook_otel` | if hook | At least one capability |

Paths are expanded with `~` and `${VAR}` only. Adapter files cannot run
commands, read files, or make network calls. `detect.command` is executed by the
daemon with a timeout and no shell.

## Planned adapters

The following adapters ship in Phase 2. Capture modes are provisional until
verified against current vendor docs.

| Agent | File | Planned capture | Verified |
| --- | --- | --- | --- |
| OpenCode | `opencode.toml` | Proxy, log-watch | No |
| Claude Code | `claude-code.toml` | Log-watch, hooks | No |
| Codex CLI | `codex.toml` | Proxy, log-watch | No |
| Cursor CLI | `cursor-cli.toml` | Log-watch | No |
| GitHub Copilot CLI | `copilot-cli.toml` | Log-watch | No |
| Antigravity / Gemini CLI | `antigravity.toml` | Proxy, log-watch | No |
| Cline | `cline.toml` | Proxy | No |
| Roo / Kilo Code | `roo-kilo.toml` | Proxy | No |
| Aider | `aider.toml` | Proxy | No |
| Goose | `goose.toml` | Proxy, log-watch | No |
| Crush | `crush.toml` | Proxy | No |
| Pi | `pi.toml` | Proxy | No |
| OpenHands | `openhands.toml` | Proxy | No |
| Qwen Code | `qwen-code.toml` | Proxy, log-watch | No |
| Amp | `amp.toml` | Log-watch | No |

## Adding an agent

1. Copy an existing adapter and change the `id`.
2. Check the vendor's current docs for env vars, flags, and session paths.
3. Keep `verified = false` until you have tested the adapter against a real
   install.
4. Add a fixture under `crates/cockpit-daemon/tests/fixtures/<id>/` if you add a
   log parser.
5. Run `cargo test -p cockpit-daemon adapters` and `cockpit doctor`.
6. Open a PR using the new-agent-adapter issue form.

## Security review checklist

- No secrets, tokens, or personal paths in the adapter file.
- No command that writes to the agent's config without user confirmation.
- Log paths are scoped to the agent's own data directory.
- Parser tests include malformed, truncated, and oversized input.
- The adapter never claims blocking support in log-watch mode.
