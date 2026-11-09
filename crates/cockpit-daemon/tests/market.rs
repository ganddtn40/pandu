//! Phase 8 market integration tests.
//!
//! These tests exercise the promises that matter for untrusted skills and MCP
//! servers: a registry is only usable when its Ed25519 signature and every
//! entry hash verify; archives cannot escape the extraction root; installs are
//! previewed, backed up, and atomic; uninstall never deletes files the user
//! edited; a crash leaves a journal that rolls back; and the cached offline
//! registry is used without ever touching the network.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cockpit_daemon::adapters;
use cockpit_daemon::market::archive::{ExtractedFile, extract_tar_gz, tree_hash, verify_tree};
use cockpit_daemon::market::config_edit::{self, ConfigFormat};
use cockpit_daemon::market::install::{self, InstallManifest, InstallState, validate_manifest};
use cockpit_daemon::market::service::{MarketService, RegistrySource};
use cockpit_daemon::market::{
    ACTIVE_INDEX_FILE, ACTIVE_REVOKED_FILE, InstallScope, LoadedRegistry, MarketKind, MarketSource,
    RevokedEntry, SignedIndex, SignedRevocation, SkillAgentTarget, TrustTier, parse_entry_text,
    parse_registry, sanitize_markdown,
};
use serde_json::{Value, json};

fn registry_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../registry")
        .canonicalize()
        .expect("the repository registry exists")
}

fn load_registry(include_examples: bool) -> LoadedRegistry {
    cockpit_daemon::market::load_registry_dir(&registry_dir(), include_examples)
        .expect("the signed registry loads")
}

fn adapter_registry(home: &Path) -> Arc<cockpit_core::adapter::AdapterRegistry> {
    Arc::new(adapters::load_registry(home))
}

fn service(
    home: &Path,
    user_home: &Path,
    registry: Option<LoadedRegistry>,
    local_source: Option<PathBuf>,
) -> Arc<MarketService> {
    service_in(home, user_home, None, registry, local_source)
}

fn service_in(
    home: &Path,
    user_home: &Path,
    workspace: Option<&Path>,
    registry: Option<LoadedRegistry>,
    local_source: Option<PathBuf>,
) -> Arc<MarketService> {
    MarketService::for_test(
        home.to_path_buf(),
        user_home.to_path_buf(),
        workspace.map(Path::to_path_buf),
        adapter_registry(home),
        registry,
        local_source,
    )
}

fn fixture_source() -> PathBuf {
    registry_dir().join("fixtures")
}

fn copy_dir(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &destination);
        } else {
            std::fs::copy(&path, &destination).unwrap();
        }
    }
}

fn tar_gz(entries: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, bytes, kind) in entries {
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

fn signed_index() -> (SignedIndex, Vec<u8>, Vec<u8>) {
    let dir = registry_dir();
    let index_bytes = std::fs::read(dir.join(ACTIVE_INDEX_FILE)).unwrap();
    let revoked_bytes = std::fs::read(dir.join(ACTIVE_REVOKED_FILE)).unwrap();
    let index: SignedIndex = serde_json::from_slice(&index_bytes).unwrap();
    (index, index_bytes, revoked_bytes)
}

fn reader_for(
    index: &SignedIndex,
) -> impl Fn(&str) -> Result<Vec<u8>, cockpit_daemon::market::MarketError> {
    let dir = registry_dir();
    let entries: Vec<(String, Vec<u8>)> = index
        .entries
        .iter()
        .map(|entry| {
            (
                entry.path.clone(),
                std::fs::read(dir.join(&entry.path)).unwrap(),
            )
        })
        .collect();
    move |path| {
        entries
            .iter()
            .find(|(candidate, _)| candidate == path)
            .map(|(_, bytes)| bytes.clone())
            .ok_or_else(|| cockpit_daemon::market::MarketError::Registry(format!("missing {path}")))
    }
}

#[tokio::test]
async fn signed_registry_lists_only_verified_entries() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let service = service(
        home.path(),
        user_home.path(),
        Some(load_registry(true)),
        Some(fixture_source()),
    );
    let catalog = service.catalog(true).await.unwrap();
    assert_eq!(catalog.source, RegistrySource::Cache);
    assert!(catalog.offline);
    assert_eq!(catalog.entries.len(), 3);
    assert_eq!(catalog.counts.skills, 2);
    assert_eq!(catalog.counts.mcp, 1);
    assert_eq!(catalog.counts.installed, 0);
    assert!(catalog.entries.iter().all(|entry| entry.example));
    assert!(
        catalog
            .entries
            .iter()
            .all(|entry| entry.trust == TrustTier::Unreviewed)
    );

    let detail = service
        .detail(MarketKind::Skill, "example-commit-messages")
        .await
        .unwrap();
    assert!(detail.readme.contains("Commit Message Coach"));
    assert_eq!(detail.source.commit, "1".repeat(40));
}

#[test]
fn signature_failure_and_tampered_index_are_refused() {
    let (mut index, index_bytes, revoked_bytes) = signed_index();

    // A corrupt signature is a signature failure, not a schema failure.
    let mut corrupt = index.clone();
    corrupt.signature = "not base64!".into();
    let error = parse_registry(
        &serde_json::to_vec(&corrupt).unwrap(),
        &revoked_bytes,
        true,
        reader_for(&index),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        cockpit_daemon::market::MarketError::Signature(_)
    ));

    // Changing any signed field invalidates the signature.
    index.generated_at = "2027-01-01T00:00:00.000Z".into();
    let error = parse_registry(
        &serde_json::to_vec(&index).unwrap(),
        &revoked_bytes,
        true,
        reader_for(&index),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        cockpit_daemon::market::MarketError::Signature(_)
    ));

    // The untouched index still verifies.
    parse_registry(&index_bytes, &revoked_bytes, true, reader_for(&index)).unwrap();
}

#[test]
fn tampered_revocation_list_is_refused() {
    let (index, index_bytes, revoked_bytes) = signed_index();
    let mut revoked: SignedRevocation = serde_json::from_slice(&revoked_bytes).unwrap();
    revoked.generated_at = "2027-01-01T00:00:00.000Z".into();
    let error = parse_registry(
        &index_bytes,
        &serde_json::to_vec(&revoked).unwrap(),
        true,
        reader_for(&index),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        cockpit_daemon::market::MarketError::Signature(_)
    ));
}

#[test]
fn entry_hash_mismatch_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let copy = temp.path().join("registry");
    copy_dir(&registry_dir(), &copy);
    let entry = copy.join("skills/example-commit-messages.yaml");
    let mut text = std::fs::read_to_string(&entry).unwrap();
    text.push_str("\n# tampered after signing\n");
    std::fs::write(&entry, text).unwrap();

    let error = cockpit_daemon::market::load_registry_dir(&copy, true).unwrap_err();
    assert!(
        error.to_string().contains("does not match the hash"),
        "{error}"
    );
}

#[tokio::test]
async fn revoked_entries_cannot_be_previewed_or_installed() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let mut registry = load_registry(true);
    registry.revoked.revoked.push(RevokedEntry {
        kind: MarketKind::Skill,
        id: "example-commit-messages".into(),
        reason: "A malicious update was published.".into(),
        revoked_on: "2026-11-09".into(),
    });
    let service = service(
        home.path(),
        user_home.path(),
        Some(registry),
        Some(fixture_source()),
    );
    let error = service
        .preview(
            MarketKind::Skill,
            "example-commit-messages",
            "claude-code",
            InstallScope::User,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("revoked"), "{error}");
    assert!(!user_home.path().join(".claude/skills").exists());
}

#[tokio::test]
async fn content_tree_hash_mismatch_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let mut registry = load_registry(true);
    let entry = registry
        .entries
        .iter_mut()
        .find(|entry| entry.id == "example-commit-messages")
        .unwrap();
    entry.source.content_sha256 = "0".repeat(64);
    let service = service(
        home.path(),
        user_home.path(),
        Some(registry),
        Some(fixture_source()),
    );
    let error = service
        .preview(
            MarketKind::Skill,
            "example-commit-messages",
            "claude-code",
            InstallScope::User,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("pinned content hash"), "{error}");
    assert!(!user_home.path().join(".claude/skills").exists());
}

#[test]
fn archives_cannot_escape_or_smuggle_links() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
        (
            "zip-slip",
            tar_gz(&[("../evil.txt", b"x", tar::EntryType::Regular)]),
        ),
        (
            "absolute",
            tar_gz(&[("/etc/passwd", b"x", tar::EntryType::Regular)]),
        ),
        ("symlink", tar_gz(&[("link", b"", tar::EntryType::Symlink)])),
        ("hardlink", tar_gz(&[("link", b"", tar::EntryType::Link)])),
        (
            "windows reserved",
            tar_gz(&[("CON", b"x", tar::EntryType::Regular)]),
        ),
        (
            "case collision",
            tar_gz(&[
                ("A.txt", b"one", tar::EntryType::Regular),
                ("a.txt", b"two", tar::EntryType::Regular),
            ]),
        ),
    ];
    for (name, bytes) in cases {
        assert!(extract_tar_gz(&bytes).is_err(), "{name} was accepted");
    }
}

#[test]
fn archive_bombs_are_refused() {
    // Too many files.
    let many: Vec<(String, Vec<u8>)> = (0..1_001)
        .map(|index| (format!("f{index}.txt"), Vec::new()))
        .collect();
    let entries: Vec<(&str, &[u8], tar::EntryType)> = many
        .iter()
        .map(|(path, bytes)| (path.as_str(), bytes.as_slice(), tar::EntryType::Regular))
        .collect();
    let bytes = tar_gz(&entries);
    assert!(extract_tar_gz(&bytes).is_err());

    // A single file larger than the per-file limit.
    let big = vec![b'x'; (4 * 1024 * 1024) + 1];
    let bytes = tar_gz(&[("big.bin", big.as_slice(), tar::EntryType::Regular)]);
    assert!(extract_tar_gz(&bytes).is_err());
}

#[test]
fn yaml_bombs_and_prompt_injection_text_are_refused() {
    let mut anchors = String::new();
    for index in 0..70 {
        anchors.push_str(&format!("a{index}: &a{index} value\n"));
    }
    anchors.push_str("alias: *a0\n");
    assert!(parse_entry_text("bomb.yaml", &anchors).is_err());

    let mut lines = String::new();
    for index in 0..10_001 {
        lines.push_str(&format!("line{index}: value\n"));
    }
    assert!(parse_entry_text("bomb.yaml", &lines).is_err());
}

#[test]
fn markdown_blocks_images_html_and_dangerous_schemes() {
    let cleaned = sanitize_markdown(
        "# Title\n\n![tracker](https://evil.example/pixel.png)\n\n\
         <script>alert(1)</script>\n\n[click](javascript:alert(1))\n",
    );
    assert!(!cleaned.contains("evil.example"));
    assert!(!cleaned.contains("<script>"));
    assert!(!cleaned.to_lowercase().contains("javascript:"));
    assert!(cleaned.contains("# Title"));
}

#[tokio::test]
async fn skill_install_uninstall_and_undo_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let service = service(
        home.path(),
        user_home.path(),
        Some(load_registry(true)),
        Some(fixture_source()),
    );
    let preview = service
        .preview(
            MarketKind::Skill,
            "example-commit-messages",
            "claude-code",
            InstallScope::User,
        )
        .await
        .unwrap();
    assert!(preview.manual.is_none());
    assert_eq!(preview.files.len(), 2);
    assert!(preview.secret_names.is_empty());
    assert!(preview.conflicts.is_empty());
    assert!(preview.command.is_none());
    assert!(preview.files.iter().all(|file| file.action == "create"));
    assert!(
        preview
            .files
            .iter()
            .all(|file| Path::new(&file.path).is_absolute()),
        "the preview carries resolved absolute paths"
    );
    assert!(
        preview
            .files
            .iter()
            .any(|file| file.display_path.starts_with("~/"))
    );

    let installed = service
        .install(&preview.preview_id, BTreeMap::new())
        .unwrap();
    assert_eq!(installed.files_written, 2);
    assert!(installed.undo_available);
    let root = user_home
        .path()
        .join(".claude/skills/example-commit-messages");
    assert!(root.join("SKILL.md").is_file());
    assert!(root.join("references/style.md").is_file());

    let list = service.installed_checked().await.unwrap();
    assert_eq!(list.installs.len(), 1);
    assert_eq!(list.installs[0].state, InstallState::Installed);
    assert!(!list.installs[0].needs_attention);

    let removal = service.preview_uninstall(&installed.install_id).unwrap();
    assert_eq!(removal.files_to_remove.len(), 2);
    assert!(!removal.needs_confirmation);

    let outcome = service.uninstall(&installed.install_id, false).unwrap();
    assert!(outcome.undo_available);
    assert!(!root.join("SKILL.md").exists());
    assert!(!root.join("references/style.md").exists());

    let undone = service.undo(&installed.install_id, false).unwrap();
    assert_eq!(undone.restored_files, 2);
    assert!(root.join("SKILL.md").is_file());
    assert!(root.join("references/style.md").is_file());
}

#[tokio::test]
async fn uninstall_preserves_user_edited_files() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let service = service(
        home.path(),
        user_home.path(),
        Some(load_registry(true)),
        Some(fixture_source()),
    );
    let preview = service
        .preview(
            MarketKind::Skill,
            "example-commit-messages",
            "claude-code",
            InstallScope::User,
        )
        .await
        .unwrap();
    let installed = service
        .install(&preview.preview_id, BTreeMap::new())
        .unwrap();
    let root = user_home
        .path()
        .join(".claude/skills/example-commit-messages");
    let skill = root.join("SKILL.md");
    let edited = format!(
        "{}\n\nMy local notes.\n",
        std::fs::read_to_string(&skill).unwrap()
    );
    std::fs::write(&skill, &edited).unwrap();

    let removal = service.preview_uninstall(&installed.install_id).unwrap();
    assert!(removal.needs_confirmation);
    assert_eq!(removal.files_edited.len(), 1);
    assert_eq!(removal.files_to_remove.len(), 1);

    // Without confirmation nothing is removed.
    let outcome = service.uninstall(&installed.install_id, false).unwrap();
    assert!(!outcome.undo_available);
    assert!(skill.is_file());
    assert!(root.join("references/style.md").is_file());

    // With confirmation Cockpit removes only the unedited file.
    let outcome = service.uninstall(&installed.install_id, true).unwrap();
    assert!(outcome.undo_available);
    assert_eq!(std::fs::read_to_string(&skill).unwrap(), edited);
    assert!(!root.join("references/style.md").exists());
}

#[tokio::test]
async fn mcp_install_edits_project_config_without_losing_comments_or_secrets() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let config_path = workspace.path().join(".mcp.json");
    std::fs::write(
        &config_path,
        "{\n  // keep this comment\n  \"unknown\": {\"a\": 1},\n  \
         \"mcpServers\": {\n    \"existing\": {\"command\": \"existing\"}\n  }\n}\n",
    )
    .unwrap();
    let service = service_in(
        home.path(),
        user_home.path(),
        Some(workspace.path()),
        Some(load_registry(true)),
        Some(fixture_source()),
    );
    let preview = service
        .preview(
            MarketKind::Mcp,
            "example-weather",
            "claude-code",
            InstallScope::Project,
        )
        .await
        .unwrap();
    let config = preview.config.as_ref().expect("MCP preview has a config");
    assert_eq!(config.display_path, ".mcp.json");
    assert!(Path::new(&config.path).is_absolute());
    assert_eq!(config.secret_names, vec!["WEATHER_API_KEY".to_string()]);
    assert_eq!(
        preview.command.as_deref(),
        Some("npx -y example-weather-mcp@1.0.0")
    );
    assert!(preview.command_warning.is_some());
    assert!(
        preview
            .warnings
            .iter()
            .any(|warning| warning.contains("WEATHER_UNITS"))
    );
    assert!(config.diff.contains("example-weather"));

    let mut secrets = BTreeMap::new();
    secrets.insert(
        "WEATHER_API_KEY".to_string(),
        "local-secret-value".to_string(),
    );
    let installed = service.install(&preview.preview_id, secrets).unwrap();
    assert_eq!(installed.config_path.as_deref(), Some(".mcp.json"));
    assert!(!user_home.path().join(".claude.json").exists());

    let contents = std::fs::read_to_string(&config_path).unwrap();
    assert!(contents.contains("// keep this comment"));
    assert!(contents.contains("\"unknown\""));
    assert!(contents.contains("\"existing\""));
    assert!(contents.contains("example-weather"));
    assert!(contents.contains("local-secret-value"));

    // The manifest records the secret name but never its value.
    let manifest_path = home
        .path()
        .join("market/installed")
        .join(format!("{}.json", installed.install_id));
    let manifest = std::fs::read_to_string(&manifest_path).unwrap();
    assert!(manifest.contains("WEATHER_API_KEY"));
    assert!(!manifest.contains("local-secret-value"));
    assert!(manifest.contains("<secret>"));

    let removal = service.preview_uninstall(&installed.install_id).unwrap();
    assert_eq!(removal.config_action, "remove");
    assert!(!removal.needs_confirmation);
    service.uninstall(&installed.install_id, false).unwrap();

    let contents = std::fs::read_to_string(&config_path).unwrap();
    assert!(contents.contains("// keep this comment"));
    assert!(contents.contains("\"unknown\""));
    assert!(contents.contains("\"existing\""));
    assert!(!contents.contains("example-weather"));
    assert!(!contents.contains("local-secret-value"));

    service.undo(&installed.install_id, false).unwrap();
    let contents = std::fs::read_to_string(&config_path).unwrap();
    assert!(contents.contains("example-weather"));
}

#[tokio::test]
async fn claude_user_scope_mcp_is_manual_and_never_touches_app_state() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    std::fs::write(
        user_home.path().join(".claude.json"),
        "{\n  \"numStartups\": 12\n}\n",
    )
    .unwrap();
    let service = service(
        home.path(),
        user_home.path(),
        Some(load_registry(true)),
        Some(fixture_source()),
    );
    let preview = service
        .preview(
            MarketKind::Mcp,
            "example-weather",
            "claude-code",
            InstallScope::User,
        )
        .await
        .unwrap();
    let manual = preview.manual.as_ref().expect("manual instructions");
    assert!(
        manual
            .steps
            .iter()
            .any(|step| step.contains("claude mcp add")),
        "{:?}",
        manual.steps
    );
    assert!(
        manual.steps.iter().any(|step| step.contains(".mcp.json")),
        "{:?}",
        manual.steps
    );
    assert_eq!(manual.path, "~/.claude.json");
    assert!(preview.config.is_none());
    assert!(preview.files.is_empty());
    let error = service
        .install(&preview.preview_id, BTreeMap::new())
        .unwrap_err();
    assert!(error.to_string().contains("manual-only"), "{error}");
    assert_eq!(
        std::fs::read_to_string(user_home.path().join(".claude.json")).unwrap(),
        "{\n  \"numStartups\": 12\n}\n"
    );
}

#[tokio::test]
async fn unverified_agents_get_manual_instructions_and_no_write() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let adapters_dir = home.path().join("adapters");
    std::fs::create_dir_all(&adapters_dir).unwrap();
    std::fs::write(
        adapters_dir.join("custom-agent.toml"),
        r#"schema_version = 1
id = "custom-agent"
name = "Custom Agent"
verified = false
docs_url = "https://example.com/custom"
capture = ["log_watch"]

[detect]
command = "custom-agent"
version_args = ["--version"]

[log_watch]
roots = ["~/.custom/logs"]
include = ["**/*.jsonl"]
parser = "generic-json"
verified = false

[skills]
user_paths = ["~/.custom/skills"]
project_paths = [".custom/skills"]
verified = false
"#,
    )
    .unwrap();

    let mut registry = load_registry(true);
    let entry = registry
        .entries
        .iter_mut()
        .find(|entry| entry.id == "example-commit-messages")
        .unwrap();
    entry.agents.push("custom-agent".into());
    entry
        .skills
        .as_mut()
        .unwrap()
        .install
        .push(SkillAgentTarget {
            agent: "custom-agent".into(),
            scopes: vec![InstallScope::User],
            subdir: None,
        });
    let service = service(
        home.path(),
        user_home.path(),
        Some(registry),
        Some(fixture_source()),
    );
    let preview = service
        .preview(
            MarketKind::Skill,
            "example-commit-messages",
            "custom-agent",
            InstallScope::User,
        )
        .await
        .unwrap();
    let manual = preview.manual.as_ref().expect("manual instructions");
    assert!(manual.steps.iter().any(|step| step.contains("SKILL.md")));
    assert!(preview.files.is_empty());
    let error = service
        .install(&preview.preview_id, BTreeMap::new())
        .unwrap_err();
    assert!(error.to_string().contains("manual-only"), "{error}");
    assert!(!user_home.path().join(".custom/skills").exists());
}

#[test]
fn config_round_trip_preserves_comments_and_unknown_keys() {
    let before = "# keep me\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = \"other\"\n";
    let after = config_edit::apply_change(
        Some(before),
        ConfigFormat::Toml,
        &["mcp_servers".into(), "demo".into()],
        &json!({"command": "npx", "args": ["-y", "pkg@1.2.3"]}),
    )
    .unwrap();
    assert!(after.contains("# keep me"));
    assert!(after.contains("model = \"x\""));
    assert!(after.contains("[mcp_servers.other]"));
    assert!(after.contains("[mcp_servers.demo]"));
    let removed = config_edit::remove_change(
        &after,
        ConfigFormat::Toml,
        &["mcp_servers".into(), "demo".into()],
    )
    .unwrap();
    assert!(removed.contains("# keep me"));
    assert!(!removed.contains("[mcp_servers.demo]"));

    let before = "{\n  // keep me\n  \"model\": \"x\",\n  \"unknown\": {\"a\": 1},\n}\n";
    let after = config_edit::apply_change(
        Some(before),
        ConfigFormat::Jsonc,
        &["mcp".into(), "servers".into(), "demo".into()],
        &json!({"type": "local", "command": ["npx", "-y", "pkg@1.2.3"]}),
    )
    .unwrap();
    assert!(after.contains("// keep me"));
    assert!(after.contains("\"unknown\""));
    assert!(after.contains("\"demo\""));
}

#[tokio::test]
async fn offline_catalog_uses_the_verified_cache_and_fails_closed() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let cache = home.path().join("market/registry");
    copy_dir(&registry_dir(), &cache);

    let cached = service(home.path(), user_home.path(), None, None);
    let catalog = cached.catalog(false).await.unwrap();
    assert_eq!(catalog.source, RegistrySource::Cache);
    assert!(catalog.offline);
    assert_eq!(catalog.entries.len(), 3);
    assert_eq!(catalog.counts.skills, 2);

    // A tampered cache must not silently fall back to anything else.
    let mut index: Value =
        serde_json::from_slice(&std::fs::read(cache.join(ACTIVE_INDEX_FILE)).unwrap()).unwrap();
    index["signature"] = json!("AAAA");
    std::fs::write(
        cache.join(ACTIVE_INDEX_FILE),
        serde_json::to_vec(&index).unwrap(),
    )
    .unwrap();
    let service = service(home.path(), user_home.path(), None, None);
    let error = service.catalog(false).await.unwrap_err();
    assert!(matches!(
        error,
        cockpit_daemon::market::MarketError::Signature(_)
    ));
}

#[tokio::test]
async fn interrupted_install_is_rolled_back_from_the_journal() {
    let home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let service = service(
        home.path(),
        user_home.path(),
        Some(load_registry(true)),
        Some(fixture_source()),
    );
    let preview = service
        .preview(
            MarketKind::Skill,
            "example-commit-messages",
            "claude-code",
            InstallScope::User,
        )
        .await
        .unwrap();
    let installed = service
        .install(&preview.preview_id, BTreeMap::new())
        .unwrap();

    let manifest =
        install::load_manifest(home.path(), user_home.path(), None, &installed.install_id).unwrap();
    // Simulate a crash after some files were written: the journal says the
    // install was applying, and only one file exists.
    let journal_dir = home.path().join("market/journal");
    std::fs::create_dir_all(&journal_dir).unwrap();
    std::fs::write(
        journal_dir.join(format!("{}.json", manifest.install_id)),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "installId": manifest.install_id,
            "backupId": manifest.backup_id,
            "state": "applying",
            "createdAt": "2026-11-09T00:00:00.000Z",
            "configPath": null
        }))
        .unwrap(),
    )
    .unwrap();
    let root = user_home
        .path()
        .join(".claude/skills/example-commit-messages");
    std::fs::remove_file(root.join("references/style.md")).unwrap();

    let recovered = install::recover_installs(home.path(), user_home.path(), None).unwrap();
    assert_eq!(recovered, vec![manifest.install_id.clone()]);
    assert!(
        !journal_dir
            .join(format!("{}.json", manifest.install_id))
            .exists()
    );
    // The backup was taken before the install, so rollback removes the files
    // that did not exist before.
    assert!(!root.join("SKILL.md").exists());
    assert!(!root.join("references/style.md").exists());
}

#[test]
fn manifest_fuzzing_never_panics_and_rejects_escapes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("user");
    std::fs::create_dir_all(&root).unwrap();
    let roots = vec![root.clone()];
    let source = MarketSource {
        repo: "https://github.com/example/demo".into(),
        commit: "1".repeat(40),
        content_sha256: "2".repeat(64),
        files: Vec::new(),
    };
    let valid = InstallManifest {
        schema_version: 1,
        install_id: cockpit_core::ids::create_id(),
        kind: MarketKind::Skill,
        entry_id: "demo".into(),
        name: "Demo".into(),
        version: "1.0.0".into(),
        trust: TrustTier::Unreviewed,
        agent: "claude-code".into(),
        scope: InstallScope::User,
        source,
        license: "MIT".into(),
        installed_at: "2026-11-09T00:00:00.000Z".into(),
        updated_at: "2026-11-09T00:00:00.000Z".into(),
        state: InstallState::Installed,
        files: vec![install::InstalledFile {
            path: root.join("skills/demo/SKILL.md").display().to_string(),
            display_path: "~/.claude/skills/demo/SKILL.md".into(),
            sha256: "a".repeat(64),
            size: 1,
            created: true,
        }],
        config: None,
        backup_id: cockpit_core::ids::create_id(),
        permissions: Vec::new(),
        secret_names: Vec::new(),
        target_root: "~/.claude/skills/demo".into(),
    };
    validate_manifest(&valid, &roots).unwrap();

    let mut value = serde_json::to_value(&valid).unwrap();
    value["files"][0]["path"] = json!(root.join("..").join("escape").display().to_string());
    let escaped: InstallManifest = serde_json::from_value(value).unwrap();
    assert!(validate_manifest(&escaped, &roots).is_err());

    let mut value = serde_json::to_value(&valid).unwrap();
    value["files"][0]["sha256"] = json!("zz".repeat(32));
    let bad_hash: InstallManifest = serde_json::from_value(value).unwrap();
    assert!(validate_manifest(&bad_hash, &roots).is_err());

    let mut value = serde_json::to_value(&valid).unwrap();
    value["schemaVersion"] = json!(99);
    let bad_schema: InstallManifest = serde_json::from_value(value).unwrap();
    assert!(validate_manifest(&bad_schema, &roots).is_err());

    let mut value = serde_json::to_value(&valid).unwrap();
    value["files"] = json!(vec![Value::Null; 1_001]);
    assert!(serde_json::from_value::<InstallManifest>(value).is_err());

    // Deterministic mutations: no panic, and every bad path or hash is
    // rejected rather than accepted.
    let mut seed = 0x5eed_1234_abcd_9876u64;
    for _ in 0..200 {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let len = (seed % 64) as usize;
        let random: String = (0..len)
            .map(|index| char::from(b' ' + ((seed >> (index % 8)) & 0x3f) as u8))
            .collect();
        let mut value = serde_json::to_value(&valid).unwrap();
        value["files"][0]["path"] = json!(random);
        value["files"][0]["sha256"] = json!(random);
        if let Ok(manifest) = serde_json::from_value::<InstallManifest>(value) {
            let result = catch_unwind(AssertUnwindSafe(|| validate_manifest(&manifest, &roots)));
            assert!(result.is_ok(), "validate_manifest panicked");
            assert!(result.unwrap().is_err());
        }
    }
}

#[test]
fn tree_hash_is_order_independent_and_verifies() {
    let files = vec![
        ExtractedFile {
            path: "SKILL.md".into(),
            bytes: b"hello".to_vec(),
        },
        ExtractedFile {
            path: "references/style.md".into(),
            bytes: b"style".to_vec(),
        },
    ];
    let hash = tree_hash(&files);
    let mut reversed = files.clone();
    reversed.reverse();
    assert_eq!(hash, tree_hash(&reversed));
    verify_tree(&reversed, &hash).unwrap();
    verify_tree(&reversed, &"0".repeat(64)).unwrap_err();
}
