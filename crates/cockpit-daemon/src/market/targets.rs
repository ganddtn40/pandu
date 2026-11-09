//! Resolve where a market entry is installed for a specific agent.
//!
//! Adapters declare the paths and format. This module never guesses an agent's
//! config location: if an adapter has no verified `[skills]` or `[mcp]` section,
//! Cockpit refuses to write and returns manual instructions instead.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use cockpit_core::adapter::{Adapter, AdapterRegistry};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::MarketError;
use super::config_edit::{ConfigFormat, apply_change};
use super::{
    InstallScope, MarketEntry, MarketKind, McpAgentTarget, McpTransport, SkillAgentTarget,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpStyle {
    Claude,
    Codex,
    OpenCode,
}

impl McpStyle {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::OpenCode),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
        }
    }

    /// Claude and Codex can store a literal env value. OpenCode is always given
    /// an `{env:NAME}` reference so a secret never enters its config file.
    pub fn accepts_secret_values(self) -> bool {
        !matches!(self, Self::OpenCode)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualInstructions {
    pub reason: String,
    pub path: String,
    pub steps: Vec<String>,
    pub snippet: String,
}

#[derive(Debug, Clone)]
pub enum ResolvedKind {
    Skill {
        root: PathBuf,
        display_root: String,
    },
    Mcp {
        path: PathBuf,
        display_path: String,
        format: ConfigFormat,
        style: McpStyle,
        /// Full key path including the server name.
        key_path: Vec<String>,
    },
}

#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    pub agent: String,
    pub scope: InstallScope,
    pub adapter_name: String,
    pub verified: bool,
    pub kind: ResolvedKind,
    pub manual: Option<ManualInstructions>,
}

impl ResolvedTarget {
    pub fn skill_root(&self) -> Option<&Path> {
        match &self.kind {
            ResolvedKind::Skill { root, .. } => Some(root),
            ResolvedKind::Mcp { .. } => None,
        }
    }

    pub fn mcp(&self) -> Option<(&Path, &str, ConfigFormat, McpStyle, &[String])> {
        match &self.kind {
            ResolvedKind::Mcp {
                path,
                display_path,
                format,
                style,
                key_path,
            } => Some((path, display_path, *format, *style, key_path)),
            ResolvedKind::Skill { .. } => None,
        }
    }

    pub fn display(&self) -> String {
        match &self.kind {
            ResolvedKind::Skill { display_root, .. } => display_root.clone(),
            ResolvedKind::Mcp { display_path, .. } => display_path.clone(),
        }
    }
}

pub struct TargetContext<'a> {
    pub adapters: &'a AdapterRegistry,
    pub user_home: &'a Path,
    pub workspace: Option<&'a Path>,
}

pub fn resolve(
    entry: &MarketEntry,
    agent: &str,
    scope: InstallScope,
    context: &TargetContext<'_>,
) -> Result<ResolvedTarget, MarketError> {
    let adapter = context.adapters.get(agent).ok_or_else(|| {
        MarketError::Install(format!(
            "Cockpit has no adapter for `{agent}`. Add one before installing."
        ))
    })?;
    if !entry.agents.iter().any(|candidate| candidate == agent) {
        return Err(MarketError::Install(format!(
            "{} does not support {agent}.",
            entry.name
        )));
    }
    match entry.kind {
        MarketKind::Skill => resolve_skill(entry, adapter, scope, context),
        MarketKind::Mcp => resolve_mcp(entry, adapter, scope, context),
    }
}

fn resolve_skill(
    entry: &MarketEntry,
    adapter: &Adapter,
    scope: InstallScope,
    context: &TargetContext<'_>,
) -> Result<ResolvedTarget, MarketError> {
    let Some(spec) = adapter.skills.as_ref() else {
        return Err(MarketError::Install(format!(
            "{} has no skill folder configured for {}. Install it manually.",
            adapter.name, entry.name
        )));
    };
    let paths = match scope {
        InstallScope::User => &spec.user_paths,
        InstallScope::Project => &spec.project_paths,
    };
    if paths.is_empty() {
        return Err(MarketError::Install(format!(
            "{} does not support {} skills. Choose another scope or install manually.",
            adapter.name,
            scope_label(scope)
        )));
    }
    let (base, display_base) = choose_path(paths, scope, context)?;
    let root = base.join(&entry.id);
    let display_root = format!("{display_base}/{}", entry.id);
    let manual = (!spec.verified).then(|| ManualInstructions {
        reason: format!(
            "Cockpit has not verified {}'s skill folder for this build, so it will not write there.",
            adapter.name
        ),
        path: display_root.clone(),
        steps: vec![
            format!(
                "Download {} at commit {} from {}.",
                entry.name, entry.source.commit, entry.source.repo
            ),
            format!("Create the folder {display_root}."),
            "Copy the skill files (including SKILL.md) into that folder.".to_string(),
        ],
        snippet: String::new(),
    });
    Ok(ResolvedTarget {
        agent: adapter.id.clone(),
        scope,
        adapter_name: adapter.name.clone(),
        verified: spec.verified,
        kind: ResolvedKind::Skill { root, display_root },
        manual,
    })
}

fn resolve_mcp(
    entry: &MarketEntry,
    adapter: &Adapter,
    scope: InstallScope,
    context: &TargetContext<'_>,
) -> Result<ResolvedTarget, MarketError> {
    let Some(spec) = adapter.mcp.as_ref() else {
        return Err(MarketError::Install(format!(
            "{} has no MCP configuration configured for {}. Install it manually.",
            adapter.name, entry.name
        )));
    };
    let paths = match scope {
        InstallScope::User => &spec.user_paths,
        InstallScope::Project => &spec.project_paths,
    };
    if paths.is_empty() {
        return Err(MarketError::Install(format!(
            "{} does not support {} MCP configuration. Choose another scope or install manually.",
            adapter.name,
            scope_label(scope)
        )));
    }
    let format = match spec.format.as_str() {
        "json" => ConfigFormat::Json,
        "jsonc" => ConfigFormat::Jsonc,
        "toml" => ConfigFormat::Toml,
        _ => {
            return Err(MarketError::Install(format!(
                "{} has an unknown MCP config format.",
                adapter.name
            )));
        }
    };
    let style = McpStyle::parse(&spec.style).ok_or_else(|| {
        MarketError::Install(format!("{} has an unknown MCP config style.", adapter.name))
    })?;
    let (path, display_path) = choose_file(paths, scope, context)?;
    let mut key_path = spec.key_path.clone();
    key_path.push(entry.id.clone());
    let snippet = manual_snippet(entry, format, &key_path)?;
    let user_edit_blocked = scope == InstallScope::User && !spec.write_user_config;
    let manual = (!spec.verified || user_edit_blocked).then(|| {
        let project_path = spec
            .project_paths
            .first()
            .cloned()
            .unwrap_or_else(|| ".mcp.json".to_string());
        let reason = if user_edit_blocked {
            format!(
                "{} keeps app state in {display_path}, so Cockpit will not edit it. Use the agent's own add command or install for the current project.",
                adapter.name
            )
        } else {
            format!(
                "Cockpit has not verified {}'s MCP configuration for this build, so it will not write there.",
                adapter.name
            )
        };
        let mut steps = Vec::new();
        if let Some(command) = add_command(entry, style) {
            steps.push(format!("Run `{command}` with the real secret values."));
        }
        if !spec.project_paths.is_empty() {
            steps.push(format!(
                "Or choose Project scope; Cockpit writes {project_path} instead of touching {display_path}."
            ));
        }
        steps.push("Restart the agent so it reads the new configuration.".to_string());
        ManualInstructions {
            reason,
            path: display_path.clone(),
            steps,
            snippet,
        }
    });
    Ok(ResolvedTarget {
        agent: adapter.id.clone(),
        scope,
        adapter_name: adapter.name.clone(),
        verified: spec.verified,
        kind: ResolvedKind::Mcp {
            path,
            display_path,
            format,
            style,
            key_path,
        },
        manual,
    })
}

fn add_command(entry: &MarketEntry, style: McpStyle) -> Option<String> {
    let recipe = entry.mcp.as_ref()?;
    match style {
        McpStyle::Claude => match recipe.transport {
            McpTransport::Stdio => {
                let command = recipe.command.as_deref()?;
                let mut parts = vec![
                    "claude".to_string(),
                    "mcp".to_string(),
                    "add".to_string(),
                    entry.id.clone(),
                ];
                for name in &recipe.secrets {
                    parts.push("-e".to_string());
                    parts.push(format!("{name}=<value>"));
                }
                parts.push("--".to_string());
                parts.push(command.to_string());
                parts.extend(recipe.args.iter().cloned());
                Some(parts.join(" "))
            }
            McpTransport::Http => {
                let url = recipe.url.as_deref()?;
                Some(format!(
                    "claude mcp add --transport http {} {url}",
                    entry.id
                ))
            }
        },
        McpStyle::Codex => match recipe.transport {
            McpTransport::Stdio => {
                let command = recipe.command.as_deref()?;
                let mut parts = vec![
                    "codex".to_string(),
                    "mcp".to_string(),
                    "add".to_string(),
                    entry.id.clone(),
                    "--".to_string(),
                    command.to_string(),
                ];
                parts.extend(recipe.args.iter().cloned());
                Some(parts.join(" "))
            }
            McpTransport::Http => recipe
                .url
                .as_deref()
                .map(|url| format!("codex mcp add {} --url {url}", entry.id)),
        },
        McpStyle::OpenCode => None,
    }
}

fn scope_label(scope: InstallScope) -> &'static str {
    match scope {
        InstallScope::User => "user",
        InstallScope::Project => "project",
    }
}

fn choose_path(
    paths: &[String],
    scope: InstallScope,
    context: &TargetContext<'_>,
) -> Result<(PathBuf, String), MarketError> {
    let mut candidates = Vec::new();
    for path in paths {
        let (actual, display) = resolve_one(path, scope, context)?;
        candidates.push((actual, display));
    }
    let chosen = candidates
        .iter()
        .find(|(actual, _)| actual.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    Ok(chosen)
}

fn choose_file(
    paths: &[String],
    scope: InstallScope,
    context: &TargetContext<'_>,
) -> Result<(PathBuf, String), MarketError> {
    let mut candidates = Vec::new();
    for path in paths {
        let (actual, display) = resolve_one(path, scope, context)?;
        candidates.push((actual, display));
    }
    let chosen = candidates
        .iter()
        .find(|(actual, _)| actual.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());
    Ok(chosen)
}

fn resolve_one(
    path: &str,
    scope: InstallScope,
    context: &TargetContext<'_>,
) -> Result<(PathBuf, String), MarketError> {
    let normalized = path.replace('\\', "/");
    match scope {
        InstallScope::User => {
            let rest = normalized.strip_prefix("~/").ok_or_else(|| {
                MarketError::Install(format!("`{path}` is not a user path beginning with `~/`."))
            })?;
            if rest.split('/').any(|part| part == "..") {
                return Err(MarketError::Install(format!(
                    "`{path}` escapes the user home."
                )));
            }
            let actual = context
                .user_home
                .join(rest.replace('/', std::path::MAIN_SEPARATOR_STR));
            Ok((actual, format!("~/{rest}")))
        }
        InstallScope::Project => {
            let workspace = context.workspace.ok_or_else(|| {
                MarketError::Install(
                    "Project installs need an open workspace. Choose user scope instead.".into(),
                )
            })?;
            if normalized.starts_with('/')
                || normalized.starts_with('~')
                || normalized.contains(':')
                || normalized.split('/').any(|part| part == "..")
            {
                return Err(MarketError::Install(format!(
                    "`{path}` is not a safe project path."
                )));
            }
            let actual = workspace.join(normalized.replace('/', std::path::MAIN_SEPARATOR_STR));
            Ok((actual, normalized))
        }
    }
}

pub fn supports(entry: &MarketEntry, agent: &str, scope: InstallScope) -> bool {
    match entry.kind {
        MarketKind::Skill => entry.skills.as_ref().is_some_and(|recipe| {
            recipe.install.iter().any(|target: &SkillAgentTarget| {
                target.agent == agent && target.scopes.contains(&scope)
            })
        }),
        MarketKind::Mcp => entry.mcp.as_ref().is_some_and(|recipe| {
            recipe.install.iter().any(|target: &McpAgentTarget| {
                target.agent == agent && target.scopes.contains(&scope)
            })
        }),
    }
}

pub fn subdir(entry: &MarketEntry, agent: &str) -> Option<String> {
    entry.skills.as_ref().and_then(|recipe| {
        recipe
            .install
            .iter()
            .find(|target| target.agent == agent)
            .and_then(|target| target.subdir.clone())
    })
}

/// Render the agent-specific MCP value. Secret values are placeholders when
/// `secrets` is `None`; OpenCode always receives an `{env:NAME}` reference.
pub fn render_mcp_value(
    entry: &MarketEntry,
    style: McpStyle,
    secrets: Option<&BTreeMap<String, String>>,
) -> Result<Value, MarketError> {
    let recipe = entry
        .mcp
        .as_ref()
        .ok_or_else(|| MarketError::Entry(format!("{} has no MCP recipe.", entry.id)))?;
    let env_names: Vec<&String> = recipe.env.iter().chain(recipe.secrets.iter()).collect();
    match recipe.transport {
        McpTransport::Stdio => {
            let command = recipe
                .command
                .clone()
                .ok_or_else(|| MarketError::Entry(format!("{} has no MCP command.", entry.id)))?;
            match style {
                McpStyle::Claude => {
                    let mut value = json!({
                        "command": command,
                        "args": recipe.args,
                    });
                    if !env_names.is_empty() {
                        let mut env = serde_json::Map::new();
                        for name in &env_names {
                            if recipe.secrets.contains(name) {
                                env.insert((*name).clone(), secret_value(name, secrets));
                            }
                        }
                        if !env.is_empty() {
                            value["env"] = Value::Object(env);
                        }
                    }
                    Ok(value)
                }
                McpStyle::Codex => {
                    let mut value = json!({
                        "command": command,
                        "args": recipe.args,
                        "env_vars": recipe.env,
                    });
                    if !recipe.secrets.is_empty() {
                        let mut env = serde_json::Map::new();
                        for name in &recipe.secrets {
                            env.insert((*name).clone(), secret_value(name, secrets));
                        }
                        value["env"] = Value::Object(env);
                    }
                    Ok(value)
                }
                McpStyle::OpenCode => {
                    let mut command_line = vec![command];
                    command_line.extend(recipe.args.iter().cloned());
                    let mut value = json!({
                        "type": "local",
                        "command": command_line,
                    });
                    if !env_names.is_empty() {
                        let mut environment = serde_json::Map::new();
                        for name in &env_names {
                            environment.insert((*name).clone(), json!(format!("{{env:{name}}}")));
                        }
                        value["environment"] = Value::Object(environment);
                    }
                    Ok(value)
                }
            }
        }
        McpTransport::Http => {
            let url = recipe
                .url
                .clone()
                .ok_or_else(|| MarketError::Entry(format!("{} has no MCP URL.", entry.id)))?;
            Ok(match style {
                McpStyle::Claude => json!({ "type": "http", "url": url }),
                McpStyle::Codex => json!({ "url": url }),
                McpStyle::OpenCode => json!({ "type": "remote", "url": url }),
            })
        }
    }
}

fn secret_value(name: &str, secrets: Option<&BTreeMap<String, String>>) -> Value {
    match secrets.and_then(|map| map.get(name)) {
        Some(value) => json!(value),
        None => json!(format!("<secret:{name}>")),
    }
}

pub fn command_line(entry: &MarketEntry) -> Option<String> {
    let recipe = entry.mcp.as_ref()?;
    if recipe.transport != McpTransport::Stdio {
        return None;
    }
    let mut parts = Vec::new();
    parts.push(recipe.command.clone()?);
    parts.extend(recipe.args.iter().cloned());
    Some(parts.join(" "))
}

pub fn manual_snippet(
    entry: &MarketEntry,
    format: ConfigFormat,
    key_path: &[String],
) -> Result<String, MarketError> {
    let style = match format {
        ConfigFormat::Toml => McpStyle::Codex,
        _ => McpStyle::Claude,
    };
    let value = render_mcp_value(entry, style, None)?;
    match format {
        ConfigFormat::Toml => {
            let document = apply_change(None, ConfigFormat::Toml, key_path, &value)?;
            Ok(document)
        }
        ConfigFormat::Json | ConfigFormat::Jsonc => {
            let nested = nest(key_path, value);
            let text = serde_json::to_string_pretty(&nested)
                .map_err(|error| MarketError::Config(error.to_string()))?;
            Ok(text)
        }
    }
}

pub fn nest(key_path: &[String], value: Value) -> Value {
    let mut current = value;
    for key in key_path.iter().rev() {
        let mut map = serde_json::Map::new();
        map.insert(key.clone(), current);
        current = Value::Object(map);
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::adapter::Adapter;
    use serde_json::json;

    const ADAPTER: &str = r#"
schema_version = 1
id = "claude-code"
name = "Claude Code"
docs_url = "https://example.com/docs"
capture = ["log_watch"]

[detect]
command = "claude"

[log_watch]
roots = ["~/.claude/projects"]
include = ["**/*.jsonl"]
parser = "claude-code-jsonl"
verified = false

[skills]
user_paths = ["~/.claude/skills"]
project_paths = [".claude/skills"]
verified = true

[mcp]
user_paths = ["~/.claude.json"]
project_paths = [".mcp.json"]
format = "json"
style = "claude"
key_path = ["mcpServers"]
write_user_config = true
verified = true
"#;

    fn entry(kind: MarketKind) -> MarketEntry {
        MarketEntry {
            schema_version: 1,
            id: "demo".into(),
            name: "Demo".into(),
            kind,
            version: "1.0.0".into(),
            short_description: "Short".into(),
            long_description: "Long".into(),
            categories: vec!["other".into()],
            tags: Vec::new(),
            agents: vec!["claude-code".into()],
            source: super::super::MarketSource {
                repo: "https://github.com/example/demo".into(),
                commit: "1".repeat(40),
                content_sha256: "2".repeat(64),
                files: Vec::new(),
            },
            license: "MIT".into(),
            trust: super::super::TrustTier::Unreviewed,
            reviewer: None,
            reviewed_on: None,
            example: true,
            permissions: Vec::new(),
            homepage: None,
            skills: (kind == MarketKind::Skill).then(|| super::super::SkillRecipe {
                install: vec![SkillAgentTarget {
                    agent: "claude-code".into(),
                    scopes: vec![InstallScope::User, InstallScope::Project],
                    subdir: None,
                }],
            }),
            mcp: (kind == MarketKind::Mcp).then(|| super::super::McpRecipe {
                transport: McpTransport::Stdio,
                command: Some("npx".into()),
                args: vec!["-y".into(), "demo@1.0.0".into()],
                url: None,
                env: Vec::new(),
                secrets: vec!["DEMO_KEY".into()],
                install: vec![McpAgentTarget {
                    agent: "claude-code".into(),
                    scopes: vec![InstallScope::User, InstallScope::Project],
                }],
            }),
            readme: String::new(),
        }
    }

    fn registry() -> AdapterRegistry {
        AdapterRegistry::new(
            vec![Adapter::from_toml("claude-code", ADAPTER).unwrap()],
            Vec::new(),
        )
    }

    #[test]
    fn resolves_verified_skill_and_mcp_targets() {
        let registry = registry();
        let home = Path::new("/home/tester");
        let workspace = Path::new("/work/project");
        let context = TargetContext {
            adapters: &registry,
            user_home: home,
            workspace: Some(workspace),
        };
        let skill = resolve(
            &entry(MarketKind::Skill),
            "claude-code",
            InstallScope::User,
            &context,
        )
        .unwrap();
        assert!(skill.verified);
        assert_eq!(
            skill.skill_root().unwrap(),
            Path::new("/home/tester/.claude/skills/demo")
        );
        let mcp = resolve(
            &entry(MarketKind::Mcp),
            "claude-code",
            InstallScope::Project,
            &context,
        )
        .unwrap();
        let (path, _, format, style, key_path) = mcp.mcp().unwrap();
        assert_eq!(path, Path::new("/work/project/.mcp.json"));
        assert_eq!(format, ConfigFormat::Json);
        assert_eq!(style, McpStyle::Claude);
        assert_eq!(key_path, ["mcpServers", "demo"]);
    }

    #[test]
    fn renders_secret_placeholders_and_env_references() {
        let entry = entry(MarketKind::Mcp);
        let claude = render_mcp_value(&entry, McpStyle::Claude, None).unwrap();
        assert_eq!(claude["env"]["DEMO_KEY"], "<secret:DEMO_KEY>");
        let mut secrets = BTreeMap::new();
        secrets.insert("DEMO_KEY".to_string(), "value".to_string());
        let claude = render_mcp_value(&entry, McpStyle::Claude, Some(&secrets)).unwrap();
        assert_eq!(claude["env"]["DEMO_KEY"], "value");
        let opencode = render_mcp_value(&entry, McpStyle::OpenCode, Some(&secrets)).unwrap();
        assert_eq!(opencode["environment"]["DEMO_KEY"], "{env:DEMO_KEY}");
    }

    #[cfg(windows)]
    #[test]
    fn resolved_windows_paths_use_one_separator() {
        let registry = registry();
        let context = TargetContext {
            adapters: &registry,
            user_home: Path::new(r"C:\Users\tester"),
            workspace: Some(Path::new(r"C:\work\project")),
        };
        let skill = resolve(
            &entry(MarketKind::Skill),
            "claude-code",
            InstallScope::User,
            &context,
        )
        .unwrap();
        let root = skill.skill_root().unwrap();
        assert_eq!(root, Path::new(r"C:\Users\tester\.claude\skills\demo"));
        assert!(!root.to_string_lossy().contains('/'), "{}", root.display());
        let mcp = resolve(
            &entry(MarketKind::Mcp),
            "claude-code",
            InstallScope::Project,
            &context,
        )
        .unwrap();
        let (path, display, _, _, _) = mcp.mcp().unwrap();
        assert_eq!(path, Path::new(r"C:\work\project\.mcp.json"));
        assert!(!path.to_string_lossy().contains('/'), "{}", path.display());
        assert_eq!(display, ".mcp.json");
    }

    #[test]
    fn unverified_targets_return_manual_instructions() {
        let mut adapter = Adapter::from_toml("claude-code", ADAPTER).unwrap();
        adapter.mcp.as_mut().unwrap().verified = false;
        let registry = AdapterRegistry::new(vec![adapter], Vec::new());
        let context = TargetContext {
            adapters: &registry,
            user_home: Path::new("/home/tester"),
            workspace: None,
        };
        let target = resolve(
            &entry(MarketKind::Mcp),
            "claude-code",
            InstallScope::User,
            &context,
        )
        .unwrap();
        assert!(!target.verified);
        assert!(target.manual.is_some());
        assert!(target.manual.unwrap().snippet.contains("mcpServers"));
    }

    #[test]
    fn app_state_user_config_is_manual_but_project_scope_writes() {
        let mut adapter = Adapter::from_toml("claude-code", ADAPTER).unwrap();
        adapter.mcp.as_mut().unwrap().write_user_config = false;
        let registry = AdapterRegistry::new(vec![adapter], Vec::new());
        let context = TargetContext {
            adapters: &registry,
            user_home: Path::new("/home/tester"),
            workspace: Some(Path::new("/work/project")),
        };
        let target = resolve(
            &entry(MarketKind::Mcp),
            "claude-code",
            InstallScope::User,
            &context,
        )
        .unwrap();
        assert!(target.verified);
        let manual = target.manual.as_ref().expect("manual instructions");
        assert!(
            manual
                .steps
                .iter()
                .any(|step| step.contains("claude mcp add"))
        );
        assert!(manual.steps.iter().any(|step| step.contains(".mcp.json")));
        assert_eq!(manual.path, "~/.claude.json");

        let target = resolve(
            &entry(MarketKind::Mcp),
            "claude-code",
            InstallScope::Project,
            &context,
        )
        .unwrap();
        assert!(target.manual.is_none());
        let (path, _, _, _, _) = target.mcp().unwrap();
        assert_eq!(path, Path::new("/work/project/.mcp.json"));
    }

    #[test]
    fn project_scope_requires_a_workspace() {
        let registry = registry();
        let context = TargetContext {
            adapters: &registry,
            user_home: Path::new("/home/tester"),
            workspace: None,
        };
        assert!(
            resolve(
                &entry(MarketKind::Skill),
                "claude-code",
                InstallScope::Project,
                &context
            )
            .is_err()
        );
    }

    #[test]
    fn nested_snippet_is_a_complete_object() {
        let value = json!({"command": "npx"});
        let nested = nest(&["mcp".into(), "servers".into(), "demo".into()], value);
        assert_eq!(nested["mcp"]["servers"]["demo"]["command"], "npx");
    }
}
