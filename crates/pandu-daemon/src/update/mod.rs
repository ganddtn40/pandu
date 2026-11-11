//! Update checks and update state.
//!
//! The daemon performs at most one HTTPS `GET` to the GitHub Releases API per
//! interval. It never uploads identifiers, never installs anything, and never
//! blocks the proxy. Install integrity lives in [`pandu_core::update`] and in
//! the `pandu update` command.

pub mod http;
pub mod service;

use serde::{Deserialize, Serialize};

pub use pandu_core::update::{
    ReleaseArtifact, ReleaseManifest, UpdateError, UpdateSigning, UpdateTrustRoot,
    active_update_key_id, active_update_public_key, resolve_update_trust_root, update_signing,
};

pub const STATE_IDLE: &str = "idle";
pub const STATE_UP_TO_DATE: &str = "up-to-date";
pub const STATE_AVAILABLE: &str = "available";
pub const STATE_SNOOZED: &str = "snoozed";
pub const STATE_SKIPPED: &str = "skipped";
pub const STATE_OFFLINE: &str = "offline";
pub const STATE_RATE_LIMITED: &str = "rate-limited";
pub const STATE_UNAVAILABLE: &str = "unavailable";
pub const STATE_ERROR: &str = "error";

/// The daemon's current view of updates. The UI renders this directly.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub enabled: bool,
    pub channel: String,
    pub current_version: String,
    pub state: String,
    pub latest_version: Option<String>,
    pub release_name: Option<String>,
    pub notes: Option<String>,
    pub notes_summary: Option<String>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub next_check_at: Option<String>,
    pub snoozed_until: Option<String>,
    pub skipped_version: Option<String>,
    pub trust: String,
    /// One of `test`, `production`, or `disabled`.
    pub signing: String,
    /// The exact label the UI must show for `signing`.
    pub signing_label: String,
    pub message: Option<String>,
    pub can_install: bool,
    pub install_command: String,
    pub checking: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubRelease {
    #[serde(default)]
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubAsset {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub browser_download_url: String,
    #[serde(default)]
    pub size: Option<u64>,
}

/// The latest release as the daemon remembers it between checks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    pub version: String,
    pub name: String,
    pub notes: String,
    pub notes_summary: String,
    pub release_url: String,
    pub published_at: Option<String>,
}
