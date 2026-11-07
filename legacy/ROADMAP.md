# Roadmap

Cockpit is built in verified phases. The 0.1.0 release completes the core
recorder, the local analysis surfaces, and the first desktop and mobile clients.
This roadmap is directional, not a promise of dates.

## 0.1.0 — complete

- [x] OpenAI and Anthropic recording proxy with streaming passthrough
- [x] SQLite storage, redaction, cost accounting, and unknown-cost honesty
- [x] Dashboard, live WebSocket feed, replay, and fork-from-here
- [x] Run Guard, budgets, secret scans, and deterministic trust scoring
- [x] Provenance, understanding debt, and the Context Doctor
- [x] Project Brain, Model Arena, handoff briefs, analytics, journal, plugins
- [x] Single-use pairing, device tokens, and explicit remote access
- [x] Tauri desktop shell and Capacitor Android client
- [x] `cockpit demo`, `cockpit doctor`, docs, CI, and release workflows

## Next

- [ ] Encrypted local storage option (SQLCipher or an encrypted vault)
- [ ] A `cockpit stop` command and richer daemon lifecycle controls
- [ ] Signed Windows installers and an Android release build
- [ ] A Linux desktop build and a macOS build
- [ ] VS Code extension for one-click Cline and Continue setup
- [ ] OTLP export for teams that already run an observability backend
- [ ] More provider adapters (Gemini, Bedrock, Azure OpenAI)
- [ ] Session comparison and diff between two flights
- [ ] Configurable redaction rules and a dry-run preview
- [ ] A first-class `cockpit export` bundle for audits and PRs

## Later

- [ ] Opt-in, end-to-end encrypted sync between your own devices
- [ ] Team workspaces without a hosted control plane
- [ ] Policy packs for common security and compliance checks
- [ ] Deeper cost forecasting from recorded history
- [ ] Plugin marketplace with signatures and a review process

## Non-goals

- A hosted Cockpit account or a mandatory cloud service
- Telemetry or analytics that leave your machine
- Replacing your agent, model provider, or source control
- Storing provider keys in a Cockpit cloud
- Training models on your recorded flights

## How to influence the roadmap

Open a discussion with the problem you are trying to solve, not only the
feature you want. Concrete workflows and reproducible pain points move issues
up faster than vote counts. Security work always takes priority.
