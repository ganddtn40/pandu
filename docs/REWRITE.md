# Pandu 0.2.0 — Rewrite decision record

Status: Phase 5 complete
Branch: `rewrite`
Baseline: `main` at `1d65df2` (the 0.1.0 release commit)

This document records what release 0.1.0 does, what the rewrite keeps, what it
drops, and how the new system is put together. The old TypeScript/Node code is
kept under `legacy/` as the behavior spec until the Rust implementation reaches
parity. It is not a dependency of the new build.

## 1. Why rewrite

Release 0.1.0 proved the product idea but grew into a 9-screen monorepo:
React web app, Tauri desktop shell, Capacitor Android shell, a Node daemon, a
Node CLI, and a shared TypeScript package. It worked, but it was hard to install,
hard to explain, and heavy for a tool that should feel invisible.

The rewrite has three goals:

1. **One small binary.** `pandu` starts the daemon and serves an embedded UI.
   No Node runtime, no package manager, no background service to babysit.
2. **Five tabs a beginner can understand.** Home, Inbox, Flights, Market,
   Settings, plus one global quick prompt. Everything else is deferred, not
   deleted from the roadmap.
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

The new schema starts from the old one and keeps only what the five tabs and
three capture modes need:

- `projects`, `settings`
- `sessions`, `steps`, `stream_chunks`, `tool_calls`
- `guard_rules`, `guard_events`
- `budget_policies`
- `redaction_rules`, `redactions`
- `git_snapshots`, `file_changes`
- `devices`, `pairing_tokens`
- `live_events`

Replay forks are not part of 0.2.0, so there is no `replay_forks` table yet. The
replay response keeps an empty `forks` field so older clients still parse it.

Cut tables belong to the deferred features and are listed in
`docs/ROADMAP.md`. Sessions gain explicit `capture_mode` (`proxy`, `log_watch`,
`hook_otel`), `agent_id`, and `source_label` columns so every flight can say
`Recorded via proxy` or `Observed from logs` without guessing.

The 0.1.0 database is not imported. The new daemon uses a fresh database at
`~/.pandu/v2/pandu.db` (or `$PANDU_HOME/pandu.db`), so a 0.1.0 database is never
opened by accident. The store refuses a database whose `sessions` table lacks the
new `capture_mode` column. Importing a 0.1.0 database is a future, separate
migration because the cut tables and new capture columns make a blind copy
unsafe.

The rename itself is handled at first start: if the pre-rename data directory
exists and the new one does not, the daemon copies the whole tree, gives the
copied database its new file name, and leaves the old directory untouched. If
both directories exist, the new one wins and nothing is copied.

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
characters per patch, and a 30-second git timeout. The user's index, HEAD,
branches, and reflog are never touched. No git binary or no repository means
snapshots are skipped with a logged warning, not a failed flight; the UI shows
an honest empty state instead of claiming a snapshot exists.

### 2.5 Pairing and remote access worth keeping

- Codes use `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, 8 characters, displayed
  `XXXX-XXXX`, 5-minute default TTL, single use, SHA-256 hashed at rest.
- Device tokens use 32 random bytes, hex encoded, SHA-256 hashed at rest.
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

Old screens also fold into the five new tabs:

| Old screen | New home |
| --- | --- |
| Overview, Analytics | Home |
| Sessions, Replay, Session detail | Flights |
| Guards, Trust | Home toggle + Inbox + Flights badge |
| Pair, Settings, Doctor | Settings + first-run wizard |
| Arena, Journal, Plugins, Brain, Handoff, Debt, Context, Understanding | Deferred; see issues |

### Changed

| Area | 0.1.0 | 0.2.0 |
| --- | --- | --- |
| Backend | TypeScript/Node | Rust 2024, tokio, axum, rusqlite |
| Desktop | Tauri 2 + Node daemon | Tauri 2 embedding the Rust daemon |
| Mobile | Capacitor app | Tauri 2 Android companion |
| UI | React + Vite, amber terminal style | Svelte 5 + Vite, WebGL2 glass, design v2 bento |
| CLI | Node CLI | Single static `pandu` binary |
| Capture | Proxy only | Proxy, log-watch, hook/OTel, labeled per flight |
| Agents | Hand-written integrations | Data-driven TOML adapters |
| Onboarding | Multi-page setup | 3-step wizard, one copyable command |
| Languages | English | 14 languages, RTL support |
| Errors | Mixed technical messages | What happened + exact fix |
| Recording failure | Could fail a request | Fail-open with a visible warning |

## 4. v1 product scope

### Screens

1. **Home** — live flight, today's spend, token ring, guard state with pending
   count, and rearrangeable/hideable bento widgets (drag on desktop, long-press
   on phone). Every empty state has `Try demo`.
2. **Inbox** — approvals and alerts that need a decision, with large
   Approve/Deny cards and a countdown ring.
3. **Flights** — list and detail, timeline scrubber, step inspector (prompt,
   response, tool calls), per-step git diff, cost, one trust badge, `Fork from
   here`.
4. **Market** — agent adapters, shared themes, and the future registry of
   capture integrations. The registry itself ships in a later phase.
5. **Settings** — Add an agent wizard, appearance, language, privacy,
   `Report a bug`, about/updates.

A global quick prompt (`Ctrl/Cmd+K`, or the Home/phone action button) is
available from every tab. First run is a 3-step wizard: pick an agent → copy one
command → watch the flight appear.

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
pandu                 start the daemon and open the UI
pandu run -- <agent>  start the agent with Pandu's environment
pandu demo            seed a demo flight
pandu doctor          check install, ports, database, git, adapters
pandu report          build a redacted diagnostics bundle
pandu pair            show a pairing code for the Android companion
```

Every error states what happened and the exact fix.

## 5. Architecture

```
crates/
  pandu-core/     domain types, pricing, adapter model, redaction, SSE parsing
  pandu-daemon/   axum proxy + API + WebSocket, SQLite, watchers, guards, snapshots
  pandu-cli/      the `pandu` binary; embeds UI assets via rust-embed
app/                Tauri 2 desktop + Android companion
ui/                 Svelte 5 + TypeScript + Vite; custom WebGL2 glass
adapters/           TOML agent definitions
docs/               beginner docs, rewrite record, roadmap, issue drafts
packaging/          cargo-dist, npm wrapper, winget, scoop, Tauri, Android
legacy/             0.1.0 TypeScript/Node behavior spec (delete after parity)
```

Dependency direction is one-way: `pandu-cli` → `pandu-daemon` →
`pandu-core`. The Tauri app embeds the daemon crate. The UI talks to the
daemon over loopback HTTP/WebSocket. The Android companion uses the same API
over the LAN with a paired device token.

### Fail-open contract

If recording, guards, redaction, snapshots, or SQLite fail, the proxy still
forwards the request and response bytes. The failure is logged, surfaced as a
warning in the UI, and never changes the upstream payload. The user's agent must
not break because Pandu broke.

### Performance budgets

| Budget | Target |
| --- | --- |
| CLI binary | < 12 MB |
| Idle RAM | < 40 MB |
| Startup | < 300 ms |
| UI JavaScript | < 90 KB gzip initial per entry; < 200 KB total |
| Android APK | < 15 MB |
| Proxy overhead | < 2 ms p99 |

These are release gates, not aspirations. The measured Windows numbers are in
[`BENCHMARKS.md`](BENCHMARKS.md); the Android APK and proxy p99 remain open.

### Visual direction

Design v2: light paper bento dashboards, matte cards with 1 px hairlines and
20–28 px radii, large ink numerals, thin charts, one accent, and a subtle status
glow. A left icon rail and floating glass top bar frame the workspace; sheets,
modals, toasts, and phone navigation are the only floating glass layers. The
default accent is blue `#2F7FE0`. Light is the default theme, with Dark and
Frost variants. No amber-on-black, no monospace uppercase labels, no serif
display type, no hero marketing headlines, no radar/grid decoration, no sharp
corners.

Three surface styles: Bento Matte (solid cards, no blur), Liquid Glass
(everything refracts), and Hybrid (default: matte cards, glass floating layers).
Full appearance customization lives in Settings → Appearance: accent presets,
corner radius, density, font and size, glass intensity/blur/refraction,
procedural or user wallpaper, card borders, motion, Performance mode, and
language. Preferences persist per device and are applied before first paint.

The glass engine is custom WebGL2 in `ui/src/glass`: one canvas renders the
wallpaper and up to 16 SDF squircle glass shapes with edge refraction,
chromatic aberration, specular rim light, tint, and saturation. Blur is
precomputed at quarter resolution and only recomputed when the wallpaper
changes. DOM content stays above the canvas with transparent backgrounds.
Fallbacks: CSS `backdrop-filter`, matte surfaces, reduced transparency, reduced
motion, Performance mode, and `?glass=off`. Overlay sheets use CSS glass over an
opaque `--sheet-bg` because the canvas sits below the scrims.

Themes are versioned JSON (`pandu.theme`, version 1), validated on import and
never executed. Wallpaper images and Performance mode are device-local and are
never exported. The full token and component contract is in
[`DESIGN.md`](DESIGN.md).

## 6. Non-goals for v1

- No cloud account, sync, or telemetry.
- No TLS interception and no reading agent credentials.
- No blocking in log-watch or hook mode.
- No 0.1.0 database import; the rename only copies the current data directory.
- No plugin runtime.
- No team/multi-user server.
- No mobile recorder; Android is a viewer/approver companion.
- No push notifications or background update pings.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Agent log formats change | Adapters are versioned TOML; fixtures and parser tests; `verified` flag; `doctor` reports drift |
| WebGL2 unavailable or slow | CSS fallback, matte surface, reduced-transparency mode, Performance mode, 16-shape cap, on-demand rendering |
| Binary exceeds 12 MB | `opt-level = "z"`, LTO, strip, `panic = "abort"`, rustls, embedded AVIF/WebP assets, Phase 12 size check |
| SSE edge cases break clients | Byte-for-byte passthrough; parser only observes a copy; integration tests with mock upstreams; property tests |
| Fail-open hides real failures | Every degraded path emits a typed warning and a visible UI badge; `doctor` reports recent warnings |
| Cross-platform paths and file watching | Platform dirs via `directories`, path tests on Windows/macOS/Linux, no shell assumptions |
| Android pairing exposure | Single-use short codes, hashed tokens, TTL, rate limits, loopback trust, explicit pairing screen |
| Rewrite stalls before parity | Phases with hard gates; legacy code remains runnable until Phase 12; cut features are issue drafts, not silent removals |
| Rust toolchain absent on this machine | Phase 0 writes configs and CI; Phase 1 starts by installing stable Rust or documenting the blocker before code changes |

## 8. Phase plan

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 0 | Audit, rewrite record, roadmap, issue drafts, legacy move, workspace scaffold | Docs reviewed; workspace layout committed |
| 1 | Rust core, proxy, SQLite, SSE passthrough, redaction, tests | `cargo test`, clippy clean, mock upstream tests pass |
| 2 | Adapters A/B/C, TOML loader, CLI (`run`, `demo`, `doctor`, `report`, `pair`) | Adapter fixture tests; CLI smoke tests |
| 3 | Git snapshots, replay data, guards, budgets, approvals API | Snapshot safety tests; guard/budget tests |
| 4 | Svelte shell, glass engine, `/glass-preview`, screenshots | Automated visual checks + user visual approval (hard stop) |
| 4B | Design v2: tokens, surfaces, appearance engine, bento components, logo, screenshots | Contrast/style/visual checks + user visual approval (hard stop) |
| 5 | Five screens wired to the daemon, onboarding wizard, i18n catalogs | Playwright e2e; missing-key CI passes |
| 6 | Agent control and notifications | Live flight, approval, and notification tests |
| 7 | Remote access security | Pairing, token, and non-loopback access tests |
| 8 | Market registry | Registry install/remove and theme-sharing tests |
| 9 | Model, effort, and context controls | Provider capability tests; no silent defaults |
| 10 | Updates and backups | Manual update check; backup/restore test |
| 11 | Packaging: Windows, Android, Web/PWA | Signed bundles; clean-machine install |
| 12 | Docs, benchmarks, 14 languages, v0.3.0 | All budgets measured; release checklist signed off |

### Phase 2 implementation notes

- Adapters are embedded from `adapters/*.toml` with rust-embed. User files in
  `<home>/adapters/*.toml` override built-ins by id; a broken user file becomes
  an `AdapterIssue`, never a startup failure.
- All 15 adapters ship with `verified = false`. `pandu doctor` reports
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
- `pandu pair` issues a six-digit, hashed, single-use code with a five-minute
  TTL and five attempts. A claim returns a 64-hex device token; only its hash is
  stored. Requiring the token on non-loopback requests lands in Phase 7.
- CLI commands `run`, `demo`, `doctor`, `report`, and `pair` are in place.
  `pandu run` starts an owned daemon if needed, sets proxy environment
  variables from the matched adapter, and passes a local sentinel instead of the
  user's real API key.
- 123 tests pass at the Phase 2 gate (4 CLI, 65 core, 47 daemon unit, 7
  integration); fmt and clippy with `-D warnings` are clean.

### Phase 3 implementation notes

- Guards and redaction share one pattern list in `pandu-core`. A secret is
  masked before storage; the forwarded bytes are never changed. Overlapping
  patterns are both reported, matching 0.1.0 behavior.
- Seven built-in guard rules are seeded idempotently: private key (pause), API
  key (warn), destructive command (pause), exfiltration endpoint (pause), git
  rewrite (warn), release command (warn), and instruction loop (warn).
- Pauses wait on an in-memory, single-use approval broker. The default window is
  120 s (`PANDU_GUARD_APPROVAL_MS`). Deny and expiry return 403
  `guard_blocked`; a budget block returns 402 `budget_exceeded`. Every detector
  fails open: a guard or budget error is logged and the request continues.
- Budgets are local arithmetic over recorded spend. Warn policies raise one
  event at 80% per period; pause policies use the same broker; block policies
  stop the request. A project-scoped policy is accepted but never applies because
  0.2.0 sessions carry no project id.
- Git snapshots run with a throwaway `GIT_INDEX_FILE`: `git add -A`,
  `git write-tree`, then `git commit-tree` with the previous snapshot as parent.
  Snapshot commits are unreferenced, so the user's index, HEAD, branch, and
  reflog stay byte-for-byte unchanged. Captures are serialized, time out after
  30 s, and degrade to a logged warning outside a repository.
- Snapshot limits are 500 files, 300,000 characters per file diff, and 2,000,000
  characters per patch. Temporary index files are removed on every path.
- `/api/sessions/{id}/replay` returns the flight, its steps, snapshot summaries,
  and an empty `forks` list. `/api/snapshots/{id}` returns the full patch and
  per-file changes. Forks remain deferred.
- Guard, budget, replay, snapshot, and secret-scan routes are live:
  `/api/guards/rules`, `/api/guards/rules/{id}`, `/api/guards/events`,
  `/api/guards/events/{id}/decision`, `/api/budgets`, `/api/budgets/{id}`,
  `/api/sessions/{id}/budgets`, `/api/sessions/{id}/replay`,
  `/api/sessions/{id}/scan`, and `/api/snapshots/{id}`.
- 147 tests pass at the Phase 3 gate (4 CLI, 75 core, 60 daemon unit, 8
  integration). Snapshot tests assert that HEAD, the real index, and the reflog
  are unchanged; proxy tests assert that guard and budget blocks never reach the
  upstream provider. fmt and clippy with `-D warnings` are clean.

### Phase 4 implementation notes

- `ui/` is a standalone Svelte 5 + TypeScript + Vite app with two gate routes:
  `/` (shell preview) and `/glass-preview` (visual test page). The daemon keeps
  its placeholder until the UI is embedded during packaging, so a clean
  `cargo build` does not depend on `ui/dist`.
- The glass engine is one custom WebGL2 canvas in `ui/src/glass`. A procedural
  wallpaper is rendered once to a full-resolution texture; a quarter-resolution
  two-pass blur feeds instanced SDF squircle shapes (max 12 at Phase 4, raised
  to 16 in Phase 4B) with edge refraction, chromatic aberration, specular rim
  light, tint, depth, and pointer parallax. Rendering is on demand, capped at
  60 fps desktop / 30 fps mobile, and paused while the page is hidden.
- Inner tiles are clipped to their nearest `[data-glass]` ancestor in the
  fragment shader, so scrolling content cannot paint outside the main panel.
- Fallbacks: `?glass=off`, `?perf=1` or the stored Performance preference,
  `prefers-reduced-transparency`, missing WebGL2, and init failure. The engine
  sets `data-glass-mode` to `webgl` or `fallback`; CSS `backdrop-filter` is the
  fallback. Reduced transparency also disables backdrop blur.
- Light and dark themes resolve from a forced URL value, then
  `localStorage['pandu.theme']`, then the OS preference. The theme is applied
  before first paint and survives reloads.
- The bundled font is a 48 KB Inter variable Latin subset, used after system UI
  fonts with `font-display: swap`. No font-loading layout shift.
- Text contrast was raised for the gate: `--text-soft` and `--text-faint` are
  darker, status text uses `--accent-ink`, `--success`, and `--danger`, and
  filled accent buttons use `--accent-strong` with white text.
- Phone controls are at least 44×44 px. Playwright checks the top bar, tab bar,
  buttons, segmented controls, text links, and toggles.
- `pnpm check` is clean. Vitest covers routing, theme resolution, preferences,
  DPR/radius clamping, visibility, and instance packing (26 tests). Playwright
  covers 1440×900 and 390×844, light/dark, `/` and `/glass-preview`, WebGL and
  fallback, horizontal overflow, theme persistence, focus rings, and touch
  targets (10 tests). Headless Chromium reports reduced transparency by default,
  so the visual spec overrides that one media query to exercise the real WebGL
  path.
- The built UI is 27.2 KB JavaScript + 4.1 KB CSS gzip, well under the 150 KB
  budget.
- Screenshots are committed in `docs/screenshots/phase4/`. Phase 4 stops here
  for user visual approval before the five screens are wired to the daemon.

### Phase 4 visual review fixes

- Phone scroll areas reserve the floating tab pill height plus 16 px and the
  safe-area inset; Playwright scrolls to the bottom at 390×844 and 360×640 and
  asserts the last card keeps a 16 px gap.
- The dark wallpaper now uses smoky blue-gray, warm-cream, and muted mauve
  pools over a ~10% base. Dark glass is a smoked near-black tint with a stronger
  edge offset, so the pools read through without lowering text contrast.
- The CSS fallback reuses the same five-gradient wallpaper recipe, plus the
  checker pattern, instead of a flat black body.
- The brand mark is a currentColor ring with a compass dot and needle.
- Light and dark text tokens are gated by a unit test that composites every
  text token over every surface token, including the brightest wallpaper pool.
  Light secondary text, accent ink, success, and danger were darkened to pass.
- Stat numerals are 44 px / 600 weight with tabular figures; phone stat tiles
  stack below 520 px so the numerals keep their size.
- Rail icons and the new-flight button have hover/focus tooltips alongside
  their aria-labels.
- `/glass-preview` has a full-width refraction test with a checker wallpaper
  toggle and a diagnostics overlay for shader mode, shape count, FPS, and
  redraws. The debug readout is excluded from the mutation observer, and a
  Playwright test asserts zero canvas redraws after three idle seconds.

### Phase 4B implementation notes (Design v2)

- Design v2 replaces the pure-glass shell with graphite bento dashboards: matte
  cards, 1 px hairlines, 20–28 px card radii, large light numerals, thin charts,
  one accent, and a left icon rail under a floating glass top bar. Floating
  sheets, toasts, modals, and the phone tab bar are the only glass chrome.
- Three surface styles: Bento Matte, Liquid Glass, and Hybrid (default: matte
  cards, glass floating layers). Themes: Light (default), Dark, Frost. Accent
  presets: Blue (default `#2F7FE0`), Orange, Cream, Green, Violet, Silver, Mono.
- Design tokens are data attributes on `<html>` (`data-theme`, `data-surface`,
  `data-accent`, `data-radius`, `data-density`, `data-font`, `data-motion`,
  `data-borders`, `data-wallpaper`, `data-performance`). `ui/index.html` applies
  the stored design before first paint, so reloads do not flash the defaults.
- The IA is now five tabs: Home, Inbox, Flights, Market, Settings. Approvals
  live in Inbox. A global quick prompt opens from `Ctrl/Cmd+K`, the Home action,
  or the phone action button. `/welcome` previews onboarding; `/glass-preview`
  remains the internal rendering lab.
- Settings → Appearance is a full customization sheet with instant live preview:
  theme, surface, accent, radius, density, font and size, glass
  intensity/blur/refraction, procedural/user/none wallpaper, card borders,
  motion, Performance mode, and language. Preferences persist per device under
  `pandu.design`; the wallpaper image uses `pandu.wallpaperImage`. Legacy
  theme/performance/pattern keys migrate automatically.
- Themes are versioned JSON (`pandu.theme`, version 1). Export writes
  `pandu-theme.json`; import validates every field, clamps numbers, rejects
  unknown enum values, limits files to 32 KB, and never executes code. Share
  links encode the same object in `?share=`. Wallpaper images and Performance
  mode are device-local and are never exported.
- Home is a bento grid of rearrangeable and hideable widgets. Desktop uses drag
  and drop; phone uses long-press edit mode. Order and visibility persist under
  `pandu.widgets`; a reset action restores the default layout.
- The glass engine now supports theme-aware tint and wallpaper scrims (light and
  frost are light surfaces; only dark is smoked), accent tinting, surface layer
  filtering (`card` vs `float`), intensity/blur/refraction uniforms, image
  wallpapers, and dynamic matte/Performance switching without a reload. The
  shape cap is 16.
- Overlay surfaces (appearance sheet, quick prompt, toast, phone tab bar) use CSS
  glass over an opaque `--sheet-bg` instead of WebGL shapes, because the canvas
  sits below their scrims. Playwright asserts their background alpha stays at or
  above 0.9.
- Accent contrast inks were corrected for light/frost orange, blue, and green so
  text on accent fills reaches 4.5:1. The CSS and TypeScript palettes are gated
  by a parity test.
- A new inline squircle logo, wordmark, mono mark, favicon, and a Playwright
  export script live in `design/logo/`. Generated PNGs are gitignored.
- `pnpm check` is clean (0 errors, 0 warnings). Vitest runs 10 files / 95 tests.
  The build is ~150.0 KB JavaScript (49.6 KB gzip) and ~50.1 KB CSS (9.7 KB
  gzip). Playwright runs 23 tests: desktop and phone, three themes, three surface
  styles, fallback, live appearance, Performance mode, quick prompt, widget
  editing, theme import/export/share, wallpaper storage, focus rings, and touch
  targets. Screenshots are in `docs/screenshots/phase4b/`.
- Phase 4B stops here for user visual approval before Phase 5 wires the screens
  to the daemon.

### Phase 4B review fixes

- One logo, in the top bar only. The rail starts with the nav icons and then a
  `+` that opens Add agent (tooltip plus `aria-label="Add agent"`).
- Minimum text is 12 px, or 13 px at 720 px and below. Sub-13 px declarations
  are wrapped in `max(var(--text-min), calc(Npx * var(--font-scale)))`, so the
  font-size preference can grow text but never shrink it below the floor.
- The phone tab pill uses an opaque `--sheet-bg` layer under CSS glass, with a
  stronger scrim and blur, so content never shows through the labels.
- The dark wallpaper is neutral graphite: smoky blue-gray pools with no warm
  tint, and the base surfaces stay within a narrow channel spread. Accent is a
  subtle glow, not a background wash.
- Development copy is gone from user-facing screens. Real daemon data replaced
  sample rows; demo mode is the only source of seeded data and always shows a
  `Demo` badge or chip. `/glass-preview` resolves to Home in production builds.
- The glass engine caps shapes at 12 on phones and low-end devices (16 on
  desktop). Low-end devices and battery saver auto-enable Performance mode on
  first run; the user can still turn it off.
- The mark was checked at 16, 24, and 32 px. `Logo.svelte` uses the glossy
  raster tile at 28 px and above, and switches to the flat vector P below 28 px.
  `ui/public/logo-small.svg` is the flat 32 px favicon with no gradients.

### Phase 5 implementation notes (real data)

- `ui/src/lib/api/` adds a typed daemon client and a reactive store. The client
  resolves the base URL from `window.__panduDaemonUrl`, then
  `http://127.0.0.1:4319` on dev/preview ports, then the page origin. The store
  polls sessions, guards, adapters, and settings, and keeps a reconnecting
  WebSocket to `/api/live`. `liveEvents` and `pendingGuards()` drive the shell
  badges and flight output.
- Home, Inbox, Flights, Market, and Settings all read daemon data. Every screen
  has explicit loading, empty, offline, and error states. Demo rows are shown
  only when `/api/health` reports `demoMode`, and they carry a `Demo` chip.
- First run redirects to `/welcome` until `pandu.onboarded` is set. The tour
  has three steps, can be skipped, and can be replayed from Settings. The
  redirect uses the router (`navigate('/welcome', { replace: true })`) because
  the router module initializes from the URL during import.
- Add agent lists the real adapters from `/api/adapters`, shows installed and
  missing state, and copies `pandu run -- <agent>` with a toast. The quick
  prompt cannot send prompts through the daemon yet, so it copies the command
  or prompt and says so instead of pretending to send.
- Flights supports status filters, search, `?session=<id>` deep links, recorded
  stream output, live chunks received after load, a replay scrubber and play
  control, lazy step details, and lazy snapshot details. The replay route
  returns snapshot summaries; the patch and per-file changes are fetched from
  `/api/snapshots/{id}` the first time a snapshot is expanded.
- Inbox approves or denies through
  `/api/guards/events/{id}/decision` and moves the event to the resolved list.
  The demo seed includes one pending approval so the flow is testable offline.
- i18n lives in `ui/src/lib/i18n/catalog.ts`: English is complete, draft
  catalogs fall back per key, and `{name}` placeholders interpolate only when
  the variable exists. The reactive `t()` reads the language from the design
  store.
- Production builds hide `/glass-preview`; development keeps it as the
  rendering lab. Diagnostics stay out of user-facing screens.
- Playwright starts disposable daemons itself: demo on port 4321 and live on
  4322, each with a fresh `ui/.tmp/e2e-*` home. The suite never touches the
  developer's database.
- `pnpm check` is clean. Vitest runs 13 files / 110 tests, including router
  query/dev-only behavior, device caps and auto Performance mode, i18n
  fallback, no-development-copy, small logo, and neutral graphite. Playwright
  runs 38 tests (desktop and phone) against the real daemon, covering demo
  labels, onboarding, approvals, replay, deep links, lazy snapshots, live
  WebSocket output, appearance, theme JSON, widgets, glass budgets, focus rings,
  and touch targets. The build is 228.6 KB JavaScript (72.6 KB gzip) and
  73.0 KB CSS (12.5 KB gzip). Screenshots are in `docs/screenshots/phase5/`.
- Phase 5 stops here for review before Phase 6 (agent control and
  notifications).

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
cargo build -p pandu-cli
```

CI runs the same commands on Windows, macOS, and Linux. `Cargo.lock` is
committed and updated by the workspace build.

## 10. Definition of done for the rewrite

- One `pandu` binary starts the daemon and UI with no Node runtime.
- Five tabs — Home, Inbox, Flights, Market, Settings — work on desktop and phone
  widths in Dark, Light, and Frost, with all three surface styles.
- The appearance sheet, theme JSON import/export/share, bento widgets, and quick
  prompt work without a reload and persist per device.
- Platform support is stated honestly: Web (PWA), Android, and Windows today;
  macOS, iOS, and Linux planned. Nothing unsupported is advertised as working.
- Proxy, log-watch, and hook/OTel capture produce the same flight model with an
  honest per-flight label.
- SSE passthrough is byte-identical and unbuffered.
- A failed recorder never fails an agent request.
- Git snapshots never touch the user's index, HEAD, branches, or reflog.
- All 14 language catalogs load, with RTL for Arabic and a missing-key CI gate.
- Installers exist for Windows, Android, Web/PWA, npm, winget, and scoop.
  macOS, iOS, and Linux installers are planned, not promised for v0.2.0.
- `cargo fmt`, clippy with `-D warnings`, `cargo test`, cargo-deny, Playwright,
  and the size/RAM/startup/proxy budgets all pass.
- `legacy/` is deleted in its own commit only after parity is demonstrated.
