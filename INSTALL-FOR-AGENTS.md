# Install Pandu for agents

This page is written for an AI coding agent that has been asked to install,
run, or verify Pandu. It is copy-paste oriented and has no interactive steps.

Pandu is not an AI agent. It is a local recorder and control surface for the
agents already on the machine.

## 1. Check prerequisites

```powershell
rustc --version
cargo --version
node --version
pnpm --version
git --version
```

Pandu needs Rust stable 1.89 or newer. Node 22+ and pnpm 10+ are only needed to
build or test the UI. Git is optional; snapshots degrade gracefully without it.

## 2. Build from source

```powershell
git clone https://github.com/ganddtn40/pandu.git
cd pandu
cargo build --release -p pandu-cli
```

The binary is `target/release/pandu.exe` on Windows and
`target/release/pandu` on macOS and Linux. To put it on `PATH`, copy it to a
directory that is already on `PATH`; do not overwrite an existing `pandu`
binary without checking its version first.

## 3. Start the daemon

```powershell
pandu serve
```

The default listener is `http://127.0.0.1:4319`. Use `pandu serve --port <port>`
when that port is taken. `pandu demo` seeds a disposable demo flight and is the
safest way to verify a fresh install.

## 4. Point an agent at Pandu

The supported path is the adapter-aware runner:

```powershell
pandu run -- <agent-command>
```

For example:

```powershell
pandu run -- claude
pandu run -- codex
```

`pandu run` starts an owned daemon when needed, sets the proxy environment
variables declared by the matched adapter, substitutes a local sentinel for the
real provider key, and runs the agent. If the adapter is missing, configure the
agent manually with the base URL printed by `pandu doctor`.

## 5. Verify

```powershell
pandu doctor
pandu report --output pandu-report.md
```

`doctor` checks the database, ports, adapters, log watcher, and daemon version.
`report` writes a redacted local diagnostics bundle; nothing is uploaded.

For the UI, open `http://127.0.0.1:4319` after `pandu serve`, or run the UI
development server with `pnpm --dir ui dev` and open
`http://127.0.0.1:5174`.

## 6. Data and removal

- Data directory: `~/.pandu` (override with `PANDU_HOME`).
- Database: `pandu.db` in the data directory.
- First start after the rename: if a pre-rename data directory exists and the
  new one does not, Pandu copies it and leaves the old directory untouched.
- To remove Pandu, stop the daemon and delete `~/.pandu`. Uninstall any market
  entries first so files Pandu created in agent configuration are removed
  cleanly.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `pandu` not found | The binary is not on `PATH`; use the full path to `target/release/pandu` |
| Port already in use | `pandu serve --port 4400`, then use that port in the UI |
| Agent ignores the proxy | Run `pandu doctor` and confirm the adapter name and environment variables |
| Database refused | A 0.1.0 database is intentionally not imported; point `PANDU_HOME` at a fresh directory |
| Market refuses the registry | A signature or hash failed; do not install until the registry is verified |
