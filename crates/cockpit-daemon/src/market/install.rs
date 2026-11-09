//! Install, uninstall, and undo for market entries.
//!
//! Cockpit only copies files and edits configuration. It never runs a package
//! manager, install script, or MCP server. Every write is previewed, backed up,
//! written through a temporary file, and recorded in a manifest. A crash during
//! an install leaves a journal that is rolled back on the next start.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use cockpit_core::ids::{create_id, is_id};

use super::archive::{ExtractedFile, tree_hash};
use super::config_edit::{self, ConfigFormat, line_diff};
use super::targets::{self, ManualInstructions, ResolvedKind, ResolvedTarget};
use super::{
    InstallScope, MarketEntry, MarketError, MarketKind, MarketPermission, MarketSource, TrustTier,
    hex, is_windows_reserved, validate_relative_path,
};

pub const INSTALL_SCHEMA_VERSION: u32 = 1;
pub const PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);
pub const MAX_MANIFESTS: usize = 500;
pub const MAX_BACKUPS: usize = 100;
pub const MAX_CONFIG_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PREVIEW_TEXT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallState {
    Installed,
    Uninstalled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFile {
    pub path: String,
    pub display_path: String,
    pub sha256: String,
    pub size: u64,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledConfig {
    pub path: String,
    pub display_path: String,
    pub format: ConfigFormat,
    pub key_path: Vec<String>,
    /// Installed value with secret values redacted.
    pub value: Value,
    pub secret_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub schema_version: u32,
    pub install_id: String,
    pub kind: MarketKind,
    pub entry_id: String,
    pub name: String,
    pub version: String,
    pub trust: TrustTier,
    pub agent: String,
    pub scope: InstallScope,
    pub source: MarketSource,
    pub license: String,
    pub installed_at: String,
    pub updated_at: String,
    pub state: InstallState,
    pub files: Vec<InstalledFile>,
    pub config: Option<InstalledConfig>,
    pub backup_id: String,
    pub permissions: Vec<String>,
    pub secret_names: Vec<String>,
    pub target_root: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlannedAction {
    Create,
    Overwrite,
    Unchanged,
    Conflict,
}

impl PlannedAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Overwrite => "overwrite",
            Self::Unchanged => "unchanged",
            Self::Conflict => "conflict",
        }
    }
}

#[derive(Debug, Clone)]
pub struct PlannedFile {
    pub path: PathBuf,
    pub display_path: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub action: PlannedAction,
    pub snapshot: Option<FileSnapshot>,
}

#[derive(Debug, Clone)]
pub struct PlannedConfig {
    pub path: PathBuf,
    pub display_path: String,
    pub format: ConfigFormat,
    pub key_path: Vec<String>,
    pub original: Option<String>,
    pub before: Option<Value>,
    pub after: Value,
    pub action: PlannedAction,
    pub secret_names: Vec<String>,
    pub snapshot: Option<FileSnapshot>,
    pub diff: String,
}

/// What the preview saw on disk. Re-checked before the first write and again
/// immediately before the atomic rename so an editor save cannot be lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSnapshot {
    pub sha256: String,
    pub modified: Option<std::time::SystemTime>,
    pub len: u64,
}

impl FileSnapshot {
    fn capture(path: &Path) -> Result<Option<Self>, MarketError> {
        match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => {
                let bytes = std::fs::read(path).map_err(|error| {
                    MarketError::Install(format!("Could not read {}: {error}", path.display()))
                })?;
                Ok(Some(Self {
                    sha256: hex(&Sha256::digest(&bytes)),
                    modified: metadata.modified().ok(),
                    len: metadata.len(),
                }))
            }
            Ok(_) => Err(MarketError::Install(format!(
                "{} is not a regular file.",
                path.display()
            ))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(MarketError::Install(format!(
                "Could not inspect {}: {error}",
                path.display()
            ))),
        }
    }
}

fn ensure_unchanged(
    path: &Path,
    expected: Option<&FileSnapshot>,
    display: &str,
) -> Result<(), MarketError> {
    let current = FileSnapshot::capture(path)?;
    let unchanged = match (expected, current.as_ref()) {
        (None, None) => true,
        (Some(expected), Some(current)) => expected == current,
        _ => false,
    };
    if !unchanged {
        return Err(MarketError::Install(format!(
            "{display} changed after the preview. Nothing was changed; preview the install again."
        )));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct PreviewPlan {
    pub created_at: Instant,
    pub entry: MarketEntry,
    pub target: ResolvedTarget,
    pub files: Vec<PlannedFile>,
    pub config: Option<PlannedConfig>,
    pub existing: Option<InstallManifest>,
    pub preview: InstallPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    pub path: String,
    pub display_path: String,
    pub sha256: String,
    pub size: u64,
    pub action: String,
    pub binary: bool,
    pub diff: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConfig {
    pub path: String,
    pub display_path: String,
    pub format: ConfigFormat,
    pub key_path: Vec<String>,
    pub before: Option<Value>,
    pub after: Value,
    pub diff: String,
    pub action: String,
    pub secret_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub preview_id: String,
    pub kind: MarketKind,
    pub entry_id: String,
    pub name: String,
    pub version: String,
    pub agent: String,
    pub scope: InstallScope,
    pub trust: TrustTier,
    pub license: String,
    pub source: MarketSource,
    pub permissions: Vec<MarketPermission>,
    pub command: Option<String>,
    pub command_warning: Option<String>,
    pub files: Vec<PreviewFile>,
    pub config: Option<PreviewConfig>,
    pub manual: Option<ManualInstructions>,
    pub secret_names: Vec<String>,
    pub warnings: Vec<String>,
    pub update: bool,
    pub installed_version: Option<String>,
    pub total_bytes: u64,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub install_id: String,
    pub kind: MarketKind,
    pub entry_id: String,
    pub name: String,
    pub version: String,
    pub agent: String,
    pub scope: InstallScope,
    pub backup_id: String,
    pub files_written: usize,
    pub config_path: Option<String>,
    pub undo_available: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPreview {
    pub install_id: String,
    pub kind: MarketKind,
    pub entry_id: String,
    pub name: String,
    pub agent: String,
    pub scope: InstallScope,
    pub files_to_remove: Vec<String>,
    pub files_edited: Vec<String>,
    pub files_missing: Vec<String>,
    pub config_action: String,
    pub needs_confirmation: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOutcome {
    pub preview: UninstallPreview,
    pub backup_id: String,
    pub undo_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub install_id: String,
    pub state: String,
    pub restored_files: usize,
    pub restored_config: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSummary {
    pub install_id: String,
    pub kind: MarketKind,
    pub entry_id: String,
    pub name: String,
    pub version: String,
    pub agent: String,
    pub scope: InstallScope,
    pub trust: TrustTier,
    pub state: InstallState,
    pub installed_at: String,
    pub updated_at: String,
    pub revoked: bool,
    pub update_available: bool,
    pub latest_version: Option<String>,
    pub needs_attention: bool,
    pub attention: Vec<String>,
    pub file_count: usize,
    pub config_path: Option<String>,
    pub backup_id: String,
}

pub struct PreviewInputs<'a> {
    pub entry: &'a MarketEntry,
    pub target: &'a ResolvedTarget,
    pub tree: Option<&'a [ExtractedFile]>,
    pub existing: Option<&'a InstallManifest>,
    pub preview_id: String,
}

pub fn build_preview(inputs: PreviewInputs<'_>) -> Result<PreviewPlan, MarketError> {
    let entry = inputs.entry;
    let target = inputs.target;
    let mut warnings = Vec::new();
    let mut conflicts = Vec::new();
    let mut files = Vec::new();
    let mut config = None;
    let mut total_bytes = 0u64;

    let update = inputs.existing.is_some_and(|existing| {
        existing.version != entry.version || existing.source.commit != entry.source.commit
    });
    let installed_version = inputs.existing.map(|existing| existing.version.clone());

    if target.manual.is_some() {
        // Manual instructions only. Nothing is fetched or written.
    } else {
        match &target.kind {
            ResolvedKind::Skill { root, display_root } => {
                let tree = inputs.tree.ok_or_else(|| {
                    MarketError::Install("The skill archive was not downloaded.".into())
                })?;
                let subdir = targets::subdir(entry, &target.agent);
                let mut selected = Vec::new();
                for file in tree {
                    let relative = match &subdir {
                        Some(subdir) => {
                            let prefix = format!("{}/", subdir.trim_matches('/'));
                            match file.path.strip_prefix(&prefix) {
                                Some(rest) if !rest.is_empty() => rest.to_string(),
                                _ => continue,
                            }
                        }
                        None => file.path.clone(),
                    };
                    validate_relative_path("skill file", &relative)?;
                    selected.push((relative, file.bytes.clone()));
                }
                if selected.is_empty() {
                    return Err(MarketError::Install(
                        "The selected skill folder is empty.".into(),
                    ));
                }
                if !selected.iter().any(|(path, _)| path == "SKILL.md") {
                    return Err(MarketError::Install(
                        "The selected skill folder has no SKILL.md.".into(),
                    ));
                }
                selected.sort_by(|left, right| left.0.cmp(&right.0));
                for (relative, bytes) in selected {
                    let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
                    let display_path = format!("{display_root}/{relative}");
                    let sha256 = hex(&Sha256::digest(&bytes));
                    let snapshot = FileSnapshot::capture(&path)?;
                    let (action, diff, content) =
                        preview_file(&path, &bytes, &sha256, inputs.existing)?;
                    if action == PlannedAction::Conflict {
                        conflicts.push(display_path.clone());
                    }
                    total_bytes = total_bytes.saturating_add(bytes.len() as u64);
                    let binary = std::str::from_utf8(&bytes).is_err();
                    files.push(PlannedFile {
                        path,
                        display_path: display_path.clone(),
                        bytes,
                        sha256,
                        action,
                        snapshot,
                    });
                    // Keep the serializable preview in the same order.
                    let _ = (diff, content, binary);
                }
            }
            ResolvedKind::Mcp {
                path,
                display_path,
                format,
                style,
                key_path,
            } => {
                let original = read_config(path)?;
                let before = match &original {
                    Some(contents) => config_edit::read_value(contents, *format, key_path)?,
                    None => None,
                };
                let after = targets::render_mcp_value(entry, *style, None)?;
                let edited =
                    config_edit::apply_change(original.as_deref(), *format, key_path, &after)?;
                total_bytes = total_bytes.saturating_add(edited.len() as u64);
                let snapshot = FileSnapshot::capture(path)?;
                let action = match (inputs.existing.and_then(|m| m.config.as_ref()), &before) {
                    (Some(installed), Some(current)) => {
                        if value_matches(current, &installed.value, &installed.secret_names, None) {
                            PlannedAction::Overwrite
                        } else {
                            PlannedAction::Conflict
                        }
                    }
                    (None, Some(_)) => PlannedAction::Conflict,
                    _ => PlannedAction::Create,
                };
                if action == PlannedAction::Conflict {
                    conflicts.push(display_path.clone());
                }
                let recipe = entry.mcp.as_ref().expect("validated MCP recipe");
                let secret_names = if style.accepts_secret_values() {
                    recipe.secrets.clone()
                } else {
                    Vec::new()
                };
                for name in recipe.env.iter().chain(recipe.secrets.iter()) {
                    match style {
                        targets::McpStyle::OpenCode => warnings.push(format!(
                            "OpenCode reads {name} from the environment; Cockpit writes an {{env:{name}}} reference."
                        )),
                        _ => warnings.push(format!(
                            "Set {name} in the agent's environment before it starts this server."
                        )),
                    }
                }
                if recipe.transport == super::McpTransport::Http {
                    warnings.push(
                        "Cockpit writes the URL only. Finish any OAuth or header sign-in in the agent."
                            .to_string(),
                    );
                }
                let diff = preview_config_diff(
                    display_path,
                    key_path,
                    before.as_ref(),
                    &after,
                    &secret_names,
                );
                config = Some(PlannedConfig {
                    path: path.clone(),
                    display_path: display_path.clone(),
                    format: *format,
                    key_path: key_path.clone(),
                    original,
                    before: before.clone(),
                    after: after.clone(),
                    action,
                    secret_names: secret_names.clone(),
                    snapshot,
                    diff,
                });
            }
        }
    }

    let preview_files = files
        .iter()
        .map(|file| {
            let existing = std::fs::read(&file.path).ok();
            let text = std::str::from_utf8(&file.bytes).ok();
            let binary = text.is_none();
            let content = text
                .and_then(|text| (text.len() <= MAX_PREVIEW_TEXT_BYTES).then(|| text.to_string()));
            let diff = match (&existing, text) {
                (Some(existing), Some(_)) => std::str::from_utf8(existing).ok().map(|before| {
                    line_diff(
                        Some(before),
                        std::str::from_utf8(&file.bytes).unwrap_or_default(),
                    )
                }),
                _ => None,
            };
            PreviewFile {
                path: file.path.display().to_string(),
                display_path: file.display_path.clone(),
                sha256: file.sha256.clone(),
                size: file.bytes.len() as u64,
                action: file.action.as_str().to_string(),
                binary,
                diff,
                content,
            }
        })
        .collect::<Vec<_>>();

    let preview_config = config.as_ref().map(|config| {
        let before = config
            .before
            .as_ref()
            .map(|value| redact_value(value.clone(), &config.secret_names));
        let after = redact_after(&config.after, &config.secret_names);
        PreviewConfig {
            path: config.path.display().to_string(),
            display_path: config.display_path.clone(),
            format: config.format,
            key_path: config.key_path.clone(),
            before,
            after,
            diff: config.diff.clone(),
            action: config.action.as_str().to_string(),
            secret_names: config.secret_names.clone(),
        }
    });

    let command = targets::command_line(entry);
    let command_warning = command.as_ref().map(|_| {
        format!(
            "{} will run this command when it starts. Cockpit writes configuration only and never executes it.",
            target.adapter_name
        )
    });
    let secret_names = config
        .as_ref()
        .map(|config| config.secret_names.clone())
        .unwrap_or_default();

    Ok(PreviewPlan {
        created_at: Instant::now(),
        entry: entry.clone(),
        target: target.clone(),
        files,
        config,
        existing: inputs.existing.cloned(),
        preview: InstallPreview {
            preview_id: inputs.preview_id,
            kind: entry.kind,
            entry_id: entry.id.clone(),
            name: entry.name.clone(),
            version: entry.version.clone(),
            agent: target.agent.clone(),
            scope: target.scope,
            trust: entry.trust,
            license: entry.license.clone(),
            source: entry.source.clone(),
            permissions: entry.permissions.clone(),
            command,
            command_warning,
            files: preview_files,
            config: preview_config,
            manual: target.manual.clone(),
            secret_names,
            warnings,
            update,
            installed_version,
            total_bytes,
            conflicts,
        },
    })
}

/// Build a preview diff that contains only the edited key subtree. Values that
/// look like secrets, and every value under `env`/`environment`, are redacted so
/// an unrelated credential in the same file never reaches the UI or logs.
fn preview_config_diff(
    display_path: &str,
    key_path: &[String],
    before: Option<&Value>,
    after: &Value,
    secret_names: &[String],
) -> String {
    let key = key_path.join(".");
    let mut output = format!("--- a/{display_path}\n+++ b/{display_path}\n@@ {key} @@\n");
    match before {
        Some(before) => {
            let redacted = redact_value(before.clone(), secret_names);
            for line in pretty_lines(&redacted) {
                output.push('-');
                output.push_str(&line);
                output.push('\n');
            }
        }
        None => output.push_str("-(not set)\n"),
    }
    let redacted = redact_after(after, secret_names);
    for line in pretty_lines(&redacted) {
        output.push('+');
        output.push_str(&line);
        output.push('\n');
    }
    output
}

fn pretty_lines(value: &Value) -> Vec<String> {
    serde_json::to_string_pretty(value)
        .unwrap_or_else(|_| "null".into())
        .lines()
        .map(ToString::to_string)
        .collect()
}

fn is_secret_key(key: &str, secret_names: &[String]) -> bool {
    if secret_names.iter().any(|name| name == key) {
        return true;
    }
    let lower = key.to_ascii_lowercase();
    [
        "secret",
        "token",
        "password",
        "credential",
        "api_key",
        "apikey",
        "private_key",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn redact_value(value: Value, secret_names: &[String]) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    if lower == "env" || lower == "environment" {
                        let redacted = match value {
                            Value::Object(entries) => Value::Object(
                                entries
                                    .into_iter()
                                    .map(|(name, _)| (name, json!("<redacted>")))
                                    .collect(),
                            ),
                            _ => json!("<redacted>"),
                        };
                        (key, redacted)
                    } else if is_secret_key(&key, secret_names) {
                        (key, json!("<redacted>"))
                    } else {
                        (key, redact_value(value, secret_names))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| redact_value(item, secret_names))
                .collect(),
        ),
        other => other,
    }
}

fn redact_after(value: &Value, secret_names: &[String]) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    if lower == "env" || lower == "environment" {
                        let redacted = match value {
                            Value::Object(entries) => Value::Object(
                                entries
                                    .iter()
                                    .map(|(name, value)| {
                                        let placeholder = value.as_str().is_some_and(|text| {
                                            text.starts_with("<secret:")
                                                || text.starts_with("{env:")
                                        });
                                        (
                                            name.clone(),
                                            if placeholder {
                                                value.clone()
                                            } else {
                                                json!("<redacted>")
                                            },
                                        )
                                    })
                                    .collect(),
                            ),
                            _ => json!("<redacted>"),
                        };
                        (key.clone(), redacted)
                    } else if is_secret_key(key, secret_names) {
                        let placeholder = value
                            .as_str()
                            .is_some_and(|text| text.starts_with("<secret:"));
                        (
                            key.clone(),
                            if placeholder {
                                value.clone()
                            } else {
                                json!("<redacted>")
                            },
                        )
                    } else {
                        (key.clone(), redact_after(value, secret_names))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_after(item, secret_names))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn preview_file(
    path: &Path,
    bytes: &[u8],
    sha256: &str,
    existing: Option<&InstallManifest>,
) -> Result<(PlannedAction, Option<String>, Option<String>), MarketError> {
    if !path.exists() {
        return Ok((PlannedAction::Create, None, None));
    }
    let current = std::fs::read(path).map_err(|error| {
        MarketError::Install(format!("Could not read {}: {error}", path.display()))
    })?;
    let current_hash = hex(&Sha256::digest(&current));
    if current_hash == sha256 {
        return Ok((PlannedAction::Unchanged, None, None));
    }
    let display = path.display().to_string();
    let owned = existing.is_some_and(|manifest| {
        manifest
            .files
            .iter()
            .any(|file| file.path == display && file.sha256 == current_hash)
    });
    if !owned {
        return Ok((PlannedAction::Conflict, None, None));
    }
    let diff = match (std::str::from_utf8(&current), std::str::from_utf8(bytes)) {
        (Ok(before), Ok(after)) => Some(line_diff(Some(before), after)),
        _ => None,
    };
    Ok((PlannedAction::Overwrite, diff, None))
}

fn read_config(path: &Path) -> Result<Option<String>, MarketError> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = std::fs::metadata(path).map_err(|error| {
        MarketError::Install(format!("Could not inspect {}: {error}", path.display()))
    })?;
    if !metadata.is_file() {
        return Err(MarketError::Install(format!(
            "{} is not a regular file.",
            path.display()
        )));
    }
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err(MarketError::Install(format!(
            "{} is larger than {} MiB.",
            path.display(),
            MAX_CONFIG_BYTES / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(path).map_err(|error| {
        MarketError::Install(format!("Could not read {}: {error}", path.display()))
    })?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| MarketError::Install(format!("{} is not UTF-8.", path.display())))
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

pub fn apply_plan(
    home: &Path,
    user_home: &Path,
    workspace: Option<&Path>,
    plan: &PreviewPlan,
    secrets: &BTreeMap<String, String>,
) -> Result<InstallOutcome, MarketError> {
    if plan.preview.manual.is_some() {
        return Err(MarketError::Install(
            "This target is manual-only. Cockpit will not write it; follow the manual steps."
                .into(),
        ));
    }
    if !plan.preview.conflicts.is_empty() {
        return Err(MarketError::Install(format!(
            "Cockpit will not overwrite files it did not create: {}",
            plan.preview.conflicts.join(", ")
        )));
    }
    for name in &plan.preview.secret_names {
        if !secrets.contains_key(name) {
            return Err(MarketError::Install(format!(
                "The secret {name} is required for this install."
            )));
        }
    }
    let roots = allowed_roots(home, user_home, workspace);
    for file in &plan.files {
        ensure_allowed(&file.path, &roots)?;
    }
    if let Some(config) = &plan.config {
        ensure_allowed(&config.path, &roots)?;
    }

    // Re-check that the files and config still match the preview.
    for file in &plan.files {
        match file.action {
            PlannedAction::Create => {
                if file.path.exists() {
                    return Err(MarketError::Install(format!(
                        "{} appeared after the preview. Nothing was changed.",
                        file.display_path
                    )));
                }
            }
            PlannedAction::Overwrite => {
                ensure_unchanged(&file.path, file.snapshot.as_ref(), &file.display_path)?;
                let current = std::fs::read(&file.path).map_err(|error| {
                    MarketError::Install(format!("Could not read {}: {error}", file.display_path))
                })?;
                let current_hash = hex(&Sha256::digest(&current));
                let owned = plan.existing.as_ref().is_some_and(|manifest| {
                    manifest.files.iter().any(|entry| {
                        entry.path == file.path.display().to_string()
                            && entry.sha256 == current_hash
                    })
                });
                if !owned {
                    return Err(MarketError::Install(format!(
                        "{} changed after the preview. Nothing was changed.",
                        file.display_path
                    )));
                }
            }
            PlannedAction::Unchanged | PlannedAction::Conflict => {}
        }
    }
    if let Some(config) = &plan.config {
        ensure_unchanged(&config.path, config.snapshot.as_ref(), &config.display_path)?;
    }

    let install_id = plan
        .existing
        .as_ref()
        .map(|manifest| manifest.install_id.clone())
        .unwrap_or_else(create_id);
    let backup_id = create_id();

    let mut backup_paths: Vec<PathBuf> = plan.files.iter().map(|file| file.path.clone()).collect();
    if let Some(existing) = &plan.existing {
        for file in &existing.files {
            backup_paths.push(PathBuf::from(&file.path));
        }
    }
    backup_paths.sort();
    backup_paths.dedup();
    let config_path = plan.config.as_ref().map(|config| config.path.clone());
    create_backup(
        home,
        &backup_id,
        &install_id,
        &backup_paths,
        config_path.as_deref(),
        plan.existing.as_ref(),
        &roots,
    )?;

    let journal_id = install_id.clone();
    write_journal(
        home,
        &Journal {
            schema_version: INSTALL_SCHEMA_VERSION,
            install_id: install_id.clone(),
            backup_id: backup_id.clone(),
            state: "applying".into(),
            created_at: now_iso(),
            config_path: config_path.as_ref().map(|path| path.display().to_string()),
        },
    )?;

    let result = apply_inner(home, &roots, plan, &install_id, &backup_id, secrets);
    match result {
        Ok(outcome) => {
            let _ = remove_journal(home, &journal_id);
            prune_backups(home);
            Ok(outcome)
        }
        Err(error) => {
            let rollback = restore_backup(home, &backup_id, &roots);
            let _ = remove_journal(home, &journal_id);
            if let Err(rollback_error) = rollback {
                return Err(MarketError::Install(format!(
                    "{error} The automatic rollback also failed: {rollback_error}. \
                     Cockpit kept the backup at {backup_id}."
                )));
            }
            Err(MarketError::Install(format!(
                "{error} Cockpit rolled the changes back."
            )))
        }
    }
}

fn apply_inner(
    home: &Path,
    roots: &[PathBuf],
    plan: &PreviewPlan,
    install_id: &str,
    backup_id: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<InstallOutcome, MarketError> {
    let mut files_written = 0usize;
    let mut installed_files = Vec::new();
    let mut created_files = Vec::new();

    for file in &plan.files {
        if file.action != PlannedAction::Unchanged {
            let expected = match file.action {
                PlannedAction::Overwrite => file.snapshot.as_ref(),
                _ => None,
            };
            if file.action == PlannedAction::Create && file.path.exists() {
                return Err(MarketError::Install(format!(
                    "{} appeared after the preview. Nothing was changed.",
                    file.display_path
                )));
            }
            atomic_write_checked(&file.path, &file.bytes, roots, expected)?;
            files_written += 1;
            if file.action == PlannedAction::Create {
                created_files.push(file.path.clone());
            }
        }
        installed_files.push(InstalledFile {
            path: file.path.display().to_string(),
            display_path: file.display_path.clone(),
            sha256: file.sha256.clone(),
            size: file.bytes.len() as u64,
            created: file.action == PlannedAction::Create,
        });
    }

    // Remove files from a previous version that are no longer part of the
    // entry. They were checked against the old manifest during preview.
    if let Some(existing) = &plan.existing {
        let keep: BTreeSet<String> = installed_files
            .iter()
            .map(|file| file.path.clone())
            .collect();
        for old in &existing.files {
            if keep.contains(&old.path) {
                continue;
            }
            let path = PathBuf::from(&old.path);
            ensure_allowed(&path, roots)?;
            if path.exists() {
                let current = std::fs::read(&path).map_err(|error| {
                    MarketError::Install(format!("Could not read {}: {error}", old.path))
                })?;
                if hex(&Sha256::digest(&current)) != old.sha256 {
                    return Err(MarketError::Install(format!(
                        "{} was edited; refusing to remove it during an update.",
                        old.display_path
                    )));
                }
                std::fs::remove_file(&path).map_err(|error| {
                    MarketError::Install(format!("Could not remove {}: {error}", old.display_path))
                })?;
            }
        }
    }

    let mut installed_config = None;
    if let Some(config) = &plan.config {
        let (_, _, _, style, _) = plan
            .target
            .mcp()
            .ok_or_else(|| MarketError::Install("The MCP target is invalid.".into()))?;
        ensure_unchanged(&config.path, config.snapshot.as_ref(), &config.display_path)?;
        let value = targets::render_mcp_value(&plan.entry, style, Some(secrets))?;
        let contents = config_edit::apply_change(
            config.original.as_deref(),
            config.format,
            &config.key_path,
            &value,
        )?;
        atomic_write_checked(
            &config.path,
            contents.as_bytes(),
            roots,
            config.snapshot.as_ref(),
        )?;
        installed_config = Some(InstalledConfig {
            path: config.path.display().to_string(),
            display_path: config.display_path.clone(),
            format: config.format,
            key_path: config.key_path.clone(),
            value: redact_secrets(value, &config.secret_names),
            secret_names: config.secret_names.clone(),
        });
    }

    let now = now_iso();
    let manifest = InstallManifest {
        schema_version: INSTALL_SCHEMA_VERSION,
        install_id: install_id.to_string(),
        kind: plan.entry.kind,
        entry_id: plan.entry.id.clone(),
        name: plan.entry.name.clone(),
        version: plan.entry.version.clone(),
        trust: plan.entry.trust,
        agent: plan.target.agent.clone(),
        scope: plan.target.scope,
        source: plan.entry.source.clone(),
        license: plan.entry.license.clone(),
        installed_at: plan
            .existing
            .as_ref()
            .map(|existing| existing.installed_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        state: InstallState::Installed,
        files: installed_files,
        config: installed_config,
        backup_id: backup_id.to_string(),
        permissions: plan
            .entry
            .permissions
            .iter()
            .map(|permission| permission.id.clone())
            .collect(),
        secret_names: plan.preview.secret_names.clone(),
        target_root: plan.target.display(),
    };
    write_manifest(home, &manifest)?;
    let _ = created_files;

    Ok(InstallOutcome {
        install_id: install_id.to_string(),
        kind: plan.entry.kind,
        entry_id: plan.entry.id.clone(),
        name: plan.entry.name.clone(),
        version: plan.entry.version.clone(),
        agent: plan.target.agent.clone(),
        scope: plan.target.scope,
        backup_id: backup_id.to_string(),
        files_written,
        config_path: plan
            .config
            .as_ref()
            .map(|config| config.display_path.clone()),
        undo_available: true,
        warnings: plan.preview.warnings.clone(),
    })
}

fn redact_secrets(mut value: Value, secret_names: &[String]) -> Value {
    if let Value::Object(map) = &mut value {
        for field in ["env", "environment"] {
            if let Some(Value::Object(entries)) = map.get_mut(field) {
                for name in secret_names {
                    if entries.contains_key(name) {
                        entries.insert(name.clone(), json!("<secret>"));
                    }
                }
            }
        }
    }
    value
}

fn value_matches(
    current: &Value,
    installed: &Value,
    secret_names: &[String],
    key: Option<&str>,
) -> bool {
    if key.is_some_and(|key| secret_names.iter().any(|name| name == key)) {
        return true;
    }
    match (current, installed) {
        (Value::Object(left), Value::Object(right)) => {
            if left.len() != right.len() {
                return false;
            }
            left.iter().all(|(key, value)| {
                right
                    .get(key)
                    .is_some_and(|other| value_matches(value, other, secret_names, Some(key)))
            })
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| value_matches(left, right, secret_names, None))
        }
        _ => current == installed,
    }
}

// ---------------------------------------------------------------------------
// Uninstall and undo
// ---------------------------------------------------------------------------

/// Inspect an installed entry without changing anything. Used by the UI to
/// show exactly which files will be removed, which were edited, and what will
/// happen to the agent configuration.
pub fn preview_uninstall(
    home: &Path,
    user_home: &Path,
    workspace: Option<&Path>,
    manifest: &InstallManifest,
) -> Result<UninstallPreview, MarketError> {
    let roots = allowed_roots(home, user_home, workspace);
    let mut files_to_remove = Vec::new();
    let mut files_edited = Vec::new();
    let mut files_missing = Vec::new();
    for file in &manifest.files {
        let path = PathBuf::from(&file.path);
        ensure_allowed(&path, &roots)?;
        if !path.exists() {
            files_missing.push(file.display_path.clone());
            continue;
        }
        let current = std::fs::read(&path).map_err(|error| {
            MarketError::Install(format!("Could not read {}: {error}", file.display_path))
        })?;
        if hex(&Sha256::digest(&current)) == file.sha256 {
            files_to_remove.push(file.display_path.clone());
        } else {
            files_edited.push(file.display_path.clone());
        }
    }
    let mut config_action = "missing".to_string();
    if let Some(config) = &manifest.config {
        let path = PathBuf::from(&config.path);
        ensure_allowed(&path, &roots)?;
        if path.exists() {
            let contents = read_config(&path)?.unwrap_or_default();
            match config_edit::read_value(&contents, config.format, &config.key_path)? {
                Some(current)
                    if value_matches(&current, &config.value, &config.secret_names, None) =>
                {
                    config_action = "remove".into();
                }
                Some(_) => config_action = "keep-edited".into(),
                None => config_action = "missing".into(),
            }
        }
    }
    let needs_confirmation = !files_edited.is_empty() || config_action == "keep-edited";
    Ok(UninstallPreview {
        install_id: manifest.install_id.clone(),
        kind: manifest.kind,
        entry_id: manifest.entry_id.clone(),
        name: manifest.name.clone(),
        agent: manifest.agent.clone(),
        scope: manifest.scope,
        files_to_remove,
        files_edited,
        files_missing,
        config_action,
        needs_confirmation,
    })
}

pub fn uninstall(
    home: &Path,
    user_home: &Path,
    workspace: Option<&Path>,
    manifest: &InstallManifest,
    confirm_edited: bool,
) -> Result<UninstallOutcome, MarketError> {
    if manifest.state != InstallState::Installed {
        return Err(MarketError::Install(
            "This entry is already uninstalled.".into(),
        ));
    }
    let preview = preview_uninstall(home, user_home, workspace, manifest)?;
    if preview.needs_confirmation && !confirm_edited {
        return Ok(UninstallOutcome {
            preview,
            backup_id: String::new(),
            undo_available: false,
        });
    }
    let roots = allowed_roots(home, user_home, workspace);
    let config_action = preview.config_action.clone();

    let backup_id = create_id();
    let mut backup_paths: Vec<PathBuf> = manifest
        .files
        .iter()
        .map(|file| PathBuf::from(&file.path))
        .collect();
    backup_paths.sort();
    backup_paths.dedup();
    create_backup(
        home,
        &backup_id,
        &manifest.install_id,
        &backup_paths,
        manifest
            .config
            .as_ref()
            .map(|config| Path::new(&config.path)),
        Some(manifest),
        &roots,
    )?;

    for file in &manifest.files {
        let path = PathBuf::from(&file.path);
        ensure_allowed(&path, &roots)?;
        if !path.exists() {
            continue;
        }
        let current = std::fs::read(&path).map_err(|error| {
            MarketError::Install(format!("Could not read {}: {error}", file.display_path))
        })?;
        if hex(&Sha256::digest(&current)) != file.sha256 {
            continue;
        }
        std::fs::remove_file(&path).map_err(|error| {
            MarketError::Install(format!("Could not remove {}: {error}", file.display_path))
        })?;
    }
    if config_action == "remove" {
        if let Some(config) = &manifest.config {
            let path = PathBuf::from(&config.path);
            let contents = read_config(&path)?.unwrap_or_default();
            let edited = config_edit::remove_change(&contents, config.format, &config.key_path)?;
            atomic_write(&path, edited.as_bytes(), &roots)?;
        }
    }
    remove_empty_parents(manifest, &roots);

    let mut updated = manifest.clone();
    updated.state = InstallState::Uninstalled;
    updated.updated_at = now_iso();
    updated.backup_id = backup_id.clone();
    write_manifest(home, &updated)?;
    prune_backups(home);

    Ok(UninstallOutcome {
        preview,
        backup_id,
        undo_available: true,
    })
}

pub fn undo(
    home: &Path,
    user_home: &Path,
    workspace: Option<&Path>,
    manifest: &InstallManifest,
    confirm_edited: bool,
) -> Result<UndoOutcome, MarketError> {
    let roots = allowed_roots(home, user_home, workspace);
    if manifest.state == InstallState::Installed {
        let mut edited = Vec::new();
        for file in &manifest.files {
            let path = PathBuf::from(&file.path);
            ensure_allowed(&path, &roots)?;
            if !path.exists() {
                continue;
            }
            let current = std::fs::read(&path).map_err(|error| {
                MarketError::Install(format!("Could not read {}: {error}", file.display_path))
            })?;
            if hex(&Sha256::digest(&current)) != file.sha256 {
                edited.push(file.display_path.clone());
            }
        }
        if !edited.is_empty() && !confirm_edited {
            return Err(MarketError::Install(format!(
                "These files were edited after install: {}. Confirm undo to discard them.",
                edited.join(", ")
            )));
        }
        let restored = restore_backup(home, &manifest.backup_id, &roots)?;
        return Ok(UndoOutcome {
            install_id: manifest.install_id.clone(),
            state: "removed".into(),
            restored_files: restored.files,
            restored_config: restored.config,
        });
    }
    let restored = restore_backup(home, &manifest.backup_id, &roots)?;
    Ok(UndoOutcome {
        install_id: manifest.install_id.clone(),
        state: "installed".into(),
        restored_files: restored.files,
        restored_config: restored.config,
    })
}

// ---------------------------------------------------------------------------
// Manifests, status, recovery
// ---------------------------------------------------------------------------

pub fn load_manifests(
    home: &Path,
    user_home: &Path,
    workspace: Option<&Path>,
) -> Result<Vec<InstallManifest>, MarketError> {
    let dir = home.join("market").join("installed");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let roots = allowed_roots(home, user_home, workspace);
    let mut manifests = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|error| {
        MarketError::Manifest(format!("Could not read {}: {error}", dir.display()))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            MarketError::Manifest(format!("Could not read an install manifest: {error}"))
        })?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        if bytes.len() > 256 * 1024 {
            continue;
        }
        let Ok(manifest) = serde_json::from_slice::<InstallManifest>(&bytes) else {
            continue;
        };
        if validate_manifest(&manifest, &roots).is_err() {
            continue;
        }
        manifests.push(manifest);
    }
    manifests.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    if manifests.len() > MAX_MANIFESTS {
        manifests.truncate(MAX_MANIFESTS);
    }
    Ok(manifests)
}

pub fn load_manifest(
    home: &Path,
    user_home: &Path,
    workspace: Option<&Path>,
    install_id: &str,
) -> Result<InstallManifest, MarketError> {
    if !is_id(install_id) {
        return Err(MarketError::NotFound("That install does not exist.".into()));
    }
    let roots = allowed_roots(home, user_home, workspace);
    let path = manifest_path(home, install_id);
    let bytes = std::fs::read(&path)
        .map_err(|_| MarketError::NotFound("That install does not exist.".into()))?;
    if bytes.len() > 256 * 1024 {
        return Err(MarketError::Manifest(
            "The install manifest is too large.".into(),
        ));
    }
    let manifest: InstallManifest = serde_json::from_slice(&bytes).map_err(|error| {
        MarketError::Manifest(format!("The install manifest is invalid: {error}"))
    })?;
    validate_manifest(&manifest, &roots)?;
    Ok(manifest)
}

pub fn validate_manifest(manifest: &InstallManifest, roots: &[PathBuf]) -> Result<(), MarketError> {
    if manifest.schema_version != INSTALL_SCHEMA_VERSION {
        return Err(MarketError::Manifest(
            "The install manifest uses an unsupported schema.".into(),
        ));
    }
    if !is_id(&manifest.install_id) {
        return Err(MarketError::Manifest("The install id is invalid.".into()));
    }
    if manifest.files.len() > super::MAX_ARCHIVE_FILES {
        return Err(MarketError::Manifest(
            "The manifest lists too many files.".into(),
        ));
    }
    for file in &manifest.files {
        let path = PathBuf::from(&file.path);
        ensure_allowed(&path, roots)?;
        if file.sha256.len() != 64
            || !file
                .sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
        {
            return Err(MarketError::Manifest(
                "A manifest file hash is not a SHA-256.".into(),
            ));
        }
        if file.size > super::MAX_FILE_BYTES {
            return Err(MarketError::Manifest(
                "A manifest file is larger than the per-file limit.".into(),
            ));
        }
    }
    if let Some(config) = &manifest.config {
        ensure_allowed(&PathBuf::from(&config.path), roots)?;
        if config.key_path.is_empty()
            || config
                .key_path
                .iter()
                .any(|key| key.is_empty() || key.len() > 64 || key.contains('.'))
        {
            return Err(MarketError::Manifest(
                "The manifest config key path is invalid.".into(),
            ));
        }
    }
    if !is_id(&manifest.backup_id) {
        return Err(MarketError::Manifest("The backup id is invalid.".into()));
    }
    Ok(())
}

pub fn summarize(
    manifest: &InstallManifest,
    catalog: Option<&MarketEntry>,
    revoked: bool,
) -> InstalledSummary {
    let mut attention = Vec::new();
    let mut missing = 0;
    let mut edited = 0;
    for file in &manifest.files {
        match std::fs::read(&file.path) {
            Ok(bytes) => {
                if hex(&Sha256::digest(&bytes)) != file.sha256 {
                    edited += 1;
                }
            }
            Err(_) => missing += 1,
        }
    }
    if missing > 0 {
        attention.push(format!("{missing} file(s) are missing"));
    }
    if edited > 0 {
        attention.push(format!("{edited} file(s) changed on disk"));
    }
    if let Some(config) = &manifest.config {
        if let Ok(Some(current)) =
            read_config(Path::new(&config.path)).and_then(|contents| match contents {
                Some(contents) => {
                    config_edit::read_value(&contents, config.format, &config.key_path)
                }
                None => Ok(None),
            })
        {
            if !value_matches(&current, &config.value, &config.secret_names, None) {
                attention.push("Configuration changed on disk".into());
            }
        }
    }
    if revoked {
        attention.push("Revoked by the registry".into());
    }
    let update_available = catalog.is_some_and(|entry| {
        entry.version != manifest.version || entry.source.commit != manifest.source.commit
    });
    InstalledSummary {
        install_id: manifest.install_id.clone(),
        kind: manifest.kind,
        entry_id: manifest.entry_id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        agent: manifest.agent.clone(),
        scope: manifest.scope,
        trust: manifest.trust,
        state: manifest.state,
        installed_at: manifest.installed_at.clone(),
        updated_at: manifest.updated_at.clone(),
        revoked,
        update_available,
        latest_version: catalog.map(|entry| entry.version.clone()),
        needs_attention: !attention.is_empty(),
        attention,
        file_count: manifest.files.len(),
        config_path: manifest
            .config
            .as_ref()
            .map(|config| config.display_path.clone()),
        backup_id: manifest.backup_id.clone(),
    }
}

/// Roll back any install that was interrupted. A journal in `applying` is
/// restored from its backup; a `done` journal is simply cleared.
pub fn recover_installs(
    home: &Path,
    user_home: &Path,
    workspace: Option<&Path>,
) -> Result<Vec<String>, MarketError> {
    let dir = home.join("market").join("journal");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let roots = allowed_roots(home, user_home, workspace);
    let mut recovered = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|error| {
        MarketError::Install(format!("Could not read the install journal: {error}"))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            MarketError::Install(format!("Could not read an install journal entry: {error}"))
        })?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(journal) = serde_json::from_slice::<Journal>(&bytes) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if journal.schema_version != INSTALL_SCHEMA_VERSION || !is_id(&journal.backup_id) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if journal.state == "applying" && restore_backup(home, &journal.backup_id, &roots).is_ok() {
            recovered.push(journal.install_id.clone());
        }
        let _ = std::fs::remove_file(&path);
    }
    Ok(recovered)
}

// ---------------------------------------------------------------------------
// Backups and atomic writes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile {
    path: String,
    existed: bool,
    backup_name: Option<String>,
    sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    schema_version: u32,
    backup_id: String,
    install_id: String,
    created_at: String,
    files: Vec<BackupFile>,
    config: Option<BackupFile>,
    previous_manifest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    schema_version: u32,
    install_id: String,
    backup_id: String,
    state: String,
    created_at: String,
    config_path: Option<String>,
}

struct Restored {
    files: usize,
    config: bool,
}

fn create_backup(
    home: &Path,
    backup_id: &str,
    install_id: &str,
    files: &[PathBuf],
    config: Option<&Path>,
    previous_manifest: Option<&InstallManifest>,
    roots: &[PathBuf],
) -> Result<(), MarketError> {
    let dir = new_backup_dir(home, backup_id);
    let files_dir = dir.join("files");
    std::fs::create_dir_all(&files_dir).map_err(|error| {
        MarketError::Install(format!("Could not create the backup folder: {error}"))
    })?;
    set_dir_permissions(&dir);
    set_dir_permissions(&files_dir);
    let mut entries = Vec::new();
    for (index, path) in files.iter().enumerate() {
        ensure_allowed(path, roots)?;
        if path.exists() {
            let backup_name = format!("files/{index}");
            let target = dir.join(&backup_name);
            std::fs::copy(path, &target).map_err(|error| {
                MarketError::Install(format!("Could not back up {}: {error}", path.display()))
            })?;
            copy_permissions(path, &target);
            let bytes = std::fs::read(&target).map_err(|error| {
                MarketError::Install(format!("Could not read the backup: {error}"))
            })?;
            entries.push(BackupFile {
                path: path.display().to_string(),
                existed: true,
                backup_name: Some(backup_name),
                sha256: Some(hex(&Sha256::digest(&bytes))),
            });
        } else {
            entries.push(BackupFile {
                path: path.display().to_string(),
                existed: false,
                backup_name: None,
                sha256: None,
            });
        }
    }
    let config_entry = match config {
        Some(path) => {
            ensure_allowed(path, roots)?;
            if path.exists() {
                let target = dir.join("config");
                std::fs::copy(path, &target).map_err(|error| {
                    MarketError::Install(format!("Could not back up {}: {error}", path.display()))
                })?;
                copy_permissions(path, &target);
                let bytes = std::fs::read(&target).map_err(|error| {
                    MarketError::Install(format!("Could not read the config backup: {error}"))
                })?;
                Some(BackupFile {
                    path: path.display().to_string(),
                    existed: true,
                    backup_name: Some("config".into()),
                    sha256: Some(hex(&Sha256::digest(&bytes))),
                })
            } else {
                Some(BackupFile {
                    path: path.display().to_string(),
                    existed: false,
                    backup_name: None,
                    sha256: None,
                })
            }
        }
        None => None,
    };
    let has_previous = previous_manifest.is_some();
    if let Some(manifest) = previous_manifest {
        let text = serde_json::to_string_pretty(manifest)
            .map_err(|error| MarketError::Manifest(error.to_string()))?;
        std::fs::write(dir.join("manifest.json"), text).map_err(|error| {
            MarketError::Install(format!("Could not back up the install manifest: {error}"))
        })?;
    }
    let manifest = BackupManifest {
        schema_version: INSTALL_SCHEMA_VERSION,
        backup_id: backup_id.to_string(),
        install_id: install_id.to_string(),
        created_at: now_iso(),
        files: entries,
        config: config_entry,
        previous_manifest: has_previous,
    };
    let text = serde_json::to_string_pretty(&manifest)
        .map_err(|error| MarketError::Manifest(error.to_string()))?;
    std::fs::write(dir.join("backup.json"), text).map_err(|error| {
        MarketError::Install(format!("Could not write the backup manifest: {error}"))
    })?;
    set_file_permissions(&dir.join("backup.json"));
    Ok(())
}

fn restore_backup(
    home: &Path,
    backup_id: &str,
    roots: &[PathBuf],
) -> Result<Restored, MarketError> {
    if !is_id(backup_id) {
        return Err(MarketError::Manifest("The backup id is invalid.".into()));
    }
    let dir = backup_dir(home, backup_id);
    let bytes = std::fs::read(dir.join("backup.json"))
        .map_err(|_| MarketError::Manifest(format!("The backup {backup_id} is missing.")))?;
    let manifest: BackupManifest = serde_json::from_slice(&bytes)
        .map_err(|error| MarketError::Manifest(format!("The backup is invalid: {error}")))?;
    if manifest.backup_id != backup_id || !is_id(&manifest.install_id) {
        return Err(MarketError::Manifest(
            "The backup id does not match.".into(),
        ));
    }
    let mut restored_files = 0usize;
    for file in &manifest.files {
        let path = PathBuf::from(&file.path);
        ensure_allowed(&path, roots)?;
        if file.existed {
            let name = file
                .backup_name
                .as_deref()
                .ok_or_else(|| MarketError::Manifest("A backup file is missing.".into()))?;
            let source = dir.join(name);
            let contents = std::fs::read(&source).map_err(|error| {
                MarketError::Install(format!("Could not read the backup: {error}"))
            })?;
            atomic_write(&path, &contents, roots)?;
            restored_files += 1;
        } else if path.exists() {
            std::fs::remove_file(&path).map_err(|error| {
                MarketError::Install(format!("Could not remove {}: {error}", path.display()))
            })?;
        }
    }
    let mut restored_config = false;
    if let Some(config) = &manifest.config {
        let path = PathBuf::from(&config.path);
        ensure_allowed(&path, roots)?;
        if config.existed {
            let name = config
                .backup_name
                .as_deref()
                .ok_or_else(|| MarketError::Manifest("The config backup is missing.".into()))?;
            let contents = std::fs::read(dir.join(name)).map_err(|error| {
                MarketError::Install(format!("Could not read the config backup: {error}"))
            })?;
            atomic_write(&path, &contents, roots)?;
            restored_config = true;
        } else if path.exists() {
            std::fs::remove_file(&path).map_err(|error| {
                MarketError::Install(format!("Could not remove {}: {error}", path.display()))
            })?;
        }
    }
    if manifest.previous_manifest {
        let previous = std::fs::read(dir.join("manifest.json")).map_err(|error| {
            MarketError::Install(format!("Could not read the previous manifest: {error}"))
        })?;
        let manifest_path = manifest_path(home, &manifest.install_id);
        if let Some(parent) = manifest_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        atomic_write(&manifest_path, &previous, roots)?;
    } else {
        let manifest_path = manifest_path(home, &manifest.install_id);
        let _ = std::fs::remove_file(manifest_path);
    }
    Ok(Restored {
        files: restored_files,
        config: restored_config,
    })
}

fn atomic_write(path: &Path, bytes: &[u8], roots: &[PathBuf]) -> Result<(), MarketError> {
    atomic_write_checked(path, bytes, roots, None)
}

fn atomic_write_checked(
    path: &Path,
    bytes: &[u8],
    roots: &[PathBuf],
    expected: Option<&FileSnapshot>,
) -> Result<(), MarketError> {
    ensure_allowed(path, roots)?;
    let parent = path.parent().ok_or_else(|| {
        MarketError::Install(format!("{} has no parent directory.", path.display()))
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        MarketError::Install(format!("Could not create {}: {error}", parent.display()))
    })?;
    set_dir_permissions(parent);
    let existing_permissions = std::fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());
    let suffix = rand::random::<u64>();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let temp = parent.join(format!(".{file_name}.tmp-{suffix}"));
    {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&temp).map_err(|error| {
            MarketError::Install(format!("Could not create {}: {error}", temp.display()))
        })?;
        file.write_all(bytes).map_err(|error| {
            MarketError::Install(format!("Could not write {}: {error}", temp.display()))
        })?;
        file.sync_all().ok();
    }
    set_file_permissions(&temp);
    if let Some(expected) = expected {
        let current = FileSnapshot::capture(path)?;
        let unchanged = current.as_ref().is_some_and(|current| current == expected);
        if !unchanged {
            let _ = std::fs::remove_file(&temp);
            return Err(MarketError::Install(format!(
                "{} changed after the preview. Nothing was changed; preview the install again.",
                path.display()
            )));
        }
    }
    #[cfg(windows)]
    {
        if path.exists() {
            let backup = parent.join(format!(".{file_name}.bak-{suffix}"));
            std::fs::rename(path, &backup).map_err(|error| {
                MarketError::Install(format!("Could not replace {}: {error}", path.display()))
            })?;
            match std::fs::rename(&temp, path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&backup);
                }
                Err(error) => {
                    let _ = std::fs::rename(&backup, path);
                    let _ = std::fs::remove_file(&temp);
                    return Err(MarketError::Install(format!(
                        "Could not replace {}: {error}",
                        path.display()
                    )));
                }
            }
        } else {
            std::fs::rename(&temp, path).map_err(|error| {
                let _ = std::fs::remove_file(&temp);
                MarketError::Install(format!("Could not write {}: {error}", path.display()))
            })?;
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(&temp, path).map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            MarketError::Install(format!("Could not write {}: {error}", path.display()))
        })?;
    }
    if let Some(permissions) = existing_permissions {
        let _ = std::fs::set_permissions(path, permissions);
    } else {
        set_file_permissions(path);
    }
    Ok(())
}

fn write_manifest(home: &Path, manifest: &InstallManifest) -> Result<(), MarketError> {
    let dir = home.join("market").join("installed");
    std::fs::create_dir_all(&dir).map_err(|error| {
        MarketError::Manifest(format!("Could not create the install folder: {error}"))
    })?;
    let path = manifest_path(home, &manifest.install_id);
    let text = serde_json::to_string_pretty(manifest)
        .map_err(|error| MarketError::Manifest(error.to_string()))?;
    let roots = [home.to_path_buf()];
    atomic_write(&path, text.as_bytes(), &roots)?;
    Ok(())
}

fn write_journal(home: &Path, journal: &Journal) -> Result<(), MarketError> {
    let dir = home.join("market").join("journal");
    std::fs::create_dir_all(&dir).map_err(|error| {
        MarketError::Install(format!("Could not create the install journal: {error}"))
    })?;
    let path = dir.join(format!("{}.json", journal.install_id));
    let text = serde_json::to_string_pretty(journal)
        .map_err(|error| MarketError::Manifest(error.to_string()))?;
    std::fs::write(&path, text).map_err(|error| {
        MarketError::Install(format!("Could not write the install journal: {error}"))
    })?;
    Ok(())
}

fn remove_journal(home: &Path, install_id: &str) -> Result<(), MarketError> {
    let path = home
        .join("market")
        .join("journal")
        .join(format!("{install_id}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| {
            MarketError::Install(format!("Could not clear the install journal: {error}"))
        })?;
    }
    Ok(())
}

fn remove_empty_parents(manifest: &InstallManifest, roots: &[PathBuf]) {
    let Some(root) = manifest
        .files
        .first()
        .map(|file| PathBuf::from(&file.path))
        .and_then(|path| path.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let mut current = Some(root);
    while let Some(directory) = current {
        if !directory.exists() || !directory.is_dir() {
            break;
        }
        if std::fs::read_dir(&directory)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
            && roots.iter().any(|allowed| directory.starts_with(allowed))
        {
            if std::fs::remove_dir(&directory).is_err() {
                break;
            }
            current = directory.parent().map(Path::to_path_buf);
        } else {
            break;
        }
    }
}

fn prune_backups(home: &Path) {
    let dir = home.join("market").join("backups");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut backups: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    if backups.len() <= MAX_BACKUPS {
        return;
    }
    backups.sort_by_key(|(modified, _)| *modified);
    let remove = backups.len() - MAX_BACKUPS;
    for (_, path) in backups.into_iter().take(remove) {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn backup_dir(home: &Path, backup_id: &str) -> PathBuf {
    let root = home.join("market").join("backups");
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == backup_id || name.ends_with(&format!("-{backup_id}")) {
                return entry.path();
            }
        }
    }
    root.join(backup_id)
}

fn new_backup_dir(home: &Path, backup_id: &str) -> PathBuf {
    let stamp = Utc::now().format("%Y-%m-%dT%H-%M-%S%.3fZ");
    home.join("market")
        .join("backups")
        .join(format!("{stamp}-{backup_id}"))
}

fn manifest_path(home: &Path, install_id: &str) -> PathBuf {
    home.join("market")
        .join("installed")
        .join(format!("{install_id}.json"))
}

pub fn allowed_roots(home: &Path, user_home: &Path, workspace: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = vec![home.to_path_buf(), user_home.to_path_buf()];
    if let Some(workspace) = workspace {
        roots.push(workspace.to_path_buf());
    }
    roots
}

fn ensure_allowed(path: &Path, roots: &[PathBuf]) -> Result<(), MarketError> {
    if !path.is_absolute() {
        return Err(MarketError::Manifest(format!(
            "{} is not an absolute path.",
            path.display()
        )));
    }
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.split('/').any(|part| part == "..") {
        return Err(MarketError::Manifest(format!(
            "{} escapes its root.",
            path.display()
        )));
    }
    if normalized.split('/').any(is_windows_reserved) {
        return Err(MarketError::Manifest(format!(
            "{} uses a Windows reserved name.",
            path.display()
        )));
    }
    let lower = normalized.to_ascii_lowercase();
    let allowed = roots.iter().any(|root| {
        let root = root
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        lower == root || lower.starts_with(&format!("{root}/"))
    });
    if !allowed {
        return Err(MarketError::Manifest(format!(
            "{} is outside Cockpit's install roots.",
            path.display()
        )));
    }
    Ok(())
}

fn copy_permissions(source: &Path, target: &Path) {
    if let Ok(metadata) = std::fs::metadata(source) {
        let _ = std::fs::set_permissions(target, metadata.permissions());
    }
}

fn set_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn set_dir_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn tree_hash_of(files: &[ExtractedFile]) -> String {
    tree_hash(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::config_edit::{ConfigFormat, apply_change, read_value};
    use crate::market::targets::{McpStyle, ResolvedKind, ResolvedTarget};
    use crate::market::{
        MarketSource, McpAgentTarget, McpRecipe, McpTransport, SkillAgentTarget, SkillRecipe,
        TrustTier,
    };

    fn entry(kind: MarketKind) -> MarketEntry {
        MarketEntry {
            schema_version: 1,
            id: "demo".into(),
            name: "Demo".into(),
            kind,
            version: "1.0.0".into(),
            short_description: "Short".into(),
            long_description: "Long".into(),
            categories: vec!["examples".into()],
            agents: vec!["claude-code".into()],
            source: MarketSource {
                repo: "https://github.com/example/demo".into(),
                commit: "1".repeat(40),
                content_sha256: "2".repeat(64),
                files: Vec::new(),
            },
            license: "MIT".into(),
            trust: TrustTier::Unreviewed,
            reviewer: None,
            reviewed_on: None,
            example: true,
            permissions: Vec::new(),
            homepage: None,
            skills: (kind == MarketKind::Skill).then(|| SkillRecipe {
                install: vec![SkillAgentTarget {
                    agent: "claude-code".into(),
                    scopes: vec![InstallScope::User],
                    subdir: None,
                }],
            }),
            mcp: (kind == MarketKind::Mcp).then(|| McpRecipe {
                transport: McpTransport::Stdio,
                command: Some("npx".into()),
                args: vec!["-y".into(), "demo@1.0.0".into()],
                url: None,
                env: Vec::new(),
                secrets: vec!["DEMO_KEY".into()],
                install: vec![McpAgentTarget {
                    agent: "claude-code".into(),
                    scopes: vec![InstallScope::User],
                }],
            }),
            readme: String::new(),
        }
    }

    fn skill_target(root: &Path) -> ResolvedTarget {
        ResolvedTarget {
            agent: "claude-code".into(),
            scope: InstallScope::User,
            adapter_name: "Claude Code".into(),
            verified: true,
            kind: ResolvedKind::Skill {
                root: root.join("demo"),
                display_root: "~/.claude/skills/demo".into(),
            },
            manual: None,
        }
    }

    fn mcp_target(path: &Path) -> ResolvedTarget {
        ResolvedTarget {
            agent: "claude-code".into(),
            scope: InstallScope::User,
            adapter_name: "Claude Code".into(),
            verified: true,
            kind: ResolvedKind::Mcp {
                path: path.to_path_buf(),
                display_path: "~/.claude.json".into(),
                format: ConfigFormat::Jsonc,
                style: McpStyle::Claude,
                key_path: vec!["mcpServers".into(), "demo".into()],
            },
            manual: None,
        }
    }

    #[test]
    fn installs_a_skill_and_uninstalls_only_matching_files() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let root = user_home.join(".claude/skills");
        let tree = vec![
            ExtractedFile {
                path: "SKILL.md".into(),
                bytes: b"# demo\n".to_vec(),
            },
            ExtractedFile {
                path: "notes.txt".into(),
                bytes: b"notes\n".to_vec(),
            },
        ];
        let target = skill_target(&root);
        let entry = entry(MarketKind::Skill);
        let plan = build_preview(PreviewInputs {
            entry: &entry,
            target: &target,
            tree: Some(&tree),
            existing: None,
            preview_id: "preview".into(),
        })
        .unwrap();
        let outcome = apply_plan(&home, &user_home, None, &plan, &BTreeMap::new()).unwrap();
        assert_eq!(outcome.files_written, 2);
        assert!(root.join("demo/SKILL.md").exists());
        let manifest = load_manifest(&home, &user_home, None, &outcome.install_id).unwrap();
        assert_eq!(manifest.state, InstallState::Installed);
        let uninstall = uninstall(&home, &user_home, None, &manifest, false).unwrap();
        assert!(!uninstall.preview.needs_confirmation);
        assert!(!root.join("demo/SKILL.md").exists());
        let manifest = load_manifest(&home, &user_home, None, &outcome.install_id).unwrap();
        assert_eq!(manifest.state, InstallState::Uninstalled);
        let undo = undo(&home, &user_home, None, &manifest, false).unwrap();
        assert_eq!(undo.state, "installed");
        assert!(root.join("demo/SKILL.md").exists());
    }

    #[test]
    fn edited_files_need_confirmation_and_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let root = user_home.join(".claude/skills");
        let tree = vec![ExtractedFile {
            path: "SKILL.md".into(),
            bytes: b"# demo\n".to_vec(),
        }];
        let target = skill_target(&root);
        let entry = entry(MarketKind::Skill);
        let plan = build_preview(PreviewInputs {
            entry: &entry,
            target: &target,
            tree: Some(&tree),
            existing: None,
            preview_id: "preview".into(),
        })
        .unwrap();
        let outcome = apply_plan(&home, &user_home, None, &plan, &BTreeMap::new()).unwrap();
        std::fs::write(root.join("demo/SKILL.md"), "# edited\n").unwrap();
        let manifest = load_manifest(&home, &user_home, None, &outcome.install_id).unwrap();
        let preview = uninstall(&home, &user_home, None, &manifest, false).unwrap();
        assert!(preview.preview.needs_confirmation);
        assert_eq!(
            preview.preview.files_edited,
            ["~/.claude/skills/demo/SKILL.md"]
        );
        assert!(root.join("demo/SKILL.md").exists());
        let outcome = uninstall(&home, &user_home, None, &manifest, true).unwrap();
        assert!(outcome.undo_available);
        assert!(root.join("demo/SKILL.md").exists());
    }

    #[test]
    fn mcp_config_round_trip_preserves_comments_and_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        std::fs::write(
            &config,
            "{\n  // keep\n  \"unknown\": true,\n  \"mcpServers\": {\"other\": {\"command\": \"x\"}},\n}\n",
        )
        .unwrap();
        let target = mcp_target(&config);
        let entry = entry(MarketKind::Mcp);
        let plan = build_preview(PreviewInputs {
            entry: &entry,
            target: &target,
            tree: None,
            existing: None,
            preview_id: "preview".into(),
        })
        .unwrap();
        let mut secrets = BTreeMap::new();
        secrets.insert("DEMO_KEY".to_string(), "value".to_string());
        apply_plan(&home, &user_home, None, &plan, &secrets).unwrap();
        let text = std::fs::read_to_string(&config).unwrap();
        assert!(text.contains("// keep"));
        assert!(text.contains("\"unknown\""));
        assert!(text.contains("\"other\""));
        let value = read_value(
            &text,
            ConfigFormat::Jsonc,
            &["mcpServers".into(), "demo".into()],
        )
        .unwrap()
        .unwrap();
        assert_eq!(value["env"]["DEMO_KEY"], "value");
        let manifest = load_manifests(&home, &user_home, None).unwrap();
        assert_eq!(manifest.len(), 1);
        assert_eq!(
            manifest[0].config.as_ref().unwrap().value["env"]["DEMO_KEY"],
            "<secret>"
        );
        let uninstall = uninstall(&home, &user_home, None, &manifest[0], false).unwrap();
        assert!(!uninstall.preview.needs_confirmation);
        let text = std::fs::read_to_string(&config).unwrap();
        assert!(!text.contains("\"demo\""));
        assert!(text.contains("\"other\""));
        assert!(text.contains("// keep"));
    }

    #[test]
    fn refuses_to_overwrite_a_file_cockpit_does_not_own() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(user_home.join(".claude/skills/demo")).unwrap();
        std::fs::write(user_home.join(".claude/skills/demo/SKILL.md"), "user file").unwrap();
        let tree = vec![ExtractedFile {
            path: "SKILL.md".into(),
            bytes: b"# demo\n".to_vec(),
        }];
        let target = skill_target(&user_home.join(".claude/skills"));
        let entry = entry(MarketKind::Skill);
        let plan = build_preview(PreviewInputs {
            entry: &entry,
            target: &target,
            tree: Some(&tree),
            existing: None,
            preview_id: "preview".into(),
        })
        .unwrap();
        assert!(!plan.preview.conflicts.is_empty());
        assert!(apply_plan(&home, &user_home, None, &plan, &BTreeMap::new()).is_err());
        assert_eq!(
            std::fs::read_to_string(user_home.join(".claude/skills/demo/SKILL.md")).unwrap(),
            "user file"
        );
    }

    #[test]
    fn manifest_validation_rejects_escapes_and_bad_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tester");
        std::fs::create_dir_all(&root).unwrap();
        let roots = vec![root.clone()];
        let mut manifest = InstallManifest {
            schema_version: 1,
            install_id: create_id(),
            kind: MarketKind::Skill,
            entry_id: "demo".into(),
            name: "Demo".into(),
            version: "1.0.0".into(),
            trust: TrustTier::Unreviewed,
            agent: "claude-code".into(),
            scope: InstallScope::User,
            source: MarketSource {
                repo: "https://github.com/example/demo".into(),
                commit: "1".repeat(40),
                content_sha256: "2".repeat(64),
                files: Vec::new(),
            },
            license: "MIT".into(),
            installed_at: now_iso(),
            updated_at: now_iso(),
            state: InstallState::Installed,
            files: vec![InstalledFile {
                path: root
                    .join(".claude/skills/demo/SKILL.md")
                    .display()
                    .to_string(),
                display_path: "~/.claude/skills/demo/SKILL.md".into(),
                sha256: "a".repeat(64),
                size: 1,
                created: true,
            }],
            config: None,
            backup_id: create_id(),
            permissions: Vec::new(),
            secret_names: Vec::new(),
            target_root: "~/.claude/skills/demo".into(),
        };
        validate_manifest(&manifest, &roots).unwrap();
        manifest.files[0].path = root
            .join("..")
            .join("etc")
            .join("passwd")
            .display()
            .to_string();
        assert!(validate_manifest(&manifest, &roots).is_err());
        manifest.files[0].path = dir
            .path()
            .join("outside")
            .join("passwd")
            .display()
            .to_string();
        assert!(validate_manifest(&manifest, &roots).is_err());
        manifest.files[0].path = root.join("skill").display().to_string();
        manifest.files[0].sha256 = "not-a-hash".into();
        assert!(validate_manifest(&manifest, &roots).is_err());
    }

    #[test]
    fn config_edit_helpers_are_used_by_the_installer() {
        let before = "{\n  \"a\": 1\n}\n";
        let after =
            apply_change(Some(before), ConfigFormat::Jsonc, &["b".into()], &json!(2)).unwrap();
        assert!(after.contains("\"b\": 2"));
    }

    fn secrets() -> BTreeMap<String, String> {
        let mut secrets = BTreeMap::new();
        secrets.insert("DEMO_KEY".to_string(), "value".to_string());
        secrets
    }

    fn mcp_plan(config: &Path) -> PreviewPlan {
        let entry = entry(MarketKind::Mcp);
        let target = mcp_target(config);
        build_preview(PreviewInputs {
            entry: &entry,
            target: &target,
            tree: None,
            existing: None,
            preview_id: "preview".into(),
        })
        .unwrap()
    }

    fn mcp_preview_error(config: &Path) -> MarketError {
        let entry = entry(MarketKind::Mcp);
        let target = mcp_target(config);
        build_preview(PreviewInputs {
            entry: &entry,
            target: &target,
            tree: None,
            existing: None,
            preview_id: "preview".into(),
        })
        .unwrap_err()
    }

    #[test]
    fn preview_aborts_when_the_config_changes_before_apply() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        std::fs::write(&config, "{\n  \"unknown\": true\n}\n").unwrap();
        let plan = mcp_plan(&config);
        std::fs::write(&config, "{\n  \"unknown\": false\n}\n").unwrap();
        let error = apply_plan(&home, &user_home, None, &plan, &secrets()).unwrap_err();
        assert!(
            error.to_string().contains("changed after the preview"),
            "{error}"
        );
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            "{\n  \"unknown\": false\n}\n"
        );
    }

    #[test]
    fn preview_refuses_a_config_that_does_not_parse() {
        let dir = tempfile::tempdir().unwrap();
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        let broken = "{\n  \"a\": \n}\n";
        std::fs::write(&config, broken).unwrap();
        let error = mcp_preview_error(&config);
        assert!(error.to_string().contains("could not be parsed"), "{error}");
        assert_eq!(std::fs::read_to_string(&config).unwrap(), broken);
    }

    #[test]
    fn preview_refuses_a_config_over_five_megabytes() {
        let dir = tempfile::tempdir().unwrap();
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        std::fs::write(&config, vec![b' '; 5 * 1024 * 1024 + 1]).unwrap();
        let error = mcp_preview_error(&config);
        assert!(error.to_string().contains("larger than 2 MiB"), "{error}");
        assert_eq!(
            std::fs::metadata(&config).unwrap().len(),
            5 * 1024 * 1024 + 1
        );
    }

    #[test]
    fn install_and_uninstall_preserve_crlf_bom_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        let before = "\u{feff}{\r\n  // keep me\r\n  \"unknown\": {\"a\": 1},\r\n  \"mcpServers\": {\"other\": {\"command\": \"x\"}}\r\n}\r\n";
        std::fs::write(&config, before).unwrap();
        let plan = mcp_plan(&config);
        let outcome = apply_plan(&home, &user_home, None, &plan, &secrets()).unwrap();
        let text = std::fs::read_to_string(&config).unwrap();
        assert!(text.starts_with('\u{feff}'), "{text:?}");
        assert!(text.contains("// keep me\r\n"), "{text:?}");
        assert!(text.contains("\"unknown\": {\"a\": 1},\r\n"), "{text:?}");
        assert!(text.contains("\"other\""), "{text:?}");
        assert!(!text.replace("\r\n", "").contains('\n'), "{text:?}");
        assert_eq!(
            read_value(
                &text,
                ConfigFormat::Jsonc,
                &["mcpServers".into(), "demo".into()],
            )
            .unwrap()
            .unwrap()["env"]["DEMO_KEY"],
            "value"
        );

        let manifest = load_manifest(&home, &user_home, None, &outcome.install_id).unwrap();
        uninstall(&home, &user_home, None, &manifest, false).unwrap();
        let text = std::fs::read_to_string(&config).unwrap();
        assert!(text.starts_with('\u{feff}'), "{text:?}");
        assert!(text.contains("// keep me\r\n"), "{text:?}");
        assert!(text.contains("\"unknown\": {\"a\": 1},\r\n"), "{text:?}");
        assert!(!text.contains("\"demo\""), "{text:?}");
        assert!(!text.replace("\r\n", "").contains('\n'), "{text:?}");
    }

    #[test]
    fn preview_diff_shows_only_the_changed_key_and_redacts_other_values() {
        let dir = tempfile::tempdir().unwrap();
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        std::fs::write(
            &config,
            r#"{
  "apiKey": "unrelated-secret-value",
  "mcpServers": {
    "other": {"command": "other", "env": {"OTHER_TOKEN": "other-secret"}},
    "demo": {"command": "npx", "env": {"DEMO_KEY": "old-demo-secret"}}
  },
  "unknown": {"token": "unknown-secret"}
}
"#,
        )
        .unwrap();
        let plan = mcp_plan(&config);
        let preview = plan.preview.config.as_ref().expect("config preview");
        assert!(
            preview.diff.contains("@@ mcpServers.demo @@"),
            "{}",
            preview.diff
        );
        for secret in [
            "unrelated-secret-value",
            "other-secret",
            "old-demo-secret",
            "unknown-secret",
        ] {
            assert!(!preview.diff.contains(secret), "{}", preview.diff);
        }
        assert!(!preview.diff.contains("\"other\""), "{}", preview.diff);
        assert!(!preview.diff.contains("unknown"), "{}", preview.diff);
        let before = preview.before.as_ref().expect("before");
        assert_eq!(before["env"]["DEMO_KEY"], "<redacted>");
        assert_eq!(preview.after["env"]["DEMO_KEY"], "<secret:DEMO_KEY>");
        assert_eq!(
            plan.config.as_ref().unwrap().before.as_ref().unwrap()["env"]["DEMO_KEY"],
            "old-demo-secret",
            "the internal plan keeps the real value for verification"
        );
    }

    #[test]
    fn backups_are_timestamped_and_hold_the_original_config() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        let before = "{\n  \"unknown\": true\n}\n";
        std::fs::write(&config, before).unwrap();
        let plan = mcp_plan(&config);
        let outcome = apply_plan(&home, &user_home, None, &plan, &secrets()).unwrap();
        let root = home.join("market").join("backups");
        let entries: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);
        let name = entries[0].file_name().to_string_lossy().to_string();
        assert!(name.ends_with(&format!("-{}", outcome.backup_id)), "{name}");
        let stamp = &name[..name.len() - outcome.backup_id.len() - 1];
        assert!(stamp.starts_with("20"), "{stamp}");
        assert!(stamp.contains('T') && stamp.ends_with('Z'), "{stamp}");
        assert_eq!(
            std::fs::read_to_string(entries[0].path().join("config")).unwrap(),
            before
        );
        assert!(entries[0].path().join("backup.json").exists());
    }

    #[test]
    fn installs_into_a_user_home_with_spaces() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user home with spaces");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        let plan = mcp_plan(&config);
        apply_plan(&home, &user_home, None, &plan, &secrets()).unwrap();
        let text = std::fs::read_to_string(&config).unwrap();
        assert_eq!(
            read_value(
                &text,
                ConfigFormat::Jsonc,
                &["mcpServers".into(), "demo".into()],
            )
            .unwrap()
            .unwrap()["command"],
            "npx"
        );
    }

    #[cfg(unix)]
    #[test]
    fn existing_config_permissions_survive_the_write_and_backup() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let user_home = dir.path().join("user");
        std::fs::create_dir_all(&user_home).unwrap();
        let config = user_home.join(".claude.json");
        std::fs::write(&config, "{\n  \"unknown\": true\n}\n").unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o640)).unwrap();
        let plan = mcp_plan(&config);
        let outcome = apply_plan(&home, &user_home, None, &plan, &secrets()).unwrap();
        let mode = std::fs::metadata(&config).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
        let backups = home.join("market").join("backups");
        let backup_dir = std::fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(&outcome.backup_id)
            })
            .expect("timestamped backup");
        let backup_mode = std::fs::metadata(backup_dir.path().join("config"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(backup_mode, 0o640);
    }
}
