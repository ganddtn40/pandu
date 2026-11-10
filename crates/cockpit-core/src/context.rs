use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::usage::TokenUsage;

/// Default share of the model window that triggers `context.high`.
pub const DEFAULT_CONTEXT_THRESHOLD: f64 = 0.8;
/// A compaction must remove at least this many tokens to count as a sudden drop.
pub const COMPACTION_MIN_DROP_TOKENS: u64 = 2_000;
/// A compaction must also remove at least 30% of the previous context.
pub const COMPACTION_DROP_RATIO: f64 = 0.7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSource {
    /// The provider reported prompt usage for this exact request.
    Provider,
    /// Cockpit estimated the prompt from the recorded request body.
    Estimated,
}

/// Approximate split of the prompt. The provider only reports a total, so this
/// split always comes from the request body, even when the total is reported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    pub system: u64,
    pub tools: u64,
    pub history: u64,
    pub files: u64,
    pub other: u64,
}

impl ContextBreakdown {
    pub fn total(&self) -> u64 {
        self.system + self.tools + self.history + self.files + self.other
    }
}

/// Per-request context pressure, stored in step metadata and shown in the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMeter {
    pub model: String,
    pub tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<u64>,
    /// 0-100, rounded to one decimal. `None` when the window is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    pub source: ContextSource,
    pub breakdown: ContextBreakdown,
    /// True when this request removed at least 30% and 2,000 tokens versus the
    /// previous step in the same flight.
    pub compacted: bool,
    /// Fraction in `0.0..=1.0`, e.g. `0.8` for the default 80% threshold.
    pub threshold: f64,
    pub high: bool,
}

impl ContextMeter {
    pub fn estimated_only(&self) -> bool {
        self.source == ContextSource::Estimated
    }
}

/// Build one meter for a request.
///
/// Provider usage wins when it is non-zero; otherwise Cockpit estimates the
/// prompt from the recorded request body. The breakdown is always estimated
/// because providers only report a single prompt total.
pub fn build_context_meter(
    model: &str,
    request_body: Option<&Value>,
    provider_usage: Option<TokenUsage>,
    window: Option<u64>,
    previous_tokens: Option<u64>,
    threshold: f64,
) -> ContextMeter {
    let breakdown = request_body
        .map(estimate_request_context)
        .unwrap_or_default();
    let reported = provider_usage
        .map(TokenUsage::total_input)
        .filter(|tokens| *tokens > 0);
    let (tokens, source) = match reported {
        Some(tokens) => (tokens, ContextSource::Provider),
        None => (breakdown.total(), ContextSource::Estimated),
    };
    let threshold = normalize_threshold(threshold);
    let percent = window
        .filter(|window| *window > 0)
        .map(|window| round_percent(tokens as f64 / window as f64 * 100.0));
    let compacted = previous_tokens.is_some_and(|previous| is_compaction(previous, tokens));

    ContextMeter {
        model: model.to_string(),
        tokens,
        window,
        percent,
        source,
        breakdown,
        compacted,
        threshold,
        high: percent.is_some_and(|percent| percent >= threshold * 100.0),
    }
}

fn is_compaction(previous: u64, current: u64) -> bool {
    previous >= COMPACTION_MIN_DROP_TOKENS
        && previous.saturating_sub(current) >= COMPACTION_MIN_DROP_TOKENS
        && (current as f64) <= previous as f64 * COMPACTION_DROP_RATIO
}

fn round_percent(value: f64) -> f64 {
    (value.clamp(0.0, 100.0) * 10.0).round() / 10.0
}

fn normalize_threshold(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.01, 1.0)
    } else {
        DEFAULT_CONTEXT_THRESHOLD
    }
}

/// Accept either a fraction (`0.8`) or a percentage (`80`, `80%`).
pub fn parse_context_threshold(raw: Option<&str>) -> f64 {
    let Some(raw) = raw else {
        return DEFAULT_CONTEXT_THRESHOLD;
    };
    let cleaned = raw.trim().trim_end_matches('%').trim();
    let Ok(value) = cleaned.parse::<f64>() else {
        return DEFAULT_CONTEXT_THRESHOLD;
    };
    if !value.is_finite() || value <= 0.0 {
        return DEFAULT_CONTEXT_THRESHOLD;
    }
    normalize_threshold(if value > 1.0 { value / 100.0 } else { value })
}

/// Estimate prompt tokens from a provider request body.
pub fn estimate_request_context(body: &Value) -> ContextBreakdown {
    let mut breakdown = ContextBreakdown::default();

    if let Some(system) = body.get("system").or_else(|| body.get("instructions")) {
        breakdown.system += estimate_json(system);
    }
    if let Some(system) = body
        .get("system_instruction")
        .or_else(|| body.get("systemInstruction"))
    {
        breakdown.system += estimate_json(system);
    }
    if let Some(tools) = body.get("tools") {
        breakdown.tools += estimate_json(tools);
    }

    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            add_message(message, &mut breakdown);
        }
    }

    match body.get("input") {
        Some(Value::String(text)) => breakdown.history += estimate_text_tokens(text),
        Some(Value::Array(items)) => {
            for item in items {
                if item.is_object() {
                    add_message(item, &mut breakdown);
                } else if let Some(text) = item.as_str() {
                    breakdown.history += estimate_text_tokens(text);
                }
            }
        }
        _ => {}
    }

    if let Some(prompt) = body.get("prompt").and_then(Value::as_str) {
        breakdown.history += estimate_text_tokens(prompt);
    }

    if let Some(contents) = body.get("contents").and_then(Value::as_array) {
        for content in contents {
            add_message(content, &mut breakdown);
        }
    }

    breakdown
}

fn add_message(message: &Value, breakdown: &mut ContextBreakdown) {
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let is_system = matches!(role, "system" | "developer");
    let mut history = 4;
    let mut files = 0;

    if let Some(content) = message.get("content") {
        collect_content(content, &mut history, &mut files);
    }
    if let Some(parts) = message.get("parts") {
        collect_content(parts, &mut history, &mut files);
    }
    if let Some(tool_calls) = message.get("tool_calls") {
        history += estimate_json(tool_calls);
    }
    if let Some(function_call) = message.get("function_call") {
        history += estimate_json(function_call);
    }

    if is_system {
        breakdown.system += history + files;
    } else {
        breakdown.history += history;
        breakdown.files += files;
    }
}

fn collect_content(content: &Value, history: &mut u64, files: &mut u64) {
    match content {
        Value::String(text) => add_text(text, history, files),
        Value::Array(blocks) => {
            for block in blocks {
                collect_block(block, history, files);
            }
        }
        Value::Object(_) => collect_block(content, history, files),
        _ => {}
    }
}

fn collect_block(block: &Value, history: &mut u64, files: &mut u64) {
    if let Some(text) = block.as_str() {
        add_text(text, history, files);
        return;
    }
    let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "text" | "input_text" | "output_text" => {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                add_text(text, history, files);
            }
        }
        "image" | "image_url" | "input_image" => {
            // A typical vision tile is roughly 85 tokens. Exact dimensions are
            // provider-specific, so keep a conservative fixed estimate.
            *files += 85;
        }
        "file" | "document" | "input_file" => {
            *files += estimate_json(block);
        }
        "tool_result" | "tool_use" => {
            if let Some(content) = block.get("content") {
                collect_content(content, history, files);
            } else if let Some(input) = block.get("input") {
                *history += estimate_json(input);
            } else {
                *history += estimate_json(block);
            }
        }
        _ => {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                add_text(text, history, files);
            } else {
                *history += estimate_json(block);
            }
        }
    }
}

fn add_text(text: &str, history: &mut u64, files: &mut u64) {
    let tokens = estimate_text_tokens(text);
    if looks_like_file_content(text) {
        *files += tokens;
    } else {
        *history += tokens;
    }
}

fn looks_like_file_content(text: &str) -> bool {
    text.contains("<file")
        || text.contains("[file:")
        || text.starts_with("File: ")
        || text.contains("diff --git ")
        || text.contains("--- a/")
        || text.contains("+++ b/")
}

fn estimate_json(value: &Value) -> u64 {
    match value {
        Value::String(text) => estimate_text_tokens(text),
        Value::Null => 0,
        other => estimate_text_tokens(&other.to_string()),
    }
}

/// Rough tokenizer approximation. English prose averages ~3.6 characters per
/// token; code and JSON are denser. The estimator is intentionally simple and
/// deterministic so tests can bound its error without a tokenizer dependency.
pub fn estimate_text_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let chars = text.chars().count() as f64;
    (chars / 3.6).ceil() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn prose(words: usize) -> String {
        let sentence = "The quick brown fox jumps over the lazy dog while the careful engineer reviews the patch. ";
        sentence.repeat(words)
    }

    #[test]
    fn prose_estimate_stays_within_bounds() {
        let text = prose(20);
        let estimate = estimate_text_tokens(&text);
        // ~1,940 characters of English prose is roughly 430-540 tokens.
        assert!((380..=600).contains(&estimate), "estimate was {estimate}");
    }

    #[test]
    fn code_estimate_stays_within_bounds() {
        let code =
            "fn main() {\n    let value = compute(42);\n    println!(\"{value}\");\n}\n".repeat(20);
        let estimate = estimate_text_tokens(&code);
        let chars = code.chars().count();
        assert!(estimate >= (chars / 5) as u64, "estimate was {estimate}");
        assert!(estimate <= (chars / 2) as u64, "estimate was {estimate}");
    }

    #[test]
    fn splits_system_tools_history_and_files() {
        let body = json!({
            "system": "You are a careful reviewer. ".repeat(30),
            "tools": [{
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file from disk",
                    "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
                }
            }],
            "messages": [
                { "role": "user", "content": "Please review this patch." },
                { "role": "assistant", "content": "Here is the file.", "tool_calls": [{
                    "id": "call_1", "type": "function",
                    "function": { "name": "read_file", "arguments": "{\"path\":\"src/main.rs\"}" }
                }]},
                { "role": "user", "content": "<file path=\"src/main.rs\">fn main() {}</file>" }
            ]
        });

        let breakdown = estimate_request_context(&body);
        assert!(breakdown.system > 100);
        assert!(breakdown.tools > 0);
        assert!(breakdown.history > 0);
        assert!(breakdown.files > 0);
        assert_eq!(breakdown.other, 0);
    }

    #[test]
    fn provider_usage_wins_over_the_estimate() {
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        let usage = TokenUsage {
            input_tokens: 900,
            cache_read_tokens: 100,
            ..TokenUsage::ZERO
        };
        let meter = build_context_meter("gpt-5.5", Some(&body), Some(usage), Some(1000), None, 0.8);
        assert_eq!(meter.source, ContextSource::Provider);
        assert_eq!(meter.tokens, 1000);
        assert_eq!(meter.percent, Some(100.0));
        assert!(meter.high);
        assert!(meter.breakdown.history > 0);
    }

    #[test]
    fn estimate_is_used_when_usage_is_missing_or_zero() {
        let body = json!({ "messages": [{ "role": "user", "content": "hello there" }] });
        let meter = build_context_meter("gpt-5.5", Some(&body), None, Some(1_000_000), None, 0.8);
        assert_eq!(meter.source, ContextSource::Estimated);
        assert!(meter.tokens > 0);
        assert!(!meter.high);

        let zero = build_context_meter(
            "gpt-5.5",
            Some(&body),
            Some(TokenUsage::ZERO),
            None,
            None,
            0.8,
        );
        assert_eq!(zero.source, ContextSource::Estimated);
        assert_eq!(zero.percent, None);
        assert!(!zero.high);
    }

    #[test]
    fn compaction_needs_a_large_sudden_drop() {
        let body = json!({ "messages": [{ "role": "user", "content": "hello" }] });
        let usage = |tokens| TokenUsage {
            input_tokens: tokens,
            ..TokenUsage::ZERO
        };

        let compacted = build_context_meter(
            "m",
            Some(&body),
            Some(usage(5_000)),
            Some(100_000),
            Some(10_000),
            0.8,
        );
        assert!(compacted.compacted);

        let small = build_context_meter(
            "m",
            Some(&body),
            Some(usage(9_000)),
            Some(100_000),
            Some(10_000),
            0.8,
        );
        assert!(!small.compacted);

        let first = build_context_meter(
            "m",
            Some(&body),
            Some(usage(10_000)),
            Some(100_000),
            None,
            0.8,
        );
        assert!(!first.compacted);
    }

    #[test]
    fn threshold_accepts_fractions_and_percentages() {
        assert_eq!(parse_context_threshold(None), 0.8);
        assert_eq!(parse_context_threshold(Some("0.75")), 0.75);
        assert_eq!(parse_context_threshold(Some("75")), 0.75);
        assert_eq!(parse_context_threshold(Some("75%")), 0.75);
        assert_eq!(parse_context_threshold(Some("nonsense")), 0.8);
        assert_eq!(parse_context_threshold(Some("0")), 0.8);
    }

    #[test]
    fn percent_is_clamped_and_rounded() {
        let body = json!({});
        let usage = TokenUsage {
            input_tokens: 1_000_000,
            ..TokenUsage::ZERO
        };
        let meter = build_context_meter("m", Some(&body), Some(usage), Some(200_000), None, 0.8);
        assert_eq!(meter.percent, Some(100.0));
        assert!(meter.high);
    }

    #[test]
    fn empty_body_estimates_zero() {
        let breakdown = estimate_request_context(&json!({}));
        assert_eq!(breakdown.total(), 0);
        let meter = build_context_meter("m", None, None, Some(1_000), None, 0.8);
        assert_eq!(meter.tokens, 0);
        assert_eq!(meter.percent, Some(0.0));
        assert!(!meter.high);
    }
}
