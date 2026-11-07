# Changelog

All notable changes to Cockpit are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `cockpit demo` seeds a realistic three-flight demo without an agent or a
  provider, and is safe to run repeatedly.
- Screenshot generation for the dashboard and documentation assets.
- CI, npm release, Windows desktop, and Android APK workflows.
- Getting-started guides for OpenCode, Cline, Aider, and Claude Code.
- Architecture, plugin, and security documentation.
- Issue and pull-request templates, a code of conduct, a security policy, and a
  roadmap.

## [0.1.0] - 2026-11-07

### Added

- OpenAI-compatible and Anthropic-compatible recording proxy with SSE
  passthrough.
- Local SQLite storage for sessions, steps, tool calls, stream chunks,
  redactions, snapshots, guards, budgets, trust, provenance, understanding,
  context, Project Brain, arena runs, handoffs, journals, plugins, and pairing.
- Dashboard with overview, flight log, session inspector, replay, trust,
  understanding, context, guards, analytics, Project Brain, Model Arena,
  journal, plugins, and pairing.
- Live WebSocket feed with durable lifecycle events and transient stream
  chunks.
- Git snapshots with a temporary index, per-file diffs, replay, and fork
  worktrees.
- Run Guard with conservative built-in rules, local rules, approvals, budgets,
  and secret rescans.
- Deterministic cheat detection and trust scoring with evidence.
- Provenance attribution, understanding debt, explanations, and quizzes.
- Context Doctor snapshots, segment breakdowns, and deterministic insights.
- Project Brain generation, checksum drift detection, and safe sync.
- Model Arena replay against one to six provider:model targets.
- Handoff briefs, analytics, weekly journals, and local plugins.
- Single-use pairing codes, hashed device tokens, local-only pairing
  management, and remote bearer authentication.
- Tauri v2 desktop shell and Capacitor Android client.
- CLI commands for daemon lifecycle, agent runs, doctor, demo, guards, budgets,
  debt, context, provenance, projects, brain, arena, handoff, analytics,
  journal, plugins, pairing, and devices.
- Strict TypeScript, Zod contracts, ESLint, Prettier, Vitest, and pnpm
  workspaces.

[Unreleased]: https://github.com/<owner>/cockpit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<owner>/cockpit/releases/tag/v0.1.0
