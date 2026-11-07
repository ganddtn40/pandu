# Cockpit 0.2.0 — Rewrite decision record

Status: Phase 2 complete
Branch: `rewrite`
Baseline: `main` at `1d65df2` (`feat: release Cockpit 0.1.0`)

This document records what Cockpit 0.1.0 does, what the rewrite keeps, what it
drops, and how the new system is put together. The old TypeScript/Node code is
kept under `legacy/` as the behavior spec until the Rust implementation reaches
parity. It is not a dependency of the new build.

## 1. Why rewrite

Cockpit 0.1.0 proved the product idea but grew into a 9-screen monorepo:
React web app, Tauri desktop shell, Capacitor Android shell, a Node daemon, a
Node CLI, and a shared TypeScript package. It worked, but it was hard to install,
hard to explain, and heavy for a tool that should feel invisible.

The rewrite has three goals:

1. **One small binary.** `cockpit` starts the daemon and serves an embedded UI.
   No Node runtime, no package manager, no background service to babysit.
2. **Four screens a beginner can understand.** Home, Flights, Approvals,
   Settings. Everything else is deferred, not deleted from the roadmap.
3. **Real glass, real speed.** A custom WebGL2 glass renderer and Svelte 5 UI,
   with strict size, memory, startup, and proxy-overhead budgets.

The rewrite is deliberately smaller than the old product. A feature returns only
when it can be explained on one screen and shipped without weakening the core
promise: record what agents do, show it live, replay it, and pause risky actions.

## 2. Audit of the old repository

The old repository is preserved at `legacy/`. It contains 380 tracked files and
389 passing tests at release time.

| Area | Old implementation | What it taught us |
| --- | --- | --- |
| Domain model | `legacy/packages/core` | Sessions, steps, tool calls, token usage, cost, trust scoring, guard rules, pairing codes |
| Daemon | `legacy/packages/daemon` | Proxy routing, SSE collection, recording, redaction, SQLite storage, WebSocket live events |
| Storage | `legacy/packages/daemon/src/db/schema.ts` | 30+ tables, including 8 feature areas cut from v1 |
| Proxy | `legacy/packages/daemon/src/proxy` | Compatible routes, protocol detection, header forwarding, fail-open behavior |
| SSE | `legacy/packages/daemon/src/sse` | OpenAI Chat/Responses and Anthropic streaming event shapes |
| Redaction | `legacy/packages/daemon/src/recording/redact.ts` | Sensitive headers/keys and provider token patterns |
| Git snapshots | `legacy/packages/daemon/src/git/snapshots.ts` | Temp index + `commit-tree`, never touching the user's index/HEAD/reflog |
| Guards | `legacy/packages/daemon/src/guards` | 7 built-in rules, pause/warn actions, approvals, budgets |
| Pairing | `legacy/packages/daemon/src/pairing/service.ts` | 8-char single-use codes, hashed device tokens, loopback trust |
| CLI | `legacy/packages/cli` | `start`, `run`, `demo`, `doctor`, `report`, pairing helpers |
| UI | `legacy/apps/web` | Useful information architecture, rejected visual language |

### 2.1 Proxy routes that must stay compatible

The rewrite keeps the old route surface so existing agent configurations do not
break:

- `/v1/...` — OpenAI-compatible default
- `/openai/v1/...` — force OpenAI protocol
- `/anthropic/v1/...` — force Anthropic Messages protocol
- `/s/:session/...` — bind a request to a known session, then use the same
  protocol rules

Protocol detection stays path-based for Anthropic (`/v1/messages`,
`/v1/complete`) and header-based when a client sends an explicit protocol.
Gemini `generateContent` is added in v1. SSE bytes are forwarded unbuffered and
never rewritten.

### 2.2 Storage model worth keeping

The new schema starts from the old one and keeps only what the four screens and
three capture modes need:

- `projects`, `settings`
- `sessions`, `steps`, `stream_chunks`, `tool_calls`
- `guard_rules`, `guard_events`
- `budget_policies`
- `redaction_rules`, `redactions`
- `git_snapshots`, `file_changes`
- `devices`, `pairing_tokens`
- `live_events`
- `replay_forks`

Cut tables belong to the deferred features and are listed in
`docs/ROADMAP.md`. Sessions gain explicit `capture_mode` (`proxy`, `log_watch`,
`hook_otel`), `agent_id`, and `source_label` columns so every flight can say
`Recorded via proxy` or `Observed from logs` without guessing.

The old database is not migrated in v1. The new daemon uses a fresh database at
`~/.cockpit/v2/cockpit.db` (or `$COCKPIT_HOME/cockpit.db`), so a 0.1.0
`~/.cockpit/cockpit.db` is never opened by accident. The store refuses a
database whose `sessions` table lacks the new `capture_mode` column. Importing a
0.1.0 database is a future, separate migration because the cut tables and new
capture columns make a blind copy unsafe.

### 2.3 Guard rules worth keeping

The seven built-in rules remain, expressed as data rather than code where
possible:

1. Private key material → pause
2. API key in content → warn
3. Destructive shell command → pause
4. Exfiltration-shaped endpoint → pause
5. Git history rewrite → warn
6. Release/deploy command → warn
7. Repeated instruction loop → warn

Guards and budgets can only pause or block in proxy mode. Log-watch and
hook/OTel flights are observe-only, and the UI says so.

### 2.4 Git snapshot algorithm worth keeping

Per step, snapshot the workspace with a temporary `GIT_INDEX_FILE`:

1. `git add -A` against the temporary index
2. `git write-tree`
3. `git commit-tree` with a synthetic parent
4. Diff the resulting tree against the step baseline
5. Store the patch and per-file changes in SQLite

Hard limits stay: 500 files, 300,000 characters per file diff, 2,000,000
characters per patch. The user's index, HEAD, branches, and reflog are never
touched. No git binary means snapshots are skipped with a visible warning, not a
failed flight.

### 2.5 Pairing and remote access worth keeping

- Codes use `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, 8 characters, displayed
  `XXXX-XXXX`, 5-minute default TTL, single use, SHA-256 hashed at rest.
- Device tokens use the `ckp_` prefix plus 32 random bytes, SHA-256 hashed at
  rest.
- Loopback is trusted. Non-loopback `/api/*` and `/s/*` require a Bearer token.
  `/api/health` and `/api/pairing/claim` stay public. WebSocket accepts
  `?token=`.
- The Android app is a companion. It never runs the recorder and never stores
  agent credentials.

## 3. Kept, cut, changed

### Kept

| Capability | Notes |
| --- | --- |
| Local-first SQLite storage | WAL mode, crash-safe writes, no cloud |
| Proxy recording | OpenAI Chat/Responses, Anthropic Messages, Gemini, OpenAI-compatible |
| Unbuffered SSE passthrough | Forward first, record second |
| Sessions, steps, tool calls, token usage, cost | Unified model for all capture modes |
| Live events + WebSocket UI updates | Home live flight and Flights detail |
| Redaction before storage | Forwarded bytes are never modified |
| Git snapshots | Temp index, graceful degradation |
| Guards, budgets, approvals | Proxy mode only |
| Trust score | One badge, no separate Trust screen |
| Demo mode | Seeds a realistic flight, works offline |
| Pairing | Desktop daemon + Android companion |
| `doctor` and `report` | Beginner-readable diagnostics |
| Old proxy routes | Backwards compatible |

### Cut from v1 (documented, not forgotten)

| Feature | Why it is out of v1 | Issue draft |
| --- | --- | --- |
| Arena | Multi-run comparison is a product of its own; it needs stable multi-agent recording first | [`issues/arena.md`](issues/arena.md) |
| Journal | Auto-written narrative is nice-to-have and needs a separate quality bar | [`issues/journal.md`](issues/journal.md) |
| Plugins | A plugin runtime multiplies the security and support surface | [`issues/plugins.md`](issues/plugins.md) |
| Project Brain | Repo indexing and context packs are a second product | [`issues/project-brain.md`](issues/project-brain.md) |
| Handoff | Valuable, but it depends on mature replay and project context | [`issues/handoff.md`](issues/handoff.md) |
| Understanding Debt/quizzes | Comprehension testing needs careful UX and cannot block the core loop | [`issues/understanding-debt.md`](issues/understanding-debt.md) |
| Context Doctor | Token-composition analysis is advanced and provider-specific | [`issues/context-doctor.md`](issues/context-doctor.md) |
| Provenance | Code-to-prompt attribution needs a trustworthy diff model first | [`issues/provenance.md`](issues/provenance.md) |

Old screens also fold into the four new ones:

| Old screen | New home |
| --- | --- |
| Overview, Analytics | Home |
| Sessions, Replay, Session detail | Flights |
| Guards, Trust | Home toggle + Approvals + Flights badge |
| Pair, Settings, Doctor | Settings + first-run wizard |
| Arena, Journal, Plugins, Brain, Handoff, Debt, Context, Understanding | Deferred; see issues |

### Changed

| Area | 0.1.0 | 0.2.0 |
| --- | --- | --- |
| Backend | TypeScript/Node | Rust 2024, tokio, axum, rusqlite |
| Desktop | Tauri 2 + Node daemon | Tauri 2 embedding the Rust daemon |
| Mobile | Capacitor app | Tauri 2 Android companion |
| UI | React + Vite, amber terminal style | Svelte 5 + Vite, WebGL2 glass, visionOS-inspired |
| CLI | Node CLI | Single static `cockpit` binary |
| Capture | Proxy only | Proxy, log-watch, hook/OTel, labeled per flight |
| Agents | Hand-written integrations | Data-driven TOML adapters |
| Onboarding | Multi-page setup | 3-step wizard, one copyable command |
| Languages | English | 14 languages, RTL support |
| Errors | Mixed technical messages | What happened + exact fix |
| Recording failure | Could fail a request | Fail-open with a visible warning |

## 4. v1 product scope

### Screens

1. **Home** — live flight, today's spend, token ring, guard on/off with pending
   count, recent flights. Every empty state has `Try demo`.
2. **Flights** — list and detail, timeline scrubber, step inspector (prompt,
   response, tool calls), per-step git diff, cost, one trust badge, `Fork from
   here`.
3. **Approvals** — large Approve/Deny cards with a countdown ring.
4. **Settings** — Add an agent wizard, language, theme, wallpaper, privacy,
   `Report a bug`, about/updates.

First run is a 3-step wizard: pick an agent → copy one command → watch the
flight appear.

### Capture modes

| Mode | Examples | Can pause? | UI label |
| --- | --- | --- | --- |
| Proxy | OpenCode, Cline, Roo/Kilo, Aider, Goose, Crush, Pi, OpenHands, Qwen Code, Amp, OpenAI-compatible tools | Yes | `Recorded via proxy` |
| Log-watch | Claude Code, Codex CLI, Cursor CLI, Copilot CLI, Antigravity/Gemini CLI | No | `Observed from logs` |
| Hook/OTel | Agents exposing hooks or OpenTelemetry export | No | `Observed via hook` |

Adapters live in `adapters/*.toml`. Each declares its name, detect command, env
wrapping, session-file paths, parser, docs link, and `verified` flag. The loader
is data-driven so a new agent is a one-file PR. Unverified adapters are shipped
with `verified = false` until checked against current vendor documentation.

### CLI

```
cockpit                 start the daemon and open the UI
cockpit run -- <agent>  start the agent with Cockpit's environment
cockpit demo            seed a demo flight
cockpit doctor          check install, ports, database, git, adapters
cockpit report          build a redacted diagnostics bundle
cockpit pair            show a pairing code for the Android companion
```

Every error states what happened and the exact fix.

## 5. Architecture

```
crates/
  cockpit-core/     domain types, pricing, adapter model, redaction, SSE parsing
  cockpit-daemon/   axum proxy + API + WebSocket, SQLite, watchers, guards, snapshots
  cockpit-cli/      the `cockpit` binary; embeds UI assets via rust-embed
app/                Tauri 2 desktop + Android companion
ui/                 Svelte 5 + TypeScript + Vite; custom WebGL2 glass
adapters/           TOML agent definitions
docs/               beginner docs, rewrite record, roadmap, issue drafts
packaging/          cargo-dist, npm wrapper, winget, scoop, Tauri, Android
legacy/             0.1.0 TypeScript/Node behavior spec (delete after parity)
```

Dependency direction is one-way: `cockpit-cli` → `cockpit-daemon` →
`cockpit-core`. The Tauri app embeds the daemon crate. The UI talks to the
daemon over loopback HTTP/WebSocket. The Android companion uses the same API
over the LAN with a paired device token.

### Fail-open contract

If recording, guards, redaction, snapshots, or SQLite fail, the proxy still
forwards the request and response bytes. The failure is logged, surfaced as a
warning in the UI, and never changes the upstream payload. The user's agent must
not break because Cockpit broke.

### Performance budgets

| Budget | Target |
| --- | --- |
| CLI binary | < 12 MB |
| Idle RAM | < 40 MB |
| Startup | < 300 ms |
| UI JavaScript | < 150 KB gzip |
| Android APK | < 15 MB |
| Proxy overhead | < 2 ms p99 |

These are release gates, not aspirations. Phase 8 measures them on a clean
machine and records the numbers.

### Visual direction

One large frosted panel (radius 32–40) over a softly blurred wallpaper, nested
matte translucent tiles (24–28), floating top pill, floating left icon pill, and
a floating bottom tab pill. Neutral monochrome glass with one accent:
`#4DA3FF` for live/active. Green and red only for status. Dark theme uses smoky
glass with cream `#F4EFD8` selected pills. System UI font stack, sentence case,
tabular numbers. No amber-on-black, no monospace uppercase labels, no serif
display type, no hero marketing headlines, no radar/grid decoration, no sharp
corners.

The glass engine is custom WebGL2 in `ui/src/glass`: one canvas renders the
wallpaper and up to 12 SDF squircle glass shapes with edge refraction,
chromatic aberration, specular rim light, tint, and saturation. Blur is
precomputed at quarter resolution and only recomputed when the wallpaper
changes. DOM content stays above the canvas with transparent backgrounds.
Fallbacks: CSS `backdrop-filter`, reduced transparency, reduced motion, and a
Performance mode setting.

## 6. Non-goals for v1

- No cloud account, sync, or telemetry.
- No TLS interception and no reading agent credentials.
- No blocking in log-watch or hook mode.
- No old database migration.
- No plugin runtime.
- No team/multi-user server.
- No mobile recorder; Android is a viewer/approver companion.
- No push notifications or background update pings.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Agent log formats change | Adapters are versioned TOML; fixtures and parser tests; `verified` flag; `doctor` reports drift |
| WebGL2 unavailable or slow | CSS fallback, reduced-transparency mode, Performance mode, 12-shape cap, on-demand rendering |
| Binary exceeds 12 MB | `opt-level = "z"`, LTO, strip, `panic = "abort"`, rustls, embedded AVIF/WebP assets, Phase 8 size check |
| SSE edge cases break clients | Byte-for-byte passthrough; parser only observes a copy; integration tests with mock upstreams; property tests |
| Fail-open hides real failures | Every degraded path emits a typed warning and a visible UI badge; `doctor` reports recent warnings |
| Cross-platform paths and file watching | Platform dirs via `directories`, path tests on Windows/macOS/Linux, no shell assumptions |
| Android pairing exposure | Single-use short codes, hashed tokens, TTL, rate limits, loopback trust, explicit pairing screen |
| Rewrite stalls before parity | Phases with hard gates; legacy code remains runnable until Phase 8; cut features are issue drafts, not silent removals |
| Rust toolchain absent on this machine | Phase 0 writes configs and CI; Phase 1 starts by installing stable Rust or documenting the blocker before code changes |

## 8. Phase plan

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 0 | Audit, rewrite record, roadmap, issue drafts, legacy move, workspace scaffold | Docs reviewed; workspace layout committed |
| 1 | Rust core, proxy, SQLite, SSE passthrough, redaction, tests | `cargo test`, clippy clean, mock upstream tests pass |
| 2 | Adapters A/B/C, TOML loader, CLI (`run`, `demo`, `doctor`, `report`, `pair`) | Adapter fixture tests; CLI smoke tests |
| 3 | Git snapshots, replay data, guards, budgets, approvals API | Snapshot safety tests; guard/budget tests |
| 4 | Svelte shell, glass engine, `/glass-preview`, screenshots | Automated visual checks + user visual approval (hard stop) |
| 5 | Four screens, onboarding wizard, i18n catalogs | Playwright e2e; missing-key CI passes |
| 6 | Tauri desktop + Android, pairing, packaging, CI/CD | Bundle builds; Android pairing test |
| 7 | Beginner docs, READMEs in 14 languages, community files | Link check; translation key check |
| 8 | Final verification, CHANGELOG, v0.2.0 notes, publish commands | All budgets measured; release checklist signed off |

### Phase 2 implementation notes

- Adapters are embedded from `adapters/*.toml` with rust-embed. User files in
  `<home>/adapters/*.toml` override built-ins by id; a broken user file becomes
  an `AdapterIssue`, never a startup failure.
- All 15 adapters ship with `verified = false`. `cockpit doctor` reports
  installed and verified counts, adapter issues, log-watch state, and daemon
  version drift.
- Parsers are compiled into the daemon: `claude-code-jsonl`, `codex-jsonl`,
  `gemini-cli-json`, `generic-jsonl`, `generic-json`. Adapter files can only
  name one; unknown names are rejected at load time.
- Log-watch polls every 2 s by default, reparses a changed file in full, and
  dedupes records with stable 64-bit keys stored in `logwatch.state.v1`. Open
  turns are held until the file has been quiet for 4 s; observed flights
  auto-complete after 10 quiet minutes. Symlinks and `.git`, `node_modules`,
  `target` are skipped; files are capped at 32 MB and 2,000 per adapter.
- File identity uses the platform file id on Unix and creation time on Windows.
  A content hash cannot identify an appended log.
- Observed steps are stored as completed rows with historical timestamps; they
  never pass through a fake running state.
- `cockpit pair` issues a six-digit, hashed, single-use code with a five-minute
  TTL and five attempts. A claim returns a 64-hex device token; only its hash is
  stored. Requiring the token on non-loopback requests lands in Phase 6.
- CLI commands `run`, `demo`, `doctor`, `report`, and `pair` are in place.
  `cockpit run` starts an owned daemon if needed, sets proxy environment
  variables from the matched adapter, and passes a local sentinel instead of the
  user's real API key.
- 123 tests pass at the Phase 2 gate (4 CLI, 65 core, 47 daemon unit, 7
  integration); fmt and clippy with `-D warnings` are clean.

## 9. Toolchain status

At Phase 0, this machine had Node `v24.21.0` and pnpm `12.9.1`, but no `cargo`,
`rustc`, or `rustup`. Phase 1 installed a repo-local stable toolchain under the
gitignored `.rustup/` and `.cargo/` directories, so builds do not touch a global
Rust install. The Phase 2 gate ran on `rustc 1.99.1` / `cargo 1.99.1`
(`x86_64-pc-windows-msvc`).

Phase 0 checks that did run:

- Every TOML file parses with Python `tomllib`.
- Every relative Markdown link resolves.
- The CI workflow parses as YAML.
- The new tree contains no staged `node_modules`, `dist`, or `target` output.
  Ignored build artifacts from 0.1.0 remain untracked under `legacy/` and are
  safe to delete later with an explicit, verified in-repo path.

Commands run at each phase gate:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build -p cockpit-cli
```

CI runs the same commands on Windows, macOS, and Linux. `Cargo.lock` is
committed and updated by the workspace build.

## 10. Definition of done for the rewrite

- One `cockpit` binary starts the daemon and UI with no Node runtime.
- Four screens work on desktop and phone widths, light and dark.
- Proxy, log-watch, and hook/OTel capture produce the same flight model with an
  honest per-flight label.
- SSE passthrough is byte-identical and unbuffered.
- A failed recorder never fails an agent request.
- Git snapshots never touch the user's index, HEAD, branches, or reflog.
- All 14 language catalogs load, with RTL for Arabic and a missing-key CI gate.
- Installers exist for Windows, macOS, Linux, npm, winget, scoop, and Android.
- `cargo fmt`, clippy with `-D warnings`, `cargo test`, cargo-deny, Playwright,
  and the size/RAM/startup/proxy budgets all pass.
- `legacy/` is deleted in its own commit only after parity is demonstrated.
