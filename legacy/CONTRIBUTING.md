# Contributing to Cockpit

Cockpit is an open-source, local-first project. Contributions of code, tests,
documentation, and careful bug reports are welcome.

By contributing, you agree that your work is licensed under the MIT License in
[LICENSE](LICENSE).

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be
direct about the work and respectful to the people doing it.

## Development setup

Requirements:

- Node.js 22.11 or newer
- pnpm 12 (`corepack enable` is the easiest way to match the pinned version)
- git

```bash
git clone https://github.com/<owner>/cockpit.git
cd cockpit
pnpm install
pnpm build
pnpm test
```

The built CLI is available at `packages/cli/dist/index.js`:

```bash
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js demo
```

`cockpit demo` seeds a realistic fake flight into the local database. It never
contacts an agent or a provider. Use a throwaway `COCKPIT_HOME` if you want the
demo data isolated:

```bash
COCKPIT_HOME=./.cockpit-dev node packages/cli/dist/index.js demo
```

## Checks

Run the same checks as CI before opening a pull request:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Use `pnpm format` to fix formatting. `pnpm build` is required after changing a
package's public exports or the dashboard.

Database changes:

```bash
pnpm db:generate
```

Commit the generated migration in `packages/daemon/drizzle`. Never edit an
applied migration by hand; add a new one.

## Project layout

| Path              | What lives there                                                  |
| ----------------- | ----------------------------------------------------------------- |
| `packages/core`   | Zod schemas and pure helpers. Keep it free of I/O.                |
| `packages/daemon` | Proxy, storage, services, REST API, WebSocket, dashboard hosting. |
| `packages/cli`    | The `cockpit` binary and command formatting.                      |
| `apps/web`        | React dashboard. Validate API responses with `@cockpit/core`.     |
| `apps/desktop`    | Tauri v2 shell. The JavaScript build must not require Rust.       |
| `apps/mobile`     | Capacitor Android client.                                         |
| `docs`            | Guides, architecture, security, and good first issues.            |

Read [docs/architecture.md](docs/architecture.md) before changing the request path
or the storage model.

## Code standards

- TypeScript strict mode is mandatory. Do not use `any`; use `unknown` and a
  schema or a type guard.
- Every external boundary is validated with Zod. New API responses get a
  schema in `packages/core` and a test.
- Optional properties follow `exactOptionalPropertyTypes`; use conditional
  spreads instead of assigning `undefined`.
- Keep the proxy streaming-safe. Never buffer an SSE response to record it.
- Keep analysis deterministic unless the feature is explicitly a model call.
- No telemetry, no hosted service, and no fake data outside demo mode.
- UI changes need keyboard access, visible focus, and an accessible name for
  every control.
- Prefer a small, tested change over a broad refactor. Preserve existing
  behavior unless the issue explicitly changes it.

## Tests

- Daemon tests use `COCKPIT_DATABASE=:memory:`, `COCKPIT_PORT=0`, and fake
  upstreams. Do not hit a real provider.
- CLI tests start a real in-memory daemon when the behavior crosses HTTP.
- Web and mobile tests render with an injected API client and real fixtures.
- Add a regression test for every bug fix. A test that only asserts "no throw"
  is not enough.
- Tests must be deterministic. Do not depend on the local timezone or locale.

## Commits and pull requests

- Write imperative, specific commit messages, for example
  `fix(daemon): preserve Retry-After on a 429`.
- Keep pull requests focused. Separate refactors from behavior changes.
- Describe the user-visible change, the tests you ran, and any limitation.
- Link the issue with `Closes #123` when applicable.
- Update the README or docs when a command, route, or configuration value
  changes.
- Do not commit build output, local databases, or `node_modules`.

## Good first issues

Start with [docs/good-first-issues.md](docs/good-first-issues.md). Comment on the
GitHub issue before starting so two people do not duplicate work.

## Security

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md).

## Questions

Open a GitHub discussion or an issue with the `question` label. Include the
Cockpit version (`cockpit --version`), the operating system, and the output of
`cockpit doctor`.
