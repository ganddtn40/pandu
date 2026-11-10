use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where a redaction happened. Kept separate so the UI can explain why a
/// stored request differs from what the agent sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureLocation {
    RequestHeaders,
    RequestBody,
    ResponseHeaders,
    ResponseBody,
}

impl CaptureLocation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RequestHeaders => "request_headers",
            Self::RequestBody => "request_body",
            Self::ResponseHeaders => "response_headers",
            Self::ResponseBody => "response_body",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "request_headers" => Some(Self::RequestHeaders),
            "request_body" => Some(Self::RequestBody),
            "response_headers" => Some(Self::ResponseHeaders),
            "response_body" => Some(Self::ResponseBody),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionRow {
    pub rule_id: String,
    pub label: String,
    pub location: CaptureLocation,
    pub occurrences: u64,
}

/// Counts what was redacted without retaining the secret itself.
#[derive(Debug, Clone, Default)]
pub struct RedactionCollector {
    rows: Vec<RedactionRow>,
}

impl RedactionCollector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(
        &mut self,
        location: CaptureLocation,
        rule_id: &str,
        label: &str,
        occurrences: u64,
    ) {
        if occurrences == 0 {
            return;
        }
        if let Some(row) = self
            .rows
            .iter_mut()
            .find(|row| row.rule_id == rule_id && row.label == label && row.location == location)
        {
            row.occurrences += occurrences;
            return;
        }
        self.rows.push(RedactionRow {
            rule_id: rule_id.to_string(),
            label: label.to_string(),
            location,
            occurrences,
        });
    }

    pub fn total(&self, location: Option<CaptureLocation>) -> u64 {
        self.rows
            .iter()
            .filter(|row| location.is_none_or(|wanted| row.location == wanted))
            .map(|row| row.occurrences)
            .sum()
    }

    pub fn rows(&self) -> Vec<RedactionRow> {
        self.rows.clone()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "azure-api-key",
    "cookie",
    "set-cookie",
    "x-amz-security-token",
];

const SENSITIVE_KEYS: &[&str] = &[
    "authorization",
    "proxyauthorization",
    "xapikey",
    "apikey",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "clientid",
    "password",
    "passwd",
    "secret",
    "token",
    "privatekey",
    "sessiontoken",
    "bearertoken",
    "awsaccesskeyid",
    "awssecretaccesskey",
];

/// One recognizable secret shape.
///
/// The guard scanner reuses these patterns so a value is classified exactly
/// the same way whether it is being redacted or reported.
#[derive(Debug, Clone)]
pub struct SecretPattern {
    pub rule_id: &'static str,
    pub label: &'static str,
    pub pattern: Regex,
}

pub static SECRET_PATTERNS: LazyLock<Vec<SecretPattern>> = LazyLock::new(|| {
    vec![
        SecretPattern {
            rule_id: "anthropic-api-key",
            label: "Anthropic API key",
            pattern: Regex::new(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b").expect("valid regex"),
        },
        SecretPattern {
            rule_id: "openai-api-key",
            label: "OpenAI API key",
            pattern: Regex::new(r"\bsk-[A-Za-z0-9_-]{20,}\b").expect("valid regex"),
        },
        SecretPattern {
            rule_id: "github-token",
            label: "GitHub token",
            pattern: Regex::new(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b")
                .expect("valid regex"),
        },
        SecretPattern {
            rule_id: "aws-access-key",
            label: "AWS access key",
            pattern: Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("valid regex"),
        },
        SecretPattern {
            rule_id: "google-api-key",
            label: "Google API key",
            pattern: Regex::new(r"\bAIza[0-9A-Za-z_-]{35}\b").expect("valid regex"),
        },
        SecretPattern {
            rule_id: "slack-token",
            label: "Slack token",
            pattern: Regex::new(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b").expect("valid regex"),
        },
        SecretPattern {
            rule_id: "private-key",
            label: "Private key block",
            pattern: Regex::new(
                r"(?s)-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----",
            )
            .expect("valid regex"),
        },
        SecretPattern {
            rule_id: "bearer-token",
            label: "Bearer token",
            pattern: Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b").expect("valid regex"),
        },
        SecretPattern {
            rule_id: "jwt",
            label: "JWT",
            pattern: Regex::new(
                r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
            )
            .expect("valid regex"),
        },
    ]
});

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Mask a secret before it reaches a guard event or the database.
///
/// Long values keep four leading and four trailing characters so a user can
/// recognize which credential leaked without storing it again.
pub fn mask_secret(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.contains("BEGIN") && trimmed.contains("PRIVATE KEY") {
        return "-----BEGIN PRIVATE KEY----- [redacted]".to_string();
    }
    let characters: Vec<char> = trimmed.chars().collect();
    if characters.len() <= 10 {
        return "[redacted]".to_string();
    }
    let head: String = characters[..4].iter().collect();
    let tail: String = characters[characters.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

pub fn redact_headers(
    headers: &BTreeMap<String, String>,
    collector: &mut RedactionCollector,
    location: CaptureLocation,
) -> BTreeMap<String, String> {
    let mut redacted = BTreeMap::new();

    for (name, value) in headers {
        let lower_name = name.to_ascii_lowercase();
        if SENSITIVE_HEADERS.contains(&lower_name.as_str()) {
            collector.record(
                location,
                "sensitive-header",
                &format!("Sensitive header: {lower_name}"),
                1,
            );
            redacted.insert(lower_name, "[REDACTED]".to_string());
            continue;
        }
        redacted.insert(lower_name, redact_string(value, collector, location));
    }

    redacted
}

pub fn redact_json(
    value: &Value,
    collector: &mut RedactionCollector,
    location: CaptureLocation,
) -> Value {
    match value {
        Value::String(text) => Value::String(redact_string(text, collector, location)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_json(item, collector, location))
                .collect(),
        ),
        Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, child) in map {
                if SENSITIVE_KEYS.contains(&normalized_key(key).as_str()) {
                    collector.record(
                        location,
                        "sensitive-field",
                        &format!("Sensitive field: {key}"),
                        1,
                    );
                    redacted.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                    continue;
                }
                redacted.insert(key.clone(), redact_json(child, collector, location));
            }
            Value::Object(redacted)
        }
        other => other.clone(),
    }
}

pub fn redact_text(
    value: &str,
    collector: &mut RedactionCollector,
    location: CaptureLocation,
) -> String {
    redact_string(value, collector, location)
}

fn redact_string(
    value: &str,
    collector: &mut RedactionCollector,
    location: CaptureLocation,
) -> String {
    let mut result = value.to_string();

    for rule in SECRET_PATTERNS.iter() {
        let occurrences = rule.pattern.find_iter(&result).count() as u64;
        if occurrences == 0 {
            continue;
        }
        collector.record(location, rule.rule_id, rule.label, occurrences);
        let replacement = format!("[REDACTED:{}]", rule.label);
        result = rule
            .pattern
            .replace_all(&result, replacement.as_str())
            .into_owned();
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_sensitive_headers() {
        let headers = BTreeMap::from([
            ("Authorization".to_string(), "Bearer abc".to_string()),
            ("Content-Type".to_string(), "application/json".to_string()),
        ]);
        let mut collector = RedactionCollector::new();
        let redacted = redact_headers(&headers, &mut collector, CaptureLocation::RequestHeaders);

        assert_eq!(redacted["authorization"], "[REDACTED]");
        assert_eq!(redacted["content-type"], "application/json");
        assert_eq!(collector.total(Some(CaptureLocation::RequestHeaders)), 1);
    }

    #[test]
    fn redacts_nested_sensitive_keys() {
        let body = json!({
            "model": "gpt-4.1",
            "api_key": "plain-text",
            "nested": { "clientSecret": "shh", "safe": "ok" },
            "items": [{ "password": "p" }]
        });
        let mut collector = RedactionCollector::new();
        let redacted = redact_json(&body, &mut collector, CaptureLocation::RequestBody);

        assert_eq!(redacted["api_key"], "[REDACTED]");
        assert_eq!(redacted["nested"]["clientSecret"], "[REDACTED]");
        assert_eq!(redacted["nested"]["safe"], "ok");
        assert_eq!(redacted["items"][0]["password"], "[REDACTED]");
        assert_eq!(collector.rows().len(), 3);
    }

    #[test]
    fn redacts_provider_tokens() {
        let text = "key sk-ant-abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnopqrstuvwx";
        let mut collector = RedactionCollector::new();
        let redacted = redact_text(text, &mut collector, CaptureLocation::ResponseBody);

        assert!(redacted.contains("[REDACTED:Anthropic API key]"));
        assert!(redacted.contains("[REDACTED:Bearer token]"));
        assert!(!redacted.contains("sk-ant-abcdefghijklmnopqrstuvwx"));
        assert_eq!(collector.total(None), 2);
    }

    #[test]
    fn leaves_clean_text_alone() {
        let mut collector = RedactionCollector::new();
        let text = "The build passed in 1.2 seconds.";
        assert_eq!(
            redact_text(text, &mut collector, CaptureLocation::ResponseBody),
            text
        );
        assert!(collector.is_empty());
    }

    #[test]
    fn counts_repeated_secrets() {
        let mut collector = RedactionCollector::new();
        let text = "sk-abcdefghijklmnopqrstuvwx sk-abcdefghijklmnopqrstuvwx";
        let redacted = redact_text(text, &mut collector, CaptureLocation::RequestBody);
        assert_eq!(redacted.matches("[REDACTED:OpenAI API key]").count(), 2);
        assert_eq!(collector.total(None), 2);
    }

    #[test]
    fn masks_secrets_without_retaining_them() {
        assert_eq!(mask_secret("short"), "[redacted]");
        assert_eq!(mask_secret("sk-ant-abcdefghijklmnop"), "sk-a…mnop");
        assert_eq!(
            mask_secret("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"),
            "-----BEGIN PRIVATE KEY----- [redacted]"
        );
    }
}
