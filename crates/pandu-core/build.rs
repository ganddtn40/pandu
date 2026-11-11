//! Compile the single brand source (`brand.json`) into the crate.
//!
//! Every product name, identifier, path, and title in the workspace comes from
//! `brand.json`. This script turns that file into `PANDU_BRAND_*` environment
//! variables, and `brand.rs` exposes them as typed constants. Changing the
//! product name is a one-file change plus a rebuild.

use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let brand_path = manifest.join("..").join("..").join("brand.json");
    println!("cargo:rerun-if-changed={}", brand_path.display());

    let text = fs::read_to_string(&brand_path)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", brand_path.display()));
    let brand: serde_json::Value =
        serde_json::from_str(&text).expect("brand.json must be valid JSON");

    let string = |path: &[&str]| -> String {
        let mut value = &brand;
        for key in path {
            value = value
                .get(key)
                .unwrap_or_else(|| panic!("brand.json is missing `{}`", path.join(".")));
        }
        value
            .as_str()
            .unwrap_or_else(|| panic!("brand.json `{}` must be a string", path.join(".")))
            .to_string()
    };

    let number = |path: &[&str]| -> String {
        let mut value = &brand;
        for key in path {
            value = value
                .get(key)
                .unwrap_or_else(|| panic!("brand.json is missing `{}`", path.join(".")));
        }
        value
            .as_u64()
            .unwrap_or_else(|| panic!("brand.json `{}` must be a number", path.join(".")))
            .to_string()
    };

    for (key, value) in [
        ("NAME", string(&["name"])),
        ("SLUG", string(&["slug"])),
        ("WORDMARK", string(&["wordmark"])),
        ("TAGLINE", string(&["tagline"])),
        ("DISAMBIGUATION", string(&["disambiguation"])),
        ("CLI_COMMAND", string(&["cli", "command"])),
        ("CRATE_CORE", string(&["crates", "core"])),
        ("CRATE_DAEMON", string(&["crates", "daemon"])),
        ("CRATE_CLI", string(&["crates", "cli"])),
        ("ENV_PREFIX", string(&["envPrefix"])),
        ("DATA_DIR", string(&["dataDir"])),
        ("DATABASE_FILE", string(&["databaseFile"])),
        ("APP_ID", string(&["appId"])),
        ("ANDROID_PACKAGE", string(&["androidPackage"])),
        ("URL_SCHEME", string(&["urlScheme"])),
        ("REPOSITORY", string(&["repository"])),
        ("REGISTRY_URL", string(&["registry", "url"])),
        ("MARKET_KEY_ID", string(&["registry", "keyId"])),
        ("MARKET_TEST_KEY_ID", string(&["registry", "testKeyId"])),
        ("UPDATE_API_URL", string(&["update", "apiUrl"])),
        ("UPDATE_RELEASES_URL", string(&["update", "releasesUrl"])),
        ("UPDATE_CHANNEL", string(&["update", "channel"])),
        ("UPDATE_KEY_ID", string(&["update", "keyId"])),
        ("UPDATE_TEST_KEY_ID", string(&["update", "testKeyId"])),
        (
            "UPDATE_MANIFEST_ASSET",
            string(&["update", "manifestAsset"]),
        ),
        (
            "UPDATE_INTERVAL_HOURS",
            number(&["update", "intervalHours"]),
        ),
        ("THEME_SCHEMA", string(&["themeSchema"])),
        ("STORAGE_PREFIX", string(&["storagePrefix"])),
        ("WINDOW_TITLE", string(&["windowTitle"])),
        ("TRAY_TOOLTIP", string(&["trayTooltip"])),
        ("NOTIFICATION_TITLE", string(&["notificationTitle"])),
        ("LOGO_ARIA_LABEL", string(&["logoAriaLabel"])),
    ] {
        println!("cargo:rustc-env=PANDU_BRAND_{key}={value}");
    }
}
