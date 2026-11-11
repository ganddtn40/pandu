# Data safety

Pandu records flights, settings, and agent events on your machine. This page
explains where that data lives, what an update or uninstall does to it, and how
to back it up or remove it.

## The short version

- Your data lives outside the application folder, in your user directory.
- Installing, updating, rolling back, or uninstalling Pandu does not delete it.
- Deleting data is always an explicit choice.
- `pandu backup` writes one archive of the database and settings. Secrets and
  remote device tokens are left out by default.
- A failed migration restores its automatic backup.

## Where your data lives

The default home is `~/.pandu/v2` on Windows, macOS, and Linux. That is:

| Platform | Default path |
| --- | --- |
| Windows | `C:\Users\<you>\.pandu\v2` |
| macOS | `/Users/<you>/.pandu/v2` |
| Linux | `/home/<you>/.pandu/v2` |

Set `PANDU_HOME` to use a different directory. The `--home` flag does the same
for a single command.

Inside the home directory:

| Path | What it is |
| --- | --- |
| `pandu.db` | Flights, steps, tool calls, settings, and remote device records |
| `pandu.db-wal`, `pandu.db-shm` | SQLite write-ahead log and shared memory |
| `pandu.db.bak-<time>-v<n>` | Automatic backup taken before a schema migration |
| `backups/` | Archives written by `pandu backup` |
| `snapshots/` | Workspace snapshots |
| `adapters/` | Your local agent adapter definitions |
| `remote-tls/` | Certificates for remote access, when enabled |
| `market/` | Market cache, installed entries, journals, and backups |

The database is the source of truth for flights and settings. Deleting the
folder removes everything above; back it up first if you want to keep it.

## What an update changes

An update replaces the Pandu binary or app bundle. It does not write into your
home directory, except for the normal database writes the running app already
makes. It does not rewrite settings, and it does not clear flights.

`pandu update` keeps the previous binary for one version. `pandu rollback`
swaps it back. Neither command touches `pandu.db`.

## What an uninstall changes

The desktop installers are not part of this build yet. When the MSI and NSIS
bundles ship, their uninstallers must keep user data by default:

- The uninstaller removes only files it installed.
- `~/.pandu/v2` stays in place.
- A separate, unchecked checkbox is required to delete data. The default is to
  keep it.
- The same rule applies to the macOS `.dmg` and the Linux packages.

This is a release requirement, not an optional setting. There is no MSI or NSIS
bundle in this repository yet, so there is nothing to uninstall and no
installer test to run. The packaging manifest already declares the data
directory as `.pandu`, outside the application folder. Do not add an
uninstaller action that deletes it.

The Android app follows the same rule: uninstalling the app removes the APK,
not your exported backups. Android may remove app-private storage when you
uninstall, so keep an exported backup if you need the data.

## Backups

Create one archive of the database and settings:

```powershell
pandu backup
```

The default output is
`<home>/backups/pandu-backup-<timestamp>.tar.gz`. The archive contains:

- `manifest.json` — format version, schema version, timestamp, and counts
- `settings.json` — non-secret settings
- `pandu.db` — a consistent copy made with the SQLite backup API

The database holds your flight history: prompts, responses, tool output, and
code snapshots. It is not a metadata-only export. Treat every archive as
private even though secret settings and remote tokens are filtered out.

The host UI can create the same unencrypted archive from Settings → Backup and
restore, and can open the data or backup folder. Those actions exist only on the
host listener and require the CSRF token; a paired device cannot call them.

Settings whose names look like tokens, passwords, credentials, API keys,
private keys, pairing codes, or PIN hashes are always excluded. Remote device
tokens are excluded by default. To include them:

```powershell
pandu backup --include-remote
```

Pandu warns you when you do this. The archive then contains pairing material;
keep it private and delete it when you no longer need it.

Pandu creates every archive readable only by your user account: mode `0600` on
Unix and an owner-only ACL on Windows. On Windows the ACL is set with `icacls`;
if it cannot be applied, Pandu deletes the archive and reports the failure.

### Encrypting a backup

Pass `--encrypt` to protect the archive with a passphrase:

```powershell
pandu backup --encrypt
```

Pandu prompts for the passphrase twice. For scripts, set
`PANDU_BACKUP_PASSPHRASE` instead; the value never appears in argv or logs. The
archive is encrypted with XChaCha20-Poly1305 (streaming AEAD) and a 32-byte key
derived with Argon2id (64 MiB memory, 3 iterations, 1 lane). The header stores
only the KDF parameters, a random salt, and a random nonce. The file name ends
in `.tar.gz.enc`.

```powershell
pandu restore .\backups\pandu-backup-20261111T090000Z.tar.gz.enc
```

Restore prompts for the passphrase when the archive is encrypted. A wrong
passphrase fails authentication before any database file is replaced. Keep the
passphrase somewhere safe: there is no recovery key.

Backups do not include `snapshots/`, `adapters/`, `remote-tls/`, or installed
market entries. Copy those separately if you need them.

## Restoring

Stop Pandu first. `pandu restore` refuses to run while a daemon answers its
health endpoint, because writing the database under a live process can corrupt
it.

```powershell
pandu restore .\backups\pandu-backup-20261111T090000Z.tar.gz
```

Before restoring, Pandu writes a timestamped snapshot of the current database.
It then replaces the database, restores the settings, runs an integrity check,
and forces remote access off (`remote.enabled=0`, `remote.autostart=0`). Pair
your phone again if you use remote access.

A backup from a newer schema is refused with a clear message. Update Pandu
first, then restore.

## Migrations

Pandu versions both the database schema and the settings schema. On startup:

1. It reads the current version.
2. If the database is newer than the build, it refuses to open it and asks you
   to update Pandu. It does not downgrade or rewrite the file.
3. If the database is older, it takes a timestamped backup with the SQLite
   backup API.
4. It runs the migrations in a transaction and checks `PRAGMA integrity_check`.
5. If anything fails, it restores the backup and reports the error.
6. If it succeeds, the Home screen shows a one-time notice with the backup
   path.

The settings chain covers appearance and themes, remote devices, market
manifests, and model overrides. A fresh database is not treated as a migration,
so you will not see a misleading backup notice on first launch.

## Removing your data

Deleting data is deliberate. Stop Pandu, then remove the home directory:

```powershell
Remove-Item -Recurse -Force "$HOME\.pandu\v2"
```

On macOS or Linux:

```bash
rm -rf ~/.pandu/v2
```

That deletes flights, settings, backups, snapshots, adapters, and remote
certificates. It cannot be undone. If you only want to reclaim space, remove
old files from `backups/` and `snapshots/` instead.

## What Pandu never does

- It never sends your database, flights, settings, or tokens to a server.
- It never includes secrets in a backup by default.
- It never deletes data during an update, rollback, or uninstall.
- It never installs an update silently.
- It never opens a database from a newer release and rewrites it.
