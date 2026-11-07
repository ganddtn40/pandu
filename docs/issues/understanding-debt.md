# Understanding Debt — know what you no longer understand

**Labels:** `help wanted`, `feature`, `area: understanding`, `size: L`
**Status:** Deferred from v0.2.0
**Legacy reference:** `legacy/packages/daemon/src/understanding/service.ts`,
`legacy/packages/core/src/understanding.ts`,
`legacy/apps/web/src/pages/UnderstandingPage.tsx`,
`legacy/apps/web/src/pages/DebtPage.tsx`

## Why

Agents can ship code faster than a person can understand it. The result is
“understanding debt”: code that works but whose owner cannot explain why. A
gentle, optional check can turn a giant diff into one or two questions worth
asking.

This feature is high-risk: done badly it feels like a pop quiz, blocks work, or
shames the user. It must stay optional, short, and easy to dismiss.

## What to build

### Data model

- `understanding_checks`: id, session_id, step_id, question, expected_points
  (JSON), status (`pending`, `answered`, `skipped`), created_at
- `understanding_answers`: id, check_id, answer_md, self_rating
  (`got_it`, `shaky`, `lost`), created_at
- `understanding_debt`: id, project_id, file_path, reason, severity, resolved_at

Debt is derived, not manually maintained: unresolved checks and large
unreviewed diffs contribute.

### Question generation

Start deterministic:

- “What does this function now do?”
- “Which callers depend on this behavior?”
- “What would break if this diff were reverted?”
- “Which test proves this works?”

Limit to two questions per flight and only when the diff is large or touches
risky paths. Never generate a question about a secret or a file the user hid.

### API

- `GET /api/sessions/:id/understanding` — checks for a flight
- `POST /api/understanding/checks/:id/answer` — save an answer and self-rating
- `POST /api/understanding/checks/:id/skip` — skip without penalty
- `GET /api/projects/:id/understanding-debt` — derived debt view
- `POST /api/understanding-debt/:id/resolve` — mark reviewed

### UI

A small card inside Flights detail after a large diff:

- One question at a time
- Text answer or “I've got it” self-rating
- `Skip` always visible
- No timer, no streak, no red badge
- Debt overview inside Settings or Home, never a separate screen

## Acceptance criteria

- [ ] Checks are opt-in in Settings and off by default.
- [ ] At most two checks are generated per flight.
- [ ] `Skip` is always available and never blocks the next flight or approval.
- [ ] No score is shown to anyone else and no telemetry is sent.
- [ ] Questions are based on the actual diff and cite the file/step.
- [ ] Debt is derived from unresolved checks and large diffs, not invented.
- [ ] The UI uses neutral language and no shame/streak mechanics.
- [ ] Unit tests cover question selection and debt calculation.
- [ ] Accessibility: keyboard-only answer and skip, screen-reader labels.

## Non-goals

- Grading answers with an LLM as the only judge
- Blocking merges, commits, or agent runs
- Team dashboards or manager views
- Gamification, streaks, or leaderboards
- A separate top-level Understanding or Debt screen

## Getting started

1. Read the old service and quiz page, then remove anything punitive.
2. Start with the deterministic questions and self-rating only.
3. User-test the tone with three developers before adding generation.
4. Propose the debt formula in this issue.
