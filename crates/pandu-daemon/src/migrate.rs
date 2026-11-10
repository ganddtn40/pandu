//! Copy an existing 0.1.0 data directory into the renamed location.
//!
//! The rename must not strand local state. On first start, if the old
//! `~/.cockpit` directory exists and `~/.pandu` does not, copy the whole tree
//! into a staging directory beside the destination, then rename the staging
//! directory into place. A failure never leaves a half-written `~/.pandu`.
//!
//! The old directory is never moved or deleted. If both exist, the new one
//! wins and nothing is copied. The copied database is written with the SQLite
//! backup API, not by copying `cockpit.db`, `-wal`, and `-shm` byte by byte:
//! the backup is a consistent snapshot even when the old daemon left a WAL
//! behind. An existing `pandu.db` in the copy is never overwritten.
//!
//! Remote access is turned off in the copy. Paired devices stay in the
//! database, but the copied daemon starts with the remote listener disabled
//! until the user explicitly enables it again from the host UI. This module is
//! the only one allowed to mention the old product name outside the frozen
//! `legacy/` tree, the changelog, and the name guard.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};

/// The pre-rename database file name.
const LEGACY_DATABASE: &str = "cockpit.db";
/// The current database file name, from `brand.json`.
const DATABASE: &str = pandu_core::brand::DATABASE_FILE;
/// Persisted settings that could re-open the remote listener without a user
/// action. The copied database keeps its paired devices, but these keys are
/// removed so the daemon starts with remote access off.
const REMOTE_SETTINGS_TO_CLEAR: &[&str] = &["remote.enabled", "remote.autostart"];
const DATABASE_SIDECARS: &[&str] = &["-wal", "-shm", "-journal"];

/// One completed copy from the old data directory to the new one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migration {
    pub source: PathBuf,
    pub destination: PathBuf,
}

/// Copy `old` to `new` when `old` is a directory and `new` does not exist.
///
/// Returns `Some` only when files were copied. Both trees are left in place;
/// the caller decides how to tell the user.
pub fn copy_legacy_home(old: &Path, new: &Path) -> io::Result<Option<Migration>> {
    if !old.is_dir() || new.exists() {
        return Ok(None);
    }
    let parent = new.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let staging = staging_directory(parent, new)?;
    let result = (|| {
        copy_tree(old, &staging)?;
        if new.exists() {
            return Ok(false);
        }
        fs::rename(&staging, new)?;
        Ok(true)
    })();
    match result {
        Ok(true) => Ok(Some(Migration {
            source: old.to_path_buf(),
            destination: new.to_path_buf(),
        })),
        Ok(false) => {
            let _ = fs::remove_dir_all(&staging);
            Ok(None)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

/// Create a unique staging directory beside the destination. Keeping it on the
/// same volume makes the final rename atomic.
fn staging_directory(parent: &Path, destination: &Path) -> io::Result<PathBuf> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    for attempt in 0..100 {
        let candidate = parent.join(format!(".{name}.migrate-{}-{attempt}", std::process::id()));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create a migration staging directory",
    ))
}

fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    let destination_database = destination.join(DATABASE);
    // A `pandu.db` already present in the old tree wins over `cockpit.db`,
    // regardless of directory iteration order.
    let has_destination_database = destination_database.exists() || source.join(DATABASE).is_file();
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_database_sidecar(name) {
            // The SQLite backup API produces a consistent database; copying a
            // stale WAL, SHM, or rollback journal would corrupt it.
            continue;
        }
        let target = destination.join(name);
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            if name == LEGACY_DATABASE {
                if !has_destination_database {
                    copy_database(&entry.path(), &destination_database)?;
                }
            } else if name == DATABASE {
                if !destination_database.exists() {
                    fs::copy(entry.path(), &destination_database)?;
                }
            } else {
                fs::copy(entry.path(), &target)?;
            }
        }
        // Symlinks are skipped: copying them could escape the data directory.
    }
    Ok(())
}

fn is_database_sidecar(name: &str) -> bool {
    [LEGACY_DATABASE, DATABASE].iter().any(|database| {
        DATABASE_SIDECARS
            .iter()
            .any(|suffix| name.strip_prefix(database) == Some(suffix))
    })
}

/// Snapshot a SQLite database with the backup API.
fn copy_database(source: &Path, destination: &Path) -> io::Result<()> {
    if destination.exists() {
        return Ok(());
    }
    let source_connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(io::Error::other)?;
    let mut destination_connection = Connection::open(destination).map_err(io::Error::other)?;
    {
        let backup = Backup::new(&source_connection, &mut destination_connection)
            .map_err(io::Error::other)?;
        backup
            .run_to_completion(64, Duration::from_millis(5), None)
            .map_err(io::Error::other)?;
    }
    disable_remote_access(&destination_connection)?;
    Ok(())
}

/// Remove persisted settings that could turn remote access back on. Paired
/// devices are deliberately kept so the user still sees them, but the remote
/// listener starts disabled and needs an explicit enable.
fn disable_remote_access(connection: &Connection) -> io::Result<()> {
    let has_settings: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings')",
            [],
            |row| row.get(0),
        )
        .map_err(io::Error::other)?;
    if !has_settings {
        return Ok(());
    }
    for key in REMOTE_SETTINGS_TO_CLEAR {
        connection
            .execute("DELETE FROM settings WHERE key = ?1", [key])
            .map_err(io::Error::other)?;
    }
    Ok(())
}

/// The default old and new locations, when the platform can name a home.
pub fn default_paths() -> Option<(PathBuf, PathBuf)> {
    let base = directories::BaseDirs::new()?;
    Some((
        base.home_dir().join(".cockpit"),
        base.home_dir().join(pandu_core::brand::DATA_DIR),
    ))
}

/// Run the first-start check against the default locations.
///
/// Logs one line when a copy happened, so `pandu serve` tells the user where
/// the data went and that the old folder is still there.
pub fn migrate_default_home() -> io::Result<Option<Migration>> {
    let Some((old, new)) = default_paths() else {
        return Ok(None);
    };
    let outcome = copy_legacy_home(&old, &new)?;
    if let Some(migration) = &outcome {
        tracing::info!(
            from = %migration.source.display(),
            to = %migration.destination.display(),
            "copied existing Cockpit data to Pandu; the old folder was left untouched"
        );
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{PairingManager, RemoteAccess};
    use crate::store::{NewRemoteDevice, Store};
    use std::sync::Arc;

    fn create_database(path: &Path, marker: &str) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch("CREATE TABLE marker (value TEXT NOT NULL);")
            .unwrap();
        connection
            .execute("INSERT INTO marker (value) VALUES (?1)", [marker])
            .unwrap();
    }

    fn read_marker(path: &Path) -> String {
        Connection::open(path)
            .unwrap()
            .query_row("SELECT value FROM marker", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn copies_when_only_the_old_directory_exists() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(old.join("v2")).unwrap();
        create_database(&old.join("v2").join("cockpit.db"), "old data");
        fs::write(old.join("legacy.txt"), b"kept").unwrap();

        let migration = copy_legacy_home(&old, &new).unwrap().expect("copied");

        assert_eq!(migration.source, old);
        assert_eq!(migration.destination, new);
        assert_eq!(read_marker(&new.join("v2").join("pandu.db")), "old data");
        assert_eq!(fs::read(new.join("legacy.txt")).unwrap(), b"kept");
        // The old tree is copied, never moved or deleted.
        assert_eq!(read_marker(&old.join("v2").join("cockpit.db")), "old data");
        assert_eq!(fs::read(old.join("legacy.txt")).unwrap(), b"kept");
    }

    #[test]
    fn an_existing_pandu_database_in_the_copy_is_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(old.join("v2")).unwrap();
        create_database(&old.join("v2").join("cockpit.db"), "legacy data");
        create_database(&old.join("v2").join("pandu.db"), "new data");

        copy_legacy_home(&old, &new).unwrap().expect("copied");

        assert_eq!(read_marker(&new.join("v2").join("pandu.db")), "new data");
        assert_eq!(
            read_marker(&old.join("v2").join("cockpit.db")),
            "legacy data"
        );
    }

    #[test]
    fn a_wal_database_is_copied_consistently_without_its_sidecars() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(old.join("v2")).unwrap();
        let source_path = old.join("v2").join("cockpit.db");
        let source = Connection::open(&source_path).unwrap();
        source
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE marker (value TEXT NOT NULL);
                 INSERT INTO marker (value) VALUES ('uncheckpointed');",
            )
            .unwrap();
        assert!(old.join("v2").join("cockpit.db-wal").exists());

        // The writer stays open, so the row lives only in the WAL when the
        // backup starts. A raw file copy would lose it.
        copy_legacy_home(&old, &new).unwrap().expect("copied");

        let copied = new.join("v2").join("pandu.db");
        assert_eq!(read_marker(&copied), "uncheckpointed");
        assert!(!new.join("v2").join("pandu.db-wal").exists());
        assert!(!new.join("v2").join("pandu.db-shm").exists());
        drop(source);
    }

    #[test]
    fn remote_access_starts_off_and_paired_devices_stay_listed() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(old.join("v2")).unwrap();
        let source = Store::open(old.join("v2").join("cockpit.db")).unwrap();
        source.set_setting("remote.enabled", "1").unwrap();
        source
            .insert_remote_device(&NewRemoteDevice {
                id: "device-1".into(),
                name: "Phone".into(),
                token_hash: "hash".into(),
                pin_salt: None,
                pin_hash: None,
                scopes: vec!["read".into()],
                require_host_confirmation: false,
                expires_at: None,
                created_at: "2026-01-01T00:00:00Z".into(),
            })
            .unwrap();
        drop(source);

        copy_legacy_home(&old, &new).unwrap().expect("copied");

        let store = Arc::new(Store::open(new.join("v2").join("pandu.db")).unwrap());
        assert_eq!(store.get_setting("remote.enabled").unwrap(), None);
        let devices = store.list_remote_devices().unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Phone");
        let remote = RemoteAccess::new(store.clone(), PairingManager::new(store));
        assert!(!remote.is_enabled());
    }

    #[test]
    fn a_failed_copy_leaves_the_destination_absent() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(old.join("v2")).unwrap();
        fs::write(old.join("v2").join("cockpit.db"), b"not a database").unwrap();

        assert!(copy_legacy_home(&old, &new).is_err());
        assert!(!new.exists());
        assert_eq!(
            fs::read(old.join("v2").join("cockpit.db")).unwrap(),
            b"not a database"
        );
    }

    #[test]
    fn does_nothing_when_only_the_new_directory_exists() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("flight.db"), b"new data").unwrap();

        assert!(copy_legacy_home(&old, &new).unwrap().is_none());
        assert_eq!(fs::read(new.join("flight.db")).unwrap(), b"new data");
        assert!(!old.exists());
    }

    #[test]
    fn leaves_the_new_directory_alone_when_both_exist() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("flight.db"), b"old data").unwrap();
        fs::write(new.join("flight.db"), b"new data").unwrap();

        assert!(copy_legacy_home(&old, &new).unwrap().is_none());
        assert_eq!(fs::read(new.join("flight.db")).unwrap(), b"new data");
        assert_eq!(fs::read(old.join("flight.db")).unwrap(), b"old data");
    }
}
