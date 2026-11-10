# Contributing to the Pandu registry

The registry is the catalogue behind **Market**. It is intentionally small,
signed, and boring: a YAML file per entry, a signed index that binds every file
by SHA-256, and a signed revocation list. Pandu refuses the whole registry if a
signature or an entry hash does not verify.

This guide is for contributors and reviewers. The runtime model is in
[`docs/market.md`](../market.md), and the threat model is in
[`docs/security.md`](../security.md).

## Before you start

- Read the entry rules and the reviewer checklist below.
- Use a source repository you control. The registry does not host code.
- Pin a full 40-character commit SHA. Branches, tags, short SHAs, and tarball
  URLs are rejected.
- Do not include secrets, tokens, private keys, customer data, or generated
  binaries in the source tree.
- New entries start as **Unreviewed**. Only a reviewer can promote an entry to
  **Community-reviewed** or **Official**.
- The scans are heuristics. A clean report is not a security guarantee.

## Repository layout

```text
registry/
  index.json                  production signed index; binds every entry by SHA-256
  revoked.json                production signed revocation list
  index.test.json             test-signed index for debug builds and tests
  revoked.test.json           test-signed revocation list
  schema/entry.schema.json    JSON Schema for one entry
  skills/<id>.yaml            skill entries
  mcp/<id>.yaml               MCP server entries
  fixtures/<id>/              local trees for `example: true` entries only
  hash.mjs                    prints the normalized content hash
  sign.mjs                    rebuilds and signs either registry variant
```

The registry is designed to move to its own GitHub repository. Keep paths
relative to this directory so the move is a copy, not a rewrite.

## Entry rules

The schema is authoritative. The highlights:

| Field | Rule |
| --- | --- |
| `id` | Lowercase letters, digits, and single hyphens; 2-64 characters. Must match the file name and the index. |
| `kind` | `skill` or `mcp`, and must match the folder. |
| `version` | Your project's version string, at most 40 characters. Changing it is an update. |
| `short_description` | At most 240 characters. Say what it does, not why it is amazing. |
| `long_description` | At most 2,000 characters. Include limits and what the entry does **not** do. |
| `categories` | 1-8 values from the controlled vocabulary: `coding`, `testing`, `security`, `docs`, `devops`, `data`, `design`, `productivity`, `other`. These drive the catalogue filter. |
| `tags` | Optional free-form labels for search and display: at most 12, 1-40 characters each. Tags never become filter categories. |
| `agents` | At least one supported agent id. Do not list an agent you have not tested. |
| `source.repo` | Real entries: exactly `https://github.com/<owner>/<repo>`. Example fixtures: exactly `https://example.invalid/<owner>/<repo>`, a reserved non-registrable host. |
| `source.commit` | Full lowercase 40-character commit SHA. |
| `source.content_sha256` | Hash of the pinned tree, computed with `registry/hash.mjs`. |
| `source.files` | At most 500 paths. This is a review aid, not an install filter: Pandu installs every file in the pinned tree. |
| `license` | SPDX identifier from the allowlist below. |
| `trust` | `unreviewed`, `community-reviewed`, or `official`. |
| `permissions` | At most 16 declarations. Describe what the entry actually does. |
| `readme` | At most 100 KiB. Plain Markdown. Images are not fetched by default. |

SPDX allowlist: `0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`,
`CC-BY-4.0`, `ISC`, `MIT`, `MPL-2.0`, `Unlicense`.

Unknown fields are rejected. A typo does not silently pass.

### Size and path limits

| Limit | Value |
| --- | --- |
| Entry YAML | 256 KiB |
| README | 100 KiB |
| Compressed archive | 20 MiB |
| Extracted tree | 40 MiB |
| Files in a tree | 1,000 |
| One file | 4 MiB |
| `source.files` | 500 paths |
| One path component | 200 characters |
| One archive path | 1,024 characters |
| MCP arguments | 32 arguments, 200 characters each |

Paths must be relative, must not contain `..`, a drive/stream separator, a NUL,
or a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`,
`LPT1`-`LPT9`). Case-colliding paths and links are rejected at install time.

### Skills

A skill entry declares where each agent stores skills:

```yaml
schema_version: 1
id: example-changelog-writer
name: "Changelog Writer"
kind: skill
version: 1.0.0
short_description: Turn merged changes into a player-facing changelog.
long_description: >-
  Groups merged changes into Added, Changed, Fixed, and Removed. Writes text
  only; it never publishes a release or tags a build.
categories: [docs]
tags: [writing, release]
agents: [claude-code, opencode]
source:
  repo: https://github.com/your-name/changelog-writer
  commit: "0123456789abcdef0123456789abcdef01234567"
  content_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
  files:
    - SKILL.md
    - references/voice.md
license: MIT
trust: unreviewed
permissions:
  - id: filesystem:read
    description: Reads the change list the user shares.
skills:
  install:
    - agent: claude-code
      scopes: [user, project]
    - agent: opencode
      scopes: [user, project]
readme: |
  # Changelog Writer

  Turns a list of merged changes into short, player-facing notes.
```

Pandu only writes a skill when the adapter has a verified `[skills]` section.
If it does not, the UI shows manual instructions and writes nothing.

### MCP servers

An MCP entry is a recipe, not a copy of the server. Pandu edits the agent's
configuration and never runs the command.

```yaml
schema_version: 1
id: example-weather
name: "Weather MCP"
kind: mcp
version: 1.0.0
short_description: A read-only MCP server for current conditions.
long_description: >-
  Returns current conditions and a short forecast. Requires a local API key.
categories: [data]
tags: [weather]
agents: [claude-code, codex, opencode]
source:
  repo: https://github.com/your-name/weather-mcp
  commit: "0123456789abcdef0123456789abcdef01234567"
  content_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
license: MIT
trust: unreviewed
permissions:
  - id: network
    description: Calls the weather provider.
  - id: secrets
    description: Needs WEATHER_API_KEY.
mcp:
  transport: stdio
  command: npx
  args: ["-y", "weather-mcp@1.2.3"]
  env: [WEATHER_API_KEY]
  secrets: [WEATHER_API_KEY]
  install:
    - agent: claude-code
      scopes: [user, project]
    - agent: codex
      scopes: [user, project]
    - agent: opencode
      scopes: [user, project]
readme: |
  # Weather MCP

  Requires `WEATHER_API_KEY`. Pandu asks for it locally and writes it only to
  the agent configuration.
```

Rules for MCP entries:

- `transport` is `stdio` or `http`.
- For `stdio`, `command` is a bare executable name (no path, slash, or
  whitespace) and `args` must pin an exact version. `npx`, `bunx`, `pnpx`, and
  `uvx` packages need an exact `name@version` (or `name==version` for `uvx`).
  `latest`, `*`, ranges, tags, and URLs are rejected.
- For `http`, `url` must be `https://`, and `command`/`args` are empty.
- `env` and `secrets` list **names only**. Values are asked for locally at
  install time. They are never stored in the registry, the database, or the
  install manifest.
- `secrets` names the values Pandu asks for. `env` is the full set of names
  the server expects. Both lists must be unique and valid environment names;
  Pandu rejects a duplicate. OpenCode always receives `{env:NAME}` references,
  never a literal secret.
- The exact command and arguments are shown in the install preview, with a
  warning that the agent will execute third-party code when it starts the
  server.

## Compute the content hash

The hash is over the pinned source tree, not the YAML file. It covers every
regular file, sorted by relative path. For each file:

1. the path length as an unsigned 64-bit big-endian integer;
2. the UTF-8 path;
3. the byte length as an unsigned 64-bit big-endian integer;
4. the file bytes.

Empty directories are ignored; links are refused. Run:

```powershell
node registry/hash.mjs path/to/source-tree
```

Paste the 64-character lowercase result into `source.content_sha256`. The
reviewer must confirm that the tree is the one at the pinned commit, not a local
working copy with uncommitted changes.

## Validate locally

Offline (schema, signatures, index hashes, and local example fixtures):

```powershell
cargo run -p pandu-cli -- market check --dir registry
```

Online (also downloads each non-example skill at its pinned commit, verifies the
content hash, and scans every file):

```powershell
cargo run -p pandu-cli -- market check --dir registry --online
```

With link checks:

```powershell
cargo run -p pandu-cli -- market check --dir registry --online --links
```

While your entry is not in the signed index yet, use the staged check. It reads
`skills/*.yaml` and `mcp/*.yaml` directly, validates duplicate ids and the
schema, verifies example fixture hashes, downloads pinned sources, and runs the
static scans. It does **not** make the entry trusted:

```powershell
cargo run -p pandu-cli -- market check --dir registry --staged --online --links
```

CI runs the staged check on pull requests and the signed check on `main` and
`rewrite`. The signed check builds a release binary because release builds
embed the production trust root; debug builds embed the test key and verify the
`.test.json` variant instead.

## Review and signing

A maintainer, not the contributor, updates the signed index. The full key
model, offline generation, rotation, and compromise procedure is in
[`KEYS.md`](KEYS.md).

1. Review the entry and the source tree using the checklist below.
2. Rebuild and sign the index from the YAML files:

   ```powershell
   node registry/sign.mjs --key C:\secure\private.pem --build --dir registry
   ```

   `--build` recomputes every entry hash in `index.json`; the script then signs
   `index.json` and `revoked.json` and verifies the signatures with the public
   key. Keep the private key offline and out of the repository.

3. If you only edited `revoked.json`, or the index was rebuilt by another
   trusted step, sign the existing files with the Rust tool. It refuses a key
   whose public half does not match the embedded key. Run it from a release
   build when signing production; a debug build signs the test variant with the
   test key:

   ```powershell
   cargo run --release -p pandu-cli -- market sign --key C:\secure\private.pem --dir registry
   ```

4. Run the signed check again from a release build:

   ```powershell
   cargo run --release -p pandu-cli -- market check --dir registry --online --links
   ```

5. If a YAML file changed, also regenerate and commit the test variant so
   debug builds and e2e tests load the same entries:

   ```powershell
   node registry/sign.mjs --key C:\secure\test-private.pem --variant test --build --dir registry
   ```

6. Commit the entry, `index.json`, `revoked.json`, `index.test.json`, and
   `revoked.test.json` together. A YAML change without a new index hash is
   rejected by every client.

The private key is never committed, never placed in CI secrets for pull
requests, and never printed. If it is exposed, follow the key-compromise
process in [`KEYS.md`](KEYS.md) and [`SECURITY.md`](../../SECURITY.md).

## Reviewer checklist

Copy this into the review. CI enforces the mechanical items; a human must sign
off on the rest.

### Identity and source

- [ ] The entry id is unique, the file name matches the id, and the folder
      matches the kind.
- [ ] The source repository exists, is owned by the submitter or an accountable
      project, and is the code being described.
- [ ] The commit is a full 40-character SHA, not a branch or tag, and the
      reviewed tree is that commit.
- [ ] `source.files` lists the intended files and no unexpected file is in the
      tree. Remember that Pandu installs the whole tree.
- [ ] The license is on the SPDX allowlist and matches the repository.
- [ ] `source.content_sha256` matches `node registry/hash.mjs` for the pinned
      tree.
- [ ] The README is accurate, does not overclaim, and explains required keys and
      network access.

### Safety and behaviour

- [ ] No `curl|sh`, `wget|sh`, encoded command, or installer that downloads and
      executes code.
- [ ] No large base64 blob, obfuscated payload, or unexplained binary.
- [ ] No access to `.ssh`, `.aws/credentials`, `.npmrc`, `.netrc`, `id_rsa`,
      `credentials.json`, `.gnupg`, or other credential/dotfile paths.
- [ ] No exfiltration host (`webhook.site`, Discord webhooks, `ngrok.io`,
      `transfer.sh`, `pastebin.com`, request bins) or unexplained telemetry.
- [ ] No prompt-injection text ("ignore previous instructions", "reveal the
      system prompt", fake `<system>` tags) aimed at the agent.
- [ ] The declared permissions match the behaviour. A skill that reads files
      declares `filesystem:read`; one that needs a key declares `secrets`.
- [ ] The entry does not ask the agent to disable safety rules, approve itself,
      or modify Pandu.
- [ ] For MCP: the command is a bare executable, the package version is exact,
      the URL is HTTPS, and every environment value is a name, not a value.
- [ ] For MCP: the server's own documentation matches the command and arguments.

### Install, update, and removal

- [ ] The install preview in a disposable home writes only the expected paths.
- [ ] The preview diff is understandable and does not overwrite unrelated keys.
- [ ] The configuration edit preserves comments and unknown keys.
- [ ] Uninstall removes only Pandu-created files and leaves user edits alone.
- [ ] Undo restores the previous state.
- [ ] An update shows the diff against the installed version; it is never
      automatic.
- [ ] The entry does not require a package manager to run during install.
      Pandu only writes files and configuration.

### Tier promotion

- [ ] The reviewer name is real and accountable.
- [ ] `reviewed_on` is the review date.
- [ ] `reviewer.ci_passed` is true and `reviewer.ci_url` points at the run.
- [ ] At least one maintainer approved the change; a second reviewer is required
      for `official`.
- [ ] The entry has been installed, uninstalled, and undone in a disposable
      home, not the reviewer's real home.
- [ ] `example: true` is removed for a real listing. Example fixtures are hidden
      in production and must stay `unreviewed`.

## Revocation and takedown

To revoke an entry, add it to `registry/revoked.json`:

```json
{
  "kind": "skill",
  "id": "example-changelog-writer",
  "reason": "Pinned source now contains an installer that was not reviewed.",
  "revokedOn": "2026-11-09"
}
```

Then sign and publish both files. The client marks an installed copy as
**Revoked**, warns on every refresh, and offers one-click removal. Pandu does
not delete installed files silently. The public process, including the
key-compromise path, is in [`SECURITY.md`](../../SECURITY.md).

## Style

- Write short, concrete descriptions. No marketing copy, emoji, or unverifiable
  claims.
- Prefer ASCII. Unicode is allowed in the README, but keep it readable.
- Do not include screenshots or remote images in the README. They are blocked by
  default and are not part of the review.
- Keep YAML key order stable: identity, descriptions, categories, agents, source,
  license, trust, permissions, kind-specific recipe, README.
- Do not reorder unrelated entries. A focused diff is easier to review.
