use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::usage::TokenUsage;

/// A price table entry. Rates are US dollars per million tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_per_mtok: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_per_mtok: Option<f64>,
    #[serde(default = "usd")]
    pub currency: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<String>,
    /// Date the row was last checked against the provider's public price list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<String>,
}

fn usd() -> String {
    "USD".to_string()
}

/// Bundled rates are estimates, not a billing authority.
///
/// They live in `models.json` at the repository root so prices can be updated
/// without touching Rust code. Each row carries a `verified` date; unknown
/// models deliberately resolve to "unknown" instead of silently costing $0. A
/// user override always wins.
pub static BUILT_IN_PRICING: LazyLock<Vec<ModelPricing>> = LazyLock::new(|| {
    let raw = include_str!("../../../models.json");
    serde_json::from_str(raw).expect("bundled models.json must be valid pricing data")
});

/// Normalize a model identifier so dated and provider-prefixed variants match.
pub fn normalize_model_id(model: &str) -> String {
    let mut value = model.trim().to_ascii_lowercase();
    if let Some(stripped) = value.strip_prefix("models/") {
        value = stripped.to_string();
    }

    if let Some((prefix, rest)) = value.split_once('/') {
        let prefix_ok = !prefix.is_empty()
            && prefix
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_alphanumeric())
            && prefix
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
        if prefix_ok {
            value = rest.to_string();
        }
    }

    if let Some(stripped) = value.strip_suffix(":latest") {
        value = stripped.to_string();
    }

    if let Some(stripped) = strip_date_suffix(&value) {
        value = stripped.to_string();
    }

    value
}

fn strip_date_suffix(value: &str) -> Option<&str> {
    if value.len() > 11 {
        let candidate = value.get(value.len() - 10..)?;
        let bytes = candidate.as_bytes();
        let looks_like_date = bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());
        if looks_like_date && value.as_bytes()[value.len() - 11] == b'-' {
            return Some(&value[..value.len() - 11]);
        }
    }

    if value.len() > 9 {
        let candidate = value.get(value.len() - 8..)?;
        if candidate.bytes().all(|byte| byte.is_ascii_digit())
            && value.as_bytes()[value.len() - 9] == b'-'
        {
            return Some(&value[..value.len() - 9]);
        }
    }

    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingMissReason {
    ModelNotFound,
    AmbiguousProvider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PricingSource {
    Override,
    Builtin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingResolution {
    pub found: bool,
    pub normalized_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PricingSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PricingMissReason>,
}

pub fn resolve_model_pricing(
    model: &str,
    provider: Option<&str>,
    overrides: &[ModelPricing],
) -> PricingResolution {
    let normalized_model = normalize_model_id(model);
    let provider = provider
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);

    let override_matches = find_within(overrides, &normalized_model, provider.as_deref());
    if override_matches.len() == 1 {
        return PricingResolution {
            found: true,
            normalized_model,
            pricing: override_matches.first().copied().cloned(),
            source: Some(PricingSource::Override),
            reason: None,
        };
    }
    if override_matches.len() > 1 {
        return PricingResolution {
            found: false,
            normalized_model,
            pricing: None,
            source: None,
            reason: Some(PricingMissReason::AmbiguousProvider),
        };
    }

    let built_in_matches = find_within(&BUILT_IN_PRICING, &normalized_model, provider.as_deref());
    if built_in_matches.len() == 1 {
        return PricingResolution {
            found: true,
            normalized_model,
            pricing: built_in_matches.first().copied().cloned(),
            source: Some(PricingSource::Builtin),
            reason: None,
        };
    }
    if built_in_matches.len() > 1 {
        return PricingResolution {
            found: false,
            normalized_model,
            pricing: None,
            source: None,
            reason: Some(PricingMissReason::AmbiguousProvider),
        };
    }

    PricingResolution {
        found: false,
        normalized_model,
        pricing: None,
        source: None,
        reason: Some(PricingMissReason::ModelNotFound),
    }
}

fn find_within<'a>(
    entries: &'a [ModelPricing],
    normalized_model: &str,
    provider: Option<&str>,
) -> Vec<&'a ModelPricing> {
    entries
        .iter()
        .filter(|entry| {
            if provider.is_some_and(|wanted| entry.provider != wanted) {
                return false;
            }
            normalize_model_id(&entry.model) == normalized_model
                || entry
                    .aliases
                    .iter()
                    .any(|alias| normalize_model_id(alias) == normalized_model)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdown {
    pub input_usd: f64,
    pub output_usd: f64,
    pub cache_read_usd: f64,
    pub cache_write_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub known: bool,
    pub normalized_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<CostBreakdown>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PricingMissReason>,
}

pub fn compute_cost_from_price(usage: TokenUsage, pricing: &ModelPricing) -> CostEstimate {
    let cache_read_rate = pricing
        .cache_read_per_mtok
        .unwrap_or(pricing.input_per_mtok);
    let cache_write_rate = pricing
        .cache_write_per_mtok
        .unwrap_or(pricing.input_per_mtok);

    let breakdown = CostBreakdown {
        input_usd: per_million(usage.input_tokens, pricing.input_per_mtok),
        output_usd: per_million(usage.output_tokens, pricing.output_per_mtok),
        cache_read_usd: per_million(usage.cache_read_tokens, cache_read_rate),
        cache_write_usd: per_million(usage.cache_write_tokens, cache_write_rate),
    };
    let usd = breakdown.input_usd
        + breakdown.output_usd
        + breakdown.cache_read_usd
        + breakdown.cache_write_usd;

    CostEstimate {
        known: true,
        normalized_model: normalize_model_id(&pricing.model),
        usd: Some(round_usd(usd)),
        breakdown: Some(breakdown),
        pricing: Some(pricing.clone()),
        reason: None,
    }
}

pub fn estimate_usage_cost(
    usage: TokenUsage,
    model: &str,
    provider: Option<&str>,
    overrides: &[ModelPricing],
) -> CostEstimate {
    let resolution = resolve_model_pricing(model, provider, overrides);
    match resolution.pricing {
        Some(pricing) if resolution.found => compute_cost_from_price(usage, &pricing),
        _ => CostEstimate {
            known: false,
            normalized_model: resolution.normalized_model,
            usd: None,
            breakdown: None,
            pricing: None,
            reason: resolution.reason,
        },
    }
}

fn per_million(tokens: u64, rate: f64) -> f64 {
    (tokens as f64 / 1_000_000.0) * rate
}

pub fn round_usd(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

pub fn format_usd(value: Option<f64>) -> String {
    let Some(value) = value else {
        return "Unpriced".to_string();
    };
    if value == 0.0 {
        return "$0.00".to_string();
    }
    if value < 0.01 {
        return format!("${value:.4}");
    }
    if value < 1.0 {
        return format!("${value:.3}");
    }
    format!("${value:.2}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage() -> TokenUsage {
        TokenUsage {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
        }
    }

    #[test]
    fn normalizes_dated_and_prefixed_models() {
        assert_eq!(normalize_model_id("openai/gpt-4.1-2025-04-14"), "gpt-4.1");
        assert_eq!(
            normalize_model_id("models/gemini-2.5-pro"),
            "gemini-2.5-pro"
        );
        assert_eq!(normalize_model_id("gpt-4o-20240806"), "gpt-4o");
        assert_eq!(
            normalize_model_id("claude-sonnet-4:latest"),
            "claude-sonnet-4"
        );
    }

    #[test]
    fn computes_known_cost() {
        let cost = estimate_usage_cost(usage(), "gpt-4.1", Some("openai"), &[]);
        assert!(cost.known);
        assert_eq!(cost.usd, Some(10.0));
        assert_eq!(cost.breakdown.unwrap().input_usd, 2.0);
    }

    #[test]
    fn unknown_models_are_unpriced_not_zero() {
        let cost = estimate_usage_cost(usage(), "mystery-model", Some("openai"), &[]);
        assert!(!cost.known);
        assert_eq!(cost.usd, None);
        assert_eq!(cost.reason, Some(PricingMissReason::ModelNotFound));
        assert_eq!(format_usd(cost.usd), "Unpriced");
    }

    #[test]
    fn overrides_win() {
        let override_price = ModelPricing {
            provider: "openai".into(),
            model: "gpt-4.1".into(),
            display_name: None,
            aliases: vec![],
            input_per_mtok: 1.0,
            output_per_mtok: 1.0,
            cache_read_per_mtok: None,
            cache_write_per_mtok: None,
            currency: usd(),
            source: "test".into(),
            reviewed_at: None,
            verified: None,
        };
        let cost = estimate_usage_cost(usage(), "gpt-4.1", Some("openai"), &[override_price]);
        assert!(cost.known);
        assert_eq!(cost.usd, Some(2.0));
        assert_eq!(cost.pricing.unwrap().source, "test");
    }

    #[test]
    fn formats_money() {
        assert_eq!(format_usd(None), "Unpriced");
        assert_eq!(format_usd(Some(0.0)), "$0.00");
        assert_eq!(format_usd(Some(0.00123)), "$0.0012");
        assert_eq!(format_usd(Some(0.123)), "$0.123");
        assert_eq!(format_usd(Some(1.234)), "$1.23");
    }
}
