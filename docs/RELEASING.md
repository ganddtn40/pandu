# Releasing Pandu

This checklist covers a tagged CLI release. Nothing here is published until a
maintainer makes an explicit release decision.

## 0. Rename the GitHub repository first

`brand.json` names `https://github.com/ganddtn40/pandu` as the canonical
repository and uses `https://raw.githubusercontent.com/ganddtn40/pandu/main/registry`
as the registry URL. While that repository does not exist, or while it is
private, the daemon cannot refresh the market and no release can publish.

Exact steps:

1. Confirm the current state. A missing repository, or a private one the token
   cannot see, returns 404:

   ```powershell
   gh repo view ganddtn40/pandu
   gh api repos/ganddtn40/pandu --jq .full_name
   ```

2. If the old repository exists under another name, rename it. On GitHub this
   is **Settings → General → Repository name**, enter `pandu`, and choose
   **Rename**. With the CLI:

   ```powershell
   gh repo rename pandu --repo <owner>/<old-repository-name>
   ```

   GitHub keeps redirects for the old URL, but the daemon and the signed
   registry must use the new URL directly.

3. Point the local checkout at the renamed repository:

   ```powershell
   git remote set-url origin https://github.com/ganddtn40/pandu.git
   git remote -v
   git push -u origin main
   ```

4. Make the repository public before the first published registry. A private
   repository returns 404 to unauthenticated clients, and the daemon
   deliberately sends no GitHub credentials:

   ```powershell
   gh repo edit ganddtn40/pandu --visibility public --accept-visibility-change-consequences
   ```

5. Verify the canonical paths:

   ```powershell
   gh api repos/ganddtn40/pandu --jq .full_name
   gh api repos/ganddtn40/pandu/contents/registry/index.json --jq .name
   Invoke-WebRequest https://raw.githubusercontent.com/ganddtn40/pandu/main/registry/index.json -UseBasicParsing |
     Select-Object StatusCode
   ```

   The first command must print `ganddtn40/pandu`. The last must return `200`
   once the signed index is on `main`.

6. If the owner or name differs from `brand.json`, update `repository` and
   `registry.url` there, then update `packaging/manifest.json`, CODEOWNERS, and
   the release workflow. Re-run:

   ```powershell
   cargo test -p pandu-core --test product_name
   cargo test -p pandu-core brand::
   ```

While the repository is absent or private:

- a market refresh returns HTTP 502 with a message saying the registry is not
  available, may not exist yet or may be private, and that the last verified
  registry stays in use;
- a release build with no production key shows **Registry is being prepared.**
  and exposes no entries;
- update checks are not implemented in this build, and the Settings screen says
  so. Do not add a background ping or an unauthenticated GitHub API call to work
  around the missing repository.

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

Follow section 0. The repository-wide name test also enforces the rename:

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

The tag workflow adds a release gate that is not part of the local loop. It
runs the ignored production-key test and `pandu market check --dir registry`
with a release binary. The publish job has `needs: registry-gate`, so a failed
gate stops the release before any artifact is published.

## 3. Registry and trust root

Read [`registry/KEYS.md`](registry/KEYS.md) before touching a signed file. It
covers the offline key-generation ceremony, the signing steps, CI verification,
rotation, and the compromise response.

The production trust root is currently empty. A release build embeds no
production key and fails closed with **Registry is being prepared.**; it never
falls back to the test key. `registry/index.json` and `registry/revoked.json`
carry the production key id from `brand.json` and empty signatures until the
maintainer completes the ceremony. Do not hand-edit either document.

- Test fixtures: re-sign `registry/index.test.json` and
  `registry/revoked.test.json` with the test key after any YAML or fixture
  change.

  ```powershell
  node registry/sign.mjs --key C:\secure\pandu-market-test-2026.pem --variant test --build
  ```

- Production: generate the key offline, embed the public half, and sign
  `registry/index.json` and `registry/revoked.json` on the offline machine.

  ```powershell
  node registry/sign.mjs --key E:\secure\pandu-market-2026.pem --build --dir registry
  ```

  Then verify with a release build:

  ```powershell
  cargo test --release -p pandu-daemon --lib `
    market::service::tests::bundled_production_registry_verifies_with_the_production_key -- --ignored
  cargo run --release --locked -p pandu-cli -- market check --dir registry --online --links
  ```

  Both commands must pass. If either fails, do not publish.

The test key only signs the `.test.json` fixtures. Never use it for a published
registry, never copy it into a release configuration, and never let a release
build fall back to it.

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
