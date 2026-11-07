# Provenance — trace every change back to the prompt that caused it

**Labels:** `help wanted`, `feature`, `area: provenance`, `size: L`
**Status:** Deferred from v0.2.0
**Legacy reference:** `legacy/packages/daemon/src/provenance/service.ts`,
`legacy/packages/core/src/provenance.ts`,
`legacy/apps/web/src/pages/TrustPage.tsx` (partial)

## Why

When a line of code is wrong, the useful question is “which step changed this,
and what was the agent asked?”. Provenance links file changes to the prompt,
response, tool call, and model that produced them, locally and without guessing.

This is also the foundation for auditability: a user can review exactly what an
agent did and why, step by step.

## What to build

### Data model

- `provenance_links`: id, project_id, session_id, step_id, file_change_id,
  file_path, line_start, line_end, confidence
  (`exact`, `inferred`, `unknown`), created_at
- `provenance_notes`: id, link_id, note, created_at

Do not duplicate diffs or prompts. Link to existing rows.

### Attribution

1. Start from per-step git snapshots and file changes.
2. For each changed file, record the step and tool call that touched it.
3. When two steps touch the same file, attribute line ranges by comparing
   consecutive patches.
4. If attribution is ambiguous, store `unknown` with the candidate steps instead
   of guessing.
5. Never claim exact attribution from a whole-file rewrite.

### API

- `GET /api/sessions/:id/provenance` — links for a flight
- `GET /api/steps/:id/provenance` — links for a step
- `GET /api/provenance/:id` — link detail with step, prompt, and diff
- `PATCH /api/provenance/:id` — add a note or correct the link
- `GET /api/files/:path/provenance?project=` — history for a file

### UI

Inside Flights detail and the step inspector:

- Changed file list with a small provenance chip per file
- Click a file to see the step, prompt excerpt, model, and diff
- Line-range highlight where confidence is `exact`
- `Unknown` state with candidate steps
- No separate top-level Provenance screen

## Acceptance criteria

- [ ] Every file change from a snapshot gets a link row with a confidence value.
- [ ] Ambiguous changes are marked `unknown`, never guessed as `exact`.
- [ ] A user can click a file and see the responsible step, prompt excerpt, and
      diff.
- [ ] Whole-file rewrites are marked inferred/unknown with an explanation.
- [ ] Users can correct a link and add a note.
- [ ] Provenance is derived locally from stored snapshots; no network call.
- [ ] Fixture tests cover single-step, multi-step, rename, and rewrite cases.
- [ ] UI works at 1440×900 and 390×844, light and dark.

## Non-goals

- Legal or compliance certification
- Blame UI or ranking developers
- Automatic code review verdicts
- Attribution for changes made outside recorded flights
- A separate top-level Provenance screen

## Getting started

1. Read the old provenance service for prior art.
2. Start with file-level attribution and confidence, not line ranges.
3. Add line-range attribution only when consecutive patches are reliable.
4. Propose the confidence rubric in this issue before coding.
