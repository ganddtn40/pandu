//! Adapter loading, path expansion, and PATH detection.
//!
//! Built-in adapters are embedded in the binary. A user can drop a TOML file
//! into `<home>/adapters/` to add a new agent or override a built-in one. A
//! broken user adapter never stops the daemon: it becomes an issue that
//! `pandu doctor` and the Settings screen can explain.

use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use pandu_core::adapter::{Adapter, AdapterIssue, AdapterRegistry};
use pandu_core::model::CaptureMode;
use rust_embed::RustEmbed;
use serde::Serialize;

#[derive(RustEmbed)]
#[folder = "../../adapters"]
struct BuiltinAdapterFiles;

/// Load every built-in adapter, then apply user overrides from `<home>/adapters`.
///
/// User files win by id. Invalid user files are reported but do not replace the
/// built-in adapter they were trying to override.
pub fn load_registry(home: &Path) -> AdapterRegistry {
    load_registry_with(home, true)
}

/// Load adapters with an option to skip the embedded built-ins. Tests use this
/// to keep a scan away from the developer's real agent logs.
pub fn load_registry_with(home: &Path, include_builtins: bool) -> AdapterRegistry {
    let mut adapters: Vec<Adapter> = Vec::new();
    let mut issues: Vec<AdapterIssue> = Vec::new();

    if include_builtins {
        for file in BuiltinAdapterFiles::iter() {
            if !file.ends_with(".toml") {
                continue;
            }
            let Some(data) = BuiltinAdapterFiles::get(&file) else {
                continue;
            };
            let contents = String::from_utf8_lossy(&data.data);
            let stem = Path::new(file.as_ref())
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default();
            match Adapter::from_toml(stem, &contents) {
                Ok(adapter) => adapters.push(adapter),
                Err(error) => issues.push(AdapterIssue {
                    source: format!("builtin:{file}"),
                    message: error.to_string(),
                }),
            }
        }
    }

    let user_dir = home.join("adapters");
    if let Ok(entries) = std::fs::read_dir(&user_dir) {
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("toml"))
            .collect();
        paths.sort();

        for path in paths {
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let contents = match std::fs::read_to_string(&path) {
                Ok(contents) => contents,
                Err(error) => {
                    issues.push(AdapterIssue {
                        source: path.display().to_string(),
                        message: format!("could not read adapter: {error}"),
                    });
                    continue;
                }
            };
            match Adapter::from_toml(stem, &contents) {
                Ok(adapter) => {
                    adapters.retain(|existing| existing.id != adapter.id);
                    adapters.push(adapter);
                }
                Err(error) => issues.push(AdapterIssue {
                    source: path.display().to_string(),
                    message: error.to_string(),
                }),
            }
        }
    } else if user_dir.exists() {
        issues.push(AdapterIssue {
            source: user_dir.display().to_string(),
            message: "the adapters directory is not readable".to_string(),
        });
    }

    AdapterRegistry::new(adapters, issues)
}

/// A lightweight detection result safe to send to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    /// The bare command a user can wrap with `pandu run --`.
    pub command: String,
    pub verified: bool,
    pub capture: Vec<CaptureMode>,
}

pub fn status_for(adapter: &Adapter) -> AdapterStatus {
    let executable = find_executable(&adapter.detect.command);
    AdapterStatus {
        id: adapter.id.clone(),
        name: adapter.name.clone(),
        installed: executable.is_some(),
        executable: executable.map(|path| path.display().to_string()),
        command: adapter.detect.command.clone(),
        verified: adapter.verified,
        capture: adapter.capture.clone(),
    }
}

pub fn statuses(registry: &AdapterRegistry) -> Vec<AdapterStatus> {
    registry.all().iter().map(status_for).collect()
}

/// Find an executable on `PATH` without running a shell.
pub fn find_executable(command: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    find_executable_in(command, &path)
}

/// Search an explicit `PATH` value. Tests use this instead of mutating the
/// process environment, which would race other tests.
pub fn find_executable_in(command: &str, path: &OsStr) -> Option<PathBuf> {
    if command.trim().is_empty() {
        return None;
    }
    for directory in env::split_paths(path) {
        for name in candidate_names(command) {
            let candidate = directory.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn candidate_names(command: &str) -> Vec<String> {
    let mut names = vec![command.to_string()];
    #[cfg(windows)]
    {
        let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        for extension in pathext.split(';').filter(|part| !part.is_empty()) {
            let extension = extension.to_ascii_lowercase();
            names.push(format!("{command}{extension}"));
        }
    }
    names.dedup();
    names
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Ask an installed agent for its version with a short timeout.
///
/// This never runs a shell and never passes user-controlled arguments.
pub async fn command_version(adapter: &Adapter) -> Option<String> {
    if adapter.detect.version_args.is_empty() {
        return None;
    }
    let executable = find_executable(&adapter.detect.command)?;
    #[cfg(windows)]
    {
        let extension = executable
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension == "cmd" || extension == "bat" {
            return None;
        }
    }

    let mut command = tokio::process::Command::new(&executable);
    command
        .args(&adapter.detect.version_args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let output = tokio::time::timeout(Duration::from_secs(3), command.output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(truncate(line, 120))
}

/// Expand `~` and `${VAR}` in an adapter path.
///
/// No other expansion is supported, and no globbing happens here.
pub fn expand_path(input: &str) -> Result<PathBuf, String> {
    let mut text = input.trim().to_string();
    if text.is_empty() {
        return Err("the path is empty".to_string());
    }

    if text == "~" {
        return home_dir().ok_or_else(|| "the home directory is not known".to_string());
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        let home = home_dir().ok_or_else(|| "the home directory is not known".to_string())?;
        return Ok(home.join(rest));
    }

    while let Some(start) = text.find("${") {
        let Some(end) = text[start + 2..].find('}').map(|offset| start + 2 + offset) else {
            return Err(format!("unclosed variable in path \"{input}\""));
        };
        let name = &text[start + 2..end];
        if name.is_empty()
            || !name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err(format!("invalid variable \"${{{name}}}\" in path"));
        }
        let value =
            env::var(name).map_err(|_| format!("environment variable {name} is not set"))?;
        text.replace_range(start..=end, &value);
    }

    if text.contains('~') {
        return Err(format!(
            "path \"{input}\" uses ~ somewhere other than the start"
        ));
    }

    Ok(PathBuf::from(text))
}

fn home_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf())
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(suffix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("{}-adapter-test-{suffix}", pandu_core::brand::SLUG))
    }

    #[test]
    fn every_builtin_adapter_loads() {
        let home = temp_home("empty-home");
        let registry = load_registry(&home);
        assert!(
            registry.issues().is_empty(),
            "built-in adapter issues: {:?}",
            registry.issues()
        );
        assert_eq!(registry.all().len(), 15);
        assert_eq!(registry.verified_count(), 0);
        for adapter in registry.all() {
            assert_eq!(adapter.filename(), format!("{}.toml", adapter.id));
        }
    }

    #[test]
    fn every_log_watch_parser_is_in_the_registry() {
        let home = temp_home("empty-home-2");
        let registry = load_registry(&home);
        for adapter in registry.log_watch_adapters() {
            let parser = &adapter.log_watch.as_ref().unwrap().parser;
            assert!(
                pandu_core::adapter::parser_is_known(parser),
                "{} uses unknown parser {parser}",
                adapter.id
            );
        }
    }

    #[test]
    fn codex_skills_paths_are_verified() {
        let home = temp_home("codex-skills");
        let registry = load_registry(&home);
        let skills = registry
            .get("codex")
            .unwrap()
            .skills
            .as_ref()
            .expect("Codex has a skills section");
        assert!(skills.verified);
        assert_eq!(skills.user_paths, vec!["~/.agents/skills"]);
        assert_eq!(skills.project_paths, vec![".agents/skills"]);
    }

    #[test]
    fn user_adapters_override_builtins() {
        let directory = tempfile::tempdir().unwrap();
        let adapters = directory.path().join("adapters");
        std::fs::create_dir_all(&adapters).unwrap();
        let contents = include_str!("../../../adapters/aider.toml")
            .replace("name = \"Aider\"", "name = \"Aider (local)\"");
        std::fs::write(adapters.join("aider.toml"), contents).unwrap();

        let registry = load_registry(directory.path());
        assert_eq!(registry.get("aider").unwrap().name, "Aider (local)");
        assert_eq!(registry.all().len(), 15);
    }

    #[test]
    fn a_broken_user_adapter_is_an_issue_not_a_crash() {
        let directory = tempfile::tempdir().unwrap();
        let adapters = directory.path().join("adapters");
        std::fs::create_dir_all(&adapters).unwrap();
        std::fs::write(adapters.join("broken.toml"), "schema_version = 1").unwrap();

        let registry = load_registry(directory.path());
        assert_eq!(registry.all().len(), 15);
        assert_eq!(registry.issues().len(), 1);
        assert!(registry.issues()[0].source.ends_with("broken.toml"));
    }

    fn write_executable(path: &Path) {
        std::fs::write(path, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[test]
    fn detection_only_finds_binaries_that_exist_on_the_given_path() {
        let directory = tempfile::tempdir().unwrap();
        write_executable(&directory.path().join("gemini"));
        let path = directory.path().as_os_str();

        assert_eq!(
            find_executable_in("gemini", path),
            Some(directory.path().join("gemini"))
        );
        // VS Code ships a `code` binary, but it is not an agent CLI. The
        // adapter must not claim it as Roo/Kilo.
        assert_eq!(find_executable_in("code", path), None);
        assert_eq!(find_executable_in("  ", path), None);
    }

    #[test]
    fn adapter_detection_uses_the_real_binary_names() {
        let home = temp_home("detect-home");
        let registry = load_registry(&home);

        let gemini = registry.get("gemini-cli").expect("gemini-cli adapter");
        assert_eq!(gemini.detect.command, "gemini");
        let roo = registry.get("roo-kilo").expect("roo-kilo adapter");
        assert_eq!(roo.detect.command, "kilocode");
        assert!(registry.get("antigravity").is_none());
        assert!(
            registry
                .all()
                .iter()
                .all(|adapter| adapter.detect.command != "code"),
            "no adapter should detect VS Code's `code` binary"
        );
    }

    #[test]
    fn expands_home_and_environment_variables() {
        let home = home_dir().unwrap();
        assert_eq!(expand_path("~/.claude").unwrap(), home.join(".claude"));

        let variable = pandu_core::brand::env_name("TEST_ROOT");
        unsafe {
            env::set_var(&variable, "/tmp/pandu-root");
        }
        let expanded = expand_path(&format!("${{{variable}}}/logs")).unwrap();
        assert!(expanded.ends_with("logs"));
        assert!(!expanded.to_string_lossy().contains("${"));
    }

    #[test]
    fn rejects_unknown_variables() {
        let variable = pandu_core::brand::env_name("MISSING_VARIABLE");
        let error = expand_path(&format!("${{{variable}}}/logs")).unwrap_err();
        assert!(error.contains(&variable));
    }

    #[test]
    fn rejects_a_tilde_in_the_middle() {
        let error = expand_path("/tmp/~/logs").unwrap_err();
        assert!(error.contains("somewhere other than the start"));
    }
}
