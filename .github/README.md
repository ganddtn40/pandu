# GitHub configuration

Community files and release automation are added in Phase 7:

- Issue forms: bug, feature, new agent adapter, translation
- PR template with a checklist
- `CODEOWNERS`, labels list
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`
- Dependabot and release-drafter
- Release workflow built on cargo-dist

Current CI (`.github/workflows/ci.yml`) checks the Rust workspace on Windows,
macOS, and Linux. It grows to include UI tests, Playwright, adapter fixtures, and
packaging in later phases.
