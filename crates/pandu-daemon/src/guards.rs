use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use pandu_core::guard::{
    ApprovalChoice, ApprovalDecisionInput, GuardAction, GuardEvent, GuardEventListQuery,
    GuardEventStatus, GuardEvidence, GuardRequestResult, GuardRule, GuardRuleConfig,
    GuardRuleInput, GuardRuleKind, GuardRulePatch, GuardRuleSource, GuardSeverity, SecretFinding,
    SecretScanResponse,
};
use pandu_core::provider::ProviderProtocol;
use pandu_core::redact::{CaptureLocation, SECRET_PATTERNS, mask_secret};
use pandu_core::request_meta::{extract_latest_user_message, extract_request_metadata};
use pandu_core::similarity::token_similarity;
use pandu_core::text::{parse_json_body, truncate_text};
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use tokio::sync::{Mutex, oneshot};

use crate::error::DaemonError;
use crate::live::LiveBus;
use crate::store::{GuardEventPatch, NewGuardEvent, Store, now_iso};

const MAX_MATCHES: usize = 8;
const MAX_SECRET_HITS: usize = 100;
const LOOP_COOLDOWN_MS: i64 = 5 * 60_000;

#[derive(Debug)]
pub struct GuardServiceError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl GuardServiceError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for GuardServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GuardServiceError {}

#[derive(Debug, thiserror::Error)]
pub enum GuardError {
    #[error("{0}")]
    Store(#[from] DaemonError),
    #[error("{0}")]
    Service(#[from] GuardServiceError),
}

impl GuardError {
    pub fn status(&self) -> u16 {
        match self {
            Self::Store(_) => 500,
            Self::Service(error) => error.status,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Store(_) => "internal_error",
            Self::Service(error) => error.code,
        }
    }
}

pub type GuardResult<T> = std::result::Result<T, GuardError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Approved,
    Denied,
    Expired,
}

#[derive(Default)]
struct BrokerState {
    pending: HashMap<String, oneshot::Sender<ApprovalOutcome>>,
    /// Decisions that landed before the proxied request registered its waiter.
    /// The remote UI can approve within milliseconds of the event appearing, so
    /// the broker must remember the answer instead of losing it.
    resolved: HashMap<String, ApprovalOutcome>,
}

/// Holds a proxied request only while a pause rule is being decided.
#[derive(Default)]
pub struct ApprovalBroker {
    state: Mutex<BrokerState>,
}

impl ApprovalBroker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn wait_for(&self, event_id: &str, timeout: Duration) -> ApprovalOutcome {
        let mut state = self.state.lock().await;
        if let Some(outcome) = state.resolved.remove(event_id) {
            return outcome;
        }
        if let Some(previous) = state.pending.remove(event_id) {
            let _ = previous.send(ApprovalOutcome::Expired);
        }
        let (sender, receiver) = oneshot::channel();
        state.pending.insert(event_id.to_string(), sender);
        drop(state);

        match tokio::time::timeout(timeout.max(Duration::from_millis(1)), receiver).await {
            Ok(Ok(outcome)) => outcome,
            _ => {
                self.state.lock().await.pending.remove(event_id);
                ApprovalOutcome::Expired
            }
        }
    }

    pub async fn resolve(&self, event_id: &str, decision: ApprovalChoice) -> bool {
        let outcome = match decision {
            ApprovalChoice::Approve => ApprovalOutcome::Approved,
            ApprovalChoice::Deny => ApprovalOutcome::Denied,
        };
        self.deliver(event_id, outcome).await
    }

    pub async fn cancel(&self, event_id: &str, outcome: ApprovalOutcome) -> bool {
        self.deliver(event_id, outcome).await
    }

    async fn deliver(&self, event_id: &str, outcome: ApprovalOutcome) -> bool {
        let mut state = self.state.lock().await;
        if let Some(sender) = state.pending.remove(event_id) {
            return sender.send(outcome).is_ok();
        }
        // Keep only a bounded number of early decisions; an unanswered event
        // that is never waited on must not grow this map forever.
        if state.resolved.len() >= 256 {
            if let Some(oldest) = state.resolved.keys().next().cloned() {
                state.resolved.remove(&oldest);
            }
        }
        state.resolved.insert(event_id.to_string(), outcome);
        false
    }

    pub async fn is_pending(&self, event_id: &str) -> bool {
        self.state.lock().await.pending.contains_key(event_id)
    }

    pub async fn clear(&self) {
        let mut state = self.state.lock().await;
        for (_, sender) in state.pending.drain() {
            let _ = sender.send(ApprovalOutcome::Expired);
        }
        state.resolved.clear();
    }
}

#[derive(Debug, Clone)]
pub struct GuardRequestInput {
    pub session_id: String,
    pub protocol: ProviderProtocol,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body_text: String,
}

#[derive(Debug, Clone)]
pub struct GuardStepInput {
    pub session_id: String,
    pub step_id: String,
    pub response_text: Option<String>,
    pub response_thinking: Option<String>,
    pub tool_calls: Vec<(String, Option<Value>)>,
}

#[derive(Debug, Clone)]
pub struct SecretScanHit {
    pub secret_type: String,
    pub label: String,
    pub confidence: f64,
    pub preview: String,
    pub location: CaptureLocation,
}

fn confidence_for(secret_type: &str) -> f64 {
    match secret_type {
        "private-key" => 0.99,
        "anthropic-api-key" => 0.97,
        "openai-api-key" | "github-token" | "aws-access-key" | "google-api-key" => 0.95,
        "slack-token" => 0.9,
        "jwt" => 0.8,
        "bearer-token" => 0.7,
        _ => 0.75,
    }
}

/// Deterministic, local secret detection. Previews are masked before they
/// reach the database.
pub fn scan_text(text: &str, location: CaptureLocation) -> Vec<SecretScanHit> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for rule in SECRET_PATTERNS.iter() {
        for found in rule.pattern.find_iter(text) {
            let value = found.as_str();
            if value.is_empty() {
                continue;
            }
            hits.push(SecretScanHit {
                secret_type: rule.rule_id.to_string(),
                label: rule.label.to_string(),
                confidence: confidence_for(rule.rule_id),
                preview: mask_secret(value),
                location,
            });
            if hits.len() >= MAX_SECRET_HITS {
                return hits;
            }
        }
    }
    hits
}

fn scan_headers(
    headers: &BTreeMap<String, String>,
    location: CaptureLocation,
) -> Vec<SecretScanHit> {
    let mut hits = Vec::new();
    for (name, value) in headers {
        hits.extend(scan_text(&format!("{name}: {value}"), location));
    }
    hits
}

fn stringify(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Character-aware excerpt around a match. The guard never stores a whole
/// prompt just to show why a rule fired.
fn excerpt_around(text: &str, byte_index: usize, byte_length: usize) -> String {
    let mut index = byte_index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    let mut end = (byte_index + byte_length).min(text.len());
    while end > index && !text.is_char_boundary(end) {
        end -= 1;
    }
    let start_char = text[..index].chars().count();
    let match_chars = text[index..end].chars().count();
    let characters: Vec<char> = text.chars().collect();
    let start = start_char.saturating_sub(60);
    let end = (start_char + match_chars + 60).min(characters.len());
    let excerpt: String = characters[start..end].iter().collect();
    truncate_text(&excerpt, 500)
}

fn compile_pattern(pattern: &str, flags: &str) -> Option<Regex> {
    RegexBuilder::new(pattern)
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .dot_matches_new_line(flags.contains('s'))
        .build()
        .ok()
}

#[derive(Debug, Clone)]
struct TextMatch {
    field: String,
    excerpt: String,
    value: String,
}

fn push_match(
    matches: &mut Vec<TextMatch>,
    seen: &mut HashSet<String>,
    field: &str,
    excerpt: String,
    value: String,
) {
    let key = format!("{field}\u{0}{excerpt}");
    if seen.insert(key) {
        matches.push(TextMatch {
            field: field.to_string(),
            excerpt,
            value,
        });
    }
}

fn match_rule(rule: &GuardRule, texts: &[(String, String)]) -> Vec<TextMatch> {
    let config = GuardRuleConfig::from_value(&rule.config);
    let mut matches = Vec::new();
    let mut seen = HashSet::new();

    for (field, text) in texts {
        if text.is_empty() {
            continue;
        }

        for pattern in &config.patterns {
            let Some(regex) = compile_pattern(pattern, config.flags.as_deref().unwrap_or("i"))
            else {
                continue;
            };
            for found in regex.find_iter(text) {
                let value = found.as_str();
                if value.is_empty() {
                    continue;
                }
                push_match(
                    &mut matches,
                    &mut seen,
                    field,
                    excerpt_around(text, found.start(), value.len()),
                    value.to_string(),
                );
                if matches.len() >= MAX_MATCHES {
                    return matches;
                }
            }
        }

        let lower = text.to_lowercase();
        for term in &config.terms {
            let needle = term.to_lowercase();
            if let Some(index) = lower.find(&needle) {
                push_match(
                    &mut matches,
                    &mut seen,
                    field,
                    excerpt_around(text, index, needle.len()),
                    term.clone(),
                );
                if matches.len() >= MAX_MATCHES {
                    return matches;
                }
            }
        }

        for host in &config.hosts {
            let needle = host.to_lowercase();
            if let Some(index) = lower.find(&needle) {
                push_match(
                    &mut matches,
                    &mut seen,
                    field,
                    excerpt_around(text, index, needle.len()),
                    host.clone(),
                );
                if matches.len() >= MAX_MATCHES {
                    return matches;
                }
            }
        }
    }

    matches
}

fn latest_user_from_prompt_text(prompt_text: &str) -> String {
    let blocks: Vec<&str> = prompt_text.split("\n\n").collect();
    let pattern = Regex::new(r"(?is)^(?:user|human):\s*(.+)$").expect("valid prompt regex");
    for block in blocks.iter().rev() {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        if let Some(captures) = pattern.captures(block) {
            if let Some(value) = captures.get(1) {
                return value.as_str().trim().to_string();
            }
        }
    }
    prompt_text.trim().to_string()
}

fn round_milli(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// Generate a 256-bit single-use approval nonce.
pub(crate) fn new_approval_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut nonce = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(nonce, "{byte:02x}");
    }
    nonce
}

fn approval_expires_at(timeout: Duration) -> String {
    let duration = chrono::Duration::from_std(timeout)
        .unwrap_or_else(|_| chrono::Duration::milliseconds(120_000));
    (chrono::Utc::now() + duration).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Give a pending event the nonce and expiry the approval API requires.
/// Called by every service that can create a pause event.
pub(crate) fn prepare_approval(input: &mut NewGuardEvent, timeout: Duration) {
    if input.status != GuardEventStatus::Pending {
        return;
    }
    if input.approval_nonce.is_none() {
        input.approval_nonce = Some(new_approval_nonce());
    }
    if input.approval_expires_at.is_none() {
        input.approval_expires_at = Some(approval_expires_at(timeout));
    }
}

fn event_payload(event: &GuardEvent) -> Value {
    json!({
        "ruleId": event.rule_id,
        "kind": event.kind,
        "action": event.action,
        "severity": event.severity,
        "status": event.status,
        "title": event.title,
        "evidenceCount": event.evidence.len(),
    })
}

pub struct GuardService {
    store: Arc<Store>,
    live: Arc<LiveBus>,
    approval_timeout: Duration,
    broker: Arc<ApprovalBroker>,
    loop_warnings: StdMutex<HashMap<String, i64>>,
    scan_timers: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

impl GuardService {
    pub fn new(store: Arc<Store>, live: Arc<LiveBus>, approval_timeout_ms: u64) -> Arc<Self> {
        let service = Arc::new(Self {
            store,
            live,
            approval_timeout: Duration::from_millis(approval_timeout_ms.max(1)),
            broker: ApprovalBroker::new(),
            loop_warnings: StdMutex::new(HashMap::new()),
            scan_timers: Mutex::new(HashMap::new()),
        });
        service.seed_builtins();
        service
    }

    pub fn broker(&self) -> Arc<ApprovalBroker> {
        self.broker.clone()
    }

    fn seed_builtins(&self) {
        for (id, input) in builtin_rules() {
            match self.store.seed_guard_rule(id, &input) {
                Ok(true) => {}
                Ok(false) => {}
                Err(error) => tracing::warn!(%error, rule_id = id, "could not seed guard rule"),
            }
        }
    }

    pub fn list_rules(&self) -> GuardResult<Vec<GuardRule>> {
        Ok(self.store.list_guard_rules()?)
    }

    pub fn create_rule(&self, input: GuardRuleInput) -> GuardResult<GuardRule> {
        Ok(self
            .store
            .create_guard_rule(None, &input, GuardRuleSource::User)?)
    }

    pub fn update_rule(&self, id: &str, patch: GuardRulePatch) -> GuardResult<GuardRule> {
        let rule = self.store.get_guard_rule(id)?.ok_or_else(|| {
            GuardServiceError::new(404, "not_found", "The guard rule was not found.")
        })?;
        if rule.source == GuardRuleSource::Builtin
            && patch.kind.is_some_and(|kind| kind != rule.kind)
        {
            return Err(GuardServiceError::new(
                409,
                "conflict",
                "A built-in rule cannot change kind. Create a custom rule instead.",
            )
            .into());
        }
        self.store.update_guard_rule(id, &patch)?.ok_or_else(|| {
            GuardServiceError::new(404, "not_found", "The guard rule was not found.").into()
        })
    }

    pub fn delete_rule(&self, id: &str) -> GuardResult<()> {
        let rule = self.store.get_guard_rule(id)?.ok_or_else(|| {
            GuardServiceError::new(404, "not_found", "The guard rule was not found.")
        })?;
        if rule.source == GuardRuleSource::Builtin {
            return Err(GuardServiceError::new(
                409,
                "conflict",
                "Built-in guard rules cannot be deleted.",
            )
            .into());
        }
        self.store.delete_guard_rule(id)?;
        Ok(())
    }

    pub fn list_events(&self, query: &GuardEventListQuery) -> GuardResult<Vec<GuardEvent>> {
        let _ = self.expire_stale_approvals();
        Ok(self.store.list_guard_events(query)?)
    }

    pub fn pending(&self, session_id: Option<&str>) -> GuardResult<Vec<GuardEvent>> {
        let _ = self.expire_stale_approvals();
        Ok(self.store.list_pending_guard_events(session_id)?)
    }

    /// Expire every approval whose window elapsed and emit one live event per
    /// real transition. Failures are logged, never fatal for the caller.
    pub fn expire_stale_approvals(&self) -> GuardResult<Vec<GuardEvent>> {
        let expired = self.store.expire_pending_guard_events(&now_iso())?;
        for event in &expired {
            self.emit_resolved(event);
        }
        Ok(expired)
    }

    pub async fn resolve_event(
        &self,
        event_id: &str,
        decision: ApprovalDecisionInput,
    ) -> GuardResult<GuardEvent> {
        let event = self.store.get_guard_event(event_id)?.ok_or_else(|| {
            GuardServiceError::new(404, "not_found", "The guard event was not found.")
        })?;
        if event.status != GuardEventStatus::Pending {
            if event.status == GuardEventStatus::Expired {
                return Err(GuardServiceError::new(
                    410,
                    "approval_expired",
                    "This approval expired. Ask the agent to request it again.",
                )
                .into());
            }
            return Err(GuardServiceError::new(
                409,
                "conflict",
                "The guard event is no longer pending.",
            )
            .into());
        }

        // Pending approvals are bound to one session, one nonce, and one
        // expiry window. Replayed or late answers are rejected before any
        // write happens.
        let Some(stored_nonce) = event.approval_nonce.as_deref() else {
            return Err(GuardServiceError::new(
                409,
                "invalid_approval",
                "This approval is missing its one-time token. Reload the Inbox and try again.",
            )
            .into());
        };
        if decision.nonce.as_deref() != Some(stored_nonce) {
            return Err(GuardServiceError::new(
                409,
                "invalid_approval",
                "The approval token does not match this request.",
            )
            .into());
        }
        if decision.session_id.as_deref() != Some(event.session_id.as_str()) {
            return Err(GuardServiceError::new(
                409,
                "invalid_approval",
                "The approval token belongs to a different session.",
            )
            .into());
        }
        if event
            .approval_expires_at
            .as_deref()
            .is_some_and(|expires_at| expires_at <= now_iso().as_str())
        {
            // Expiring is also a single-use transition: clear the nonce with
            // the same atomic guard the approve/deny path uses.
            let patch = GuardEventPatch {
                status: Some(GuardEventStatus::Expired),
                resolved_at: Some(now_iso()),
                resolved_by: Some("pandu".to_string()),
                resolution_note: Some("The approval window elapsed.".to_string()),
            };
            if let Some(expired) =
                self.store
                    .resolve_guard_event_once(event_id, stored_nonce, &patch)?
            {
                self.emit_resolved(&expired);
            }
            self.broker.cancel(event_id, ApprovalOutcome::Expired).await;
            return Err(GuardServiceError::new(
                410,
                "approval_expired",
                "This approval expired. Ask the agent to request it again.",
            )
            .into());
        }

        let status = match decision.decision {
            ApprovalChoice::Approve => GuardEventStatus::Approved,
            ApprovalChoice::Deny => GuardEventStatus::Denied,
        };
        let actor = decision
            .actor
            .clone()
            .unwrap_or_else(|| decision.channel.clone());
        let patch = GuardEventPatch {
            status: Some(status),
            resolved_at: Some(now_iso()),
            resolved_by: Some(actor),
            resolution_note: decision.note.clone(),
        };
        let updated = self
            .store
            .resolve_guard_event_once(event_id, stored_nonce, &patch)?
            .ok_or_else(|| {
                GuardServiceError::new(
                    409,
                    "conflict",
                    "This approval was already answered or is no longer pending.",
                )
            })?;
        self.emit_resolved(&updated);
        self.broker.resolve(event_id, decision.decision).await;
        Ok(updated)
    }

    pub async fn evaluate_request(
        &self,
        input: GuardRequestInput,
    ) -> GuardResult<GuardRequestResult> {
        let pending = self
            .store
            .list_pending_guard_events(Some(&input.session_id))?;
        if let Some(first) = pending.first() {
            return Ok(GuardRequestResult {
                allowed: false,
                status: Some(403),
                code: Some("guard_blocked".to_string()),
                message: Some(format!(
                    "Pandu is holding this session until an approval is resolved: {}.",
                    first.title
                )),
                events: Vec::new(),
            });
        }

        let rules: Vec<GuardRule> = self
            .store
            .list_guard_rules()?
            .into_iter()
            .filter(|rule| rule.enabled)
            .collect();
        let parsed = parse_json_body(&input.body_text);
        let metadata = extract_request_metadata(input.protocol, &input.path, parsed.value.as_ref());
        let latest_user =
            extract_latest_user_message(input.protocol, &input.path, parsed.value.as_ref())
                .or(metadata.prompt_text)
                .unwrap_or_default();

        let mut events = Vec::new();

        let mut secret_hits = scan_headers(&input.headers, CaptureLocation::RequestHeaders);
        secret_hits.extend(scan_text(&input.body_text, CaptureLocation::RequestBody));
        events.extend(self.record_secret_hits(&input.session_id, None, &secret_hits, "request")?);

        let texts = vec![
            ("prompt".to_string(), latest_user.clone()),
            ("body".to_string(), parsed.text.clone()),
        ];

        for rule in &rules {
            if matches!(
                rule.kind,
                GuardRuleKind::Secret | GuardRuleKind::Loop | GuardRuleKind::Budget
            ) {
                continue;
            }
            let matches = match_rule(rule, &texts);
            if matches.is_empty() {
                continue;
            }
            events.extend(self.record_matches(
                &input.session_id,
                None,
                rule,
                &matches,
                "request",
            )?);
        }

        events.extend(self.detect_loop(&input.session_id, &latest_user, &rules)?);

        let pause_events: Vec<GuardEvent> = events
            .iter()
            .filter(|event| event.action == GuardAction::Pause)
            .cloned()
            .collect();
        for event in pause_events {
            let mut outcome = self.broker.wait_for(&event.id, self.approval_timeout).await;
            let current = self.store.get_guard_event(&event.id)?;
            // An approval can land between recording the event and registering
            // the waiter. Trust the stored decision over a late timeout.
            if let Some(current) = &current {
                match current.status {
                    GuardEventStatus::Approved => outcome = ApprovalOutcome::Approved,
                    GuardEventStatus::Denied => outcome = ApprovalOutcome::Denied,
                    _ => {}
                }
            }
            if current
                .as_ref()
                .is_some_and(|current| current.status == GuardEventStatus::Pending)
            {
                let status = match outcome {
                    ApprovalOutcome::Approved => GuardEventStatus::Approved,
                    ApprovalOutcome::Denied => GuardEventStatus::Denied,
                    ApprovalOutcome::Expired => GuardEventStatus::Expired,
                };
                let updated = self.store.update_guard_event(
                    &event.id,
                    &GuardEventPatch {
                        status: Some(status),
                        resolved_at: Some(now_iso()),
                        resolved_by: Some("pandu".to_string()),
                        resolution_note: (outcome == ApprovalOutcome::Expired)
                            .then(|| "The approval window elapsed.".to_string()),
                    },
                )?;
                if let Some(updated) = updated {
                    self.emit_resolved(&updated);
                }
            }
            if outcome != ApprovalOutcome::Approved {
                return Ok(GuardRequestResult {
                    allowed: false,
                    status: Some(403),
                    code: Some("guard_blocked".to_string()),
                    message: Some(match outcome {
                        ApprovalOutcome::Denied => {
                            format!("Pandu blocked this request: {}.", event.title)
                        }
                        _ => format!(
                            "Pandu blocked this request because the approval window elapsed: {}.",
                            event.title
                        ),
                    }),
                    events: self.refresh_events(&events)?,
                });
            }
        }

        let action = GuardAction::strongest(events.iter().map(|event| event.action));
        if action == GuardAction::Block {
            return Ok(GuardRequestResult {
                allowed: false,
                status: Some(403),
                code: Some("guard_blocked".to_string()),
                message: Some(format!(
                    "Pandu blocked this request: {}.",
                    events
                        .first()
                        .map(|event| event.title.clone())
                        .unwrap_or_else(|| "guard rule".to_string())
                )),
                events: self.refresh_events(&events)?,
            });
        }

        Ok(GuardRequestResult {
            allowed: true,
            status: None,
            code: None,
            message: None,
            events: self.refresh_events(&events)?,
        })
    }

    pub fn evaluate_step(&self, input: GuardStepInput) -> GuardResult<Vec<GuardEvent>> {
        let rules: Vec<GuardRule> = self
            .store
            .list_guard_rules()?
            .into_iter()
            .filter(|rule| rule.enabled)
            .collect();
        let mut events = Vec::new();

        let mut secret_hits = scan_text(
            input.response_text.as_deref().unwrap_or(""),
            CaptureLocation::ResponseBody,
        );
        secret_hits.extend(scan_text(
            input.response_thinking.as_deref().unwrap_or(""),
            CaptureLocation::ResponseBody,
        ));
        for (_, call_input) in &input.tool_calls {
            secret_hits.extend(scan_text(
                &stringify(call_input.as_ref()),
                CaptureLocation::ResponseBody,
            ));
        }
        events.extend(self.record_secret_hits(
            &input.session_id,
            Some(&input.step_id),
            &secret_hits,
            "response",
        )?);

        let texts: Vec<(String, String)> = input
            .tool_calls
            .iter()
            .map(|(name, call_input)| (format!("tool:{name}"), stringify(call_input.as_ref())))
            .collect();

        for rule in &rules {
            if matches!(
                rule.kind,
                GuardRuleKind::Secret | GuardRuleKind::Loop | GuardRuleKind::Budget
            ) {
                continue;
            }
            let matches = match_rule(rule, &texts);
            if matches.is_empty() {
                continue;
            }
            events.extend(self.record_matches(
                &input.session_id,
                Some(&input.step_id),
                rule,
                &matches,
                "response",
            )?);
        }

        Ok(events)
    }

    pub fn scan_session(&self, session_id: &str) -> GuardResult<SecretScanResponse> {
        let session = self.store.get_session(session_id)?.ok_or_else(|| {
            GuardServiceError::new(404, "not_found", "The session was not found.")
        })?;
        let _ = session;

        let findings = self.scan_stored_session(session_id)?;
        self.store.delete_secret_scan_events(session_id)?;

        let mut events = Vec::new();
        for finding in &findings {
            events.push(self.record_event(NewGuardEvent {
                session_id: session_id.to_string(),
                step_id: None,
                rule_id: format!("secret-scan:{}", finding.secret_type),
                kind: GuardRuleKind::Secret,
                action: finding.action,
                severity: finding.action.severity(),
                // A historical rescan must never open an approval gate: the
                // request it refers to has already happened.
                status: if finding.action == GuardAction::Redact {
                    GuardEventStatus::Redacted
                } else {
                    GuardEventStatus::Warned
                },
                title: format!("Secret scan: {}", finding.secret_type),
                description: "A rescan of stored session data found a secret pattern.".to_string(),
                command: None,
                evidence: vec![GuardEvidence::field_excerpt(
                    finding.location.as_str(),
                    finding.preview.clone(),
                )],
                metadata: Some(json!({
                    "source": "scan",
                    "secretType": finding.secret_type,
                    "location": finding.location.as_str(),
                    "confidence": finding.confidence,
                })),
                approval_nonce: None,
                approval_expires_at: None,
            })?);
        }

        let files_examined = self.store.list_steps(session_id, 1_000_000)?.len() as u64;
        Ok(SecretScanResponse {
            session_id: session_id.to_string(),
            scanned_at: now_iso(),
            findings,
            events,
            files_examined,
        })
    }

    /// Snapshots arrive in bursts. Debouncing keeps a long session from
    /// rescanning every stored step after each tool call.
    pub fn schedule_scan(self: &Arc<Self>, session_id: &str, delay: Duration) {
        let service = self.clone();
        let session = session_id.to_string();
        let session_key = session_id.to_string();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let scanner = service.clone();
            let id = session.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Err(error) = scanner.scan_session(&id) {
                    tracing::warn!(%error, session_id = id, "could not rescan a session for secrets");
                }
            })
            .await;
        });

        let registry = self.clone();
        tokio::spawn(async move {
            let mut timers = registry.scan_timers.lock().await;
            if let Some(previous) = timers.insert(session_key, handle) {
                previous.abort();
            }
        });
    }

    pub async fn close(&self) {
        {
            let mut timers = self.scan_timers.lock().await;
            for (_, handle) in timers.drain() {
                handle.abort();
            }
        }
        self.broker.clear().await;
    }

    fn scan_stored_session(&self, session_id: &str) -> GuardResult<Vec<SecretFinding>> {
        let mut findings = Vec::new();
        let mut seen = HashSet::new();

        let mut push = |finding: SecretFinding, seen: &mut HashSet<String>| {
            let key = format!(
                "{}\u{0}{}\u{0}{}",
                finding.secret_type,
                finding.location.as_str(),
                finding.preview
            );
            if seen.insert(key) {
                findings.push(finding);
            }
        };

        for row in self.store.list_session_redactions(session_id)? {
            push(
                SecretFinding {
                    secret_type: row.rule_id.clone(),
                    confidence: 1.0,
                    preview: format!("[redacted by Pandu: {}]", row.label),
                    location: row.location,
                    action: self.action_for_secret(&row.rule_id)?,
                },
                &mut seen,
            );
        }

        for step in self.store.list_steps(session_id, 1_000_000)? {
            let request_texts = [
                (
                    step.request
                        .as_ref()
                        .and_then(|request| request.prompt_text.clone())
                        .unwrap_or_default(),
                    CaptureLocation::RequestBody,
                ),
                (
                    step.request
                        .as_ref()
                        .and_then(|request| request.system_prompt.clone())
                        .unwrap_or_default(),
                    CaptureLocation::RequestBody,
                ),
                (
                    stringify(
                        step.request
                            .as_ref()
                            .and_then(|request| request.body.as_ref()),
                    ),
                    CaptureLocation::RequestBody,
                ),
            ];
            for (text, location) in request_texts {
                for hit in scan_text(&text, location) {
                    push(
                        SecretFinding {
                            secret_type: hit.secret_type.clone(),
                            confidence: hit.confidence,
                            preview: hit.preview,
                            location: hit.location,
                            action: self.action_for_secret(&hit.secret_type)?,
                        },
                        &mut seen,
                    );
                }
            }

            let response_texts = [
                (
                    step.response
                        .as_ref()
                        .and_then(|response| response.text.clone())
                        .unwrap_or_default(),
                    CaptureLocation::ResponseBody,
                ),
                (
                    step.response
                        .as_ref()
                        .and_then(|response| response.thinking.clone())
                        .unwrap_or_default(),
                    CaptureLocation::ResponseBody,
                ),
            ];
            for (text, location) in response_texts {
                for hit in scan_text(&text, location) {
                    push(
                        SecretFinding {
                            secret_type: hit.secret_type.clone(),
                            confidence: hit.confidence,
                            preview: hit.preview,
                            location: hit.location,
                            action: self.action_for_secret(&hit.secret_type)?,
                        },
                        &mut seen,
                    );
                }
            }

            for call in self.store.list_tool_calls(&step.id)? {
                for hit in scan_text(
                    &stringify(call.input.as_ref()),
                    CaptureLocation::ResponseBody,
                ) {
                    push(
                        SecretFinding {
                            secret_type: hit.secret_type.clone(),
                            confidence: hit.confidence,
                            preview: hit.preview,
                            location: hit.location,
                            action: self.action_for_secret(&hit.secret_type)?,
                        },
                        &mut seen,
                    );
                }
            }
        }

        Ok(findings)
    }

    fn action_for_secret(&self, secret_type: &str) -> GuardResult<GuardAction> {
        for rule in self.store.list_guard_rules()? {
            if !rule.enabled || rule.kind != GuardRuleKind::Secret {
                continue;
            }
            let config = GuardRuleConfig::from_value(&rule.config);
            if config.patterns.iter().any(|pattern| pattern == secret_type) {
                return Ok(rule.action);
            }
        }
        Ok(GuardAction::Warn)
    }

    fn record_secret_hits(
        &self,
        session_id: &str,
        step_id: Option<&str>,
        hits: &[SecretScanHit],
        source: &str,
    ) -> GuardResult<Vec<GuardEvent>> {
        if hits.is_empty() {
            return Ok(Vec::new());
        }
        let rules: Vec<GuardRule> = self
            .store
            .list_guard_rules()?
            .into_iter()
            .filter(|rule| rule.enabled && rule.kind == GuardRuleKind::Secret)
            .collect();

        let mut grouped: Vec<(String, CaptureLocation, &SecretScanHit, u64)> = Vec::new();
        for hit in hits {
            if let Some(existing) = grouped.iter_mut().find(|(kind, location, _, _)| {
                kind == &hit.secret_type && *location == hit.location
            }) {
                existing.3 += 1;
            } else {
                grouped.push((hit.secret_type.clone(), hit.location, hit, 1));
            }
        }

        let mut surfaced = HashSet::new();
        for event in self.store.list_guard_events(&GuardEventListQuery {
            session_id: Some(session_id.to_string()),
            status: None,
            kind: Some(GuardRuleKind::Secret),
            limit: 500,
        })? {
            if let Some(metadata) = event.metadata {
                if let (Some(secret_type), Some(location)) = (
                    metadata.get("secretType").and_then(Value::as_str),
                    metadata.get("location").and_then(Value::as_str),
                ) {
                    surfaced.insert(format!(
                        "{}\u{0}{secret_type}\u{0}{location}",
                        event.step_id.as_deref().unwrap_or("request")
                    ));
                }
            }
        }

        let mut events = Vec::new();
        for (secret_type, location, hit, count) in grouped {
            let Some(rule) = rules.iter().find(|rule| {
                GuardRuleConfig::from_value(&rule.config)
                    .patterns
                    .iter()
                    .any(|pattern| pattern == &secret_type)
            }) else {
                continue;
            };

            let surfaced_key = format!(
                "{}\u{0}{secret_type}\u{0}{}",
                step_id.unwrap_or("request"),
                location.as_str()
            );
            if rule.action != GuardAction::Pause
                && rule.action != GuardAction::Block
                && surfaced.contains(&surfaced_key)
            {
                continue;
            }
            surfaced.insert(surfaced_key);

            events.push(self.record_event(NewGuardEvent {
                session_id: session_id.to_string(),
                step_id: step_id.map(str::to_string),
                rule_id: format!("secret-scan:{secret_type}"),
                kind: GuardRuleKind::Secret,
                action: rule.action,
                severity: rule.severity,
                status: rule.action.event_status(),
                title: format!("{}: {}", rule.name, hit.label),
                description: if rule.action == GuardAction::Pause {
                    "A high-risk secret is about to leave the machine. Approve to send it, or deny to keep it local.".to_string()
                } else {
                    "A recognizable secret pattern was found. Pandu redacts the value before storage.".to_string()
                },
                command: None,
                evidence: vec![GuardEvidence::field_excerpt(
                    location.as_str(),
                    hit.preview.clone(),
                )],
                metadata: Some(json!({
                    "guardRuleId": rule.id,
                    "source": source,
                    "secretType": secret_type,
                    "location": location.as_str(),
                    "occurrences": count,
                    "confidence": hit.confidence,
                })),
                approval_nonce: None,
                approval_expires_at: None,
            })?);
        }
        Ok(events)
    }

    fn record_matches(
        &self,
        session_id: &str,
        step_id: Option<&str>,
        rule: &GuardRule,
        matches: &[TextMatch],
        source: &str,
    ) -> GuardResult<Vec<GuardEvent>> {
        let Some(first) = matches.first() else {
            return Ok(Vec::new());
        };
        Ok(vec![
            self.record_event(NewGuardEvent {
                session_id: session_id.to_string(),
                step_id: step_id.map(str::to_string),
                rule_id: rule.id.clone(),
                kind: rule.kind,
                action: rule.action,
                severity: rule.severity,
                status: rule.action.event_status(),
                title: rule.name.clone(),
                description: rule.description.clone(),
                command: (rule.kind == GuardRuleKind::DangerousCommand)
                    .then(|| first.value.clone()),
                evidence: matches
                    .iter()
                    .map(|item| GuardEvidence::field_excerpt(&item.field, &item.excerpt))
                    .collect(),
                metadata: Some(json!({
                    "source": source,
                    "matchCount": matches.len(),
                })),
                approval_nonce: None,
                approval_expires_at: None,
            })?,
        ])
    }

    fn detect_loop(
        &self,
        session_id: &str,
        latest_user: &str,
        rules: &[GuardRule],
    ) -> GuardResult<Vec<GuardEvent>> {
        let normalized = latest_user.trim();
        if normalized.chars().count() < 20 {
            return Ok(Vec::new());
        }
        let Some(loop_rule) = rules.iter().find(|rule| rule.kind == GuardRuleKind::Loop) else {
            return Ok(Vec::new());
        };
        let config = GuardRuleConfig::from_value(&loop_rule.config);
        let threshold = config.threshold.unwrap_or(0.9);
        let min_occurrences = config.min_occurrences.unwrap_or(3) as usize;
        let window = config.window.unwrap_or(10);

        let prefix: String = normalized.chars().take(160).collect();
        let key = format!("{session_id}:{}", prefix.to_lowercase());
        let now_ms = chrono::Utc::now().timestamp_millis();
        {
            let warnings = self
                .loop_warnings
                .lock()
                .map_err(|_| DaemonError::other("loop warning lock was poisoned"))?;
            if warnings
                .get(&key)
                .is_some_and(|last| now_ms - last < LOOP_COOLDOWN_MS)
            {
                return Ok(Vec::new());
            }
        }

        let recent: Vec<String> = self
            .store
            .list_recent_prompt_texts(session_id, window)?
            .into_iter()
            .map(|prompt| latest_user_from_prompt_text(&prompt))
            .filter(|prompt| prompt.chars().count() >= 20)
            .collect();

        let mut similar = 0usize;
        let mut best = 0.0f64;
        for prompt in &recent {
            let score = token_similarity(normalized, prompt);
            if score > best {
                best = score;
            }
            if score >= threshold {
                similar += 1;
            }
        }

        if similar + 1 < min_occurrences {
            return Ok(Vec::new());
        }
        if let Ok(mut warnings) = self.loop_warnings.lock() {
            warnings.insert(key, now_ms);
        }

        Ok(vec![self.record_event(NewGuardEvent {
            session_id: session_id.to_string(),
            step_id: None,
            rule_id: loop_rule.id.clone(),
            kind: GuardRuleKind::Loop,
            action: loop_rule.action,
            severity: loop_rule.severity,
            status: loop_rule.action.event_status(),
            title: loop_rule.name.clone(),
            description: format!(
                "A near-identical instruction has been sent {} times in this session.",
                similar + 1
            ),
            command: None,
            evidence: vec![GuardEvidence::field_excerpt(
                "prompt",
                truncate_text(normalized, 500),
            )],
            metadata: Some(json!({
                "source": "request",
                "similarity": round_milli(best),
                "occurrences": similar + 1,
                "threshold": threshold,
            })),
            approval_nonce: None,
            approval_expires_at: None,
        })?])
    }

    fn refresh_events(&self, events: &[GuardEvent]) -> GuardResult<Vec<GuardEvent>> {
        let mut refreshed = Vec::with_capacity(events.len());
        for event in events {
            refreshed.push(
                self.store
                    .get_guard_event(&event.id)?
                    .unwrap_or_else(|| event.clone()),
            );
        }
        Ok(refreshed)
    }

    pub(crate) fn record_event(&self, mut input: NewGuardEvent) -> GuardResult<GuardEvent> {
        prepare_approval(&mut input, self.approval_timeout);
        let event = self.store.insert_guard_event(input)?;
        self.live.publish(
            "guard.triggered",
            Some(&event.session_id),
            event.step_id.as_deref(),
            event_payload(&event),
        );
        Ok(event)
    }

    fn emit_resolved(&self, event: &GuardEvent) {
        let mut payload = event_payload(event);
        if let Some(actor) = &event.resolved_by {
            payload["resolvedBy"] = Value::String(actor.clone());
        }
        self.live.publish(
            "guard.resolved",
            Some(&event.session_id),
            event.step_id.as_deref(),
            payload,
        );
    }
}

fn builtin_rules() -> Vec<(&'static str, GuardRuleInput)> {
    vec![
        (
            "builtin-secret-private-key",
            GuardRuleInput {
                name: "Private key in prompt".to_string(),
                description: "Pauses when a private key block is about to leave the machine. The recorder redacts it either way.".to_string(),
                kind: GuardRuleKind::Secret,
                action: GuardAction::Pause,
                severity: GuardSeverity::Critical,
                enabled: true,
                priority: 5,
                config: json!({ "patterns": ["private-key"] }),
            },
        ),
        (
            "builtin-secret-api-key",
            GuardRuleInput {
                name: "API key in prompt".to_string(),
                description: "Warns when a recognizable provider token appears in a request. The recorder redacts the value before storage.".to_string(),
                kind: GuardRuleKind::Secret,
                action: GuardAction::Warn,
                severity: GuardSeverity::High,
                enabled: true,
                priority: 10,
                config: json!({
                    "patterns": [
                        "anthropic-api-key",
                        "openai-api-key",
                        "github-token",
                        "aws-access-key",
                        "google-api-key",
                        "slack-token",
                        "bearer-token",
                        "jwt"
                    ]
                }),
            },
        ),
        (
            "builtin-dangerous-command",
            GuardRuleInput {
                name: "Destructive command".to_string(),
                description: "Pauses when the newest instruction asks for an irreversible filesystem, database, or pipe-to-shell command.".to_string(),
                kind: GuardRuleKind::DangerousCommand,
                action: GuardAction::Pause,
                severity: GuardSeverity::Critical,
                enabled: true,
                priority: 10,
                config: json!({
                    "patterns": [
                        r"\brm\s+-rf?\s+(?:/|~|\*|\.{1,2})(?:\s|$)",
                        r"\bchmod\s+-R\s+777\b",
                        r"\bmkfs(?:\.\w+)?\b",
                        r"\bdd\s+if=.+\s+of=/dev/",
                        r"\b(?:curl|wget)\s+[^\n|]+\|\s*(?:ba)?sh\b",
                        r"\b(?:shutdown|reboot|halt)\b",
                        r"\bDROP\s+(?:TABLE|DATABASE)\b"
                    ]
                }),
            },
        ),
        (
            "builtin-egress",
            GuardRuleInput {
                name: "Exfiltration endpoint".to_string(),
                description: "Pauses when a prompt mentions a paste, webhook, or tunnel service commonly used to move data out of a workspace.".to_string(),
                kind: GuardRuleKind::Egress,
                action: GuardAction::Pause,
                severity: GuardSeverity::High,
                enabled: true,
                priority: 15,
                config: json!({
                    "hosts": [
                        "pastebin.com",
                        "webhook.site",
                        "transfer.sh",
                        "ngrok.io",
                        "ngrok-free.app",
                        "requestbin.net",
                        "pipedream.net",
                        "beeceptor.com",
                        "hookbin.com",
                        "0x0.st",
                        "file.io"
                    ]
                }),
            },
        ),
        (
            "builtin-git-rewrite",
            GuardRuleInput {
                name: "Git history rewrite".to_string(),
                description: "Warns on commands that rewrite shared history or discard uncommitted work.".to_string(),
                kind: GuardRuleKind::DangerousCommand,
                action: GuardAction::Warn,
                severity: GuardSeverity::High,
                enabled: true,
                priority: 20,
                config: json!({
                    "patterns": [
                        r"\bgit\s+reset\s+--hard\b",
                        r"\bgit\s+clean\s+-[a-z]*f",
                        r"\bgit\s+push\s+(?:--force|-f)\b",
                        r"\bgit\s+branch\s+-D\b",
                        r"\bgit\s+commit\s+--amend\b",
                        r"\bgit\s+rebase\s+-i\b",
                        r"\bgit\s+filter-branch\b"
                    ]
                }),
            },
        ),
        (
            "builtin-release-command",
            GuardRuleInput {
                name: "Release or deploy command".to_string(),
                description: "Warns before publishing a package, pushing an image, or deploying to production.".to_string(),
                kind: GuardRuleKind::DangerousCommand,
                action: GuardAction::Warn,
                severity: GuardSeverity::Medium,
                enabled: true,
                priority: 30,
                config: json!({
                    "patterns": [
                        r"\bnpm\s+publish\b",
                        r"\bpnpm\s+publish\b",
                        r"\byarn\s+publish\b",
                        r"\bcargo\s+publish\b",
                        r"\bgh\s+release\s+create\b",
                        r"\bdocker\s+push\b",
                        r"\bvercel\s+--prod\b",
                        r"\bnetlify\s+deploy\b"
                    ]
                }),
            },
        ),
        (
            "builtin-loop",
            GuardRuleInput {
                name: "Repeated instruction loop".to_string(),
                description: "Warns when the same instruction is sent repeatedly without progress. Warning only: loops are often legitimate retries.".to_string(),
                kind: GuardRuleKind::Loop,
                action: GuardAction::Warn,
                severity: GuardSeverity::Medium,
                enabled: true,
                priority: 50,
                config: json!({
                    "threshold": 0.9,
                    "minOccurrences": 3,
                    "window": 10
                }),
            },
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::LiveBus;
    use crate::store::NewSession;
    use pandu_core::model::{CaptureMode, SessionSource};

    fn setup_with_timeout(timeout_ms: u64) -> (Arc<GuardService>, Arc<Store>) {
        let store = Arc::new(Store::open(":memory:").unwrap());
        let bus = LiveBus::new(store.clone(), 0);
        let service = GuardService::new(store.clone(), bus, timeout_ms);
        (service, store)
    }

    fn service() -> Arc<GuardService> {
        setup_with_timeout(100).0
    }

    fn pending_event(service: &GuardService, store: &Store) -> GuardEvent {
        let session = store
            .create_session(NewSession {
                title: "Approval flight".to_string(),
                source: SessionSource::Proxy,
                capture_mode: CaptureMode::Proxy,
                ..NewSession::default()
            })
            .unwrap();
        service
            .record_event(NewGuardEvent {
                session_id: session.id,
                step_id: None,
                rule_id: "test-pause".to_string(),
                kind: GuardRuleKind::DangerousCommand,
                action: GuardAction::Pause,
                severity: GuardSeverity::High,
                status: GuardEventStatus::Pending,
                title: "Test approval".to_string(),
                description: "A pending approval used by tests.".to_string(),
                command: Some("rm -rf build".to_string()),
                evidence: Vec::new(),
                metadata: None,
                approval_nonce: None,
                approval_expires_at: None,
            })
            .unwrap()
    }

    fn decision(
        choice: ApprovalChoice,
        nonce: Option<&str>,
        session_id: Option<&str>,
    ) -> ApprovalDecisionInput {
        ApprovalDecisionInput {
            decision: choice,
            note: None,
            actor: Some("test".to_string()),
            channel: "dashboard".to_string(),
            provider: None,
            nonce: nonce.map(str::to_string),
            session_id: session_id.map(str::to_string),
        }
    }

    #[test]
    fn seeds_all_builtin_rules() {
        let service = service();
        let rules = service.list_rules().unwrap();
        assert_eq!(rules.len(), 7);
        assert!(
            rules
                .iter()
                .all(|rule| rule.source == GuardRuleSource::Builtin)
        );
        // Seeding twice must not duplicate rows.
        service.seed_builtins();
        assert_eq!(service.list_rules().unwrap().len(), 7);
    }

    #[test]
    fn detects_secret_patterns() {
        let hits = scan_text(
            "here is sk-ant-abcdefghijklmnopqrstuvwx",
            CaptureLocation::RequestBody,
        );
        // The generic `sk-` pattern overlaps the Anthropic-specific one. Both
        // are reported, exactly like 0.1.0; previews are always masked.
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].secret_type, "anthropic-api-key");
        assert_eq!(hits[1].secret_type, "openai-api-key");
        assert!(
            hits.iter()
                .all(|hit| !hit.preview.contains("abcdefghijklmnopqrstuvwx"))
        );
    }

    #[test]
    fn builtin_private_key_rule_pauses() {
        let service = service();
        let rules = service.list_rules().unwrap();
        let rule = rules
            .iter()
            .find(|rule| rule.id == "builtin-secret-private-key")
            .unwrap();
        assert_eq!(rule.action, GuardAction::Pause);
        assert_eq!(rule.severity, GuardSeverity::Critical);
    }

    #[tokio::test]
    async fn broker_resolves_and_expires() {
        let broker = ApprovalBroker::new();
        let waiting = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .wait_for("event-1", Duration::from_millis(2_000))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(broker.resolve("event-1", ApprovalChoice::Approve).await);
        assert_eq!(waiting.await.unwrap(), ApprovalOutcome::Approved);

        let expired = broker.wait_for("event-2", Duration::from_millis(5)).await;
        assert_eq!(expired, ApprovalOutcome::Expired);
        assert!(!broker.is_pending("event-2").await);
    }

    #[tokio::test]
    async fn approvals_are_bound_to_nonce_and_session() {
        let (service, store) = setup_with_timeout(5_000);
        let event = pending_event(&service, &store);
        let nonce = event.approval_nonce.clone().expect("a pending nonce");

        // A missing or wrong nonce never resolves the event.
        let missing = service
            .resolve_event(
                &event.id,
                decision(ApprovalChoice::Approve, None, Some(&event.session_id)),
            )
            .await
            .unwrap_err();
        assert_eq!(missing.code(), "invalid_approval");
        let wrong = service
            .resolve_event(
                &event.id,
                decision(
                    ApprovalChoice::Approve,
                    Some("not-the-nonce"),
                    Some(&event.session_id),
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(wrong.code(), "invalid_approval");

        // The right nonce from the wrong session is rejected too.
        let other = store
            .create_session(NewSession {
                title: "Other flight".to_string(),
                source: SessionSource::Proxy,
                capture_mode: CaptureMode::Proxy,
                ..NewSession::default()
            })
            .unwrap();
        let wrong_session = service
            .resolve_event(
                &event.id,
                decision(ApprovalChoice::Approve, Some(&nonce), Some(&other.id)),
            )
            .await
            .unwrap_err();
        assert_eq!(wrong_session.code(), "invalid_approval");

        let still_pending = store.get_guard_event(&event.id).unwrap().unwrap();
        assert_eq!(still_pending.status, GuardEventStatus::Pending);
        assert_eq!(
            still_pending.approval_nonce.as_deref(),
            Some(nonce.as_str())
        );

        // The correct tuple resolves once.
        let resolved = service
            .resolve_event(
                &event.id,
                decision(
                    ApprovalChoice::Approve,
                    Some(&nonce),
                    Some(&event.session_id),
                ),
            )
            .await
            .unwrap();
        assert_eq!(resolved.status, GuardEventStatus::Approved);
        assert_eq!(resolved.approval_nonce, None);
    }

    #[tokio::test]
    async fn a_replayed_approval_is_rejected() {
        let (service, store) = setup_with_timeout(5_000);
        let event = pending_event(&service, &store);
        let nonce = event.approval_nonce.clone().expect("a pending nonce");

        service
            .resolve_event(
                &event.id,
                decision(
                    ApprovalChoice::Approve,
                    Some(&nonce),
                    Some(&event.session_id),
                ),
            )
            .await
            .unwrap();

        let replay = service
            .resolve_event(
                &event.id,
                decision(
                    ApprovalChoice::Approve,
                    Some(&nonce),
                    Some(&event.session_id),
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(replay.code(), "conflict");
        let stored = store.get_guard_event(&event.id).unwrap().unwrap();
        assert_eq!(stored.status, GuardEventStatus::Approved);
        assert_eq!(stored.resolved_by.as_deref(), Some("test"));
    }

    #[tokio::test]
    async fn an_expired_approval_is_rejected_and_marked_expired() {
        let (service, store) = setup_with_timeout(20);
        let event = pending_event(&service, &store);
        let nonce = event.approval_nonce.clone().expect("a pending nonce");
        tokio::time::sleep(Duration::from_millis(40)).await;

        let expired = service
            .resolve_event(
                &event.id,
                decision(
                    ApprovalChoice::Approve,
                    Some(&nonce),
                    Some(&event.session_id),
                ),
            )
            .await
            .unwrap_err();
        assert_eq!(expired.code(), "approval_expired");

        let stored = store.get_guard_event(&event.id).unwrap().unwrap();
        assert_eq!(stored.status, GuardEventStatus::Expired);
        assert_eq!(stored.approval_nonce, None);
    }

    #[tokio::test]
    async fn the_expiry_sweep_only_touches_elapsed_events() {
        let (service, store) = setup_with_timeout(20);
        let expired_event = pending_event(&service, &store);
        tokio::time::sleep(Duration::from_millis(40)).await;
        let swept = service.expire_stale_approvals().unwrap();
        assert_eq!(swept.len(), 1);
        assert_eq!(swept[0].id, expired_event.id);

        // A sweep with nothing to do is a no-op.
        assert!(service.expire_stale_approvals().unwrap().is_empty());
    }
}
