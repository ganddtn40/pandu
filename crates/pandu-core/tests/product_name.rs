//! Repo-wide guard against the pre-rename product name.
//!
//! The rename is only complete when the old name survives in exactly the places
//! that must keep it: the copy-only data migration, the frozen production trust
//! root, this guard, the changelog, and the two signed production registry
//! documents. Everything else, including docs and tests, must use Pandu.

use std::fs;
use std::path::Path;
use std::process::Command;

/// Repository-relative paths allowed to contain the old name.
const ALLOWED: &[&str] = &[
    "CHANGELOG.md",
    "crates/pandu-core/tests/product_name.rs",
    "crates/pandu-daemon/src/market/legacy_key.rs",
    "crates/pandu-daemon/src/migrate.rs",
    "registry/index.json",
    "registry/revoked.json",
];

/// The frozen 0.1.0 tree is a behavior spec, not part of the current product.
const ALLOWED_PREFIX: &str = "legacy/";

#[test]
fn the_old_product_name_is_gone() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .expect("run git ls-files");
    assert!(
        output.status.success(),
        "git ls-files failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let files = String::from_utf8(output.stdout).expect("git paths are UTF-8");
    let mut offenders = Vec::new();

    for path in files.split('\0').filter(|path| !path.is_empty()) {
        let normalized = path.replace('\\', "/");
        if normalized.starts_with(ALLOWED_PREFIX) || ALLOWED.contains(&normalized.as_str()) {
            continue;
        }
        let Ok(bytes) = fs::read(root.join(path)) else {
            continue;
        };
        let Ok(contents) = String::from_utf8(bytes) else {
            continue;
        };
        for (index, line) in contents.lines().enumerate() {
            if line.to_ascii_lowercase().contains("cockpit") {
                offenders.push(format!("{normalized}:{}: {}", index + 1, line.trim()));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "the old product name is still present:\n{}",
        offenders.join("\n")
    );
}
