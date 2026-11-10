use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::redact::CaptureLocation;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardAction {
    Allow,
    Warn,
    Redact,
    Pause,
    Block,
}

impl GuardAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Warn => "warn",
            Self::Redact => "redact",
            Self::Pause => "pause",
            Self::Block => "block",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "warn" => Some(Self::Warn),
            "redact" => Some(Self::Redact),
            "pause" => Some(Self::Pause),
            "block" => Some(Self::Block),
            _ => None,
        }
    }

    /// Strength ordering used when several rules match one request.
    pub fn rank(self) -> u8 {
        match self {
            Self::Allow => 0,
            Self::Warn => 1,
            Self::Redact => 2,
            Self::Pause => 3,
            Self::Block => 4,
        }
    }

    pub fn strongest(actions: impl IntoIterator<Item = Self>) -> Self {
        actions
            .into_iter()
            .max_by_key(|action| action.rank())
            .unwrap_or(Self::Allow)
    }

    pub fn event_status(self) -> GuardEventStatus {
        match self {
            Self::Pause => GuardEventStatus::Pending,
            Self::Block => GuardEventStatus::Blocked,
            Self::Redact => GuardEventStatus::Redacted,
            Self::Allow | Self::Warn => GuardEventStatus::Warned,
        }
    }

    pub fn severity(self) -> GuardSeverity {
        match self {
            Self::Pause | Self::Block => GuardSeverity::Critical,
            Self::Redact => GuardSeverity::High,
            Self::Allow | Self::Warn => GuardSeverity::Medium,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardSeverity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

impl GuardSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "info" => Some(Self::Info),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "critical" => Some(Self::Critical),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardRuleKind {
    Secret,
    DangerousCommand,
    Loop,
    Budget,
    Egress,
    Custom,
}

impl GuardRuleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Secret => "secret",
            Self::DangerousCommand => "dangerous_command",
            Self::Loop => "loop",
            Self::Budget => "budget",
            Self::Egress => "egress",
            Self::Custom => "custom",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "secret" => Some(Self::Secret),
            "dangerous_command" => Some(Self::DangerousCommand),
            "loop" => Some(Self::Loop),
            "budget" => Some(Self::Budget),
            "egress" => Some(Self::Egress),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardRuleSource {
    Builtin,
    Plugin,
    Project,
    User,
}

impl GuardRuleSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Plugin => "plugin",
            Self::Project => "project",
            Self::User => "user",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "builtin" => Some(Self::Builtin),
            "plugin" => Some(Self::Plugin),
            "project" => Some(Self::Project),
            "user" => Some(Self::User),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardEventStatus {
    Pending,
    Approved,
    Denied,
    Blocked,
    Redacted,
    Warned,
    Expired,
}

impl GuardEventStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Blocked => "blocked",
            Self::Redacted => "redacted",
            Self::Warned => "warned",
            Self::Expired => "expired",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "approved" => Some(Self::Approved),
            "denied" => Some(Self::Denied),
            "blocked" => Some(Self::Blocked),
            "redacted" => Some(Self::Redacted),
            "warned" => Some(Self::Warned),
            "expired" => Some(Self::Expired),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetScope {
    Session,
    Project,
    Global,
}

impl BudgetScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
            Self::Global => "global",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "session" => Some(Self::Session),
            "project" => Some(Self::Project),
            "global" => Some(Self::Global),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetPeriod {
    Session,
    Day,
    Week,
    Month,
}

impl BudgetPeriod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "session" => Some(Self::Session),
            "day" => Some(Self::Day),
            "week" => Some(Self::Week),
            "month" => Some(Self::Month),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetEnforcement {
    Warn,
    Pause,
    Block,
}

impl BudgetEnforcement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Warn => "warn",
            Self::Pause => "pause",
            Self::Block => "block",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "warn" => Some(Self::Warn),
            "pause" => Some(Self::Pause),
            "block" => Some(Self::Block),
            _ => None,
        }
    }
}

/// The optional fields every built-in detector understands.
///
/// Rules are data, not code, so the stored JSON object may carry extra fields
/// for plugins. These are the keys Pandu itself reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GuardRuleConfig {
    pub patterns: Vec<String>,
    pub terms: Vec<String>,
    pub hosts: Vec<String>,
    pub paths: Vec<String>,
    pub threshold: Option<f64>,
    pub min_occurrences: Option<u32>,
    pub window: Option<u32>,
    pub flags: Option<String>,
}

impl GuardRuleConfig {
    pub fn from_value(config: &Value) -> Self {
        let Some(object) = config.as_object() else {
            return Self::default();
        };
        let strings = |key: &str| -> Vec<String> {
            object
                .get(key)
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        Self {
            patterns: strings("patterns"),
            terms: strings("terms"),
            hosts: strings("hosts"),
            paths: strings("paths"),
            threshold: object.get("threshold").and_then(Value::as_f64),
            min_occurrences: object
                .get("minOccurrences")
                .and_then(Value::as_u64)
                .map(|value| value.clamp(1, 1_000) as u32),
            window: object
                .get("window")
                .and_then(Value::as_u64)
                .map(|value| value.clamp(1, 1_000) as u32),
            flags: object
                .get("flags")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardRule {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub kind: GuardRuleKind,
    pub action: GuardAction,
    pub severity: GuardSeverity,
    pub source: GuardRuleSource,
    pub enabled: bool,
    pub priority: u32,
    #[serde(default)]
    pub config: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardRuleInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub kind: GuardRuleKind,
    pub action: GuardAction,
    pub severity: GuardSeverity,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_priority")]
    pub priority: u32,
    #[serde(default = "empty_config")]
    pub config: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardRulePatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub kind: Option<GuardRuleKind>,
    pub action: Option<GuardAction>,
    pub severity: Option<GuardSeverity>,
    pub enabled: Option<bool>,
    pub priority: Option<u32>,
    pub config: Option<Value>,
}

fn default_true() -> bool {
    true
}

fn default_priority() -> u32 {
    100
}

fn empty_config() -> Value {
    Value::Object(serde_json::Map::new())
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl GuardEvidence {
    pub fn field_excerpt(field: impl Into<String>, excerpt: impl Into<String>) -> Self {
        Self {
            field: Some(field.into()),
            excerpt: Some(excerpt.into()),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardEvent {
    pub id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub rule_id: String,
    pub kind: GuardRuleKind,
    pub action: GuardAction,
    pub severity: GuardSeverity,
    pub status: GuardEventStatus,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub evidence: Vec<GuardEvidence>,
    pub requested_at: String,
    /// Single-use secret that must accompany an approval decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_nonce: Option<String>,
    /// The instant after which this approval can no longer be used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardEventListQuery {
    pub session_id: Option<String>,
    pub status: Option<GuardEventStatus>,
    pub kind: Option<GuardRuleKind>,
    #[serde(default = "default_event_limit")]
    pub limit: u32,
}

fn default_event_limit() -> u32 {
    100
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPolicy {
    pub id: String,
    pub name: String,
    pub scope: BudgetScope,
    pub period: BudgetPeriod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub limit_usd: f64,
    pub enforcement: BudgetEnforcement,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPolicyInput {
    pub name: String,
    pub scope: BudgetScope,
    pub period: BudgetPeriod,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub limit_usd: f64,
    pub enforcement: BudgetEnforcement,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPolicyPatch {
    pub name: Option<String>,
    pub scope: Option<BudgetScope>,
    pub period: Option<BudgetPeriod>,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub limit_usd: Option<f64>,
    pub enforcement: Option<BudgetEnforcement>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub policy_id: String,
    pub name: String,
    pub limit_usd: f64,
    pub spent_usd: f64,
    pub remaining_usd: f64,
    pub usage_ratio: f64,
    pub warning: bool,
    pub exceeded: bool,
    pub enforcement: BudgetEnforcement,
    pub period: BudgetPeriod,
    pub period_start: String,
}

/// UTC period boundaries keep budget math identical across time zones and
/// machines. Session periods start when the session started.
pub fn budget_period_start(
    period: BudgetPeriod,
    now: DateTime<Utc>,
    session_started_at: Option<DateTime<Utc>>,
) -> DateTime<Utc> {
    if period == BudgetPeriod::Session {
        return session_started_at.unwrap_or_else(|| Utc.timestamp_opt(0, 0).single().unwrap());
    }

    let start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("midnight is always valid")
        .and_utc();
    match period {
        BudgetPeriod::Session => start,
        BudgetPeriod::Day => start,
        BudgetPeriod::Week => {
            let weekday = start.weekday().num_days_from_monday() as i64;
            start - Duration::days(weekday)
        }
        BudgetPeriod::Month => Utc
            .with_ymd_and_hms(start.year(), start.month(), 1, 0, 0, 0)
            .single()
            .unwrap_or(start),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalChoice {
    Approve,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionInput {
    pub decision: ApprovalChoice,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(default = "default_channel")]
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The nonce shown with the pending event. Required for pause approvals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// The session the approval belongs to. Required for pause approvals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

fn default_channel() -> String {
    "dashboard".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardRequestResult {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub events: Vec<GuardEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretFinding {
    #[serde(rename = "type")]
    pub secret_type: String,
    pub confidence: f64,
    pub preview: String,
    pub location: CaptureLocation,
    pub action: GuardAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretScanResponse {
    pub session_id: String,
    pub scanned_at: String,
    pub findings: Vec<SecretFinding>,
    pub events: Vec<GuardEvent>,
    pub files_examined: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strongest_action_wins() {
        assert_eq!(
            GuardAction::strongest([GuardAction::Warn, GuardAction::Pause, GuardAction::Redact]),
            GuardAction::Pause
        );
        assert_eq!(GuardAction::strongest([]), GuardAction::Allow);
    }

    #[test]
    fn budget_periods_start_at_utc_boundaries() {
        let now = Utc.with_ymd_and_hms(2026, 11, 8, 15, 30, 0).unwrap();
        let session_start = Utc.with_ymd_and_hms(2026, 11, 8, 9, 0, 0).unwrap();
        assert_eq!(
            budget_period_start(BudgetPeriod::Session, now, Some(session_start)),
            session_start
        );
        assert_eq!(
            budget_period_start(BudgetPeriod::Day, now, None),
            Utc.with_ymd_and_hms(2026, 11, 8, 0, 0, 0).unwrap()
        );
        // 2026-11-08 is a Sunday, so the week starts on Monday 2026-11-02.
        assert_eq!(
            budget_period_start(BudgetPeriod::Week, now, None),
            Utc.with_ymd_and_hms(2026, 11, 2, 0, 0, 0).unwrap()
        );
        assert_eq!(
            budget_period_start(BudgetPeriod::Month, now, None),
            Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap()
        );
    }

    #[test]
    fn rule_config_reads_optional_fields() {
        let config = GuardRuleConfig::from_value(&serde_json::json!({
            "patterns": ["private-key", 7],
            "terms": ["deploy"],
            "hosts": ["pastebin.com"],
            "threshold": 0.8,
            "minOccurrences": 4,
            "window": 12,
            "flags": "im"
        }));
        assert_eq!(config.patterns, vec!["private-key"]);
        assert_eq!(config.terms, vec!["deploy"]);
        assert_eq!(config.hosts, vec!["pastebin.com"]);
        assert_eq!(config.threshold, Some(0.8));
        assert_eq!(config.min_occurrences, Some(4));
        assert_eq!(config.window, Some(12));
        assert_eq!(config.flags.as_deref(), Some("im"));
    }

    #[test]
    fn enums_round_trip() {
        for action in [
            GuardAction::Allow,
            GuardAction::Warn,
            GuardAction::Redact,
            GuardAction::Pause,
            GuardAction::Block,
        ] {
            assert_eq!(GuardAction::parse(action.as_str()), Some(action));
        }
        for status in [
            GuardEventStatus::Pending,
            GuardEventStatus::Approved,
            GuardEventStatus::Denied,
            GuardEventStatus::Blocked,
            GuardEventStatus::Redacted,
            GuardEventStatus::Warned,
            GuardEventStatus::Expired,
        ] {
            assert_eq!(GuardEventStatus::parse(status.as_str()), Some(status));
        }
    }
}
