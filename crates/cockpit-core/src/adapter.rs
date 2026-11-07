//! Data-driven agent adapters.
//!
//! An adapter is a TOML file. It never contains executable code: the daemon
//! ships a fixed parser registry and adapters only choose a parser and describe
//! where files live. Everything here is pure parsing and validation so it can
//! be tested without touching the filesystem.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::CaptureMode;
use crate::provider::ProviderProtocol;

pub const ADAPTER_SCHEMA_VERSION: u32 = 1;

/// Parsers implemented by `cockpit-daemon`. Unknown names are rejected when an
/// adapter is loaded.
pub const PARSER_REGISTRY: &[&str] = &[
    "claude-code-jsonl",
    "codex-jsonl",
    "gemini-cli-json",
    "generic-jsonl",
    "generic-json",
];

pub fn parser_is_known(name: &str) -> bool {
    PARSER_REGISTRY.contains(&name)
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct AdapterError(pub String);

impl AdapterError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// The wire protocol an adapter speaks through the proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdapterProtocol {
    OpenaiChat,
    OpenaiResponses,
    Anthropic,
    Gemini,
}

impl AdapterProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenaiChat => "openai-chat",
            Self::OpenaiResponses => "openai-responses",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }

    pub fn provider(self) -> ProviderProtocol {
        match self {
            Self::OpenaiChat | Self::OpenaiResponses => ProviderProtocol::Openai,
            Self::Anthropic => ProviderProtocol::Anthropic,
            Self::Gemini => ProviderProtocol::Gemini,
        }
    }

    /// Path appended to the daemon's origin for this protocol.
    pub fn proxy_base_path(self) -> &'static str {
        match self {
            Self::OpenaiChat | Self::OpenaiResponses => "/v1",
            Self::Anthropic | Self::Gemini => "",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct Detect {
    /// Bare executable name. No paths, arguments, or shell interpolation.
    pub command: String,
    #[serde(default)]
    pub version_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ProxySpec {
    pub protocols: Vec<AdapterProtocol>,
    pub base_url_env: Vec<String>,
    pub api_key_env: Vec<String>,
    #[serde(default)]
    pub setup_note: String,
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct LogWatchSpec {
    /// Directories to watch. `~` and `${VAR}` are expanded; no globs.
    pub roots: Vec<String>,
    /// Glob patterns relative to each root.
    pub include: Vec<String>,
    /// One of `PARSER_REGISTRY`.
    pub parser: String,
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct HookOtelSpec {
    #[serde(default)]
    pub otlp_http: bool,
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct Adapter {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub verified: bool,
    pub docs_url: String,
    pub capture: Vec<CaptureMode>,
    pub detect: Detect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxySpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_watch: Option<LogWatchSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_otel: Option<HookOtelSpec>,
}

impl Adapter {
    /// Parse and validate one adapter file.
    ///
    /// `expected_id` is the file stem; the declared `id` must match it so two
    /// files cannot silently claim the same identity.
    pub fn from_toml(expected_id: &str, contents: &str) -> Result<Self, AdapterError> {
        let mut adapter: Self =
            toml::from_str(contents).map_err(|error| AdapterError::new(error.to_string()))?;
        adapter.validate(Some(expected_id))?;
        adapter.normalize();
        Ok(adapter)
    }

    pub fn validate(&self, expected_id: Option<&str>) -> Result<(), AdapterError> {
        if self.schema_version != ADAPTER_SCHEMA_VERSION {
            return Err(AdapterError::new(format!(
                "adapter {} uses schema_version {}, but this build understands {}",
                self.id, self.schema_version, ADAPTER_SCHEMA_VERSION
            )));
        }
        validate_id(&self.id)?;
        if let Some(expected) = expected_id {
            if self.id != expected {
                return Err(AdapterError::new(format!(
                    "adapter file {expected}.toml declares id \"{}\"; the filename and id must match",
                    self.id
                )));
            }
        }
        if self.name.trim().is_empty() || self.name.len() > 80 || self.name.contains('\n') {
            return Err(AdapterError::new(
                "adapter name must be 1-80 characters on one line",
            ));
        }
        if !self.docs_url.starts_with("https://") || !self.docs_url.contains('.') {
            return Err(AdapterError::new(
                "docs_url must be an https:// vendor documentation URL",
            ));
        }
        if self.capture.is_empty() {
            return Err(AdapterError::new(
                "capture must list at least one capture mode",
            ));
        }
        let mut modes = BTreeSet::new();
        for mode in &self.capture {
            if !modes.insert(mode.as_str()) {
                return Err(AdapterError::new(format!(
                    "capture lists {} twice",
                    mode.as_str()
                )));
            }
        }
        if modes.contains("proxy") && self.proxy.is_none() {
            return Err(AdapterError::new(
                "capture includes proxy but the [proxy] section is missing",
            ));
        }
        if modes.contains("log_watch") && self.log_watch.is_none() {
            return Err(AdapterError::new(
                "capture includes log_watch but the [log_watch] section is missing",
            ));
        }
        if modes.contains("hook_otel") && self.hook_otel.is_none() {
            return Err(AdapterError::new(
                "capture includes hook_otel but the [hook_otel] section is missing",
            ));
        }
        if self.proxy.is_some() && !modes.contains("proxy") {
            return Err(AdapterError::new(
                "[proxy] is present but capture does not include proxy",
            ));
        }
        if self.log_watch.is_some() && !modes.contains("log_watch") {
            return Err(AdapterError::new(
                "[log_watch] is present but capture does not include log_watch",
            ));
        }
        if self.hook_otel.is_some() && !modes.contains("hook_otel") {
            return Err(AdapterError::new(
                "[hook_otel] is present but capture does not include hook_otel",
            ));
        }

        validate_command(&self.detect.command)?;
        if self.detect.version_args.len() > 8 {
            return Err(AdapterError::new(
                "version_args accepts at most 8 arguments",
            ));
        }
        for argument in &self.detect.version_args {
            if argument.len() > 100 || argument.contains('\0') {
                return Err(AdapterError::new(
                    "version_args entries must be at most 100 characters",
                ));
            }
        }

        if let Some(proxy) = &self.proxy {
            if proxy.protocols.is_empty() {
                return Err(AdapterError::new(
                    "proxy.protocols must list at least one protocol",
                ));
            }
            let mut protocols = BTreeSet::new();
            for protocol in &proxy.protocols {
                if !protocols.insert(protocol.as_str()) {
                    return Err(AdapterError::new(format!(
                        "proxy.protocols lists {} twice",
                        protocol.as_str()
                    )));
                }
            }
            validate_env_names("proxy.base_url_env", &proxy.base_url_env)?;
            validate_env_names("proxy.api_key_env", &proxy.api_key_env)?;
            if proxy.setup_note.len() > 500 {
                return Err(AdapterError::new(
                    "proxy.setup_note must be at most 500 characters",
                ));
            }
        }

        if let Some(log_watch) = &self.log_watch {
            if log_watch.roots.is_empty() {
                return Err(AdapterError::new(
                    "log_watch.roots must list at least one directory",
                ));
            }
            for root in &log_watch.roots {
                if root.trim().is_empty() || root.len() > 500 || root.contains('*') {
                    return Err(AdapterError::new(
                        "log_watch roots must be concrete paths of at most 500 characters",
                    ));
                }
            }
            if log_watch.include.is_empty() {
                return Err(AdapterError::new(
                    "log_watch.include must list at least one glob",
                ));
            }
            for pattern in &log_watch.include {
                if pattern.trim().is_empty() || pattern.len() > 200 {
                    return Err(AdapterError::new(
                        "log_watch include patterns must be 1-200 characters",
                    ));
                }
            }
            if !parser_is_known(&log_watch.parser) {
                return Err(AdapterError::new(format!(
                    "log_watch.parser \"{}\" is not in the parser registry ({})",
                    log_watch.parser,
                    PARSER_REGISTRY.join(", ")
                )));
            }
        }

        if let Some(hook) = &self.hook_otel {
            if !hook.otlp_http && hook.hooks.is_empty() {
                return Err(AdapterError::new(
                    "hook_otel must enable otlp_http or list at least one hook",
                ));
            }
            for name in &hook.hooks {
                if name.trim().is_empty() || name.len() > 80 || !name.contains('_') {
                    return Err(AdapterError::new(
                        "hook names must be snake_case identifiers of at most 80 characters",
                    ));
                }
            }
        }

        Ok(())
    }

    /// A top-level `verified = true` is only honest when every declared section
    /// is verified too.
    fn normalize(&mut self) {
        let sections_verified = self.proxy.as_ref().is_none_or(|proxy| proxy.verified)
            && self
                .log_watch
                .as_ref()
                .is_none_or(|log_watch| log_watch.verified)
            && self.hook_otel.as_ref().is_none_or(|hook| hook.verified);
        self.verified = self.verified && sections_verified;
    }

    pub fn supports(&self, mode: CaptureMode) -> bool {
        self.capture.contains(&mode)
    }

    pub fn primary_protocol(&self) -> Option<AdapterProtocol> {
        self.proxy
            .as_ref()
            .and_then(|proxy| proxy.protocols.first().copied())
    }

    pub fn filename(&self) -> String {
        format!("{}.toml", self.id)
    }
}

fn validate_id(id: &str) -> Result<(), AdapterError> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        && id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        && id
            .chars()
            .last()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        && !id.contains("--");
    if !valid {
        return Err(AdapterError::new(format!(
            "adapter id \"{id}\" must be lowercase letters, digits, and single hyphens"
        )));
    }
    Ok(())
}

fn validate_command(command: &str) -> Result<(), AdapterError> {
    let valid = !command.is_empty()
        && command.len() <= 64
        && !command.contains('/')
        && !command.contains('\\')
        && !command.chars().any(char::is_whitespace);
    if !valid {
        return Err(AdapterError::new(
            "detect.command must be a bare executable name, not a path or shell command",
        ));
    }
    Ok(())
}

fn validate_env_names(field: &str, names: &[String]) -> Result<(), AdapterError> {
    if names.is_empty() {
        return Err(AdapterError::new(format!(
            "{field} must list at least one environment variable"
        )));
    }
    for name in names {
        let valid = !name.is_empty()
            && name.len() <= 100
            && name
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_uppercase() || character == '_')
            && name.chars().all(|character| {
                character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
            });
        if !valid {
            return Err(AdapterError::new(format!(
                "{field} contains \"{name}\", which is not an environment variable name"
            )));
        }
    }
    Ok(())
}

/// A validated collection of adapters plus the files that failed to load.
///
/// Load errors are data, not fatal: one broken community adapter must never
/// stop the daemon from recording.
#[derive(Debug, Default, Clone)]
pub struct AdapterRegistry {
    adapters: Vec<Adapter>,
    issues: Vec<AdapterIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterIssue {
    pub source: String,
    pub message: String,
}

impl AdapterRegistry {
    pub fn new(adapters: Vec<Adapter>, issues: Vec<AdapterIssue>) -> Self {
        let mut adapters = adapters;
        adapters.sort_by(|left, right| left.name.cmp(&right.name));
        Self { adapters, issues }
    }

    pub fn all(&self) -> &[Adapter] {
        &self.adapters
    }

    pub fn issues(&self) -> &[AdapterIssue] {
        &self.issues
    }

    pub fn get(&self, id: &str) -> Option<&Adapter> {
        self.adapters.iter().find(|adapter| adapter.id == id)
    }

    pub fn find(&self, id_or_name: &str) -> Option<&Adapter> {
        let wanted = id_or_name.trim();
        self.adapters
            .iter()
            .find(|adapter| adapter.id.eq_ignore_ascii_case(wanted))
            .or_else(|| {
                self.adapters
                    .iter()
                    .find(|adapter| adapter.name.eq_ignore_ascii_case(wanted))
            })
    }

    pub fn verified_count(&self) -> usize {
        self.adapters
            .iter()
            .filter(|adapter| adapter.verified)
            .count()
    }

    pub fn log_watch_adapters(&self) -> impl Iterator<Item = &Adapter> {
        self.adapters
            .iter()
            .filter(|adapter| adapter.log_watch.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"
schema_version = 1
id = "example-agent"
name = "Example Agent"
verified = false
docs_url = "https://example.com/docs/agent"
capture = ["proxy", "log_watch"]

[detect]
command = "example"
version_args = ["--version"]

[proxy]
protocols = ["openai-chat"]
base_url_env = ["OPENAI_BASE_URL"]
api_key_env = ["OPENAI_API_KEY"]
setup_note = "Point the agent at Cockpit's local base URL."
verified = false

[log_watch]
roots = ["~/.example-agent/sessions"]
include = ["**/*.jsonl"]
parser = "generic-jsonl"
verified = false
"#;

    #[test]
    fn parses_a_valid_adapter() {
        let adapter = Adapter::from_toml("example-agent", VALID).unwrap();
        assert_eq!(adapter.id, "example-agent");
        assert_eq!(adapter.capture.len(), 2);
        assert!(adapter.supports(CaptureMode::LogWatch));
        assert_eq!(
            adapter.primary_protocol(),
            Some(AdapterProtocol::OpenaiChat)
        );
        assert_eq!(adapter.primary_protocol().unwrap().proxy_base_path(), "/v1");
        assert!(!adapter.verified);
    }

    #[test]
    fn unverified_sections_force_the_summary_to_false() {
        let contents = VALID.replace(
            "verified = false\ndocs_url =",
            "verified = true\ndocs_url =",
        );
        let adapter = Adapter::from_toml("example-agent", &contents).unwrap();
        assert!(!adapter.verified);
    }

    #[test]
    fn rejects_a_filename_that_does_not_match_the_id() {
        let error = Adapter::from_toml("other", VALID).unwrap_err();
        assert!(error.to_string().contains("filename and id must match"));
    }

    #[test]
    fn rejects_an_unknown_parser() {
        let contents = VALID.replace("generic-jsonl", "shell-script");
        let error = Adapter::from_toml("example-agent", &contents).unwrap_err();
        assert!(error.to_string().contains("parser registry"));
    }

    #[test]
    fn rejects_a_missing_section_for_a_capture_mode() {
        let contents = VALID.replace(
            "capture = [\"proxy\", \"log_watch\"]",
            "capture = [\"proxy\", \"log_watch\", \"hook_otel\"]",
        );
        let error = Adapter::from_toml("example-agent", &contents).unwrap_err();
        assert!(error.to_string().contains("[hook_otel] section is missing"));
    }

    #[test]
    fn rejects_a_command_with_arguments_or_a_path() {
        let contents = VALID.replace("command = \"example\"", "command = \"example --flag\"");
        let error = Adapter::from_toml("example-agent", &contents).unwrap_err();
        assert!(error.to_string().contains("bare executable name"));
    }

    #[test]
    fn rejects_glob_characters_in_log_roots() {
        let contents = VALID.replace("~/.example-agent/sessions", "~/.example-agent/*");
        let error = Adapter::from_toml("example-agent", &contents).unwrap_err();
        assert!(error.to_string().contains("concrete paths"));
    }

    #[test]
    fn registry_finds_adapters_by_id_or_display_name() {
        let adapter = Adapter::from_toml("example-agent", VALID).unwrap();
        let registry = AdapterRegistry::new(vec![adapter], Vec::new());
        assert!(registry.get("example-agent").is_some());
        assert!(registry.find("Example Agent").is_some());
        assert_eq!(registry.verified_count(), 0);
    }
}
