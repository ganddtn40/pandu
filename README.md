# Cockpit

**A local flight recorder and control tower for AI coding agents.**

Cockpit records what your agents do, shows it live, lets you replay every step,
and asks permission before risky actions. Everything stays on your machine. No
account, no cloud, no telemetry.

> **Status:** the 0.2.0 rewrite is in progress on the `rewrite` branch. Phases
> 0–5 are complete: the Rust core, proxy, adapters, guards, snapshots, the
> design v2 UI, and the five tabs wired to real daemon data. The shipped 0.1.0
> TypeScript/Node implementation is preserved under `legacy/` as the behavior
> spec. Next: agent control and notifications (Phase 6).

## What v0.2.0 will be

- **One binary.** `cockpit` starts the local daemon and opens the embedded UI.
- **Five tabs.** Home, Inbox, Flights, Market, Settings, plus a global quick
  prompt (`Ctrl/Cmd+K`).
- **Design v2.** Dark graphite bento dashboards with matte cards, hairline
  borders, one accent, and floating glass chrome. Three themes (Dark, Light,
  Frost), three surface styles (Bento Matte, Liquid Glass, Hybrid), and full
  appearance customization in Settings.
- **Three capture modes.** Proxy, log-watch, and hook/OTel, each labeled honestly
  per flight.
- **Local by default.** SQLite on disk, no telemetry, no TLS interception, no
  credential capture.
- **Fail-open.** If Cockpit breaks, your agent keeps working.

## Platform support

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

## Design and appearance

- Default accent: warm orange `#FF7A2F`. Presets: Orange, Cream, Blue, Green,
  Violet, Silver, Mono.
- Themes: Dark (default), Light, Frost.
- Surfaces: Bento Matte, Liquid Glass, Hybrid (default: matte cards, glass
  floating layers).
- Settings → Appearance controls theme, surface, accent, corner radius,
  density, font and size, glass intensity/blur/refraction, wallpaper
  (procedural/own image/none), card borders, motion, Performance mode, and
  language, with instant live preview.
- Preferences are per-device. Themes are versioned JSON (`cockpit.theme`,
  version 1) that can be exported, imported, and shared; imports are validated
  and never execute code. Wallpaper images stay on the device.
- Home widgets are rearrangeable and hideable: drag on desktop, long-press on
  phone.
- Demo mode is explicit: a `Demo` badge appears in the top bar, sessions and
  approvals carry a `Demo` chip, and live data is never mixed with seeded rows
  silently. Demo data is only offered when the daemon runs with
  `COCKPIT_DEMO=1`.

The full contract is in [`docs/DESIGN.md`](docs/DESIGN.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `crates/cockpit-core` | Domain types, pricing, adapters, redaction, SSE parsing |
| `crates/cockpit-daemon` | Proxy, API, WebSocket, SQLite, watchers, guards |
| `crates/cockpit-cli` | The `cockpit` binary; embeds UI assets |
| `app` | Tauri 2 desktop app and Android companion |
| `ui` | Svelte 5 + TypeScript + Vite UI and WebGL2 glass |
| `design` | Logo sources and export scripts |
| `adapters` | Data-driven TOML agent definitions |
| `docs` | Rewrite record, roadmap, design system, beginner docs, issue drafts |
| `packaging` | cargo-dist, npm wrapper, winget, scoop, Tauri, Android |
| `legacy` | 0.1.0 TypeScript/Node behavior spec |

## Development

Requirements once the rewrite is runnable:

- Rust stable 1.85+ (`rust-toolchain.toml` installs components via rustup)
- Node.js 22+ and pnpm 10+
- Git (optional; snapshots degrade gracefully without it)

Rust gates:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p cockpit-cli
```

UI gates:

```powershell
cd ui
pnpm install
pnpm check
pnpm test
pnpm build
pnpm exec playwright test
```

The UI preview is available at `http://127.0.0.1:5174` with `pnpm dev`, or
`http://127.0.0.1:4174` with `pnpm preview` after a build. Start the daemon with
`cockpit serve` (or `cockpit demo` for seeded data); the UI calls
`http://127.0.0.1:4319` on dev/preview ports and the same origin otherwise.
Playwright starts its own disposable demo and live daemons, so it never touches
your local database.

## Read more

- [Design system](docs/DESIGN.md) — tokens, surfaces, appearance, theme JSON
- [Rewrite decision record](docs/REWRITE.md) — what is kept, cut, and changed
- [Roadmap](docs/ROADMAP.md) — v0.2.0 scope, phases, and deferred features
- [Issue drafts](docs/issues/) — ready-to-paste `help wanted` work
- [Adapter format](adapters/README.md) — how to add an agent
- [UI notes](ui/README.md) — glass engine, budgets, and commands

## License

MIT. See [LICENSE](LICENSE).
