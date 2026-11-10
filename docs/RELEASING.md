# Releasing Pandu

This checklist covers a tagged CLI release. Nothing here is published until a
maintainer makes an explicit release decision.

## 1. Confirm the name is available

Run these before the first release and whenever the repository or package name
changes. Record the output in the release issue.

### npm

```powershell
npm view pandu version
npm view @ganddtn40/pandu version
```

An `E404` means the unscoped name is free. If `pandu` is taken, publish the
scoped package and update `brand.json` and the packaging manifest; do not
silently publish under a different name.

### crates.io

```powershell
cargo search pandu --limit 10
cargo info pandu
```

`cargo search` must show no exact `pandu` crate. `cargo info pandu` should fail
with "not found". If either succeeds, choose a new crate prefix and update
`brand.json`, the workspace members, and every import.

### winget

```powershell
winget search --id ganddtn40.Pandu
winget search Pandu
```

There must be no exact `ganddtn40.Pandu` package. If the id is taken, change the
publisher segment in `packaging/manifest.json` before submitting the manifest.

### GitHub

```powershell
gh repo view ganddtn40/pandu
gh api repos/ganddtn40/pandu --jq .full_name
```

Both commands must fail with a 404 before the repository is created. After the
repository exists, confirm the owner and name match `brand.json`.

The repository-wide test also enforces the rename:

```powershell
cargo test -p pandu-core --test product_name
```

## 2. Run the gates

From a clean checkout:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check --release -p pandu-daemon
cargo test --release -p pandu-daemon --lib "market::"
cargo run -p pandu-cli -- models audit
```

UI:

```powershell
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui check
pnpm --dir ui test
pnpm --dir ui build
pnpm --dir ui exec playwright test
```

Build the CLI before Playwright:

```powershell
cargo build -p pandu-cli
```

## 3. Registry

Production and test trust roots are separate. The production private key is kept
offline and is never a CI secret.

- Test fixtures: re-sign `registry/index.test.json` and
  `registry/revoked.test.json` with the test key after any YAML or fixture
  change.

  ```powershell
  node registry/sign.mjs --key C:\secure\pandu-market-test-2026.pem --variant test --build
  ```

- Production: sign `registry/index.json` and `registry/revoked.json` offline
  with the production key.

  ```powershell
  node registry/sign.mjs --key C:\secure\pandu-market-2026.pem --build
  ```

  Then verify with a release build:

  ```powershell
  cargo run --release -p pandu-cli -- market check --dir registry --online --links
  ```

The production key id and signatures currently predate the rename and are
frozen; see [`registry/KEYS.md`](registry/KEYS.md). Do not hand-edit either
signed document. A release build refuses a test trust root.

## 4. Version and artifacts

1. Update the version in `Cargo.toml` (`workspace.package.version`) and
   `ui/package.json`.
2. Update `packaging/manifest.json` if artifact names or channels changed.
3. Build from the tagged commit, never from a developer working tree.
4. Publish checksums next to every artifact.
5. Confirm the npm wrapper verifies the downloaded binary checksum before
   running it.
6. Android signing keys come from the release environment; never commit a
   keystore or password.

## 5. Post-release checks

```powershell
pandu --version
pandu doctor
```

Install from each advertised channel on a clean machine, confirm the UI opens,
run one demo flight, and confirm no network request is made without an explicit
user action. Update the changelog and close the release issue.
