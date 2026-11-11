# Registry signing keys

Pandu verifies the market registry with an Ed25519 key embedded in the
binary. The private key never belongs in this repository, a debug build, a
contributor pull request, CI logs, or an agent transcript. This document covers
the current empty production trust root, offline key generation, the signing
ceremony, CI verification, rotation, and compromise response.

## Current state: the production trust root is empty

No production signing key has been provisioned. `PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64`
in `crates/pandu-daemon/src/market/mod.rs` is `None`, so a release build embeds
no production key and the market fails closed:

- the catalogue is empty and exposes no entries;
- the UI shows **Registry is being prepared.**;
- detail, preview, install, and refresh return HTTP 503;
- installed entries remain listed locally, but updates cannot be checked;
- the test key is **never** used as a fallback. A release configuration that
  embeds the test key is refused.

`registry/index.json` and `registry/revoked.json` carry the production key id
from `brand.json` and an empty signature. They are placeholders until the
maintainer completes the ceremony below. Do not hand-edit the signatures.

## The pre-rename production key is compromised

A production key was generated before the rename. Its private half was not
available during the rename. The repository history does not record the machine,
path, media, or custodian used to generate or store it, so its exact generation
and storage location cannot be confirmed.

Where it did and did not appear:

| Location | Finding |
| --- | --- |
| Repository | No private key material found. History scans match only the PEM header constant, redaction code, and fake test fixtures. No `.pem` or `.key` object exists in any commit. |
| CI configuration | No production signing key or secret is referenced. Pull-request jobs never receive one. |
| Logs | Cannot be confirmed. Historical CI logs and terminal scrollback are not part of the repository and were not reviewed, so they cannot be proven clean. |
| Test fixtures | No. The `.test.json` fixtures are signed with the separate test key, not the production key. |
| Assistant context and tool output | The old production private key did not appear in this session's assistant context or tool output; only its public key did. Earlier agent transcripts were not retained or reviewed, so they cannot be proven clean. |

Because generation, storage, and every log and transcript cannot be confirmed,
**treat the pre-rename production key as compromised.** It is not embedded in
this build and it must never be used again. Do not sign another index with it,
do not restore it from a backup, and do not add its public key back to the
build. The first production release must use a newly generated key.

## Two trust roots

| | Production | Test |
| --- | --- | --- |
| Public key | none yet (release embeds no key) | `BU/+PJwKB5yqebHqAd3lANMGOC3HAAMsfjI0m/U48l8=` |
| Key id | `pandu-market-2026` from `brand.json` | `pandu-market-test-2026` |
| Registry files | `registry/index.json`, `registry/revoked.json` | `registry/index.test.json`, `registry/revoked.test.json` |
| Embedded by | release builds, once provisioned | debug and test builds |
| Signing tool | `node registry/sign.mjs` (default variant) | `node registry/sign.mjs --variant test` |
| Rust signer | release `pandu market sign` | debug `pandu market sign` |

The test key only signs the `.test.json` fixtures. It is a test fixture: never
use it for a published registry, never copy it into a release configuration,
and never let a release build fall back to it. `resolve_trust_root` in
`crates/pandu-daemon/src/market/mod.rs` makes a release build with no key
`Preparing` and a release build with the test key `Refused`.

## No private key in the repository

Run these checks before a release and after any key change:

```powershell
git grep -n -I -E "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|BEGIN PANDU MARKET SIGNING KEY"
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

## Offline key generation ceremony

Perform this on a dedicated offline machine, not in CI and not on a developer
workstation that runs agents. Use a freshly built binary from the tagged commit.

1. Build the CLI on the offline machine and record the source commit:

   ```powershell
   git rev-parse HEAD
   cargo build --release --locked -p pandu-cli
   ```

2. Generate the key into encrypted offline media with restrictive permissions:

   ```powershell
   target\release\pandu.exe market keygen --out E:\secure\pandu-market-2026.pem
   ```

   On Unix:

   ```sh
   chmod 600 /secure/pandu-market-2026.pem
   ```

   The command prints the public key and writes a 32-byte Ed25519 seed in a
   PEM-like wrapper. Record the public key and the source commit in the release
   issue. Never paste the private key into a chat, issue, log, or agent session.

3. On the online checkout, embed the public key and key id:

   - Set `PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64` in
     `crates/pandu-daemon/src/market/mod.rs` to
     `Some("<the printed public key>")`.
   - Confirm `brand.json` `registry.keyId` is the intended production key id
     (`pandu-market-2026` for the first key). Change it only as part of a
     rotation.
   - Update the trust-root table in this document.

4. Copy the registry directory to the offline machine and sign it there:

   ```powershell
   node registry/sign.mjs --key E:\secure\pandu-market-2026.pem --build --dir registry
   ```

   The signer prints the public key. It must match the value embedded in step 3
   and the key id in `brand.json`. The signer refuses a mismatch.

5. Return only the signed JSON files to the online checkout. Commit the public
   key, `registry/index.json`, `registry/revoked.json`, and this document. Never
   commit the private key or a copy of it.

6. Verify the committed result with the production trust root:

   ```powershell
   cargo test -p pandu-daemon --lib market::tests::bundled_production_registry_verifies_with_the_production_key -- --ignored
   cargo run --release --locked -p pandu-cli -- market check --dir registry --online --links
   ```

   The ignored test and the release check must both pass. If either fails, do
   not publish. A release build with no production key fails closed with
   "Registry is being prepared."

### Test key

The test key exists only to keep debug builds and the e2e fixtures independent
of the production key. Generate it once on a development machine, keep it out
of the repository, and regenerate the test registry after any YAML change:

```powershell
node registry/sign.mjs --key C:\secure\pandu-market-test-2026.pem --variant test --build --dir registry
```

Commit `registry/index.test.json` and `registry/revoked.test.json` together
with the YAML files. Do not commit the test private key. A test build that
loads a production-signed index fails closed; that is the intended separation.

## CI and release verification

Pull requests never receive a signing key:

1. CI runs the staged check, which reads `skills/*.yaml` and `mcp/*.yaml`,
   validates the schema and duplicate ids, verifies example fixture hashes,
   downloads pinned sources, and runs the static scans.
2. A maintainer reviews the entry using the checklist in
   [`CONTRIBUTING.md`](CONTRIBUTING.md).
3. The maintainer signs offline with `registry/sign.mjs` (or a release build's
   `market sign`) and commits the entry plus the signed production index and
   revocation list.
4. The release workflow builds a release binary and runs the ignored
   production-key test plus `pandu market check --dir registry`. A missing
   production key, an unsigned index, a stale key id, or a bad signature fails
   the job and blocks publishing.
5. CI also runs the market unit tests in debug mode, which verify the
   test-signed `.test.json` files. This proves that the debug trust root works
   without exposing the production key.

The signed job must not use a debug binary: debug builds trust the test key and
would verify the wrong variant. The workflow uses `--release` for that reason.

The production private key is never a pull-request secret. If a protected
environment is used for a release signing job, require manual approval and keep
the key in that environment only for the signing step. Prefer signing offline
and committing only the resulting signature.

## Rotation

A Pandu build trusts exactly one key id. Rotation is therefore a release
operation:

1. Generate a new keypair offline and choose a new key id, for example
   `pandu-market-2027`.
2. Update `PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64` in the market module,
   `brand.json` `registry.keyId`, and this document.
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

- [`docs/market.md`](../market.md) - user-facing market model and threat model.
- [`docs/security.md`](../security.md) - security boundaries and verification
  tests.
- [`SECURITY.md`](../../SECURITY.md) - vulnerability reporting and compromise
  response.
- [`docs/registry/CONTRIBUTING.md`](CONTRIBUTING.md) - entry review and signing
  workflow.
