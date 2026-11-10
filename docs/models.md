# Models, effort, overrides, and context

Status: Phase 9. Branch `rewrite`.

Cockpit ships a small, verified table of popular models so it can price a flight,
show how full the context window is, and offer a host-only model override without
guessing. The table lives in [`models.json`](../models.json) at the repository
root and is compiled into the binary with `include_str!`; it is not fetched at
runtime.

Every value in the table was read from the provider's own documentation on
`2026-11-10`. The `source` URL and `verifiedOn` date are part of each row and are
shown in the UI. When a value could not be verified it is stored as `"unknown"`
(JSON `null`), never as a plausible number. A model with an unknown input or
output price is shown as **Price unknown** and is never counted as `$0.00`.

## 1. The verified table

Prices are USD per million tokens. "Cache read" is a cache hit; "cache write" is
the 5-minute TTL rate where the provider charges one. Context and output limits
are tokens.

### OpenAI

| Model | Context | Max output | Input | Cache read | Output | Effort | Default |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `gpt-5.5` | 1,050,000 | 128,000 | $5.00 | $0.50 | $30.00 | `reasoning_effort`: none, low, medium, high, xhigh | medium |
| `gpt-5.4` | 1,050,000 | 128,000 | $2.50 | $0.25 | $15.00 | same | none |
| `gpt-5.4-mini` | 400,000 | 128,000 | $0.75 | $0.075 | $4.50 | same | none |
| `gpt-4.1` (deprecated) | 1,047,576 | 32,768 | $2.00 | $0.50 | $8.00 | none | — |

Source: `https://developers.openai.com/api/docs/models/<model>`. On the
Responses API the effort field is `reasoning.effort`; Cockpit uses that spelling
when the request path is a `/responses` endpoint and `reasoning_effort`
otherwise.

### Anthropic

| Model | Context | Max output | Input | Cache read | Cache write | Output | Effort | Default |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `claude-fable-5-2` | 1,000,000 | 128,000 | $8.00 | $0.20 | $10.00 | $40.00 | `output_config.effort`: low, medium, high, xhigh, max | high |
| `claude-opus-5-5` | 1,000,000 | 128,000 | $4.00 | $0.20 | $5.00 | $20.00 | same | medium |
| `claude-sonnet-5-5` | 1,000,000 | 128,000 | $2.00 | $0.10 | $2.50 | $10.00 | same | high |
| `claude-haiku-5-5` | 1,000,000 | 128,000 | $0.10 | $0.01 | $0.125 | $0.50 | same | medium |
| `claude-sonnet-4` (retired) | 200,000 | 64,000 | $3.00 | $0.30 | $3.75 | $15.00 | none | — |

Source: `https://platform.claude.com/docs/en/about-claude/pricing` and
`https://platform.claude.com/docs/en/about-claude/models/overview`.
`claude-haiku-5-5` prices each request on its own: prompts over 100K tokens are
billed at $0.50 input, $2.50 output, $0.05 cache read, and $0.625 5-minute
cache write. The table keeps the standard rate and `longContext` records the
tier. `claude-sonnet-4` is retained only so historical flights remain priced; it
has no `verifiedOn` because it was not re-verified this cycle and Anthropic lists
that generation as retired.

### Google

| Model | Context | Max output | Input | Cache read | Output | Effort | Default |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `gemini-4-argon` | 1,048,576 | 65,536 | $2.00 | $0.10 | $10.00 | `generationConfig.thinkingConfig.thinkingLevel`: low, medium, high | medium |
| `gemini-3.8-flash` | 1,048,576 | 65,536 | $0.75 | $0.075 | $3.75 | same | medium |
| `gemini-3.6-flash` | 1,048,576 | 65,536 | $0.75 | $0.075 | $3.75 | minimal, low, medium, high | medium |
| `gemini-2.5-pro` (deprecated) | 1,048,576 | 65,536 | $1.25 | $0.125 | $10.00 | `generationConfig.thinkingConfig.thinkingBudget`: 128–32,768 tokens, dynamic (`-1`); cannot disable | dynamic |

Source: `https://ai.google.dev/gemini-api/docs/pricing` and
`https://ai.google.dev/gemini-api/docs/thinking`. The `gemini-4-argon`
standard rate is in effect through `2026-11-30` ($4 / $20 from `2026-12-01`).
The two Flash rows are promotional through `2026-12-31` ($1.50 / $7.50 from
`2027-01-01`). `gemini-2.5-pro` is deprecated; from `2026-12-01` requests route
to Gemini 3.8 Flash and are billed at its rates. Cockpit keeps the recorded
model id and flags the row as deprecated rather than rewriting history.

Gemini 2.5 uses a numeric `thinkingBudget`; Gemini 3 and 4 use a string
`thinkingLevel`. The two are mutually exclusive at the provider: sending both
returns `400`. A row declares exactly one of `levels` or `budget`, and Cockpit
never sends both fields in one request.

For Gemini, the model is part of the URL path as well as the body. An override
rewrites both.

### DeepSeek

| Model | Context | Max output | Input | Cache read | Output | Effort | Default |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `deepseek-flash` | 1,000,000 | 384,000 | $0.30 | $0.006 | $1.20 | `reasoning_effort`: low, high, max | high |
| `deepseek-v4-pro` | 1,000,000 | 384,000 | $1.32 | $0.044 | $3.96 | same | high |

Source: `https://api-docs.deepseek.com/quick_start/pricing`. These are peak
rates; off-peak usage is billed at half. `deepseek-flash` accepts the legacy ids
`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, and
`deepseek-v4.1-flash` as aliases. When DeepSeek is reached through its
Anthropic-compatible endpoint, the effort field is `output_config.effort`.

## 2. Pricing and relative cost

- Cost is computed per step from the provider-reported usage. Input and output
  prices are optional; `priceKnown` is true only when both are present.
- Unknown prices are explicit. The cost is marked `cost_known: false`, the UI
  shows **Price unknown**, and the unknown-call count is shown next to the total.
  The demo seed keeps exactly one unknown-cost call so the UI always exercises
  this state.
- Cached input is billed at the cache-read rate when the provider reports cache
  reads. It is not silently folded into the input rate.
- The override preview is a warning signal, not a bill. It prices this flight's
  actual input, cached-input, cache-write, and output tokens at the current and
  target models, applies the provider's long-context tiers, and reports the
  percentage and ratio. It also prices the first request after a switch, which
  re-reads the current context with a cold provider cache. If either side has an
  unknown price the preview says **Price unknown**, shows no dollar estimate,
  and still requires the user to acknowledge it by pressing **Apply override**
  anyway.
- Long-context tiers live in each row as `longContext`. `scope: "session"` means
  one prompt above the threshold reprices the whole flight (OpenAI).
  `scope: "request"` means only prompts above the threshold pay the higher rates
  (Anthropic Haiku 5.5 and Gemini 2.5 Pro). The preview applies request-scoped
  tiers per recorded model call, so a large prompt does not reprice the small
  ones.

| Model | Threshold | Input | Cache read | Output | Scope |
| --- | ---: | ---: | ---: | ---: | --- |
| `gpt-5.5`, `gpt-5.4` | 272,000 | 2× base | 2× base | 1.5× base | session |
| `claude-haiku-5-5` | 100,000 | $0.50 | $0.05 | $2.50 | request |
| `gemini-2.5-pro` | 200,000 | $2.50 | $0.25 | $15.00 | request |

Sources: `https://developers.openai.com/api/docs/pricing`,
`https://platform.claude.com/docs/en/about-claude/pricing`, and
`https://ai.google.dev/gemini-api/docs/pricing`, all verified on `2026-11-10`.

## 3. Model and effort overrides

Overrides are **opt-in per flight**, **host-only**, and **in-memory**. There is
no setting that turns them on globally.

- The host UI offers the override panel only for an active flight captured
  through the proxy. A flight captured from logs, hooks, or a PTY shows manual
  instructions instead.
- The remote listener does not mount the loopback model routes:
  `GET/PUT/DELETE /api/sessions/{id}/model`,
  `GET /api/sessions/{id}/model/preview`, `POST /api/sessions/{id}/model/switch`,
  and `GET /api/models` all return `404 not_found` to a paired device. It mounts
  only `POST /api/remote/sessions/{id}/model` and
  `POST /api/remote/sessions/{id}/model/switch`, which always return
  `403 host_only` even for a fully scoped device, and the attempt is written to
  the audit log. The scope matrix lists both rejection routes as `host-only`.
- Setting, clearing, denying, and switching write hash-chained audit entries:
  `model.override.set`, `model.override.cleared`, `model.override.denied`,
  `model.switch`, `model.switch.manual`, and `model.switch.denied`. The entry
  records the session, provider, from/to model and effort, and the mode. It does
  not record prompts, request bodies, or credentials.
- The override clears when the flight ends (`session_ended`) and when the daemon
  restarts. It never survives into a new flight.

### 3.1 What is rewritten

Only the forwarded copy of the request is changed. The recorder keeps the
original body, so replay and export always show what the agent actually sent.

| Protocol | Model field | Effort field |
| --- | --- | --- |
| OpenAI Chat Completions | `model` | `reasoning_effort` |
| OpenAI Responses | `model` | `reasoning.effort` |
| Anthropic Messages | `model` | `output_config.effort` |
| Gemini (3.x and 4) | URL path model and body `model` | `generationConfig.thinkingConfig.thinkingLevel` |
| Gemini 2.5 | URL path model and body `model` | `generationConfig.thinkingConfig.thinkingBudget` (number) |
| DeepSeek (OpenAI format) | `model` | `reasoning_effort` |
| DeepSeek (Anthropic format) | `model` | `output_config.effort` |

Before writing, Cockpit:

1. Finds the target model in `models.json` for the same canonical provider.
   `google` and `gemini` are the same provider for this check.
2. Validates the requested effort against that model's allowed levels, or
   against its verified budget range, `dynamic`, and `off` support.
3. Removes every effort spelling Cockpit knows about from the body, including
   both `thinkingLevel` and `thinkingBudget`, then writes only the field the
   target model and protocol expect. This prevents a switch from leaving an
   incompatible `reasoning_effort` next to `output_config.effort`, or leaving
   both Gemini thinking fields in one request.
4. Leaves every other byte of the JSON semantics alone. Object key order may
   change because the body is parsed and serialized; values, arrays, and unknown
   fields are preserved.

### 3.2 Window and provider rejection safety

- **Window preflight.** Before installing an override, Cockpit reads the flight's
  latest context meter. If its token count is larger than the target model's
  `contextWindow`, the switch is rejected with `context_window_exceeded` (HTTP
  `409`). The preview applies the same check. A model switch cannot compact a
  prompt, so installing it would only guarantee that the next request fails.
- **One-shot auto-revert.** If the provider returns a 4xx for a request whose
  override was applied, Cockpit reverts the override immediately, records
  `model.override.reverted` (actor `cockpit`, reason `provider_rejected`, provider
  status), and flags the step metadata with `providerRejected: true`,
  `reverted: true`, `revertReason`, `providerStatus`, and a truncated
  `providerError`. The provider response is forwarded unchanged. Cockpit never
  retries the request in a loop; the next request uses the agent's original
  model.
- **Provider-bound artifacts.** Signatures, thinking blocks, cache keys, and some
  tool-call references are issued for a specific provider and model. Cockpit
  rewrites only the model and effort fields, so a mid-flight switch can leave an
  artifact the target model rejects. That rejection is handled by the one-shot
  revert above; the artifact is not rewritten or stripped. Start a new flight
  when the provider requires fresh artifacts.

### 3.3 Fail-open

If a safe rewrite is impossible, the request is forwarded **unmodified** and the
step is flagged. Fail-open reasons include:

- `model_not_found`: the target is not in the verified table.
- `provider_mismatch`: the target belongs to another provider.
- `effort_unsupported`: the target does not accept that effort level or budget.
  The host API reports an out-of-range budget as `effort_out_of_range`.
- `effort_not_supported`: an effort was supplied for a model with no effort
  control.
- `body_not_json`, `body_not_object`, `model_not_in_request`,
  `model_not_in_path`, `model_not_serializable`.

The step metadata records `applied: false`, `failedOpen: true`, the reason, and
the intended model, so the UI can show the step was not modified. Forwarding the
agent's original request is always preferred to sending a request the provider
will reject.

### 3.4 Byte-identical passthrough

With no override, the proxy forwards the original `Bytes` handle and the original
path. It does not parse or re-serialize the body. The integration test
`with_the_override_off_the_forwarded_bytes_are_identical` compares the upstream
bytes to the agent's request and requires an exact match, including whitespace
and key order.

## 4. PTY and hook model switching

A log-watch, hook, or PTY session is not proxied, so there is nothing to rewrite.
Cockpit can only type a command into a live terminal, and only when the adapter
declares that it has verified the command.

```toml
[model_switch]
command = "/model {model}"
verified = true
```

- The template must contain `{model}`, be one line, and be 1–200 characters.
- `Adapter::model_switch_command` substitutes only `{model}`. It does not shell
  out, and the daemon does not spawn anything.
- `POST /api/sessions/{id}/model/switch` is host-only. If the session has a live
  PTY and the adapter command is verified, Cockpit queues the command as
  keystrokes and returns `mode: "pty"`.
- Otherwise it returns `mode: "manual"` with instructions to change the model
  inside the agent and start a new flight. A hook or log-watch flight always gets
  manual instructions because Cockpit has no terminal to type into.
- Claude Code and Codex currently declare `command = "/model {model}"` with
  `verified = true`. The adapter `verified` flag and the model-switch `verified`
  flag are separate: an adapter can be unverified for prompt detection and still
  have a verified model command, and vice versa.

## 5. Context meter

Every model step records a context meter in its metadata. It is shown on Home, in
the flight detail **Model & effort** card, and on the remote status view as a
percentage only.

- **Tokens.** Provider-reported prompt usage wins when it is non-zero
  (`input_tokens + cache_read_tokens + cache_creation_tokens`, as the provider
  reports them). Otherwise Cockpit estimates from the recorded request body.
  `source` says `provider` or `estimated`.
- **Window.** The context window comes from `models.json`. If the model is
  unknown, `window` and `percent` are absent and the UI says the window is
  unknown. A percentage is never invented.
- **Breakdown.** `system`, `tools`, `history`, `files`, and `other` are always an
  estimate from the recorded body, because providers report a single prompt
  total. Text is estimated at roughly four characters per token; images and file
  blocks add conservative fixed estimates. The breakdown is labeled as an
  estimate even when the total is provider-reported.
- **Compaction.** A step is marked `compacted` when the prompt drops by at least
  30% **and** at least 2,000 tokens versus the previous step in the same flight.
  A small drop is not called a compaction.
- **Threshold.** `context.threshold` accepts a fraction (`0.8`) or a percentage
  (`80`, `80%`); the default is `0.8`. The meter is `high` at or above the
  threshold. `context.high` is sent once per crossing through the existing
  notification pipeline (stored event, live `agent.event`, in-app toast, and the
  optional ntfy ping). The recorder compares the previous step's stored `high`
  flag so a long flight does not notify on every request.
- **Remote.** A `view:status` device sees `contextPercent` only. Token counts, the
  window, the breakdown, and the model's source URL are not included in the
  status payload. A content-scoped device sees the full flight record as before.

## 6. Updating the table

1. Read the provider's current documentation. Do not infer a price, a limit, or
   an effort level from a model name.
2. Edit `models.json`. Keep the existing schema: `provider`, `model`,
   `displayName`, `aliases`, `contextWindow`, `maxOutput`, `effort`
   (`parameter`, optional `anthropicParameter` and `responsesParameter`, exactly
   one of `levels` or `budget`, `default`), `inputPerMtok`, `outputPerMtok`,
   optional `cacheReadPerMtok` and `cacheWritePerMtok`, `currency`, `source`,
   `verifiedOn`, optional `note`, and `deprecated`. A budget control declares
   `min`, `max`, `canDisable`, `dynamic`, and `step`.
3. Store an unknown value as `null` (or omit the field), not as a plausible
   number or `0`. The UI renders a missing price as **Price unknown**. Only use
   `0` when the provider genuinely charges zero.
4. Run `cargo test -p cockpit-core cost::` and
   `cargo test -p cockpit-daemon --test integration override`.
5. Re-check the demo seed's single unknown-cost call and the cost fixtures before
   changing a price.

The compiled table is a convenience, not a billing system. Provider prices and
model availability change; the `verifiedOn` date is the only claim Cockpit makes
about freshness.
