//! Local backup and restore archives.
//!
//! A backup is one `.tar.gz` containing `manifest.json`, a consistent SQLite
//! snapshot, and `settings.json`. Remote device tokens and secret-looking
//! settings are excluded by default. A restore always turns remote access off,
//! keeps a pre-restore snapshot, and refuses a database from a newer release.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::KeyInit;
use chacha20poly1305::aead::generic_array::GenericArray;
use chacha20poly1305::aead::stream::{DecryptorBE32, EncryptorBE32};
use chrono::{SecondsFormat, Utc};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use rand::RngCore;
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
/// Encrypted archives start with this marker. The header that follows carries
/// the Argon2id parameters, salt, and XChaCha20-Poly1305 nonce.
pub const ENCRYPTED_MAGIC: &[u8] = b"PANDU-BACKUP-ENC-1\n";
/// Upper bound on the compressed archive. A local archive is never trusted
/// just because the user picked it.
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

const SALT_LEN: usize = 16;
/// XChaCha20-Poly1305 has a 24-byte nonce. The stream API spends the last five
/// bytes on the block counter and the final-block flag, so the caller supplies
/// the 19-byte prefix and the header stores exactly that prefix.
const NONCE_LEN: usize = 19;
const TAG_LEN: usize = 16;
const CHUNK_SIZE: usize = 1024 * 1024;
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;
const MAX_KDF_MEMORY_KIB: u32 = 256 * 1024;
const MAX_KDF_ITERATIONS: u32 = 10;
const MAX_KDF_PARALLELISM: u32 = 4;
const ENCRYPTION_HEADER_BYTES: usize = ENCRYPTED_MAGIC.len() + 12 + SALT_LEN + NONCE_LEN;

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
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub archive: String,
    pub database: String,
    pub database_schema: u32,
    pub settings_count: usize,
    pub include_remote: bool,
    pub encrypted: bool,
    pub remote_enabled: bool,
    pub pre_restore_backup: Option<String>,
}

/// Create a backup archive. `destination` must not already exist.
///
/// The archive contains flight history: prompts, responses, tool output, and
/// code snapshots. Secret-looking settings and remote device tokens are
/// excluded, but the remaining content can still be sensitive. When a
/// passphrase is supplied the tar.gz is encrypted with XChaCha20-Poly1305 and
/// an Argon2id key. Every archive is created owner-only.
pub fn create_backup(
    database: &Path,
    destination: &Path,
    include_remote: bool,
    passphrase: Option<&str>,
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

    let encrypted = passphrase.is_some();
    if let Some(passphrase) = passphrase {
        let encrypted_pending = encrypted_pending_path(destination);
        let _ = std::fs::remove_file(&encrypted_pending);
        if let Err(error) = encrypt_file(&pending, &encrypted_pending, passphrase) {
            let _ = std::fs::remove_file(&pending);
            let _ = std::fs::remove_file(&encrypted_pending);
            return Err(error);
        }
        std::fs::remove_file(&pending)?;
        if let Err(error) = std::fs::rename(&encrypted_pending, destination) {
            let _ = std::fs::remove_file(&encrypted_pending);
            return Err(error.into());
        }
    } else {
        std::fs::rename(&pending, destination)?;
    }
    if let Err(error) = restrict_to_owner(destination) {
        let _ = std::fs::remove_file(destination);
        return Err(error);
    }

    Ok(BackupSummary {
        path: destination.display().to_string(),
        bytes: std::fs::metadata(destination)?.len(),
        database_schema,
        settings_count: settings.len(),
        include_remote,
        encrypted,
    })
}

/// The default archive name for a data directory.
pub fn default_backup_path(home: &Path, encrypted: bool) -> PathBuf {
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
    let suffix = if encrypted { "tar.gz.enc" } else { "tar.gz" };
    let directory = home.join("backups");
    let mut candidate = directory.join(format!("{}-backup-{stamp}.{suffix}", brand::SLUG));
    for attempt in 1..100 {
        if !candidate.exists() {
            break;
        }
        candidate = directory.join(format!("{}-backup-{stamp}-{attempt}.{suffix}", brand::SLUG));
    }
    candidate
}

/// Whether an archive is encrypted, without asking for a passphrase.
pub fn is_encrypted_archive(archive: &Path) -> Result<bool> {
    let mut file = File::open(archive)?;
    let mut magic = vec![0u8; ENCRYPTED_MAGIC.len()];
    match file.read_exact(&mut magic) {
        Ok(()) => Ok(magic == ENCRYPTED_MAGIC),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// Restore a backup archive over `database`.
///
/// The current database is copied to a timestamped pre-restore file first. The
/// archive is validated before anything is replaced, and remote access is off
/// after the restore no matter what the archive says.
pub fn restore_backup(
    archive: &Path,
    database: &Path,
    passphrase: Option<&str>,
) -> Result<RestoreSummary> {
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
    let encrypted = is_encrypted_archive(archive)?;
    let plaintext_archive = if encrypted {
        let Some(passphrase) = passphrase else {
            return Err(DaemonError::config(
                "this backup is encrypted. Provide the passphrase to restore it.",
            ));
        };
        let decrypted = workspace.path().join("archive.tar.gz");
        decrypt_file(archive, &decrypted, passphrase)?;
        decrypted
    } else {
        archive.to_path_buf()
    };
    extract(&plaintext_archive, workspace.path())?;

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
        encrypted,
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

fn encrypted_pending_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "backup".to_string());
    destination.with_file_name(format!(".{name}.pending.enc"))
}

fn create_owner_only(path: &Path) -> Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

/// Restrict an archive to the current user. On Unix this is mode 0600. On
/// Windows it removes inherited ACEs and grants full control to the current
/// user SID with `icacls`, which is present on supported Windows versions.
fn restrict_to_owner(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let sid = current_user_sid().ok_or_else(|| {
            DaemonError::other("could not determine the current Windows user SID")
        })?;
        let output = std::process::Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(format!("*{sid}:F"))
            .output()
            .map_err(|error| {
                DaemonError::other(format!("could not set owner-only permissions: {error}"))
            })?;
        if !output.status.success() {
            return Err(DaemonError::other(
                "could not set owner-only permissions on the backup",
            ));
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(windows)]
fn current_user_sid() -> Option<String> {
    let output = std::process::Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let sid = text.split(',').nth(1)?.trim().trim_matches('"').to_string();
    sid.starts_with("S-1-").then_some(sid)
}

fn derive_key(
    passphrase: &str,
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<[u8; 32]> {
    if passphrase.is_empty() {
        return Err(DaemonError::config("the backup passphrase is empty"));
    }
    let params = Params::new(memory_kib, iterations, parallelism, Some(32)).map_err(|error| {
        DaemonError::config(format!("invalid backup encryption parameters: {error}"))
    })?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|error| DaemonError::other(format!("could not derive the backup key: {error}")))?;
    Ok(key)
}

fn cipher(
    passphrase: &str,
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<XChaCha20Poly1305> {
    let key = derive_key(passphrase, salt, memory_kib, iterations, parallelism)?;
    XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|_| DaemonError::other("could not initialize backup encryption"))
}

fn encrypt_file(source: &Path, destination: &Path, passphrase: &str) -> Result<()> {
    let total = std::fs::metadata(source)?.len();
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let cipher = cipher(
        passphrase,
        &salt,
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    )?;
    let mut encryptor = EncryptorBE32::from_aead(cipher, GenericArray::from_slice(&nonce));
    let mut input = BufReader::new(File::open(source)?);
    let mut output = BufWriter::new(create_owner_only(destination)?);

    output.write_all(ENCRYPTED_MAGIC)?;
    output.write_all(&KDF_MEMORY_KIB.to_le_bytes())?;
    output.write_all(&KDF_ITERATIONS.to_le_bytes())?;
    output.write_all(&KDF_PARALLELISM.to_le_bytes())?;
    output.write_all(&salt)?;
    output.write_all(&nonce)?;

    let full_chunks = total / CHUNK_SIZE as u64;
    let remainder = total % CHUNK_SIZE as u64;
    let mut buffer = vec![0u8; CHUNK_SIZE];
    // Every chunk but the final one is sealed with `encrypt_next`. The final
    // chunk consumes the encryptor, so it is handled outside the loop.
    let next_chunks = if remainder == 0 && full_chunks > 0 {
        full_chunks - 1
    } else {
        full_chunks
    };
    for _ in 0..next_chunks {
        input.read_exact(&mut buffer)?;
        let encrypted = encryptor
            .encrypt_next(&buffer[..])
            .map_err(|_| DaemonError::other("could not encrypt the backup"))?;
        output.write_all(&encrypted)?;
    }
    if remainder > 0 {
        let mut tail = vec![0u8; remainder as usize];
        input.read_exact(&mut tail)?;
        let encrypted = encryptor
            .encrypt_last(&tail[..])
            .map_err(|_| DaemonError::other("could not encrypt the backup"))?;
        output.write_all(&encrypted)?;
    } else if full_chunks > 0 {
        input.read_exact(&mut buffer)?;
        let encrypted = encryptor
            .encrypt_last(&buffer[..])
            .map_err(|_| DaemonError::other("could not encrypt the backup"))?;
        output.write_all(&encrypted)?;
    } else {
        let encrypted = encryptor
            .encrypt_last(&[][..])
            .map_err(|_| DaemonError::other("could not encrypt the backup"))?;
        output.write_all(&encrypted)?;
    }
    output.flush()?;
    output.get_ref().sync_all()?;
    Ok(())
}

fn decrypt_file(source: &Path, destination: &Path, passphrase: &str) -> Result<()> {
    let total = std::fs::metadata(source)?.len();
    if total < ENCRYPTION_HEADER_BYTES as u64 + TAG_LEN as u64 {
        return Err(DaemonError::config(
            "the encrypted backup is truncated or not a backup archive.",
        ));
    }
    let mut input = BufReader::new(File::open(source)?);
    let mut magic = vec![0u8; ENCRYPTED_MAGIC.len()];
    input.read_exact(&mut magic)?;
    if magic != ENCRYPTED_MAGIC {
        return Err(DaemonError::config(
            "the backup is not in the encrypted backup format.",
        ));
    }
    let mut params = [0u8; 12];
    input.read_exact(&mut params)?;
    let memory_kib = u32::from_le_bytes(params[0..4].try_into().expect("four bytes"));
    let iterations = u32::from_le_bytes(params[4..8].try_into().expect("four bytes"));
    let parallelism = u32::from_le_bytes(params[8..12].try_into().expect("four bytes"));
    if !(1024..=MAX_KDF_MEMORY_KIB).contains(&memory_kib)
        || !(1..=MAX_KDF_ITERATIONS).contains(&iterations)
        || !(1..=MAX_KDF_PARALLELISM).contains(&parallelism)
    {
        return Err(DaemonError::config(
            "the encrypted backup uses unsupported key-derivation parameters.",
        ));
    }
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    input.read_exact(&mut salt)?;
    input.read_exact(&mut nonce)?;

    let cipher = cipher(passphrase, &salt, memory_kib, iterations, parallelism)?;
    let mut decryptor = DecryptorBE32::from_aead(cipher, GenericArray::from_slice(&nonce));
    let mut output = BufWriter::new(create_owner_only(destination)?);
    let mut remaining = total - ENCRYPTION_HEADER_BYTES as u64;
    let chunk_size = (CHUNK_SIZE + TAG_LEN) as u64;
    let chunks = remaining.div_ceil(chunk_size);
    let mut buffer = vec![0u8; CHUNK_SIZE + TAG_LEN];
    for index in 0..chunks {
        let chunk_len = remaining.min(chunk_size) as usize;
        input.read_exact(&mut buffer[..chunk_len])?;
        if index + 1 == chunks {
            let plaintext = decryptor.decrypt_last(&buffer[..chunk_len]).map_err(|_| {
                DaemonError::config(
                    "the backup could not be decrypted. The passphrase is wrong, or the archive is damaged.",
                )
            })?;
            output.write_all(&plaintext)?;
            remaining -= chunk_len as u64;
            break;
        }
        let plaintext = decryptor.decrypt_next(&buffer[..chunk_len]).map_err(|_| {
            DaemonError::config(
                "the backup could not be decrypted. The passphrase is wrong, or the archive is damaged.",
            )
        })?;
        output.write_all(&plaintext)?;
        remaining -= chunk_len as u64;
    }
    debug_assert_eq!(remaining, 0);
    output.flush()?;
    output.get_ref().sync_all()?;
    Ok(())
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
        create_backup(database, &path, include_remote, None).unwrap();
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

        let summary = create_backup(
            &database,
            &directory.path().join("second.tar.gz"),
            false,
            None,
        )
        .unwrap();
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

        let summary = restore_backup(&archive, &database, None).unwrap();
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
        let error = restore_backup(&archive, &database, None)
            .unwrap_err()
            .to_string();
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
        let error = restore_backup(&archive, &database, None)
            .unwrap_err()
            .to_string();
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

        let error = restore_backup(&archive, &directory.path().join(brand::DATABASE_FILE), None)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("absolute path") || error.contains("nested path"),
            "{error}"
        );
    }

    #[test]
    fn an_encrypted_backup_round_trips_with_the_passphrase() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = directory.path().join("encrypted.tar.gz.enc");
        let summary = create_backup(&database, &archive, false, Some("correct horse")).unwrap();
        assert!(summary.encrypted);
        assert!(is_encrypted_archive(&archive).unwrap());
        let header = std::fs::read(&archive).unwrap();
        assert!(header.starts_with(ENCRYPTED_MAGIC));
        assert!(
            !header.windows(4).any(|window| window == b"pandu.db"),
            "the encrypted archive must not expose plaintext tar entries"
        );

        let summary = restore_backup(&archive, &database, Some("correct horse")).unwrap();
        assert!(summary.encrypted);
        let store = Store::open(&database).unwrap();
        assert_eq!(
            store.get_setting("appearance.theme").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(store.list_sessions(10, 0, None).unwrap().len(), 1);
    }

    #[test]
    fn an_encrypted_backup_refuses_a_wrong_passphrase() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = directory.path().join("encrypted.tar.gz.enc");
        create_backup(&database, &archive, false, Some("correct horse")).unwrap();
        let before = std::fs::read(&database).unwrap();

        let error = restore_backup(&archive, &database, Some("battery staple"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("passphrase is wrong"), "{error}");
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }

    #[test]
    fn an_encrypted_backup_requires_a_passphrase() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = directory.path().join("encrypted.tar.gz.enc");
        create_backup(&database, &archive, false, Some("correct horse")).unwrap();
        let before = std::fs::read(&database).unwrap();

        let error = restore_backup(&archive, &database, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("encrypted"), "{error}");
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }

    #[test]
    fn archives_are_readable_only_by_the_current_user() {
        let directory = tempfile::tempdir().unwrap();
        let database = database_with_data(directory.path());
        let archive = archive(directory.path(), &database, false);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&archive).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "archive mode must be owner-only");
        }
        #[cfg(windows)]
        {
            let output = std::process::Command::new("icacls")
                .arg(&archive)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&output.stdout);
            assert!(output.status.success(), "{text}");
            let whoami = std::process::Command::new("whoami").output().unwrap();
            let user = String::from_utf8_lossy(&whoami.stdout).trim().to_string();
            assert!(
                text.to_lowercase().contains(&user.to_lowercase()),
                "missing owner ACE for {user}: {text}"
            );
            assert!(
                !text.contains("(I)"),
                "inherited ACEs remain on the archive: {text}"
            );
        }
    }

    #[test]
    fn the_default_backup_path_uses_the_documented_names() {
        let directory = tempfile::tempdir().unwrap();
        let plain = default_backup_path(directory.path(), false);
        assert_eq!(plain.parent().unwrap(), directory.path().join("backups"));
        assert!(plain.to_string_lossy().ends_with(".tar.gz"));
        let encrypted = default_backup_path(directory.path(), true);
        assert!(encrypted.to_string_lossy().ends_with(".tar.gz.enc"));
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
