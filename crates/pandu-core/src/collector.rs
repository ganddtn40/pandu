use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::model::{FinishReason, StreamChunkKind};
use crate::provider::ProviderProtocol;
use crate::sse::SseEvent;
use crate::text::{
    MAX_RESPONSE_CHARS, MAX_THINKING_CHARS, MAX_TOOL_ARGUMENT_CHARS, append_limited,
};
use crate::usage::{TokenUsage, normalize_usage};

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedToolCall {
    pub provider_tool_call_id: Option<String>,
    pub name: String,
    pub input: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollectedResponse {
    pub text: String,
    pub thinking: String,
    pub usage: TokenUsage,
    pub finish_reason: Option<FinishReason>,
    pub tool_calls: Vec<ParsedToolCall>,
    pub model: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestedEvent {
    pub kind: StreamChunkKind,
    pub delta_text: Option<String>,
}

impl IngestedEvent {
    fn event() -> Self {
        Self {
            kind: StreamChunkKind::Event,
            delta_text: None,
        }
    }

    fn text(delta: String) -> Self {
        Self {
            kind: StreamChunkKind::Text,
            delta_text: Some(delta),
        }
    }

    fn thinking(delta: String) -> Self {
        Self {
            kind: StreamChunkKind::Thinking,
            delta_text: Some(delta),
        }
    }

    fn tool_call() -> Self {
        Self {
            kind: StreamChunkKind::ToolCall,
            delta_text: None,
        }
    }

    fn usage() -> Self {
        Self {
            kind: StreamChunkKind::Usage,
            delta_text: None,
        }
    }

    fn done() -> Self {
        Self {
            kind: StreamChunkKind::Done,
            delta_text: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct ToolCallAccumulator {
    id: Option<String>,
    name: String,
    arguments_text: String,
    initial_input: Option<Value>,
    finalized: bool,
}

pub fn map_openai_finish_reason(value: Option<&str>) -> Option<FinishReason> {
    match value {
        Some("stop") => Some(FinishReason::Stop),
        Some("length") => Some(FinishReason::Length),
        Some("tool_calls" | "function_call") => Some(FinishReason::ToolCalls),
        Some("content_filter") => Some(FinishReason::ContentFilter),
        Some("error") => Some(FinishReason::Error),
        Some(_) => Some(FinishReason::Unknown),
        None => None,
    }
}

pub fn map_anthropic_finish_reason(value: Option<&str>) -> Option<FinishReason> {
    match value {
        Some("end_turn" | "stop_sequence" | "pause_turn") => Some(FinishReason::Stop),
        Some("max_tokens") => Some(FinishReason::Length),
        Some("tool_use") => Some(FinishReason::ToolCalls),
        Some("refusal") => Some(FinishReason::ContentFilter),
        Some(_) => Some(FinishReason::Unknown),
        None => None,
    }
}

pub fn map_gemini_finish_reason(value: Option<&str>) -> Option<FinishReason> {
    match value {
        Some("STOP") => Some(FinishReason::Stop),
        Some("MAX_TOKENS") => Some(FinishReason::Length),
        Some("SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII") => {
            Some(FinishReason::ContentFilter)
        }
        Some("MALFORMED_FUNCTION_CALL" | "UNEXPECTED_TOOL_CALL") => Some(FinishReason::Error),
        Some("OTHER") => Some(FinishReason::Unknown),
        Some(_) => Some(FinishReason::Unknown),
        None => None,
    }
}

fn parse_json_value(text: &str) -> Option<Value> {
    if text.trim().is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) => Some(value),
        Err(_) => Some(Value::String(text.to_string())),
    }
}

fn content_part_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let mut pieces = Vec::new();
            for part in parts {
                let Some(object) = part.as_object() else {
                    continue;
                };
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    pieces.push(text.to_string());
                } else if let Some(refusal) = object.get("refusal").and_then(Value::as_str) {
                    pieces.push(refusal.to_string());
                }
            }
            pieces.join("")
        }
        _ => String::new(),
    }
}

fn tool_calls_from_openai_message(message: &Map<String, Value>) -> Vec<ParsedToolCall> {
    let Some(Value::Array(raw_calls)) = message.get("tool_calls") else {
        return Vec::new();
    };

    let mut calls = Vec::new();
    for raw_call in raw_calls {
        let Some(call) = raw_call.as_object() else {
            continue;
        };
        let function = call.get("function").and_then(Value::as_object);
        let Some(name) = function
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let id = call.get("id").and_then(Value::as_str);
        let input = function
            .and_then(|function| function.get("arguments"))
            .and_then(|arguments| match arguments {
                Value::String(text) => parse_json_value(text),
                Value::Null => None,
                other => Some(other.clone()),
            });

        calls.push(ParsedToolCall {
            provider_tool_call_id: id.map(str::to_string),
            name: name.to_string(),
            input,
        });
    }
    calls
}

fn tool_calls_from_anthropic_content(content: &[Value]) -> Vec<ParsedToolCall> {
    let mut calls = Vec::new();
    for block in content {
        let Some(object) = block.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(name) = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        calls.push(ParsedToolCall {
            provider_tool_call_id: object.get("id").and_then(Value::as_str).map(str::to_string),
            name: name.to_string(),
            input: object.get("input").cloned(),
        });
    }
    calls
}

fn tool_calls_from_openai_output(output: Option<&Value>) -> Vec<ParsedToolCall> {
    let Some(Value::Array(items)) = output else {
        return Vec::new();
    };

    let mut calls = Vec::new();
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let Some(name) = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let input = object
            .get("arguments")
            .and_then(|arguments| match arguments {
                Value::String(text) => parse_json_value(text),
                Value::Null => None,
                other => Some(other.clone()),
            });
        calls.push(ParsedToolCall {
            provider_tool_call_id: object
                .get("call_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            name: name.to_string(),
            input,
        });
    }
    calls
}

fn output_text_from_openai_output(output: Option<&Value>) -> String {
    let Some(Value::Array(items)) = output else {
        return String::new();
    };
    let mut pieces = Vec::new();
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) == Some("message") {
            pieces.push(content_part_text(
                object.get("content").unwrap_or(&Value::Null),
            ));
        }
    }
    pieces.join("")
}

fn reasoning_from_openai_output(output: Option<&Value>) -> String {
    let Some(Value::Array(items)) = output else {
        return String::new();
    };
    let mut pieces = Vec::new();
    for item in items {
        let Some(object) = item.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some("reasoning") {
            continue;
        }
        let Some(Value::Array(summary)) = object.get("summary") else {
            continue;
        };
        for part in summary {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                pieces.push(text.to_string());
            }
        }
    }
    pieces.join("\n")
}

fn merge_usage(base: TokenUsage, update: TokenUsage) -> TokenUsage {
    TokenUsage {
        input_tokens: if update.input_tokens > 0 {
            update.input_tokens
        } else {
            base.input_tokens
        },
        output_tokens: if update.output_tokens > 0 {
            update.output_tokens
        } else {
            base.output_tokens
        },
        cache_read_tokens: if update.cache_read_tokens > 0 {
            update.cache_read_tokens
        } else {
            base.cache_read_tokens
        },
        cache_write_tokens: if update.cache_write_tokens > 0 {
            update.cache_write_tokens
        } else {
            base.cache_write_tokens
        },
        reasoning_tokens: if update.reasoning_tokens > 0 {
            update.reasoning_tokens
        } else {
            base.reasoning_tokens
        },
    }
}

fn error_message(value: &Value) -> String {
    match value {
        Value::Object(object) => object
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string()),
        _ => value.to_string(),
    }
}

/// Observe OpenAI Chat/Responses, Anthropic Messages, and Gemini streaming
/// events. The collector never mutates the bytes sent to the client.
#[derive(Debug)]
pub struct ProtocolCollector {
    protocol: ProviderProtocol,
    responses_mode: bool,
    tool_calls: BTreeMap<String, ToolCallAccumulator>,
    text: String,
    thinking: String,
    usage: TokenUsage,
    finish_reason: Option<FinishReason>,
    model: Option<String>,
    error: Option<String>,
    fallback_text: String,
    fallback_thinking: String,
}

impl ProtocolCollector {
    pub fn new(protocol: ProviderProtocol, path: &str) -> Self {
        Self {
            protocol,
            responses_mode: protocol == ProviderProtocol::Openai && path.contains("/responses"),
            tool_calls: BTreeMap::new(),
            text: String::new(),
            thinking: String::new(),
            usage: TokenUsage::ZERO,
            finish_reason: None,
            model: None,
            error: None,
            fallback_text: String::new(),
            fallback_thinking: String::new(),
        }
    }

    pub fn ingest(&mut self, event: &SseEvent) -> IngestedEvent {
        if event.data.trim() == "[DONE]" {
            return IngestedEvent::done();
        }
        if event.data.trim().is_empty() {
            return IngestedEvent::event();
        }

        let payload = match serde_json::from_str::<Value>(&event.data) {
            Ok(value) => value,
            Err(_) => return IngestedEvent::event(),
        };
        let Some(object) = payload.as_object() else {
            return IngestedEvent::event();
        };

        match self.protocol {
            ProviderProtocol::Anthropic => self.ingest_anthropic(object, event.event.as_deref()),
            ProviderProtocol::Gemini => self.ingest_gemini(object),
            ProviderProtocol::Openai => {
                let event_type = object.get("type").and_then(Value::as_str);
                if self.responses_mode
                    || event_type.is_some_and(|value| value.starts_with("response."))
                {
                    self.ingest_openai_responses(object, event_type)
                } else {
                    self.ingest_openai_chat(object)
                }
            }
        }
    }

    pub fn snapshot(&mut self) -> CollectedResponse {
        let text = if self.text.is_empty() {
            self.fallback_text.clone()
        } else {
            self.text.clone()
        };
        let thinking = if self.thinking.is_empty() {
            self.fallback_thinking.clone()
        } else {
            self.thinking.clone()
        };

        CollectedResponse {
            text,
            thinking,
            usage: self.usage,
            finish_reason: self.finish_reason,
            tool_calls: self.finalize_tool_calls(),
            model: self.model.clone(),
            error: self.error.clone(),
        }
    }

    fn record_usage(&mut self, raw: &Value) {
        self.usage = merge_usage(self.usage, normalize_usage(raw, Some(self.protocol)));
    }

    fn tool_accumulator(&mut self, key: &str) -> &mut ToolCallAccumulator {
        self.tool_calls.entry(key.to_string()).or_default()
    }

    fn record_tool_call_chunk(&mut self, key: &str, call: &Map<String, Value>, delta: &str) {
        let accumulator = self.tool_accumulator(key);

        if let Some(id) = call.get("id").and_then(Value::as_str) {
            accumulator.id = Some(id.to_string());
        }
        if let Some(function) = call.get("function").and_then(Value::as_object) {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                accumulator.name = name.to_string();
            }
            match function.get("arguments") {
                Some(Value::String(arguments)) => append_limited(
                    &mut accumulator.arguments_text,
                    arguments,
                    MAX_TOOL_ARGUMENT_CHARS,
                ),
                Some(Value::Object(_)) => {
                    accumulator.initial_input = function.get("arguments").cloned();
                }
                _ => {}
            }
        }
        if !delta.is_empty() {
            append_limited(
                &mut accumulator.arguments_text,
                delta,
                MAX_TOOL_ARGUMENT_CHARS,
            );
        }
    }

    fn ingest_openai_chat(&mut self, payload: &Map<String, Value>) -> IngestedEvent {
        if let Some(error) = payload.get("error").and_then(Value::as_object) {
            self.error = Some(error_message(&Value::Object(error.clone())));
            self.finish_reason = Some(FinishReason::Error);
            return IngestedEvent::event();
        }

        if let Some(model) = payload.get("model").and_then(Value::as_str) {
            self.model = Some(model.to_string());
        }
        if let Some(usage) = payload.get("usage") {
            self.record_usage(usage);
        }

        let mut text_delta = String::new();
        let mut thinking_delta = String::new();
        let mut saw_tool_call = false;

        if let Some(Value::Array(choices)) = payload.get("choices") {
            for choice in choices {
                let Some(choice) = choice.as_object() else {
                    continue;
                };
                let delta = choice
                    .get("delta")
                    .and_then(Value::as_object)
                    .or_else(|| choice.get("message").and_then(Value::as_object));

                if let Some(delta) = delta {
                    match delta.get("content") {
                        Some(Value::String(content)) => {
                            append_limited(&mut text_delta, content, MAX_RESPONSE_CHARS);
                        }
                        Some(Value::Array(_)) => {
                            let content =
                                content_part_text(delta.get("content").unwrap_or(&Value::Null));
                            append_limited(&mut text_delta, &content, MAX_RESPONSE_CHARS);
                        }
                        _ => {}
                    }

                    let reasoning = delta
                        .get("reasoning_content")
                        .or_else(|| delta.get("reasoning"))
                        .and_then(Value::as_str);
                    if let Some(reasoning) = reasoning {
                        append_limited(&mut thinking_delta, reasoning, MAX_THINKING_CHARS);
                    }

                    if let Some(Value::Array(tool_calls)) = delta.get("tool_calls") {
                        for (fallback_index, raw_call) in tool_calls.iter().enumerate() {
                            let Some(raw_call) = raw_call.as_object() else {
                                continue;
                            };
                            let index = raw_call
                                .get("index")
                                .and_then(Value::as_u64)
                                .map(|value| value as usize)
                                .unwrap_or(fallback_index);
                            self.record_tool_call_chunk(&format!("chat:{index}"), raw_call, "");
                            saw_tool_call = true;
                        }
                    }

                    if let Some(legacy_function) =
                        delta.get("function_call").and_then(Value::as_object)
                    {
                        let accumulator = self.tool_accumulator("chat:legacy");
                        if let Some(name) = legacy_function.get("name").and_then(Value::as_str) {
                            accumulator.name = name.to_string();
                        }
                        if let Some(arguments) =
                            legacy_function.get("arguments").and_then(Value::as_str)
                        {
                            append_limited(
                                &mut accumulator.arguments_text,
                                arguments,
                                MAX_TOOL_ARGUMENT_CHARS,
                            );
                        }
                        saw_tool_call = true;
                    }
                }

                if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                    self.finish_reason = map_openai_finish_reason(Some(reason));
                }
            }
        }

        append_limited(&mut self.text, &text_delta, MAX_RESPONSE_CHARS);
        append_limited(&mut self.thinking, &thinking_delta, MAX_THINKING_CHARS);

        if !text_delta.is_empty() {
            IngestedEvent::text(text_delta)
        } else if !thinking_delta.is_empty() {
            IngestedEvent::thinking(thinking_delta)
        } else if saw_tool_call {
            IngestedEvent::tool_call()
        } else if payload.contains_key("usage") {
            IngestedEvent::usage()
        } else {
            IngestedEvent::event()
        }
    }

    fn ingest_openai_responses(
        &mut self,
        payload: &Map<String, Value>,
        event_type: Option<&str>,
    ) -> IngestedEvent {
        if matches!(event_type, Some("error" | "response.failed")) {
            let error = payload
                .get("error")
                .and_then(Value::as_object)
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .or_else(|| {
                    payload
                        .get("response")
                        .and_then(Value::as_object)
                        .and_then(|response| response.get("error"))
                        .and_then(Value::as_object)
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                });
            self.error = Some(error.unwrap_or("Upstream response failed").to_string());
            self.finish_reason = Some(FinishReason::Error);
            return IngestedEvent::event();
        }

        if event_type == Some("response.created") {
            if let Some(model) = payload
                .get("response")
                .and_then(Value::as_object)
                .and_then(|response| response.get("model"))
                .and_then(Value::as_str)
            {
                self.model = Some(model.to_string());
            }
            return IngestedEvent::event();
        }

        if matches!(
            event_type,
            Some("response.output_text.delta" | "response.refusal.delta")
        ) {
            if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                append_limited(&mut self.text, delta, MAX_RESPONSE_CHARS);
                return IngestedEvent::text(delta.to_string());
            }
            return IngestedEvent::event();
        }

        if matches!(
            event_type,
            Some("response.reasoning_summary_text.delta" | "response.reasoning_text.delta")
        ) {
            if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                append_limited(&mut self.thinking, delta, MAX_THINKING_CHARS);
                return IngestedEvent::thinking(delta.to_string());
            }
            return IngestedEvent::event();
        }

        if event_type == Some("response.output_item.added") {
            if let Some(item) = payload.get("item").and_then(Value::as_object)
                && item.get("type").and_then(Value::as_str) == Some("function_call")
            {
                let key = payload
                    .get("item_id")
                    .or_else(|| item.get("call_id"))
                    .or_else(|| payload.get("output_index"))
                    .map(Value::to_string)
                    .unwrap_or_else(|| "0".to_string());
                let accumulator = self.tool_accumulator(&key);
                if let Some(id) = item.get("call_id").and_then(Value::as_str) {
                    accumulator.id = Some(id.to_string());
                }
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    accumulator.name = name.to_string();
                }
                if let Some(arguments) = item.get("arguments").and_then(Value::as_str)
                    && !arguments.is_empty()
                {
                    accumulator.initial_input = parse_json_value(arguments);
                }
                return IngestedEvent::tool_call();
            }
            return IngestedEvent::event();
        }

        if matches!(
            event_type,
            Some(
                "response.function_call_arguments.delta" | "response.function_call_arguments.done"
            )
        ) {
            let key = payload
                .get("item_id")
                .or_else(|| payload.get("call_id"))
                .or_else(|| payload.get("output_index"))
                .map(Value::to_string)
                .unwrap_or_else(|| "0".to_string());
            let accumulator = self.tool_accumulator(&key);
            if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                append_limited(
                    &mut accumulator.arguments_text,
                    delta,
                    MAX_TOOL_ARGUMENT_CHARS,
                );
            }
            if let Some(arguments) = payload.get("arguments").and_then(Value::as_str) {
                accumulator.arguments_text = arguments.to_string();
            }
            return IngestedEvent::tool_call();
        }

        if event_type == Some("response.output_item.done") {
            if let Some(item) = payload.get("item").and_then(Value::as_object)
                && item.get("type").and_then(Value::as_str) == Some("function_call")
            {
                let key = item
                    .get("call_id")
                    .or_else(|| payload.get("item_id"))
                    .or_else(|| payload.get("output_index"))
                    .map(Value::to_string)
                    .unwrap_or_else(|| "0".to_string());
                let accumulator = self.tool_accumulator(&key);
                if let Some(id) = item.get("call_id").and_then(Value::as_str) {
                    accumulator.id = Some(id.to_string());
                }
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    accumulator.name = name.to_string();
                }
                if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                    accumulator.arguments_text = arguments.to_string();
                }
                return IngestedEvent::tool_call();
            }
            return IngestedEvent::event();
        }

        if event_type == Some("response.output_text.done") {
            if let Some(text) = payload.get("text").and_then(Value::as_str)
                && self.text.is_empty()
            {
                self.fallback_text = text.to_string();
            }
            return IngestedEvent::event();
        }

        if matches!(
            event_type,
            Some("response.completed" | "response.incomplete")
        ) {
            let response = payload.get("response").and_then(Value::as_object);
            let Some(response) = response else {
                self.finish_reason = Some(if event_type == Some("response.incomplete") {
                    FinishReason::Length
                } else {
                    FinishReason::Stop
                });
                return IngestedEvent::done();
            };

            if let Some(model) = response.get("model").and_then(Value::as_str) {
                self.model = Some(model.to_string());
            }
            if let Some(usage) = response.get("usage") {
                self.record_usage(usage);
            }

            let output = response.get("output");
            for call in tool_calls_from_openai_output(output) {
                let key = format!(
                    "output:{}",
                    call.provider_tool_call_id.as_deref().unwrap_or(&call.name)
                );
                let accumulator = self.tool_accumulator(&key);
                if let Some(id) = call.provider_tool_call_id {
                    accumulator.id = Some(id);
                }
                accumulator.name = call.name;
                if let Some(input) = call.input {
                    accumulator.initial_input = Some(input);
                }
                accumulator.arguments_text.clear();
            }

            let text = output_text_from_openai_output(output);
            append_limited(&mut self.fallback_text, &text, MAX_RESPONSE_CHARS);
            let thinking = reasoning_from_openai_output(output);
            append_limited(&mut self.fallback_thinking, &thinking, MAX_THINKING_CHARS);

            self.finish_reason = Some(if event_type == Some("response.incomplete") {
                FinishReason::Length
            } else if !self.tool_calls.is_empty() {
                FinishReason::ToolCalls
            } else {
                FinishReason::Stop
            });
            return IngestedEvent::done();
        }

        IngestedEvent::event()
    }

    fn ingest_anthropic(
        &mut self,
        payload: &Map<String, Value>,
        event_name: Option<&str>,
    ) -> IngestedEvent {
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .or(event_name)
            .unwrap_or("unknown");

        if event_type == "error" {
            let error = payload
                .get("error")
                .and_then(Value::as_object)
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str);
            self.error = Some(error.unwrap_or("Anthropic stream error").to_string());
            self.finish_reason = Some(FinishReason::Error);
            return IngestedEvent::event();
        }

        if event_type == "message_start" {
            if let Some(message) = payload.get("message").and_then(Value::as_object) {
                if let Some(model) = message.get("model").and_then(Value::as_str) {
                    self.model = Some(model.to_string());
                }
                if let Some(usage) = message.get("usage") {
                    self.record_usage(usage);
                }
            }
            return IngestedEvent::event();
        }

        if event_type == "content_block_start" {
            let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0);
            let Some(block) = payload.get("content_block").and_then(Value::as_object) else {
                return IngestedEvent::event();
            };

            match block.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    let accumulator = self.tool_accumulator(&format!("anthropic:{index}"));
                    if let Some(id) = block.get("id").and_then(Value::as_str) {
                        accumulator.id = Some(id.to_string());
                    }
                    if let Some(name) = block.get("name").and_then(Value::as_str) {
                        accumulator.name = name.to_string();
                    }
                    if let Some(input) = block.get("input") {
                        accumulator.initial_input = Some(input.clone());
                    }
                    IngestedEvent::tool_call()
                }
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str)
                        && !text.is_empty()
                    {
                        append_limited(&mut self.text, text, MAX_RESPONSE_CHARS);
                        return IngestedEvent::text(text.to_string());
                    }
                    IngestedEvent::event()
                }
                Some("thinking") => {
                    if let Some(thinking) = block.get("thinking").and_then(Value::as_str)
                        && !thinking.is_empty()
                    {
                        append_limited(&mut self.thinking, thinking, MAX_THINKING_CHARS);
                        return IngestedEvent::thinking(thinking.to_string());
                    }
                    IngestedEvent::event()
                }
                _ => IngestedEvent::event(),
            }
        } else if event_type == "content_block_delta" {
            let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0);
            let Some(delta) = payload.get("delta").and_then(Value::as_object) else {
                return IngestedEvent::event();
            };

            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    if let Some(text) = delta.get("text").and_then(Value::as_str) {
                        append_limited(&mut self.text, text, MAX_RESPONSE_CHARS);
                        return IngestedEvent::text(text.to_string());
                    }
                    IngestedEvent::event()
                }
                Some("thinking_delta") => {
                    if let Some(thinking) = delta.get("thinking").and_then(Value::as_str) {
                        append_limited(&mut self.thinking, thinking, MAX_THINKING_CHARS);
                        return IngestedEvent::thinking(thinking.to_string());
                    }
                    IngestedEvent::event()
                }
                Some("input_json_delta") => {
                    if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                        let accumulator = self.tool_accumulator(&format!("anthropic:{index}"));
                        append_limited(
                            &mut accumulator.arguments_text,
                            partial,
                            MAX_TOOL_ARGUMENT_CHARS,
                        );
                        return IngestedEvent::tool_call();
                    }
                    IngestedEvent::event()
                }
                _ => IngestedEvent::event(),
            }
        } else if event_type == "content_block_stop" {
            IngestedEvent::event()
        } else if event_type == "message_delta" {
            if let Some(delta) = payload.get("delta").and_then(Value::as_object)
                && let Some(reason) = delta.get("stop_reason").and_then(Value::as_str)
            {
                self.finish_reason = map_anthropic_finish_reason(Some(reason));
            }
            if let Some(usage) = payload.get("usage") {
                self.record_usage(usage);
            }
            IngestedEvent::usage()
        } else if event_type == "message_stop" {
            IngestedEvent::done()
        } else {
            IngestedEvent::event()
        }
    }

    fn ingest_gemini(&mut self, payload: &Map<String, Value>) -> IngestedEvent {
        if let Some(error) = payload.get("error") {
            self.error = Some(error_message(error));
            self.finish_reason = Some(FinishReason::Error);
            return IngestedEvent::event();
        }

        if let Some(model) = payload
            .get("modelVersion")
            .or_else(|| payload.get("model"))
            .and_then(Value::as_str)
        {
            self.model = Some(model.to_string());
        }
        if let Some(usage) = payload.get("usageMetadata") {
            self.record_usage(usage);
        }

        if let Some(block_reason) = payload
            .get("promptFeedback")
            .and_then(Value::as_object)
            .and_then(|feedback| feedback.get("blockReason"))
            .and_then(Value::as_str)
        {
            self.error = Some(format!("Gemini blocked the prompt: {block_reason}"));
            self.finish_reason = Some(FinishReason::ContentFilter);
            return IngestedEvent::event();
        }

        let mut text_delta = String::new();
        let mut thinking_delta = String::new();
        let mut saw_tool_call = false;

        if let Some(Value::Array(candidates)) = payload.get("candidates") {
            for (candidate_index, candidate) in candidates.iter().enumerate() {
                let Some(candidate) = candidate.as_object() else {
                    continue;
                };

                if let Some(Value::Array(parts)) = candidate
                    .get("content")
                    .and_then(Value::as_object)
                    .and_then(|content| content.get("parts"))
                {
                    for (part_index, part) in parts.iter().enumerate() {
                        let Some(part) = part.as_object() else {
                            continue;
                        };

                        if let Some(text) = part.get("text").and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                                append_limited(&mut thinking_delta, text, MAX_THINKING_CHARS);
                            } else {
                                append_limited(&mut text_delta, text, MAX_RESPONSE_CHARS);
                            }
                        }

                        if let Some(function_call) =
                            part.get("functionCall").and_then(Value::as_object)
                        {
                            let name = function_call
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if !name.is_empty() {
                                let key = format!("gemini:{candidate_index}:{part_index}:{name}");
                                let accumulator = self.tool_accumulator(&key);
                                accumulator.name = name.to_string();
                                if let Some(id) = function_call.get("id").and_then(Value::as_str) {
                                    accumulator.id = Some(id.to_string());
                                }
                                if let Some(args) = function_call.get("args") {
                                    accumulator.initial_input = Some(args.clone());
                                }
                                saw_tool_call = true;
                            }
                        }
                    }
                }

                if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
                    self.finish_reason = map_gemini_finish_reason(Some(reason));
                }
            }
        }

        append_limited(&mut self.text, &text_delta, MAX_RESPONSE_CHARS);
        append_limited(&mut self.thinking, &thinking_delta, MAX_THINKING_CHARS);

        if !text_delta.is_empty() {
            IngestedEvent::text(text_delta)
        } else if !thinking_delta.is_empty() {
            IngestedEvent::thinking(thinking_delta)
        } else if saw_tool_call {
            IngestedEvent::tool_call()
        } else if payload.contains_key("usageMetadata") {
            IngestedEvent::usage()
        } else {
            IngestedEvent::event()
        }
    }

    fn finalize_tool_calls(&mut self) -> Vec<ParsedToolCall> {
        let mut result = Vec::new();

        for accumulator in self.tool_calls.values_mut() {
            if accumulator.finalized {
                continue;
            }
            accumulator.finalized = true;
            if accumulator.name.trim().is_empty() {
                continue;
            }

            let input = parse_json_value(&accumulator.arguments_text)
                .or_else(|| accumulator.initial_input.clone());

            result.push(ParsedToolCall {
                provider_tool_call_id: accumulator.id.clone(),
                name: accumulator.name.clone(),
                input,
            });
        }

        result
    }
}

pub fn collect_non_stream_response(
    protocol: ProviderProtocol,
    path: &str,
    body: &Value,
) -> CollectedResponse {
    let Some(body) = body.as_object() else {
        return CollectedResponse::default();
    };

    match protocol {
        ProviderProtocol::Anthropic => collect_anthropic_response(body),
        ProviderProtocol::Gemini => collect_gemini_response(body),
        ProviderProtocol::Openai => {
            if path.contains("/responses")
                || body.get("object").and_then(Value::as_str) == Some("response")
            {
                collect_openai_responses_response(body)
            } else {
                collect_openai_chat_response(body)
            }
        }
    }
}

fn collect_openai_chat_response(body: &Map<String, Value>) -> CollectedResponse {
    let mut result = CollectedResponse::default();

    if let Some(error) = body.get("error") {
        result.error = Some(error_message(error));
        result.finish_reason = Some(FinishReason::Error);
        return result;
    }

    if let Some(model) = body.get("model").and_then(Value::as_str) {
        result.model = Some(model.to_string());
    }
    result.usage = normalize_usage(
        body.get("usage").unwrap_or(&Value::Null),
        Some(ProviderProtocol::Openai),
    );

    if let Some(Value::Array(choices)) = body.get("choices")
        && let Some(choice) = choices.first().and_then(Value::as_object)
    {
        let message = choice
            .get("message")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        result.text = content_part_text(message.get("content").unwrap_or(&Value::Null));
        if let Some(reasoning) = message
            .get("reasoning_content")
            .or_else(|| message.get("reasoning"))
            .and_then(Value::as_str)
        {
            result.thinking = reasoning.to_string();
        }
        result.tool_calls = tool_calls_from_openai_message(&message);
        result.finish_reason =
            map_openai_finish_reason(choice.get("finish_reason").and_then(Value::as_str));
    }

    result
}

fn collect_openai_responses_response(body: &Map<String, Value>) -> CollectedResponse {
    let mut result = CollectedResponse::default();

    if body.get("status").and_then(Value::as_str) == Some("failed") || body.contains_key("error") {
        result.error = Some(
            body.get("error")
                .map(error_message)
                .unwrap_or_else(|| "Upstream response failed".to_string()),
        );
        result.finish_reason = Some(FinishReason::Error);
    }

    if let Some(model) = body.get("model").and_then(Value::as_str) {
        result.model = Some(model.to_string());
    }
    result.usage = normalize_usage(
        body.get("usage").unwrap_or(&Value::Null),
        Some(ProviderProtocol::Openai),
    );

    let output = body.get("output");
    result.text = output_text_from_openai_output(output);
    if result.text.is_empty()
        && let Some(text) = body.get("output_text").and_then(Value::as_str)
    {
        result.text = text.to_string();
    }
    result.thinking = reasoning_from_openai_output(output);
    result.tool_calls = tool_calls_from_openai_output(output);

    result.finish_reason = if body.get("status").and_then(Value::as_str) == Some("incomplete") {
        Some(FinishReason::Length)
    } else if !result.tool_calls.is_empty() {
        Some(FinishReason::ToolCalls)
    } else if body.get("status").and_then(Value::as_str) == Some("completed") {
        Some(FinishReason::Stop)
    } else {
        None
    };

    result
}

fn collect_anthropic_response(body: &Map<String, Value>) -> CollectedResponse {
    let mut result = CollectedResponse::default();

    if body.get("type").and_then(Value::as_str) == Some("error") || body.contains_key("error") {
        result.error = Some(
            body.get("error")
                .map(error_message)
                .unwrap_or_else(|| "Anthropic request failed".to_string()),
        );
        result.finish_reason = Some(FinishReason::Error);
    }

    if let Some(model) = body.get("model").and_then(Value::as_str) {
        result.model = Some(model.to_string());
    }
    result.usage = normalize_usage(
        body.get("usage").unwrap_or(&Value::Null),
        Some(ProviderProtocol::Anthropic),
    );

    if let Some(Value::Array(content)) = body.get("content") {
        let mut text_pieces = Vec::new();
        let mut thinking_pieces = Vec::new();
        for block in content {
            let Some(block) = block.as_object() else {
                continue;
            };
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        text_pieces.push(text.to_string());
                    }
                }
                Some("thinking") => {
                    if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                        thinking_pieces.push(thinking.to_string());
                    }
                }
                _ => {}
            }
        }
        result.text = text_pieces.join("");
        result.thinking = thinking_pieces.join("");
        result.tool_calls = tool_calls_from_anthropic_content(content);
    }

    result.finish_reason =
        map_anthropic_finish_reason(body.get("stop_reason").and_then(Value::as_str));
    result
}

fn collect_gemini_response(body: &Map<String, Value>) -> CollectedResponse {
    let mut result = CollectedResponse::default();

    if let Some(error) = body.get("error") {
        result.error = Some(error_message(error));
        result.finish_reason = Some(FinishReason::Error);
    }

    if let Some(model) = body
        .get("modelVersion")
        .or_else(|| body.get("model"))
        .and_then(Value::as_str)
    {
        result.model = Some(model.to_string());
    }
    result.usage = normalize_usage(
        body.get("usageMetadata").unwrap_or(&Value::Null),
        Some(ProviderProtocol::Gemini),
    );

    if let Some(block_reason) = body
        .get("promptFeedback")
        .and_then(Value::as_object)
        .and_then(|feedback| feedback.get("blockReason"))
        .and_then(Value::as_str)
    {
        result.error = Some(format!("Gemini blocked the prompt: {block_reason}"));
        result.finish_reason = Some(FinishReason::ContentFilter);
    }

    if let Some(Value::Array(candidates)) = body.get("candidates")
        && let Some(candidate) = candidates.first().and_then(Value::as_object)
    {
        if let Some(Value::Array(parts)) = candidate
            .get("content")
            .and_then(Value::as_object)
            .and_then(|content| content.get("parts"))
        {
            let mut text_pieces = Vec::new();
            let mut thinking_pieces = Vec::new();
            for part in parts {
                let Some(part) = part.as_object() else {
                    continue;
                };
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if part.get("thought").and_then(Value::as_bool) == Some(true) {
                        thinking_pieces.push(text.to_string());
                    } else {
                        text_pieces.push(text.to_string());
                    }
                }
                if let Some(function_call) = part.get("functionCall").and_then(Value::as_object)
                    && let Some(name) = function_call.get("name").and_then(Value::as_str)
                    && !name.is_empty()
                {
                    result.tool_calls.push(ParsedToolCall {
                        provider_tool_call_id: function_call
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        name: name.to_string(),
                        input: function_call.get("args").cloned(),
                    });
                }
            }
            result.text = text_pieces.join("");
            result.thinking = thinking_pieces.join("");
        }

        result.finish_reason =
            map_gemini_finish_reason(candidate.get("finishReason").and_then(Value::as_str));
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(data: Value) -> SseEvent {
        SseEvent {
            id: None,
            event: None,
            data: data.to_string(),
            retry: None,
            raw: String::new(),
        }
    }

    #[test]
    fn collects_openai_chat_stream() {
        let mut collector =
            ProtocolCollector::new(ProviderProtocol::Openai, "/v1/chat/completions");
        let first = collector.ingest(&event(json!({
            "model": "gpt-4.1",
            "choices": [{ "delta": { "content": "Hel" } }]
        })));
        assert_eq!(first.kind, StreamChunkKind::Text);
        assert_eq!(first.delta_text.as_deref(), Some("Hel"));

        collector.ingest(&event(json!({
            "choices": [{ "delta": { "content": "lo" }, "finish_reason": "stop" }]
        })));
        collector.ingest(&event(json!({
            "usage": { "prompt_tokens": 10, "completion_tokens": 2 }
        })));

        let response = collector.snapshot();
        assert_eq!(response.text, "Hello");
        assert_eq!(response.model.as_deref(), Some("gpt-4.1"));
        assert_eq!(response.finish_reason, Some(FinishReason::Stop));
        assert_eq!(response.usage.input_tokens, 10);
        assert_eq!(response.usage.output_tokens, 2);
    }

    #[test]
    fn collects_openai_tool_calls() {
        let mut collector =
            ProtocolCollector::new(ProviderProtocol::Openai, "/v1/chat/completions");
        collector.ingest(&event(json!({
            "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "id": "call_1", "function": { "name": "read_file", "arguments": "{\"path\":" } }
            ] } }]
        })));
        collector.ingest(&event(json!({
            "choices": [{ "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": "\"src/main.rs\"}" } }
            ] } }]
        })));

        let response = collector.snapshot();
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "read_file");
        assert_eq!(
            response.tool_calls[0].input,
            Some(json!({ "path": "src/main.rs" }))
        );
    }

    #[test]
    fn collects_anthropic_stream() {
        let mut collector = ProtocolCollector::new(ProviderProtocol::Anthropic, "/v1/messages");
        collector.ingest(&SseEvent {
            id: None,
            event: Some("message_start".into()),
            data: json!({
                "type": "message_start",
                "message": { "model": "claude-sonnet-4", "usage": { "input_tokens": 7, "output_tokens": 0 } }
            })
            .to_string(),
            retry: None,
            raw: String::new(),
        });
        collector.ingest(&event(json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "Hi" }
        })));
        collector.ingest(&event(json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "output_tokens": 3 }
        })));

        let response = collector.snapshot();
        assert_eq!(response.text, "Hi");
        assert_eq!(response.model.as_deref(), Some("claude-sonnet-4"));
        assert_eq!(response.finish_reason, Some(FinishReason::Stop));
        assert_eq!(response.usage.input_tokens, 7);
        assert_eq!(response.usage.output_tokens, 3);
    }

    #[test]
    fn collects_gemini_stream() {
        let mut collector = ProtocolCollector::new(
            ProviderProtocol::Gemini,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
        );
        let first = collector.ingest(&event(json!({
            "modelVersion": "gemini-2.5-pro",
            "candidates": [{ "content": { "parts": [{ "text": "Hel" }] } }]
        })));
        assert_eq!(first.kind, StreamChunkKind::Text);
        collector.ingest(&event(json!({
            "candidates": [{ "content": { "parts": [{ "text": "lo" }] }, "finishReason": "STOP" }],
            "usageMetadata": {
                "promptTokenCount": 10,
                "candidatesTokenCount": 2,
                "cachedContentTokenCount": 4,
                "thoughtsTokenCount": 1
            }
        })));

        let response = collector.snapshot();
        assert_eq!(response.text, "Hello");
        assert_eq!(response.model.as_deref(), Some("gemini-2.5-pro"));
        assert_eq!(response.finish_reason, Some(FinishReason::Stop));
        assert_eq!(response.usage.input_tokens, 6);
        assert_eq!(response.usage.cache_read_tokens, 4);
        assert_eq!(response.usage.reasoning_tokens, 1);
    }

    #[test]
    fn collects_gemini_function_call() {
        let mut collector =
            ProtocolCollector::new(ProviderProtocol::Gemini, "/v1beta/models/x:generateContent");
        collector.ingest(&event(json!({
            "candidates": [{ "content": { "parts": [
                { "functionCall": { "name": "read_file", "args": { "path": "a.txt" } } }
            ] } }]
        })));
        let response = collector.snapshot();
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "read_file");
        assert_eq!(
            response.tool_calls[0].input,
            Some(json!({ "path": "a.txt" }))
        );
    }

    #[test]
    fn collects_non_stream_responses() {
        let chat = collect_non_stream_response(
            ProviderProtocol::Openai,
            "/v1/chat/completions",
            &json!({
                "model": "gpt-4o-mini",
                "choices": [{ "message": { "content": "Done" }, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 5, "completion_tokens": 1 }
            }),
        );
        assert_eq!(chat.text, "Done");
        assert_eq!(chat.usage.input_tokens, 5);

        let anthropic = collect_non_stream_response(
            ProviderProtocol::Anthropic,
            "/v1/messages",
            &json!({
                "model": "claude-3-5-haiku",
                "content": [{ "type": "text", "text": "Hi" }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 2, "output_tokens": 1 }
            }),
        );
        assert_eq!(anthropic.text, "Hi");
        assert_eq!(anthropic.finish_reason, Some(FinishReason::Stop));

        let gemini = collect_non_stream_response(
            ProviderProtocol::Gemini,
            "/v1beta/models/gemini-2.5-pro:generateContent",
            &json!({
                "candidates": [{ "content": { "parts": [{ "text": "Hello" }] }, "finishReason": "STOP" }],
                "usageMetadata": { "promptTokenCount": 2, "candidatesTokenCount": 1 }
            }),
        );
        assert_eq!(gemini.text, "Hello");
        assert_eq!(gemini.finish_reason, Some(FinishReason::Stop));
    }

    #[test]
    fn reports_upstream_errors() {
        let mut collector =
            ProtocolCollector::new(ProviderProtocol::Openai, "/v1/chat/completions");
        collector.ingest(&event(json!({ "error": { "message": "bad key" } })));
        let response = collector.snapshot();
        assert_eq!(response.error.as_deref(), Some("bad key"));
        assert_eq!(response.finish_reason, Some(FinishReason::Error));
    }
}
