//! Local backup and restore archives.
//!
//! A backup is one `.tar.gz` containing `manifest.json`, a consistent SQLite
//! snapshot, and `settings.json`. Remote device tokens and secret-looking
//! settings are excluded by default. A restore always turns remote access off,
//! keeps a pre-restore snapshot, and refuses a database from a newer release.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::{Component, Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};

use pandu_core::brand;

use crate::error::{DaemonError, Result};
use crate::store::{
    SCHEMA_VERSION, check_database_file, database_file_version, prepare_restored_database,
    sanitize_backup_database, snapshot_database,
};

pub const BACKUP_SCHEMA: u32 = 1;
pub const MANIFEST_FILE: &str = "manifest.json";
pub const SETTINGS_FILE: &str = "settings.json";
/// Upper bound on the compressed archive. A local archive is never trusted
/// just because the user picked it.
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub schema: u32,
    pub product: String,
    pub app_version: String,
    pub database_schema: u32,
    pub created_at: String,
    pub include_remote: bool,
    pub settings_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub path: String,
    pub bytes: u64,
    pub database_schema: u32,
    pub settings_count: usize,
    pub include_remote: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub archive: String,
    pub database: String,
    pub database_schema: u32,
    pub settings_count: usize,
    pub include_remote: bool,
    pub remote_enabled: bool,
    pub pre_restore_backup: Option<String>,
}

/// Create a backup archive. `destination` must not already exist.
pub fn create_backup(
    database: &Path,
    destination: &Path,
    include_remote: bool,
) -> Result<BackupSummary> {
    if !database.exists() {
        return Err(DaemonError::config(format!(
            "the database {} does not exist",
            database.display()
        )));
    }
    if destination.exists() {
        return Err(DaemonError::config(format!(
            "{} already exists. Choose another name.",
            destination.display()
        )));
    }
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let workspace = tempfile::Builder::new()
        .prefix(".pandu-backup-")
        .tempdir_in(parent)?;
    let snapshot = workspace.path().join(brand::DATABASE_FILE);

    snapshot_database(database, &snapshot)?;
    let database_schema = database_file_version(&snapshot)?.unwrap_or(0);
    let settings = sanitize_backup_database(&snapshot, include_remote)?;
    let settings_json = serde_json::to_vec_pretty(&settings)?;
    let manifest = BackupManifest {
        schema: BACKUP_SCHEMA,
        product: brand::PRODUCT_NAME.to_string(),
        app_version: pandu_core::VERSION.to_string(),
        database_schema,
        created_at: now_iso(),
        include_remote,
        settings_count: settings.len(),
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest)?;

    let pending = pending_path(destination);
    let _ = std::fs::remove_file(&pending);
    let file = File::create(&pending)?;
    let encoder = GzEncoder::new(file, Compression::default());
    let mut builder = tar::Builder::new(encoder);
    append_bytes(&mut builder, MANIFEST_FILE, &manifest_json)?;
    append_bytes(&mut builder, SETTINGS_FILE, &settings_json)?;
    append_file(&mut builder, &snapshot, brand::DATABASE_FILE)?;
    let encoder = builder
        .into_inner()
        .map_err(|error| DaemonError::other(format!("could not finish the backup: {error}")))?;
    let file = encoder
        .finish()
        .map_err(|error| DaemonError::other(format!("could not finish the backup: {error}")))?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&pending, destination)?;

    Ok(BackupSummary {
        path: destination.display().to_string(),
        bytes: std::fs::metadata(destination)?.len(),
        database_schema,
        settings_count: settings.len(),
        include_remote,
    })
}

/// Restore a backup archive over `database`.
///
/// The current database is copied to a timestamped pre-restore file first. The
/// archive is validated before anything is replaced, and remote access is off
/// after the restore no matter what the archive says.
pub fn restore_backup(archive: &Path, database: &Path) -> Result<RestoreSummary> {
    if !archive.exists() {
        return Err(DaemonError::config(format!(
            "the backup {} does not exist",
            archive.display()
        )));
    }
    let archive_bytes = std::fs::metadata(archive)?.len();
    if archive_bytes > MAX_ARCHIVE_BYTES {
        return Err(DaemonError::config(format!(
            "the backup is larger than {} GB and will not be opened.",
            MAX_ARCHIVE_BYTES / (1024 * 1024 * 1024)
        )));
    }
    let parent = database.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let workspace = tempfile::Builder::new()
        .prefix(".pandu-restore-")
        .tempdir_in(parent)?;
    extract(archive, workspace.path())?;

    let manifest: BackupManifest = read_json(&workspace.path().join(MANIFEST_FILE))?;
    if manifest.schema != BACKUP_SCHEMA {
        return Err(DaemonError::config(format!(
            "this backup uses format {}, but this build understands {}. Update {} and try again.",
            manifest.schema,
            BACKUP_SCHEMA,
            brand::PRODUCT_NAME
        )));
    }
    if manifest.product != brand::PRODUCT_NAME {
        return Err(DaemonError::config(format!(
            "this backup was made by {}, not {}.",
            manifest.product,
            brand::PRODUCT_NAME
        )));
    }

    let extracted_database = workspace.path().join(brand::DATABASE_FILE);
    check_database_file(&extracted_database)?;
    match database_file_version(&extracted_database)? {
        None => {
            return Err(DaemonError::config(
                "this backup does not contain a database this build understands. Your data was not changed.",
            ));
        }
        Some(version) if version > SCHEMA_VERSION => {
            return Err(DaemonError::config(format!(
                "this backup was created by a newer version of {} (schema {version}; this build understands {SCHEMA_VERSION}). \
                 Update {} before restoring it. Your data was not changed.",
                brand::PRODUCT_NAME,
                brand::PRODUCT_NAME
            )));
        }
        Some(_) => {}
    }

    let settings: BTreeMap<String, String> = read_json(&workspace.path().join(SETTINGS_FILE))?;
    let prepared_version =
        prepare_restored_database(&extracted_database, &settings).map_err(|error| {
            DaemonError::other(format!("could not prepare the restored database: {error}"))
        })?;

    let pre_restore = if database.exists() {
        let path = pre_restore_path(database);
        snapshot_database(database, &path).map_err(|error| {
            DaemonError::other(format!("could not snapshot the current database: {error}"))
        })?;
        Some(path)
    } else {
        None
    };

    let pending = pending_path(database);
    let _ = std::fs::remove_file(&pending);
    std::fs::copy(&extracted_database, &pending).map_err(|error| {
        DaemonError::other(format!("could not stage the restored database: {error}"))
    })?;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&pending)?
        .sync_all()?;

    let replaced = if database.exists() {
        let old = old_restore_path(database);
        std::fs::rename(database, &old).map_err(|error| {
            DaemonError::config(format!(
                "could not move the current database aside: {error}. \
                 Stop {} before restoring.",
                brand::PRODUCT_NAME
            ))
        })?;
        Some(old)
    } else {
        None
    };
    if let Err(error) = std::fs::rename(&pending, database) {
        if let Some(old) = &replaced {
            let _ = std::fs::rename(old, database);
        }
        let _ = std::fs::remove_file(&pending);
        return Err(DaemonError::Io(error));
    }
    if let Some(old) = replaced {
        let _ = std::fs::remove_file(old);
    }
    remove_sidecars(database);
    check_database_file(database)?;

    Ok(RestoreSummary {
        archive: archive.display().to_string(),
        database: database.display().to_string(),
        database_schema: prepared_version,
        settings_count: settings.len(),
        include_remote: manifest.include_remote,
        remote_enabled: false,
        pre_restore_backup: pre_restore.map(|path| path.display().to_string()),
    })
}

fn extract(archive: &Path, directory: &Path) -> Result<()> {
    let file = File::open(archive)?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut seen = std::collections::BTreeSet::new();
    let mut total = 0u64;
    let entries = archive
        .entries()
        .map_err(|error| DaemonError::config(format!("the backup could not be read: {error}")))?;
    for entry in entries {
        let mut entry = entry
            .map_err(|error| DaemonError::config(format!("a backup entry is invalid: {error}")))?;
        let kind = entry.header().entry_type();
        if matches!(
            kind,
            tar::EntryType::XGlobalHeader
                | tar::EntryType::XHeader
                | tar::EntryType::GNULongName
                | tar::EntryType::GNULongLink
        ) {
            continue;
        }
        if kind.is_dir() {
            continue;
        }
        if kind.is_symlink() || kind.is_hard_link() || !kind.is_file() {
            return Err(DaemonError::config(
                "the backup contains a link or an unsupported entry. Refusing to restore it.",
            ));
        }
        let path = entry
            .path()
            .map_err(|error| DaemonError::config(format!("a backup path is invalid: {error}")))?;
        let name = safe_entry_name(&path)?;
        if !seen.insert(name.clone()) {
            return Err(DaemonError::config(format!(
                "the backup contains {name} more than once."
            )));
        }
        let size = entry.header().size().unwrap_or(u64::MAX);
        total = total.saturating_add(size);
        if size > MAX_EXTRACTED_BYTES || total > MAX_EXTRACTED_BYTES {
            return Err(DaemonError::config(
                "the backup expands past the restore limit.",
            ));
        }
        let target = directory.join(&name);
        let mut output = File::create(&target)?;
        let copied = std::io::copy(&mut entry, &mut output)?;
        output.sync_all()?;
        if copied != size {
            return Err(DaemonError::config(format!(
                "the backup entry {name} is truncated."
            )));
        }
    }
    Ok(())
}

fn safe_entry_name(path: &Path) -> Result<String> {
    let mut components = path.components();
    let Some(Component::Normal(name)) = components.next() else {
        return Err(DaemonError::config(
            "the backup contains an absolute path. Refusing to restore it.",
        ));
    };
    if components.next().is_some() {
        return Err(DaemonError::config(
            "the backup contains a nested path. Refusing to restore it.",
        ));
    }
    let name = name.to_string_lossy().to_string();
    if !matches!(
        name.as_str(),
        MANIFEST_FILE | SETTINGS_FILE | brand::DATABASE_FILE
    ) {
        return Err(DaemonError::config(format!(
            "the backup contains an unexpected file, {name}."
        )));
    }
    Ok(name)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let bytes = std::fs::read(path).map_err(|error| {
        DaemonError::config(format!(
            "the backup is missing {}: {error}",
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.display().to_string())
        ))
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|error| DaemonError::config(format!("the backup is not valid: {error}")))
}

fn append_bytes(
    builder: &mut tar::Builder<GzEncoder<File>>,
    name: &str,
    bytes: &[u8],
) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_mtime(0);
    header.set_cksum();
    builder.append_data(&mut header, name, bytes)?;
    Ok(())
}

fn append_file(builder: &mut tar::Builder<GzEncoder<File>>, path: &Path, name: &str) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(std::fs::metadata(path)?.len());
    header.set_mode(0o600);
    header.set_mtime(0);
    header.set_cksum();
    builder.append_data(&mut header, name, File::open(path)?)?;
    Ok(())
}

fn pending_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "backup".to_string());
    destination.with_file_name(format!(".{name}.pending"))
}

fn pre_restore_path(database: &Path) -> PathBuf {
    unique_path(database, "pre-restore")
}

fn old_restore_path(database: &Path) -> PathBuf {
    unique_path(database, "restore-old")
}

fn unique_path(database: &Path, label: &str) -> PathBuf {
    let name = database
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "database".to_string());
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
    for attempt in 0..100 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let candidate = database.with_file_name(format!("{name}.{label}-{stamp}{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    database.with_file_name(format!("{name}.{label}-{stamp}-overflow"))
}

fn remove_sidecars(database: &Path) {
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", database.display()));
        let _ = std::fs::remove_file(sidecar);
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use pandu_core::model::{CaptureMode, SessionSource};
    use rusqlite::Connection;

    fn database_with_data(directory: &Path) -> PathBuf {
        let path = directory.join(brand::DATABASE_FILE);
        let store = Store::open(&path).unwrap();
        store.set_setting("appearance.theme", "dark").unwrap();
        store.set_setting("remote.enabled", "1").unwrap();
        store.set_setting("remote.autostart", "1").unwrap();
        store
            .set_setting("pairing.token", "never-copy-this")
            .unwrap();
        store
            .create_session(crate::store::NewSession {
                title: "Before backup".to_string(),
                source: SessionSource::Proxy,
                capture_mode: CaptureMode::Proxy,
                ..Default::default()
            })
            .unwrap();
        store.checkpoint().unwrap();
        drop(store);

        // Remote device rows live behind the daemon's private lock; insert one
        // directly into the file to prove the archive excludes it.
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO remote_devices (id, name, token_hash, scopes, created_at)
                 VALUES ('device-1', 'Phone', 'hashed-token', '[\"view:status\"]', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        path
    }

    fn archive(directory: &Path, database: &Path, include_remote: bool) -> PathBuf {
        let path = directory.join("backup.tar.gz");
        create_backup(database, &path, include_remote).unwrap();
        path
    }

    fn extracted(path: &Path, name: &str) -> Vec<u8> {
        let directory = tempfile::tempdir().unwrap();
        extract(path, directory.path()).unwrap();
        std::fs::read(directory.path().join(name)).unwrap()
    }

    #[test]
    fn a_backup_round_trips_database_and_settings() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = archive(directory.path(), &database, false);

        let summary =
            create_backup(&database, &directory.path().join("second.tar.gz"), false).unwrap();
        assert_eq!(summary.settings_count, 3, "only safe settings are exported");
        assert_eq!(summary.database_schema, SCHEMA_VERSION);

        let manifest: BackupManifest =
            serde_json::from_slice(&extracted(&archive, MANIFEST_FILE)).unwrap();
        assert_eq!(manifest.product, brand::PRODUCT_NAME);
        assert_eq!(manifest.schema, BACKUP_SCHEMA);
        assert!(!manifest.include_remote);
        assert_eq!(manifest.settings_count, 3);

        let settings: BTreeMap<String, String> =
            serde_json::from_slice(&extracted(&archive, SETTINGS_FILE)).unwrap();
        assert_eq!(
            settings.get("appearance.theme").map(String::as_str),
            Some("dark")
        );
        assert!(!settings.contains_key("pairing.token"));

        let snapshot = directory.path().join("snapshot.db");
        std::fs::write(&snapshot, extracted(&archive, brand::DATABASE_FILE)).unwrap();
        check_database_file(&snapshot).unwrap();
        let connection = Connection::open(&snapshot).unwrap();
        let devices: i64 = connection
            .query_row("SELECT COUNT(*) FROM remote_devices", [], |row| row.get(0))
            .unwrap();
        assert_eq!(devices, 0, "remote device tokens are excluded by default");
        let sessions: i64 = connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sessions, 1);
        let secret: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'pairing.token'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(secret, 0);
    }

    #[test]
    fn include_remote_keeps_device_rows_but_never_secret_settings() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = archive(directory.path(), &database, true);

        let manifest: BackupManifest =
            serde_json::from_slice(&extracted(&archive, MANIFEST_FILE)).unwrap();
        assert!(manifest.include_remote);

        let snapshot = directory.path().join("snapshot.db");
        std::fs::write(&snapshot, extracted(&archive, brand::DATABASE_FILE)).unwrap();
        let connection = Connection::open(&snapshot).unwrap();
        let devices: i64 = connection
            .query_row("SELECT COUNT(*) FROM remote_devices", [], |row| row.get(0))
            .unwrap();
        assert_eq!(devices, 1);
        let secret: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'pairing.token'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(secret, 0);
    }

    #[test]
    fn restoring_replaces_the_database_and_turns_remote_off() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = archive(directory.path(), &database, true);

        // Change the live database after the backup.
        let store = Store::open(&database).unwrap();
        store.set_setting("appearance.theme", "light").unwrap();
        store.set_setting("remote.enabled", "1").unwrap();
        store
            .create_session(crate::store::NewSession {
                title: "After backup".to_string(),
                source: SessionSource::Proxy,
                capture_mode: CaptureMode::Proxy,
                ..Default::default()
            })
            .unwrap();
        store.checkpoint().unwrap();
        drop(store);

        let summary = restore_backup(&archive, &database).unwrap();
        assert_eq!(summary.database_schema, SCHEMA_VERSION);
        assert!(!summary.remote_enabled);
        assert!(summary.pre_restore_backup.is_some());
        let pre_restore = PathBuf::from(summary.pre_restore_backup.unwrap());
        assert!(pre_restore.exists());
        check_database_file(&pre_restore).unwrap();

        let store = Store::open(&database).unwrap();
        assert_eq!(
            store.get_setting("appearance.theme").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(
            store.get_setting("remote.enabled").unwrap().as_deref(),
            Some("0")
        );
        assert_eq!(
            store.get_setting("remote.autostart").unwrap().as_deref(),
            Some("0")
        );
        let sessions = store.list_sessions(10, 0, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "Before backup");
    }

    #[test]
    fn a_newer_schema_is_refused_without_changing_the_current_database() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = directory.path().join("newer.tar.gz");
        {
            let workspace = tempfile::tempdir().unwrap();
            let newer = workspace.path().join(brand::DATABASE_FILE);
            std::fs::copy(&database, &newer).unwrap();
            let connection = Connection::open(&newer).unwrap();
            connection
                .execute(
                    "UPDATE schema_meta SET value = '99' WHERE key = 'schema_version'",
                    [],
                )
                .unwrap();
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")
                .unwrap();
            drop(connection);
            let manifest = BackupManifest {
                schema: BACKUP_SCHEMA,
                product: brand::PRODUCT_NAME.to_string(),
                app_version: "99.0.0".to_string(),
                database_schema: 99,
                created_at: now_iso(),
                include_remote: false,
                settings_count: 0,
            };
            write_archive(
                &archive,
                &serde_json::to_vec(&manifest).unwrap(),
                b"{}",
                &std::fs::read(&newer).unwrap(),
            );
        }

        let before = std::fs::read(&database).unwrap();
        let error = restore_backup(&archive, &database).unwrap_err().to_string();
        assert!(error.contains("newer version"), "{error}");
        assert!(error.contains("Update Pandu"), "{error}");
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }

    #[test]
    fn a_damaged_database_is_refused_before_anything_changes() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = directory.path().join("damaged.tar.gz");
        let manifest = BackupManifest {
            schema: BACKUP_SCHEMA,
            product: brand::PRODUCT_NAME.to_string(),
            app_version: pandu_core::VERSION.to_string(),
            database_schema: SCHEMA_VERSION,
            created_at: now_iso(),
            include_remote: false,
            settings_count: 0,
        };
        write_archive(
            &archive,
            &serde_json::to_vec(&manifest).unwrap(),
            b"{}",
            b"this is not a database",
        );

        let before = std::fs::read(&database).unwrap();
        let error = restore_backup(&archive, &database).unwrap_err().to_string();
        assert!(
            error.contains("integrity check") || error.contains("database"),
            "{error}"
        );
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }

    #[test]
    fn path_traversal_entries_are_refused() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("evil.tar.gz");
        let file = File::create(&archive).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o600);
        let name = b"../evil";
        header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
        header.set_cksum();
        builder.append(&header, &b"evil"[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let error = restore_backup(&archive, &directory.path().join(brand::DATABASE_FILE))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("absolute path") || error.contains("nested path"),
            "{error}"
        );
    }

    #[test]
    fn secret_setting_names_are_broadly_matched() {
        for key in [
            "remote.token",
            "remote.secret",
            "auth.password",
            "cloud.credential",
            "openai.api_key",
            "openai.apikey",
            "device.private_key",
            "pairing.code",
            "device.pin_hash",
            "http.authorization",
        ] {
            assert!(crate::store::is_secret_setting(key), "{key}");
        }
        for key in [
            "appearance.theme",
            "remote.enabled",
            "remote.autostart",
            "pricing.overrides",
            "update.skipVersion",
        ] {
            assert!(!crate::store::is_secret_setting(key), "{key}");
        }
    }

    fn write_archive(path: &Path, manifest: &[u8], settings: &[u8], database: &[u8]) {
        let file = File::create(path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = tar::Builder::new(encoder);
        append_bytes(&mut builder, MANIFEST_FILE, manifest).unwrap();
        append_bytes(&mut builder, SETTINGS_FILE, settings).unwrap();
        append_bytes(&mut builder, brand::DATABASE_FILE, database).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }
}
