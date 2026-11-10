use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use cockpit_core::cost::{canonical_provider, find_builtin_model};
use cockpit_core::model::{CaptureMode, Session, SessionSource, SessionStatus};
use cockpit_core::provider::{AgentInfo, ProviderProtocol};
use serde::Serialize;
use serde_json::json;

use crate::error::Result;
use crate::guards::GuardService;
use crate::live::LiveBus;
use crate::snapshots::GitSnapshotService;
use crate::store::{NewRemoteAudit, NewSession, Store, now_iso};

struct AmbientSession {
    session_id: String,
    last_used_ms: u64,
}

/// A host-only model/effort override for one active flight.
///
/// The override lives in memory only. It is deliberately not persisted:
/// ending the flight (or restarting the daemon) drops it, so a stale override
/// can never surprise the next request. Every change is still audited through
/// the hash-chained `remote_audit` table.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_effort: Option<String>,
    pub set_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelOverrideError {
    SessionNotFound,
    SessionEnded,
    ModelNotFound {
        model: String,
    },
    ProviderMismatch {
        provider: String,
        model: String,
    },
    EffortUnsupported {
        model: String,
        effort: String,
        levels: Vec<String>,
    },
    EffortNotSupported {
        model: String,
    },
    Storage(String),
}

impl ModelOverrideError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SessionNotFound => "session_not_found",
            Self::SessionEnded => "session_ended",
            Self::ModelNotFound { .. } => "model_not_found",
            Self::ProviderMismatch { .. } => "provider_mismatch",
            Self::EffortUnsupported { .. } => "effort_unsupported",
            Self::EffortNotSupported { .. } => "effort_not_supported",
            Self::Storage(_) => "storage_error",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::SessionNotFound => "That flight does not exist.".to_string(),
            Self::SessionEnded => "That flight has already ended.".to_string(),
            Self::ModelNotFound { model } => {
                format!("Cockpit does not have verified data for the model `{model}`.")
            }
            Self::ProviderMismatch { provider, model } => format!(
                "`{model}` belongs to a different provider. This flight can only switch models inside `{provider}`."
            ),
            Self::EffortUnsupported {
                model,
                effort,
                levels,
            } => format!(
                "`{model}` does not support effort `{effort}`. Allowed levels: {}.",
                levels.join(", ")
            ),
            Self::EffortNotSupported { model } => {
                format!("`{model}` does not expose a reasoning effort control.")
            }
            Self::Storage(error) => format!("Cockpit could not store the override: {error}"),
        }
    }
}

impl std::fmt::Display for ModelOverrideError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl From<crate::error::DaemonError> for ModelOverrideError {
    fn from(error: crate::error::DaemonError) -> Self {
        Self::Storage(error.to_string())
    }
}

/// Owns the implicit "ambient" flight per protocol.
///
/// When an agent sends a request without an explicit `/s/:id` prefix, Cockpit
/// keeps one active flight per protocol and reuses it until the idle timeout.
pub struct SessionManager {
    store: Arc<Store>,
    bus: Arc<LiveBus>,
    idle_timeout_ms: u64,
    workspace_path: Option<PathBuf>,
    guards: Option<Arc<GuardService>>,
    snapshots: Option<Arc<GitSnapshotService>>,
    ambient: Mutex<HashMap<ProviderProtocol, AmbientSession>>,
    overrides: Mutex<HashMap<String, ModelOverride>>,
}

impl SessionManager {
    pub fn new(
        store: Arc<Store>,
        bus: Arc<LiveBus>,
        idle_timeout_ms: u64,
        workspace_path: Option<PathBuf>,
        guards: Option<Arc<GuardService>>,
        snapshots: Option<Arc<GitSnapshotService>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            bus,
            idle_timeout_ms,
            workspace_path,
            guards,
            snapshots,
            ambient: Mutex::new(HashMap::new()),
            overrides: Mutex::new(HashMap::new()),
        })
    }

    pub fn resolve_ambient(
        &self,
        protocol: ProviderProtocol,
        agent: Option<AgentInfo>,
    ) -> Result<Session> {
        {
            let ambient = self.ambient.lock().expect("session map lock");
            if let Some(existing) = ambient.get(&protocol) {
                if let Some(session) = self.store.get_session(&existing.session_id)? {
                    if session.status == SessionStatus::Active {
                        drop(ambient);
                        self.mark_used(&session.id);
                        return Ok(session);
                    }
                }
            }
        }

        self.ambient
            .lock()
            .expect("session map lock")
            .remove(&protocol);

        let title = match protocol {
            ProviderProtocol::Openai => "Local OpenAI proxy",
            ProviderProtocol::Anthropic => "Local Anthropic proxy",
            ProviderProtocol::Gemini => "Local Gemini proxy",
        };
        let session = self.store.create_session(NewSession {
            title: title.to_string(),
            source: SessionSource::Proxy,
            capture_mode: CaptureMode::Proxy,
            protocol: Some(protocol),
            provider: Some(protocol.default_provider().to_string()),
            agent,
            workspace_path: self
                .workspace_path
                .as_ref()
                .map(|path| path.display().to_string()),
            tags: vec!["ambient".to_string()],
            metadata: Some(json!({ "autoCreated": true, "protocol": protocol.as_str() })),
            ..NewSession::default()
        })?;

        self.ambient.lock().expect("session map lock").insert(
            protocol,
            AmbientSession {
                session_id: session.id.clone(),
                last_used_ms: now_ms(),
            },
        );

        self.emit_started(&session);
        Ok(session)
    }

    pub fn mark_used(&self, session_id: &str) {
        let mut ambient = self.ambient.lock().expect("session map lock");
        for entry in ambient.values_mut() {
            if entry.session_id == session_id {
                entry.last_used_ms = now_ms();
                return;
            }
        }
    }

    /// The active override for a flight, if the host turned one on.
    pub fn model_override(&self, session_id: &str) -> Option<ModelOverride> {
        self.overrides
            .lock()
            .expect("override map lock")
            .get(session_id)
            .cloned()
    }

    /// Validate and install a host-only model/effort override.
    ///
    /// A switch is only accepted when the target model exists in the bundled,
    /// verified `models.json`, belongs to the same provider as the flight, and
    /// supports the requested effort level. Every attempt — accepted or
    /// denied — is written to the audit chain.
    pub fn set_model_override(
        &self,
        session_id: &str,
        model: &str,
        effort: Option<&str>,
    ) -> std::result::Result<ModelOverride, ModelOverrideError> {
        let model = model.trim();
        let effort = effort
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase());

        let result = self.validate_model_override(session_id, model, effort.as_deref());
        match result {
            Ok(override_) => {
                self.overrides
                    .lock()
                    .expect("override map lock")
                    .insert(session_id.to_string(), override_.clone());
                self.audit_override(
                    "model.override.set",
                    session_id,
                    json!({
                        "sessionId": session_id,
                        "fromModel": override_.original_model,
                        "toModel": override_.model,
                        "fromEffort": override_.original_effort,
                        "toEffort": override_.effort,
                        "actor": "host",
                    }),
                );
                self.bus.publish(
                    "session.updated",
                    Some(session_id),
                    None,
                    json!({ "modelOverride": override_ }),
                );
                Ok(override_)
            }
            Err(error) => {
                self.audit_override(
                    "model.override.denied",
                    session_id,
                    json!({
                        "sessionId": session_id,
                        "model": model,
                        "effort": effort,
                        "reason": error.code(),
                        "actor": "host",
                    }),
                );
                Err(error)
            }
        }
    }

    /// Validate a candidate override without installing it. Used by the
    /// confirmation preview so the UI can show the relative cost first.
    pub fn preview_model_override(
        &self,
        session_id: &str,
        model: &str,
        effort: Option<&str>,
    ) -> std::result::Result<ModelOverride, ModelOverrideError> {
        let effort = effort
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase());
        self.validate_model_override(session_id, model.trim(), effort.as_deref())
    }

    fn validate_model_override(
        &self,
        session_id: &str,
        model: &str,
        effort: Option<&str>,
    ) -> std::result::Result<ModelOverride, ModelOverrideError> {
        let session = self
            .store
            .get_session(session_id)?
            .ok_or(ModelOverrideError::SessionNotFound)?;
        if session.status != SessionStatus::Active {
            return Err(ModelOverrideError::SessionEnded);
        }
        if model.is_empty() {
            return Err(ModelOverrideError::ModelNotFound {
                model: model.to_string(),
            });
        }

        let provider = session
            .provider
            .clone()
            .or_else(|| {
                session
                    .protocol
                    .map(|protocol| protocol.default_provider().to_string())
            })
            .unwrap_or_else(|| "openai".to_string());
        let provider = canonical_provider(&provider);

        let Some(pricing) = find_builtin_model(model, Some(provider.as_str())) else {
            if find_builtin_model(model, None).is_some() {
                return Err(ModelOverrideError::ProviderMismatch {
                    provider,
                    model: model.to_string(),
                });
            }
            return Err(ModelOverrideError::ModelNotFound {
                model: model.to_string(),
            });
        };

        match (pricing.effort.as_ref(), effort) {
            (Some(control), Some(level)) if !control.supports(level) => {
                return Err(ModelOverrideError::EffortUnsupported {
                    model: pricing.model.clone(),
                    effort: level.to_string(),
                    levels: control.levels.clone(),
                });
            }
            (None, Some(_)) => {
                return Err(ModelOverrideError::EffortNotSupported {
                    model: pricing.model.clone(),
                });
            }
            _ => {}
        }

        Ok(ModelOverride {
            session_id: session_id.to_string(),
            provider,
            model: pricing.model.clone(),
            effort: effort.map(str::to_string),
            original_model: session.model.clone(),
            original_effort: None,
            set_at: now_iso(),
        })
    }

    /// Drop an override (host "turn off" or the end of the flight).
    pub fn clear_model_override(&self, session_id: &str) -> Option<ModelOverride> {
        self.remove_model_override(session_id, "host")
    }

    fn remove_model_override(&self, session_id: &str, reason: &str) -> Option<ModelOverride> {
        let removed = self
            .overrides
            .lock()
            .expect("override map lock")
            .remove(session_id);
        if let Some(existing) = &removed {
            self.audit_override(
                "model.override.cleared",
                session_id,
                json!({
                    "sessionId": session_id,
                    "model": existing.model,
                    "effort": existing.effort,
                    "reason": reason,
                    "actor": "host",
                }),
            );
            self.bus.publish(
                "session.updated",
                Some(session_id),
                None,
                json!({ "modelOverride": null }),
            );
        }
        removed
    }

    /// Record a model event that is not an override, such as a PTY switch.
    pub fn audit_model_event(&self, event: &str, session_id: &str, detail: serde_json::Value) {
        self.audit_override(event, session_id, detail);
    }

    fn audit_override(&self, event: &str, session_id: &str, detail: serde_json::Value) {
        let row = NewRemoteAudit {
            id: uuid::Uuid::new_v4().to_string(),
            at: now_iso(),
            event: event.to_string(),
            device_id: None,
            device_name: None,
            ip: None,
            detail: detail.to_string(),
            size_bytes: None,
            content_hash: None,
        };
        if let Err(error) = self.store.insert_remote_audit(&row) {
            tracing::warn!(%error, session_id, "could not append a model override audit row");
        }
    }

    /// Close ambient flights that have been idle longer than the timeout.
    pub fn sweep(&self) -> Vec<String> {
        let now = now_ms();
        let expired: Vec<(ProviderProtocol, String)> = {
            let ambient = self.ambient.lock().expect("session map lock");
            ambient
                .iter()
                .filter(|(_, entry)| now.saturating_sub(entry.last_used_ms) >= self.idle_timeout_ms)
                .map(|(protocol, entry)| (*protocol, entry.session_id.clone()))
                .collect()
        };

        let mut ended = Vec::new();
        for (protocol, session_id) in expired {
            if let Some(session) = self.end_session(&session_id, SessionStatus::Completed) {
                ended.push(session.id);
            }
            self.ambient
                .lock()
                .expect("session map lock")
                .remove(&protocol);
        }
        ended
    }

    pub fn end_session(&self, id: &str, status: SessionStatus) -> Option<Session> {
        // A host override never outlives its flight, even if the session was
        // already closed by another path.
        self.remove_model_override(id, "session_ended");
        let before = self.store.get_session(id).ok().flatten()?;
        if before.status != SessionStatus::Active {
            return Some(before);
        }
        let session = self.store.end_session(id, status).ok().flatten()?;
        self.bus.publish(
            "session.completed",
            Some(&session.id),
            None,
            json!({
                "status": session.status.as_str(),
                "durationMs": session.duration_ms,
                "totals": totals_payload(&session),
            }),
        );
        if let Some(snapshots) = &self.snapshots {
            snapshots.note_session_ended(&session.id);
        }
        if let Some(guards) = &self.guards {
            let guards = guards.clone();
            let session_id = session.id.clone();
            tokio::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || {
                    if let Err(error) = guards.scan_session(&session_id) {
                        tracing::warn!(%error, session_id, "could not scan a finished session for secrets");
                    }
                })
                .await;
            });
        }
        Some(session)
    }

    pub fn shutdown(&self) {
        self.ambient.lock().expect("session map lock").clear();
        if let Ok(sessions) = self.store.list_active_sessions() {
            for session in sessions {
                self.end_session(&session.id, SessionStatus::Completed);
            }
        }
    }

    fn emit_started(&self, session: &Session) {
        self.bus.publish(
            "session.started",
            Some(&session.id),
            None,
            json!({
                "title": session.title,
                "source": session.source.as_str(),
                "captureMode": session.capture_mode.as_str(),
                "status": session.status.as_str(),
                "protocol": session.protocol.map(|protocol| protocol.as_str()),
                "provider": session.provider,
                "model": session.model,
                "agent": session.agent.as_ref().and_then(|agent| agent.name.clone()),
            }),
        );
    }
}

pub fn totals_payload(session: &Session) -> serde_json::Value {
    json!({
        "stepCount": session.totals.step_count,
        "modelCallCount": session.totals.model_call_count,
        "toolCallCount": session.totals.tool_call_count,
        "inputTokens": session.totals.input_tokens,
        "outputTokens": session.totals.output_tokens,
        "cacheReadTokens": session.totals.cache_read_tokens,
        "cacheWriteTokens": session.totals.cache_write_tokens,
        "reasoningTokens": session.totals.reasoning_tokens,
        "totalCostUsd": session.totals.total_cost_usd,
        "unknownCostCalls": session.totals.unknown_cost_calls,
        "errorCount": session.totals.error_count,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
