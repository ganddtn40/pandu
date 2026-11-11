//! `pandu update` and `pandu rollback`.
//!
//! The updater trusts only the key compiled into this build. It downloads a
//! signed manifest and a signed artifact over HTTPS, verifies the SHA-256
//! digest and Minisign signature, refuses downgrades, and keeps the previous
//! binary for one rollback. It never installs anything in the background.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use pandu_core::brand;
use pandu_core::update::{
    MAX_ARTIFACT_BYTES, MAX_MANIFEST_BYTES, UpdateTrustRoot, active_update_key_id,
    active_update_public_key, compare_versions, current_target, notes_summary, parse_manifest,
    parse_version, require_upgrade, resolve_update_trust_root, safe_https_url, select_artifact,
    verify_artifact,
};
use pandu_daemon::update::GitHubRelease;
use serde_json::{Value, json};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct UpdateOutcome {
    pub status: String,
    pub current_version: String,
    pub latest_version: String,
    pub channel: String,
    pub trust: String,
    pub notes: String,
    pub release_url: String,
    pub artifact_target: String,
    pub installed: bool,
    pub previous_binary: Option<String>,
}

/// Check the pinned GitHub release feed and install a verified update.
pub async fn run(check_only: bool) -> anyhow::Result<UpdateOutcome> {
    let trust = resolve_update_trust_root(
        cfg!(debug_assertions),
        pandu_core::update::PRODUCTION_UPDATER_PUBLIC_KEY_BASE64,
    );
    let (public_key, key_id) = match trust {
        UpdateTrustRoot::Ready => (
            active_update_public_key(cfg!(debug_assertions)).expect("a ready trust root has a key"),
            active_update_key_id(cfg!(debug_assertions)),
        ),
        UpdateTrustRoot::Preparing => bail!("{}", pandu_core::update::UPDATE_PREPARING_MESSAGE),
        UpdateTrustRoot::Refused => {
            bail!("This build embedded the test updater key. Release builds refuse updates.")
        }
    };

    let client = client()?;
    let release = fetch_latest_release(&client).await?;
    if release.draft || release.prerelease {
        bail!(
            "The newest release is not on the {} channel yet. Try again later.",
            brand::UPDATE_CHANNEL
        );
    }
    let latest_version = release.tag_name.trim().trim_start_matches('v').to_string();
    match compare_versions(pandu_core::VERSION, &release.tag_name)? {
        pandu_core::update::VersionRelation::Same => {
            return Ok(UpdateOutcome {
                status: "up-to-date".to_string(),
                current_version: pandu_core::VERSION.to_string(),
                latest_version,
                channel: brand::UPDATE_CHANNEL.to_string(),
                trust: trust.as_str().to_string(),
                notes: String::new(),
                release_url: release
                    .html_url
                    .filter(|url| url.starts_with("https://"))
                    .unwrap_or_else(|| brand::UPDATE_RELEASES_URL.to_string()),
                artifact_target: current_target(),
                installed: false,
                previous_binary: None,
            });
        }
        pandu_core::update::VersionRelation::Older => {
            bail!(
                "The newest published release ({}) is older than this build ({}). \
                 Refusing to downgrade. Nothing was installed.",
                release.tag_name,
                pandu_core::VERSION
            );
        }
        pandu_core::update::VersionRelation::Newer => {}
    }

    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == brand::UPDATE_MANIFEST_ASSET)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "This release has no signed update manifest ({}). Nothing was installed.",
                brand::UPDATE_MANIFEST_ASSET
            )
        })?;
    let manifest_bytes = download(
        &client,
        &asset.browser_download_url,
        MAX_MANIFEST_BYTES as u64,
    )
    .await?;
    let manifest = parse_manifest(&manifest_bytes, public_key, key_id)
        .map_err(|error| anyhow::anyhow!("The update manifest failed verification: {error}"))?;
    if parse_version(&manifest.version)? != parse_version(&release.tag_name)? {
        bail!(
            "The update manifest says {}, but the release is {}. Refusing to install it.",
            manifest.version,
            release.tag_name
        );
    }
    require_upgrade(pandu_core::VERSION, &manifest.version)?;

    let release_url = release
        .html_url
        .filter(|url| url.starts_with("https://"))
        .unwrap_or_else(|| brand::UPDATE_RELEASES_URL.to_string());
    let target = current_target();
    let artifact = select_artifact(&manifest, &target)?;

    if check_only {
        return Ok(UpdateOutcome {
            status: "available".to_string(),
            current_version: pandu_core::VERSION.to_string(),
            latest_version: manifest.version.clone(),
            channel: manifest.channel.clone(),
            trust: trust.as_str().to_string(),
            notes: manifest.notes.clone(),
            release_url,
            artifact_target: target,
            installed: false,
            previous_binary: None,
        });
    }

    let bytes = download(
        &client,
        &artifact.url,
        artifact.size.unwrap_or(MAX_ARTIFACT_BYTES),
    )
    .await?;
    verify_artifact(&bytes, artifact, public_key)
        .map_err(|error| anyhow::anyhow!("The update failed verification: {error}"))?;

    let current = std::env::current_exe().context("could not locate the running binary")?;
    let staged = staged_path(&current);
    write_staged(&staged, &bytes)?;
    let previous = install_binary(&staged, &current)?;

    Ok(UpdateOutcome {
        status: "installed".to_string(),
        current_version: pandu_core::VERSION.to_string(),
        latest_version: manifest.version,
        channel: manifest.channel,
        trust: trust.as_str().to_string(),
        notes: manifest.notes,
        release_url,
        artifact_target: target,
        installed: true,
        previous_binary: Some(previous.display().to_string()),
    })
}

/// Restore the binary kept by the last update.
pub fn rollback() -> anyhow::Result<PathBuf> {
    let current = std::env::current_exe().context("could not locate the running binary")?;
    rollback_binary(&current)
}

pub fn outcome_json(outcome: &UpdateOutcome) -> Value {
    json!({
        "status": outcome.status,
        "currentVersion": outcome.current_version,
        "latestVersion": outcome.latest_version,
        "channel": outcome.channel,
        "trust": outcome.trust,
        "notes": outcome.notes,
        "releaseUrl": outcome.release_url,
        "artifactTarget": outcome.artifact_target,
        "installed": outcome.installed,
        "previousBinary": outcome.previous_binary,
    })
}

pub fn print_outcome(outcome: &UpdateOutcome) {
    println!("{} {}", brand::PRODUCT_NAME, outcome.current_version);
    println!("channel: {}", outcome.channel);
    if outcome.status == "up-to-date" {
        println!("You are up to date.");
        return;
    }
    println!("new version: {}", outcome.latest_version);
    let summary = notes_summary(&outcome.notes, 240);
    if !summary.is_empty() {
        println!("highlights: {summary}");
    }
    println!("release: {}", outcome.release_url);
    if outcome.installed {
        println!("installed for {}.", outcome.artifact_target);
        if let Some(previous) = &outcome.previous_binary {
            println!("previous binary: {previous}");
        }
        println!(
            "Start {} again to use the new version. If anything looks wrong, run `{} rollback`.",
            brand::PRODUCT_NAME,
            brand::CLI_COMMAND
        );
    } else {
        println!(
            "Nothing was downloaded. Run `{} update` to install it.",
            brand::CLI_COMMAND
        );
    }
}

fn client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" {
                attempt.stop()
            } else if attempt.previous().len() > 10 {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .context("could not build the update HTTP client")
}

async fn fetch_latest_release(client: &reqwest::Client) -> anyhow::Result<GitHubRelease> {
    let url = format!("{}/latest", brand::UPDATE_API_URL.trim_end_matches('/'));
    let response = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28")
        .header(
            reqwest::header::USER_AGENT,
            format!("{}-{}", brand::SLUG, pandu_core::VERSION),
        )
        .send()
        .await
        .context("could not reach the update service")?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        bail!(
            "There is no published release yet. The release repository may be private or not published."
        );
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        bail!("GitHub is limiting update checks. Try again later.");
    }
    if !status.is_success() {
        bail!("The update service returned HTTP {status}. Nothing was installed.");
    }
    let bytes = response
        .bytes()
        .await
        .context("could not read the update response")?;
    serde_json::from_slice(&bytes).context("the update service returned an unexpected response")
}

async fn download(client: &reqwest::Client, url: &str, max_bytes: u64) -> anyhow::Result<Vec<u8>> {
    safe_https_url(url).map_err(|error| anyhow::anyhow!(error))?;
    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("could not download {url}"))?;
    let status = response.status();
    if !status.is_success() {
        bail!("The download returned HTTP {status}. Nothing was installed.");
    }
    safe_https_url(response.url().as_str()).map_err(|error| anyhow::anyhow!(error))?;
    if let Some(length) = response.content_length() {
        if length > max_bytes {
            bail!("The download is larger than expected ({length} bytes). Nothing was installed.");
        }
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("the download was interrupted")?
    {
        if bytes.len() as u64 + chunk.len() as u64 > max_bytes {
            bail!("The download is larger than expected. Nothing was installed.");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn staged_path(current: &Path) -> PathBuf {
    with_suffix(current, "pending")
}

fn previous_path(current: &Path) -> PathBuf {
    with_suffix(current, "previous")
}

fn with_suffix(current: &Path, suffix: &str) -> PathBuf {
    let name = current
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| brand::CLI_COMMAND.to_string());
    current.with_file_name(format!("{name}.{suffix}"))
}

fn write_staged(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .with_context(|| format!("could not stage the update at {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// Move the current binary to `.previous` and put the staged binary in place.
pub fn install_binary(staged: &Path, current: &Path) -> anyhow::Result<PathBuf> {
    if !staged.exists() {
        bail!("the staged update {} does not exist", staged.display());
    }
    let previous = previous_path(current);
    if previous.exists() {
        std::fs::remove_file(&previous)
            .with_context(|| format!("could not replace {}", previous.display()))?;
    }
    std::fs::rename(current, &previous).with_context(|| {
        format!(
            "could not move the current binary to {}. Close every {} process and try again.",
            previous.display(),
            brand::PRODUCT_NAME
        )
    })?;
    match std::fs::rename(staged, current) {
        Ok(()) => Ok(previous),
        Err(error) => {
            let _ = std::fs::rename(&previous, current);
            Err(error).with_context(|| {
                format!(
                    "could not install the new binary at {}. The previous binary was restored.",
                    current.display()
                )
            })
        }
    }
}

/// Swap the current binary with the one kept by the last update.
pub fn rollback_binary(current: &Path) -> anyhow::Result<PathBuf> {
    let previous = previous_path(current);
    if !previous.exists() {
        bail!(
            "there is no previous binary at {}. Run `{} update` first.",
            previous.display(),
            brand::CLI_COMMAND
        );
    }
    let temporary = with_suffix(current, "rollback");
    let _ = std::fs::remove_file(&temporary);
    std::fs::rename(current, &temporary).with_context(|| {
        format!(
            "could not move the current binary aside. Close every {} process and try again.",
            brand::PRODUCT_NAME
        )
    })?;
    if let Err(error) = std::fs::rename(&previous, current) {
        let _ = std::fs::rename(&temporary, current);
        return Err(error).with_context(|| {
            format!(
                "could not restore the previous binary at {}. Nothing was changed.",
                current.display()
            )
        });
    }
    if let Err(error) = std::fs::rename(&temporary, &previous) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error).with_context(|| {
            format!(
                "the previous binary is in place, but its backup copy could not be kept at {}",
                previous.display()
            )
        });
    }
    Ok(previous)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pandu_core::update::test_signing;
    use pandu_core::update::{
        PRODUCTION_UPDATER_PUBLIC_KEY_BASE64, ReleaseArtifact, TEST_UPDATER_KEY_ID, UpdateError,
        UpdateTrustRoot, active_update_public_key, manifest_signing_payload, parse_manifest,
        resolve_update_trust_root,
    };

    fn signed_manifest(version: &str) -> (Vec<u8>, Vec<u8>) {
        let artifact = b"the new binary".to_vec();
        let manifest = test_signing::manifest(version, &artifact);
        (serde_json::to_vec(&manifest).unwrap(), artifact)
    }

    #[test]
    fn a_test_signed_manifest_verifies_in_a_test_build() {
        let (bytes, _artifact) = signed_manifest("9.9.9");
        let parsed = parse_manifest(
            &bytes,
            active_update_public_key(true).unwrap(),
            active_update_key_id(true),
        )
        .unwrap();
        assert_eq!(parsed.version, "9.9.9");
        assert_eq!(parsed.key_id, TEST_UPDATER_KEY_ID);
    }

    #[test]
    fn a_tampered_manifest_is_refused() {
        let (mut bytes, _artifact) = signed_manifest("9.9.9");
        let position = bytes
            .windows(5)
            .position(|window| window == b"9.9.9")
            .unwrap();
        bytes[position] = b'8';
        let error = parse_manifest(
            &bytes,
            active_update_public_key(true).unwrap(),
            active_update_key_id(true),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("signature"), "{error}");
    }

    #[test]
    fn an_unsigned_manifest_is_refused() {
        let mut manifest = test_signing::manifest("9.9.9", b"the new binary");
        manifest.signature.clear();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let error = parse_manifest(
            &bytes,
            active_update_public_key(true).unwrap(),
            active_update_key_id(true),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("unsigned"), "{error}");
    }

    #[test]
    fn a_release_build_without_a_production_key_fails_closed() {
        assert_eq!(
            resolve_update_trust_root(false, PRODUCTION_UPDATER_PUBLIC_KEY_BASE64),
            UpdateTrustRoot::Preparing
        );
        assert_eq!(active_update_public_key(false), None);
        let message = pandu_core::update::UPDATE_PREPARING_MESSAGE;
        assert!(message.contains("no production updater key"), "{message}");
    }

    #[test]
    fn a_release_build_never_accepts_the_test_key() {
        let test_public_key = test_signing::public_key();
        assert_eq!(
            resolve_update_trust_root(false, Some(&test_public_key)),
            UpdateTrustRoot::Refused
        );
    }

    #[test]
    fn downgrades_and_reinstalls_are_refused() {
        let error = require_upgrade("2.0.0", "1.9.0").unwrap_err().to_string();
        assert!(error.contains("downgrade"), "{error}");
        let error = require_upgrade("2.0.0", "2.0.0").unwrap_err().to_string();
        assert!(error.contains("already installed"), "{error}");
        assert!(require_upgrade("2.0.0", "2.0.1").is_ok());
    }

    #[test]
    fn a_manifest_for_another_channel_or_key_is_refused() {
        let (bytes, _artifact) = signed_manifest("9.9.9");
        let error = parse_manifest(
            &bytes,
            active_update_public_key(true).unwrap(),
            "some-other-key",
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("key id"), "{error}");
    }

    #[test]
    fn install_keeps_the_previous_binary_and_rollback_swaps_it_back() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory
            .path()
            .join(if cfg!(windows) { "pandu.exe" } else { "pandu" });
        let staged = staged_path(&current);
        std::fs::write(&current, b"old binary").unwrap();
        std::fs::write(&staged, b"new binary").unwrap();

        let previous = install_binary(&staged, &current).unwrap();
        assert_eq!(std::fs::read(&current).unwrap(), b"new binary");
        assert_eq!(std::fs::read(&previous).unwrap(), b"old binary");
        assert!(!staged.exists());

        rollback_binary(&current).unwrap();
        assert_eq!(std::fs::read(&current).unwrap(), b"old binary");
        assert_eq!(std::fs::read(&previous).unwrap(), b"new binary");
    }

    #[test]
    fn rollback_without_a_previous_binary_is_a_clear_error() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("pandu");
        std::fs::write(&current, b"only binary").unwrap();
        let error = rollback_binary(&current).unwrap_err().to_string();
        assert!(error.contains("no previous binary"), "{error}");
        assert_eq!(std::fs::read(&current).unwrap(), b"only binary");
    }

    #[test]
    fn a_missing_staged_update_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let current = directory.path().join("pandu");
        std::fs::write(&current, b"old binary").unwrap();
        let missing = directory.path().join("missing.pending");
        let error = install_binary(&missing, &current).unwrap_err().to_string();
        assert!(error.contains("does not exist"), "{error}");
        assert_eq!(std::fs::read(&current).unwrap(), b"old binary");
    }

    #[test]
    fn the_signing_payload_is_stable() {
        let manifest = test_signing::manifest("1.2.3", b"artifact");
        let first = manifest_signing_payload(&manifest);
        let second = manifest_signing_payload(&manifest);
        assert_eq!(first, second);
        assert!(
            String::from_utf8(first)
                .unwrap()
                .contains("\"version\":\"1.2.3\"")
        );
    }

    #[test]
    fn the_artifact_verifier_rejects_a_changed_byte() {
        let artifact_bytes = b"the new binary".to_vec();
        let artifact: ReleaseArtifact =
            test_signing::artifact(&artifact_bytes, "https://example.com/pandu.exe");
        assert!(
            verify_artifact(
                &artifact_bytes,
                &artifact,
                active_update_public_key(true).unwrap()
            )
            .is_ok()
        );
        let mut changed = artifact_bytes;
        changed[0] ^= 1;
        let error = verify_artifact(&changed, &artifact, active_update_public_key(true).unwrap())
            .unwrap_err()
            .to_string();
        assert!(error.contains("damaged"), "{error}");
    }

    #[test]
    fn update_errors_are_readable() {
        let error = UpdateError::Signature("no".to_string());
        assert_eq!(error.to_string(), "no");
    }
}
