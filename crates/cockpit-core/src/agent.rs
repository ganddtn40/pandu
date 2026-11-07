use http::HeaderMap;

use crate::provider::{AgentInfo, DetectedFrom};

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
    let explicit_name = header(headers, "x-cockpit-agent-name")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let explicit_version = header(headers, "x-cockpit-agent-version")
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
    let value = header(headers, "x-cockpit-provider")?
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
        headers.insert("x-cockpit-agent-name", "My Agent".parse().unwrap());
        headers.insert("x-cockpit-agent-version", "1.2.3".parse().unwrap());
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
        headers.insert("x-cockpit-provider", "deepseek".parse().unwrap());
        assert_eq!(provider_override(&headers).as_deref(), Some("deepseek"));
    }
}
