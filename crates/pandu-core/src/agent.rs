use http::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::brand::{AGENT_NAME_HEADER, AGENT_VERSION_HEADER, PROVIDER_HEADER};
use crate::provider::{AgentInfo, DetectedFrom};

/// The control-plane event vocabulary shared by the CLI, daemon, and UI.
///
/// Adapters may only emit these types. Keeping the list closed prevents an
/// untrusted agent from inventing UI states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentEventType {
    #[serde(rename = "agent.started")]
    Started,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "permission")]
    Permission,
    #[serde(rename = "question")]
    Question,
    #[serde(rename = "choice")]
    Choice,
    #[serde(rename = "auth_required")]
    AuthRequired,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "stuck")]
    Stuck,
    #[serde(rename = "budget.warn")]
    BudgetWarn,
    #[serde(rename = "context.high")]
    ContextHigh,
}

impl AgentEventType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "agent.started",
            Self::Done => "done",
            Self::Permission => "permission",
            Self::Question => "question",
            Self::Choice => "choice",
            Self::AuthRequired => "auth_required",
            Self::Error => "error",
            Self::Stuck => "stuck",
            Self::BudgetWarn => "budget.warn",
            Self::ContextHigh => "context.high",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "agent.started" => Some(Self::Started),
            "done" => Some(Self::Done),
            "permission" => Some(Self::Permission),
            "question" => Some(Self::Question),
            "choice" => Some(Self::Choice),
            "auth_required" => Some(Self::AuthRequired),
            "error" => Some(Self::Error),
            "stuck" => Some(Self::Stuck),
            "budget.warn" => Some(Self::BudgetWarn),
            "context.high" => Some(Self::ContextHigh),
            _ => None,
        }
    }

    /// Events that require a human at the computer. Authentication prompts are
    /// deliberately included: Pandu never relays secrets.
    pub fn needs_you(self) -> bool {
        matches!(
            self,
            Self::Permission | Self::Question | Self::Choice | Self::AuthRequired | Self::Stuck
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventStatus {
    #[default]
    Open,
    Acknowledged,
}

impl AgentEventStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Acknowledged => "acknowledged",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "acknowledged" => Some(Self::Acknowledged),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub id: String,
    pub session_id: String,
    pub agent_name: String,
    pub project_name: String,
    #[serde(rename = "type")]
    pub event_type: AgentEventType,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub status: AgentEventStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acknowledged_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventInput {
    #[serde(rename = "type")]
    pub event_type: AgentEventType,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub metadata: Option<Value>,
}

/// The only data Pandu is allowed to put in an OS or browser notification.
///
/// This type has no message, prompt, code, or token field on purpose. Any new
/// field must be reviewed against the Phase 6 notification rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub event_type: String,
    pub agent_name: String,
    pub project_name: String,
}

const AGENT_PATTERNS: &[(&str, &str)] = &[
    ("claude code", "Claude Code"),
    ("claude-code", "Claude Code"),
    ("opencode", "OpenCode"),
    ("codex", "Codex"),
    ("cursor", "Cursor"),
    ("cline", "Cline"),
    ("roo code", "Roo Code"),
    ("roo-code", "Roo Code"),
    ("aider", "Aider"),
    ("continue", "Continue"),
    ("windsurf", "Windsurf"),
    ("gemini cli", "Gemini CLI"),
    ("gemini-cli", "Gemini CLI"),
    ("goose", "Goose"),
    ("zed", "Zed"),
];

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// Identify the agent from explicit wrapper headers or its User-Agent.
pub fn detect_agent(headers: &HeaderMap) -> Option<AgentInfo> {
    let explicit_name = header(headers, AGENT_NAME_HEADER)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let explicit_version = header(headers, AGENT_VERSION_HEADER)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let user_agent = header(headers, "user-agent")
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(name) = explicit_name {
        return Some(AgentInfo {
            name: Some(truncate(name, 100)),
            version: explicit_version.map(|value| truncate(value, 100)),
            user_agent: user_agent.map(|value| truncate(value, 500)),
            detected_from: DetectedFrom::Headers,
        });
    }

    let user_agent = user_agent?;
    let lower = user_agent.to_ascii_lowercase();
    let name = AGENT_PATTERNS
        .iter()
        .find(|(pattern, _)| lower.contains(pattern))
        .map(|(_, label)| (*label).to_string());

    Some(AgentInfo {
        name,
        version: None,
        user_agent: Some(truncate(user_agent, 500)),
        detected_from: DetectedFrom::Headers,
    })
}

/// A provider identifier is lowercase, starts with a letter or digit, and
/// contains only letters, digits, dots, underscores, and hyphens.
pub fn is_provider_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
}

/// Read the explicit provider override header used by OpenAI-compatible tools.
pub fn provider_override(headers: &HeaderMap) -> Option<String> {
    let value = header(headers, PROVIDER_HEADER)?
        .trim()
        .to_ascii_lowercase();
    is_provider_id(&value).then_some(value)
}

fn truncate(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_headers_win() {
        let mut headers = HeaderMap::new();
        headers.insert(AGENT_NAME_HEADER, "My Agent".parse().unwrap());
        headers.insert(AGENT_VERSION_HEADER, "1.2.3".parse().unwrap());
        headers.insert("user-agent", "curl/8".parse().unwrap());

        let agent = detect_agent(&headers).unwrap();
        assert_eq!(agent.name.as_deref(), Some("My Agent"));
        assert_eq!(agent.version.as_deref(), Some("1.2.3"));
        assert_eq!(agent.detected_from, DetectedFrom::Headers);
    }

    #[test]
    fn detects_known_user_agents() {
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", "claude-code/2.0".parse().unwrap());
        let agent = detect_agent(&headers).unwrap();
        assert_eq!(agent.name.as_deref(), Some("Claude Code"));
    }

    #[test]
    fn unknown_user_agent_keeps_raw_value() {
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", "my-custom-client".parse().unwrap());
        let agent = detect_agent(&headers).unwrap();
        assert_eq!(agent.name, None);
        assert_eq!(agent.user_agent.as_deref(), Some("my-custom-client"));
    }

    #[test]
    fn validates_provider_ids() {
        assert!(is_provider_id("openai"));
        assert!(is_provider_id("my-provider_1.0"));
        assert!(!is_provider_id("OpenAI"));
        assert!(!is_provider_id("-bad"));
        assert!(!is_provider_id(""));
    }

    #[test]
    fn reads_provider_override() {
        let mut headers = HeaderMap::new();
        headers.insert(PROVIDER_HEADER, "deepseek".parse().unwrap());
        assert_eq!(provider_override(&headers).as_deref(), Some("deepseek"));
    }
}
