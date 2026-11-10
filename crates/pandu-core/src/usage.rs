use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provider::ProviderProtocol;

/// Canonical token accounting.
///
/// `input_tokens` is uncached input only. Cache reads and cache writes stay
/// separate because providers charge different rates for them. Reasoning
/// tokens are a subset of `output_tokens`; they are tracked for analytics and
/// never added to the output total a second time.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
}

impl TokenUsage {
    pub const ZERO: Self = Self {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
    };

    pub fn total_input(self) -> u64 {
        self.input_tokens + self.cache_read_tokens + self.cache_write_tokens
    }

    pub fn total(self) -> u64 {
        self.total_input() + self.output_tokens
    }

    pub fn combined(self, other: Self) -> Self {
        Self {
            input_tokens: self.input_tokens + other.input_tokens,
            output_tokens: self.output_tokens + other.output_tokens,
            cache_read_tokens: self.cache_read_tokens + other.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens + other.cache_write_tokens,
            reasoning_tokens: self.reasoning_tokens + other.reasoning_tokens,
        }
    }
}

fn read_number(record: &serde_json::Map<String, Value>, key: &str) -> u64 {
    match record.get(key) {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value.trunc() as u64)
            .unwrap_or(0),
        _ => 0,
    }
}

fn read_object<'a>(
    record: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a serde_json::Map<String, Value>> {
    record.get(key).and_then(Value::as_object)
}

/// Convert provider usage payloads into the canonical shape.
///
/// OpenAI reports cached tokens inside its input count. Anthropic and Gemini
/// report cache reads separately. The shape is detected first so tokens are
/// never double counted.
pub fn normalize_usage(raw: &Value, protocol: Option<ProviderProtocol>) -> TokenUsage {
    let Some(record) = raw.as_object() else {
        return TokenUsage::ZERO;
    };

    if record.contains_key("prompt_tokens") || record.contains_key("completion_tokens") {
        let prompt = read_number(record, "prompt_tokens");
        let completion = read_number(record, "completion_tokens");
        let cached = read_object(record, "prompt_tokens_details")
            .map(|details| read_number(details, "cached_tokens"))
            .unwrap_or(0);
        let reasoning = read_object(record, "completion_tokens_details")
            .map(|details| read_number(details, "reasoning_tokens"))
            .unwrap_or(0);

        return TokenUsage {
            input_tokens: prompt.saturating_sub(cached),
            output_tokens: completion,
            cache_read_tokens: cached.min(prompt),
            cache_write_tokens: 0,
            reasoning_tokens: reasoning,
        };
    }

    if record.contains_key("input_tokens") || record.contains_key("output_tokens") {
        let input = read_number(record, "input_tokens");
        let output = read_number(record, "output_tokens");
        let cache_read = non_zero(
            read_number(record, "cache_read_input_tokens"),
            read_number(record, "cache_read_tokens"),
        );
        let cache_write = non_zero(
            read_number(record, "cache_creation_input_tokens"),
            read_number(record, "cache_write_tokens"),
        );
        let openai_cached = read_object(record, "input_tokens_details")
            .map(|details| read_number(details, "cached_tokens"))
            .unwrap_or(0);
        let reasoning = read_object(record, "output_tokens_details")
            .map(|details| read_number(details, "reasoning_tokens"))
            .unwrap_or(0);

        if protocol == Some(ProviderProtocol::Anthropic) || cache_read > 0 || cache_write > 0 {
            return TokenUsage {
                input_tokens: input,
                output_tokens: output,
                cache_read_tokens: cache_read,
                cache_write_tokens: cache_write,
                reasoning_tokens: 0,
            };
        }

        return TokenUsage {
            input_tokens: input.saturating_sub(openai_cached),
            output_tokens: output,
            cache_read_tokens: openai_cached,
            cache_write_tokens: 0,
            reasoning_tokens: reasoning,
        };
    }

    // Gemini: promptTokenCount includes cached content, so cached tokens are
    // subtracted from input and kept separately. thoughtsTokenCount is a subset
    // of the candidate count.
    if record.contains_key("promptTokenCount") || record.contains_key("candidatesTokenCount") {
        let prompt = read_number(record, "promptTokenCount");
        let candidates = read_number(record, "candidatesTokenCount");
        let cached = read_number(record, "cachedContentTokenCount");
        let thoughts = read_number(record, "thoughtsTokenCount");

        return TokenUsage {
            input_tokens: prompt.saturating_sub(cached),
            output_tokens: candidates,
            cache_read_tokens: cached.min(prompt),
            cache_write_tokens: 0,
            reasoning_tokens: thoughts,
        };
    }

    TokenUsage::ZERO
}

fn non_zero(primary: u64, fallback: u64) -> u64 {
    if primary > 0 { primary } else { fallback }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_cached_tokens_are_subtracted() {
        let usage = normalize_usage(
            &json!({
                "prompt_tokens": 1000,
                "completion_tokens": 200,
                "prompt_tokens_details": { "cached_tokens": 400 },
                "completion_tokens_details": { "reasoning_tokens": 50 }
            }),
            Some(ProviderProtocol::Openai),
        );

        assert_eq!(usage.input_tokens, 600);
        assert_eq!(usage.output_tokens, 200);
        assert_eq!(usage.cache_read_tokens, 400);
        assert_eq!(usage.reasoning_tokens, 50);
    }

    #[test]
    fn anthropic_cache_tokens_stay_separate() {
        let usage = normalize_usage(
            &json!({
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_input_tokens": 300,
                "cache_creation_input_tokens": 40
            }),
            Some(ProviderProtocol::Anthropic),
        );

        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.cache_read_tokens, 300);
        assert_eq!(usage.cache_write_tokens, 40);
    }

    #[test]
    fn gemini_cached_tokens_are_subtracted() {
        let usage = normalize_usage(
            &json!({
                "promptTokenCount": 500,
                "candidatesTokenCount": 80,
                "cachedContentTokenCount": 120,
                "thoughtsTokenCount": 30
            }),
            Some(ProviderProtocol::Gemini),
        );

        assert_eq!(usage.input_tokens, 380);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(usage.cache_read_tokens, 120);
        assert_eq!(usage.reasoning_tokens, 30);
    }

    #[test]
    fn unknown_shape_is_zero() {
        assert_eq!(
            normalize_usage(&json!({ "foo": 1 }), None),
            TokenUsage::ZERO
        );
        assert_eq!(normalize_usage(&json!("nope"), None), TokenUsage::ZERO);
    }
}
