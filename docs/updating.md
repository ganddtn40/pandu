# Updating Pandu

Pandu can tell you when a new version is available. It never installs an update
without you asking, and it never downloads a build it cannot verify.

This guide is for everyone. If you only use the desktop app, read the first two
sections. If you use the command line, read the CLI section too.

## What Pandu checks

On launch and at most once every 24 hours, Pandu asks GitHub for the newest
release of the repository named in `brand.json`. The request is a single HTTPS
`GET`. It sends no account token, no machine identifier, and no usage data.

- If you are offline, the check fails silently and Pandu keeps working.
- If the repository is not public yet, Pandu says updates are unavailable and
  does not retry in a loop.
- If GitHub asks clients to slow down, Pandu waits and tells you when it will
  try again.
- You can turn automatic checks off in **Settings → Updates**. **Check now**
  still works when you ask for it.

An update check only reports a version and its release notes. Release notes are
cleaned before they appear: HTML is removed and remote images are not loaded.

## The update card

When a newer stable version exists, the Home screen shows a card with the
version and the release highlights.

- **Update now** does not install anything by itself. It shows the exact
  command to run, with a copy button, so you stay in control.
- **Remind me later** offers three choices:
  - **Tomorrow** hides the card until tomorrow.
  - **In one week** hides the card for seven days.
  - **Skip this version** hides this version until a newer one is published.
- Snoozes and skips are stored by the local daemon, so they survive a restart.

The same information is in **Settings → Updates**, including the current
version, the latest version, the release notes, the channel, and whether this
build can verify signatures.

## Updating with the CLI

Stop Pandu before replacing the binary, then run:

```powershell
pandu update --check
```

This only checks. It prints the current version, the latest version, the
channel, and the release notes. To download and install a verified update:

```powershell
pandu update
```

Pandu verifies all of the following before it touches the binary:

1. The download URL uses HTTPS.
2. The release has a signed `pandu-update.json` manifest.
3. The manifest is signed by the updater key compiled into your build.
4. The manifest is for the `stable` channel and the same key id.
5. The manifest has not expired.
6. The manifest's sequence is newer than the last update you installed.
7. The artifact's SHA-256 matches the manifest.
8. The artifact's Minisign signature matches the manifest.
9. The new version is newer than the version you are running.

If any check fails, Pandu stops and installs nothing. It also refuses to
downgrade, even if a release feed points at an older tag. The expiry and
sequence checks stop an attacker from replaying an old signed release, for
example after you roll back to a previous version.

The sequence is recorded in `pandu-update-state.json` in your Pandu home only
after a verified update is installed. If that file is damaged, the updater
fails closed instead of silently accepting a replayed manifest.

The previous binary is kept next to the new one for one version. If the new
build does not start, run:

```powershell
pandu rollback
```

That restores the previous binary. Start Pandu again to use it.

### While agents are running

`pandu update` does not stop Pandu-owned PTY sessions. Before it replaces the
binary it asks the local daemon which sessions are active, lists them by title
and agent, and asks you to confirm. In a terminal you can answer `y`; in a
script or another non-interactive shell it refuses unless you pass `--yes`.

```powershell
pandu update --yes
```

The sessions keep running the old build until they exit, and the proxy stays
available. On Windows the running binary may block replacement; if that
happens, Pandu stops without installing anything. Close the sessions and run
the command again.

### If the updater is not ready

A release build only trusts a production updater key. While the maintainer has
not embedded one, the build says:

> Updates are not available in this build because no production updater key is
> embedded.

That is intentional. A build without a production key fails closed and never
falls back to the test key used by debug builds and fixtures.

## Android

Pandu does not install APKs silently. When the Android app ships, it will:

1. Download the APK over HTTPS.
2. Check its SHA-256 against the signed release manifest.
3. Check the APK signer certificate.
4. Hand the verified file to the Android system installer.

You confirm the install in the system dialog. If you prefer a store-like
updater, [Obtainium](https://github.com/ImranR98/Obtainium) can follow the
GitHub releases for this repository and perform its own verification.

## Desktop app

The desktop shell is not part of this build yet. When it ships, it will use the
same signed manifest, the same production updater key, and the same rule: show
the update, ask first, never install silently. It will not have a second trust
root.

## Your data is separate from the app

Updating or uninstalling Pandu does not delete your flights, settings, or
database. They live in your user data directory, outside the application
folder. See [`data-safety.md`](data-safety.md) for the exact paths, backups, and
how to remove data deliberately.

## Troubleshooting

**"The update manifest failed verification."**
The download was altered, the key id is wrong, or the release was signed with a
different key. Do not install it. Report the release.

**"Refusing to downgrade."**
The newest published tag is older than your build. This usually means a
prerelease or a mistaken tag. Stay on your current version.

**"This release has no signed update manifest."**
The release is missing `pandu-update.json`. Ask the maintainer to sign and
upload it.

**"The update manifest expired."**
The signed manifest is past its `expires` time. This is normal for an old
release. Ask the maintainer for a freshly signed manifest; do not bypass the
check.

**"Refusing to replay an old release."**
The manifest sequence is not newer than the last update this installation
accepted. Either the release feed is serving an old manifest, or someone is
replaying one. If you rolled back on purpose, the next update must carry a
higher sequence than the one you installed before.

**Permission denied while replacing the binary.**
Stop every Pandu process, then run the command again. On Windows, an open
terminal in the install folder can also hold the file.

**The new version will not start.**
Run `pandu rollback`, then report the problem with the output of
`pandu doctor`.
