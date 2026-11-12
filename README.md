<p align="center">
  <img src="docs/assets/readme/icon-192.png" width="96" height="96" alt="Pandu app icon: a glossy white tile with a blue navigation P">
</p>

<h1 align="center">Pandu</h1>

<p align="center">
  <strong>A local flight recorder and control tower for AI coding agents.</strong>
</p>

<p align="center">
  Pandu records what your agents do, shows it live, lets you replay every step,
  and asks permission before risky actions. It is not an AI agent; it guides,
  records and protects the agents you already use. Everything stays on your
  machine — no account, no cloud, no telemetry.
</p>

<p align="center">
  <a href="https://github.com/ganddtn40/pandu/actions/workflows/ci.yml"><img src="https://github.com/ganddtn40/pandu/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2F7FE0" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/rust-1.89%2B-2F7FE0?logo=rust&amp;logoColor=white" alt="Rust 1.89+">
  <img src="https://img.shields.io/badge/node-24-2F7FE0?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#screens">Screens</a> ·
  <a href="#what-v020-is">Features</a> ·
  <a href="#development">Development</a> ·
  <a href="docs/ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/readme/desktop-home-dark.png">
    <img src="docs/screenshots/readme/desktop-home-light.png" alt="Pandu dashboard showing a live flight, spend, tokens, guards, and approvals" width="100%">
  </picture>
</p>

> **Status:** the 0.2.0 rewrite is the active line on `main`. Phases 0–11 are
> complete. Phase 12 is in progress: the fourteen-language interface with RTL,
> beginner install guides, community docs, and the benchmark report have
> shipped; native review of the 13 draft catalogs, README translations, the npm
> wrapper, macOS/iOS/Linux bundles, and the remaining fuzz and crash-safety
> tests are open in the [roadmap](docs/ROADMAP.md). The shipped 0.1.0
> TypeScript/Node implementation is preserved under `legacy/` as the behavior
> spec.

## Screens

Captured from the real app in explicit demo mode, so the `Demo` badge is part of
the UI. The hero above switches with your GitHub theme.

<p align="center">
  <img src="docs/screenshots/readme/desktop-flight-output.png" width="49%" alt="Recorded flight with live output, model details, and replay tabs">
  <img src="docs/screenshots/readme/desktop-market.png" width="49%" alt="Market screen with signed skills and MCP servers">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/readme/phone-home-dark.png">
    <img src="docs/screenshots/readme/phone-home-light.png" width="300" alt="Pandu Android companion showing the home screen">
  </picture>
</p>

<p align="center"><sub>Android companion — experimental, verified on an emulator.</sub></p>

## Install

Download the latest build from [GitHub Releases](https://github.com/ganddtn40/pandu/releases).
The Windows installer is the fastest path; the CLI archive is in the same
release.

The beginner guides cover the command-line tool, the Windows desktop app, the
Android companion, and the installable web app, in all 14 interface languages:

| Language | Guide |
| --- | --- |
| English (reference) | [docs/install/en.md](docs/install/en.md) |
| Bahasa Indonesia | [docs/install/id.md](docs/install/id.md) |
| Español | [docs/install/es.md](docs/install/es.md) |
| Français | [docs/install/fr.md](docs/install/fr.md) |
| Deutsch | [docs/install/de.md](docs/install/de.md) |
| 日本語 | [docs/install/ja.md](docs/install/ja.md) |
| 简体中文 | [docs/install/zh.md](docs/install/zh.md) |
| العربية | [docs/install/ar.md](docs/install/ar.md) |
| हिन्दी | [docs/install/hi.md](docs/install/hi.md) |
| 한국어 | [docs/install/ko.md](docs/install/ko.md) |
| Português (Brasil) | [docs/install/pt.md](docs/install/pt.md) |
| Русский | [docs/install/ru.md](docs/install/ru.md) |
| Türkçe | [docs/install/tr.md](docs/install/tr.md) |
| Tiếng Việt | [docs/install/vi.md](docs/install/vi.md) |

The English guide is the full reference. The other interface catalogs are
drafts that fall back to English per key; the install guides are compact
translations of the same steps. [`docs/TRANSLATING.md`](docs/TRANSLATING.md)
explains the catalog layout and coverage.

Platform-specific details: [Android](docs/install/android.md),
[PWA](docs/install/pwa.md), [uninstall and cleanup](docs/install/uninstall.md),
and [troubleshooting](docs/install/troubleshooting.md).

## What v0.2.0 is

Pandu records a copy of agent traffic and forwards the original bytes unchanged.
If Pandu breaks, the agent keeps working.

- **One binary.** `pandu` starts the local daemon and serves the embedded UI;
  the Windows shell opens it in a desktop window.
- **Five tabs.** Home, Inbox, Flights, Market, Settings, plus a global quick
  prompt (`Ctrl/Cmd+K`).
- **Design v2.** Light paper bento dashboards with matte cards, hairline
  borders, one accent, and floating glass chrome. Three themes (Light, Dark,
  Frost), three surface styles (Bento Matte, Liquid Glass, Hybrid), and full
  appearance customization in Settings.
- **Fourteen interface languages.** English plus thirteen draft catalogs,
  lazy-loaded with per-key English fallback and a right-to-left layout for
  Arabic.
- **Two capture modes today.** Proxy and log-watch are implemented; hook/OTel is
  deferred, and a single trust badge per flight is still on the roadmap.
- **Signed market.** Skills and MCP servers with trust tiers, pinned commits,
  permissions, a diff before install, and a signed registry.
- **Remote access.** Off by default, host-confirmed pairing, scoped device
  tokens, and revocation.
- **Local by default.** SQLite on disk, no telemetry, no TLS interception, no
  credential capture.
- **Fail-open.** If Pandu breaks, your agent keeps working.

## Platform support

| Platform | Status |
| --- | --- |
| Windows | Supported |
| Web (PWA) | Supported |
| Android | Experimental |
| macOS | Planned |
| iOS | Planned |
| Linux | Planned |

Android is a companion viewer/approver, not a recorder. It has been verified
on an emulator but not yet on a physical phone, so it stays experimental; the
Android CI job is allowed to fail and Android is not part of a release until
phone verification is recorded. Nothing outside the supported rows is
advertised as working.

## Design and appearance

- Default accent: blue `#2F7FE0`. Presets: Blue, Orange, Cream, Green, Violet,
  Silver, Mono.
- Themes: Light (default), Dark, Frost. The app icon is a glossy white tile
  with a blue navigation P; the favicon is a flat vector variant.
- Surfaces: Bento Matte, Liquid Glass, Hybrid (default: matte cards, glass
  floating layers).
- Settings → Appearance controls theme, surface, accent, corner radius,
  density, font and size, glass intensity/blur/refraction, wallpaper
  (procedural/own image/none), card borders, motion, Performance mode, and
  language, with instant live preview.
- Preferences are per-device. Themes are versioned JSON (`pandu.theme`,
  version 1) that can be exported, imported, and shared; imports are validated
  and never execute code. Wallpaper images stay on the device.
- Home widgets are rearrangeable and hideable: drag on desktop, long-press on
  phone.
- Demo mode is explicit: a `Demo` badge appears in the top bar, sessions and
  approvals carry a `Demo` chip, and live data is never mixed with seeded rows
  silently. Demo data is only offered when the daemon runs with
  `PANDU_DEMO=1`.

The full contract is in [`docs/DESIGN.md`](docs/DESIGN.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `brand.json` | Single source of truth for every product name and identifier |
| `crates/pandu-core` | Domain types, pricing, adapters, redaction, SSE parsing |
| `crates/pandu-daemon` | Proxy, API, WebSocket, SQLite, watchers, guards |
| `crates/pandu-cli` | The `pandu` binary; embeds UI assets |
| `app` | Tauri 2 desktop app and Android companion |
| `ui` | Svelte 5 + TypeScript + Vite UI and WebGL2 glass |
| `design` | Logo sources and export scripts |
| `adapters` | Data-driven TOML agent definitions |
| `registry` | Signed market entries, schema, fixtures, and signing tools |
| `docs` | Rewrite record, roadmap, design system, beginner docs, issue drafts |
| `packaging` | cargo-dist, winget/scoop drafts, release manifest, notices |
| `legacy` | 0.1.0 TypeScript/Node behavior spec |

## Development

Requirements:

- Rust 1.89+ (stable; `rust-toolchain.toml` pins the channel and components)
- Node.js 24 and pnpm 12.9.1 (the versions CI uses)
- Git (optional; snapshots degrade gracefully without it)
- Windows desktop builds: the Tauri 2 prerequisites and WebView2 (the installer
  downloads the bootstrapper when it is missing)
- Android builds: JDK 17, Android SDK, and NDK; see
  [docs/install/android.md](docs/install/android.md)

Rust gates:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check --release -p pandu-daemon
```

UI gates:

```powershell
cd ui
pnpm install
pnpm check
pnpm check:i18n
pnpm test
pnpm build
pnpm exec playwright test
```

`pnpm build` also enforces the JavaScript budgets with `pnpm size`. Playwright
runs `target/debug/pandu.exe`, so build the CLI first with
`cargo build -p pandu-cli`.

The UI preview is available at `http://127.0.0.1:5174` with `pnpm dev`, or
`http://127.0.0.1:4174` with `pnpm preview` after a build. Start the daemon with
`pandu serve` (or `pandu demo` for seeded data); the UI calls
`http://127.0.0.1:4319` on dev/preview ports and the same origin otherwise.
Playwright starts its own disposable demo and live daemons, so it never touches
your local database.

## Read more

### Product

- [Design system](docs/DESIGN.md) — tokens, surfaces, appearance, theme JSON
- [Remote access](docs/remote-access.md) — Tailscale, Cloudflare tunnel, pairing,
  scopes, revocation, and troubleshooting
- [Security model](docs/security.md) — what is protected, stolen-token impact,
  and the endpoints × scopes table
- [Models, effort, and context](docs/models.md) — the verified model table,
  host-only overrides, PTY switching, and the context meter
- [Privacy](docs/privacy.md) — what is stored locally, what can leave the
  machine, and how to delete it
- [Updating](docs/updating.md) — update checks, the update card, signed
  installs, rollback, and Android
- [Data safety](docs/data-safety.md) — where your data lives, backups,
  migrations, and uninstalls
- [Market and registry](docs/market.md) — trust tiers, signed registry, install
  previews, offline behavior, and the contributor rules
- [Translating](docs/TRANSLATING.md) — catalog layout, coverage, drafts, and RTL
- [Rewrite decision record](docs/REWRITE.md) — what is kept, cut, and changed
- [Roadmap](docs/ROADMAP.md) — v0.2.0 scope, phases, and deferred features

### Build and release

- [Adapter format](adapters/README.md) — how to add an agent
- [UI notes](ui/README.md) — glass engine, budgets, and commands
- [Benchmarks](docs/BENCHMARKS.md) — measured artifact sizes, whole-app idle
  RAM/CPU, TTI, and uninstall hygiene
- [Releasing](docs/RELEASING.md) — gates, dry run, package-name checks, and
  registry signing
- [Code signing policy](docs/code-signing-policy.md) — what is signed, what is
  not, and how to verify
- [Uninstall and cleanup](docs/install/uninstall.md) — data retention and the
  leftover check
- [Install for agents](INSTALL-FOR-AGENTS.md) — copy-paste setup for an AI agent

### Community

- [Contributing](CONTRIBUTING.md) — setup, gates, and where each change belongs
- [Issue drafts](docs/issues/) — ready-to-paste `help wanted` work
- [Security policy](SECURITY.md) — supported versions and private vulnerability
  reporting
- [Code of conduct](CODE_OF_CONDUCT.md) — participation rules

## License

MIT. See [LICENSE](LICENSE).

---

<p align="center">
  <sub>Built with Rust, Svelte 5, and Tauri 2. Local by default.</sub>
</p>
