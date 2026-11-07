# Plugins — a small, sandboxed extension system

**Labels:** `help wanted`, `feature`, `area: plugins`, `size: XL`
**Status:** Deferred from v0.2.0
**Legacy reference:** `legacy/packages/daemon/src/plugins/service.ts`,
`legacy/packages/core/src/plugin.ts`,
`legacy/apps/web/src/pages/PluginsPage.tsx`,
`legacy/docs/plugins.md`

## Why

Developers will always want one more integration: a custom guard, a cost
exporter, a notification, a report format. Plugins let the community extend
Cockpit without adding every request to the core binary.

A plugin system is also the easiest way to destroy trust. This issue must ship
with a security model, not after it.

## What to build

### Plugin package

A plugin is a directory with `plugin.toml` and a sandboxed entry point:

```toml
schema_version = 1
id = "acme.cost-export"
name = "Cost export"
version = "1.0.0"
description = "Export daily cost as CSV"
author = "Acme"
license = "MIT"
entry = "main.wasm"
runtime = "wasm"

[permissions]
read = ["sessions", "steps"]
write = []
network = []
```

Rules:

- WASM only for v1 of the plugin system. No arbitrary native code.
- No network unless the manifest declares hosts and the user grants them.
- No filesystem access outside an explicit plugin data directory.
- No access to raw prompts/responses unless a separate, clearly named
  permission is granted.
- Every permission is shown at install time in plain language.
- Plugins are disabled by default after install until the user enables them.

### Hooks

Start with a deliberately small set:

- `on_flight_started`
- `on_step_recorded`
- `on_guard_triggered`
- `on_flight_ended`
- `on_daily_summary`

Each hook receives a stable, versioned JSON payload. Plugins return actions
(annotate, emit notification, write export file) but can never modify forwarded
proxy bytes.

### API and UI

- `GET /api/plugins` — installed plugins and state
- `POST /api/plugins` — install from a local `.zip` or directory
- `PATCH /api/plugins/:id` — enable/disable, grant/revoke permissions
- `DELETE /api/plugins/:id`
- `GET /api/plugins/:id/runs` — recent executions and errors

UI lives in Settings under Advanced. No separate Plugins screen.

## Acceptance criteria

- [ ] A plugin can be installed from a local file and shows its permissions
      before install.
- [ ] Plugins are disabled until explicitly enabled.
- [ ] A plugin cannot read prompts/responses without a dedicated permission.
- [ ] A plugin cannot make network calls without a declared host and user grant.
- [ ] A crashing or looping plugin cannot crash the daemon or block a proxy
      request; it is disabled after repeated failures.
- [ ] Hook payloads are versioned and documented.
- [ ] At least two example plugins ship in the repo: CSV cost export and a
      desktop notification.
- [ ] Security tests cover permission bypass, oversized output, and infinite
      loops.
- [ ] `docs/PLUGINS.md` explains the manifest and permissions for beginners.

## Non-goals

- Native dynamic libraries
- A plugin marketplace or remote registry
- Plugins that rewrite proxy traffic
- Plugins that read agent credentials
- A separate top-level Plugins screen

## Getting started

1. Read the old plugin service for prior art, then ignore its permission model
   and design a stricter one.
2. Propose the WASM runtime choice (e.g. Wasmtime) and its size impact on the
   binary.
3. Get security review before implementation.
4. Build the manifest parser and a deny-by-default host first.
