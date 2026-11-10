//! Copy an existing 0.1.0 data directory into the renamed location.
//!
//! The rename must not strand local state. On first start, if the old
//! `~/.cockpit` directory exists and `~/.pandu` does not, copy the whole tree.
//! The old directory is never moved or deleted. If both exist, the new one
//! wins and nothing is copied. This is the only module allowed to mention the
//! old product name outside the frozen `legacy/` tree, the changelog, and the
//! signed production registry identity.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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
    copy_tree(old, new)?;
    rename_copied_database(new)?;
    Ok(Some(Migration {
        source: old.to_path_buf(),
        destination: new.to_path_buf(),
    }))
}

/// Give the copied database the new file name.
///
/// Only the copy is renamed; the old directory keeps its own file. The new
/// name wins if both are present, so a partially completed copy is never
/// overwritten.
fn rename_copied_database(directory: &Path) -> io::Result<()> {
    const OLD: &str = "cockpit.db";
    const NEW: &str = pandu_core::brand::DATABASE_FILE;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            rename_copied_database(&entry.path())?;
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        for suffix in ["", "-wal", "-shm"] {
            let old_name = format!("{OLD}{suffix}");
            if name != old_name {
                continue;
            }
            let target = directory.join(format!("{NEW}{suffix}"));
            if !target.exists() {
                fs::rename(entry.path(), target)?;
            }
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)?;
        }
        // Symlinks are skipped: copying them could escape the data directory.
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

    #[test]
    fn copies_when_only_the_old_directory_exists() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(old.join("v2")).unwrap();
        fs::write(old.join("v2").join("cockpit.db"), b"old data").unwrap();
        fs::write(old.join("legacy.txt"), b"kept").unwrap();

        let migration = copy_legacy_home(&old, &new).unwrap().expect("copied");

        assert_eq!(migration.source, old);
        assert_eq!(migration.destination, new);
        assert_eq!(
            fs::read(new.join("v2").join("pandu.db")).unwrap(),
            b"old data"
        );
        assert_eq!(fs::read(new.join("legacy.txt")).unwrap(), b"kept");
        // The old tree is copied, never moved or deleted.
        assert_eq!(
            fs::read(old.join("v2").join("cockpit.db")).unwrap(),
            b"old data"
        );
        assert_eq!(fs::read(old.join("legacy.txt")).unwrap(), b"kept");
    }

    #[test]
    fn an_existing_database_in_the_copy_is_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir_all(old.join("v2")).unwrap();
        fs::write(old.join("v2").join("cockpit.db"), b"old data").unwrap();
        fs::write(old.join("v2").join("pandu.db"), b"new data").unwrap();

        let migration = copy_legacy_home(&old, &new).unwrap().expect("copied");

        assert_eq!(migration.source, old);
        assert_eq!(
            fs::read(new.join("v2").join("pandu.db")).unwrap(),
            b"new data"
        );
        assert_eq!(
            fs::read(new.join("v2").join("cockpit.db")).unwrap(),
            b"old data"
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
