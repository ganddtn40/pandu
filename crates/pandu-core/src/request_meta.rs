use serde_json::Value;

use crate::provider::ProviderProtocol;
use crate::text::{MAX_PROMPT_CHARS, truncate_text};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestMetadata {
    pub model: Option<String>,
    pub stream: bool,
    pub system_prompt: Option<String>,
    pub prompt_text: Option<String>,
}

fn content_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let mut pieces = Vec::new();
            for part in parts {
                match part {
                    Value::String(text) => pieces.push(text.clone()),
                    Value::Object(object) => {
                        if let Some(text) = object.get("text").and_then(Value::as_str) {
                            pieces.push(text.to_string());
                            continue;
                        }
                        if let Some(content) = object.get("content").and_then(Value::as_str) {
                            pieces.push(content.to_string());
                            continue;
                        }
                        if matches!(
                            object.get("type").and_then(Value::as_str),
                            Some("image" | "image_url")
                        ) || object.contains_key("inlineData")
                            || object.contains_key("fileData")
                        {
                            pieces.push("[image]".to_string());
                        }
                    }
                    _ => {}
                }
            }
            pieces.join("\n")
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

fn join_blocks(blocks: Vec<String>, maximum: usize) -> Option<String> {
    let non_empty: Vec<String> = blocks
        .into_iter()
        .filter(|block| !block.trim().is_empty())
        .collect();
    if non_empty.is_empty() {
        return None;
    }
    Some(truncate_text(&non_empty.join("\n\n"), maximum))
}

fn model_from(body: &serde_json::Map<String, Value>) -> Option<String> {
    body.get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

fn collect_openai_chat(body: &serde_json::Map<String, Value>) -> RequestMetadata {
    let mut metadata = RequestMetadata {
        model: model_from(body),
        stream: body.get("stream").and_then(Value::as_bool).unwrap_or(false),
        ..RequestMetadata::default()
    };

    let mut system_blocks = Vec::new();
    let mut prompt_blocks = Vec::new();

    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            let Some(object) = message.as_object() else {
                continue;
            };
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            let text = content_to_text(object.get("content").unwrap_or(&Value::Null));
            if text.is_empty() {
                continue;
            }
            if role == "system" || role == "developer" {
                system_blocks.push(text);
            } else {
                prompt_blocks.push(format!("{role}: {text}"));
            }
        }
    }

    metadata.system_prompt = join_blocks(system_blocks, MAX_PROMPT_CHARS);
    metadata.prompt_text = join_blocks(prompt_blocks, MAX_PROMPT_CHARS);
    metadata
}

fn collect_openai_responses(body: &serde_json::Map<String, Value>) -> RequestMetadata {
    let mut metadata = RequestMetadata {
        model: model_from(body),
        stream: body.get("stream").and_then(Value::as_bool).unwrap_or(false),
        ..RequestMetadata::default()
    };

    let mut system_blocks = Vec::new();
    let mut prompt_blocks = Vec::new();

    if let Some(instructions) = body.get("instructions") {
        if let Some(text) = instructions.as_str() {
            system_blocks.push(text.to_string());
        } else {
            let rendered = content_to_text(instructions);
            if !rendered.is_empty() {
                system_blocks.push(rendered);
            }
        }
    }

    match body.get("input") {
        Some(Value::String(input)) => prompt_blocks.push(input.clone()),
        Some(Value::Array(items)) => {
            for item in items {
                match item {
                    Value::String(text) => prompt_blocks.push(text.clone()),
                    Value::Object(object) => {
                        let role = object.get("role").and_then(Value::as_str);
                        let text = content_to_text(object.get("content").unwrap_or(&Value::Null));
                        if !text.is_empty() {
                            if matches!(role, Some("system" | "developer")) {
                                system_blocks.push(text);
                            } else {
                                prompt_blocks.push(match role {
                                    Some(role) => format!("{role}: {text}"),
                                    None => text,
                                });
                            }
                            continue;
                        }
                        if let Some(output) = object.get("output").and_then(Value::as_str) {
                            prompt_blocks.push(format!("tool: {output}"));
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            let Some(object) = message.as_object() else {
                continue;
            };
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            let text = content_to_text(object.get("content").unwrap_or(&Value::Null));
            if text.is_empty() {
                continue;
            }
            if role == "system" || role == "developer" {
                system_blocks.push(text);
            } else {
                prompt_blocks.push(format!("{role}: {text}"));
            }
        }
    }

    metadata.system_prompt = join_blocks(system_blocks, MAX_PROMPT_CHARS);
    metadata.prompt_text = join_blocks(prompt_blocks, MAX_PROMPT_CHARS);
    metadata
}

fn collect_anthropic(body: &serde_json::Map<String, Value>) -> RequestMetadata {
    let mut metadata = RequestMetadata {
        model: model_from(body),
        stream: body.get("stream").and_then(Value::as_bool).unwrap_or(false),
        ..RequestMetadata::default()
    };

    let mut system_blocks = Vec::new();
    let mut prompt_blocks = Vec::new();

    if let Some(system) = body.get("system") {
        if let Some(text) = system.as_str() {
            system_blocks.push(text.to_string());
        } else {
            let rendered = content_to_text(system);
            if !rendered.is_empty() {
                system_blocks.push(rendered);
            }
        }
    }

    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            let Some(object) = message.as_object() else {
                continue;
            };
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            let text = content_to_text(object.get("content").unwrap_or(&Value::Null));
            if text.is_empty() {
                continue;
            }
            prompt_blocks.push(format!("{role}: {text}"));
        }
    }

    metadata.system_prompt = join_blocks(system_blocks, MAX_PROMPT_CHARS);
    metadata.prompt_text = join_blocks(prompt_blocks, MAX_PROMPT_CHARS);
    metadata
}

fn collect_gemini(body: &serde_json::Map<String, Value>, path: &str) -> RequestMetadata {
    let mut metadata = RequestMetadata {
        model: model_from(body),
        stream: body.get("stream").and_then(Value::as_bool).unwrap_or(false)
            || path.contains(":streamGenerateContent"),
        ..RequestMetadata::default()
    };

    let mut system_blocks = Vec::new();
    let mut prompt_blocks = Vec::new();

    if let Some(system) = body.get("systemInstruction") {
        if let Some(text) = system.as_str() {
            system_blocks.push(text.to_string());
        } else if let Some(object) = system.as_object() {
            let rendered = content_to_text(object.get("parts").unwrap_or(&Value::Null));
            if !rendered.is_empty() {
                system_blocks.push(rendered);
            }
        } else {
            let rendered = content_to_text(system);
            if !rendered.is_empty() {
                system_blocks.push(rendered);
            }
        }
    }

    if let Some(contents) = body.get("contents") {
        let items: Vec<&Value> = match contents {
            Value::Array(items) => items.iter().collect(),
            other => vec![other],
        };
        for item in items {
            let Some(object) = item.as_object() else {
                continue;
            };
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            let text = content_to_text(object.get("parts").unwrap_or(&Value::Null));
            if text.is_empty() {
                continue;
            }
            if role == "system" || role == "developer" {
                system_blocks.push(text);
            } else {
                prompt_blocks.push(format!("{role}: {text}"));
            }
        }
    }

    metadata.system_prompt = join_blocks(system_blocks, MAX_PROMPT_CHARS);
    metadata.prompt_text = join_blocks(prompt_blocks, MAX_PROMPT_CHARS);
    metadata
}

pub fn extract_request_metadata(
    protocol: ProviderProtocol,
    path: &str,
    body: Option<&Value>,
) -> RequestMetadata {
    let Some(body) = body.and_then(Value::as_object) else {
        return RequestMetadata::default();
    };

    match protocol {
        ProviderProtocol::Anthropic => collect_anthropic(body),
        ProviderProtocol::Gemini => collect_gemini(body, path),
        ProviderProtocol::Openai => {
            if path.contains("/responses")
                || body.get("object").and_then(Value::as_str) == Some("response")
            {
                collect_openai_responses(body)
            } else {
                collect_openai_chat(body)
            }
        }
    }
}

fn last_user_message(value: Option<&Value>) -> Option<String> {
    let items = value?.as_array()?;
    for item in items.iter().rev() {
        let Some(object) = item.as_object() else {
            continue;
        };
        if object.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let text = content_to_text(object.get("content").unwrap_or(&Value::Null));
        let text = if text.trim().is_empty() {
            content_to_text(object.get("parts").unwrap_or(&Value::Null))
        } else {
            text
        };
        if !text.trim().is_empty() {
            return Some(truncate_text(&text, MAX_PROMPT_CHARS));
        }
    }
    None
}

/// Loop detection needs the newest instruction, not the growing transcript.
pub fn extract_latest_user_message(
    protocol: ProviderProtocol,
    path: &str,
    body: Option<&Value>,
) -> Option<String> {
    let body = body?.as_object()?;

    match protocol {
        ProviderProtocol::Anthropic => last_user_message(body.get("messages")),
        ProviderProtocol::Gemini => last_user_message(body.get("contents")),
        ProviderProtocol::Openai => {
            if let Some(message) = last_user_message(body.get("messages")) {
                return Some(message);
            }
            if path.contains("/responses")
                || body.get("object").and_then(Value::as_str) == Some("response")
            {
                if let Some(input) = body.get("input") {
                    if let Some(text) = input.as_str() {
                        if !text.trim().is_empty() {
                            return Some(truncate_text(text, MAX_PROMPT_CHARS));
                        }
                    }
                    return last_user_message(Some(input));
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_openai_chat_prompt_and_system() {
        let body = json!({
            "model": "gpt-4.1",
            "stream": true,
            "messages": [
                { "role": "system", "content": "You are terse." },
                { "role": "user", "content": "Fix the build" }
            ]
        });
        let metadata = extract_request_metadata(
            ProviderProtocol::Openai,
            "/v1/chat/completions",
            Some(&body),
        );
        assert_eq!(metadata.model.as_deref(), Some("gpt-4.1"));
        assert!(metadata.stream);
        assert_eq!(metadata.system_prompt.as_deref(), Some("You are terse."));
        assert_eq!(metadata.prompt_text.as_deref(), Some("user: Fix the build"));
    }

    #[test]
    fn extracts_anthropic_blocks() {
        let body = json!({
            "model": "claude-sonnet-4",
            "system": [{ "type": "text", "text": "Rules" }],
            "messages": [{ "role": "user", "content": [{ "type": "text", "text": "Hello" }] }]
        });
        let metadata =
            extract_request_metadata(ProviderProtocol::Anthropic, "/v1/messages", Some(&body));
        assert_eq!(metadata.system_prompt.as_deref(), Some("Rules"));
        assert_eq!(metadata.prompt_text.as_deref(), Some("user: Hello"));
    }

    #[test]
    fn extracts_responses_input() {
        let body = json!({
            "model": "gpt-4.1",
            "instructions": "Be brief",
            "input": "What changed?"
        });
        let metadata =
            extract_request_metadata(ProviderProtocol::Openai, "/v1/responses", Some(&body));
        assert_eq!(metadata.system_prompt.as_deref(), Some("Be brief"));
        assert_eq!(metadata.prompt_text.as_deref(), Some("What changed?"));
    }

    #[test]
    fn extracts_gemini_parts_and_streaming() {
        let body = json!({
            "systemInstruction": { "parts": [{ "text": "Be nice" }] },
            "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }]
        });
        let metadata = extract_request_metadata(
            ProviderProtocol::Gemini,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
            Some(&body),
        );
        assert!(metadata.stream);
        assert_eq!(metadata.system_prompt.as_deref(), Some("Be nice"));
        assert_eq!(metadata.prompt_text.as_deref(), Some("user: Hi"));
    }

    #[test]
    fn finds_latest_user_message() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "first" },
                { "role": "assistant", "content": "reply" },
                { "role": "user", "content": "second" }
            ]
        });
        assert_eq!(
            extract_latest_user_message(
                ProviderProtocol::Openai,
                "/v1/chat/completions",
                Some(&body)
            )
            .as_deref(),
            Some("second")
        );
    }
}
