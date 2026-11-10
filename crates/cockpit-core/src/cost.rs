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

/// Long-context pricing that starts above a prompt-size threshold.
///
/// Providers publish two different scopes. OpenAI reprices the whole session
/// once one prompt crosses the threshold; Gemini prices each prompt on its own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongContextTier {
    /// Prompt input tokens above which the higher rates apply.
    pub threshold_input_tokens: u64,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_per_mtok: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_per_mtok: Option<f64>,
    pub scope: LongContextScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LongContextScope {
    /// Once one prompt crosses the threshold, the provider bills the whole
    /// session at the higher rates (OpenAI).
    Session,
    /// Only prompts above the threshold are billed at the higher rates
    /// (Gemini 2.5 Pro and Claude Haiku 5.5).
    Request,
}

/// Effective per-million-token rates for one prompt size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PricingRates {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_per_mtok: f64,
    pub long_context: bool,
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
    /// Higher rates for prompts above the provider's long-context threshold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_context: Option<LongContextTier>,
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

impl ModelPricing {
    /// Whether a prompt of this size is billed at the long-context tier.
    pub fn tier_applies(&self, prompt_tokens: u64) -> bool {
        self.long_context
            .as_ref()
            .is_some_and(|tier| prompt_tokens > tier.threshold_input_tokens)
    }

    /// Effective rates for one prompt size, or `None` when the price is unknown.
    ///
    /// A tier that omits a cache rate keeps the base cache rate when one is
    /// published, and otherwise falls back to the tier's input rate.
    pub fn rates_for_prompt(&self, prompt_tokens: Option<u64>) -> Option<PricingRates> {
        let input = self.input_per_mtok?;
        let output = self.output_per_mtok?;
        let tier = prompt_tokens.and_then(|tokens| {
            self.long_context
                .as_ref()
                .filter(|tier| tokens > tier.threshold_input_tokens)
        });
        match tier {
            Some(tier) => Some(PricingRates {
                input_per_mtok: tier.input_per_mtok,
                output_per_mtok: tier.output_per_mtok,
                cache_read_per_mtok: tier
                    .cache_read_per_mtok
                    .or(self.cache_read_per_mtok)
                    .unwrap_or(tier.input_per_mtok),
                cache_write_per_mtok: tier
                    .cache_write_per_mtok
                    .or(self.cache_write_per_mtok)
                    .unwrap_or(tier.input_per_mtok),
                long_context: true,
            }),
            None => Some(PricingRates {
                input_per_mtok: input,
                output_per_mtok: output,
                cache_read_per_mtok: self.cache_read_per_mtok.unwrap_or(input),
                cache_write_per_mtok: self.cache_write_per_mtok.unwrap_or(input),
                long_context: false,
            }),
        }
    }
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
    /// True when any part of this estimate used long-context rates.
    #[serde(default)]
    pub long_context: bool,
}

fn price_unknown(pricing: &ModelPricing) -> CostEstimate {
    CostEstimate {
        known: false,
        normalized_model: normalize_model_id(&pricing.model),
        usd: None,
        breakdown: None,
        pricing: Some(pricing.clone()),
        reason: Some(PricingMissReason::PriceUnknown),
        long_context: false,
    }
}

/// Cost at the base rates. Per-step accounting stays on base rates because the
/// step does not know whether an earlier request already crossed a
/// session-scoped threshold; use [`estimate_flight_cost`] for a flight total.
pub fn compute_cost_from_price(usage: TokenUsage, pricing: &ModelPricing) -> CostEstimate {
    let Some(rates) = pricing.rates_for_prompt(None) else {
        return price_unknown(pricing);
    };
    build_estimate(usage, pricing, rates)
}

/// Cost for one prompt, using the long-context tier when `prompt_tokens`
/// crosses its threshold.
pub fn compute_cost_at_prompt(
    usage: TokenUsage,
    pricing: &ModelPricing,
    prompt_tokens: Option<u64>,
) -> CostEstimate {
    let Some(rates) = pricing.rates_for_prompt(prompt_tokens) else {
        return price_unknown(pricing);
    };
    build_estimate(usage, pricing, rates)
}

/// Price a flight's actual usage.
///
/// `steps` are the per-model-call usages in order, `totals` the flight totals,
/// and `context_tokens` the latest prompt size. When the step list is complete,
/// request-scoped tiers are applied per prompt and session-scoped tiers apply
/// to the whole flight once one prompt crosses the threshold. When it is not,
/// the totals are priced at the tier implied by the latest context.
pub fn estimate_flight_cost(
    steps: &[TokenUsage],
    totals: TokenUsage,
    context_tokens: Option<u64>,
    pricing: &ModelPricing,
) -> CostEstimate {
    if pricing.rates_for_prompt(None).is_none() {
        return price_unknown(pricing);
    }

    let mut steps_total = TokenUsage::ZERO;
    for step in steps {
        steps_total = steps_total.combined(*step);
    }
    let steps_complete = !steps.is_empty() && steps_total == totals;
    if !steps_complete {
        return compute_cost_at_prompt(totals, pricing, context_tokens);
    }

    match pricing.long_context.as_ref().map(|tier| tier.scope) {
        Some(LongContextScope::Request) => {
            let mut breakdown = CostBreakdown::default();
            let mut long_context = false;
            for step in steps {
                let estimate = compute_cost_at_prompt(*step, pricing, Some(step.total_input()));
                let Some(part) = estimate.breakdown else {
                    return price_unknown(pricing);
                };
                breakdown.input_usd += part.input_usd;
                breakdown.output_usd += part.output_usd;
                breakdown.cache_read_usd += part.cache_read_usd;
                breakdown.cache_write_usd += part.cache_write_usd;
                long_context |= estimate.long_context;
            }
            finish_estimate(pricing, breakdown, long_context)
        }
        Some(LongContextScope::Session) => {
            let threshold = pricing
                .long_context
                .as_ref()
                .map(|tier| tier.threshold_input_tokens)
                .unwrap_or(u64::MAX);
            let long_context = steps.iter().any(|step| step.total_input() > threshold)
                || context_tokens.is_some_and(|tokens| tokens > threshold);
            let prompt = long_context.then(|| threshold.saturating_add(1));
            compute_cost_at_prompt(totals, pricing, prompt)
        }
        None => compute_cost_from_price(totals, pricing),
    }
}

/// Cost of the first request after a switch, which re-reads the context with a
/// cold provider cache. Only input tokens are priced; output is unknown.
pub fn estimate_first_request_cost(pricing: &ModelPricing, context_tokens: u64) -> Option<f64> {
    let rates = pricing.rates_for_prompt(Some(context_tokens))?;
    Some(round_usd(per_million(context_tokens, rates.input_per_mtok)))
}

fn build_estimate(usage: TokenUsage, pricing: &ModelPricing, rates: PricingRates) -> CostEstimate {
    let breakdown = CostBreakdown {
        input_usd: per_million(usage.input_tokens, rates.input_per_mtok),
        output_usd: per_million(usage.output_tokens, rates.output_per_mtok),
        cache_read_usd: per_million(usage.cache_read_tokens, rates.cache_read_per_mtok),
        cache_write_usd: per_million(usage.cache_write_tokens, rates.cache_write_per_mtok),
    };
    finish_estimate(pricing, breakdown, rates.long_context)
}

fn finish_estimate(
    pricing: &ModelPricing,
    breakdown: CostBreakdown,
    long_context: bool,
) -> CostEstimate {
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
        long_context,
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
            long_context: false,
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
            long_context: None,
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
    fn long_context_rates_start_above_the_threshold() {
        let pricing = find_builtin_model("gpt-5.5", Some("openai")).expect("gpt-5.5 row");
        let short = compute_cost_at_prompt(usage(), pricing, Some(272_000));
        assert_eq!(short.usd, Some(35.0));
        assert!(!short.long_context);

        let long = compute_cost_at_prompt(usage(), pricing, Some(272_001));
        assert_eq!(long.usd, Some(55.0));
        assert!(long.long_context);
        assert_eq!(long.breakdown.unwrap().input_usd, 10.0);
    }

    #[test]
    fn session_scoped_tiers_reprice_the_whole_flight() {
        let pricing = find_builtin_model("gpt-5.5", Some("openai")).expect("gpt-5.5 row");
        let steps = [
            TokenUsage {
                input_tokens: 100_000,
                output_tokens: 1_000,
                ..TokenUsage::ZERO
            },
            TokenUsage {
                input_tokens: 300_000,
                output_tokens: 1_000,
                ..TokenUsage::ZERO
            },
        ];
        let totals = steps
            .iter()
            .fold(TokenUsage::ZERO, |sum, step| sum.combined(*step));

        let short_steps = [
            TokenUsage {
                input_tokens: 100_000,
                output_tokens: 1_000,
                ..TokenUsage::ZERO
            },
            TokenUsage {
                input_tokens: 150_000,
                output_tokens: 1_000,
                ..TokenUsage::ZERO
            },
        ];
        let short_totals = short_steps
            .iter()
            .fold(TokenUsage::ZERO, |sum, step| sum.combined(*step));

        let short = estimate_flight_cost(&short_steps, short_totals, Some(200_000), pricing);
        assert_eq!(short.usd, Some(1.31));

        let long = estimate_flight_cost(&steps, totals, Some(300_000), pricing);
        assert_eq!(long.usd, Some(4.09));
        assert!(long.long_context);
    }

    #[test]
    fn request_scoped_tiers_price_only_large_prompts() {
        let pricing = find_builtin_model("gemini-2.5-pro", Some("google")).expect("gemini row");
        let steps = [
            TokenUsage {
                input_tokens: 100_000,
                output_tokens: 1_000,
                ..TokenUsage::ZERO
            },
            TokenUsage {
                input_tokens: 300_000,
                output_tokens: 1_000,
                ..TokenUsage::ZERO
            },
        ];
        let totals = steps
            .iter()
            .fold(TokenUsage::ZERO, |sum, step| sum.combined(*step));

        let cost = estimate_flight_cost(&steps, totals, Some(300_000), pricing);
        assert_eq!(cost.usd, Some(0.9));
        assert!(cost.long_context);
    }

    #[test]
    fn first_request_prices_the_uncached_context() {
        let gpt = find_builtin_model("gpt-5.5", Some("openai")).expect("gpt-5.5 row");
        assert_eq!(estimate_first_request_cost(gpt, 100_000), Some(0.5));
        assert_eq!(estimate_first_request_cost(gpt, 864_000), Some(8.64));

        let gemini = find_builtin_model("gemini-2.5-pro", Some("google")).expect("gemini row");
        assert_eq!(estimate_first_request_cost(gemini, 250_000), Some(0.625));
    }

    #[test]
    fn unknown_prices_stay_unknown_with_a_tier() {
        let mut pricing = override_row(None, None);
        pricing.long_context = Some(LongContextTier {
            threshold_input_tokens: 200_000,
            input_per_mtok: 2.5,
            output_per_mtok: 15.0,
            cache_read_per_mtok: None,
            cache_write_per_mtok: None,
            scope: LongContextScope::Request,
        });
        let cost = estimate_flight_cost(&[], usage(), Some(300_000), &pricing);
        assert!(!cost.known);
        assert_eq!(cost.usd, None);
        assert_eq!(cost.reason, Some(PricingMissReason::PriceUnknown));
        assert_eq!(estimate_first_request_cost(&pricing, 300_000), None);
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
