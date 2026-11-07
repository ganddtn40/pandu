# Handoff — a clean baton pass between agents or people

**Labels:** `help wanted`, `feature`, `area: handoff`, `size: M`
**Status:** Deferred from v0.2.0
**Legacy reference:** `legacy/packages/daemon/src/handoff/service.ts`,
`legacy/packages/core/src/handoff.ts`,
`legacy/apps/web/src/pages/HandoffPage.tsx`

## Why

Work moves between agents, models, machines, and people. The next session
usually starts with a long, lossy explanation. Handoff generates a compact,
evidence-linked brief: what was the task, what changed, what was decided, what is
left, and which flights prove it.

## What to build

### Data model

- `handoffs`: id, project_id, session_id, title, body_md, status
  (`draft`, `ready`, `consumed`), created_at, updated_at
- `handoff_sources`: handoff_id, step_id, file_change_id, note

### Generated sections

1. **Goal** — user-authored or inferred from the first prompt, with a link
2. **What changed** — files and diff stats from git snapshots
3. **Decisions** — explicit notes the user adds, never invented
4. **Open threads** — failed commands, pending approvals, TODO markers
5. **Next step** — one sentence, user-editable
6. **Evidence** — links to flights and steps

The deterministic generator must work offline. An optional local model can
polish prose, but every sentence must keep a source link.

### API

- `POST /api/sessions/:id/handoffs` — generate a draft
- `GET /api/sessions/:id/handoffs` — list
- `GET /api/handoffs/:id` — detail
- `PATCH /api/handoffs/:id` — edit and mark ready
- `POST /api/handoffs/:id/consume` — mark consumed by a new flight
- `DELETE /api/handoffs/:id`

### UI

A Handoff panel inside Flights detail:

- Generate draft from the current flight
- Editable markdown with section anchors
- Copy as markdown / download `.md`
- “Start a flight from this handoff” action
- `Try demo` empty state

## Acceptance criteria

- [ ] A handoff can be generated from any completed flight, fully offline.
- [ ] Every generated claim links to a step, file change, or user note.
- [ ] Files changed come from git snapshots, not guesses.
- [ ] The user can edit every section and mark the handoff ready.
- [ ] Consuming a handoff creates a new flight with a link back.
- [ ] Copy and download produce clean markdown with no local absolute paths.
- [ ] No prompts, responses, or secrets are included unless the user explicitly
      selects them.
- [ ] Unit tests cover section generation and missing-data cases.
- [ ] UI works at 1440×900 and 390×844, light and dark.

## Non-goals

- Automatic commits or PR creation
- Sending handoffs to a remote service
- Multi-user assignment or comments
- Replacing issue trackers
- A separate top-level Handoff screen

## Getting started

1. Read the old handoff service for section ideas.
2. Start with the deterministic generator and evidence links.
3. Add the consume flow only after generation is trustworthy.
4. Propose the markdown format in this issue.
