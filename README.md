# Pandu

**A local flight recorder and control tower for AI coding agents.**

Pandu records what your agents do, shows it live, lets you replay every step,
and asks permission before risky actions. Everything stays on your machine. No
account, no cloud, no telemetry.

Pandu is not an AI agent; it guides, records and protects the agents you already use.

> **Status:** the 0.2.0 rewrite is in progress on the `rewrite` branch. Phases
> 0–11 are complete: the Rust core, proxy, adapters, guards, snapshots, the
> design v2 UI, the five tabs wired to real daemon data, host-confirmed remote
> access, the signed skill/MCP market, model controls, updates and backups, and
> the Windows desktop app, Android companion, and PWA packages. Phase 12 — the
> remaining documentation, benchmarks, and language catalogs — is tracked in the
> [roadmap](docs/ROADMAP.md). The shipped 0.1.0 TypeScript/Node implementation is
> preserved under `legacy/` as the behavior spec.

## Install

The beginner guides cover the Windows desktop app, the Android companion, and
the installable web app, in all 14 interface languages:

| Language | Guide |
| --- | --- |
| English (reference) | [docs/install/en.md](docs/install/en.md) |
| Bahasa Indonesia | [docs/install/id.md](docs/install/id.md) |
| Español | [docs/install/es.md](docs/install/es.md) |
| Français | [docs/install/fr.md](docs/install/fr.md) |
| Deutsch | [docs/install/de.md](docs/install/de.md) |
| 日本語 | [docs/install/ja.md](docs/install/ja.md) |
| 中文 | [docs/install/zh.md](docs/install/zh.md) |
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

- **One binary.** `pandu` starts the local daemon and serves the embedded UI;
  the Windows shell opens it in a desktop window.
- **Five tabs.** Home, Inbox, Flights, Market, Settings, plus a global quick
  prompt (`Ctrl/Cmd+K`).
- **Design v2.** Light paper bento dashboards with matte cards, hairline
  borders, one accent, and floating glass chrome. Three themes (Light, Dark,
  Frost), three surface styles (Bento Matte, Liquid Glass, Hybrid), and full
  appearance customization in Settings.
- **Two capture modes today.** Proxy and log-watch are implemented; hook/OTel is
  deferred, and a single trust badge per flight is still on the roadmap.
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
| `docs` | Rewrite record, roadmap, design system, beginner docs, issue drafts |
| `packaging` | cargo-dist, winget/scoop drafts, release manifest, notices |
| `legacy` | 0.1.0 TypeScript/Node behavior spec |

## Development

Requirements:

- Rust stable 1.89+ (`rust-toolchain.toml` installs components via rustup)
- Node.js 22+ and pnpm 10+
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
cargo build --release -p pandu-cli
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
`pandu serve` (or `pandu demo` for seeded data); the UI calls
`http://127.0.0.1:4319` on dev/preview ports and the same origin otherwise.
Playwright starts its own disposable demo and live daemons, so it never touches
your local database.

## Read more

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
- [Rewrite decision record](docs/REWRITE.md) — what is kept, cut, and changed
- [Roadmap](docs/ROADMAP.md) — v0.2.0 scope, phases, and deferred features
- [Issue drafts](docs/issues/) — ready-to-paste `help wanted` work
- [Adapter format](adapters/README.md) — how to add an agent
- [UI notes](ui/README.md) — glass engine, budgets, and commands
- [Benchmarks](docs/BENCHMARKS.md) — measured artifact sizes, whole-app idle RAM/CPU, TTI, and uninstall hygiene
- [Releasing](docs/RELEASING.md) — gates, dry run, package-name checks, and registry signing
- [Code signing policy](docs/code-signing-policy.md) — what is signed, what is not, and how to verify
- [Uninstall and cleanup](docs/install/uninstall.md) — data retention and the leftover check
- [Install for agents](INSTALL-FOR-AGENTS.md) — copy-paste setup for an AI agent

## License

MIT. See [LICENSE](LICENSE).
