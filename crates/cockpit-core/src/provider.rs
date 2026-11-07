use serde::{Deserialize, Serialize};

/// The wire protocol a captured request used.
///
/// `openai` also covers OpenAI-compatible servers (DeepSeek, Groq, local
/// gateways). `gemini` covers the Google Generative Language API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderProtocol {
    Openai,
    Anthropic,
    Gemini,
}

impl ProviderProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai" => Some(Self::Openai),
            "anthropic" => Some(Self::Anthropic),
            "gemini" | "google" => Some(Self::Gemini),
            _ => None,
        }
    }

    pub fn default_provider(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }
}

impl std::fmt::Display for ProviderProtocol {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Where Cockpit learned which agent produced a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectedFrom {
    Headers,
    Wrapper,
    Manual,
    Demo,
    LogWatch,
    Hook,
    #[default]
    Unknown,
}

/// The coding agent behind a request, when Cockpit can identify it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub detected_from: DetectedFrom,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_protocols() {
        assert_eq!(
            ProviderProtocol::parse(" OpenAI "),
            Some(ProviderProtocol::Openai)
        );
        assert_eq!(
            ProviderProtocol::parse("google"),
            Some(ProviderProtocol::Gemini)
        );
        assert_eq!(ProviderProtocol::parse("cohere"), None);
    }

    #[test]
    fn serializes_lowercase() {
        let json = serde_json::to_string(&ProviderProtocol::Anthropic).unwrap();
        assert_eq!(json, "\"anthropic\"");
    }
}
