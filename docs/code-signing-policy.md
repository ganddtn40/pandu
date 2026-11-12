# Code signing policy

This document explains what Pandu signs, what it does not sign, how the keys
are handled, and how a release is verified. It is written for maintainers and
for anyone who wants to check a download before running it.

## License

Pandu is released under **one** OSI-approved license: the MIT License. See
[`LICENSE`](../LICENSE). There is no dual licensing, no contributor license
agreement that changes the distribution license, and no proprietary add-on in
the release artifacts. Third-party components keep their own licenses and are
listed in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Current state

Windows release artifacts are **unsigned** unless the release notes say an
Authenticode certificate was used. The tag workflow builds the artifacts, writes
`SHA256SUMS`, and creates a draft release. An unsigned build is a supported
outcome, not a failure: the project has not been accepted into a signing
programme yet.

Unsigned does not mean unverified. Every release ships:

- `SHA256SUMS`, generated from the exact files attached to the draft.
- Build provenance attestations for the release assets.
- The source commit and tag that produced the build.

The install guides explain the SmartScreen prompt and how to verify a checksum
before choosing **Run anyway**. Never bypass SmartScreen for a file whose hash
does not match.

## What would be signed

If a certificate is provisioned, the signing scope is:

| Artifact | Signed | Notes |
| --- | --- | --- |
| `Pandu.exe` (standalone) | Yes | The executable inside the portable zip. |
| `Pandu_<version>_x64-setup.exe` (NSIS) | Yes | The installer itself. |
| `Pandu_<version>_x64_en-US.msi` (WiX) | Yes | The installer itself. |
| Portable zip | No | A zip has no Authenticode signature; verify the extracted `Pandu.exe`. |
| CLI archives | No | cargo-dist archives are checksummed, not Authenticode-signed. |
| Android APK | Separate | APK signing uses `apksigner`, never Authenticode. |

The Tauri updater signature is a separate Minisign signature over
`pandu-update.json`. It is not an Authenticode signature and does not make the
installer trusted by Windows. See [`updating.md`](updating.md).

## Signing providers

Two providers are acceptable. Use exactly one path per release.

### SignPath.io (preferred for an open-source project)

SignPath.io offers free code signing for eligible open-source projects through
the SignPath Foundation. The project has **not** been accepted yet. The
attribution placeholder to use after acceptance is:

> Free code signing provided by [SignPath.io](https://signpath.io/), certificate
> by [SignPath Foundation](https://signpath.org/).

Do not publish that attribution, or claim a SignPath-signed release, before an
application has been approved and a real signing request has completed.

The disabled `windows-sign` job in
[`.github/workflows/release.yml`](../.github/workflows/release.yml) is the
starting point. Before enabling it:

1. Replace the placeholder organization id, project slug, signing policy, and
   artifact configuration with the values from the SignPath project.
2. Pin the SignPath action to a reviewed commit SHA.
3. Store `SIGNPATH_API_TOKEN` as a repository or environment secret.
4. Remove the inline PFX signing step from `windows-app`, or keep exactly one
   signing path.
5. Add `windows-sign` to the `release` job's `needs` and download
   `windows-signed` instead of `windows-app`.
6. Run a throwaway tag first. Do not use a production version tag for the first
   signing attempt.

### Azure Trusted Signing

Azure Trusted Signing is an alternative for projects that meet its eligibility
rules. It uses a short-lived certificate issued to the CI identity. The same
rules apply: no private key in the repository, one signing path, timestamping,
and a verification step.

### Authenticode PFX (existing optional step)

The `windows-app` job can sign with a base64 `.pfx` supplied as
`WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`. The workflow
writes the PFX to the runner's temporary directory, signs, and deletes it. This
path is optional and does nothing when the secrets are absent.

A long-lived PFX is the least preferred option. If it is used:

- Keep the certificate in a protected environment with manual approval.
- Never commit the PFX, its password, or a decrypted copy.
- Prefer a hardware token or a cloud signing service over an exportable PFX.
- Rotate the certificate before expiry and publish the new thumbprint.

## Verification

After a signed build, verify the signature on Windows:

```powershell
Get-AuthenticodeSignature .\Pandu_0.2.0_x64-setup.exe | Format-List
```

The status must be `Valid`, the signer must be the expected publisher, and the
timestamp must be present. For an unsigned release the status is
`NotSigned`; that is expected and must match the release notes.

For the APK, use `apksigner verify --verbose --print-certs`. The release
workflow does this before uploading a signed APK.

## Key custody and incident response

- Signing secrets live in GitHub environments with required reviewers, not in
  the repository, a build log, or a developer machine.
- The Android keystore, the Minisign updater key, the registry key, and any
  Authenticode key are separate. Compromise of one must not compromise another.
- If a signing key is suspected compromised: stop releases, revoke or rotate the
  key, publish an advisory, and re-sign affected artifacts with a new key.
  Checksums from the compromised release are no longer trustworthy.
- A test key must never sign a production artifact. The repository's tests and
  release gates reject the test updater and registry keys.

## What signing does not promise

A valid signature means the file was signed by the holder of that certificate
and has not changed since signing. It does not mean the software is free of
bugs, that a particular build is reproducible, or that the publisher's account
was not compromised. Always verify the checksum and read the release notes.
