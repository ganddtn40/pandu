# Journal — a local daily log of what your agents did

**Labels:** `help wanted`, `feature`, `area: journal`, `size: M`
**Status:** Deferred from v0.2.0
**Legacy reference:** `legacy/packages/daemon/src/journal/service.ts`,
`legacy/packages/core/src/journal.ts`,
`legacy/apps/web/src/pages/JournalPage.tsx`

## Why

Flights answer “what happened in this run?”. A journal answers “what did I ship
this week?”. Developers lose the thread across many short agent sessions; a
short, factual daily summary makes standups and changelogs easier without
sending data anywhere.

## What to build

### Data model

- `journal_entries`: id, project_id, period_start, period_end, title, body_md,
  source_session_ids (JSON array), edited_by_user, created_at, updated_at
- Optional `journal_templates`: id, name, prompt, created_at

Entries are generated from flights the user already recorded. Store the source
session ids so every sentence can be traced back to evidence.

### API

- `POST /api/journal/generate` — generate for a day or week
- `GET /api/journal` — list entries
- `GET /api/journal/:id` — entry with source links
- `PATCH /api/journal/:id` — edit title/body
- `DELETE /api/journal/:id`

Generation must be optional and explicit. If no local model is configured,
produce a deterministic template summary (sessions, steps, files changed,
commands, cost) rather than inventing prose.

### UI

A Journal section inside Home or Flights, not a fifth top-level screen:

- Date range picker (today, yesterday, this week)
- Generated entry with source-flight chips
- Edit-in-place markdown
- Copy as markdown
- `Try demo` empty state

## Acceptance criteria

- [ ] A user can generate a journal entry for today or the last seven days.
- [ ] The deterministic summary lists flights, files changed, commands, and
      cost without any network call.
- [ ] Every generated entry links to the flights it summarizes.
- [ ] Entries can be edited and copied as markdown.
- [ ] Generation never includes prompts, responses, or file contents unless the
      user explicitly enables a local model and sees a preview.
- [ ] No telemetry and no remote model call by default.
- [ ] Unit tests cover date grouping and empty ranges.
- [ ] UI works at 1440×900 and 390×844, light and dark.

## Non-goals

- Automatic publishing to Notion, Slack, or GitHub
- AI-authored performance reviews
- Team journals or shared workspaces
- Background generation

## Getting started

1. Read the old journal service to see what was generated.
2. Decide whether the deterministic template alone is useful enough for v1.
3. Add a schema migration, generator tests, and a UI state matrix.
4. Keep the feature local-first and explicit.
