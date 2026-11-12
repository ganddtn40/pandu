# GitHub configuration

Release automation and review routing live here:

- `.github/workflows/ci.yml` runs the Rust workspace on Windows, macOS, and
  Linux, plus the UI, Playwright, adapter fixtures, packaging, Android, and docs
  gates.
- `.github/workflows/release.yml` runs on a version tag, builds the CLI with
  cargo-dist, the Windows bundles with Tauri, and the Android APK, then creates
  an unsigned draft release for offline Minisign signing.
- `.github/workflows/registry.yml` validates the signed market registry.
- `CODEOWNERS` routes review for the security-sensitive paths.
- `ISSUE_TEMPLATE/` and `pull_request_template.md` collect the information the
  gates need.

The community files live at the repository root: `SECURITY.md`,
`CODE_OF_CONDUCT.md`, and `CONTRIBUTING.md`. Dependabot is still open Phase 12
work.

This file is not named `README.md` on purpose. GitHub renders
`.github/README.md` on the repository landing page instead of the project
README, so the configuration notes stay here under a different name.
