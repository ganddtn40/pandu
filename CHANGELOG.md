# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Renamed the product from Cockpit to Pandu. The binary and CLI command are now
  `pandu`, the crates are `pandu-core`, `pandu-daemon`, and `pandu-cli`, the
  environment prefix is `PANDU_`, the data directory is `~/.pandu`, the database
  is `pandu.db`, and the URL scheme is `pandu`.
- Added `brand.json` as the single source of truth for the product name,
  wordmark, tagline, crate and binary names, environment prefix, paths, app ids,
  URL scheme, repository and registry URLs, theme schema, and UI storage prefix.
- On first start, an existing pre-rename data directory is copied to the new
  location. The old directory is never moved or deleted, and a new directory
  always wins when both exist. The copied database is renamed to `pandu.db`
  inside the copy.
- Moved UI preferences to the `pandu.*` storage keys and the `pandu.theme`
  theme schema. Browser storage from the pre-rename build is not migrated.
- Re-signed the test registry fixtures with a new test key. The production
  `registry/index.json` and `registry/revoked.json` keep their frozen
  pre-rename key id and signatures because the offline production key was not
  available during the rename.
- Light is the default theme, with the blue P mark as the app icon on Windows,
  Android, iOS, the PWA, and the favicon. Dark and Frost remain available.

### Added

- Fourteen interface languages: English plus thirteen draft catalogs with lazy
  chunk loading, per-key English fallback, Arabic right-to-left layout, and the
  `pnpm --dir ui check:i18n` gate.
- Beginner install guides in all fourteen interface languages, plus
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue and pull request
  templates, and `docs/TRANSLATING.md`.
- A repository-wide name guard that fails the test suite if the pre-rename name
  appears outside the migration, the frozen production trust root, the
  changelog, and the frozen `legacy/` tree.
- `docs/RELEASING.md` with the release checklist and package-name checks for
  npm, crates.io, winget, and GitHub.
- `AGENTS.md`, `INSTALL-FOR-AGENTS.md`, `llms.txt`, and
  `packaging/manifest.json`.

## [0.1.0]

- First TypeScript/Node release, preserved under `legacy/` as the behavior
  spec for the Rust rewrite.
