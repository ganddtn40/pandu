# Cockpit roadmap

Cockpit records what AI coding agents do, shows it live, replays it, and asks
permission before risky actions. Everything stays on the user's machine. Zero
telemetry.

This roadmap is honest about scope: v0.2.0 is intentionally small. Features that
are not in v1 have a written spec and a `help wanted` issue draft, so they can
come back without reopening old decisions.

## v0.2.0 — the rewrite (in progress)

**Theme:** one binary, four screens, three capture modes, real glass.

### Product

- [ ] Home: live flight, today's spend, token ring, guard toggle with pending
      count, recent flights
- [ ] Flights: list and detail, timeline scrubber, step inspector, per-step git
      diff, cost, one trust badge, `Fork from here`
- [ ] Approvals: large Approve/Deny cards with countdown ring
- [ ] Settings: Add an agent wizard, language, theme, wallpaper, privacy,
      `Report a bug`, about/updates
- [ ] First-run wizard: pick agent → copy one command → watch the flight appear
- [ ] `Try demo` on every empty state
- [ ] Honest per-flight capture label: `Recorded via proxy`, `Observed from
      logs`, or `Observed via hook`

### Capture

- [x] Proxy mode: OpenAI Chat + Responses, Anthropic Messages, Gemini
      `generateContent`, OpenAI-compatible endpoints
- [x] Unbuffered SSE passthrough
- [x] Log-watch mode: read-only, observe-only, clearly labeled
- [ ] Hook/OTel mode where supported
- [x] TOML adapters for OpenCode, Claude Code, Codex CLI, Cursor CLI, GitHub
      Copilot CLI, Antigravity/Gemini CLI, Cline, Roo/Kilo Code, Aider, Goose,
      Crush, Pi, OpenHands, Qwen Code, Amp
- [x] Adapter `verified` flag, surfaced by the API and `cockpit doctor`
- [ ] Adapter drift checks against current vendor docs

### Trust and safety

- [x] Seven built-in guard rules
- [x] Budget policies with warn/pause enforcement
- [x] Approvals API and countdown
- [x] Redaction before storage; forwarded bytes untouched
- [x] Git snapshots with a temporary index; graceful no-git fallback
- [x] Fail-open everywhere: a Cockpit failure never breaks an agent
- [x] Loopback-only by default; hashed pairing codes and device tokens

### App and UI

- [ ] Tauri 2 desktop embedding the daemon (single exe)
- [ ] Tauri 2 Android companion with QR/short-code pairing
- [x] Svelte 5 + TypeScript + Vite
- [x] Custom WebGL2 glass engine with CSS fallback, reduced transparency,
      reduced motion, and Performance mode
- [x] Light/dark/system themes and a procedural abstract wallpaper
- [ ] 14 language catalogs, RTL, missing-key CI gate
- [ ] Playwright e2e for the four screens

### Install and release

- [ ] cargo-dist CLI installers: PowerShell, shell, Homebrew
- [ ] npm wrapper (`npx cockpit`)
- [ ] winget and scoop manifests
- [ ] Tauri bundles: MSI/NSIS, dmg, AppImage/deb
- [ ] Signed Android APK with documented keystore steps
- [ ] Manual `Check for updates` only; no background pings
- [ ] README and beginner docs in all 14 languages

### Quality gates

- [x] `cargo fmt --all -- --check`
- [x] `cargo clippy --workspace --all-targets -- -D warnings`
- [x] `cargo test --workspace`
- [ ] `cargo deny check`
- [x] Mock upstream tests for OpenAI, Anthropic, and Gemini (streaming + errors)
- [ ] Property/fuzz tests for the SSE parser and redaction
- [x] Guard and budget tests
- [x] Adapter parser tests on fixtures
- [ ] Crash-safe SQLite tests
- [ ] CI matrix on Windows, macOS, Linux
- [ ] Performance: binary < 12 MB, idle RAM < 40 MB, startup < 300 ms, UI JS
      < 150 KB gzip, Android APK < 15 MB, proxy overhead < 2 ms p99

## Not in v0.2.0

These features existed in 0.1.0 or were designed for it. They are deliberately
out of v1 because each one is a product of its own and would weaken the core
loop if rushed. Each has a ready-to-paste issue draft with a spec and acceptance
criteria.

| Feature | Why it waits | Issue |
| --- | --- | --- |
| Arena | Needs stable multi-run recording and a fair comparison model | [`issues/arena.md`](issues/arena.md) |
| Journal | Needs a separate writing-quality bar and user trust | [`issues/journal.md`](issues/journal.md) |
| Plugins | A runtime multiplies security and support surface | [`issues/plugins.md`](issues/plugins.md) |
| Project Brain | Repo indexing is a second product | [`issues/project-brain.md`](issues/project-brain.md) |
| Handoff | Depends on mature replay and project context | [`issues/handoff.md`](issues/handoff.md) |
| Understanding Debt/quizzes | Comprehension UX needs careful research | [`issues/understanding-debt.md`](issues/understanding-debt.md) |
| Context Doctor | Provider-specific token analysis needs live fixtures | [`issues/context-doctor.md`](issues/context-doctor.md) |
| Provenance | Attribution needs a trustworthy diff model first | [`issues/provenance.md`](issues/provenance.md) |

Also deferred:

- Importing a 0.1.0 SQLite database (the v1 schema is not a blind copy)
- Team/multi-user server
- Cloud sync or hosted dashboards
- Mobile recording (Android is a companion, not a recorder)
- Push notifications
- TLS interception or credential capture (permanent non-goals)

## After v0.2.0

Order is a guess, not a promise. The community can change it by opening an issue
or picking up a `help wanted` draft.

1. **Stability window.** Fix real-world adapter drift, proxy edge cases, and
   install problems before adding surface area.
2. **Database import.** Read-only importer for 0.1.0 databases with a preview
   and explicit confirmation.
3. **Handoff + Provenance.** They reinforce replay and are useful to individual
   developers before teams.
4. **Context Doctor.** High value once enough real provider fixtures exist.
5. **Arena.** Only after multi-agent capture is boringly reliable.
6. **Journal + Understanding Debt.** Writing and learning features need their
   own design pass.
7. **Project Brain + Plugins.** Both are platforms; ship them when the core API
   is stable enough to support third parties.

## How to pick up work

1. Read `CONTRIBUTING.md` (added in Phase 7).
2. Pick an issue labeled `help wanted`.
3. Comment with your plan before large changes.
4. Keep the four-screen promise: new surface area needs a strong reason.
5. Every PR must pass fmt, clippy, tests, and the relevant adapter/e2e checks.

## Release criteria for v0.2.0

- All v0.2.0 checkboxes above are complete.
- A clean-machine install works on Windows, macOS, and Linux.
- The Android companion pairs and views flights over the LAN.
- The performance budgets are measured and recorded in the release notes.
- No known data-loss, credential-leak, or agent-breaking bug is open.
- `legacy/` is deleted only after parity is demonstrated in its own commit.
