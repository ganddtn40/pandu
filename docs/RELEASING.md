# Releasing Pandu

This checklist covers a tagged release of the CLI, the Windows desktop app, the
Android companion, and the PWA assets. Nothing here is published until a
maintainer makes an explicit release decision. CI builds the artifacts and
creates a **draft** release; a maintainer signs the update manifest offline and
publishes the draft by hand.

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
- update checks reach the GitHub Releases API for the repository in
  `brand.json`. While that repository is absent or private, the check reports
  that updates are unavailable, stays silent offline, and never falls back to
  an unsigned download. The daemon sends no token and no identifier.

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
cargo test --release -p pandu-core --lib update::tests::
cargo run -p pandu-cli -- models audit
node --check packaging/sign-update.mjs
```

UI:

```powershell
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui check
pnpm --dir ui test
pnpm --dir ui build
pnpm --dir ui exec playwright test
```

Desktop shell and packaging:

```powershell
pnpm --dir app install --frozen-lockfile
node app/scripts/check-brand.mjs
pnpm --dir app exec tauri build --bundles nsis msi
node app/scripts/smoke.mjs
node app/scripts/resources.mjs --seconds 5
node app/scripts/portable.mjs --skip-build
node packaging/notices.mjs --check
node packaging/check-licenses.mjs
node packaging/channel-manifests.mjs --check
cargo deny check
```

Android (requires JDK 17, the Android SDK, NDK 27.2.12479018, and the four
Rust Android targets):

```powershell
node app/scripts/android-init.mjs
node app/scripts/android-build.mjs --out dist/android
```

Build the CLI before Playwright:

```powershell
cargo build -p pandu-cli
```

The tag workflow adds release gates that are not part of the local loop. The
registry gate runs the ignored production-key test and
`pandu market check --dir registry` with a release binary. The update gate
checks `packaging/sign-update.mjs` and runs the updater tests in release mode,
where the test key is compiled out and the build must fail closed. The publish
job has `needs: [registry-gate, update-gate]`, so a failed gate stops the
release before any artifact is published.

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

## 4. Updater trust root and key ceremony

The updater key is separate from the registry key and from the Android signing
key. It signs `pandu-update.json` and every artifact it lists. The private key
never enters the repository, CI, a chat, or an agent session.

The production updater trust root is currently empty.
`PRODUCTION_UPDATER_PUBLIC_KEY_BASE64` is `None`, so a release build fails
closed with **Updates are not available in this build because no production
updater key is embedded.** It never falls back to the test key. The test key
only signs fixtures and debug builds.

### Create the key offline

Do this once, on a machine that does not run an AI agent, with the network
disconnected if your policy allows it:

```powershell
minisign -G -p pandu-updater-2026.pub -s pandu-updater-2026.key
```

- Store the `.key` file on encrypted offline media. Keep two copies in separate
  physical locations.
- Record the key id printed by `minisign -G`; it must equal `update.keyId` in
  `brand.json` (`pandu-updater-2026`).
- Never commit either file. `packaging/sign-update.mjs` reads the secret key
  only through the `minisign` binary and never prints it.

### Embed the public key

1. Paste the public key contents (the base64 text on the second line of the
   `.pub` file, without the `untrusted comment:` line) into
   `PRODUCTION_UPDATER_PUBLIC_KEY_BASE64` in
   `crates/pandu-core/src/update.rs`.
2. Confirm `PRODUCTION_UPDATER_KEY_ID` still resolves to `update.keyId` in
   `brand.json`.
3. Run the release-mode trust-root tests. With the key embedded, a release
   build is `Ready`; with the test key embedded, it is `Refused`:

   ```powershell
   cargo test --release -p pandu-core --lib update::tests::
   ```

4. Rebuild the release CLI and confirm `pandu update --check` reports a signed
   update or that none is published. It must never install without a verified
   manifest.

If the private key is lost, generate a new key pair, bump `update.keyId` in
`brand.json`, embed the new public key, and ship one release through the old
channel path. Treat every artifact signed by the lost key as untrusted.

### Sign a release manifest

Build the artifacts from the tagged commit, then sign them offline:

```powershell
node packaging/sign-update.mjs `
  --version 0.3.0 `
  --notes dist/notes.md `
  --artifact windows-x86_64=dist/pandu.exe `
  --artifact linux-x86_64=dist/pandu `
  --artifact macos-aarch64=dist/pandu `
  --expires 2026-12-01T00:00:00Z `
  --sequence 42 `
  --key E:\secure\pandu-updater-2026.key `
  --out dist/pandu-update.json
```

The output is one JSON asset. Upload it to the GitHub release with the exact
name in `brand.json` (`pandu-update.json`), next to the artifacts. The manifest
carries a SHA-256 and a Minisign signature per artifact, plus a self-signature
over the canonical JSON. `pandu update` refuses a manifest with the wrong
channel, the wrong key id, a missing signature, a bad digest, an expired
`expires`, a `sequence` that is not newer than the last one the installation
accepted, or a version that is not newer than the running build.

The manifest is schema 2. Both `--expires` and `--sequence` are required:

- `--expires` is an RFC 3339 timestamp in the future. Keep it short, for
  example a few weeks after the release. A replayed manifest stops working when
  it expires even if the sequence check is somehow bypassed.
- `--sequence` is a positive integer that must strictly increase with every
  release on the channel. The canonical signed payload includes both fields, so
  neither can be changed without the private key. Record the sequence in the
  release notes or a release ledger so the next one is always higher. Never
  reuse or lower a sequence: installations that accepted the higher value will
  refuse the release.

The CLI records the accepted sequence in `pandu-update-state.json` in the Pandu
home only after a verified install. A damaged state file fails closed. If a
maintainer needs to republish the same version, sign it with a new, higher
sequence and a new expiry; do not reuse the previous manifest.

### Desktop app and Android

The Windows desktop app uses the same update check and the same production
updater trust root as the CLI. It does not bundle the Tauri updater plugin, so
it never downloads or replaces its own binary and never needs a second key:

- The update card reports the new version and links to the release page.
- To update, quit Pandu from the tray, verify `SHA256SUMS`, and run the newer
  NSIS installer over the old install. The portable build is replaced by
  extracting the new zip. User data under `%USERPROFILE%\.pandu` is untouched.
- The NSIS installer is per-user and does not need administrator rights. The
  MSI is per-machine for managed deployment; see `docs/install/en.md`.

Android never updates itself:

1. Pandu does not download or install APKs silently.
2. The Android system installer shows the permissions and asks for
   confirmation.
3. Verify the APK SHA-256 against `SHA256SUMS` and, when building from source,
   the signer certificate with `apksigner verify --verbose --print-certs`.
4. [Obtainium](https://github.com/ImranR98/Obtainium) can follow the GitHub
   releases and do its own verification for users who prefer a store-like
   updater.

The Android signing key is separate from the updater key and the registry key.
A tag release fails closed when `PANDU_ANDROID_KEYSTORE_BASE64`,
`PANDU_ANDROID_KEYSTORE_PASSWORD`, `PANDU_ANDROID_KEY_ALIAS`, or
`PANDU_ANDROID_KEY_PASSWORD` is missing. Pull-request builds still produce an
unsigned APK for smoke testing.

## 5. Version and artifacts

1. Update the version in every place that carries it:

   - `Cargo.toml` (`workspace.package.version`),
   - `app/src-tauri/Cargo.toml`,
   - `app/src-tauri/tauri.conf.json`,
   - `app/package.json`,
   - `ui/package.json`,
   - `packaging/manifest.json`.

   Run `node app/scripts/sync-brand.mjs`, then
   `node app/scripts/check-brand.mjs`. The tag must be `v<version>` and must
   equal `app/src-tauri/tauri.conf.json`; the `plan` job refuses a mismatch.

2. Update `packaging/manifest.json` if artifact names or channels changed.
3. Build from the tagged commit, never from a developer working tree.
4. Tag and push:

   ```powershell
   git tag -s v0.2.0 -m "Pandu 0.2.0"
   git push origin v0.2.0
   ```

   The tag workflow runs every gate, builds the artifacts, and creates a
   **draft** release. It does not publish anything.

5. The draft contains:

   | Artifact | Built by | Notes |
   | --- | --- | --- |
   | `pandu-cli-<target>.zip` / `.tar.xz` | cargo-dist | Windows, Linux, macOS (x86_64 and aarch64) |
   | `pandu-cli-installer.ps1`, `pandu-cli-installer.sh` | cargo-dist | Per-user CLI installers |
   | `Pandu_<version>_x64-setup.exe` | Tauri NSIS | Per-user, no administrator rights |
   | `Pandu_<version>_x64_en-US.msi` | Tauri WiX | Per-machine, managed deployment |
   | `pandu-<version>-x86_64-pc-windows-msvc-portable.zip` | `app/scripts/portable.mjs` | No installer |
   | `pandu-<version>-android-universal-release-signed.apk` | Gradle + `apksigner` | Signed in CI, verified |
   | `<crate>-sbom.json` | cargo-cyclonedx | CycloneDX 1.5 |
   | `THIRD_PARTY_NOTICES.md` | `packaging/notices.mjs` | Rust and JavaScript licenses |
   | `SHA256SUMS` | `app/scripts/checksums.mjs` | Every asset |

6. Authenticode is a placeholder. Set `WINDOWS_CERTIFICATE_BASE64` and
   `WINDOWS_CERTIFICATE_PASSWORD` to sign the standalone executable, the NSIS
   installer, and the MSI. Without them the workflow ships unsigned artifacts
   and says so in the step summary. The executable inside the NSIS and MSI
   bundles stays unsigned either way; do not claim otherwise. Open-source
   projects can apply to SignPath.io or Azure Trusted Signing, but eligibility
   is not automatic: check the current programme rules before promising a
   signed build.

7. Android signing keys come from the release environment; never commit a
   keystore or password. Keep the APK signing key separate from the updater and
   registry keys.

8. Sign `pandu-update.json` offline (section 4) and upload it to the draft.
   `pandu update` is the only automatic installer. The desktop app and the
   Android app never install silently.

9. Refresh the channel drafts only after the release is public:

   ```powershell
   node packaging/channel-manifests.mjs
   ```

   This reads the real `SHA256SUMS`, replaces the zero placeholders, and
   rewrites `packaging/winget/ganddtn40.Pandu.yaml` and
   `packaging/scoop/pandu.json`. Submit them to `microsoft/winget-pkgs` and the
   scoop bucket separately; the release workflow does not publish to either
   channel.

10. Publish the draft by hand, after the manifest is uploaded and verified.

The tag workflow also produces a CycloneDX SBOM, a GitHub artifact provenance
attestation for every uploaded file, `THIRD_PARTY_NOTICES.md`, and the
`cargo-deny` / pnpm license gates. A failed license, registry, or updater gate
stops the release before the draft is created.

## 6. Post-release checks

1. Download `SHA256SUMS` and every asset from the published release. Verify
   each hash. Run `apksigner verify --verbose --print-certs` on the APK.
2. Install on a clean Windows virtual machine:
   - NSIS per-user: no administrator prompt, WebView2 bootstrapper runs when
     the runtime is missing.
   - MSI per-machine: installs for every user and needs administrator rights.
   - Portable zip: starts with WebView2 already installed.
   Confirm the tray icon, close-to-tray behavior, `pandu://flights/<id>`, and
   that uninstall keeps `%USERPROFILE%\.pandu` unless you opt in to deletion.
   Run `node app/scripts/uninstall-check.mjs --phase before` before uninstalling
   and `--phase after --baseline dist/uninstall-baseline.json` afterwards. The
   after-check must pass with no protocol handler, shortcut, task, service,
   autostart value, uninstall entry, install directory, or vendor registry key
   left behind. See [`BENCHMARKS.md`](BENCHMARKS.md#uninstall-hygiene).
3. Install the APK on a clean phone or emulator. Confirm the camera permission
   is requested only after **Scan QR**, the Keystore token survives a restart,
   the four notification channels exist, the 15-minute background check runs,
   and a high-risk approval requires the PIN or biometric.
4. Install the PWA over the Tailscale HTTPS URL. Confirm the install prompt,
   the app-shell cache, and that no API or flight content is cached.
5. Run the published CLI:

   ```powershell
   pandu --version
   pandu doctor
   ```

   Record one demo flight and confirm no network request is made without an
   explicit user action.
6. Check the update path with a release build. With a signed manifest on the
   release, `pandu update --check` reports it; with no production key embedded,
   the build must say updates are unavailable and accept nothing.
7. Verify provenance for one artifact:

   ```powershell
   gh attestation verify .\Pandu_0.2.0_x64-setup.exe --repo ganddtn40/pandu
   ```

8. Update the changelog and close the release issue.

## 7. Private-repo dry run

The tag workflow has never run end to end. Before the first public tag, run it
once in a private repository with a throwaway tag. This proves the workflow
syntax, the cargo-dist and Tauri paths, the gates, and the draft-release step
without publishing anything.

Use the tag **`v0.0.0-ci-test`**. It is the only tag allowed to skip the
app-version match, and it always produces a draft (`draft: true`), never a
published release.

1. Create a private repository and push the release commit and branch.
2. Enable Actions and set the repository default workflow permissions to
   **Read repository contents**. The release job requests `contents: write` for
   the draft only.
3. Create and push the throwaway tag:

   ```bash
   git tag v0.0.0-ci-test
   git push origin v0.0.0-ci-test
   ```

4. Watch the run:

   ```bash
   gh run list --workflow Release
   gh run watch
   ```

5. Check the expected result:
   - `plan`, `cli-local`, `cli-global`, `windows-app`, `verify`, `licenses`,
     `registry-gate`, `update-gate`, and `sbom` succeed.
   - `android` may fail; it is non-blocking and its APK is not a release asset.
   - `release` creates a **draft** named `v0.0.0-ci-test`, marked prerelease.
   - The draft contains the CLI archives, Windows installers, portable zip,
     SBOMs, `THIRD_PARTY_NOTICES.md`, and `SHA256SUMS`.
   - The draft does **not** contain `pandu-update.json` or an Android APK.
   - `SHA256SUMS` matches every attached file.

6. Download one asset and verify it:

   ```bash
   gh release download v0.0.0-ci-test --pattern SHA256SUMS
   gh release download v0.0.0-ci-test --pattern 'Pandu_*_x64-setup.exe'
   sha256sum -c SHA256SUMS --ignore-missing
   ```

7. Clean up. Do not leave the tag or the draft behind:

   ```bash
   gh release delete v0.0.0-ci-test --yes --cleanup-tag
   git tag -d v0.0.0-ci-test
   git push origin :refs/tags/v0.0.0-ci-test
   ```

   `--cleanup-tag` deletes the remote tag. Delete the local tag separately if
   it still exists. Workflow artifacts expire after their retention window; if
   the repository is only for the dry run, delete it as well.

8. Record the run URL and any fixes in the release issue. Fix the workflow and
   repeat the dry run until it passes. Only then create the real version tag.

If the dry run fails, do not create the real tag. The draft is not a release;
delete it and fix the workflow first.
