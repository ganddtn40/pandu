# Registry seed report — Phase 8b

- **Date:** 2026-11-10
- **Branch:** `rewrite`
- **Scope:** seed the Market registry with real, primary-source-verified entries
- **Signing:** test key only (`pandu-market-test-2026`)
- **Result:** 22 entries (11 skills, 8 MCP servers, 3 example fixtures) pass the
  staged and signed online checks

This report records every candidate, what was published, what was held back,
and the evidence behind each field. A clean scan is not a security guarantee;
the reviewer still has to read the source.

## Method

For every source repository:

1. Resolved the pinned commit with `git ls-remote` or the release tag's peeled
   commit. Branches, short SHAs, and tarball URLs are never used.
2. Downloaded the pinned tree from `codeload.github.com` and computed the
   normalized whole-tree SHA-256 used by `source.content_sha256`.
3. Fetched the license evidence at that commit and confirmed the SPDX id.
4. For skills, confirmed each candidate has its own `LICENSE.txt`, validated
   `SKILL.md` frontmatter (`name` 1–64 characters, lowercase letters, digits,
   and hyphens; `name` equals the folder name; `description` present), and
   generated the exact `source.files` list from the tree.
5. For MCP servers, verified the npm/PyPI package name, exact version,
   integrity or wheel hash, and that the package's repository points at the
   vendor repository. The Docker entry uses the GHCR manifest digest.
6. Verified the current agent documentation for skill folders and MCP config
   paths before writing any target.

### Whole-tree hashes

| Repository | Commit | Files | Bytes | Normalized SHA-256 |
| --- | --- | ---: | ---: | --- |
| `anthropics/skills` | `2c5958ecac7cee2b583967a2c4981d0f4a75c579` | 446 | 11,969,368 | `da39d89a6fe60aac12400b53ff6636868216f1578422d7cd10c1ae8e7c95c37c` |
| `modelcontextprotocol/servers` | `36380287ed3b15d115b55f546617d723072b1296` | 390 | 4,769,893 | `8361f866c514c80d70c196430874ff45bdae143dfc7a5b0ad8e145e535b62d19` |
| `github/github-mcp-server` | `4bcdcdf8d7beee98c9448e73e257308280924cc4` | 667 | 7,026,861 | `d1430c8a295eabb2646d3fd7e7d7e506a197ffe48d7a482478f6243a45ac889c` |
| `microsoft/playwright-mcp` | `4e0794dd0a0176519830a5ed27b491137cf9338f` | 45 | 274,575 | `8f573529e0ebcb84822236a6ceb629cfeec4d6fc8f7dab0992973a7fe28d53fa` |
| `upstash/context7` | `6e68ffcbad0e23cf4fa8c11795ce9e551aeef19b` | 618 | 27,278,492 | `a56b31dba74d5005dba7f3f636ab6fce0403f3d1055c6e314b55703d20baedec` |

All five trees were checked for symlinks, non-ASCII paths, and case
collisions; none were found. All are within the file-count and extracted-size
limits. The Context7 tarball is 22,165,493 bytes compressed, above the 20 MiB
archive limit, but MCP entries do not download a tree during `market check`;
the whole-tree hash is reviewer evidence.

## Published entries

Every published entry is `trust: official`, reviewer `Pandu maintainers`,
`reviewed_on: 2026-11-10`, `ci_passed: true`. All sources are vendor-owned
repositories. The test-signed index is not a production promotion; production
signing still requires the human checklist in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

### Skills (11)

All skill entries share the `anthropics/skills` repository, commit
`2c5958ecac7cee2b583967a2c4981d0f4a75c579`, and whole-tree hash
`da39d89a…c95c37c`. The `version` field is the short commit `2c5958e` because
the repository has no release tags and no per-skill version. Each entry installs
only its own folder under `skills/<id>` for Claude Code, Codex, and OpenCode,
at user and project scope.

| Entry | License | License evidence | Files in skill folder |
| --- | --- | --- | ---: |
| `algorithmic-art` | Apache-2.0 | `skills/algorithmic-art/LICENSE.txt` | 4 |
| `brand-guidelines` | Apache-2.0 | `skills/brand-guidelines/LICENSE.txt` | 2 |
| `canvas-design` | Apache-2.0 | `skills/canvas-design/LICENSE.txt`; bundled fonts keep their own OFL files under `canvas-fonts/` | 83 |
| `frontend-design` | Apache-2.0 | `skills/frontend-design/LICENSE.txt` | 2 |
| `internal-comms` | Apache-2.0 | `skills/internal-comms/LICENSE.txt` | 6 |
| `mcp-builder` | Apache-2.0 | `skills/mcp-builder/LICENSE.txt` | 11 |
| `skill-creator` | Apache-2.0 | `skills/skill-creator/LICENSE.txt` | 18 |
| `slack-gif-creator` | Apache-2.0 | `skills/slack-gif-creator/LICENSE.txt` | 7 |
| `theme-factory` | Apache-2.0 | `skills/theme-factory/LICENSE.txt` | 13 |
| `web-artifacts-builder` | Apache-2.0 | `skills/web-artifacts-builder/LICENSE.txt` | 5 |
| `webapp-testing` | Apache-2.0 | `skills/webapp-testing/LICENSE.txt` | 6 |

`claude-api` is held back; see [Candidate outcomes](#candidate-outcomes).

### MCP servers (8)

MCP entries write configuration only. Pandu never runs the package manager,
the container, or the server during install. Environment values are recorded as
names; no secret is stored in the registry.

| Entry | Version | Transport / command | License | License evidence |
| --- | --- | --- | --- | --- |
| `sequential-thinking` | 2.1.1 | `npx -y @modelcontextprotocol/server-sequential-thinking@2.1.1` | MIT | `src/sequentialthinking/README.md` states MIT |
| `fetch` | 2026.11.4 | `uvx mcp-server-fetch==2026.11.4` | MIT | `src/fetch/LICENSE` |
| `git` | 2026.11.4 | `uvx mcp-server-git==2026.11.4` | MIT | `src/git/LICENSE` |
| `time` | 2026.11.4 | `uvx mcp-server-time==2026.11.4` | MIT | `src/time/pyproject.toml` declares MIT |
| `playwright` | 0.0.85 | `npx -y @playwright/mcp@0.0.85` | Apache-2.0 | `LICENSE`; `package.json` |
| `context7` | 4.6.0 | `npx -y @upstash/context7-mcp@4.6.0` | MIT | `LICENSE`, `packages/mcp/LICENSE` |
| `github-mcp-remote` | 2.1.0 | HTTPS `https://api.githubcopilot.com/mcp/` | MIT | `LICENSE` |
| `github-mcp-server` | 2.1.0 | `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server@sha256:f6056fc…e0f8a` | MIT | `LICENSE` |

Package pins verified this session:

- npm `@modelcontextprotocol/server-sequential-thinking@2.1.1`,
  integrity `sha512-yvj9eotCoXX7BLmyOKdajnCYB5vgeCS3YwtEU0wCIcVgl+xvCdBtjkd0CTA45Ljh2+Iv1538n28VAnrstps1Tg==`
- npm `@playwright/mcp@0.0.85`,
  integrity `sha512-bSfECMbLXhJdWkGhLzNMxTZuazG+9IDJ679gflji3yyD94e7ARnGdqmJmG6lTPB+gYX+OiFLmX5myBl62+wZEw==`
- npm `@upstash/context7-mcp@4.6.0`,
  integrity `sha512-V/ve0WbDojzajy7ZwHVi3MRxujeyqvzX1uGO9QZSXuD+WUe2swll1OB3Mv+kI9ZU6fMFkbUM9MUgBA+Hc1j2tA==`
- PyPI `mcp-server-fetch==2026.11.4`, wheel
  `7c5891e3d3e3ea7d2d8c21acb9c64ccd30ff1f42beeea59f95715637b970307d`
- PyPI `mcp-server-git==2026.11.4`, wheel
  `0cdaa8f446554d020f8ffa0e44ef45b89df4ed4deaeb961b4305d8a2852b4e0e`
- PyPI `mcp-server-time==2026.11.4`, wheel
  `536388fc6f19adec845f0d3a194d696aca3260a626c041cb97a9988e1a18444a`
- GHCR `ghcr.io/github/github-mcp-server:v2.1.0`, digest
  `sha256:f6056fc10bfffcc8c81a6417a2e9ca12808647e8dd6049642a4feaadee0e0f8a`
  (`v2.1.0`, `2.1.0`, and `latest` resolved to the same digest)

## Candidate outcomes

### Skills

| Candidate | Outcome | Reason |
| --- | --- | --- |
| `algorithmic-art` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `brand-guidelines` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `canvas-design` | Published | Apache-2.0 `LICENSE.txt`; bundled OFL fonts carry their own licenses |
| `claude-api` | **Held back** | The installed folder trips the conservative scanner: `shared/evals/report/build-report-lite.mjs` and `shared/evals/report/runner-scaffold.mjs` mention `~/.ssh/id_rsa` in comments, and `shared/managed-agents-onboarding-from-url.md` contains `curl | sh` inside a warning. These look like false positives, but the registry has no waiver mechanism. |
| `frontend-design` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `internal-comms` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `mcp-builder` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `skill-creator` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid. The scanner's `eval(` rule was narrowed to a word boundary so `run_eval(` no longer false-positives. |
| `slack-gif-creator` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `theme-factory` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `web-artifacts-builder` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `webapp-testing` | Published | Apache-2.0 `LICENSE.txt`; frontmatter valid |
| `doc-coauthoring` | Excluded | No `LICENSE.txt` in the skill folder |
| `docx` | Excluded | Proprietary license terms; not on the SPDX allowlist |
| `pdf` | Excluded | Proprietary license terms; not on the SPDX allowlist |
| `pptx` | Excluded | Proprietary license terms; not on the SPDX allowlist |
| `xlsx` | Excluded | Proprietary license terms; not on the SPDX allowlist |

### MCP

| Candidate | Outcome | Reason |
| --- | --- | --- |
| `sequential-thinking` | Published | MIT stated in the server README; npm package pinned to 2.1.1 |
| `fetch` | Published | MIT `src/fetch/LICENSE`; PyPI pinned to 2026.11.4 |
| `git` | Published | MIT `src/git/LICENSE`; PyPI pinned to 2026.11.4. Entry warns that every tool takes `repo_path`, so the server can reach any repository the agent process can read. |
| `time` | Published | MIT declared in `src/time/pyproject.toml`; PyPI pinned to 2026.11.4 |
| `playwright` | Published | Apache-2.0 `LICENSE`; npm pinned to 0.0.85. Browser binaries must already be installed. |
| `context7` | Published | MIT `LICENSE` and `packages/mcp/LICENSE`; npm pinned to 4.6.0. The stdio package works without an API key. |
| `github-mcp-remote` | Published | MIT `LICENSE`; HTTPS URL. The agent authenticates with GitHub OAuth; a PAT header is documented as a manual option because the HTTP recipe has no header field. |
| `github-mcp-server` | Published | MIT `LICENSE`; GHCR image pinned by digest. Requires Docker and `GITHUB_PERSONAL_ACCESS_TOKEN`. |
| `filesystem` | Excluded | Requires a user-chosen allowed-directory argument; the registry has no per-install argument input |
| `memory` | Excluded | Requires an absolute `MEMORY_FILE_PATH`; non-secret env values are not rendered for Claude Code or OpenCode |
| `everything` | Excluded | Demo/test server with an intentionally broad tool surface; not a production install |
| `github` (archived server) | Excluded | Archived upstream |
| `sqlite` (archived server) | Excluded | Archived upstream |
| `aws-kb-retrieval` (archived server) | Excluded | Archived upstream |
| `obra/superpowers` | Deferred | Third-party project, not vendor-owned; needs its own review |

## Target verification

Checked on 2026-11-10 against the current vendor documentation:

| Agent | Skills | MCP |
| --- | --- | --- |
| **Claude Code** | `~/.claude/skills`, `.claude/skills` | Project `.mcp.json` or `claude mcp add`. Pandu never writes `~/.claude.json` because it also holds Claude Code app state. |
| **Codex CLI** | `~/.agents/skills`, `.agents/skills`; Codex also reads ancestor `.agents/skills` and admin `/etc/codex/skills` | `~/.codex/config.toml`, `.codex/config.toml` under `[mcp_servers.<name>]` |
| **OpenCode** | `~/.config/opencode/skills`, `.opencode/skills`; compatibility paths `~/.claude/skills`, `~/.agents/skills`, `.claude/skills`, `.agents/skills` | `mcp.servers` in `opencode.json` / `opencode.jsonc` |

The Codex `[skills]` section was added to `adapters/codex.toml` in this phase
and is marked `verified = true`. The target table in `docs/market.md` was
updated to match.

## Registry check changes

Two scanner fixes were required before the seed could pass:

1. **Scan only the installed skill subdirectory.** A skill entry that installs
   `skills/<id>` no longer scans unrelated folders in the same monorepo. The
   whole archive is still bound by `source.content_sha256`. Regression tests:
   `scans_only_the_installed_skill_subdir` and
   `scans_the_whole_tree_when_no_subdir_is_selected`.
2. **Match `eval(` only at a word boundary.** `run_eval(` in
   `skill-creator` was being reported as an encoded command. Regression test:
   `static_scan_catches_encoded_commands_without_matching_function_names`.

## Checks run

```text
cargo run -q -p pandu-cli -- market check --dir registry --staged
# before claude-api was held back
registry: 23 entries checked, 3 downloaded, OK
# final staged registry
registry: 22 entries checked, 3 downloaded, OK

cargo run -q -p pandu-cli -- market check --dir registry --staged --online
registry: 22 entries checked, 14 downloaded, OK

node registry/sign.mjs --key <test-key> --variant test --build --dir registry
public key: 6Zxqlnu7Ci8srz7rzhSxmrnCyyWMZYKNWPMTtXxZloY=
signed registry\index.test.json
signed registry\revoked.test.json

cargo run -q -p pandu-cli -- market check --dir registry --online
registry: 22 entries checked, 14 downloaded, OK
```

The staged check was run once with 23 entries before `claude-api` was held
back. The signed check uses the debug-build test index (`index.test.json`) and
the test key id `pandu-market-test-2026`.

## Signing and release status

- The test index and revocation list are signed with the test key. The public
  key matches `TEST_REGISTRY_PUBLIC_KEY_BASE64` in
  `crates/pandu-daemon/src/market/mod.rs`.
- No private key is in the repository. The production index and revocation
  list were not signed in this phase.
- A release build rejects the test key by design
  (`trust_root_error`), so these entries cannot ship in a release until they
  are reviewed and signed with the production key.

## Known gaps and manual instructions

- **GitHub remote:** OAuth works through the agent. A personal access token
  needs a custom `Authorization` header, which the registry HTTP recipe cannot
  express; the entry documents it as a manual step.
- **Context7 remote:** the remote URL requires an `Authorization: Bearer`
  header. Use the pinned stdio package instead; Pandu writes that command.
- **Playwright:** the package does not install browser binaries. Run the
  Playwright install step once on the machine before enabling the server.
- **GitHub Docker:** Docker must be installed and running, and the token is
  requested at install time and written to the agent configuration. It is not
  stored in the install manifest.
- **Git:** without `--repository`, each tool takes `repo_path`, so the server
  can reach any repository the agent process can read. The entry warns about
  this scope.
- **Skill versions:** `anthropics/skills` has no tags, so the version is the
  pinned short commit. The full commit remains in `source.commit`.
- **MCP source trees:** `market check` verifies skill trees only. MCP package
  and image facts were verified against npm, PyPI, and GHCR this session; the
  whole-tree hashes are recorded for review but are not fetched by the check.
- **`claude-api`:** held back pending a reviewer decision on the three scanner
  findings above. The rest of the skill is verified and ready to publish once
  the gate can represent an accepted false positive.

## Sources

Retrieved 2026-11-10:

- <https://github.com/anthropics/skills>
- <https://github.com/modelcontextprotocol/servers>
- <https://github.com/github/github-mcp-server>
- <https://github.com/microsoft/playwright-mcp>
- <https://github.com/upstash/context7>
- <https://docs.claude.com/en/docs/claude-code/skills>
- <https://docs.claude.com/en/docs/claude-code/mcp>
- <https://developers.openai.com/codex/skills.md>
- <https://developers.openai.com/codex/mcp>
- <https://opencode.ai/docs/skills>
- <https://opencode.ai/docs/mcp-servers>
- npm registry metadata for the three pinned npm packages
- PyPI JSON metadata for the three pinned Python packages
- GHCR manifest metadata for `ghcr.io/github/github-mcp-server:v2.1.0`
