use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use cockpit_core::model::{CaptureMode, Session, SessionSource, SessionStatus};
use cockpit_core::provider::{AgentInfo, ProviderProtocol};
use serde_json::json;

use crate::error::Result;
use crate::guards::GuardService;
use crate::live::LiveBus;
use crate::snapshots::GitSnapshotService;
use crate::store::{NewSession, Store};

struct AmbientSession {
    session_id: String,
    last_used_ms: u64,
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
