//! Update manifests, release-note sanitizing, and artifact verification.
//!
//! An update is untrusted input. A release manifest names a version, a channel,
//! and one artifact per platform. Every artifact is pinned by a SHA-256 digest
//! and a Minisign signature. The manifest itself is signed over a canonical
//! JSON payload so a mirror cannot swap the version, notes, or artifact list
//! without the updater key.
//!
//! Trust roots mirror the market: debug and test builds embed only the test
//! key; release builds embed only an optional production key and fail closed
//! when it is absent. A release build never falls back to the test key.

use std::collections::BTreeMap;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use regex::Regex;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::brand;

pub const UPDATE_MANIFEST_SCHEMA: u32 = 1;
pub const MAX_MANIFEST_BYTES: usize = 512 * 1024;
pub const MAX_NOTES_CHARS: usize = 12_000;
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

/// Production updater public key, when the maintainer has provisioned one.
///
/// No production updater key exists yet. Release builds therefore embed no key
/// and fail closed with [`UPDATE_PREPARING_MESSAGE`]. Follow
/// `docs/RELEASING.md` to create the key offline and fill this in. The matching
/// private key never belongs in this repository, CI, logs, or an agent session.
pub const PRODUCTION_UPDATER_PUBLIC_KEY_BASE64: Option<&str> = None;
pub const PRODUCTION_UPDATER_KEY_ID: &str = brand::UPDATE_KEY_ID;

/// Test updater public key. It signs only test fixtures and debug builds. The
/// matching seed lives in [`test_signing`] and is never compiled into a release
/// build.
pub const TEST_UPDATER_PUBLIC_KEY_BASE64: &str =
    "RWTis6utEobHm0NNk3waeSEbTirnP1Ev+yScZuDnFnyr4+pfiRCarrLi";
pub const TEST_UPDATER_KEY_ID: &str = brand::UPDATE_TEST_KEY_ID;

/// The message shown when a release build has no production updater key.
pub const UPDATE_PREPARING_MESSAGE: &str =
    "Updates are not available in this build because no production updater key is embedded.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateTrustRoot {
    /// A key is embedded for this build mode and may verify an update.
    Ready,
    /// A release build has no production key. Fail closed.
    Preparing,
    /// A release build embedded the test key or another unusable key.
    Refused,
}

impl UpdateTrustRoot {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Preparing => "preparing",
            Self::Refused => "refused",
        }
    }
}

/// Resolve the trust root from the build mode and the optional production key.
///
/// Pure so tests can prove a release configuration with no key is `Preparing`
/// and can never become `Ready` by falling back to the test key.
pub fn resolve_update_trust_root(debug: bool, production_key: Option<&str>) -> UpdateTrustRoot {
    if debug {
        return UpdateTrustRoot::Ready;
    }
    match production_key.map(str::trim).filter(|key| !key.is_empty()) {
        None => UpdateTrustRoot::Preparing,
        Some(key) if key == TEST_UPDATER_PUBLIC_KEY_BASE64 => UpdateTrustRoot::Refused,
        Some(_) => UpdateTrustRoot::Ready,
    }
}

/// What the build can truthfully say about update signing.
///
/// This is deliberately separate from [`UpdateTrustRoot`]: the UI needs one
/// exact label per build state, while verification only needs to know whether a
/// key may be used at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateSigning {
    /// A debug build that can verify test-signed fixtures.
    TestKey,
    /// A release build with a provisioned production key.
    ProductionKey,
    /// A release build without a usable production key. Updates are disabled.
    Disabled,
}

impl UpdateSigning {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TestKey => "test",
            Self::ProductionKey => "production",
            Self::Disabled => "disabled",
        }
    }

    /// The exact label the UI must show for this state.
    pub fn label(self) -> &'static str {
        match self {
            Self::TestKey => "Test key (development)",
            Self::ProductionKey => "Signed updates ready (production key)",
            Self::Disabled => "No production key: updates disabled",
        }
    }
}

/// Map the build mode and production key to the label the UI shows.
///
/// A release build that embeds the test key reports `Disabled`: it has no
/// production key and refuses every update.
pub fn update_signing(debug: bool, production_key: Option<&str>) -> UpdateSigning {
    if debug {
        return UpdateSigning::TestKey;
    }
    match resolve_update_trust_root(false, production_key) {
        UpdateTrustRoot::Ready => UpdateSigning::ProductionKey,
        UpdateTrustRoot::Preparing | UpdateTrustRoot::Refused => UpdateSigning::Disabled,
    }
}

/// The public key this build may use, or `None` when it must fail closed.
pub fn active_update_public_key(debug: bool) -> Option<&'static str> {
    match resolve_update_trust_root(debug, PRODUCTION_UPDATER_PUBLIC_KEY_BASE64) {
        UpdateTrustRoot::Ready if debug => Some(TEST_UPDATER_PUBLIC_KEY_BASE64),
        UpdateTrustRoot::Ready => PRODUCTION_UPDATER_PUBLIC_KEY_BASE64,
        UpdateTrustRoot::Preparing | UpdateTrustRoot::Refused => None,
    }
}

/// The logical key id this build expects in a manifest.
pub fn active_update_key_id(debug: bool) -> &'static str {
    if debug {
        TEST_UPDATER_KEY_ID
    } else {
        PRODUCTION_UPDATER_KEY_ID
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    Manifest(String),
    Signature(String),
    Checksum(String),
    UnsafeUrl(String),
    Version(String),
    Trust(String),
    TooLarge(String),
    Io(String),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Manifest(message)
            | Self::Signature(message)
            | Self::Checksum(message)
            | Self::UnsafeUrl(message)
            | Self::Version(message)
            | Self::Trust(message)
            | Self::TooLarge(message)
            | Self::Io(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for UpdateError {}

/// One downloadable artifact, pinned by digest and signature.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArtifact {
    pub url: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// A complete Minisign signature (untrusted comment, packet, trusted
    /// comment, global signature).
    pub signature: String,
}

/// A signed release manifest, served as a release asset.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub schema: u32,
    pub channel: String,
    pub version: String,
    pub key_id: String,
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(default)]
    pub artifacts: BTreeMap<String, ReleaseArtifact>,
    /// Minisign signature over the canonical payload without this field.
    #[serde(default)]
    pub signature: String,
}

/// The exact bytes a manifest signature covers.
///
/// Field order is fixed by this struct and artifact keys are sorted by
/// `BTreeMap`, so signing and verification agree across platforms and
/// serializers. Release notes are signed raw, before sanitizing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestPayload<'a> {
    schema: u32,
    channel: &'a str,
    version: &'a str,
    key_id: &'a str,
    notes: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<&'a str>,
    artifacts: &'a BTreeMap<String, ReleaseArtifact>,
}

pub fn manifest_signing_payload(manifest: &ReleaseManifest) -> Vec<u8> {
    serde_json::to_vec(&ManifestPayload {
        schema: manifest.schema,
        channel: &manifest.channel,
        version: &manifest.version,
        key_id: &manifest.key_id,
        notes: &manifest.notes,
        published_at: manifest.published_at.as_deref(),
        artifacts: &manifest.artifacts,
    })
    .expect("a release manifest always serializes")
}

/// Parse, validate, and verify a manifest against the embedded trust root.
///
/// The returned manifest has sanitized notes. Verification happens before
/// sanitizing so the signature covers exactly the bytes the publisher signed.
pub fn parse_manifest(
    bytes: &[u8],
    public_key_base64: &str,
    expected_key_id: &str,
) -> Result<ReleaseManifest, UpdateError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge(format!(
            "The update manifest is larger than {} KB.",
            MAX_MANIFEST_BYTES / 1024
        )));
    }
    let mut manifest: ReleaseManifest = serde_json::from_slice(bytes).map_err(|error| {
        UpdateError::Manifest(format!("The update manifest is not valid JSON: {error}"))
    })?;
    validate_manifest(&manifest, expected_key_id)?;
    if manifest.signature.trim().is_empty() {
        return Err(UpdateError::Signature(
            "The update manifest is unsigned. Refusing to install it.".into(),
        ));
    }
    let payload = manifest_signing_payload(&manifest);
    verify_minisign(&payload, &manifest.signature, public_key_base64)?;
    manifest.notes = sanitize_release_notes(&manifest.notes);
    Ok(manifest)
}

fn validate_manifest(manifest: &ReleaseManifest, expected_key_id: &str) -> Result<(), UpdateError> {
    if manifest.schema != UPDATE_MANIFEST_SCHEMA {
        return Err(UpdateError::Manifest(format!(
            "The update manifest uses schema {}, but this build understands {}.",
            manifest.schema, UPDATE_MANIFEST_SCHEMA
        )));
    }
    if manifest.channel != brand::UPDATE_CHANNEL {
        return Err(UpdateError::Manifest(format!(
            "This update is for the {} channel. This build follows the {} channel.",
            manifest.channel,
            brand::UPDATE_CHANNEL
        )));
    }
    if manifest.key_id != expected_key_id {
        return Err(UpdateError::Signature(format!(
            "The update was signed for key id `{}`, but this build trusts `{}`.",
            manifest.key_id, expected_key_id
        )));
    }
    parse_version(&manifest.version)?;
    if manifest.artifacts.is_empty() {
        return Err(UpdateError::Manifest(
            "The update manifest lists no artifacts.".into(),
        ));
    }
    for (target, artifact) in &manifest.artifacts {
        if target.trim().is_empty() || target.len() > 80 {
            return Err(UpdateError::Manifest(
                "The update manifest has an invalid artifact target.".into(),
            ));
        }
        safe_https_url(&artifact.url)?;
        if artifact.sha256.len() != 64
            || !artifact
                .sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(UpdateError::Manifest(format!(
                "The update artifact for {target} has an invalid SHA-256 digest."
            )));
        }
        if artifact.signature.trim().is_empty() {
            return Err(UpdateError::Signature(format!(
                "The update artifact for {target} is unsigned. Refusing to install it."
            )));
        }
        if artifact.size.is_some_and(|size| size > MAX_ARTIFACT_BYTES) {
            return Err(UpdateError::TooLarge(format!(
                "The update artifact for {target} is larger than {} MB.",
                MAX_ARTIFACT_BYTES / (1024 * 1024)
            )));
        }
    }
    Ok(())
}

/// The artifact target for the running build, for example `windows-x86_64`.
pub fn current_target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

pub fn select_artifact<'a>(
    manifest: &'a ReleaseManifest,
    target: &str,
) -> Result<&'a ReleaseArtifact, UpdateError> {
    manifest.artifacts.get(target).ok_or_else(|| {
        UpdateError::Manifest(format!(
            "This release has no update artifact for {target}. Download it from {} instead.",
            brand::UPDATE_RELEASES_URL
        ))
    })
}

/// Require an HTTPS URL with a real host and no embedded credentials.
pub fn safe_https_url(value: &str) -> Result<(), UpdateError> {
    let value = value.trim();
    if !value.starts_with("https://") {
        return Err(UpdateError::UnsafeUrl(
            "Update downloads must use https:// URLs.".into(),
        ));
    }
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(UpdateError::UnsafeUrl(
            "The update URL contains whitespace or control characters.".into(),
        ));
    }
    let authority = value
        .strip_prefix("https://")
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || authority.starts_with(':') {
        return Err(UpdateError::UnsafeUrl(
            "The update URL does not name a plain host.".into(),
        ));
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

/// Verify the digest and Minisign signature for one artifact.
pub fn verify_artifact(
    bytes: &[u8],
    artifact: &ReleaseArtifact,
    public_key_base64: &str,
) -> Result<(), UpdateError> {
    if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        return Err(UpdateError::TooLarge(format!(
            "The update artifact is larger than {} MB.",
            MAX_ARTIFACT_BYTES / (1024 * 1024)
        )));
    }
    let actual = sha256_hex(bytes);
    if !actual.eq_ignore_ascii_case(artifact.sha256.trim()) {
        return Err(UpdateError::Checksum(format!(
            "The update download is damaged: expected SHA-256 {}, got {actual}.",
            artifact.sha256
        )));
    }
    verify_minisign(bytes, &artifact.signature, public_key_base64)
}

fn verify_minisign(
    bytes: &[u8],
    signature_text: &str,
    public_key_base64: &str,
) -> Result<(), UpdateError> {
    let public_key = PublicKey::from_base64(public_key_base64.trim())
        .map_err(|_| UpdateError::Signature("The embedded updater key is invalid.".into()))?;
    let signature = Signature::decode(signature_text)
        .map_err(|_| UpdateError::Signature("The update signature is malformed.".into()))?;
    public_key.verify(bytes, &signature, false).map_err(|_| {
        UpdateError::Signature(
            "The update signature does not match the embedded updater key. Refusing to install it."
                .into(),
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionRelation {
    Newer,
    Same,
    Older,
}

pub fn parse_version(value: &str) -> Result<Version, UpdateError> {
    let trimmed = value.trim();
    let trimmed = trimmed.strip_prefix('v').unwrap_or(trimmed);
    Version::parse(trimmed).map_err(|_| {
        UpdateError::Version(format!(
            "`{value}` is not a valid version. Expected a SemVer version such as 1.2.3."
        ))
    })
}

pub fn compare_versions(current: &str, candidate: &str) -> Result<VersionRelation, UpdateError> {
    let current = parse_version(current)?;
    let candidate = parse_version(candidate)?;
    Ok(match candidate.cmp(&current) {
        std::cmp::Ordering::Greater => VersionRelation::Newer,
        std::cmp::Ordering::Equal => VersionRelation::Same,
        std::cmp::Ordering::Less => VersionRelation::Older,
    })
}

/// Refuse anything that is not a strict upgrade.
pub fn require_upgrade(current: &str, candidate: &str) -> Result<(), UpdateError> {
    match compare_versions(current, candidate)? {
        VersionRelation::Newer => Ok(()),
        VersionRelation::Same => Err(UpdateError::Version(format!(
            "{} {candidate} is already installed.",
            brand::PRODUCT_NAME
        ))),
        VersionRelation::Older => Err(UpdateError::Version(format!(
            "Refusing to downgrade from {current} to {candidate}. \
             Downgrades are never installed automatically."
        ))),
    }
}

/// Strip raw HTML, remote images, and control characters from release notes.
///
/// The UI renders notes as text, never as HTML or Markdown. This function is
/// still the trust boundary: it removes tags, comments, and image syntax so a
/// release body cannot smuggle a remote image or an executable fragment into a
/// future renderer.
pub fn sanitize_release_notes(raw: &str) -> String {
    let without_comments = Regex::new(r"(?s)<!--.*?-->")
        .expect("a fixed HTML comment pattern")
        .replace_all(raw, "");
    let without_images = Regex::new(r"!\[[^\]]*\]\([^)]*\)")
        .expect("a fixed Markdown image pattern")
        .replace_all(&without_comments, "");
    let without_tags = Regex::new(r"<[^>]*>")
        .expect("a fixed HTML tag pattern")
        .replace_all(&without_images, "");
    let mut cleaned = String::with_capacity(without_tags.len());
    for character in without_tags.chars() {
        match character {
            '\r' => {}
            '\n' | '\t' => cleaned.push(character),
            character if character.is_control() => {}
            character => cleaned.push(character),
        }
    }
    let mut lines: Vec<&str> = cleaned.lines().collect();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let mut collapsed = String::new();
    let mut blank_run = 0;
    for line in lines {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        collapsed.push_str(line.trim_end());
        collapsed.push('\n');
    }
    let collapsed = collapsed.trim_end().to_string();
    truncate_chars(&collapsed, MAX_NOTES_CHARS)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(limit.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

/// A compact, single-line summary for a notification or a card.
pub fn notes_summary(notes: &str, limit: usize) -> String {
    let first = notes
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    truncate_chars(first, limit)
}

/// Encode a Minisign signature packet. Maintainer tooling only.
pub fn encode_minisign_signature(
    seed: &[u8; 32],
    bytes: &[u8],
    trusted_comment: &str,
) -> Result<String, UpdateError> {
    use blake2::Digest as _;
    use ed25519_dalek::{Signer, SigningKey};

    let signing_key = SigningKey::from_bytes(seed);
    let verifying_key = signing_key.verifying_key();
    let key_id = minisign_key_id(verifying_key.as_bytes());
    let digest = blake2::Blake2b512::digest(bytes);
    let signature = signing_key.sign(digest.as_slice());
    let mut packet = Vec::with_capacity(74);
    packet.extend_from_slice(b"ED");
    packet.extend_from_slice(&key_id);
    packet.extend_from_slice(&signature.to_bytes());
    let mut global_input = Vec::with_capacity(64 + trusted_comment.len());
    global_input.extend_from_slice(&signature.to_bytes());
    global_input.extend_from_slice(trusted_comment.as_bytes());
    let global = signing_key.sign(&global_input);
    Ok(format!(
        "untrusted comment: signature from {} updater test key\n{}\ntrusted comment: {}\n{}",
        brand::SLUG,
        base64::engine::general_purpose::STANDARD.encode(packet),
        trusted_comment,
        base64::engine::general_purpose::STANDARD.encode(global.to_bytes())
    ))
}

/// The 8-byte Minisign key id derived from the public key.
pub fn minisign_key_id(public_key: &[u8; 32]) -> [u8; 8] {
    let digest = Sha256::digest(public_key);
    let mut key_id = [0u8; 8];
    key_id.copy_from_slice(&digest[..8]);
    key_id
}

/// Build the public-key packet Minisign expects, for maintainer tooling.
pub fn minisign_public_key(seed: &[u8; 32]) -> String {
    use ed25519_dalek::SigningKey;
    let signing_key = SigningKey::from_bytes(seed);
    let public = signing_key.verifying_key();
    let key_id = minisign_key_id(public.as_bytes());
    let mut packet = Vec::with_capacity(42);
    packet.extend_from_slice(b"Ed");
    packet.extend_from_slice(&key_id);
    packet.extend_from_slice(public.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(packet)
}

/// Deterministic signing helpers for tests and fixtures.
///
/// This module is compiled only for tests or with the `test-signing` feature.
/// The seed is a test key and is never accepted by a release build.
#[cfg(any(test, feature = "test-signing"))]
pub mod test_signing {
    use super::*;

    pub const TEST_SEED_HEX: &str =
        "f242edc50e8f8918d4867651ce1137c36abee7ac50307e29e092b45b6588552c";

    pub fn seed() -> [u8; 32] {
        let bytes = hex_bytes(TEST_SEED_HEX).expect("the test seed is valid hex");
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&bytes);
        seed
    }

    pub fn public_key() -> String {
        minisign_public_key(&seed())
    }

    pub fn sign(bytes: &[u8], trusted_comment: &str) -> String {
        encode_minisign_signature(&seed(), bytes, trusted_comment).expect("test signing works")
    }

    pub fn artifact(bytes: &[u8], url: &str) -> ReleaseArtifact {
        ReleaseArtifact {
            url: url.to_string(),
            sha256: sha256_hex(bytes),
            size: Some(bytes.len() as u64),
            signature: sign(bytes, "timestamp:0\tfile:test\tprehashed"),
        }
    }

    pub fn manifest(version: &str, bytes: &[u8]) -> ReleaseManifest {
        let target = current_target();
        let mut artifacts = BTreeMap::new();
        artifacts.insert(target, artifact(bytes, "https://example.com/pandu.zip"));
        let mut manifest = ReleaseManifest {
            schema: UPDATE_MANIFEST_SCHEMA,
            channel: brand::UPDATE_CHANNEL.to_string(),
            version: version.to_string(),
            key_id: TEST_UPDATER_KEY_ID.to_string(),
            notes: "A test release.".to_string(),
            published_at: Some("2026-01-01T00:00:00Z".to_string()),
            artifacts,
            signature: String::new(),
        };
        let payload = manifest_signing_payload(&manifest);
        manifest.signature = sign(&payload, "timestamp:0\tfile:manifest\tprehashed");
        manifest
    }

    fn hex_bytes(value: &str) -> Option<Vec<u8>> {
        if value.len() % 2 != 0 {
            return None;
        }
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_public_key_matches_the_test_seed() {
        assert_eq!(test_signing::public_key(), TEST_UPDATER_PUBLIC_KEY_BASE64);
        assert_ne!(TEST_UPDATER_PUBLIC_KEY_BASE64, "test");
    }

    #[test]
    fn a_release_without_a_production_key_fails_closed() {
        assert_eq!(
            resolve_update_trust_root(false, None),
            UpdateTrustRoot::Preparing
        );
        assert_eq!(
            resolve_update_trust_root(false, Some("   ")),
            UpdateTrustRoot::Preparing
        );
        assert_eq!(active_update_public_key(false), None);
    }

    #[test]
    fn a_release_never_falls_back_to_the_test_key() {
        assert_eq!(
            resolve_update_trust_root(false, Some(TEST_UPDATER_PUBLIC_KEY_BASE64)),
            UpdateTrustRoot::Refused
        );
        assert_eq!(
            resolve_update_trust_root(false, Some("a-production-key")),
            UpdateTrustRoot::Ready
        );
        assert_eq!(
            resolve_update_trust_root(true, None),
            UpdateTrustRoot::Ready
        );
    }

    #[test]
    fn the_signing_label_is_exact_for_each_build_state() {
        assert_eq!(update_signing(true, None).label(), "Test key (development)");
        assert_eq!(
            update_signing(false, Some("a-production-key")).label(),
            "Signed updates ready (production key)"
        );
        assert_eq!(
            update_signing(false, None).label(),
            "No production key: updates disabled"
        );
        assert_eq!(
            update_signing(false, Some("   ")).label(),
            "No production key: updates disabled"
        );
        assert_eq!(
            update_signing(false, Some(TEST_UPDATER_PUBLIC_KEY_BASE64)).label(),
            "No production key: updates disabled"
        );
        assert_eq!(update_signing(true, None).as_str(), "test");
        assert_eq!(
            update_signing(false, Some("a-production-key")).as_str(),
            "production"
        );
        assert_eq!(update_signing(false, None).as_str(), "disabled");
    }

    #[test]
    fn the_test_key_and_production_key_ids_are_distinct() {
        assert_ne!(TEST_UPDATER_KEY_ID, PRODUCTION_UPDATER_KEY_ID);
        assert_ne!(
            PRODUCTION_UPDATER_KEY_ID,
            brand::MARKET_KEY_ID,
            "updater keys must be separate from registry keys"
        );
        assert_ne!(TEST_UPDATER_KEY_ID, brand::MARKET_TEST_KEY_ID);
    }

    #[test]
    fn release_notes_lose_html_and_remote_images() {
        let raw = "<h1>Fixed</h1>\n\n![diagram](https://example.com/x.png)\n\n<script>alert(1)</script>Keep this.";
        let notes = sanitize_release_notes(raw);
        assert!(!notes.contains('<'));
        assert!(!notes.contains("!["));
        assert!(!notes.contains("example.com/x.png"));
        assert!(notes.contains("Fixed"));
        assert!(notes.contains("Keep this."));
    }

    #[test]
    fn release_notes_are_truncated_on_a_character_boundary() {
        let raw = "a".repeat(MAX_NOTES_CHARS + 10);
        let notes = sanitize_release_notes(&raw);
        assert_eq!(notes.chars().count(), MAX_NOTES_CHARS);
        assert!(notes.ends_with('…'));
    }

    #[test]
    fn only_https_download_urls_are_allowed() {
        assert!(safe_https_url("https://github.com/x/y.zip").is_ok());
        assert!(safe_https_url("http://github.com/x/y.zip").is_err());
        assert!(safe_https_url("https://user@github.com/x").is_err());
        assert!(safe_https_url("https://").is_err());
        assert!(safe_https_url("https://github.com/a b").is_err());
    }

    #[test]
    fn versions_are_compared_with_semver() {
        assert_eq!(
            compare_versions("0.2.0", "0.3.0").unwrap(),
            VersionRelation::Newer
        );
        assert_eq!(
            compare_versions("v0.3.0", "0.3.0").unwrap(),
            VersionRelation::Same
        );
        assert_eq!(
            compare_versions("0.4.0", "0.3.9").unwrap(),
            VersionRelation::Older
        );
        assert!(require_upgrade("0.4.0", "0.3.9").is_err());
        assert!(require_upgrade("0.4.0", "0.4.0").is_err());
        assert!(require_upgrade("0.4.0", "0.4.1").is_ok());
    }

    #[test]
    fn a_signed_manifest_round_trips() {
        let bytes = b"the artifact";
        let manifest = test_signing::manifest("0.3.0", bytes);
        let json = serde_json::to_vec(&manifest).unwrap();
        let parsed = parse_manifest(&json, TEST_UPDATER_PUBLIC_KEY_BASE64, TEST_UPDATER_KEY_ID)
            .expect("the test manifest verifies");
        assert_eq!(parsed.version, "0.3.0");
        assert_eq!(parsed.notes, "A test release.");
    }

    #[test]
    fn a_tampered_manifest_is_refused() {
        let bytes = b"the artifact";
        let mut manifest = test_signing::manifest("0.3.0", bytes);
        manifest.version = "9.9.9".to_string();
        let json = serde_json::to_vec(&manifest).unwrap();
        assert!(
            parse_manifest(&json, TEST_UPDATER_PUBLIC_KEY_BASE64, TEST_UPDATER_KEY_ID).is_err()
        );
    }

    #[test]
    fn an_unsigned_manifest_is_refused() {
        let mut manifest = test_signing::manifest("0.3.0", b"x");
        manifest.signature.clear();
        let json = serde_json::to_vec(&manifest).unwrap();
        assert!(
            parse_manifest(&json, TEST_UPDATER_PUBLIC_KEY_BASE64, TEST_UPDATER_KEY_ID).is_err()
        );
    }

    #[test]
    fn an_artifact_with_the_wrong_digest_is_refused() {
        let bytes = b"the artifact";
        let mut artifact = test_signing::artifact(bytes, "https://example.com/a.zip");
        artifact.sha256 = "0".repeat(64);
        assert!(matches!(
            verify_artifact(bytes, &artifact, TEST_UPDATER_PUBLIC_KEY_BASE64),
            Err(UpdateError::Checksum(_))
        ));
    }

    #[test]
    fn an_artifact_with_a_broken_signature_is_refused() {
        let bytes = b"the artifact";
        let mut artifact = test_signing::artifact(bytes, "https://example.com/a.zip");
        let mut lines: Vec<&str> = artifact.signature.lines().collect();
        let packet = lines[1].to_string();
        let mut packet = packet.into_bytes();
        packet[0] = if packet[0] == b'A' { b'B' } else { b'A' };
        lines[1] = std::str::from_utf8(&packet).unwrap();
        artifact.signature = lines.join("\n");
        assert!(matches!(
            verify_artifact(bytes, &artifact, TEST_UPDATER_PUBLIC_KEY_BASE64),
            Err(UpdateError::Signature(_))
        ));
    }

    #[test]
    fn a_different_key_does_not_verify_the_artifact() {
        let bytes = b"the artifact";
        let artifact = test_signing::artifact(bytes, "https://example.com/a.zip");
        assert!(verify_artifact(bytes, &artifact, TEST_UPDATER_PUBLIC_KEY_BASE64).is_ok());
        assert!(
            verify_artifact(
                bytes,
                &artifact,
                "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
            )
            .is_err()
        );
    }

    #[test]
    fn the_manifest_rejects_an_http_artifact() {
        let bytes = b"x";
        let mut manifest = test_signing::manifest("0.3.0", bytes);
        let target = current_target();
        manifest.artifacts.get_mut(&target).unwrap().url = "http://example.com/x".into();
        let json = serde_json::to_vec(&manifest).unwrap();
        assert!(
            parse_manifest(&json, TEST_UPDATER_PUBLIC_KEY_BASE64, TEST_UPDATER_KEY_ID).is_err()
        );
    }
}
