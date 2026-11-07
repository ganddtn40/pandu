# Project Brain — a local, searchable memory of the repository

**Labels:** `help wanted`, `feature`, `area: brain`, `size: L`
**Status:** Deferred from v0.2.0
**Legacy reference:** `legacy/packages/daemon/src/brain/service.ts`,
`legacy/packages/core/src/brain.ts`,
`legacy/apps/web/src/pages/BrainPage.tsx`

## Why

Agents repeatedly rediscover the same project facts: architecture, conventions,
commands, owners, known traps. A local Project Brain can answer “where is auth
handled?” or “what commands does CI run?” and produce a compact context pack for
the next flight.

It must be local, inspectable, and correctable. A wrong brain is worse than no
brain.

## What to build

### Data model

- `brain_sources`: id, project_id, path, kind (`doc`, `code`, `adr`, `config`),
  checksum, indexed_at
- `brain_chunks`: id, source_id, ordinal, text, token_count
- `brain_facts`: id, project_id, key, value, confidence, source_ids (JSON),
  verified_by_user, updated_at
- SQLite FTS5 virtual table over chunks for local search

### Indexing

- Index only files the user selects, defaulting to docs, READMEs, ADRs, and
  config manifests.
- Never index `.env`, key files, `node_modules`, build output, or files matched
  by a deny list.
- Respect `.gitignore` by default.
- Store checksums and re-index incrementally.
- Hard caps on file size and total index size, configurable in Settings.

### API

- `POST /api/projects/:id/brain/index` — start or refresh indexing
- `GET /api/projects/:id/brain/status` — progress, counts, errors
- `GET /api/projects/:id/brain/search?q=` — local search results with citations
- `GET /api/projects/:id/brain/context?task=` — build a context pack
- `PATCH /api/brain/facts/:id` — correct a fact
- `DELETE /api/projects/:id/brain` — delete the index

### UI

A Project Brain panel inside Flights/Settings, not a fifth screen:

- Index status and size
- Search with file citations
- Fact list with “correct this” action
- Copy context pack
- Clear warning that this is local only

## Acceptance criteria

- [ ] Indexing is opt-in per project and shows exactly which paths will be read.
- [ ] Secrets and ignored files are excluded by default; tests cover `.env`,
      private keys, and `node_modules`.
- [ ] Search returns cited results from local FTS5 only.
- [ ] A context pack fits a user-selected token budget and lists its sources.
- [ ] Users can correct or delete any stored fact.
- [ ] Deleting the index removes all chunks and facts for the project.
- [ ] No network call and no embedding service is required.
- [ ] Incremental re-index does not duplicate chunks.
- [ ] Unit tests cover deny lists, caps, and citation formatting.

## Non-goals

- Sending code to a remote embedding provider by default
- Autonomous code modification
- Cross-project or team memory
- Replacing the agent's own context management
- A separate top-level Brain screen

## Getting started

1. Read the old brain service for the data shape, not the UX.
2. Start with FTS5; embeddings are optional and later.
3. Build the deny list and tests before the indexer.
4. Propose the context-pack format in this issue.
