# Registry signing keys

Cockpit verifies the market registry with an Ed25519 key embedded in the
binary. The private key never belongs in this repository, a debug build, a
contributor pull request, or an agent transcript. This document covers the two
trust roots, offline key generation, the CI signing flow, rotation, and what to
do if a key is compromised.

## Two trust roots

| | Production | Test |
| --- | --- | --- |
| Public key | `iE0AJlU1Nd+iTodC0vgTYx7aMFCETJisOnFEIsP6hMc=` | `6Zxqlnu7Ci8srz7rzhSxmrnCyyWMZYKNWPMTtXxZloY=` |
| Key id | `cockpit-market-2026` | `cockpit-market-test-2026` |
| Registry files | `registry/index.json`, `registry/revoked.json` | `registry/index.test.json`, `registry/revoked.test.json` |
| Embedded by | release builds | debug and test builds |
| Signing tool | `node registry/sign.mjs` (default variant) | `node registry/sign.mjs --variant test` |
| Rust signer | release `cockpit market sign` | debug `cockpit market sign` |

A release build embeds only the production public key and loads only the
production registry files. A debug or test build embeds only the test public
key and loads only the `.test.json` files. The two key ids and public keys must
stay distinct; `trust_root_error` in
`crates/cockpit-daemon/src/market/mod.rs` refuses to open the market in a
release build that embeds the test key or an unrecognised key.

The test key is a test fixture. Its private half may be used locally to
regenerate the `.test.json` files, but it must never sign a published registry
and must never be copied into a release configuration.

## No private key in the repository

Run these checks before a release and after any key change:

```powershell
git grep -n -I -E "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|BEGIN COCKPIT MARKET SIGNING KEY"
git log --all -S "BEGIN PRIVATE KEY" --oneline
git log --all -S "<first bytes of the private key seed>" --oneline
git rev-list --all --objects | Select-String -Pattern "\.pem$|\.key$"
```

The first command is expected to match only redaction code and test fixtures
that contain fake PEM headers. It must never print a real key body. The `git
log -S` commands must return no commit for the real private seed. The object
listing must not contain a key file. Repeat the search against every remote
before publishing a release; deleting a key in a later commit does not remove
it from history.

## Offline key generation

Generate the production key on an offline machine, not in CI and not on a
developer workstation that runs agents:

```powershell
cargo run --release -p cockpit-cli -- market keygen --out C:\secure\cockpit-market-2026.pem
```

The command prints the public key and writes a 32-byte Ed25519 seed in a
PEM-like wrapper. Keep the private file on encrypted offline media with
permissions for one account only. On Unix:

```sh
chmod 600 /secure/cockpit-market-2026.pem
```

Record the public key in two places:

1. `PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64` and
   `PRODUCTION_REGISTRY_KEY_ID` in
   `crates/cockpit-daemon/src/market/mod.rs`.
2. This document's trust-root table.

Then sign the production registry from a release build (or with the Node
script, which does not depend on the build mode):

```powershell
node registry/sign.mjs --key C:\secure\cockpit-market-2026.pem --build --dir registry
cargo run --release -p cockpit-cli -- market check --dir registry --online --links
```

The signer refuses a key whose public half does not match the key the build
trusts. The Node script prints the public key so it can be compared with the
constant.

### Test key

The test key exists only to keep debug builds and the e2e fixtures independent
of the production key. Generate it once on a development machine, keep it out
of the repository, and regenerate the test registry after any YAML change:

```powershell
node registry/sign.mjs --key C:\secure\cockpit-market-test-2026.pem --variant test --build --dir registry
```

Commit `registry/index.test.json` and `registry/revoked.test.json` together
with the YAML files. Do not commit the test private key. A test build that
loads a production-signed index fails closed; that is the intended separation.

## CI signing flow

Pull requests never receive a signing key:

1. CI runs the staged check, which reads `skills/*.yaml` and `mcp/*.yaml`,
   validates the schema and duplicate ids, verifies example fixture hashes,
   downloads pinned sources, and runs the static scans.
2. A maintainer reviews the entry using the checklist in
   [`CONTRIBUTING.md`](CONTRIBUTING.md).
3. The maintainer signs offline with `registry/sign.mjs` (or a release build's
   `market sign`) and commits the entry plus the signed production index and
   revocation list.
4. CI on the protected branch builds a release binary and runs the signed check
   with that binary. The release binary embeds the production key, so a
   signature made with any other key fails the job.
5. CI also runs the market unit tests in debug mode, which verify the
   test-signed `.test.json` files. This proves that the debug trust root works
   without exposing the production key.

The signed job must not use a debug binary: debug builds trust the test key and
would verify the wrong variant. The workflow uses `cargo run --release` for
that reason.

The production private key is never a pull-request secret. If a protected
environment is used for a release signing job, require manual approval and keep
the key in that environment only for the signing step. Prefer signing offline
and committing only the resulting signature.

## Rotation

A Cockpit build trusts exactly one key id. Rotation is therefore a release
operation:

1. Generate a new keypair offline and choose a new key id, for example
   `cockpit-market-2027`.
2. Update `PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64` and
   `PRODUCTION_REGISTRY_KEY_ID` in the market module, and update this document.
3. Re-sign `index.json` and `revoked.json` with the new key and publish a
   release that embeds the new public key.
4. Publish an advisory naming the old key id, the new key id, and the first
   release that trusts the new key.
5. Keep the old key available only long enough to sign the final registry that
   old clients can still verify. Old clients cannot verify the new key until
   they update, so do not publish a registry signed only with the new key while
   supported old clients still need updates. If an overlap is required, ship a
   release that understands both keys before switching the published registry.
6. After the overlap window, retire the old key and remove it from the build.

Never rotate by editing the published registry alone. The trust root is in the
binary; a registry signed with an unknown key is rejected by every existing
client.

## If a key is compromised

Treat any exposure of the private key as a full compromise, including a copy in
a backup, a chat message, a terminal scrollback, or an agent session.

1. Stop publishing with the compromised key. Do not sign another index with it.
2. Revoke affected entries and publish a revocation list signed by the last
   trusted key, if that key is still safe. If the signing key itself is
   compromised, assume every entry published while it was exposed is suspect.
3. Generate a new keypair offline, assign a new key id, and follow the rotation
   steps above.
4. Publish a security advisory with the old key id, the exposure window, the
   new key id, and the release that trusts it. Tell users to update before
   refreshing the market.
5. Review every entry published during the exposure window: YAML, pinned
   commit, content hash, README, and source tree. Revoke anything that cannot
   be re-verified from a clean machine.
6. Re-sign the index and revocation list with the new key, verify them with the
   release build, and run the signed CI check before publishing.

The test key is not a production signing key. If it leaks, regenerate the
`.test.json` files and the test key constant; no user-facing advisory is
required, but do not reuse the leaked test key for a release.

## Related documents

- [`docs/market.md`](../market.md) — user-facing market model and threat model.
- [`docs/security.md`](../security.md) — security boundaries and verification
  tests.
- [`SECURITY.md`](../../SECURITY.md) — vulnerability reporting and compromise
  response.
- [`docs/registry/CONTRIBUTING.md`](CONTRIBUTING.md) — entry review and signing
  workflow.
