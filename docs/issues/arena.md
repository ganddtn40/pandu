# Arena — compare agent runs side by side

**Labels:** `help wanted`, `feature`, `area: arena`, `size: L`
**Status:** Deferred from v0.2.0
**Legacy reference:** `legacy/packages/daemon/src/arena/service.ts`,
`legacy/packages/core/src/arena.ts`,
`legacy/apps/web/src/pages/ArenaPage.tsx`

## Why

Developers want to know which agent, model, or prompt produces the best result
for a task. Today they compare by hand: run one agent, copy the output, run
another, lose track of cost and diffs. Arena turns that into one local,
repeatable comparison.

Arena must not become a benchmark leaderboard. It compares runs the user
actually made, on the user's machine, with the user's repository.

## What to build

### Data model

- `arena_runs`: id, project_id, title, prompt, created_at, status
- `arena_variants`: id, arena_run_id, session_id, label, agent_id, model,
  status, cost_usd, token totals, duration_ms
- `arena_verdicts`: id, arena_run_id, variant_id, verdict (`winner`, `rejected`,
  `tie`), note, created_at

Variants reference normal flights. Do not duplicate steps, tool calls, or diffs;
read them from the existing tables.

### API

- `POST /api/arena` — create a run with a prompt and 2–5 variant specs
- `GET /api/arena` — list runs
- `GET /api/arena/:id` — run detail with variant summaries
- `POST /api/arena/:id/verdict` — mark winner/rejected/tie with an optional note
- `DELETE /api/arena/:id` — delete the run, keep the underlying flights

Starting variants may reuse `cockpit run -- <agent>` under the hood. The first
version can require the user to launch each variant manually and attach the
resulting flight; automatic launching is a stretch goal, not an acceptance
criterion.

### UI

A single Arena detail view inside Flights, not a fifth top-level screen:

- Prompt header
- 2–5 columns on desktop, stacked cards on phone
- Per variant: agent/model, cost, tokens, duration, trust badge, final diff
  summary, open-flight link
- Winner control and optional note
- Honest empty state with `Try demo`

## Acceptance criteria

- [ ] A user can create an Arena run from an existing flight or from scratch.
- [ ] 2–5 flights can be attached to one run and are labeled by agent/model.
- [ ] Cost, token totals, duration, and trust score are read from the flights,
      not recomputed differently.
- [ ] A winner, rejected, or tie verdict can be saved and edited.
- [ ] Deleting an Arena run never deletes the underlying flights.
- [ ] Arena works entirely offline and writes only to local SQLite.
- [ ] The UI works at 1440×900 and 390×844, light and dark.
- [ ] Unit tests cover verdict validation and cost aggregation.
- [ ] No new background process, telemetry, or network call is introduced.

## Non-goals

- Public leaderboards or sharing results
- Automatic model routing
- Statistical significance claims
- Replacing the four-screen information architecture

## Getting started

1. Read `docs/REWRITE.md` sections 2.2 and 4.
2. Run the old Arena service and page from `legacy/` to understand behavior.
3. Propose the smallest schema and API in this issue before coding.
4. Add migrations, API tests, and a UI state matrix.
