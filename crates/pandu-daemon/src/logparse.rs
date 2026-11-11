//! Log parsers for the five parser names shipped with Pandu.
//!
//! A parser turns an agent's own session file into the same model-step shape the
//! proxy records. Parsers never touch the filesystem and never execute code;
//! they take text in and return data out. Unknown or malformed records are
//! skipped with a warning so a single bad line cannot hide the rest of a flight.

use chrono::{SecondsFormat, Utc};
use pandu_core::model::{CapturedRequest, CapturedResponse, FinishReason, StepStatus, ToolCall};
use pandu_core::provider::ProviderProtocol;
use pandu_core::text::truncate_text;
use pandu_core::usage::{TokenUsage, normalize_usage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::store::now_iso;

/// The five parser names in `pandu_core::adapter::PARSER_REGISTRY`.
pub const PARSERS: &[&str] = &[
    "claude-code-jsonl",
    "codex-jsonl",
    "gemini-cli-json",
    "generic-jsonl",
    "generic-json",
];

#[derive(Debug, Clone, Default)]
pub struct SessionHint {
    pub external_id: Option<String>,
    pub title: Option<String>,
    pub workspace_path: Option<String>,
    pub git_branch: Option<String>,
    pub model: Option<String>,
    pub agent_version: Option<String>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedToolCall {
    pub provider_tool_call_id: Option<String>,
    pub name: String,
    pub input: Option<Value>,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedToolResult {
    pub provider_tool_call_id: String,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedModelStep {
    pub provider: ProviderProtocol,
    pub model: Option<String>,
    pub prompt: Option<String>,
    pub system_prompt: Option<String>,
    pub response_text: Option<String>,
    pub thinking: Option<String>,
    pub usage: TokenUsage,
    pub finish_reason: Option<FinishReason>,
    pub status: StepStatus,
    pub error: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub tool_calls: Vec<ParsedToolCall>,
    pub metadata: Option<Value>,
    /// Stable across reparses of the same file. The watcher uses it to avoid
    /// inserting the same step twice when a log is read again.
    pub key: u64,
    /// A record is closed when the parser saw the end of the turn. Open records
    /// are held until the file has been quiet for a moment.
    pub closed: bool,
}

#[derive(Debug, Clone)]
pub enum ParsedRecord {
    Model(ParsedModelStep),
    ToolResult(ParsedToolResult),
}

#[derive(Debug, Clone, Default)]
pub struct ParsedBatch {
    pub session: SessionHint,
    pub records: Vec<ParsedRecord>,
    /// JSON files: number of new items consumed. JSONL files leave this at 0.
    pub consumed: usize,
    /// JSON files: total number of items in the file.
    pub total: usize,
    pub last_timestamp: Option<String>,
    pub warnings: Vec<String>,
}

impl ParsedBatch {
    fn warn(&mut self, message: impl Into<String>) {
        if self.warnings.len() < 20 {
            self.warnings.push(message.into());
        }
    }

    fn note_timestamp(&mut self, timestamp: &str) {
        self.last_timestamp = Some(timestamp.to_string());
    }
}

pub fn parse(parser: &str, contents: &str, skip: usize) -> Result<ParsedBatch, String> {
    match parser {
        "claude-code-jsonl" => Ok(parse_claude_code(contents)),
        "codex-jsonl" => Ok(parse_codex(contents)),
        "gemini-cli-json" => parse_gemini(contents, skip),
        "generic-jsonl" => Ok(parse_generic_jsonl(contents)),
        "generic-json" => parse_generic_json(contents, skip),
        other => Err(format!(
            "parser \"{other}\" is not registered; known parsers: {}",
            PARSERS.join(", ")
        )),
    }
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

fn parse_claude_code(contents: &str) -> ParsedBatch {
    let mut batch = ParsedBatch::default();
    let mut first_prompt: Option<String> = None;
    let mut last_prompt: Option<String> = None;
    // Claude Code can write one line per streamed content block. Merge lines
    // that share a message id so usage is counted once.
    let mut message_indexes: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();

    for (line_number, line) in contents.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                batch.warn(format!("line {}: {error}", line_number + 1));
                continue;
            }
        };

        if let Some(session_id) = value.get("sessionId").and_then(Value::as_str) {
            batch
                .session
                .external_id
                .get_or_insert_with(|| session_id.to_string());
        }
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            batch
                .session
                .workspace_path
                .get_or_insert_with(|| cwd.to_string());
        }
        if let Some(branch) = value.get("gitBranch").and_then(Value::as_str) {
            batch
                .session
                .git_branch
                .get_or_insert_with(|| branch.to_string());
        }
        if let Some(version) = value.get("version").and_then(Value::as_str) {
            batch
                .session
                .agent_version
                .get_or_insert_with(|| version.to_string());
        }

        match value.get("type").and_then(Value::as_str) {
            Some("summary") => {
                if let Some(summary) = value.get("summary").and_then(Value::as_str) {
                    batch
                        .session
                        .title
                        .get_or_insert_with(|| title_from(summary));
                }
            }
            Some("user") => {
                let message = value.get("message");
                let content = message.and_then(|message| message.get("content"));
                if let Some(text) = content.and_then(user_prompt_text) {
                    first_prompt.get_or_insert_with(|| text.clone());
                    last_prompt = Some(text);
                }
                if let Some(items) = content.and_then(Value::as_array) {
                    for item in items {
                        if item.get("type").and_then(Value::as_str) != Some("tool_result") {
                            continue;
                        }
                        let Some(tool_id) = item.get("tool_use_id").and_then(Value::as_str) else {
                            continue;
                        };
                        let is_error = item
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let output = item.get("content").cloned();
                        batch
                            .records
                            .push(ParsedRecord::ToolResult(ParsedToolResult {
                                provider_tool_call_id: tool_id.to_string(),
                                output: if is_error { None } else { output.clone() },
                                error: if is_error {
                                    output.and_then(|value| content_text(&value))
                                } else {
                                    None
                                },
                                ended_at: timestamp(value.get("timestamp")),
                            }));
                    }
                }
            }
            Some("assistant") => {
                let Some(message) = value.get("message") else {
                    continue;
                };
                let model = message
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if batch.session.model.is_none() {
                    batch.session.model = model.clone();
                }

                let mut response_text = String::new();
                let mut thinking = String::new();
                let mut tool_calls = Vec::new();
                if let Some(items) = message.get("content").and_then(Value::as_array) {
                    for item in items {
                        match item.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = item.get("text").and_then(Value::as_str) {
                                    if !response_text.is_empty() {
                                        response_text.push('\n');
                                    }
                                    response_text.push_str(text);
                                }
                            }
                            Some("thinking") => {
                                if let Some(text) = item.get("text").and_then(Value::as_str) {
                                    if !thinking.is_empty() {
                                        thinking.push('\n');
                                    }
                                    thinking.push_str(text);
                                }
                            }
                            Some("tool_use") => {
                                tool_calls.push(ParsedToolCall {
                                    provider_tool_call_id: item
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .map(str::to_string),
                                    name: item
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or("tool")
                                        .to_string(),
                                    input: item.get("input").cloned(),
                                    output: None,
                                    error: None,
                                    started_at: timestamp(value.get("timestamp"))
                                        .unwrap_or_else(now_iso),
                                    ended_at: None,
                                });
                            }
                            _ => {}
                        }
                    }
                }

                let started_at = timestamp(value.get("timestamp")).unwrap_or_else(now_iso);
                let stop_reason = message.get("stop_reason").and_then(Value::as_str);
                let message_key = message
                    .get("id")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("uuid").and_then(Value::as_str))
                    .map(str::to_string);
                let key_source = message_key
                    .clone()
                    .unwrap_or_else(|| format!("{started_at}:{response_text}"));
                if let Some(existing) = message_key
                    .as_ref()
                    .and_then(|key| message_indexes.get(key).copied())
                    && let Some(ParsedRecord::Model(existing)) = batch.records.get_mut(existing)
                {
                    if !response_text.is_empty() {
                        match &mut existing.response_text {
                            Some(text) => {
                                text.push('\n');
                                text.push_str(&response_text);
                            }
                            None => existing.response_text = Some(response_text),
                        }
                    }
                    if !thinking.is_empty() {
                        match &mut existing.thinking {
                            Some(text) => {
                                text.push('\n');
                                text.push_str(&thinking);
                            }
                            None => existing.thinking = Some(thinking),
                        }
                    }
                    existing.tool_calls.extend(tool_calls);
                    if model.is_some() {
                        existing.model = model;
                    }
                    existing.usage = normalize_usage(
                        message.get("usage").unwrap_or(&Value::Null),
                        Some(ProviderProtocol::Anthropic),
                    );
                    existing.ended_at = Some(started_at);
                    existing.closed = existing.closed || stop_reason.is_some();
                    continue;
                }

                let finish_reason = stop_reason.and_then(finish_reason);
                let status = if stop_reason == Some("error") {
                    StepStatus::Failed
                } else {
                    StepStatus::Completed
                };
                let usage = normalize_usage(
                    message.get("usage").unwrap_or(&Value::Null),
                    Some(ProviderProtocol::Anthropic),
                );
                batch.note_timestamp(&started_at);
                let record_index = batch.records.len();
                batch.records.push(ParsedRecord::Model(ParsedModelStep {
                    provider: ProviderProtocol::Anthropic,
                    model,
                    prompt: last_prompt.clone(),
                    system_prompt: None,
                    response_text: non_empty(response_text),
                    thinking: non_empty(thinking),
                    usage,
                    finish_reason,
                    status,
                    error: None,
                    started_at,
                    ended_at: None,
                    tool_calls,
                    metadata: Some(json!({ "observedFrom": "claude-code-jsonl" })),
                    key: step_key(&["claude-code", &key_source]),
                    closed: stop_reason.is_some(),
                }));
                if let Some(key) = message_key {
                    message_indexes.insert(key, record_index);
                }
            }
            _ => {}
        }
    }

    if batch.session.title.is_none() {
        batch.session.title = first_prompt.as_deref().map(title_from);
    }
    batch
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct CodexTurn {
    text: String,
    thinking: String,
    tool_calls: Vec<ParsedToolCall>,
    results: Vec<ParsedToolResult>,
    started_at: Option<String>,
}

impl CodexTurn {
    #[allow(clippy::too_many_arguments)]
    fn flush(
        &mut self,
        batch: &mut ParsedBatch,
        last_prompt: &Option<String>,
        model: &Option<String>,
        usage: TokenUsage,
        at: String,
        reason: Option<FinishReason>,
        closed: bool,
    ) {
        let has_model = !self.text.trim().is_empty()
            || !self.thinking.trim().is_empty()
            || !self.tool_calls.is_empty()
            || usage.total() > 0;
        if has_model {
            let started_at = self.started_at.take().unwrap_or_else(|| at.clone());
            let tool_ids = self
                .tool_calls
                .iter()
                .filter_map(|call| call.provider_tool_call_id.as_deref())
                .collect::<Vec<_>>()
                .join(",");
            let key = step_key(&[
                "codex",
                &started_at,
                &at,
                model.as_deref().unwrap_or_default(),
                &self.text,
                &self.thinking,
                &tool_ids,
            ]);
            batch.note_timestamp(&at);
            batch.records.push(ParsedRecord::Model(ParsedModelStep {
                provider: ProviderProtocol::Openai,
                model: model.clone(),
                prompt: last_prompt.clone(),
                system_prompt: None,
                response_text: non_empty(std::mem::take(&mut self.text)),
                thinking: non_empty(std::mem::take(&mut self.thinking)),
                usage,
                finish_reason: reason,
                status: StepStatus::Completed,
                error: None,
                started_at,
                ended_at: Some(at),
                tool_calls: std::mem::take(&mut self.tool_calls),
                metadata: Some(json!({ "observedFrom": "codex-jsonl" })),
                key,
                closed,
            }));
        }
        for result in self.results.drain(..) {
            batch.records.push(ParsedRecord::ToolResult(result));
        }
    }
}

fn parse_codex(contents: &str) -> ParsedBatch {
    let mut batch = ParsedBatch::default();
    let mut last_prompt: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut model: Option<String> = None;
    let mut turn = CodexTurn::default();

    for (line_number, line) in contents.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                batch.warn(format!("line {}: {error}", line_number + 1));
                continue;
            }
        };
        let at = timestamp(value.get("timestamp")).unwrap_or_else(now_iso);
        let payload = value.get("payload").unwrap_or(&Value::Null);
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    batch
                        .session
                        .external_id
                        .get_or_insert_with(|| id.to_string());
                }
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                    batch
                        .session
                        .workspace_path
                        .get_or_insert_with(|| cwd.to_string());
                }
                if let Some(branch) = payload
                    .get("git")
                    .and_then(|git| git.get("branch"))
                    .and_then(Value::as_str)
                {
                    batch
                        .session
                        .git_branch
                        .get_or_insert_with(|| branch.to_string());
                }
                if let Some(version) = payload.get("cli_version").and_then(Value::as_str) {
                    batch
                        .session
                        .agent_version
                        .get_or_insert_with(|| version.to_string());
                }
            }
            Some("turn_context") => {
                if let Some(value) = payload.get("model").and_then(Value::as_str) {
                    model = Some(value.to_string());
                    batch.session.model.get_or_insert_with(|| value.to_string());
                }
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                    batch
                        .session
                        .workspace_path
                        .get_or_insert_with(|| cwd.to_string());
                }
            }
            Some("response_item") => match payload.get("type").and_then(Value::as_str) {
                Some("message") => {
                    let role = payload
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let text = payload.get("content").and_then(content_text);
                    if role == "user" {
                        if let Some(text) = text {
                            first_prompt.get_or_insert_with(|| text.clone());
                            last_prompt = Some(text);
                        }
                    } else if role == "assistant"
                        && let Some(text) = text
                    {
                        if !turn.text.is_empty() {
                            turn.text.push('\n');
                        }
                        turn.text.push_str(&text);
                        turn.started_at.get_or_insert(at);
                    }
                }
                Some("function_call") => {
                    let arguments = payload.get("arguments").and_then(|value| {
                        value.as_str().map(|text| {
                            serde_json::from_str::<Value>(text)
                                .unwrap_or_else(|_| Value::String(text.to_string()))
                        })
                    });
                    turn.tool_calls.push(ParsedToolCall {
                        provider_tool_call_id: payload
                            .get("call_id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        name: payload
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string(),
                        input: arguments,
                        output: None,
                        error: None,
                        started_at: at.clone(),
                        ended_at: None,
                    });
                    turn.started_at.get_or_insert(at);
                }
                Some("function_call_output") => {
                    if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                        turn.results.push(ParsedToolResult {
                            provider_tool_call_id: call_id.to_string(),
                            output: payload.get("output").cloned(),
                            error: None,
                            ended_at: Some(at),
                        });
                    }
                }
                Some("reasoning") => {
                    if let Some(text) = payload
                        .get("summary")
                        .and_then(content_text)
                        .or_else(|| payload.get("content").and_then(content_text))
                    {
                        if !turn.thinking.is_empty() {
                            turn.thinking.push('\n');
                        }
                        turn.thinking.push_str(&text);
                    }
                }
                _ => {}
            },
            Some("event_msg") => match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    if let Some(text) = payload.get("message").and_then(Value::as_str) {
                        first_prompt.get_or_insert_with(|| text.to_string());
                        last_prompt = Some(text.to_string());
                    }
                }
                Some("token_count") => {
                    let info = payload.get("info").unwrap_or(&Value::Null);
                    let usage = info
                        .get("last_token_usage")
                        .map(codex_usage)
                        .or_else(|| {
                            info.get("total_token_usage").and_then(|total| {
                                info.get("previous_total_token_usage")
                                    .and_then(|previous| usage_delta(total, previous))
                                    .map(|delta| {
                                        normalize_usage(&delta, Some(ProviderProtocol::Openai))
                                    })
                            })
                        })
                        .unwrap_or_default();
                    let reason = if turn.tool_calls.is_empty() {
                        FinishReason::Stop
                    } else {
                        FinishReason::ToolCalls
                    };
                    turn.flush(
                        &mut batch,
                        &last_prompt,
                        &model,
                        usage,
                        at,
                        Some(reason),
                        true,
                    );
                }
                _ => {}
            },
            _ => {}
        }
    }

    turn.flush(
        &mut batch,
        &last_prompt,
        &model,
        TokenUsage::ZERO,
        now_iso(),
        None,
        false,
    );

    if batch.session.title.is_none() {
        batch.session.title = first_prompt.as_deref().map(title_from);
    }
    batch
}

fn codex_usage(value: &Value) -> TokenUsage {
    let read = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = read("input_tokens");
    let cached = read("cached_input_tokens").min(input);
    TokenUsage {
        input_tokens: input.saturating_sub(cached),
        output_tokens: read("output_tokens"),
        cache_read_tokens: cached,
        cache_write_tokens: 0,
        reasoning_tokens: read("reasoning_output_tokens"),
    }
}

/// Gemini CLI writes a compact `{ input, output, cached, thoughts }` shape in
/// some versions and the API's `promptTokenCount` shape in others.
fn gemini_usage(value: &Value) -> TokenUsage {
    if value.get("promptTokenCount").is_some() || value.get("candidatesTokenCount").is_some() {
        return normalize_usage(value, Some(ProviderProtocol::Gemini));
    }
    let read = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = read("input");
    let cached = read("cached").min(input);
    TokenUsage {
        input_tokens: input.saturating_sub(cached),
        output_tokens: read("output"),
        cache_read_tokens: cached,
        cache_write_tokens: 0,
        reasoning_tokens: read("thoughts"),
    }
}

fn usage_delta(total: &Value, previous: &Value) -> Option<Value> {
    let read = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let keys = [
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
    ];
    let mut delta = serde_json::Map::new();
    for key in keys {
        let value = read(total, key).saturating_sub(read(previous, key));
        delta.insert(key.to_string(), json!(value));
    }
    // Codex reports cached tokens separately from input; the canonical OpenAI
    // shape expects cached tokens inside prompt_tokens.
    let input = read(total, "input_tokens").saturating_sub(read(previous, "input_tokens"));
    let cached =
        read(total, "cached_input_tokens").saturating_sub(read(previous, "cached_input_tokens"));
    delta.insert("prompt_tokens".to_string(), json!(input + cached));
    delta.insert(
        "completion_tokens".to_string(),
        json!(read(total, "output_tokens").saturating_sub(read(previous, "output_tokens"))),
    );
    delta.insert(
        "prompt_tokens_details".to_string(),
        json!({ "cached_tokens": cached }),
    );
    delta.insert(
        "completion_tokens_details".to_string(),
        json!({
            "reasoning_tokens": read(total, "reasoning_output_tokens")
                .saturating_sub(read(previous, "reasoning_output_tokens"))
        }),
    );
    Some(Value::Object(delta))
}

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------

fn parse_gemini(contents: &str, skip: usize) -> Result<ParsedBatch, String> {
    let value: Value = serde_json::from_str(contents)
        .map_err(|error| format!("gemini session file is not valid JSON: {error}"))?;
    let mut batch = ParsedBatch::default();
    if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
        batch.session.external_id = Some(id.to_string());
    }
    batch.session.started_at = timestamp(value.get("startTime"));
    if let Some(updated) = timestamp(value.get("lastUpdated")) {
        batch.last_timestamp = Some(updated);
    }

    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut last_prompt: Option<String> = None;
    let mut first_prompt: Option<String> = None;

    for message in messages.iter().skip(skip) {
        let at = timestamp(message.get("timestamp")).unwrap_or_else(now_iso);
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let content = message.get("content");
        if kind == "user" {
            if let Some(text) = content.and_then(content_text) {
                first_prompt.get_or_insert_with(|| text.clone());
                last_prompt = Some(text);
            }
            continue;
        }
        if kind != "gemini" && kind != "model" && kind != "assistant" {
            continue;
        }

        let model = message
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
        if batch.session.model.is_none() {
            batch.session.model = model.clone();
        }
        let usage = gemini_usage(message.get("tokens").unwrap_or(&Value::Null));
        let tool_calls = message
            .get("toolCalls")
            .and_then(Value::as_array)
            .map(|calls| {
                calls
                    .iter()
                    .map(|call| {
                        let error = call
                            .get("status")
                            .and_then(Value::as_str)
                            .filter(|status| *status != "success")
                            .map(|status| format!("tool finished with status {status}"));
                        ParsedToolCall {
                            provider_tool_call_id: call
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            name: call
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            input: call.get("args").cloned(),
                            output: call.get("result").cloned(),
                            error,
                            started_at: timestamp(call.get("timestamp"))
                                .unwrap_or_else(|| at.clone()),
                            ended_at: timestamp(call.get("timestamp")),
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        batch.note_timestamp(&at);
        let key_source = message
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "{at}:{}",
                    content.and_then(content_text).unwrap_or_default()
                )
            });
        batch.records.push(ParsedRecord::Model(ParsedModelStep {
            provider: ProviderProtocol::Gemini,
            model,
            prompt: last_prompt.clone(),
            system_prompt: None,
            response_text: content.and_then(content_text),
            thinking: message
                .get("thoughts")
                .and_then(content_text)
                .or_else(|| message.get("thinking").and_then(content_text)),
            usage,
            finish_reason: Some(FinishReason::Stop),
            status: StepStatus::Completed,
            error: None,
            started_at: at.clone(),
            ended_at: Some(at),
            tool_calls,
            metadata: Some(json!({ "observedFrom": "gemini-cli-json" })),
            key: step_key(&["gemini", &key_source]),
            closed: true,
        }));
    }

    batch.consumed = messages.len().saturating_sub(skip);
    batch.total = messages.len();
    if batch.session.title.is_none() {
        batch.session.title = first_prompt.as_deref().map(title_from);
    }
    Ok(batch)
}

// ---------------------------------------------------------------------------
// Generic JSONL and JSON
// ---------------------------------------------------------------------------

fn parse_generic_jsonl(contents: &str) -> ParsedBatch {
    let mut batch = ParsedBatch::default();
    let mut last_prompt: Option<String> = None;
    let mut first_prompt: Option<String> = None;

    for (line_number, line) in contents.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                batch.warn(format!("line {}: {error}", line_number + 1));
                continue;
            }
        };
        let at = timestamp(
            value
                .get("timestamp")
                .or_else(|| value.get("created_at"))
                .or_else(|| value.get("created")),
        )
        .unwrap_or_else(now_iso);
        let recognized =
            generic_record(&value, &at, &mut last_prompt, &mut first_prompt, &mut batch);
        if !recognized && !looks_like_metadata(&value) {
            batch.warn(format!("line {}: no message fields found", line_number + 1));
        }
    }

    if batch.session.title.is_none() {
        batch.session.title = first_prompt.as_deref().map(title_from);
    }
    batch
}

fn parse_generic_json(contents: &str, skip: usize) -> Result<ParsedBatch, String> {
    let value: Value = serde_json::from_str(contents)
        .map_err(|error| format!("session file is not valid JSON: {error}"))?;
    let mut batch = ParsedBatch::default();
    if let Some(object) = value.as_object() {
        batch.session.external_id = object
            .get("sessionId")
            .or_else(|| object.get("session_id"))
            .or_else(|| object.get("conversationId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        batch.session.title = object.get("title").and_then(Value::as_str).map(title_from);
        batch.session.workspace_path = object
            .get("cwd")
            .or_else(|| object.get("workspace"))
            .or_else(|| object.get("workspacePath"))
            .and_then(Value::as_str)
            .map(str::to_string);
        batch.session.git_branch = object
            .get("gitBranch")
            .or_else(|| object.get("branch"))
            .and_then(Value::as_str)
            .map(str::to_string);
        batch.session.model = object
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    let items = if let Some(array) = value.as_array() {
        array.clone()
    } else {
        [
            "messages",
            "events",
            "items",
            "entries",
            "conversation",
            "history",
        ]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_array).cloned())
        .unwrap_or_else(|| vec![value.clone()])
    };

    let mut last_prompt: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    for item in items.iter().skip(skip) {
        let at = timestamp(
            item.get("timestamp")
                .or_else(|| item.get("created_at"))
                .or_else(|| item.get("created")),
        )
        .unwrap_or_else(now_iso);
        generic_record(item, &at, &mut last_prompt, &mut first_prompt, &mut batch);
    }

    batch.consumed = items.len().saturating_sub(skip);
    batch.total = items.len();
    if batch.session.title.is_none() {
        batch.session.title = first_prompt.as_deref().map(title_from);
    }
    Ok(batch)
}

fn generic_record(
    value: &Value,
    at: &str,
    last_prompt: &mut Option<String>,
    first_prompt: &mut Option<String>,
    batch: &mut ParsedBatch,
) -> bool {
    // OpenAI chat-completion wrapper.
    if let Some(choice) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    {
        if let Some(message) = choice.get("message") {
            return generic_record(message, at, last_prompt, first_prompt, batch);
        }
        return false;
    }

    // `{ "type": "assistant", "message": { ... } }` wrapper.
    if let Some(message) = value.get("message").filter(|_| {
        value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "message")
    }) {
        return generic_record(message, at, last_prompt, first_prompt, batch);
    }

    let role = value
        .get("role")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content = value
        .get("content")
        .or_else(|| value.get("text"))
        .or_else(|| value.get("message"));

    if role == "user" || role == "human" {
        if let Some(text) = content.and_then(content_text) {
            first_prompt.get_or_insert_with(|| text.clone());
            *last_prompt = Some(text);
        }
        return true;
    }

    if role == "tool" || role == "function" || role == "tool_result" {
        let Some(tool_id) = value
            .get("tool_call_id")
            .or_else(|| value.get("tool_use_id"))
            .or_else(|| value.get("call_id"))
            .and_then(Value::as_str)
        else {
            return true;
        };
        let is_error = value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || role == "tool_result" && value.get("error").is_some();
        batch
            .records
            .push(ParsedRecord::ToolResult(ParsedToolResult {
                provider_tool_call_id: tool_id.to_string(),
                output: if is_error { None } else { content.cloned() },
                error: if is_error {
                    content.and_then(content_text)
                } else {
                    None
                },
                ended_at: Some(at.to_string()),
            }));
        return true;
    }

    if !matches!(
        role.as_str(),
        "assistant" | "model" | "gemini" | "ai" | "bot" | ""
    ) {
        return false;
    }
    if role.is_empty() && content.is_none() {
        return false;
    }

    let model = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| batch.session.model.clone());
    if batch.session.model.is_none() {
        batch.session.model = model.clone();
    }
    let provider = protocol_for_model(model.as_deref());
    let usage_value = value
        .get("usage")
        .or_else(|| value.get("tokens"))
        .or_else(|| value.get("tokenUsage"))
        .unwrap_or(&Value::Null);
    let usage = if provider == ProviderProtocol::Gemini {
        gemini_usage(usage_value)
    } else {
        normalize_usage(usage_value, Some(provider))
    };
    let tool_calls = value
        .get("tool_calls")
        .or_else(|| value.get("toolCalls"))
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .map(|call| {
                    let function = call.get("function").unwrap_or(call);
                    let arguments = function.get("arguments").and_then(|value| {
                        value.as_str().map(|text| {
                            serde_json::from_str::<Value>(text)
                                .unwrap_or_else(|_| Value::String(text.to_string()))
                        })
                    });
                    ParsedToolCall {
                        provider_tool_call_id: call
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        name: function
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string(),
                        input: arguments.or_else(|| call.get("args").cloned()),
                        output: call.get("result").cloned(),
                        error: call
                            .get("status")
                            .and_then(Value::as_str)
                            .filter(|status| *status != "success" && *status != "completed")
                            .map(|status| format!("tool finished with status {status}")),
                        started_at: at.to_string(),
                        ended_at: Some(at.to_string()),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let finish_reason = value
        .get("finish_reason")
        .or_else(|| value.get("stop_reason"))
        .and_then(Value::as_str)
        .and_then(finish_reason);
    let status = if value.get("error").is_some_and(|error| !error.is_null()) {
        StepStatus::Failed
    } else {
        StepStatus::Completed
    };

    batch.note_timestamp(at);
    let key_source = value
        .get("id")
        .or_else(|| value.get("message_id"))
        .or_else(|| value.get("uuid"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "{at}:{}",
                content.and_then(content_text).unwrap_or_default()
            )
        });
    batch.records.push(ParsedRecord::Model(ParsedModelStep {
        provider,
        model,
        prompt: last_prompt.clone(),
        system_prompt: value
            .get("system")
            .or_else(|| value.get("system_prompt"))
            .and_then(content_text),
        response_text: content.and_then(content_text),
        thinking: value
            .get("thinking")
            .or_else(|| value.get("reasoning"))
            .and_then(content_text),
        usage,
        finish_reason,
        status,
        error: value.get("error").and_then(content_text),
        started_at: at.to_string(),
        ended_at: Some(at.to_string()),
        tool_calls,
        metadata: Some(json!({ "observedFrom": "generic" })),
        key: step_key(&["generic", &key_source]),
        closed: true,
    }));
    true
}

fn looks_like_metadata(value: &Value) -> bool {
    let kind = value
        .get("type")
        .or_else(|| value.get("role"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        kind.as_str(),
        "system" | "metadata" | "session" | "session_meta" | "summary" | "info"
    )
}

fn protocol_for_model(model: Option<&str>) -> ProviderProtocol {
    let model = model.unwrap_or_default().to_ascii_lowercase();
    if model.contains("claude") {
        ProviderProtocol::Anthropic
    } else if model.contains("gemini") || model.contains("gemma") {
        ProviderProtocol::Gemini
    } else {
        ProviderProtocol::Openai
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// A stable 64-bit fingerprint for a record. Reparsing the same log file must
/// produce the same key, so the watcher can skip records it already stored.
fn step_key(parts: &[&str]) -> u64 {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    let digest = hasher.finalize();
    u64::from_be_bytes(digest[..8].try_into().expect("sha256 has 32 bytes"))
}

fn non_empty(text: String) -> Option<String> {
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty(text.clone()),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(text) = content_text(item) {
                    parts.push(text);
                }
            }
            non_empty(parts.join("\n"))
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                return non_empty(text.to_string());
            }
            if let Some(text) = map.get("output_text").and_then(Value::as_str) {
                return non_empty(text.to_string());
            }
            if let Some(text) = map.get("input_text").and_then(Value::as_str) {
                return non_empty(text.to_string());
            }
            if let Some(text) = map.get("content") {
                return content_text(text);
            }
            if let Some(text) = map.get("message") {
                return content_text(text);
            }
            if let Some(text) = map.get("output") {
                return content_text(text);
            }
            None
        }
        _ => None,
    }
}

fn user_prompt_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => non_empty(text.clone()),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(text) = item.get("text").and_then(Value::as_str)
                {
                    parts.push(text.to_string());
                }
            }
            non_empty(parts.join("\n"))
        }
        _ => None,
    }
}

fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Observed flight");
    let mut title = truncate_text(line, 80);
    if title.is_empty() {
        title = "Observed flight".to_string();
    }
    title
}

fn timestamp(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(text) {
                return Some(
                    parsed
                        .with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true),
                );
            }
            if let Ok(parsed) = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f")
            {
                return Some(
                    parsed
                        .and_utc()
                        .to_rfc3339_opts(SecondsFormat::Millis, true),
                );
            }
            None
        }
        Value::Number(number) => {
            let raw = number.as_i64()?;
            let (seconds, nanos) = if raw.abs() > 10_000_000_000 {
                (
                    raw.div_euclid(1000),
                    (raw.rem_euclid(1000) * 1_000_000) as u32,
                )
            } else {
                (raw, 0)
            };
            chrono::DateTime::from_timestamp(seconds, nanos)
                .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        }
        _ => None,
    }
}

fn finish_reason(value: &str) -> Option<FinishReason> {
    match value {
        "stop" | "end_turn" | "STOP" => Some(FinishReason::Stop),
        "length" | "max_tokens" | "MAX_TOKENS" => Some(FinishReason::Length),
        "tool_calls" | "tool_use" | "function_call" => Some(FinishReason::ToolCalls),
        "content_filter" | "safety" => Some(FinishReason::ContentFilter),
        "error" => Some(FinishReason::Error),
        "cancelled" | "canceled" => Some(FinishReason::Cancelled),
        _ => None,
    }
}

/// Build the request/response pair stored for an observed model step.
pub fn observed_step_parts(
    step: &ParsedModelStep,
    external_id: Option<&str>,
) -> (CapturedRequest, CapturedResponse) {
    let path = match external_id {
        Some(id) => format!("log/{id}"),
        None => "log".to_string(),
    };
    let request = CapturedRequest {
        protocol: step.provider,
        method: "OBSERVED".to_string(),
        path,
        model: step.model.clone(),
        stream: false,
        headers: Default::default(),
        body: None,
        system_prompt: step.system_prompt.clone(),
        prompt_text: step.prompt.clone(),
        redaction_count: 0,
    };
    let response = CapturedResponse {
        status: if step.status == StepStatus::Failed {
            500
        } else {
            200
        },
        headers: Default::default(),
        finish_reason: step.finish_reason,
        text: step.response_text.clone(),
        thinking: step.thinking.clone(),
        usage: step.usage,
        ttft_ms: None,
        latency_ms: None,
        error: step.error.clone(),
    };
    (request, response)
}

/// Convert a parser tool call into the stored tool-call shape.
pub fn to_tool_call(session_id: &str, call: &ParsedToolCall) -> ToolCall {
    let status = if call.error.is_some() {
        pandu_core::model::ToolCallStatus::Failed
    } else {
        pandu_core::model::ToolCallStatus::Completed
    };
    ToolCall {
        id: pandu_core::ids::create_id(),
        session_id: session_id.to_string(),
        step_id: None,
        provider_tool_call_id: call.provider_tool_call_id.clone(),
        name: call.name.clone(),
        status,
        input: call.input.clone(),
        output: call.output.clone(),
        error: call.error.clone(),
        file_paths: pandu_core::text::extract_file_paths(call.input.as_ref()),
        started_at: call.started_at.clone(),
        ended_at: call.ended_at.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_parses_a_turn_with_a_tool_call() {
        let contents = r#"
{"type":"summary","summary":"Fix the login redirect"}
{"type":"user","message":{"role":"user","content":"Please fix the login redirect"},"sessionId":"sess-1","cwd":"/work/app","gitBranch":"main","version":"2.0.1","timestamp":"2026-01-01T10:00:00.000Z"}
{"type":"assistant","message":{"id":"msg-1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"I will inspect the router."},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"/work/app/router.ts"}}],"stop_reason":"tool_use","usage":{"input_tokens":120,"output_tokens":30,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}},"sessionId":"sess-1","cwd":"/work/app","gitBranch":"main","version":"2.0.1","timestamp":"2026-01-01T10:00:02.000Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"router contents"}]},"timestamp":"2026-01-01T10:00:03.000Z"}
{"type":"assistant","message":{"id":"msg-2","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"Fixed."}],"stop_reason":"end_turn","usage":{"input_tokens":200,"output_tokens":20}},"timestamp":"2026-01-01T10:00:04.000Z"}
"#;
        let batch = parse("claude-code-jsonl", contents, 0).unwrap();
        assert_eq!(batch.session.external_id.as_deref(), Some("sess-1"));
        assert_eq!(batch.session.workspace_path.as_deref(), Some("/work/app"));
        assert_eq!(batch.session.git_branch.as_deref(), Some("main"));
        assert_eq!(
            batch.session.title.as_deref(),
            Some("Fix the login redirect")
        );
        assert_eq!(batch.records.len(), 3);
        let ParsedRecord::Model(first) = &batch.records[0] else {
            panic!("expected a model step");
        };
        assert_eq!(
            first.prompt.as_deref(),
            Some("Please fix the login redirect")
        );
        assert_eq!(first.usage.input_tokens, 120);
        assert_eq!(first.usage.cache_read_tokens, 10);
        assert_eq!(first.tool_calls.len(), 1);
        assert_eq!(first.tool_calls[0].name, "Read");
        assert_eq!(first.finish_reason, Some(FinishReason::ToolCalls));
        let ParsedRecord::ToolResult(result) = &batch.records[1] else {
            panic!("expected a tool result");
        };
        assert_eq!(result.provider_tool_call_id, "tool-1");
        assert_eq!(result.output.as_ref().unwrap(), &json!("router contents"));
    }

    #[test]
    fn claude_code_merges_streamed_message_blocks() {
        let contents = r#"
{"type":"assistant","message":{"id":"msg-1","model":"claude-sonnet-4-5","content":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":1,"output_tokens":1}},"timestamp":"2026-01-01T10:00:00Z"}
{"type":"assistant","message":{"id":"msg-1","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":1,"output_tokens":2}},"timestamp":"2026-01-01T10:00:01Z"}
"#;
        let batch = parse("claude-code-jsonl", contents, 0).unwrap();
        assert_eq!(batch.records.len(), 1);
        let ParsedRecord::Model(step) = &batch.records[0] else {
            panic!("expected a model step");
        };
        assert_eq!(step.response_text.as_deref(), Some("Hello"));
        assert_eq!(step.tool_calls.len(), 1);
        assert_eq!(step.usage.output_tokens, 2);
    }

    #[test]
    fn codex_parses_session_meta_and_token_counts() {
        let contents = r#"
{"timestamp":"2026-01-01T10:00:00.000Z","type":"session_meta","payload":{"id":"codex-1","cwd":"/work/app","cli_version":"0.42.0","git":{"branch":"main"}}}
{"timestamp":"2026-01-01T10:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5-codex","cwd":"/work/app"}}
{"timestamp":"2026-01-01T10:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"Run the tests"}}
{"timestamp":"2026-01-01T10:00:03.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Running tests."}]}}
{"timestamp":"2026-01-01T10:00:04.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"cargo\",\"test\"]}","call_id":"call-1"}}
{"timestamp":"2026-01-01T10:00:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"all tests pass"}}
{"timestamp":"2026-01-01T10:00:06.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":40,"reasoning_output_tokens":5}}}}
"#;
        let batch = parse("codex-jsonl", contents, 0).unwrap();
        assert_eq!(batch.session.external_id.as_deref(), Some("codex-1"));
        assert_eq!(batch.session.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(batch.session.title.as_deref(), Some("Run the tests"));
        assert_eq!(batch.records.len(), 2);
        let ParsedRecord::Model(step) = &batch.records[0] else {
            panic!("expected a model step");
        };
        assert_eq!(step.response_text.as_deref(), Some("Running tests."));
        assert_eq!(step.tool_calls.len(), 1);
        assert_eq!(step.usage.input_tokens, 80);
        assert_eq!(step.usage.cache_read_tokens, 20);
        assert_eq!(step.usage.output_tokens, 40);
        assert_eq!(step.finish_reason, Some(FinishReason::ToolCalls));
        let ParsedRecord::ToolResult(result) = &batch.records[1] else {
            panic!("expected a tool result");
        };
        assert_eq!(result.provider_tool_call_id, "call-1");
    }

    #[test]
    fn gemini_parses_messages_and_resumes_from_a_cursor() {
        let contents = r#"
{"sessionId":"gem-1","startTime":"2026-01-01T10:00:00Z","messages":[
 {"id":"m1","timestamp":"2026-01-01T10:00:01Z","type":"user","content":"Explain the build"},
 {"id":"m2","timestamp":"2026-01-01T10:00:02Z","type":"gemini","content":"The build is green.","model":"gemini-2.5-pro","tokens":{"input":100,"output":20,"cached":10,"thoughts":3},"toolCalls":[{"id":"t1","name":"read_file","args":{"file_path":"/work/a.ts"},"result":[{"functionResponse":{"response":{"output":"ok"}}}],"status":"success","timestamp":"2026-01-01T10:00:02Z"}]}
]}
"#;
        let batch = parse("gemini-cli-json", contents, 0).unwrap();
        assert_eq!(batch.session.external_id.as_deref(), Some("gem-1"));
        assert_eq!(batch.session.title.as_deref(), Some("Explain the build"));
        assert_eq!(batch.consumed, 2);
        assert_eq!(batch.records.len(), 1);
        let ParsedRecord::Model(step) = &batch.records[0] else {
            panic!("expected a model step");
        };
        assert_eq!(step.model.as_deref(), Some("gemini-2.5-pro"));
        assert_eq!(step.usage.input_tokens, 90);
        assert_eq!(step.usage.cache_read_tokens, 10);
        assert_eq!(step.usage.reasoning_tokens, 3);
        assert_eq!(step.tool_calls.len(), 1);

        let resumed = parse("gemini-cli-json", contents, 2).unwrap();
        assert_eq!(resumed.consumed, 0);
        assert!(resumed.records.is_empty());
    }

    #[test]
    fn generic_jsonl_understands_openai_style_records() {
        let contents = r#"
{"role":"user","content":"Refactor the parser","timestamp":"2026-01-01T10:00:00Z"}
{"role":"assistant","model":"gpt-4.1","content":"Done.","usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":10}},"tool_calls":[{"id":"call-1","function":{"name":"shell","arguments":"{\"cmd\":\"ls\"}"}}],"timestamp":"2026-01-01T10:00:01Z"}
{"role":"tool","tool_call_id":"call-1","content":"file.txt","timestamp":"2026-01-01T10:00:02Z"}
"#;
        let batch = parse("generic-jsonl", contents, 0).unwrap();
        assert_eq!(batch.session.title.as_deref(), Some("Refactor the parser"));
        assert_eq!(batch.records.len(), 2);
        let ParsedRecord::Model(step) = &batch.records[0] else {
            panic!("expected a model step");
        };
        assert_eq!(step.model.as_deref(), Some("gpt-4.1"));
        assert_eq!(step.usage.input_tokens, 90);
        assert_eq!(step.usage.cache_read_tokens, 10);
        assert_eq!(step.tool_calls[0].name, "shell");
        assert_eq!(
            step.tool_calls[0].input.as_ref().unwrap()["cmd"],
            json!("ls")
        );
    }

    #[test]
    fn generic_json_accepts_a_messages_array() {
        let contents = r#"
{"sessionId":"gen-1","title":"Investigate flaky test","model":"claude-sonnet-4-5","messages":[
 {"role":"user","content":"Why is the test flaky?"},
 {"role":"assistant","content":"A race on the cache.","usage":{"input_tokens":10,"output_tokens":5},"timestamp":"2026-01-01T10:00:00Z"}
]}
"#;
        let batch = parse("generic-json", contents, 0).unwrap();
        assert_eq!(batch.session.external_id.as_deref(), Some("gen-1"));
        assert_eq!(
            batch.session.title.as_deref(),
            Some("Investigate flaky test")
        );
        assert_eq!(batch.consumed, 2);
        assert_eq!(batch.records.len(), 1);
        let ParsedRecord::Model(step) = &batch.records[0] else {
            panic!("expected a model step");
        };
        assert_eq!(step.provider, ProviderProtocol::Anthropic);
    }

    #[test]
    fn malformed_jsonl_lines_are_warnings_not_failures() {
        let contents = "{\"role\":\"user\",\"content\":\"Hi\"}\nnot json\n{\"role\":\"assistant\",\"content\":\"Hello\"}\n";
        let batch = parse("generic-jsonl", contents, 0).unwrap();
        assert_eq!(batch.records.len(), 1);
        assert_eq!(batch.warnings.len(), 1);
    }

    #[test]
    fn unknown_parsers_are_rejected() {
        let error = parse("run-a-shell-script", "{}", 0).unwrap_err();
        assert!(error.contains("not registered"));
    }

    #[test]
    fn timestamps_are_normalized_to_utc() {
        assert_eq!(
            timestamp(Some(&json!("2026-01-01T10:00:00+02:00"))).unwrap(),
            "2026-01-01T08:00:00.000Z"
        );
        assert_eq!(
            timestamp(Some(&json!(1_767_265_200_i64))).unwrap(),
            "2026-01-01T11:00:00.000Z"
        );
    }
}
