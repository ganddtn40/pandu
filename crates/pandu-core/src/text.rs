use serde_json::Value;

pub const MAX_PROMPT_CHARS: usize = 2_000_000;
pub const MAX_RESPONSE_CHARS: usize = 20_000_000;
pub const MAX_STREAM_DATA_CHARS: usize = 1_000_000;
pub const MAX_STREAM_DELTA_CHARS: usize = 200_000;
pub const MAX_THINKING_CHARS: usize = 2_000_000;
pub const MAX_TOOL_ARGUMENT_CHARS: usize = 2_000_000;

/// Truncate to at most `maximum` bytes without splitting a UTF-8 character.
pub fn truncate_text(value: &str, maximum: usize) -> String {
    if value.len() <= maximum {
        return value.to_string();
    }
    let mut end = maximum;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

/// Append `addition` while keeping the total at or below `maximum` bytes.
pub fn append_limited(current: &mut String, addition: &str, maximum: usize) {
    if addition.is_empty() || current.len() >= maximum {
        return;
    }
    let remaining = maximum - current.len();
    if addition.len() <= remaining {
        current.push_str(addition);
        return;
    }
    let mut end = remaining;
    while end > 0 && !addition.is_char_boundary(end) {
        end -= 1;
    }
    current.push_str(&addition[..end]);
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedJsonBody {
    pub value: Option<Value>,
    pub text: String,
    pub is_json: bool,
}

/// Parse a request or response body without ever rejecting non-JSON payloads.
///
/// Providers accept plain text and custom encodings, and the proxy must still
/// forward them untouched. A parse failure is therefore a normal outcome.
pub fn parse_json_body(text: &str) -> ParsedJsonBody {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return ParsedJsonBody {
            value: None,
            text: String::new(),
            is_json: false,
        };
    }

    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => ParsedJsonBody {
            value: Some(value),
            text: text.to_string(),
            is_json: true,
        },
        Err(_) => ParsedJsonBody {
            value: None,
            text: text.to_string(),
            is_json: false,
        },
    }
}

pub fn stringify_for_storage(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Best-effort extraction of file paths from a tool call's input.
pub fn extract_file_paths(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };

    let mut paths = Vec::new();
    collect_paths(value, &mut paths, 0);
    paths.sort();
    paths.dedup();
    paths.truncate(100);
    paths
}

fn collect_paths(value: &Value, paths: &mut Vec<String>, depth: usize) {
    if depth > 4 || paths.len() >= 100 {
        return;
    }
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                if matches!(
                    normalized.as_str(),
                    "path" | "file" | "filepath" | "filename" | "notebookpath" | "cwd"
                ) {
                    if let Some(path) = child.as_str() {
                        let path = path.trim();
                        if !path.is_empty() && path.len() <= 4096 {
                            paths.push(path.to_string());
                        }
                    }
                }
                collect_paths(child, paths, depth + 1);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_paths(item, paths, depth + 1);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate_text("hello", 10), "hello");
        assert_eq!(truncate_text("hello", 3), "hel");
        assert_eq!(truncate_text("aé", 2), "a");
    }

    #[test]
    fn appends_within_limit() {
        let mut value = String::from("abc");
        append_limited(&mut value, "def", 5);
        assert_eq!(value, "abcde");
        append_limited(&mut value, "ignored", 5);
        assert_eq!(value, "abcde");
    }

    #[test]
    fn parses_json_and_keeps_plain_text() {
        let parsed = parse_json_body(" {\"a\":1} ");
        assert!(parsed.is_json);
        assert_eq!(parsed.value, Some(json!({ "a": 1 })));

        let plain = parse_json_body("not json");
        assert!(!plain.is_json);
        assert_eq!(plain.text, "not json");

        let empty = parse_json_body("   ");
        assert_eq!(empty.text, "");
    }

    #[test]
    fn extracts_paths_from_tool_input() {
        let paths = extract_file_paths(Some(&json!({
            "file_path": "src/main.rs",
            "nested": { "path": "docs/README.md" },
            "other": 3
        })));
        assert_eq!(paths, vec!["docs/README.md", "src/main.rs"]);
    }
}
