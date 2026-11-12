# Security policy

Pandu is a local flight recorder and control surface for AI coding agents.
It runs on the user's computer, stores data in a local SQLite database, and can
observe, prompt, and approve activity in a terminal the user started. It is not
a sandbox, an anti-malware product, or a certification.

## Supported versions

| Version | Branch | Security support |
| --- | --- | --- |
| 0.2.x (in progress) | `main` | Yes - the current build |
| 0.1.x | tag `v0.1.0` / `legacy/` | Fixes for confirmed high-severity issues only |
| Older snapshots | any | No |

The security model for the current build is in [`docs/security.md`](docs/security.md).
The market and registry model is in [`docs/market.md`](docs/market.md).

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private
vulnerability reporting:

<https://github.com/ganddtn40/pandu/security/advisories/new>

If private advisories are unavailable, contact the maintainer through the
GitHub profile linked from the repository and ask for a private channel. Do not
send secrets, tokens, private source code, or a working exploit in the first
message; describe the impact and ask how to share evidence.

Please include:

- the Pandu version or commit, the operating system, and whether the build is
  from source or a package;
- the affected surface: daemon HTTP API, remote listener, PTY, proxy, adapters,
  notifications, market/registry, or UI;
- reproduction steps, or a minimal proof of concept with real secrets redacted;
- the impact you believe is possible, and any preconditions (paired device,
  local user, network position, installed market entry);
- whether the issue is already public.

### What to expect

- We aim to acknowledge a report within three business days.
- We will confirm or reject the impact, ask for missing details, and agree on a
  disclosure window. The default coordinated-disclosure target is 90 days; a
  critical issue with active exploitation may be disclosed sooner.
- We will credit the reporter in the advisory unless you ask us not to.
- There is no bug bounty. Do not test against other people's installations,
  devices, or data.

### In scope

- The daemon, CLI, embedded UI, and model proxy.
- Remote access: pairing, tokens, scopes, live sockets, approvals, prompts, and
  the audit chain.
- Market and registry: signature verification, index and revocation handling,
  archive extraction, config edits, install manifests, uninstall, and undo.
- Adapter files and the claims Pandu makes about an agent.
- Anything that lets a remote device, a web page, an agent, or an installed
  market entry cross a boundary described in `docs/security.md`.

### Out of scope

- Vulnerabilities in a third-party agent, MCP server, package, or model provider
  itself. Report those upstream. If Pandu's install or display path makes the
  issue worse, that part is in scope.
- An attacker who already runs code as the same local user. Same-user malware
  can read the database, the agent's environment, and the terminal.
- Denial of service that only affects the reporter's own machine and requires
  local access.
- Social engineering, physical access, and compromised operating systems.
- Missing hardening headers on a static documentation site.

## Registry takedown process

The market registry is security-sensitive: an entry can ask a user to install a
skill or configure an MCP server that the agent will later run. The registry is
designed to live in its own repository; this process applies wherever the signed
`index.json` and `revoked.json` are published.

### If you find a malicious or broken entry

1. Report it privately through the advisory link above, or to the maintainer if
   the registry has moved. Include the entry `id`, `kind`, `version`, the pinned
   `source.repo` and `source.commit`, and the behaviour you observed.
2. Do not install the entry on another machine to "confirm" it. Use a disposable
   home directory and a disposable agent configuration.
3. The maintainer will verify that the report refers to the signed entry, not a
   look-alike, and will reproduce the behaviour in a disposable environment.
4. Confirmed malicious, dangerous, or non-functional entries are added to
   `registry/revoked.json` with a short public reason and a `revokedOn` date.
   The index and revocation list are re-signed with the offline maintainer key
   and published together.
5. Clients that refresh the registry refuse the revoked entry, mark an installed
   copy as **Revoked**, and offer one-click removal. Pandu does not silently
   delete an installed copy; the user confirms the removal.
6. A GitHub security advisory is published for issues that affect users, with
   the entry id, affected versions, and the removal step. The advisory may be
   published before the revocation list propagates so users can act.

Target: a confirmed malicious entry is revoked within 72 hours of verification.
A policy violation that is not immediately dangerous is handled in the next
scheduled registry update.

### If the signing key is compromised

The private key is kept offline and never committed. The full key model,
rotation overlap, and step-by-step compromise procedure is in
[`docs/registry/KEYS.md`](docs/registry/KEYS.md). If it is exposed:

1. Stop publishing with the old key.
2. Generate a new Ed25519 key, embed the new public key in a Pandu release,
   and publish the new key id.
3. Re-sign the index and revocation list with the new key.
4. Publish an advisory that names the old key id and the release that trusts the
   new one. Old clients cannot verify the new key until they update, so the
   advisory must say so plainly.
5. Review every entry published while the old key was exposed. Revoke anything
   that cannot be attributed to a reviewed commit.

### Removing an entry without a revocation

An entry can be removed from `index.json` in a normal update. That hides it from
the catalogue but does not remove an installed copy and does not warn existing
users. Use `revoked.json` when users must act. Removing an entry is appropriate
for a duplicate, a withdrawn project, or a listing that never should have been
published, and the maintainer should still explain the removal in the registry
changelog.

## Safe harbour

We will not pursue legal action against a researcher who follows this policy,
tests only their own installation, avoids privacy violations and service
disruption, and gives us a reasonable chance to fix the issue before disclosure.
