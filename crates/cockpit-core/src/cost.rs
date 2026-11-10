use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::provider::ProviderProtocol;
use crate::usage::TokenUsage;

/// How a model exposes its reasoning effort control.
///
/// The parameter names are stored as dotted body paths because every provider
/// spells this differently. `parameter` is the OpenAI-compatible form,
/// `anthropic_parameter` the Messages API form, and `responses_parameter` the
/// OpenAI Responses API form.
///
/// A row declares either discrete `levels` or a numeric `budget`. The two are
/// mutually exclusive: Gemini 2.5 uses `thinkingBudget`, while Gemini 3 and 4
/// use `thinkingLevel`. Keeping them apart prevents a cross-generation switch
/// from sending both fields in one request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortControl {
    pub parameter: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_parameter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub responses_parameter: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub levels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<BudgetControl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// Numeric thinking-token control used by the Gemini 2.5 generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetControl {
    pub min: u64,
    pub max: u64,
    /// Whether `0` disables thinking.
    #[serde(default)]
    pub can_disable: bool,
    /// Whether `-1` (dynamic thinking) is accepted.
    #[serde(default)]
    pub dynamic: bool,
    #[serde(default = "default_budget_step")]
    pub step: u64,
}

fn default_budget_step() -> u64 {
    1024
}

impl BudgetControl {
    /// Normalize a user-supplied budget to its canonical form.
    ///
    /// `dynamic` and `-1` both become `dynamic`; `off` and `none` both become
    /// `0` when the model can disable thinking. Everything else must parse as
    /// an integer inside the verified range.
    pub fn normalize(&self, value: &str) -> Option<String> {
        let value = value.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        match value.as_str() {
            "dynamic" | "-1" if self.dynamic => return Some("dynamic".to_string()),
            "off" | "none" if self.can_disable => return Some("0".to_string()),
            _ => {}
        }
        let parsed = value.parse::<u64>().ok()?;
        if parsed == 0 {
            return self.can_disable.then(|| "0".to_string());
        }
        (parsed >= self.min && parsed <= self.max).then(|| parsed.to_string())
    }

    /// Human-readable allowed values, used in validation messages.
    pub fn describe(&self) -> String {
        let mut values = vec![format!("{}–{} tokens", self.min, self.max)];
        if self.dynamic {
            values.push("dynamic".to_string());
        }
        if self.can_disable {
            values.push("off".to_string());
        }
        values.join(", ")
    }
}

impl EffortControl {
    /// The exact body path for the request protocol and endpoint.
    pub fn parameter_for(&self, protocol: ProviderProtocol, path: &str) -> &str {
        match protocol {
            ProviderProtocol::Anthropic => self
                .anthropic_parameter
                .as_deref()
                .unwrap_or(self.parameter.as_str()),
            ProviderProtocol::Openai if path.contains("/responses") => self
                .responses_parameter
                .as_deref()
                .unwrap_or(self.parameter.as_str()),
            _ => self.parameter.as_str(),
        }
    }

    pub fn is_budget(&self) -> bool {
        self.budget.is_some()
    }

    /// Normalize one effort value for this control, or `None` if unsupported.
    pub fn normalize(&self, value: &str) -> Option<String> {
        let value = value.trim().to_ascii_lowercase();
        if let Some(budget) = &self.budget {
            return budget.normalize(&value);
        }
        self.levels
            .iter()
            .find(|allowed| allowed.eq_ignore_ascii_case(&value))
            .cloned()
    }

    pub fn supports(&self, level: &str) -> bool {
        self.normalize(level).is_some()
    }
}

/// A model row. Rates are US dollars per million tokens.
///
/// Prices are optional on purpose: an unverified row must stay explicitly
/// unknown rather than silently costing $0.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<EffortControl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_per_mtok: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_per_mtok: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_per_mtok: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_per_mtok: Option<f64>,
    #[serde(default = "usd")]
    pub currency: String,
    pub source: String,
    /// Date the row was checked against the provider's public documentation.
    /// `None` means the row is retained from an older snapshot and is not a
    /// fresh verification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub deprecated: bool,
}

fn usd() -> String {
    "USD".to_string()
}

/// Bundled rates are estimates, not a billing authority.
///
/// They live in `models.json` at the repository root so prices can be updated
/// without touching Rust code. Each row carries a `verifiedOn` date and a
/// source URL; unknown models deliberately resolve to "unknown" instead of
/// silently costing $0. A user override always wins.
pub static BUILT_IN_PRICING: LazyLock<Vec<ModelPricing>> = LazyLock::new(|| {
    let raw = include_str!("../../../models.json");
    serde_json::from_str(raw).expect("bundled models.json must be valid pricing data")
});

/// Normalize a provider name so `google` and `gemini` resolve to the same rows.
pub fn canonical_provider(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "google" | "gemini" => "google".to_string(),
        other => other.to_string(),
    }
}

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
    PriceUnknown,
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
        .map(canonical_provider);

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

/// Resolve one bundled row. Used for override validation and context windows.
pub fn find_builtin_model(model: &str, provider: Option<&str>) -> Option<&'static ModelPricing> {
    let normalized_model = normalize_model_id(model);
    let provider = provider.map(canonical_provider);
    let matches = find_within(&BUILT_IN_PRICING, &normalized_model, provider.as_deref());
    (matches.len() == 1).then(|| matches[0])
}

fn find_within<'a>(
    entries: &'a [ModelPricing],
    normalized_model: &str,
    provider: Option<&str>,
) -> Vec<&'a ModelPricing> {
    entries
        .iter()
        .filter(|entry| {
            if provider.is_some_and(|wanted| canonical_provider(&entry.provider) != wanted) {
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
    let (Some(input_rate), Some(output_rate)) = (pricing.input_per_mtok, pricing.output_per_mtok)
    else {
        return CostEstimate {
            known: false,
            normalized_model: normalize_model_id(&pricing.model),
            usd: None,
            breakdown: None,
            pricing: Some(pricing.clone()),
            reason: Some(PricingMissReason::PriceUnknown),
        };
    };

    let cache_read_rate = pricing.cache_read_per_mtok.unwrap_or(input_rate);
    let cache_write_rate = pricing.cache_write_per_mtok.unwrap_or(input_rate);

    let breakdown = CostBreakdown {
        input_usd: per_million(usage.input_tokens, input_rate),
        output_usd: per_million(usage.output_tokens, output_rate),
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

    fn override_row(input: Option<f64>, output: Option<f64>) -> ModelPricing {
        ModelPricing {
            provider: "openai".into(),
            model: "gpt-4.1".into(),
            display_name: None,
            aliases: vec![],
            context_window: Some(1_000_000),
            max_output: Some(32_768),
            effort: None,
            input_per_mtok: input,
            output_per_mtok: output,
            cache_read_per_mtok: None,
            cache_write_per_mtok: None,
            currency: usd(),
            source: "test".into(),
            verified_on: None,
            note: None,
            deprecated: false,
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
    fn unknown_prices_are_unpriced_not_zero() {
        let cost = estimate_usage_cost(
            usage(),
            "gpt-4.1",
            Some("openai"),
            &[override_row(None, None)],
        );
        assert!(!cost.known);
        assert_eq!(cost.usd, None);
        assert_eq!(cost.reason, Some(PricingMissReason::PriceUnknown));
        assert_eq!(cost.pricing.unwrap().source, "test");
    }

    #[test]
    fn overrides_win() {
        let override_price = override_row(Some(1.0), Some(1.0));
        let cost = estimate_usage_cost(usage(), "gpt-4.1", Some("openai"), &[override_price]);
        assert!(cost.known);
        assert_eq!(cost.usd, Some(2.0));
        assert_eq!(cost.pricing.unwrap().source, "test");
    }

    #[test]
    fn google_and_gemini_resolve_to_the_same_row() {
        let gemini = estimate_usage_cost(usage(), "gemini-2.5-pro", Some("gemini"), &[]);
        let google = estimate_usage_cost(usage(), "gemini-2.5-pro", Some("google"), &[]);
        assert!(gemini.known);
        assert_eq!(gemini.usd, google.usd);
    }

    #[test]
    fn effort_parameter_follows_the_protocol() {
        let effort = EffortControl {
            parameter: "reasoning_effort".into(),
            anthropic_parameter: Some("output_config.effort".into()),
            responses_parameter: Some("reasoning.effort".into()),
            levels: vec!["low".into(), "high".into()],
            budget: None,
            default: Some("high".into()),
        };
        assert_eq!(
            effort.parameter_for(ProviderProtocol::Openai, "/v1/chat/completions"),
            "reasoning_effort"
        );
        assert_eq!(
            effort.parameter_for(ProviderProtocol::Openai, "/v1/responses"),
            "reasoning.effort"
        );
        assert_eq!(
            effort.parameter_for(ProviderProtocol::Anthropic, "/v1/messages"),
            "output_config.effort"
        );
        assert!(effort.supports("high"));
        assert!(!effort.supports("medium"));
    }

    #[test]
    fn budget_controls_normalize_ranges_and_aliases() {
        let budget = BudgetControl {
            min: 128,
            max: 32_768,
            can_disable: false,
            dynamic: true,
            step: 1024,
        };
        assert_eq!(budget.normalize("8192"), Some("8192".to_string()));
        assert_eq!(budget.normalize("dynamic"), Some("dynamic".to_string()));
        assert_eq!(budget.normalize("-1"), Some("dynamic".to_string()));
        assert_eq!(budget.normalize("128"), Some("128".to_string()));
        assert_eq!(budget.normalize("32768"), Some("32768".to_string()));
        assert_eq!(budget.normalize("0"), None);
        assert_eq!(budget.normalize("127"), None);
        assert_eq!(budget.normalize("32769"), None);
        assert_eq!(budget.normalize("lots"), None);
        assert!(!budget.describe().contains("off"));
    }

    #[test]
    fn gemini_2_5_uses_a_budget_and_later_generations_use_levels() {
        for row in BUILT_IN_PRICING.iter() {
            let Some(effort) = &row.effort else {
                continue;
            };
            if row.model.starts_with("gemini-2.5") {
                assert!(effort.is_budget(), "{} must use thinkingBudget", row.model);
                assert!(
                    effort.parameter.ends_with("thinkingBudget"),
                    "{} must not point at thinkingLevel",
                    row.model
                );
                assert!(effort.levels.is_empty());
            } else if row.model.starts_with("gemini-") {
                assert!(!effort.is_budget(), "{} must use thinkingLevel", row.model);
                assert!(effort.parameter.ends_with("thinkingLevel"));
            }
        }
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
