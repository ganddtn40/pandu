# Cockpit roadmap

Cockpit records what AI coding agents do, shows it live, replays it, and asks
permission before risky actions. Everything stays on the user's machine. Zero
telemetry.

This roadmap is honest about scope: v0.2.0 is intentionally small. Features that
are not in v1 have a written spec and a `help wanted` issue draft, so they can
come back without reopening old decisions.

## v0.2.0 — the rewrite (in progress)

**Theme:** one binary, five tabs, three capture modes, design v2.

### Product

- [x] Five-tab IA: Home, Inbox, Flights, Market, Settings
- [x] Global quick prompt (`Ctrl/Cmd+K`, Home action, phone action button)
- [x] Home wired to the daemon: live flight, today's spend, token ring, guard
      state with pending count
- [x] Inbox: approvals and alerts with large Approve/Deny cards and countdown
- [x] Flights: list and detail, timeline scrubber, step inspector, per-step git
      diff, cost, live output, replay, deep links
- [ ] Flights: one trust badge and `Fork from here` (replay forks are deferred)
- [ ] Market: adapter and theme discovery, then the registry (Phase 8)
- [x] Settings: Add an agent flow, language, privacy, platform support,
      about/updates
- [ ] Settings: `Report a bug` diagnostics bundle
- [x] First-run tour: three steps, skip, replay from Settings
- [x] Demo seeding from Home, Flights, and Settings, always labeled `Demo`
- [ ] Honest per-flight capture label: `Recorded via proxy`, `Observed from
      logs`, or `Observed via hook`

Phase 5 wires the five tabs to real daemon data. The Market registry remains a
later phase; the screen says so instead of showing fake listings.

### Design v2

- [x] Dark (default), Light, and Frost themes
- [x] Three surface styles: Bento Matte, Liquid Glass, Hybrid (default)
- [x] Seven accent presets with a single accent per theme
- [x] Corner radius: Sharp, Soft (default), Round
- [x] Density: Compact, Comfortable (default), Spacious
- [x] Font: System, Inter, Mono for code; font size slider
- [x] Glass intensity, blur, and refraction sliders
- [x] Wallpaper: procedural, your image, or none
- [x] Card borders, motion (Full/Reduced/Off), and Performance mode
- [x] Live appearance sheet with instant preview and per-device persistence
- [x] Legacy settings migration
- [x] Versioned theme JSON export/import/share with validation, never executed
- [x] Bento widgets: drag on desktop, long-press on phone, hide and reset
- [x] New logo suite, wordmark, mono mark, and favicon
- [x] Contrast, style-ban, theme, wallpaper, widget, and visual gates
- [x] Per-screen empty/loading/error states wired to real data
- [x] Final visual approval by the user (Phase 4B)

The full token, surface, theme, and accessibility contract is in
[`DESIGN.md`](DESIGN.md).

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

- [ ] Tauri 2 Windows app embedding the daemon (single exe)
- [ ] Tauri 2 Android companion with QR/short-code pairing
- [ ] Web/PWA build served by the daemon
- [x] Svelte 5 + TypeScript + Vite
- [x] Design v2 shell, appearance engine, bento components, and quick prompt
- [x] Custom WebGL2 glass engine with CSS fallback, matte fallback, reduced
      transparency, reduced motion, Performance mode, a 16-shape desktop cap,
      and a 12-shape cap on phones and low-end devices
- [x] Playwright gates for the shell and design system
- [x] Playwright e2e for the five tabs against disposable demo and live daemons
- [x] i18n scaffolding: English complete, drafts fall back per key
- [ ] 14 complete language catalogs, RTL, missing-key CI gate

### Install and release

- [ ] cargo-dist CLI installers: PowerShell and shell
- [ ] npm wrapper (`npx cockpit`)
- [ ] winget and scoop manifests
- [ ] Windows Tauri bundle (MSI/NSIS)
- [ ] Signed Android APK with documented keystore steps
- [ ] Web/PWA bundle
- [ ] macOS, iOS, and Linux bundles (planned after v0.2.0)
- [ ] Manual `Check for updates` only; no background pings
- [ ] README and beginner docs in all 14 languages

### Platform support

| Platform | Status |
| --- | --- |
| Web (PWA) | Today |
| Android | Today |
| Windows | Today |
| macOS | Planned |
| iOS | Planned |
| Linux | Planned |

Android is a companion viewer/approver, not a recorder. Nothing outside the
"Today" rows is advertised as working.

### Quality gates

- [x] `cargo fmt --all -- --check`
- [x] `cargo clippy --workspace --all-targets -- -D warnings`
- [x] `cargo test --workspace`
- [x] `pnpm check`
- [x] `pnpm test` (13 files / 110 tests)
- [x] Playwright design, visual, and daemon e2e suite (38 tests)
- [x] Text contrast ≥ 4.5:1 across every theme, surface, and accent pair
- [x] 44 px minimum touch targets on phone
- [x] Zero idle canvas redraws and visible focus rings
- [x] UI JavaScript < 150 KB gzip (currently ~72.6 KB gzip)
- [ ] `cargo deny check`
- [x] Mock upstream tests for OpenAI, Anthropic, and Gemini (streaming + errors)
- [ ] Property/fuzz tests for the SSE parser and redaction
- [x] Guard and budget tests
- [x] Adapter parser tests on fixtures
- [ ] Crash-safe SQLite tests
- [ ] CI matrix on Windows, macOS, Linux
- [ ] Performance: binary < 12 MB, idle RAM < 40 MB, startup < 300 ms, Android
      APK < 15 MB, proxy overhead < 2 ms p99

### Release plan

| Phase | Focus |
| --- | --- |
| 4B | Design v2 complete; user visual approval (hard stop) — complete |
| 5 | Five tabs wired to the daemon, onboarding, i18n catalogs — complete |
| 6 | Agent control and notifications |
| 7 | Remote access security |
| 8 | Market registry |
| 9 | Model, effort, and context controls |
| 10 | Updates and backups |
| 11 | Packaging: Windows, Android, Web/PWA |
| 12 | Docs, benchmarks, 14 languages, v0.3.0 |

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
2. **macOS, iOS, and Linux.** Finish the planned platform matrix with signed
   bundles and the same honesty about what works.
3. **Database import.** Read-only importer for 0.1.0 databases with a preview
   and explicit confirmation.
4. **Handoff + Provenance.** They reinforce replay and are useful to individual
   developers before teams.
5. **Context Doctor.** High value once enough real provider fixtures exist.
6. **Arena.** Only after multi-agent capture is boringly reliable.
7. **Journal + Understanding Debt.** Writing and learning features need their
   own design pass.
8. **Project Brain + Plugins.** Both are platforms; ship them when the core API
   is stable enough to support third parties.

## How to pick up work

1. Read `CONTRIBUTING.md` (added in Phase 12).
2. Pick an issue labeled `help wanted`.
3. Comment with your plan before large changes.
4. Keep the five-tab promise: new surface area needs a strong reason.
5. Every PR must pass fmt, clippy, tests, `pnpm check`, Vitest, Playwright, and
   the relevant adapter/e2e checks.

## Release criteria for v0.2.0

- All v0.2.0 checkboxes above are complete.
- A clean-machine install works on Windows, Android, and Web/PWA.
- macOS, iOS, and Linux remain clearly labeled as planned until their bundles
  ship.
- The Android companion pairs and views flights over the LAN.
- The performance budgets are measured and recorded in the release notes.
- No known data-loss, credential-leak, or agent-breaking bug is open.
- `legacy/` is deleted only after parity is demonstrated in its own commit.
