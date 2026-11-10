//! The skill and MCP market.
//!
//! Everything here treats a registry entry as untrusted input. The index and
//! revocation list must carry a valid Ed25519 signature from the embedded
//! public key before any entry is parsed. Installs are host-only, copy files or
//! edit configuration, and never execute a package manager, script, or MCP
//! server.

pub mod archive;
pub mod config_edit;
pub mod http;
pub mod install;
mod legacy_key;
pub mod registry_check;
pub mod service;
pub mod signing;
pub mod targets;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MARKET_SCHEMA_VERSION: u32 = 1;
/// Production registry files. Release builds load and verify these.
pub const INDEX_FILE: &str = "index.json";
pub const REVOKED_FILE: &str = "revoked.json";
/// Test registry files. Debug and test builds load and verify these. They are
/// signed with the test key, which never appears in a release build.
pub const TEST_INDEX_FILE: &str = "index.test.json";
pub const TEST_REVOKED_FILE: &str = "revoked.test.json";

#[cfg(debug_assertions)]
pub const ACTIVE_INDEX_FILE: &str = TEST_INDEX_FILE;
#[cfg(not(debug_assertions))]
pub const ACTIVE_INDEX_FILE: &str = INDEX_FILE;

#[cfg(debug_assertions)]
pub const ACTIVE_REVOKED_FILE: &str = TEST_REVOKED_FILE;
#[cfg(not(debug_assertions))]
pub const ACTIVE_REVOKED_FILE: &str = REVOKED_FILE;
pub const MAX_ENTRY_BYTES: usize = 256 * 1024;
pub const MAX_README_BYTES: usize = 100 * 1024;
pub const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_EXTRACTED_BYTES: u64 = 40 * 1024 * 1024;
pub const MAX_ARCHIVE_FILES: usize = 1_000;
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Ed25519 public key for the production Pandu registry. The matching
/// private key is kept offline by maintainers and is never part of this
/// repository or a debug build.
pub const PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64: &str =
    "iE0AJlU1Nd+iTodC0vgTYx7aMFCETJisOnFEIsP6hMc=";
pub const PRODUCTION_REGISTRY_KEY_ID: &str = legacy_key::PRODUCTION_KEY_ID;

/// Ed25519 public key for the test registry. It only signs the `.test.json`
/// registry variants used by debug builds, tests, and the e2e fixtures. The
/// matching private key is a test key and is not accepted by a release build.
pub const TEST_REGISTRY_PUBLIC_KEY_BASE64: &str = "BU/+PJwKB5yqebHqAd3lANMGOC3HAAMsfjI0m/U48l8=";
pub const TEST_REGISTRY_KEY_ID: &str = pandu_core::brand::MARKET_TEST_KEY_ID;

#[cfg(debug_assertions)]
pub const REGISTRY_PUBLIC_KEY_BASE64: &str = TEST_REGISTRY_PUBLIC_KEY_BASE64;
#[cfg(not(debug_assertions))]
pub const REGISTRY_PUBLIC_KEY_BASE64: &str = PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64;

#[cfg(debug_assertions)]
pub const REGISTRY_KEY_ID: &str = TEST_REGISTRY_KEY_ID;
#[cfg(not(debug_assertions))]
pub const REGISTRY_KEY_ID: &str = PRODUCTION_REGISTRY_KEY_ID;

/// Refuse to start a release build whose trust root is the test key. The
/// function takes the key and the build mode explicitly so tests can prove
/// that a release configuration rejects a test key without building one.
pub fn trust_root_error(public_key: &str, key_id: &str, debug: bool) -> Option<String> {
    let is_test = public_key == TEST_REGISTRY_PUBLIC_KEY_BASE64 || key_id == TEST_REGISTRY_KEY_ID;
    if is_test && !debug {
        return Some(
            "This release build embedded the test registry key. Pandu refuses to open the \
             market with a test trust root."
                .into(),
        );
    }
    if !is_test
        && (public_key != PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64
            || key_id != PRODUCTION_REGISTRY_KEY_ID)
    {
        return Some(
            "This build does not embed a recognised Pandu registry key. Pandu refuses to \
             open the market."
                .into(),
        );
    }
    None
}

pub const SPDX_ALLOWLIST: &[&str] = &[
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "CC0-1.0",
    "CC-BY-4.0",
    "ISC",
    "MIT",
    "MPL-2.0",
    "Unlicense",
];

/// The controlled category vocabulary. Entries may only use these values;
/// free-form labels belong in `tags`. Keep this list in sync with
/// `registry/schema/entry.schema.json` and the market UI.
pub const MARKET_CATEGORIES: &[&str] = &[
    "coding",
    "testing",
    "security",
    "docs",
    "devops",
    "data",
    "design",
    "productivity",
    "other",
];

pub const MARKET_AGENTS: &[&str] = &[
    "claude-code",
    "codex",
    "gemini-cli",
    "opencode",
    "cursor-cli",
    "copilot-cli",
    "cline",
    "goose",
    "aider",
    "amp",
    "crush",
    "openhands",
    "pi",
    "qwen-code",
    "roo-kilo",
];

pub const PERMISSION_IDS: &[&str] = &[
    "filesystem:read",
    "filesystem:write",
    "network",
    "shell",
    "secrets",
    "clipboard",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarketError {
    Signature(String),
    Registry(String),
    Entry(String),
    Archive(String),
    Config(String),
    Install(String),
    Manifest(String),
    Network(String),
    NotFound(String),
}

impl MarketError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Signature(_) => "market_signature_invalid",
            Self::Registry(_) => "market_registry_invalid",
            Self::Entry(_) => "market_entry_invalid",
            Self::Archive(_) => "market_archive_invalid",
            Self::Config(_) => "market_config_invalid",
            Self::Install(_) => "market_install_failed",
            Self::Manifest(_) => "market_manifest_invalid",
            Self::Network(_) => "market_network_failed",
            Self::NotFound(_) => "market_not_found",
        }
    }
}

impl std::fmt::Display for MarketError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Signature(message)
            | Self::Registry(message)
            | Self::Entry(message)
            | Self::Archive(message)
            | Self::Config(message)
            | Self::Install(message)
            | Self::Manifest(message)
            | Self::Network(message)
            | Self::NotFound(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for MarketError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum MarketKind {
    Skill,
    Mcp,
}

impl MarketKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Mcp => "mcp",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "skill" => Some(Self::Skill),
            "mcp" => Some(Self::Mcp),
            _ => None,
        }
    }

    pub fn directory(self) -> &'static str {
        match self {
            Self::Skill => "skills",
            Self::Mcp => "mcp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum TrustTier {
    Official,
    CommunityReviewed,
    Unreviewed,
}

impl TrustTier {
    pub fn rank(self) -> u8 {
        match self {
            Self::Official => 0,
            Self::CommunityReviewed => 1,
            Self::Unreviewed => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallScope {
    User,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub name: String,
    pub date: String,
    #[serde(alias = "ci_passed")]
    pub ci_passed: bool,
    #[serde(default, alias = "ci_url")]
    pub ci_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPermission {
    pub id: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSource {
    /// `https://github.com/<owner>/<repo>` only.
    pub repo: String,
    /// Full 40-character commit SHA. Branches and tags are rejected.
    pub commit: String,
    /// SHA-256 over the normalized file tree.
    #[serde(alias = "content_sha256")]
    pub content_sha256: String,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAgentTarget {
    pub agent: String,
    pub scopes: Vec<InstallScope>,
    /// Optional subdirectory inside the repository that becomes the skill
    /// folder. `None` means the repository root is the skill.
    #[serde(default)]
    pub subdir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecipe {
    pub install: Vec<SkillAgentTarget>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpTransport {
    Stdio,
    Http,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAgentTarget {
    pub agent: String,
    pub scopes: Vec<InstallScope>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRecipe {
    pub transport: McpTransport,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// Required environment variable names. Never values.
    #[serde(default)]
    pub env: Vec<String>,
    /// Names Pandu may ask for locally. Values are never stored in the
    /// registry, the database, or the install manifest.
    #[serde(default)]
    pub secrets: Vec<String>,
    pub install: Vec<McpAgentTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    #[serde(alias = "schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub kind: MarketKind,
    pub version: String,
    #[serde(alias = "short_description")]
    pub short_description: String,
    #[serde(alias = "long_description")]
    pub long_description: String,
    pub categories: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub agents: Vec<String>,
    pub source: MarketSource,
    pub license: String,
    pub trust: TrustTier,
    #[serde(default)]
    pub reviewer: Option<Reviewer>,
    #[serde(default, alias = "reviewed_on")]
    pub reviewed_on: Option<String>,
    #[serde(default)]
    pub example: bool,
    #[serde(default)]
    pub permissions: Vec<MarketPermission>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub skills: Option<SkillRecipe>,
    #[serde(default)]
    pub mcp: Option<McpRecipe>,
    #[serde(default)]
    pub readme: String,
}

impl MarketEntry {
    pub fn validate(&self) -> Result<(), MarketError> {
        if self.schema_version != MARKET_SCHEMA_VERSION {
            return Err(MarketError::Entry(format!(
                "entry {} uses schema_version {}; this build understands {}",
                self.id, self.schema_version, MARKET_SCHEMA_VERSION
            )));
        }
        validate_id(&self.id)?;
        validate_text("name", &self.name, 1, 80)?;
        validate_text("version", &self.version, 1, 40)?;
        validate_text("short_description", &self.short_description, 1, 240)?;
        validate_text("long_description", &self.long_description, 1, 2_000)?;
        if self.categories.is_empty() || self.categories.len() > 8 {
            return Err(MarketError::Entry(format!(
                "entry {} must list 1-8 categories",
                self.id
            )));
        }
        let mut seen_categories = BTreeSet::new();
        for category in &self.categories {
            if !MARKET_CATEGORIES.contains(&category.as_str()) {
                return Err(MarketError::Entry(format!(
                    "entry {} uses category `{category}`, which is not in the controlled vocabulary ({}); put free-form labels in tags",
                    self.id,
                    MARKET_CATEGORIES.join(", ")
                )));
            }
            if !seen_categories.insert(category) {
                return Err(MarketError::Entry(format!(
                    "entry {} lists category `{category}` twice",
                    self.id
                )));
            }
        }
        if self.tags.len() > 12 {
            return Err(MarketError::Entry(format!(
                "entry {} must list at most 12 tags",
                self.id
            )));
        }
        let mut seen_tags = BTreeSet::new();
        for tag in &self.tags {
            validate_text("tag", tag, 1, 40)?;
            if !seen_tags.insert(tag) {
                return Err(MarketError::Entry(format!(
                    "entry {} lists tag `{tag}` twice",
                    self.id
                )));
            }
        }
        if self.agents.is_empty() {
            return Err(MarketError::Entry(format!(
                "entry {} must support at least one agent",
                self.id
            )));
        }
        let mut seen = BTreeSet::new();
        for agent in &self.agents {
            if !MARKET_AGENTS.contains(&agent.as_str()) {
                return Err(MarketError::Entry(format!(
                    "entry {} names unknown agent `{agent}`",
                    self.id
                )));
            }
            if !seen.insert(agent) {
                return Err(MarketError::Entry(format!(
                    "entry {} lists agent `{agent}` twice",
                    self.id
                )));
            }
        }
        validate_source(&self.source, self.example)?;
        if !SPDX_ALLOWLIST.contains(&self.license.as_str()) {
            return Err(MarketError::Entry(format!(
                "entry {} uses license `{}`, which is not on the SPDX allowlist",
                self.id, self.license
            )));
        }
        match self.trust {
            TrustTier::Official => {
                if self.reviewer.is_none() || self.reviewed_on.is_none() {
                    return Err(MarketError::Entry(format!(
                        "entry {} is Official but has no reviewer or reviewed_on date",
                        self.id
                    )));
                }
            }
            TrustTier::CommunityReviewed => {
                let reviewer = self.reviewer.as_ref().ok_or_else(|| {
                    MarketError::Entry(format!(
                        "entry {} is Community-reviewed but has no reviewer",
                        self.id
                    ))
                })?;
                if !reviewer.ci_passed {
                    return Err(MarketError::Entry(format!(
                        "entry {} is Community-reviewed but its CI check did not pass",
                        self.id
                    )));
                }
                if self.reviewed_on.is_none() {
                    return Err(MarketError::Entry(format!(
                        "entry {} is Community-reviewed but has no reviewed_on date",
                        self.id
                    )));
                }
            }
            TrustTier::Unreviewed => {}
        }
        if let Some(reviewer) = &self.reviewer {
            validate_text("reviewer.name", &reviewer.name, 1, 80)?;
            validate_date(&reviewer.date)?;
            if let Some(url) = &reviewer.ci_url {
                validate_https_url("reviewer.ci_url", url)?;
            }
        }
        if let Some(date) = &self.reviewed_on {
            validate_date(date)?;
        }
        if let Some(homepage) = &self.homepage {
            validate_https_url("homepage", homepage)?;
        }
        if self.permissions.len() > 16 {
            return Err(MarketError::Entry(format!(
                "entry {} requests too many permissions",
                self.id
            )));
        }
        let mut permission_ids = BTreeSet::new();
        for permission in &self.permissions {
            if !PERMISSION_IDS.contains(&permission.id.as_str()) {
                return Err(MarketError::Entry(format!(
                    "entry {} requests unknown permission `{}`",
                    self.id, permission.id
                )));
            }
            if !permission_ids.insert(&permission.id) {
                return Err(MarketError::Entry(format!(
                    "entry {} lists permission `{}` twice",
                    self.id, permission.id
                )));
            }
            validate_text("permission.description", &permission.description, 1, 200)?;
        }
        match self.kind {
            MarketKind::Skill => {
                let skills = self.skills.as_ref().ok_or_else(|| {
                    MarketError::Entry(format!("skill {} has no [skills] recipe", self.id))
                })?;
                if skills.install.is_empty() {
                    return Err(MarketError::Entry(format!(
                        "skill {} has no agent install target",
                        self.id
                    )));
                }
                for target in &skills.install {
                    validate_agent_target(&self.id, &target.agent, &target.scopes)?;
                    if let Some(subdir) = &target.subdir {
                        validate_relative_path("skills.install.subdir", subdir)?;
                    }
                }
                if self.mcp.is_some() {
                    return Err(MarketError::Entry(format!(
                        "skill {} must not carry an [mcp] recipe",
                        self.id
                    )));
                }
            }
            MarketKind::Mcp => {
                let mcp = self.mcp.as_ref().ok_or_else(|| {
                    MarketError::Entry(format!("MCP server {} has no [mcp] recipe", self.id))
                })?;
                if mcp.install.is_empty() {
                    return Err(MarketError::Entry(format!(
                        "MCP server {} has no agent install target",
                        self.id
                    )));
                }
                for target in &mcp.install {
                    validate_agent_target(&self.id, &target.agent, &target.scopes)?;
                }
                match mcp.transport {
                    McpTransport::Stdio => {
                        let command = mcp.command.as_deref().ok_or_else(|| {
                            MarketError::Entry(format!(
                                "MCP server {} is stdio but has no command",
                                self.id
                            ))
                        })?;
                        validate_executable(command)?;
                        if mcp.url.is_some() {
                            return Err(MarketError::Entry(format!(
                                "MCP server {} is stdio but carries a url",
                                self.id
                            )));
                        }
                        validate_pinned_args(command, &mcp.args)?;
                    }
                    McpTransport::Http => {
                        let url = mcp.url.as_deref().ok_or_else(|| {
                            MarketError::Entry(format!(
                                "MCP server {} is http but has no url",
                                self.id
                            ))
                        })?;
                        validate_https_url("mcp.url", url)?;
                        if mcp.command.is_some() || !mcp.args.is_empty() {
                            return Err(MarketError::Entry(format!(
                                "MCP server {} is http but carries a command or args",
                                self.id
                            )));
                        }
                    }
                }
                let mut env = BTreeSet::new();
                for name in mcp.env.iter().chain(mcp.secrets.iter()) {
                    validate_env_name(name)?;
                    if !env.insert(name) {
                        return Err(MarketError::Entry(format!(
                            "MCP server {} lists environment variable `{name}` twice",
                            self.id
                        )));
                    }
                }
                if self.skills.is_some() {
                    return Err(MarketError::Entry(format!(
                        "MCP server {} must not carry a [skills] recipe",
                        self.id
                    )));
                }
            }
        }
        if self.readme.len() > MAX_README_BYTES {
            return Err(MarketError::Entry(format!(
                "entry {} README is larger than {} bytes",
                self.id, MAX_README_BYTES
            )));
        }
        Ok(())
    }

    pub fn supports(&self, agent: &str, scope: InstallScope) -> bool {
        match self.kind {
            MarketKind::Skill => self.skills.as_ref().is_some_and(|recipe| {
                recipe
                    .install
                    .iter()
                    .any(|target| target.agent == agent && target.scopes.contains(&scope))
            }),
            MarketKind::Mcp => self.mcp.as_ref().is_some_and(|recipe| {
                recipe
                    .install
                    .iter()
                    .any(|target| target.agent == agent && target.scopes.contains(&scope))
            }),
        }
    }
}

fn validate_id(id: &str) -> Result<(), MarketError> {
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
        return Err(MarketError::Entry(format!(
            "id `{id}` must be lowercase letters, digits, and single hyphens"
        )));
    }
    Ok(())
}

fn validate_text(
    field: &str,
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), MarketError> {
    let length = value.chars().count();
    if length < minimum || length > maximum || value.contains('\0') {
        return Err(MarketError::Entry(format!(
            "{field} must be {minimum}-{maximum} characters"
        )));
    }
    Ok(())
}

fn validate_date(value: &str) -> Result<(), MarketError> {
    if chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err() {
        return Err(MarketError::Entry(format!(
            "`{value}` is not an ISO date (YYYY-MM-DD)"
        )));
    }
    Ok(())
}

fn validate_https_url(field: &str, value: &str) -> Result<(), MarketError> {
    if !value.starts_with("https://") || value.len() > 500 || value.contains(char::is_whitespace) {
        return Err(MarketError::Entry(format!(
            "{field} must be an https:// URL without whitespace"
        )));
    }
    Ok(())
}

fn validate_source(source: &MarketSource, example: bool) -> Result<(), MarketError> {
    // Real entries must point at GitHub, which is the only host Pandu
    // downloads pinned tarballs from. Example fixtures must use the reserved,
    // non-registrable `example.invalid` host so a fixture can never look like
    // a real GitHub project.
    let rest = if let Some(rest) = source.repo.strip_prefix("https://github.com/") {
        if example {
            return Err(MarketError::Entry(
                "example entries must use https://example.invalid/<owner>/<repo>, not GitHub"
                    .to_string(),
            ));
        }
        rest
    } else if let Some(rest) = source.repo.strip_prefix("https://example.invalid/") {
        if !example {
            return Err(MarketError::Entry(
                "only example entries may use https://example.invalid/<owner>/<repo>".to_string(),
            ));
        }
        rest
    } else {
        return Err(MarketError::Entry(
            "source.repo must be https://github.com/<owner>/<repo> (example entries use https://example.invalid/<owner>/<repo>)".to_string(),
        ));
    };
    let rest = rest.trim_end_matches('/');
    let mut parts = rest.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if owner.is_empty()
        || repo.is_empty()
        || parts.next().is_some()
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains("..")
        || rest.contains(char::is_whitespace)
    {
        return Err(MarketError::Entry(
            "source.repo must be exactly https://<host>/<owner>/<repo>".to_string(),
        ));
    }
    if rest.len() > 140 {
        return Err(MarketError::Entry("source.repo is too long".to_string()));
    }
    if source.commit.len() != 40
        || !source
            .commit
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        return Err(MarketError::Entry(
            "source.commit must be a full 40-character lowercase commit SHA".to_string(),
        ));
    }
    if source.content_sha256.len() != 64
        || !source
            .content_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        return Err(MarketError::Entry(
            "source.content_sha256 must be a 64-character lowercase SHA-256".to_string(),
        ));
    }
    if source.files.len() > 500 {
        return Err(MarketError::Entry(
            "source.files may list at most 500 files".to_string(),
        ));
    }
    let mut seen = BTreeSet::new();
    for file in &source.files {
        validate_relative_path("source.files", file)?;
        if !seen.insert(file) {
            return Err(MarketError::Entry(format!(
                "source.files lists `{file}` twice"
            )));
        }
    }
    Ok(())
}

fn validate_agent_target(
    entry_id: &str,
    agent: &str,
    scopes: &[InstallScope],
) -> Result<(), MarketError> {
    if !MARKET_AGENTS.contains(&agent) {
        return Err(MarketError::Entry(format!(
            "entry {entry_id} names unknown agent `{agent}`"
        )));
    }
    if scopes.is_empty() {
        return Err(MarketError::Entry(format!(
            "entry {entry_id} target for {agent} has no scopes"
        )));
    }
    let mut seen = BTreeSet::new();
    for scope in scopes {
        let key = match scope {
            InstallScope::User => "user",
            InstallScope::Project => "project",
        };
        if !seen.insert(key) {
            return Err(MarketError::Entry(format!(
                "entry {entry_id} target for {agent} lists {key} twice"
            )));
        }
    }
    Ok(())
}

fn validate_executable(command: &str) -> Result<(), MarketError> {
    if command.is_empty()
        || command.len() > 64
        || command.contains('/')
        || command.contains('\\')
        || command.chars().any(char::is_whitespace)
    {
        return Err(MarketError::Entry(format!(
            "MCP command `{command}` must be a bare executable name"
        )));
    }
    Ok(())
}

fn validate_pinned_args(command: &str, args: &[String]) -> Result<(), MarketError> {
    if args.len() > 32 {
        return Err(MarketError::Entry(
            "MCP args may contain at most 32 entries".to_string(),
        ));
    }
    for argument in args {
        if argument.len() > 200 || argument.contains('\0') {
            return Err(MarketError::Entry(
                "MCP args must be at most 200 characters".to_string(),
            ));
        }
        let lower = argument.to_ascii_lowercase();
        if lower.contains("latest") || lower == "*" || lower.contains("://") {
            return Err(MarketError::Entry(format!(
                "MCP arg `{argument}` must pin an exact package version, not a range, tag, or URL"
            )));
        }
    }
    if matches!(command, "npx" | "bunx" | "pnpx" | "uvx") {
        let package = args
            .iter()
            .find(|argument| !argument.starts_with('-'))
            .ok_or_else(|| {
                MarketError::Entry(format!(
                    "`{command}` needs an exact package@version argument"
                ))
            })?;
        let pinned = if command == "uvx" {
            package.contains("==")
        } else {
            package
                .rsplit_once('@')
                .is_some_and(|(name, version)| !name.is_empty() && is_exact_version(version))
        };
        if !pinned {
            return Err(MarketError::Entry(format!(
                "MCP package `{package}` must pin an exact version (for example pkg@1.2.3)"
            )));
        }
    }
    Ok(())
}

fn is_exact_version(version: &str) -> bool {
    !version.is_empty()
        && version.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
        && version.chars().any(|character| character.is_ascii_digit())
}

pub fn validate_env_name(name: &str) -> Result<(), MarketError> {
    let mut characters = name.chars();
    let valid = name.len() <= 80
        && characters
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_');
    if !valid {
        return Err(MarketError::Entry(format!(
            "environment variable `{name}` is not a valid name"
        )));
    }
    Ok(())
}

pub fn validate_relative_path(field: &str, value: &str) -> Result<(), MarketError> {
    if value.is_empty() || value.len() > 240 || value.contains('\0') {
        return Err(MarketError::Entry(format!(
            "{field} contains an empty or over-long path"
        )));
    }
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/') || normalized.starts_with("//") {
        return Err(MarketError::Entry(format!(
            "{field} path `{value}` must be relative"
        )));
    }
    if normalized
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(MarketError::Entry(format!(
            "{field} path `{value}` must not contain empty, `.` or `..` segments"
        )));
    }
    if normalized.contains(':') {
        return Err(MarketError::Entry(format!(
            "{field} path `{value}` must not contain a drive or stream separator"
        )));
    }
    for part in normalized.split('/') {
        if is_windows_reserved(part) {
            return Err(MarketError::Entry(format!(
                "{field} path `{value}` uses a Windows reserved name"
            )));
        }
    }
    Ok(())
}

pub fn is_windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem[3..]
                .chars()
                .all(|character| character.is_ascii_digit())
            && stem[3..] != *"0")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub kind: MarketKind,
    pub id: String,
    pub path: String,
    pub sha256: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIndex {
    pub schema_version: u32,
    pub generated_at: String,
    pub key_id: String,
    pub entries: Vec<IndexEntry>,
    #[serde(default)]
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedEntry {
    pub kind: MarketKind,
    pub id: String,
    pub reason: String,
    pub revoked_on: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedRevocation {
    pub schema_version: u32,
    pub generated_at: String,
    pub key_id: String,
    pub revoked: Vec<RevokedEntry>,
    #[serde(default)]
    pub signature: String,
}

impl SignedIndex {
    pub fn payload(&self) -> Value {
        json!({
            "schemaVersion": self.schema_version,
            "generatedAt": self.generated_at,
            "keyId": self.key_id,
            "entries": self.entries,
        })
    }
}

impl SignedRevocation {
    pub fn payload(&self) -> Value {
        json!({
            "schemaVersion": self.schema_version,
            "generatedAt": self.generated_at,
            "keyId": self.key_id,
            "revoked": self.revoked,
        })
    }
}

/// Canonical JSON: object keys sorted recursively, no insignificant whitespace.
pub fn canonical_json(value: &Value) -> Vec<u8> {
    fn write(value: &Value, output: &mut String) {
        match value {
            Value::Null => output.push_str("null"),
            Value::Bool(boolean) => output.push_str(if *boolean { "true" } else { "false" }),
            Value::Number(number) => output.push_str(&number.to_string()),
            Value::String(string) => {
                output.push_str(&serde_json::to_string(string).unwrap_or_else(|_| "\"\"".into()))
            }
            Value::Array(items) => {
                output.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write(item, output);
                }
                output.push(']');
            }
            Value::Object(map) => {
                output.push('{');
                let sorted: BTreeMap<&String, &Value> = map.iter().collect();
                for (index, (key, item)) in sorted.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(
                        &serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                    );
                    output.push(':');
                    write(item, output);
                }
                output.push('}');
            }
        }
    }
    let mut output = String::new();
    write(value, &mut output);
    output.into_bytes()
}

pub fn verify_signature(payload: &Value, signature_base64: &str) -> Result<(), MarketError> {
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(REGISTRY_PUBLIC_KEY_BASE64)
        .map_err(|_| MarketError::Signature("The embedded registry key is invalid.".into()))?;
    let key_bytes: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| MarketError::Signature("The embedded registry key is not 32 bytes.".into()))?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| {
        MarketError::Signature("The embedded registry key could not be loaded.".into())
    })?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_base64)
        .map_err(|_| {
            MarketError::Signature(
                "The registry signature is not valid base64. Pandu refused to load it.".into(),
            )
        })?;
    let signature_bytes: [u8; 64] = signature_bytes.try_into().map_err(|_| {
        MarketError::Signature(
            "The registry signature is not 64 bytes. Pandu refused to load it.".into(),
        )
    })?;
    let signature = Signature::from_bytes(&signature_bytes);
    key.verify_strict(&canonical_json(payload), &signature)
        .map_err(|_| {
            MarketError::Signature(
                "The registry signature could not be verified. Pandu refused to load the index. \
                 Do not install anything until the registry maintainers publish a valid signature."
                    .into(),
            )
        })
}

pub fn verify_index(index: &SignedIndex) -> Result<(), MarketError> {
    if index.schema_version != MARKET_SCHEMA_VERSION {
        return Err(MarketError::Registry(format!(
            "registry index uses schema_version {}; this build understands {}",
            index.schema_version, MARKET_SCHEMA_VERSION
        )));
    }
    if index.key_id != REGISTRY_KEY_ID {
        return Err(MarketError::Signature(format!(
            "registry index is signed with unknown key `{}`",
            index.key_id
        )));
    }
    verify_signature(&index.payload(), &index.signature)
}

pub fn verify_revocation(revoked: &SignedRevocation) -> Result<(), MarketError> {
    if revoked.schema_version != MARKET_SCHEMA_VERSION {
        return Err(MarketError::Registry(format!(
            "revocation list uses schema_version {}; this build understands {}",
            revoked.schema_version, MARKET_SCHEMA_VERSION
        )));
    }
    if revoked.key_id != REGISTRY_KEY_ID {
        return Err(MarketError::Signature(format!(
            "revocation list is signed with unknown key `{}`",
            revoked.key_id
        )));
    }
    verify_signature(&revoked.payload(), &revoked.signature)
}

#[derive(Debug, Clone)]
pub struct LoadedRegistry {
    pub index: SignedIndex,
    pub revoked: SignedRevocation,
    pub entries: Vec<MarketEntry>,
    pub warnings: Vec<String>,
}

impl LoadedRegistry {
    pub fn is_revoked(&self, kind: MarketKind, id: &str) -> bool {
        self.revoked
            .revoked
            .iter()
            .any(|entry| entry.kind == kind && entry.id == id)
    }

    pub fn entry(&self, kind: MarketKind, id: &str) -> Option<&MarketEntry> {
        self.entries
            .iter()
            .find(|entry| entry.kind == kind && entry.id == id)
    }
}

/// Load and verify a registry directory. Nothing is returned unless both the
/// index and the revocation list carry a valid signature and every entry file
/// matches its index hash.
pub fn load_registry_dir(
    dir: &Path,
    include_examples: bool,
) -> Result<LoadedRegistry, MarketError> {
    let index_bytes = std::fs::read(dir.join(ACTIVE_INDEX_FILE)).map_err(|error| {
        MarketError::Registry(format!("Could not read the registry index: {error}"))
    })?;
    let revoked_bytes = std::fs::read(dir.join(ACTIVE_REVOKED_FILE)).map_err(|error| {
        MarketError::Registry(format!("Could not read the revocation list: {error}"))
    })?;
    parse_registry(&index_bytes, &revoked_bytes, include_examples, |path| {
        let path = dir.join(path);
        std::fs::read(&path).map_err(|error| {
            MarketError::Registry(format!(
                "Could not read registry entry `{}`: {error}",
                path.display()
            ))
        })
    })
}

/// Verify and parse an index, a revocation list, and entry files supplied by
/// `read_entry`. The caller decides whether those bytes come from disk, the
/// embedded production registry, or a refresh download; this function applies
/// exactly the same signature, hash, schema, and YAML checks to all of them.
pub fn parse_registry<F>(
    index_bytes: &[u8],
    revoked_bytes: &[u8],
    include_examples: bool,
    read_entry: F,
) -> Result<LoadedRegistry, MarketError>
where
    F: Fn(&str) -> Result<Vec<u8>, MarketError>,
{
    if index_bytes.len() > 4 * 1024 * 1024 {
        return Err(MarketError::Registry(
            "The registry index is larger than 4 MiB.".into(),
        ));
    }
    let index: SignedIndex = serde_json::from_slice(index_bytes).map_err(|error| {
        MarketError::Registry(format!("The registry index is not valid JSON: {error}"))
    })?;
    verify_index(&index)?;

    if revoked_bytes.len() > 2 * 1024 * 1024 {
        return Err(MarketError::Registry(
            "The revocation list is larger than 2 MiB.".into(),
        ));
    }
    let revoked: SignedRevocation = serde_json::from_slice(revoked_bytes).map_err(|error| {
        MarketError::Registry(format!("The revocation list is not valid JSON: {error}"))
    })?;
    verify_revocation(&revoked)?;

    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut ids = BTreeSet::new();
    for indexed in &index.entries {
        if !ids.insert((indexed.kind, indexed.id.clone())) {
            return Err(MarketError::Registry(format!(
                "The registry index lists `{}` ({}) twice.",
                indexed.id,
                indexed.kind.as_str()
            )));
        }
        validate_relative_path("index.path", &indexed.path)?;
        let expected_prefix = indexed.kind.directory();
        if !indexed.path.starts_with(&format!("{expected_prefix}/"))
            || !indexed.path.ends_with(".yaml")
            || indexed.path.contains("..")
        {
            return Err(MarketError::Registry(format!(
                "Index path `{}` must be under {expected_prefix}/ and end in .yaml",
                indexed.path
            )));
        }
        if indexed.sha256.len() != 64
            || !indexed
                .sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
        {
            return Err(MarketError::Registry(format!(
                "Index hash for `{}` is not a SHA-256.",
                indexed.id
            )));
        }
        let bytes = read_entry(&indexed.path)?;
        if bytes.len() > MAX_ENTRY_BYTES {
            return Err(MarketError::Entry(format!(
                "Registry entry `{}` is larger than {} bytes.",
                indexed.path, MAX_ENTRY_BYTES
            )));
        }
        let hash = hex(&Sha256::digest(&bytes));
        if hash != indexed.sha256 {
            return Err(MarketError::Registry(format!(
                "Registry entry `{}` does not match the hash in the signed index. \
                 Pandu refused to load it.",
                indexed.path
            )));
        }
        let text = String::from_utf8(bytes).map_err(|_| {
            MarketError::Entry(format!("Registry entry `{}` is not UTF-8.", indexed.path))
        })?;
        let entry = parse_entry_text(&indexed.path, &text)?;
        if entry.id != indexed.id || entry.kind != indexed.kind {
            return Err(MarketError::Registry(format!(
                "Index entry `{}` disagrees with the YAML id/kind.",
                indexed.path
            )));
        }
        if entry.version != indexed.version {
            return Err(MarketError::Registry(format!(
                "Index version for `{}` disagrees with the YAML version.",
                indexed.id
            )));
        }
        if entry.example && !include_examples {
            warnings.push(format!(
                "Example entry `{}` is hidden in production builds.",
                entry.id
            ));
            continue;
        }
        entries.push(entry);
    }
    entries.sort_by(|left, right| {
        left.trust
            .rank()
            .cmp(&right.trust.rank())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(LoadedRegistry {
        index,
        revoked,
        entries,
        warnings,
    })
}

/// Parse and validate one YAML entry. Exposed so the registry checker and
/// tests apply exactly the same bomb guard and schema checks as the loader.
pub fn parse_entry_text(path: &str, text: &str) -> Result<MarketEntry, MarketError> {
    reject_yaml_bomb(text)?;
    let entry: MarketEntry = serde_yaml::from_str(text).map_err(|error| {
        MarketError::Entry(format!("Registry entry `{path}` is invalid YAML: {error}"))
    })?;
    entry.validate()?;
    Ok(entry)
}

fn reject_yaml_bomb(text: &str) -> Result<(), MarketError> {
    let alias = Regex::new(r"(^|[\s\[{,])[&*][A-Za-z0-9_-]+").expect("valid alias regex");
    if alias.find_iter(text).count() > 64 {
        return Err(MarketError::Entry(
            "Registry entry contains too many YAML anchors or aliases.".into(),
        ));
    }
    if text.lines().count() > 10_000 {
        return Err(MarketError::Entry(
            "Registry entry contains too many lines.".into(),
        ));
    }
    Ok(())
}

pub fn sanitize_markdown(markdown: &str) -> String {
    let image = Regex::new(r"!\[[^\]]*\]\([^)]*\)").expect("valid image regex");
    let html = Regex::new(r"<[^>]*>").expect("valid html regex");
    let dangerous = Regex::new(r"(?i)(javascript|data|vbscript):").expect("valid scheme regex");
    let mut output = markdown.replace("\r\n", "\n");
    output = image.replace_all(&output, "").into_owned();
    output = html.replace_all(&output, "").into_owned();
    output = dangerous.replace_all(&output, "").into_owned();
    if output.len() > MAX_README_BYTES {
        output.truncate(MAX_README_BYTES);
    }
    output
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys_recursively() {
        let value = json!({"b": 1, "a": {"d": 2, "c": [{"z": 1, "y": 2}]}});
        assert_eq!(
            String::from_utf8(canonical_json(&value)).unwrap(),
            r#"{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}"#
        );
    }

    #[test]
    fn markdown_removes_images_and_html() {
        let sanitized = sanitize_markdown(
            "# Title\n![tracker](https://example.com/pixel.png)\n<script>alert(1)</script>\n[j](javascript:alert(1))",
        );
        assert!(!sanitized.contains("pixel.png"));
        assert!(!sanitized.contains("<script>"));
        assert!(!sanitized.contains("javascript:"));
    }

    #[test]
    fn windows_reserved_names_are_rejected() {
        for name in ["CON", "con.txt", "NUL", "COM1", "LPT9", "aux.md"] {
            assert!(is_windows_reserved(name), "{name}");
        }
        assert!(!is_windows_reserved("console.md"));
        assert!(!is_windows_reserved("COM10"));
    }

    #[test]
    fn production_and_test_trust_roots_are_distinct() {
        assert_ne!(
            PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64,
            TEST_REGISTRY_PUBLIC_KEY_BASE64
        );
        assert_ne!(PRODUCTION_REGISTRY_KEY_ID, TEST_REGISTRY_KEY_ID);
    }

    #[test]
    fn release_builds_refuse_a_test_trust_root() {
        let error = trust_root_error(TEST_REGISTRY_PUBLIC_KEY_BASE64, TEST_REGISTRY_KEY_ID, false)
            .expect("a release build must reject the test key");
        assert!(error.contains("test registry key"), "{error}");
        assert!(
            trust_root_error(
                PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64,
                PRODUCTION_REGISTRY_KEY_ID,
                false
            )
            .is_none()
        );
        assert!(
            trust_root_error(TEST_REGISTRY_PUBLIC_KEY_BASE64, TEST_REGISTRY_KEY_ID, true).is_none()
        );
        assert!(
            trust_root_error("not-a-real-key", "pandu-market-2026", false)
                .expect("unknown keys are refused")
                .contains("recognised")
        );
    }

    #[test]
    #[cfg(debug_assertions)]
    fn debug_builds_verify_with_the_test_key() {
        assert_eq!(REGISTRY_PUBLIC_KEY_BASE64, TEST_REGISTRY_PUBLIC_KEY_BASE64);
        assert_eq!(REGISTRY_KEY_ID, TEST_REGISTRY_KEY_ID);
        assert_eq!(ACTIVE_INDEX_FILE, TEST_INDEX_FILE);
        assert_eq!(ACTIVE_REVOKED_FILE, TEST_REVOKED_FILE);
    }

    fn entry_value() -> Value {
        json!({
            "schema_version": 1,
            "id": "demo",
            "name": "Demo",
            "kind": "skill",
            "version": "1.0.0",
            "short_description": "Short",
            "long_description": "Long",
            "categories": ["coding"],
            "agents": ["claude-code"],
            "source": {
                "repo": "https://github.com/example/demo",
                "commit": "1".repeat(40),
                "content_sha256": "2".repeat(64)
            },
            "license": "MIT",
            "trust": "unreviewed",
            "skills": { "install": [{ "agent": "claude-code", "scopes": ["user"] }] },
            "readme": "readme"
        })
    }

    #[test]
    fn categories_are_a_controlled_vocabulary() {
        let mut entry: MarketEntry = serde_json::from_value(entry_value()).unwrap();
        assert!(entry.validate().is_ok());

        entry.categories = vec!["writing".into()];
        let error = entry.validate().unwrap_err().to_string();
        assert!(error.contains("controlled vocabulary"), "{error}");
        assert!(error.contains("tags"), "{error}");

        let mut duplicate = entry_value();
        duplicate["categories"] = json!(["docs", "docs"]);
        let entry: MarketEntry = serde_json::from_value(duplicate).unwrap();
        assert!(entry.validate().unwrap_err().to_string().contains("twice"));
    }

    #[test]
    fn free_form_tags_are_labels_not_filter_categories() {
        let mut entry: MarketEntry = serde_json::from_value(entry_value()).unwrap();
        entry.tags = vec!["release notes".into(), "git".into()];
        assert!(entry.validate().is_ok());

        entry.tags = vec!["git".into(), "git".into()];
        assert!(entry.validate().unwrap_err().to_string().contains("tag"));

        entry.tags = vec!["".into()];
        assert!(entry.validate().is_err());

        entry.tags = (0..13).map(|index| format!("tag-{index}")).collect();
        assert!(
            entry
                .validate()
                .unwrap_err()
                .to_string()
                .contains("12 tags")
        );
    }

    #[test]
    fn example_fixtures_use_the_reserved_invalid_host() {
        let mut example = entry_value();
        example["example"] = json!(true);
        example["source"]["repo"] = json!("https://example.invalid/pandu-examples/demo");
        let entry: MarketEntry = serde_json::from_value(example.clone()).unwrap();
        assert!(entry.validate().is_ok());

        example["source"]["repo"] = json!("https://github.com/pandu-examples/demo");
        let entry: MarketEntry = serde_json::from_value(example.clone()).unwrap();
        let error = entry.validate().unwrap_err().to_string();
        assert!(error.contains("example.invalid"), "{error}");

        let mut real = entry_value();
        real["source"]["repo"] = json!("https://example.invalid/example/demo");
        let entry: MarketEntry = serde_json::from_value(real).unwrap();
        let error = entry.validate().unwrap_err().to_string();
        assert!(error.contains("only example entries"), "{error}");
    }

    #[test]
    fn schema_category_vocabulary_matches_the_market() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../registry/schema/entry.schema.json"
        ))
        .expect("registry schema");
        let values = schema["properties"]["categories"]["items"]["enum"]
            .as_array()
            .expect("categories enum")
            .iter()
            .map(|value| value.as_str().expect("category string"))
            .collect::<Vec<_>>();
        assert_eq!(values.as_slice(), MARKET_CATEGORIES);
        assert_eq!(schema["properties"]["tags"]["maxItems"], 12);
        let repo_pattern = schema["$defs"]["source"]["properties"]["repo"]["pattern"]
            .as_str()
            .expect("source.repo pattern");
        assert!(repo_pattern.contains("example\\.invalid"), "{repo_pattern}");
    }
}
