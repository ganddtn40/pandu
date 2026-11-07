# Cockpit

**A local flight recorder and control tower for AI coding agents.**

Cockpit records what your agents do, shows it live, lets you replay every step,
and asks permission before risky actions. Everything stays on your machine. No
account, no cloud, no telemetry.

> **Status:** the 0.2.0 rewrite is in progress on the `rewrite` branch. The
> shipped 0.1.0 TypeScript/Node implementation is preserved under `legacy/` as
> the behavior spec. Installers and the first runnable Rust build arrive in the
> later phases; this README will be replaced with the full guide when they do.

## What v0.2.0 will be

- **One binary.** `cockpit` starts the local daemon and opens the embedded UI.
- **Four screens.** Home, Flights, Approvals, Settings.
- **Three capture modes.** Proxy, log-watch, and hook/OTel, each labeled honestly
  per flight.
- **Real glass.** A custom WebGL2 renderer with a CSS fallback, light and dark.
- **Local by default.** SQLite on disk, no telemetry, no TLS interception, no
  credential capture.
- **Fail-open.** If Cockpit breaks, your agent keeps working.

## Repository layout

| Path | Purpose |
| --- | --- |
| `crates/cockpit-core` | Domain types, pricing, adapters, redaction, SSE parsing |
| `crates/cockpit-daemon` | Proxy, API, WebSocket, SQLite, watchers, guards |
| `crates/cockpit-cli` | The `cockpit` binary; embeds UI assets |
| `app` | Tauri 2 desktop app and Android companion |
| `ui` | Svelte 5 + TypeScript + Vite UI and WebGL2 glass |
| `adapters` | Data-driven TOML agent definitions |
| `docs` | Rewrite record, roadmap, beginner docs, issue drafts |
| `packaging` | cargo-dist, npm wrapper, winget, scoop, Tauri, Android |
| `legacy` | 0.1.0 TypeScript/Node behavior spec |

## Development

Requirements once the rewrite is runnable:

- Rust stable 1.85+ (`rust-toolchain.toml` installs components via rustup)
- Node.js 22+ and pnpm 10+
- Git (optional; snapshots degrade gracefully without it)

Commands:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p cockpit-cli
```

The UI and app commands are added in Phase 4 and Phase 6.

## Read more

- [Rewrite decision record](docs/REWRITE.md) — what is kept, cut, and changed
- [Roadmap](docs/ROADMAP.md) — v0.2.0 scope and deferred features
- [Issue drafts](docs/issues/) — ready-to-paste `help wanted` work
- [Adapter format](adapters/README.md) — how to add an agent

## License

MIT. See [LICENSE](LICENSE).
