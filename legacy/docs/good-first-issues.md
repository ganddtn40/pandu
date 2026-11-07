# Good first issues

These are scoped, useful, and testable. Comment on the GitHub issue to claim
one. If you are new to the codebase, read [CONTRIBUTING.md](../CONTRIBUTING.md)
and run the full check suite before opening a pull request.

Each draft below includes the likely files, the expected behavior, and
acceptance criteria. Keep the change narrow; open a discussion first if you
want to expand the scope.

---

## 1. Add `cockpit doctor --json`

**Difficulty:** easy · **Labels:** `good first issue`, `cli`, `dx`

`cockpit doctor` prints a human-readable report. Automation needs a stable JSON
shape with the same checks and exit code.

**Files:** `packages/cli/src/doctor.ts`, `packages/cli/src/cli.ts`,
`packages/cli/tests/doctor.test.ts`.

**Acceptance criteria**

- `cockpit doctor --json` prints a single JSON object with `checks` and
  `exitCode`; each check has `name`, `status`, and `detail`.
- The exit code is unchanged: `1` when any check is `fail`, otherwise `0`.
- The human-readable output is unchanged when `--json` is absent.
- Tests cover ok, warn, and fail reports.

---

## 2. Run a SQLite integrity check in `cockpit doctor`

**Difficulty:** easy · **Labels:** `good first issue`, `cli`, `storage`

`doctor` currently counts tables. A corrupted database can still have the right
table count.

**Files:** `packages/cli/src/doctor.ts`, `packages/cli/tests/doctor.test.ts`.

**Acceptance criteria**

- Run `PRAGMA integrity_check` against the configured database.
- Report `ok` for `ok`, and `fail` with the first error line otherwise.
- Keep the check read-only and close the connection in a `finally` block.
- Add a test with a valid temporary database and a test seam for a failure.

---

## 3. Add `cockpit session create`

**Difficulty:** easy–medium · **Labels:** `good first issue`, `cli`, `api`

Tools that cannot be wrapped by `cockpit run` (Cline, IDE extensions) need an
explicit session id. Today users must call the REST API with `curl`.

**Files:** `packages/cli/src/cli.ts`, `packages/cli/src/daemon-client.ts`,
`packages/cli/tests/`.

**Acceptance criteria**

- `cockpit session create --title "..." --workspace .` creates a manual session
  and prints the id and dashboard URL.
- `--json` prints the parsed `Session` object.
- The command reuses `DaemonClient.createSession`; do not add a second HTTP
  path.
- Tests cover text output, JSON output, and a daemon error.

---

## 4. Add `cockpit demo --reset`

**Difficulty:** medium · **Labels:** `good first issue`, `cli`, `demo`

Running `cockpit demo` is idempotent, which is good for screenshots but makes it
hard to recover from an edited demo story.

**Files:** `packages/daemon/src/demo/seed.ts`, `packages/daemon/src/store/store.ts`,
`packages/cli/src/demo.ts`, `packages/cli/src/cli.ts`, tests.

**Acceptance criteria**

- `cockpit demo --reset` removes only sessions whose `source` is `demo` and
  whose metadata contains the demo seed marker, then reseeds.
- Real sessions are never deleted.
- The operation is transactional or clearly reports partial failure.
- The command prints the same summary as `cockpit demo`.
- Tests assert that a real session survives a reset.

---

## 5. Export analytics as CSV

**Difficulty:** easy · **Labels:** `good first issue`, `cli`, `analytics`

The analytics API returns JSON. Spreadsheet users need a CSV export.

**Files:** `packages/cli/src/cli.ts`, `packages/cli/src/phase7.ts` (or a new
`analytics.ts`), `packages/cli/tests/`.

**Acceptance criteria**

- `cockpit analytics --days 30 --csv` prints a header row and one row per UTC
  day with sessions, steps, tokens, cost, and errors.
- Values are RFC 4180 quoted when they contain commas, quotes, or newlines.
- The JSON path is unchanged.
- Tests cover quoting and an empty window.

---

## 6. Add copy buttons to the step inspector

**Difficulty:** easy · **Labels:** `good first issue`, `web`, `ui`

The replay console can copy prompts and diffs, but the session inspector cannot
copy a request body or a response.

**Files:** `apps/web/src/components/StepInspector.tsx`,
`apps/web/src/pages/SessionPage.tsx`, `apps/web/src/styles/global.css`, tests.

**Acceptance criteria**

- Request body, system prompt, prompt text, response text, and response
  thinking each get a copy button.
- The button has an accessible name and announces success without relying on
  color alone.
- Use `navigator.clipboard.writeText` and reset the "Copied" state after a
  short timeout, matching the existing replay pattern.
- Component tests cover the success path and a rejected clipboard promise.

---

## 7. Show a demo-mode banner in the dashboard

**Difficulty:** easy · **Labels:** `good first issue`, `web`, `demo`

The daemon reports `demoMode` in `/api/health`, but the dashboard does not make
it obvious that the visible data is synthetic.

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/components/AppShell.tsx`,
`apps/web/src/styles/global.css`, tests.

**Acceptance criteria**

- When health reports `demoMode: true`, show a persistent, dismissible banner:
  "Demo data · nothing here came from a real agent."
- The banner is visible on every route, does not cover navigation, and has a
  link to the demo documentation.
- `demoMode: false` renders nothing.
- Tests cover both states and the dismiss action.

---

## 8. Filter the flight log by tag

**Difficulty:** medium · **Labels:** `good first issue`, `web`, `api`

Sessions carry tags (`demo`, `cli`, `auth`, and so on), but the flight log only
filters by search and status.

**Files:** `packages/core/src/session.ts`, `packages/daemon/src/app.ts`,
`packages/daemon/src/store/store.ts`, `apps/web/src/lib/api.ts`,
`apps/web/src/pages/SessionsPage.tsx`, tests.

**Acceptance criteria**

- Add an optional `tag` query parameter to `GET /api/sessions`.
- Filtering is exact and combines with search, status, and pagination.
- The flight log exposes a tag selector populated from the current page or a
  small aggregate endpoint.
- The empty state explains how to clear the filter.
- Tests cover a matching tag, no match, and a tag plus status filter.

---

## 9. Ship an example analyzer plugin

**Difficulty:** easy–medium · **Labels:** `good first issue`, `plugins`, `docs`

The plugin guide has a snippet, but there is no runnable example in the repo.

**Files:** new `examples/plugins/file-touch-counter/` with
`cockpit-plugin.json`, `index.mjs`, and a README; a daemon test that installs
and runs it.

**Acceptance criteria**

- The plugin counts distinct file paths in tool calls and returns JSON.
- It uses only Node built-ins and reads stdin, matching the documented contract.
- `cockpit plugins install examples/plugins/file-touch-counter` works from a
  clean checkout after `pnpm build`.
- The README explains the expected payload and output.
- A test covers install, run, and the stored result.

---

## 10. Export a flight as a Markdown bundle

**Difficulty:** medium · **Labels:** `good first issue`, `cli`, `export`

Handoff briefs cover the resume case. Users also want a portable record of a
whole flight for a PR, an incident review, or an offline archive.

**Files:** `packages/cli/src/cli.ts`, a new
`packages/daemon/src/export/markdown.ts` service, `packages/daemon/src/app.ts`,
tests.

**Acceptance criteria**

- `cockpit export <sessionId> --out flight.md` writes a Markdown document with
  session metadata, step summaries, prompts, responses, tool calls, guard
  events, trust findings, and snapshot file lists.
- Secrets already redacted in storage stay redacted; the exporter never reads
  raw request bytes from disk.
- Output is deterministic for the same session and is bounded (large fields
  are clipped with an explicit marker).
- `--json` returns the same data as structured JSON.
- Tests cover a session with steps, a failed step, and an empty session.
