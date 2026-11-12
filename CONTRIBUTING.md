# Contributing to Pandu

Pandu is a local flight recorder and control tower for AI coding agents. It is
not an AI agent. Contributions are welcome when they keep the product local,
honest, and fail-open.

Read [`AGENTS.md`](AGENTS.md) first if you are an AI coding agent. It contains
the repository rules that apply to automated changes.

## Ground rules

- **Local by default.** No telemetry, cloud sync, background update pings, or
  TLS interception. Remote access is off by default and can only be enabled
  from the host.
- **Fail open.** A recording, storage, guard, or snapshot failure must never
  change or block bytes travelling to the model provider. Record a copy; never
  rewrite forwarded traffic.
- **Server authority.** The daemon validates every remote argument, rate limits
  state-changing routes, and never trusts a client-supplied path or scope.
- **Adapters are data.** Add a TOML file and a fixture instead of hard-coding a
  vendor in the daemon unless the parser genuinely needs it.
- **No silent claims.** Unsupported platforms, experimental features, and
  incomplete translations are labeled as such.

## Set up

You need:

- Rust stable (the repository pins it in `rust-toolchain.toml`)
- Node.js 24 and pnpm 12.9.1
- On Windows, Microsoft Edge WebView2 for the desktop shell

Install dependencies:

```powershell
pnpm --dir ui install
pnpm --dir app install
```

Run the daemon and UI:

```powershell
cargo run -p pandu-cli -- serve
pnpm --dir ui dev
```

The desktop shell is optional:

```powershell
pnpm --dir app exec tauri dev
```

## Before you open a pull request

Run the gates that match your change from the repository root.

Rust:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check --release -p pandu-daemon
```

UI:

```powershell
pnpm --dir ui check
pnpm --dir ui test
pnpm --dir ui check:i18n
pnpm --dir ui build
pnpm --dir ui exec playwright test
```

Desktop shell:

```powershell
node app/scripts/check-brand.mjs
pnpm --dir app exec tauri build --no-bundle
node app/scripts/smoke.mjs
```

Playwright starts disposable daemons and never touches your developer
database. Build the CLI first with `cargo build -p pandu-cli`; the end-to-end
harness runs `target/debug/pandu.exe`.

## What to change, and where

| Area | Location | Notes |
| --- | --- | --- |
| Brand names, paths, ids | `brand.json` | The only source of truth. Rust reads it through `pandu-core`; the UI reads it through `ui/src/lib/brand.ts`. |
| Domain types, pricing, redaction, SSE | `crates/pandu-core` | Keep the proxy byte-for-byte. Add tests for every parser edge case. |
| Proxy, API, SQLite, watchers, guards | `crates/pandu-daemon` | Validate input, rate limit mutations, and keep failure paths fail-open. |
| CLI | `crates/pandu-cli` | The binary embeds the built UI assets. |
| UI and glass engine | `ui` | Svelte 5, TypeScript, Vite. Follow the design tokens in `ui/src/app.css`. |
| Agent definitions | `adapters` | TOML only. Add or update a fixture in the adapter tests. |
| Market entries | `registry` | Security-sensitive. Follow [`docs/registry/CONTRIBUTING.md`](docs/registry/CONTRIBUTING.md). |
| Documentation | `docs` | Keep platform and translation claims honest. |

Do not rename or edit files under `legacy/`. It is the frozen 0.1.0 behavior
spec.

## Translations

The UI ships English plus 13 draft catalogs. Drafts fall back to English per
key, so an incomplete catalog is visible instead of silent. Read
[`docs/TRANSLATING.md`](docs/TRANSLATING.md) before adding or changing strings.

The short version:

- Edit the English catalog in `ui/src/lib/i18n/catalog.ts`.
- Put a draft catalog in `ui/src/lib/i18n/catalogs/<language>.ts`.
- Keep `{placeholders}` exactly as they appear in English.
- Run `pnpm --dir ui check:i18n`.
- Add a beginner guide at `docs/install/<language>.md` and list it in the
  README.

Do not machine-translate a catalog and mark it complete. Drafts are welcome;
unreviewed text must stay labeled as a draft.

## Commits

Use Conventional Commits:

```text
fix: keep the proxy fail-open on a recording error
feat(i18n): add Arabic and right-to-left layout
docs: explain the Android pairing flow
```

Keep the brand rename separate from behavior changes when possible. A commit
should explain why the change is needed, not only what changed.

## Pull requests

- Keep the change focused. Split unrelated refactors.
- Describe the user-visible effect and the tests you ran.
- Add a screenshot for a visual change.
- Call out anything that is still experimental or unverified.
- Link the issue when one exists.

The pull request template repeats the important checks.

## Security and conduct

Do not report a vulnerability in a public issue. Follow
[`SECURITY.md`](SECURITY.md) and use GitHub's private vulnerability reporting.

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
