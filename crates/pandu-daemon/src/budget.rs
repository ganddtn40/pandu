use std::collections::HashSet;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use pandu_core::brand;
use pandu_core::guard::{
    BudgetEnforcement, BudgetPolicy, BudgetStatus, GuardAction, GuardEvent, GuardEventListQuery,
    GuardEventStatus, GuardRuleKind, GuardSeverity, budget_period_start,
};
use pandu_core::model::Session;
use serde_json::{Value, json};

use crate::error::Result;
use crate::guards::{ApprovalBroker, ApprovalOutcome};
use crate::live::LiveBus;
use crate::store::{GuardEventPatch, NewGuardEvent, Store, now_iso};

#[derive(Debug, Clone)]
pub struct BudgetBlock {
    pub policy: BudgetPolicy,
    pub status: BudgetStatus,
}

#[derive(Debug, Clone)]
pub struct BudgetCheckResult {
    pub statuses: Vec<BudgetStatus>,
    pub blocked: Option<BudgetBlock>,
}

pub struct BudgetService {
    store: Arc<Store>,
    live: Arc<LiveBus>,
    broker: Arc<ApprovalBroker>,
    approval_timeout: Duration,
    warned: StdMutex<HashSet<String>>,
}

fn round_usd(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn round_ratio(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
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

impl BudgetService {
    pub fn new(
        store: Arc<Store>,
        live: Arc<LiveBus>,
        broker: Arc<ApprovalBroker>,
        approval_timeout_ms: u64,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            live,
            broker,
            approval_timeout: Duration::from_millis(approval_timeout_ms.max(1)),
            warned: StdMutex::new(HashSet::new()),
        })
    }

    pub fn statuses(&self, session_id: &str) -> Result<Vec<BudgetStatus>> {
        let Some(session) = self.store.get_session(session_id)? else {
            return Ok(Vec::new());
        };
        Ok(self
            .store
            .list_budget_policies()?
            .into_iter()
            .filter(|policy| policy.enabled && applies(policy, &session))
            .map(|policy| self.status_for(&policy, &session))
            .collect())
    }

    pub async fn check(&self, session_id: &str) -> Result<BudgetCheckResult> {
        let Some(session) = self.store.get_session(session_id)? else {
            return Ok(BudgetCheckResult {
                statuses: Vec::new(),
                blocked: None,
            });
        };

        let policies: Vec<BudgetPolicy> = self
            .store
            .list_budget_policies()?
            .into_iter()
            .filter(|policy| policy.enabled && applies(policy, &session))
            .collect();
        let statuses: Vec<BudgetStatus> = policies
            .iter()
            .map(|policy| self.status_for(policy, &session))
            .collect();

        for status in statuses.iter().cloned() {
            let Some(policy) = policies.iter().find(|policy| policy.id == status.policy_id) else {
                continue;
            };

            if !status.exceeded {
                if status.warning {
                    self.record_warning(session_id, policy, &status, false)?;
                }
                continue;
            }

            if self.has_override(policy, &status.period_start)? {
                continue;
            }

            if policy.enforcement == BudgetEnforcement::Block {
                self.record_exceeded(session_id, policy, &status, "block")?;
                return Ok(BudgetCheckResult {
                    statuses,
                    blocked: Some(BudgetBlock {
                        policy: policy.clone(),
                        status,
                    }),
                });
            }

            if policy.enforcement == BudgetEnforcement::Pause {
                let event = self.record_exceeded(session_id, policy, &status, "pause")?;
                let mut outcome = self.broker.wait_for(&event.id, self.approval_timeout).await;
                let current = self.store.get_guard_event(&event.id)?;
                // An approval can land between recording the event and
                // registering the waiter. Trust the stored decision.
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
                    let resolved_status = match outcome {
                        ApprovalOutcome::Approved => GuardEventStatus::Approved,
                        ApprovalOutcome::Denied => GuardEventStatus::Denied,
                        ApprovalOutcome::Expired => GuardEventStatus::Expired,
                    };
                    if let Some(updated) = self.store.update_guard_event(
                        &event.id,
                        &GuardEventPatch {
                            status: Some(resolved_status),
                            resolved_at: Some(now_iso()),
                            resolved_by: Some(brand::AUDIT_ACTOR.to_string()),
                            resolution_note: (outcome == ApprovalOutcome::Expired)
                                .then(|| "The approval window elapsed.".to_string()),
                        },
                    )? {
                        let mut payload = event_payload(&updated);
                        if let Some(actor) = &updated.resolved_by {
                            payload["resolvedBy"] = Value::String(actor.clone());
                        }
                        self.live.publish(
                            "guard.resolved",
                            Some(&updated.session_id),
                            updated.step_id.as_deref(),
                            payload,
                        );
                    }
                }
                if outcome != ApprovalOutcome::Approved {
                    return Ok(BudgetCheckResult {
                        statuses,
                        blocked: Some(BudgetBlock {
                            policy: policy.clone(),
                            status: status.clone(),
                        }),
                    });
                }
                continue;
            }

            self.record_warning(session_id, policy, &status, true)?;
        }

        Ok(BudgetCheckResult {
            statuses,
            blocked: None,
        })
    }

    fn status_for(&self, policy: &BudgetPolicy, session: &Session) -> BudgetStatus {
        let session_started = DateTime::parse_from_rfc3339(&session.started_at)
            .ok()
            .map(|value| value.with_timezone(&Utc));
        let period_start = budget_period_start(policy.period, Utc::now(), session_started);
        let period_start_iso = period_start.to_rfc3339();

        let spent = if policy.period == pandu_core::guard::BudgetPeriod::Session {
            session.totals.total_cost_usd
        } else if policy.scope == pandu_core::guard::BudgetScope::Session {
            policy
                .session_id
                .as_deref()
                .map(|id| self.store.session_cost_usd(id))
                .transpose()
                .ok()
                .flatten()
                .unwrap_or(0.0)
        } else {
            let project = (policy.scope == pandu_core::guard::BudgetScope::Project)
                .then_some(policy.project_id.as_deref())
                .flatten();
            self.store
                .spend_since(&period_start_iso, project)
                .unwrap_or_else(|error| {
                    tracing::warn!(%error, policy_id = policy.id, "could not read budget spend");
                    0.0
                })
        };

        let limit = policy.limit_usd.max(0.0);
        let usage_ratio = if limit <= 0.0 {
            if spent > 0.0 { 1.0 } else { 0.0 }
        } else {
            spent / limit
        };
        let exceeded = if limit <= 0.0 {
            spent > 0.0
        } else {
            spent >= limit
        };

        BudgetStatus {
            policy_id: policy.id.clone(),
            name: policy.name.clone(),
            limit_usd: round_usd(limit),
            spent_usd: round_usd(spent),
            remaining_usd: round_usd((limit - spent).max(0.0)),
            usage_ratio: round_ratio(usage_ratio),
            warning: !exceeded && usage_ratio >= 0.8,
            exceeded,
            enforcement: policy.enforcement,
            period: policy.period,
            period_start: period_start_iso,
        }
    }

    fn has_override(&self, policy: &BudgetPolicy, period_start: &str) -> Result<bool> {
        let events = self.store.list_guard_events(&GuardEventListQuery {
            session_id: None,
            status: Some(GuardEventStatus::Approved),
            kind: Some(GuardRuleKind::Budget),
            limit: 500,
        })?;
        Ok(events.iter().any(|event| {
            event.metadata.as_ref().is_some_and(|metadata| {
                metadata.get("policyId").and_then(Value::as_str) == Some(policy.id.as_str())
                    && metadata.get("periodStart").and_then(Value::as_str) == Some(period_start)
                    && metadata.get("kind").and_then(Value::as_str) == Some("exceeded")
            })
        }))
    }

    fn record_warning(
        &self,
        session_id: &str,
        policy: &BudgetPolicy,
        status: &BudgetStatus,
        exceeded: bool,
    ) -> Result<()> {
        let key = format!(
            "{}:{}:{}",
            policy.id,
            status.period_start,
            if exceeded { "exceeded" } else { "warning" }
        );
        {
            let mut warned = self.warned.lock().map_err(|_| {
                crate::error::DaemonError::other("budget warning lock was poisoned")
            })?;
            if !warned.insert(key) {
                return Ok(());
            }
        }

        let event = self.record_event(NewGuardEvent {
            session_id: session_id.to_string(),
            step_id: None,
            rule_id: format!("budget:{}", policy.id),
            kind: GuardRuleKind::Budget,
            action: GuardAction::Warn,
            severity: if exceeded {
                GuardSeverity::High
            } else {
                GuardSeverity::Medium
            },
            status: GuardEventStatus::Warned,
            title: format!(
                "{}: {}",
                if exceeded {
                    "Budget exceeded"
                } else {
                    "Budget warning"
                },
                policy.name
            ),
            description: format!(
                "{:.4} USD of {:.4} USD used ({}%).",
                status.spent_usd,
                status.limit_usd,
                (status.usage_ratio * 100.0).round()
            ),
            command: None,
            evidence: Vec::new(),
            metadata: Some(json!({
                "kind": if exceeded { "exceeded" } else { "warning" },
                "policyId": policy.id,
                "periodStart": status.period_start,
                "spentUsd": status.spent_usd,
                "limitUsd": status.limit_usd,
                "usageRatio": status.usage_ratio,
            })),
            approval_nonce: None,
            approval_expires_at: None,
        })?;

        self.live.publish(
            if exceeded {
                "budget.exceeded"
            } else {
                "budget.warning"
            },
            Some(&event.session_id),
            None,
            json!({
                "policyId": policy.id,
                "name": policy.name,
                "spentUsd": status.spent_usd,
                "limitUsd": status.limit_usd,
                "usageRatio": status.usage_ratio,
                "enforcement": policy.enforcement,
            }),
        );
        Ok(())
    }

    fn record_exceeded(
        &self,
        session_id: &str,
        policy: &BudgetPolicy,
        status: &BudgetStatus,
        action: &str,
    ) -> Result<GuardEvent> {
        let event = self.record_event(NewGuardEvent {
            session_id: session_id.to_string(),
            step_id: None,
            rule_id: format!("budget:{}", policy.id),
            kind: GuardRuleKind::Budget,
            action: if action == "block" {
                GuardAction::Block
            } else {
                GuardAction::Pause
            },
            severity: GuardSeverity::High,
            status: if action == "block" {
                GuardEventStatus::Blocked
            } else {
                GuardEventStatus::Pending
            },
            title: format!("Budget exceeded: {}", policy.name),
            description: format!(
                "{:.4} USD of {:.4} USD used. Enforcement: {}.",
                status.spent_usd,
                status.limit_usd,
                policy.enforcement.as_str()
            ),
            command: None,
            evidence: Vec::new(),
            metadata: Some(json!({
                "kind": "exceeded",
                "policyId": policy.id,
                "periodStart": status.period_start,
                "spentUsd": status.spent_usd,
                "limitUsd": status.limit_usd,
                "usageRatio": status.usage_ratio,
            })),
            approval_nonce: None,
            approval_expires_at: None,
        })?;

        self.live.publish(
            "budget.exceeded",
            Some(&event.session_id),
            None,
            json!({
                "policyId": policy.id,
                "name": policy.name,
                "spentUsd": status.spent_usd,
                "limitUsd": status.limit_usd,
                "usageRatio": status.usage_ratio,
                "enforcement": policy.enforcement,
            }),
        );
        Ok(event)
    }

    fn record_event(&self, mut input: NewGuardEvent) -> Result<GuardEvent> {
        crate::guards::prepare_approval(&mut input, self.approval_timeout);
        let event = self.store.insert_guard_event(input)?;
        self.live.publish(
            "guard.triggered",
            Some(&event.session_id),
            event.step_id.as_deref(),
            event_payload(&event),
        );
        Ok(event)
    }
}

fn applies(policy: &BudgetPolicy, session: &Session) -> bool {
    match policy.scope {
        pandu_core::guard::BudgetScope::Session => {
            policy.session_id.as_deref() == Some(session.id.as_str())
        }
        // v1 sessions do not carry a project id yet, so a project-scoped
        // policy can be stored but never matches.
        pandu_core::guard::BudgetScope::Project => false,
        pandu_core::guard::BudgetScope::Global => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guards::GuardService;
    use crate::store::{BeginStep, CompleteStep, NewSession, Store};
    use pandu_core::guard::{BudgetPeriod, BudgetPolicyInput, BudgetScope, GuardEventListQuery};
    use pandu_core::model::{
        CaptureMode, CapturedRequest, FinishReason, SessionSource, StepKind, StepStatus,
    };
    use pandu_core::provider::ProviderProtocol;
    use pandu_core::usage::TokenUsage;
    use std::collections::BTreeMap;

    fn setup() -> (Arc<Store>, Arc<BudgetService>, String) {
        setup_with_timeout(100)
    }

    fn setup_with_timeout(timeout_ms: u64) -> (Arc<Store>, Arc<BudgetService>, String) {
        let store = Arc::new(Store::open(":memory:").unwrap());
        let live = LiveBus::new(store.clone(), 0);
        let guards = GuardService::new(store.clone(), live.clone(), timeout_ms);
        let budgets = BudgetService::new(store.clone(), live, guards.broker(), timeout_ms);
        let session = store
            .create_session(NewSession {
                title: "Budget flight".to_string(),
                source: SessionSource::Proxy,
                capture_mode: CaptureMode::Proxy,
                ..NewSession::default()
            })
            .unwrap();
        (store, budgets, session.id)
    }

    /// Record a completed step so the session's stored spend becomes non-zero.
    fn record_spend(store: &Store, session_id: &str, cost_usd: f64) {
        let step = store
            .begin_step(BeginStep {
                session_id: session_id.to_string(),
                kind: StepKind::Model,
                provider: Some("openai".to_string()),
                model: Some("gpt-4.1".to_string()),
                request: CapturedRequest {
                    protocol: ProviderProtocol::Openai,
                    method: "POST".to_string(),
                    path: "/v1/chat/completions".to_string(),
                    model: Some("gpt-4.1".to_string()),
                    stream: false,
                    headers: BTreeMap::new(),
                    body: None,
                    system_prompt: None,
                    prompt_text: Some("Hello".to_string()),
                    redaction_count: 0,
                },
            })
            .unwrap();
        store
            .complete_step(
                &step.id,
                CompleteStep {
                    status: StepStatus::Completed,
                    response_status: 200,
                    response_headers: BTreeMap::new(),
                    response_text: Some("Hi".to_string()),
                    response_thinking: None,
                    finish_reason: Some(FinishReason::Stop),
                    usage: TokenUsage::ZERO,
                    cost_usd: Some(cost_usd),
                    cost_known: true,
                    model: None,
                    error: None,
                    ttft_ms: None,
                    latency_ms: 1,
                    metadata: None,
                },
                0,
            )
            .unwrap()
            .unwrap();
    }

    fn policy(
        scope: BudgetScope,
        session_id: Option<String>,
        limit_usd: f64,
        enforcement: BudgetEnforcement,
    ) -> BudgetPolicyInput {
        BudgetPolicyInput {
            name: "Test budget".to_string(),
            scope,
            period: if scope == BudgetScope::Session {
                BudgetPeriod::Session
            } else {
                BudgetPeriod::Day
            },
            project_id: None,
            session_id,
            limit_usd,
            enforcement,
            enabled: true,
        }
    }

    #[tokio::test]
    async fn warns_at_eighty_percent() {
        let (store, budgets, session_id) = setup();
        store
            .create_budget_policy(&policy(
                BudgetScope::Global,
                None,
                1.0,
                BudgetEnforcement::Warn,
            ))
            .unwrap();
        // Zero spend is below the warning threshold.
        let result = budgets.check(&session_id).await.unwrap();
        assert_eq!(result.statuses.len(), 1);
        assert!(!result.statuses[0].warning);
        assert!(result.blocked.is_none());
    }

    #[tokio::test]
    async fn warns_when_spend_crosses_eighty_percent() {
        let (store, budgets, session_id) = setup();
        store
            .create_budget_policy(&policy(
                BudgetScope::Global,
                None,
                1.0,
                BudgetEnforcement::Warn,
            ))
            .unwrap();
        record_spend(&store, &session_id, 0.85);

        let result = budgets.check(&session_id).await.unwrap();
        let status = &result.statuses[0];
        assert!(status.warning);
        assert!(!status.exceeded);
        assert_eq!(status.spent_usd, 0.85);
        assert_eq!(status.remaining_usd, 0.15);
        assert_eq!(status.usage_ratio, 0.85);
        assert!(result.blocked.is_none());

        // The warning is recorded once, not on every request.
        let events = store
            .list_guard_events(&GuardEventListQuery {
                session_id: Some(session_id.clone()),
                ..GuardEventListQuery::default()
            })
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, pandu_core::guard::GuardRuleKind::Budget);
        budgets.check(&session_id).await.unwrap();
        assert_eq!(
            store
                .list_guard_events(&GuardEventListQuery {
                    session_id: Some(session_id),
                    ..GuardEventListQuery::default()
                })
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn blocks_when_the_policy_says_block() {
        let (store, budgets, session_id) = setup();
        store
            .create_budget_policy(&policy(
                BudgetScope::Session,
                Some(session_id.clone()),
                0.0,
                BudgetEnforcement::Block,
            ))
            .unwrap();
        // A zero limit with zero spend is not exceeded.
        let result = budgets.check(&session_id).await.unwrap();
        assert!(result.blocked.is_none());
        assert_eq!(result.statuses[0].remaining_usd, 0.0);

        record_spend(&store, &session_id, 0.01);
        let result = budgets.check(&session_id).await.unwrap();
        let blocked = result.blocked.expect("the zero budget should block");
        assert_eq!(blocked.policy.name, "Test budget");
        assert!(blocked.status.exceeded);
        assert_eq!(blocked.status.spent_usd, 0.01);
    }

    #[tokio::test]
    async fn a_pause_budget_blocks_when_approval_expires() {
        let (store, budgets, session_id) = setup_with_timeout(5);
        store
            .create_budget_policy(&policy(
                BudgetScope::Session,
                Some(session_id.clone()),
                0.0,
                BudgetEnforcement::Pause,
            ))
            .unwrap();
        record_spend(&store, &session_id, 0.01);

        let result = budgets.check(&session_id).await.unwrap();
        assert!(result.blocked.is_some());
        let events = store
            .list_guard_events(&GuardEventListQuery {
                session_id: Some(session_id),
                ..GuardEventListQuery::default()
            })
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].status,
            pandu_core::guard::GuardEventStatus::Expired
        );
    }
}
