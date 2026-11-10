# AGENTS.md

Instructions for coding agents working in this repository. Read this before
changing code, docs, or registry entries.

## What this project is

Pandu is a local flight recorder and control tower for AI coding agents. It is
not an AI agent. It runs a local daemon, proxies model-provider traffic for
recording, watches agent logs, stores flights in SQLite, and serves a Svelte UI.
The daemon must fail open: a recording, storage, guard, or snapshot failure must
never change or block the bytes travelling to the provider.

## Layout

| Path | Purpose |
| --- | --- |
| `brand.json` | Single source of truth for every product name and identifier |
| `crates/pandu-core` | Domain types, pricing, adapters, redaction, SSE parsing |
| `crates/pandu-daemon` | Proxy, API, WebSocket, SQLite, watchers, guards, market |
| `crates/pandu-cli` | The `pandu` binary; embeds UI assets |
| `ui` | Svelte 5 + TypeScript + Vite UI and the WebGL2 glass engine |
| `adapters` | Data-driven TOML agent definitions |
| `registry` | Signed market entries, schema, fixtures, and signing tools |
| `docs` | Design, security, privacy, market, roadmap, and release docs |
| `legacy` | Frozen 0.1.0 TypeScript/Node behavior spec; never rename or edit it |
| `packaging` | Distribution manifest and release notes |

## Brand rules

- `brand.json` is the only place to change the product name, wordmark, tagline,
  crate names, binary name, environment prefix, data directory, database file,
  app ids, URL scheme, repository and registry URLs, theme schema, or UI storage
  prefix. Rust reads it through `crates/pandu-core/build.rs` and
  `crates/pandu-core/src/brand.rs`; the UI reads it through
  `ui/src/lib/brand.ts`.
- Do not hard-code `Pandu`, `pandu`, or `PANDU_` in new runtime strings when a
  `brand::` constant or the UI brand module already exposes the value.
- The repository-wide test in `crates/pandu-core/tests/product_name.rs` fails if
  the pre-rename name appears outside its allowlist. Do not widen the allowlist
  to make a change pass.
- `legacy/` is frozen. Do not rename files or strings inside it.
- The production registry key id comes from `brand.json` (`registry.keyId`) and
  is resolved in `crates/pandu-daemon/src/market/mod.rs`. No production key is
  embedded yet; follow `docs/registry/KEYS.md` for the offline ceremony. Never
  edit `registry/index.json` or `registry/revoked.json` by hand, and never sign
  a production registry with the test key.

## Before committing

Run the gates from the repository root:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check --release -p pandu-daemon
```

For UI changes:

```powershell
pnpm --dir ui check
pnpm --dir ui test
pnpm --dir ui build
pnpm --dir ui exec playwright test
```

Playwright starts disposable daemons and never touches the developer database.
Build the CLI first with `cargo build -p pandu-cli`; the e2e harness runs
`target/debug/pandu.exe`.

## Code rules

- Keep the daemon server-authoritative. Validate every remote argument, rate
  limit state-changing routes, and never trust a client-supplied path or scope.
- Keep the proxy fail-open. Record a copy; never rewrite forwarded bytes.
- Use `pandu_core::brand` for runtime names, paths, environment variables, and
  headers. Use `ui/src/lib/brand.ts` for UI names and storage keys.
- Adapters are data. Add a TOML file and a fixture; do not hard-code a vendor in
  the daemon unless the parser genuinely needs it.
- Registry entries are security-sensitive. Follow
  `docs/registry/CONTRIBUTING.md`; run the staged market check and rebuild the
  test index with `node registry/sign.mjs --variant test --build`.
- Do not add telemetry, cloud sync, background update pings, or TLS
  interception.

## Commits

Use Conventional Commits, for example `fix: keep the proxy fail-open on a
recording error`. Keep the rename commit separate from behavior changes when
possible.
