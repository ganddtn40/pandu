# Context Doctor — see what is eating the context window

**Labels:** `help wanted`, `feature`, `area: context`, `size: M`
**Status:** Deferred from v0.2.0
**Legacy reference:** `legacy/packages/daemon/src/context/doctor.ts`,
`legacy/packages/core/src/context.ts`,
`legacy/apps/web/src/pages/ContextPage.tsx`

## Why

Long flights get expensive and forgetful because the context window fills with
duplicated files, stale tool output, and oversized prompts. Context Doctor shows
where the tokens went and suggests concrete trims, without changing the agent's
behavior automatically.

## What to build

### Analysis

For a recorded proxy flight, break the request context into:

- System/developer instructions
- Conversation history
- Tool results
- Retrieved/file content
- Current user prompt
- Unknown/other

Report token counts and percentages using the provider's tokenizer when
available, or a conservative estimate with a visible `estimated` label.

Detect:

- The same file included more than once
- Tool output over a configurable threshold
- Very long system prompts
- Context that grows every turn without pruning
- Near-limit requests

### Data model

- `context_insights`: id, session_id, step_id, kind, severity, message,
  estimated_savings_tokens, paths (JSON), created_at

Insights are derived from stored requests. Do not store a second copy of the
prompt.

### API

- `GET /api/sessions/:id/context` — per-step breakdown and insights
- `POST /api/sessions/:id/context/analyze` — recompute insights
- `GET /api/context/insights/:id` — detail with source links

### UI

A Context panel inside Flights detail:

- Stacked bar of context composition per step
- Insight cards with “why this matters” and “what to try”
- Link to the step that produced it
- Copy a suggested fix (for example, a `.gitignore` or prompt change)
- `Try demo` empty state

## Acceptance criteria

- [ ] Composition is shown per step with token counts and percentages.
- [ ] Estimates are clearly labeled and never presented as exact.
- [ ] Insights cite the step and file paths that caused them.
- [ ] The analysis is read-only and never rewrites a prompt or request.
- [ ] Duplicate-file and oversized-tool-output detection have fixture tests.
- [ ] Provider tokenizer differences are documented; unknown models fall back
      to an estimate.
- [ ] No network call is required for analysis.
- [ ] UI works at 1440×900 and 390×844, light and dark.

## Non-goals

- Automatically pruning or rewriting context
- Sending prompts to an external analyzer
- A separate top-level Context screen
- Exact tokenizer parity for every model
- Blaming the user with scores or grades

## Getting started

1. Read the old Context Doctor for the insight shapes.
2. Build the read-only analyzer against recorded fixtures first.
3. Add the stacked bar only after the numbers are trustworthy.
4. Propose the token-estimation strategy in this issue.
