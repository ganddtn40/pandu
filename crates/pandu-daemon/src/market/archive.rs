//! Safe archive handling and normalized content hashing.
//!
//! The install pipeline accepts a GitHub tarball (or, in debug builds only, a
//! local fixture tree). Extraction rejects absolute paths, `..`, links,
//! Windows reserved names, case collisions, over-long paths, and archives that
//! exceed the size or file-count limits.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

use super::{
    MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES, MAX_EXTRACTED_BYTES, MAX_FILE_BYTES, MarketError, hex,
    is_windows_reserved,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

pub fn tree_hash(files: &[ExtractedFile]) -> String {
    let mut sorted: Vec<&ExtractedFile> = files.iter().collect();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    let mut hasher = Sha256::new();
    for file in sorted {
        hasher.update((file.path.len() as u64).to_be_bytes());
        hasher.update(file.path.as_bytes());
        hasher.update((file.bytes.len() as u64).to_be_bytes());
        hasher.update(&file.bytes);
    }
    hex(&hasher.finalize())
}

pub fn verify_tree(files: &[ExtractedFile], expected: &str) -> Result<(), MarketError> {
    let actual = tree_hash(files);
    if actual != expected {
        return Err(MarketError::Archive(format!(
            "The downloaded files do not match the pinned content hash. \
             Expected {expected}, got {actual}. Pandu refused to install them."
        )));
    }
    Ok(())
}

pub fn extract_tar_gz(bytes: &[u8]) -> Result<Vec<ExtractedFile>, MarketError> {
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(MarketError::Archive(format!(
            "The archive is larger than {} MiB.",
            MAX_ARCHIVE_BYTES / 1024 / 1024
        )));
    }
    let decoder = GzDecoder::new(bytes);
    let limited = decoder.take(MAX_EXTRACTED_BYTES + 1);
    let mut archive = tar::Archive::new(limited);
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut seen = BTreeSet::new();
    let entries = archive
        .entries()
        .map_err(|error| MarketError::Archive(format!("The archive could not be read: {error}")))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            MarketError::Archive(format!("An archive entry is invalid: {error}"))
        })?;
        let entry_type = entry.header().entry_type();
        if matches!(
            entry_type,
            tar::EntryType::XGlobalHeader
                | tar::EntryType::XHeader
                | tar::EntryType::GNULongName
                | tar::EntryType::GNULongLink
        ) {
            continue;
        }
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(MarketError::Archive(
                "The archive contains a link. Links are never extracted.".into(),
            ));
        }
        if entry_type.is_dir() {
            continue;
        }
        if !entry_type.is_file() {
            return Err(MarketError::Archive(
                "The archive contains an unsupported entry type.".into(),
            ));
        }
        let size = entry.header().size().unwrap_or(u64::MAX);
        if size > MAX_FILE_BYTES {
            return Err(MarketError::Archive(format!(
                "An archive file is larger than {} MiB.",
                MAX_FILE_BYTES / 1024 / 1024
            )));
        }
        let path = entry.path().map_err(|error| {
            MarketError::Archive(format!("An archive path is invalid: {error}"))
        })?;
        let path = normalize_archive_path(&path)?;
        let key = path.to_ascii_lowercase();
        if !seen.insert(key) {
            return Err(MarketError::Archive(format!(
                "The archive contains a duplicate or case-colliding path: {path}"
            )));
        }
        total = total.saturating_add(size);
        if total > MAX_EXTRACTED_BYTES {
            return Err(MarketError::Archive(format!(
                "The archive expands past {} MiB.",
                MAX_EXTRACTED_BYTES / 1024 / 1024
            )));
        }
        let mut buffer = Vec::with_capacity(size.min(64 * 1024) as usize);
        entry
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut buffer)
            .map_err(|error| {
                MarketError::Archive(format!("An archive file could not be read: {error}"))
            })?;
        if buffer.len() as u64 > MAX_FILE_BYTES {
            return Err(MarketError::Archive(
                "An archive file expanded past the per-file limit.".into(),
            ));
        }
        files.push(ExtractedFile {
            path,
            bytes: buffer,
        });
        if files.len() > MAX_ARCHIVE_FILES {
            return Err(MarketError::Archive(format!(
                "The archive contains more than {MAX_ARCHIVE_FILES} files."
            )));
        }
    }
    if files.is_empty() {
        return Err(MarketError::Archive(
            "The archive contains no files.".into(),
        ));
    }
    strip_common_prefix(files)
}

/// GitHub tarballs wrap everything in `<owner>-<repo>-<sha>/`. Strip a common
/// top-level directory when every file shares one.
fn strip_common_prefix(files: Vec<ExtractedFile>) -> Result<Vec<ExtractedFile>, MarketError> {
    let Some(first) = files.first() else {
        return Ok(files);
    };
    let prefix = first.path.split_once('/').map(|(prefix, _)| prefix);
    let Some(prefix) = prefix else {
        return Ok(files);
    };
    if prefix.is_empty() {
        return Ok(files);
    }
    let prefix = prefix.to_string();
    let prefix_with_slash = format!("{prefix}/");
    let all_share = files
        .iter()
        .all(|file| file.path.starts_with(&prefix_with_slash));
    if !all_share {
        return Ok(files);
    }
    let mut stripped = Vec::with_capacity(files.len());
    for file in files {
        let path = file
            .path
            .strip_prefix(&prefix_with_slash)
            .unwrap_or(&file.path)
            .to_string();
        if path.is_empty() {
            continue;
        }
        stripped.push(ExtractedFile {
            path,
            bytes: file.bytes,
        });
    }
    Ok(stripped)
}

fn normalize_archive_path(path: &Path) -> Result<String, MarketError> {
    let raw = path.to_string_lossy().replace('\\', "/");
    if raw.contains('\0') || raw.contains(':') {
        return Err(MarketError::Archive(format!(
            "Archive path `{raw}` contains a NUL or drive separator."
        )));
    }
    if raw.starts_with('/') || raw.starts_with("//") {
        return Err(MarketError::Archive(format!(
            "Archive path `{raw}` is absolute."
        )));
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(MarketError::Archive(format!(
                "Archive path `{raw}` escapes the extraction root."
            )));
        }
        if part.len() > 200 {
            return Err(MarketError::Archive(
                "An archive path component is longer than 200 characters.".into(),
            ));
        }
        if is_windows_reserved(part) {
            return Err(MarketError::Archive(format!(
                "Archive path `{raw}` uses a Windows reserved name."
            )));
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err(MarketError::Archive("An archive path is empty.".into()));
    }
    let normalized = parts.join("/");
    if normalized.len() > 1_024 {
        return Err(MarketError::Archive(
            "An archive path is longer than 1024 characters.".into(),
        ));
    }
    Ok(normalized)
}

/// Read a local fixture tree. Only used by tests and debug builds.
pub fn read_local_tree(root: &Path) -> Result<Vec<ExtractedFile>, MarketError> {
    let mut files = Vec::new();
    let mut total = 0u64;
    walk(root, root, &mut files, &mut total)?;
    if files.is_empty() {
        return Err(MarketError::Archive(
            "The local source tree is empty.".into(),
        ));
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn walk(
    root: &Path,
    directory: &Path,
    files: &mut Vec<ExtractedFile>,
    total: &mut u64,
) -> Result<(), MarketError> {
    let entries = std::fs::read_dir(directory).map_err(|error| {
        MarketError::Archive(format!("Could not read {}: {error}", directory.display()))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            MarketError::Archive(format!("Could not read a directory entry: {error}"))
        })?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            MarketError::Archive(format!("Could not inspect {}: {error}", path.display()))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(MarketError::Archive(format!(
                "The local source contains a link: {}",
                path.display()
            )));
        }
        if metadata.is_dir() {
            walk(root, &path, files, total)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(MarketError::Archive(format!(
                "The local source contains an unsupported entry: {}",
                path.display()
            )));
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(MarketError::Archive(format!(
                "{} is larger than the per-file limit.",
                path.display()
            )));
        }
        *total = total.saturating_add(metadata.len());
        if *total > MAX_EXTRACTED_BYTES {
            return Err(MarketError::Archive(
                "The local source exceeds the extraction limit.".into(),
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| MarketError::Archive("A local source path escaped its root.".into()))?;
        let normalized = normalize_archive_path(relative)?;
        let bytes = std::fs::read(&path).map_err(|error| {
            MarketError::Archive(format!("Could not read {}: {error}", path.display()))
        })?;
        files.push(ExtractedFile {
            path: normalized,
            bytes,
        });
        if files.len() > MAX_ARCHIVE_FILES {
            return Err(MarketError::Archive(format!(
                "The local source contains more than {MAX_ARCHIVE_FILES} files."
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(entries: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, bytes, kind) in entries {
            // Write the name directly into the header. `Header::set_path`
            // refuses traversal and over-long names, which is exactly what
            // these tests need to feed the extractor.
            assert!(path.len() < 100, "test path must fit the tar name field");
            let mut header = tar::Header::new_gnu();
            header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
            header.set_size(bytes.len() as u64);
            header.set_entry_type(*kind);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, *bytes).unwrap();
        }
        let tar = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn strips_github_prefix_and_hashes_deterministically() {
        let bytes = archive(&[
            ("owner-repo-sha/SKILL.md", b"# hi", tar::EntryType::Regular),
            (
                "owner-repo-sha/scripts/run.sh",
                b"echo hi",
                tar::EntryType::Regular,
            ),
        ]);
        let files = extract_tar_gz(&bytes).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "SKILL.md");
        assert_eq!(
            tree_hash(&files),
            tree_hash(&files.clone().into_iter().rev().collect::<Vec<_>>())
        );
    }

    #[test]
    fn rejects_traversal_absolute_links_and_reserved_names() {
        for path in ["../evil", "/etc/passwd", "CON", "dir/LPT1.txt"] {
            let bytes = archive(&[(path, b"x", tar::EntryType::Regular)]);
            assert!(extract_tar_gz(&bytes).is_err(), "{path}");
        }
        let bytes = archive(&[("link", b"/etc/passwd", tar::EntryType::Symlink)]);
        assert!(extract_tar_gz(&bytes).is_err());
    }

    #[test]
    fn rejects_case_collisions() {
        let bytes = archive(&[
            ("SKILL.md", b"a", tar::EntryType::Regular),
            ("skill.md", b"b", tar::EntryType::Regular),
        ]);
        assert!(extract_tar_gz(&bytes).is_err());
    }

    #[test]
    fn rejects_overlong_paths() {
        let long_component = format!("{}/x", "a".repeat(201));
        assert!(normalize_archive_path(Path::new(&long_component)).is_err());
        let long_path = vec!["abcd"; 300].join("/");
        assert!(normalize_archive_path(Path::new(&long_path)).is_err());
    }

    #[test]
    fn rejects_absolute_and_drive_qualified_paths() {
        for path in ["/etc/passwd", "C:/Windows/System32/drivers/etc/hosts"] {
            assert!(normalize_archive_path(Path::new(path)).is_err(), "{path}");
        }
    }
}
