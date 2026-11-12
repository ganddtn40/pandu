# Packaging and distribution

Everything here is a draft. CI builds the artifacts and creates a **draft**
GitHub release; nothing is published until a maintainer signs the update
manifest offline and publishes the draft by hand.

## Artifacts

| Channel | Artifact | Tool |
| --- | --- | --- |
| Windows CLI | `pandu-cli-x86_64-pc-windows-msvc.zip` + PowerShell installer | cargo-dist |
| macOS CLI | `pandu-cli-aarch64-apple-darwin.tar.xz`, `pandu-cli-x86_64-apple-darwin.tar.xz` + shell installer | cargo-dist |
| Linux CLI | `pandu-cli-x86_64-unknown-linux-gnu.tar.xz` + shell installer | cargo-dist |
| Windows app | `Pandu_<version>_x64-setup.exe` (NSIS, per-user) | Tauri 2 |
| Windows app | `Pandu_<version>_x64_en-US.msi` (WiX, per-machine) | Tauri 2 |
| Windows portable | `pandu-<version>-x86_64-pc-windows-msvc-portable.zip` | `app/scripts/portable.mjs` |
| Android (experimental) | `pandu-<version>-android-universal-release-signed.apk`; not attached to releases until verified | Tauri 2 + Gradle + `apksigner` |
| PWA | served by the daemon from the bundled `ui/dist`; no separate asset | Vite |
| winget | `packaging/winget/ganddtn40.Pandu.yaml` draft | winget-pkgs |
| scoop | `packaging/scoop/pandu.json` draft | scoop bucket |
| Homebrew, npm | not configured | — |

The tag workflow also uploads `<crate>-sbom.json` for the three crates and the
desktop shell, `THIRD_PARTY_NOTICES.md`, and `SHA256SUMS` covering every file.

## Rules

- Update checks are one HTTPS `GET` to the pinned GitHub Releases API, at most
  once every 24 hours, and can be turned off in Settings. They send no token,
  no machine identifier, and no usage data. Pandu never installs an update
  without an explicit user action.
- Every update artifact is listed in a signed `pandu-update.json` with a
  SHA-256 and a Minisign signature. Release builds trust only a production
  updater public key and fail closed without one. Sign with
  `packaging/sign-update.mjs`; keep the private key offline.
- Release binaries are built from a tagged commit in CI, never from a developer
  machine. The tag must be `v<version>` and must match
  `app/src-tauri/tauri.conf.json`.
- Android signing keys are supplied by the release environment and never
  committed. Keep the APK signing key separate from the updater and registry
  keys.
- Checksums are published next to every artifact.
- Installers and uninstallers never delete user data. The database and settings
  live outside the application directory, and removing them is an explicit
  opt-in.
- The Windows installers are unsigned unless an Authenticode certificate is
  configured. The executable inside the NSIS and MSI bundles stays unsigned
  even then; docs and release notes must say so.

## Windows installers

`pnpm --dir app exec tauri build --bundles nsis msi` builds both bundles.

- **NSIS** is the recommended per-user install. It does not need administrator
  rights, and `app/src-tauri/installer/hooks.nsh` asks whether to delete
  `%USERPROFILE%\.pandu` during uninstall. The default is **No**, and silent
  uninstalls always keep the data.
- **MSI** is per-machine for managed deployment. It needs administrator rights
  and has no data-deletion hook; removing `%USERPROFILE%\.pandu` is a manual
  step.
- **Portable zip** contains the single executable plus a short README. WebView2
  must already be installed.

The NSIS installer downloads the WebView2 Evergreen bootstrapper when the
runtime is missing. That is the only network access during install.

### Authenticode placeholder

The release workflow signs the standalone executable, the NSIS installer, and
the MSI when these repository secrets exist:

- `WINDOWS_CERTIFICATE_BASE64` — base64 of a `.pfx` file.
- `WINDOWS_CERTIFICATE_PASSWORD` — the `.pfx` password.

Without the secrets the workflow ships unsigned artifacts and notes it in the
step summary. Do not treat an unsigned build as a failure. Open-source signing
programmes (SignPath.io, Azure Trusted Signing) have their own eligibility
rules; check them before promising a signed release.

## Android signing

Gradle builds an **unsigned** release APK. Signing happens afterwards with
`apksigner`, so no keystore or signing config is ever committed:

```powershell
node app/scripts/android-init.mjs
node app/scripts/android-build.mjs --sign --require-sign --out dist/android
```

Required environment:

- `PANDU_ANDROID_KEYSTORE` — path to the keystore.
- `PANDU_ANDROID_KEYSTORE_PASSWORD`
- `PANDU_ANDROID_KEY_ALIAS`
- `PANDU_ANDROID_KEY_PASSWORD`

The script runs `apksigner verify` after signing and writes `SHA256SUMS`. A tag
release fails closed when the CI secrets are missing; pull-request builds still
produce an unsigned APK for smoke testing.

Generate a keystore once, offline, and keep it out of the repository:

```powershell
keytool -genkeypair -v -keystore pandu-release.keystore `
  -alias pandu -keyalg RSA -keysize 4096 -validity 10000
```

## Update manifest signing

`packaging/sign-update.mjs` writes the signed JSON asset that `pandu update`
reads. It needs the `minisign` binary and an offline private key. CI never
holds the key and never creates the manifest.

```powershell
node packaging/sign-update.mjs `
  --version 0.3.0 `
  --notes dist/notes.md `
  --artifact windows-x86_64=dist/Pandu_0.3.0_x64-setup.exe `
  --artifact windows-portable=dist/pandu-0.3.0-x86_64-pc-windows-msvc-portable.zip `
  --artifact android-universal=dist/pandu-0.3.0-android-universal-release-signed.apk `
  --expires 2026-12-01T00:00:00Z `
  --sequence 42 `
  --key E:\secure\pandu-updater-2026.key `
  --out dist/pandu-update.json
```

Upload the output as `pandu-update.json` to the draft release, verify it with a
release build, then publish the draft. The full key ceremony, rotation, and
compromise response are in
[`docs/RELEASING.md`](../docs/RELEASING.md#4-updater-trust-root-and-key-ceremony).

## Channel manifests

`packaging/channel-manifests.mjs` generates the winget and scoop drafts from
`brand.json`, the Tauri version, and the release asset names:

```powershell
node packaging/channel-manifests.mjs
node packaging/channel-manifests.mjs --check
```

Hashes stay as 64 zeroes until a real `SHA256SUMS` exists in `dist/release` or
`dist/windows`. After the release is public, run the generator without
`--check` to fill the real hashes, then submit the files to
`microsoft/winget-pkgs` and the scoop bucket. `--check` fails on drift and runs
in CI; never edit the generated files by hand.

## Release gates

The tag workflow runs the workspace tests, UI checks, `cargo-deny`, the pnpm
license audit, the generated-notices check, the registry trust-root gate, the
updater trust-root gate, and the Android build before it creates the draft. It
attests every uploaded file with GitHub artifact provenance and generates
CycloneDX SBOMs. See [`.github/workflows/release.yml`](../.github/workflows/release.yml).
