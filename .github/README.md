# GitHub configuration

Release automation lives here:

- `.github/workflows/ci.yml` runs the Rust workspace on Windows, macOS, and
  Linux, plus the UI, Playwright, adapter fixtures, packaging, Android, and docs
  gates.
- `.github/workflows/release.yml` runs on a version tag, builds the CLI with
  cargo-dist, the Windows bundles with Tauri, and the Android APK, then creates
  an unsigned draft release for offline Minisign signing.
- `.github/workflows/registry.yml` validates the signed market registry.
- `CODEOWNERS` routes review for the security-sensitive paths.

Community files (issue forms, PR template, `SECURITY.md`,
`CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, Dependabot) are Phase 12 work and are
not present yet.
