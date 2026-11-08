use std::collections::BTreeMap;

use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use cockpit_core::guard::{
    GuardAction, GuardEventStatus, GuardEvidence, GuardRuleKind, GuardSeverity,
};
use cockpit_core::ids::{create_id, is_id};
use cockpit_core::model::{
    CaptureMode, CapturedRequest, FinishReason, Session, SessionSource, SessionStatus, StepKind,
    StepStatus, StreamChunk, StreamChunkKind, ToolCall, ToolCallStatus,
};
use cockpit_core::provider::{AgentInfo, DetectedFrom, ProviderProtocol};
use cockpit_core::redact::{CaptureLocation, RedactionRow};
use cockpit_core::replay::{FileChangeType, SnapshotKind};
use cockpit_core::usage::TokenUsage;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;

use crate::error::DaemonError;
use crate::state::AppState;
use crate::store::{BeginStep, CompleteStep, NewFileChange, NewSession, NewSnapshot, now_iso};

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    code: &'static str,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "error": {
                    "code": self.code,
                    "message": self.message,
                }
            })),
        )
            .into_response()
    }
}

fn store_error(error: DaemonError) -> ApiError {
    tracing::error!(%error, "a database operation failed");
    ApiError::internal("Cockpit could not read its local database.")
}

pub async fn health(State(state): State<AppState>) -> Response {
    let database_ok = state.store.ping();
    let status = if database_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "ok": database_ok,
            "version": cockpit_core::VERSION,
            "database": if database_ok { "ok" } else { "unavailable" },
            "uptimeMs": state.started_at.elapsed().as_millis() as u64,
            "demoMode": state.config.demo_mode,
        })),
    )
        .into_response()
}

pub async fn overview(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let stats = state.store.overview().map_err(store_error)?;
    let active_sessions = state
        .store
        .list_sessions(20, 0, Some(SessionStatus::Active))
        .map_err(store_error)?;
    let recent_sessions = state
        .store
        .list_sessions(10, 0, None)
        .map_err(store_error)?;

    Ok(Json(json!({
        "stats": stats,
        "activeSessions": active_sessions,
        "recentSessions": recent_sessions,
    })))
}

pub async fn stats(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let stats = state.store.overview().map_err(store_error)?;
    Ok(Json(json!(stats)))
}

#[derive(Debug, Deserialize)]
pub struct SessionQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub status: Option<String>,
}

pub async fn list_sessions(
    State(state): State<AppState>,
    Query(query): Query<SessionQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset = query.offset.unwrap_or(0);
    let status = match query.status.as_deref() {
        Some(value) if !value.trim().is_empty() => match SessionStatus::parse(value.trim()) {
            Some(status) => Some(status),
            None => {
                return Err(ApiError::bad_request(
                    "status must be one of active, completed, failed, or killed",
                ));
            }
        },
        _ => None,
    };

    let sessions = state
        .store
        .list_sessions(limit, offset, status)
        .map_err(store_error)?;
    let total = state.store.count_sessions().map_err(store_error)?;

    Ok(Json(json!({
        "sessions": sessions,
        "total": total,
        "limit": limit,
        "offset": offset,
    })))
}

pub async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The session id is not valid."));
    }
    let session = state
        .store
        .get_session(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That flight does not exist."))?;
    Ok(Json(json!(session)))
}

pub async fn list_steps(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The session id is not valid."));
    }
    if state.store.get_session(&id).map_err(store_error)?.is_none() {
        return Err(ApiError::not_found("That flight does not exist."));
    }
    let steps = state.store.list_steps(&id, 1_000).map_err(store_error)?;
    Ok(Json(json!({ "steps": steps })))
}

pub async fn get_step(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The step id is not valid."));
    }
    let step = state
        .store
        .get_step(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That step does not exist."))?;
    let redactions = state.store.list_redactions(&id).map_err(store_error)?;
    let stream_chunks = state.store.list_stream_chunks(&id).map_err(store_error)?;
    let tool_calls = state.store.list_tool_calls(&id).map_err(store_error)?;

    Ok(Json(json!({
        "step": step,
        "redactions": redactions,
        "streamChunks": stream_chunks,
        "toolCalls": tool_calls,
    })))
}

pub async fn end_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The session id is not valid."));
    }
    let session = state
        .sessions
        .end_session(&id, SessionStatus::Completed)
        .ok_or_else(|| ApiError::not_found("That flight does not exist."))?;
    Ok(Json(json!({ "session": session })))
}

pub async fn get_settings(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let settings = state.store.all_settings().map_err(store_error)?;
    Ok(Json(json!({ "settings": settings })))
}

pub async fn put_settings(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let Some(settings) = body.as_object() else {
        return Err(ApiError::bad_request(
            "Settings must be sent as a JSON object of key/value pairs.",
        ));
    };

    for (key, value) in settings {
        let key = key.trim();
        if key.is_empty() || key.len() > 100 {
            return Err(ApiError::bad_request(
                "Setting keys must be between 1 and 100 characters.",
            ));
        }
        let stored = match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        if stored.len() > 100_000 {
            return Err(ApiError::bad_request("That setting value is too large."));
        }
        state.store.set_setting(key, &stored).map_err(store_error)?;
    }

    let settings = state.store.all_settings().map_err(store_error)?;
    Ok(Json(json!({ "settings": settings })))
}

pub async fn seed_demo(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let sessions = seed_demo_sessions(&state)?;
    Ok(Json(json!({
        "seeded": sessions.len(),
        "sessions": sessions,
    })))
}

/// Every adapter, its install status, and any file that failed to load.
pub async fn list_adapters(State(state): State<AppState>) -> Json<Value> {
    let statuses = crate::adapters::statuses(&state.adapters);
    let installed = statuses.iter().filter(|status| status.installed).count();
    let verified = statuses.iter().filter(|status| status.verified).count();
    Json(json!({
        "adapters": statuses,
        "issues": state.adapters.issues(),
        "installed": installed,
        "verified": verified,
        "total": statuses.len(),
        "logWatch": state.logwatch.status(),
        "logWatchEnabled": state.config.log_watch,
    }))
}

/// One adapter, including its full TOML data and detection result.
pub async fn get_adapter(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let adapter = state
        .adapters
        .get(&id)
        .ok_or_else(|| ApiError::not_found("That adapter does not exist."))?;
    Ok(Json(json!({
        "adapter": adapter,
        "status": crate::adapters::status_for(adapter),
    })))
}

/// Run one read-only log-watch pass right now. The UI uses this after the user
/// changes an adapter; the background watcher keeps polling on its own.
pub async fn scan_log_watch(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let watcher = state.logwatch.clone();
    let status = tokio::task::spawn_blocking(move || watcher.scan())
        .await
        .map_err(|error| ApiError::internal(format!("The log scan could not run: {error}")))?;
    Ok(Json(json!({ "status": status })))
}

pub async fn log_watch_status(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "enabled": state.config.log_watch,
        "status": state.logwatch.status(),
    }))
}

/// Issue a short-lived pairing code for the phone companion.
pub async fn pair_code(State(state): State<AppState>) -> Json<Value> {
    let issued = state.pairing.issue_code();
    Json(json!({
        "code": issued.code,
        "expiresAt": issued.expires_at,
        "expiresInSeconds": issued.expires_in_seconds,
        "attemptsRemaining": issued.attempts_remaining,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairClaim {
    pub code: String,
    #[serde(default)]
    pub device_name: Option<String>,
}

pub async fn pair_claim(
    State(state): State<AppState>,
    Json(body): Json<PairClaim>,
) -> Result<Json<Value>, ApiError> {
    let claimed = state
        .pairing
        .claim(&body.code, body.device_name.as_deref())
        .map_err(|error| {
            ApiError::new(StatusCode::BAD_REQUEST, "pairing_failed", error.to_string())
        })?;
    Ok(Json(json!({
        "token": claimed.token,
        "deviceName": claimed.device_name,
        "claimedAt": claimed.claimed_at,
    })))
}

pub async fn pair_status(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": state.pairing.status(),
        "devices": state.pairing.paired_devices(),
    }))
}

// ----- Guards -------------------------------------------------------------

fn guard_error(error: crate::guards::GuardError) -> ApiError {
    let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    ApiError::new(status, error.code(), error.to_string())
}

pub async fn list_guard_rules(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rules = state.guards.list_rules().map_err(guard_error)?;
    Ok(Json(json!({ "rules": rules })))
}

pub async fn create_guard_rule(
    State(state): State<AppState>,
    Json(input): Json<cockpit_core::guard::GuardRuleInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if input.name.trim().is_empty() {
        return Err(ApiError::bad_request("A guard rule needs a name."));
    }
    let rule = state.guards.create_rule(input).map_err(guard_error)?;
    Ok((StatusCode::CREATED, Json(json!({ "rule": rule }))))
}

pub async fn update_guard_rule(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(patch): Json<cockpit_core::guard::GuardRulePatch>,
) -> Result<Json<Value>, ApiError> {
    let rule = state.guards.update_rule(&id, patch).map_err(guard_error)?;
    Ok(Json(json!({ "rule": rule })))
}

pub async fn delete_guard_rule(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state.guards.delete_rule(&id).map_err(guard_error)?;
    Ok(Json(json!({ "removed": true, "id": id })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardEventQuery {
    pub session_id: Option<String>,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub limit: Option<u32>,
}

pub async fn list_guard_events(
    State(state): State<AppState>,
    Query(query): Query<GuardEventQuery>,
) -> Result<Json<Value>, ApiError> {
    let status = match query.status.as_deref() {
        Some(value) if !value.trim().is_empty() => Some(
            cockpit_core::guard::GuardEventStatus::parse(value.trim()).ok_or_else(|| {
                ApiError::bad_request("status must be a known guard event status")
            })?,
        ),
        _ => None,
    };
    let kind = match query.kind.as_deref() {
        Some(value) if !value.trim().is_empty() => Some(
            cockpit_core::guard::GuardRuleKind::parse(value.trim())
                .ok_or_else(|| ApiError::bad_request("kind must be a known guard rule kind"))?,
        ),
        _ => None,
    };
    let events = state
        .guards
        .list_events(&cockpit_core::guard::GuardEventListQuery {
            session_id: query.session_id,
            status,
            kind,
            limit: query.limit.unwrap_or(100),
        })
        .map_err(guard_error)?;
    Ok(Json(json!({ "events": events })))
}

pub async fn guard_decision(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(decision): Json<cockpit_core::guard::ApprovalDecisionInput>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The guard event id is not valid."));
    }
    let event = state
        .guards
        .resolve_event(&id, decision)
        .await
        .map_err(guard_error)?;
    Ok(Json(json!({ "event": event })))
}

// ----- Budgets ------------------------------------------------------------

pub async fn list_budgets(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let policies = state.store.list_budget_policies().map_err(store_error)?;
    Ok(Json(json!({ "policies": policies })))
}

fn validate_budget(limit_usd: f64, name: &str) -> Result<(), ApiError> {
    if !limit_usd.is_finite() || limit_usd < 0.0 {
        return Err(ApiError::bad_request(
            "The budget limit must be a non-negative number.",
        ));
    }
    if name.trim().is_empty() {
        return Err(ApiError::bad_request("A budget policy needs a name."));
    }
    Ok(())
}

pub async fn create_budget(
    State(state): State<AppState>,
    Json(input): Json<cockpit_core::guard::BudgetPolicyInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_budget(input.limit_usd, &input.name)?;
    let policy = state
        .store
        .create_budget_policy(&input)
        .map_err(store_error)?;
    Ok((StatusCode::CREATED, Json(json!({ "policy": policy }))))
}

pub async fn update_budget(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(patch): Json<cockpit_core::guard::BudgetPolicyPatch>,
) -> Result<Json<Value>, ApiError> {
    if let Some(limit) = patch.limit_usd {
        if !limit.is_finite() || limit < 0.0 {
            return Err(ApiError::bad_request(
                "The budget limit must be a non-negative number.",
            ));
        }
    }
    let policy = state
        .store
        .update_budget_policy(&id, &patch)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("The budget policy was not found."))?;
    Ok(Json(json!({ "policy": policy })))
}

pub async fn delete_budget(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let removed = state.store.delete_budget_policy(&id).map_err(store_error)?;
    if !removed {
        return Err(ApiError::not_found("The budget policy was not found."));
    }
    Ok(Json(json!({ "removed": true, "id": id })))
}

pub async fn session_budgets(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The session id is not valid."));
    }
    if state.store.get_session(&id).map_err(store_error)?.is_none() {
        return Err(ApiError::not_found("That flight does not exist."));
    }
    let statuses = state.budgets.statuses(&id).map_err(store_error)?;
    Ok(Json(json!({ "statuses": statuses })))
}

// ----- Replay and secret scans -------------------------------------------

pub async fn session_replay(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The session id is not valid."));
    }
    let session = state
        .store
        .get_session(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That flight does not exist."))?;
    let steps = state.store.list_steps(&id, 2_000).map_err(store_error)?;
    let snapshots = state
        .store
        .list_snapshots(&id)
        .map_err(store_error)?
        .into_iter()
        .map(|snapshot| snapshot.summary())
        .collect::<Vec<_>>();
    Ok(Json(json!(cockpit_core::replay::SessionReplayResponse {
        session,
        steps,
        snapshots,
        // Replay forks are not part of 0.2.0; the field stays for older clients.
        forks: Vec::new(),
    })))
}

pub async fn snapshot_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The snapshot id is not valid."));
    }
    let snapshot = state
        .store
        .get_snapshot(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("The requested snapshot was not found."))?;
    let file_changes = state
        .store
        .list_snapshot_file_changes(&id)
        .map_err(store_error)?;
    Ok(Json(json!(cockpit_core::replay::SnapshotDetailResponse {
        snapshot,
        file_changes,
    })))
}

pub async fn session_scan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !is_id(&id) {
        return Err(ApiError::bad_request("The session id is not valid."));
    }
    let guards = state.guards.clone();
    let result = tokio::task::spawn_blocking(move || guards.scan_session(&id))
        .await
        .map_err(|error| ApiError::internal(format!("The secret scan could not run: {error}")))?
        .map_err(guard_error)?;
    Ok(Json(json!(result)))
}

pub async fn not_found() -> Response {
    ApiError::not_found("No Cockpit API route matches this path.").into_response()
}

#[derive(Debug, Deserialize, Default)]
pub struct LiveQuery {
    pub replay: Option<u32>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
}

pub async fn live(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<LiveQuery>,
) -> Response {
    ws.on_upgrade(move |socket| live_socket(socket, state, query))
}

async fn live_socket(mut socket: WebSocket, state: AppState, query: LiveQuery) {
    let mut receiver = state.live.subscribe();
    let replay_limit = query.replay.unwrap_or(50).min(500);
    let mut last_sequence = 0;

    let ready = json!({
        "type": "live.ready",
        "sequence": state.live.current_sequence(),
        "at": now_iso(),
    });
    if send_json(&mut socket, &ready).await.is_err() {
        return;
    }

    for event in state.live.replay(replay_limit) {
        if !matches_filter(&event, query.session_id.as_deref()) {
            continue;
        }
        last_sequence = event.sequence;
        if send_json(&mut socket, &event).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            received = receiver.recv() => {
                match received {
                    Ok(event) => {
                        if event.sequence <= last_sequence
                            || !matches_filter(&event, query.session_id.as_deref())
                        {
                            continue;
                        }
                        last_sequence = event.sequence;
                        if send_json(&mut socket, &event).await.is_err() {
                            return;
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Err(_)) => return,
                    _ => {}
                }
            }
        }
    }
}

fn matches_filter(event: &cockpit_core::model::LiveEvent, session_id: Option<&str>) -> bool {
    match session_id {
        Some(wanted) => event.session_id.as_deref() == Some(wanted),
        None => true,
    }
}

async fn send_json<T: serde::Serialize>(socket: &mut WebSocket, value: &T) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

/// Create the three demo flights used by every empty state's "Try demo".
///
/// Seeding is recorded in settings so a second click does not duplicate data.
pub(crate) fn seed_demo_sessions(state: &AppState) -> Result<Vec<Session>, ApiError> {
    if state
        .store
        .get_setting("demo.seeded")
        .map_err(store_error)?
        .is_some()
    {
        return Ok(Vec::new());
    }

    let agent = AgentInfo {
        name: Some("Claude Code".to_string()),
        version: Some("2.1.0".to_string()),
        user_agent: Some("claude-cli/2.1.0".to_string()),
        detected_from: DetectedFrom::Demo,
    };

    let mut sessions = Vec::new();

    // Flight 1: a successful refactor with a tool call.
    let first = state
        .store
        .create_session(NewSession {
            title: "Refactor auth middleware".to_string(),
            source: SessionSource::Demo,
            capture_mode: CaptureMode::Proxy,
            protocol: Some(ProviderProtocol::Openai),
            provider: Some("openai".to_string()),
            model: Some("gpt-4.1".to_string()),
            agent: Some(agent.clone()),
            workspace_path: Some("~/projects/checkout-service".to_string()),
            git_branch: Some("feature/auth-cleanup".to_string()),
            tags: vec!["demo".to_string(), "refactor".to_string()],
            metadata: Some(json!({ "demo": true })),
            ..NewSession::default()
        })
        .map_err(store_error)?;

    let first_step = state
        .store
        .begin_step(BeginStep {
            session_id: first.id.clone(),
            kind: StepKind::Model,
            provider: Some("openai".to_string()),
            model: Some("gpt-4.1".to_string()),
            request: demo_request(
                ProviderProtocol::Openai,
                "/v1/chat/completions",
                "gpt-4.1",
                "You are a careful Rust reviewer.",
                "user: Split the auth middleware without changing behaviour.",
            ),
        })
        .map_err(store_error)?;
    let first_usage = TokenUsage {
        input_tokens: 1_840,
        output_tokens: 420,
        cache_read_tokens: 640,
        ..TokenUsage::ZERO
    };
    let first_cost =
        cockpit_core::cost::estimate_usage_cost(first_usage, "gpt-4.1", Some("openai"), &[]);
    state
        .store
        .complete_step(
            &first_step.id,
            CompleteStep {
                status: StepStatus::Completed,
                response_status: 200,
                response_headers: demo_headers(),
                response_text: Some(
                    "I split the middleware into `auth::session` and `auth::token`, kept the public API, and added two regression tests."
                        .to_string(),
                ),
                response_thinking: None,
                finish_reason: Some(FinishReason::Stop),
                usage: first_usage,
                cost_usd: first_cost.usd,
                cost_known: first_cost.known,
                model: Some("gpt-4.1".to_string()),
                error: None,
                ttft_ms: Some(312),
                latency_ms: 1_940,
            },
            1,
        )
        .map_err(store_error)?;
    state
        .store
        .insert_tool_calls(&[ToolCall {
            id: create_id(),
            session_id: first.id.clone(),
            step_id: Some(first_step.id.clone()),
            provider_tool_call_id: Some("call_demo_read".to_string()),
            name: "read_file".to_string(),
            status: ToolCallStatus::Completed,
            input: Some(json!({ "path": "src/auth/middleware.rs" })),
            output: None,
            error: None,
            file_paths: vec!["src/auth/middleware.rs".to_string()],
            started_at: now_iso(),
            ended_at: Some(now_iso()),
        }])
        .map_err(store_error)?;

    let second_step = state
        .store
        .begin_step(BeginStep {
            session_id: first.id.clone(),
            kind: StepKind::Model,
            provider: Some("openai".to_string()),
            model: Some("gpt-4.1".to_string()),
            request: demo_request(
                ProviderProtocol::Openai,
                "/v1/chat/completions",
                "gpt-4.1",
                "You are a careful Rust reviewer.",
                "user: Run the test suite and summarise what changed.",
            ),
        })
        .map_err(store_error)?;
    let second_usage = TokenUsage {
        input_tokens: 2_310,
        output_tokens: 180,
        cache_read_tokens: 1_280,
        ..TokenUsage::ZERO
    };
    let second_cost =
        cockpit_core::cost::estimate_usage_cost(second_usage, "gpt-4.1", Some("openai"), &[]);
    state
        .store
        .complete_step(
            &second_step.id,
            CompleteStep {
                status: StepStatus::Completed,
                response_status: 200,
                response_headers: demo_headers(),
                response_text: Some(
                    "`cargo test auth` passes: 18 tests, 0 failures. The diff is limited to the two new modules plus their tests."
                        .to_string(),
                ),
                response_thinking: None,
                finish_reason: Some(FinishReason::Stop),
                usage: second_usage,
                cost_usd: second_cost.usd,
                cost_known: second_cost.known,
                model: Some("gpt-4.1".to_string()),
                error: None,
                ttft_ms: Some(268),
                latency_ms: 1_120,
            },
            0,
        )
        .map_err(store_error)?;
    state
        .store
        .end_session(&first.id, SessionStatus::Completed)
        .map_err(store_error)?;

    // A recorded git snapshot so the replay screen has real file changes to
    // inspect instead of an empty tab.
    state
        .store
        .insert_snapshot(NewSnapshot {
            session_id: first.id.clone(),
            step_id: Some(second_step.id.clone()),
            kind: SnapshotKind::After,
            commit_sha: Some("8f3c2a1d9b7e4f60a1c2d3e4f5a6b7c8d9e0f1a2".to_string()),
            parent_commit_sha: Some("1b7d6f5e4c3a29180f7e6d5c4b3a29180f7e6d5c".to_string()),
            branch: Some("feature/auth-cleanup".to_string()),
            worktree_path: Some("~/projects/checkout-service".to_string()),
            patch: Some(
                "diff --git a/src/auth/session.rs b/src/auth/session.rs\nnew file mode 100644\n+pub struct Session {\n+    pub token: String,\n+}\n+\n+pub fn validate(token: &str) -> bool {\n+    !token.is_empty()\n+}\ndiff --git a/src/auth/token.rs b/src/auth/token.rs\nnew file mode 100644\n+pub fn refresh(token: &str) -> String {\n+    token.to_string()\n+}\n"
                    .to_string(),
            ),
            files_changed: 3,
            insertions: 128,
            deletions: 42,
            created_at: None,
            file_changes: vec![
                NewFileChange {
                    path: "src/auth/session.rs".to_string(),
                    old_path: None,
                    change_type: FileChangeType::Added,
                    additions: 86,
                    deletions: 0,
                    diff: Some("+pub struct Session { ... }".to_string()),
                    ai_authored: Some(true),
                },
                NewFileChange {
                    path: "src/auth/token.rs".to_string(),
                    old_path: None,
                    change_type: FileChangeType::Added,
                    additions: 32,
                    deletions: 0,
                    diff: Some("+pub fn refresh(token: &str) -> String { ... }".to_string()),
                    ai_authored: Some(true),
                },
                NewFileChange {
                    path: "src/auth/mod.rs".to_string(),
                    old_path: None,
                    change_type: FileChangeType::Modified,
                    additions: 10,
                    deletions: 42,
                    diff: Some("-mod middleware;\n+mod session;\n+mod token;".to_string()),
                    ai_authored: Some(true),
                },
            ],
        })
        .map_err(store_error)?;

    if let Some(session) = state.store.get_session(&first.id).map_err(store_error)? {
        publish_demo_started(state, &session);
        sessions.push(session);
    }

    // Flight 2: a streaming Anthropic repair with one redacted header.
    let second = state
        .store
        .create_session(NewSession {
            title: "Fix flaky checkout test".to_string(),
            source: SessionSource::Demo,
            capture_mode: CaptureMode::Proxy,
            protocol: Some(ProviderProtocol::Anthropic),
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-4".to_string()),
            agent: Some(agent.clone()),
            workspace_path: Some("~/projects/checkout-service".to_string()),
            git_branch: Some("fix/flaky-cart-test".to_string()),
            tags: vec!["demo".to_string(), "tests".to_string()],
            metadata: Some(json!({ "demo": true })),
            ..NewSession::default()
        })
        .map_err(store_error)?;

    let mut request = demo_request(
        ProviderProtocol::Anthropic,
        "/v1/messages",
        "claude-sonnet-4",
        "You debug flaky tests by finding the real race.",
        "user: The cart total test fails about one run in twenty. Find the race.",
    );
    request.stream = true;
    request
        .headers
        .insert("authorization".to_string(), "[REDACTED]".to_string());
    request.redaction_count = 1;

    let step = state
        .store
        .begin_step(BeginStep {
            session_id: second.id.clone(),
            kind: StepKind::Model,
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-4".to_string()),
            request,
        })
        .map_err(store_error)?;
    let usage = TokenUsage {
        input_tokens: 920,
        output_tokens: 310,
        cache_write_tokens: 410,
        ..TokenUsage::ZERO
    };
    let cost =
        cockpit_core::cost::estimate_usage_cost(usage, "claude-sonnet-4", Some("anthropic"), &[]);
    state
        .store
        .complete_step(
            &step.id,
            CompleteStep {
                status: StepStatus::Completed,
                response_status: 200,
                response_headers: demo_headers(),
                response_text: Some(
                    "The test reads `cart.total` before the async recalculation finishes. Await `recalculate()` in the fixture instead of sleeping."
                        .to_string(),
                ),
                response_thinking: Some(
                    "The 50 ms sleep is the smell. The assertion races the recalculation task."
                        .to_string(),
                ),
                finish_reason: Some(FinishReason::Stop),
                usage,
                cost_usd: cost.usd,
                cost_known: cost.known,
                model: Some("claude-sonnet-4".to_string()),
                error: None,
                ttft_ms: Some(410),
                latency_ms: 2_480,
            },
            0,
        )
        .map_err(store_error)?;
    state
        .store
        .insert_redactions(
            &step.id,
            &[RedactionRow {
                rule_id: "sensitive-header".to_string(),
                label: "Sensitive header: authorization".to_string(),
                location: CaptureLocation::RequestHeaders,
                occurrences: 1,
            }],
        )
        .map_err(store_error)?;
    state
        .store
        .insert_stream_chunks(&[
            StreamChunk {
                id: create_id(),
                step_id: step.id.clone(),
                seq: 0,
                kind: StreamChunkKind::Thinking,
                data: "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"The 50 ms sleep is the smell. The assertion races the recalculation task.\"}}"
                    .to_string(),
                delta_text: Some(
                    "The 50 ms sleep is the smell. The assertion races the recalculation task."
                        .to_string(),
                ),
                received_at: now_iso(),
            },
            StreamChunk {
                id: create_id(),
                step_id: step.id.clone(),
                seq: 1,
                kind: StreamChunkKind::Text,
                data: "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"The test reads `cart.total` before the async \"}}"
                    .to_string(),
                delta_text: Some("The test reads `cart.total` before the async ".to_string()),
                received_at: now_iso(),
            },
            StreamChunk {
                id: create_id(),
                step_id: step.id.clone(),
                seq: 2,
                kind: StreamChunkKind::Text,
                data: "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"recalculation finishes. Await `recalculate()` \"}}"
                    .to_string(),
                delta_text: Some(
                    "recalculation finishes. Await `recalculate()` ".to_string(),
                ),
                received_at: now_iso(),
            },
            StreamChunk {
                id: create_id(),
                step_id: step.id.clone(),
                seq: 3,
                kind: StreamChunkKind::Text,
                data: "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"in the fixture instead of sleeping.\"}}"
                    .to_string(),
                delta_text: Some("in the fixture instead of sleeping.".to_string()),
                received_at: now_iso(),
            },
            StreamChunk {
                id: create_id(),
                step_id: step.id.clone(),
                seq: 4,
                kind: StreamChunkKind::Done,
                data: "event: message_stop\ndata: {\"type\":\"message_stop\"}".to_string(),
                delta_text: None,
                received_at: now_iso(),
            },
        ])
        .map_err(store_error)?;
    state
        .store
        .end_session(&second.id, SessionStatus::Completed)
        .map_err(store_error)?;

    if let Some(session) = state.store.get_session(&second.id).map_err(store_error)? {
        publish_demo_started(state, &session);
        sessions.push(session);
    }

    // Flight 3: an active Gemini review with an honest "unpriced" cost.
    let third = state
        .store
        .create_session(NewSession {
            title: "Review landing page copy".to_string(),
            source: SessionSource::Demo,
            capture_mode: CaptureMode::Proxy,
            protocol: Some(ProviderProtocol::Gemini),
            provider: Some("gemini".to_string()),
            model: Some("gemini-2.5-pro".to_string()),
            agent: Some(agent),
            workspace_path: Some("~/projects/cockpit-site".to_string()),
            git_branch: Some("copy/hero".to_string()),
            tags: vec!["demo".to_string(), "writing".to_string()],
            metadata: Some(json!({ "demo": true })),
            ..NewSession::default()
        })
        .map_err(store_error)?;

    let step = state
        .store
        .begin_step(BeginStep {
            session_id: third.id.clone(),
            kind: StepKind::Model,
            provider: Some("gemini".to_string()),
            model: Some("gemini-2.5-pro".to_string()),
            request: demo_request(
                ProviderProtocol::Gemini,
                "/v1beta/models/gemini-2.5-pro:generateContent",
                "gemini-2.5-pro",
                "You edit product copy for clarity and restraint.",
                "user: Tighten the hero copy without adding hype.",
            ),
        })
        .map_err(store_error)?;
    state
        .store
        .complete_step(
            &step.id,
            CompleteStep {
                status: StepStatus::Completed,
                response_status: 200,
                response_headers: demo_headers(),
                response_text: Some(
                    "See every request your agent makes. Replay any flight. Keep the receipts."
                        .to_string(),
                ),
                response_thinking: None,
                finish_reason: Some(FinishReason::Stop),
                usage: TokenUsage {
                    input_tokens: 1_200,
                    output_tokens: 260,
                    ..TokenUsage::ZERO
                },
                cost_usd: None,
                cost_known: false,
                model: Some("gemini-2.5-pro".to_string()),
                error: None,
                ttft_ms: Some(355),
                latency_ms: 1_650,
            },
            0,
        )
        .map_err(store_error)?;

    if let Some(session) = state.store.get_session(&third.id).map_err(store_error)? {
        publish_demo_started(state, &session);
        sessions.push(session);
    }

    // A pending approval so the Inbox has something real to act on in demo
    // mode. This is a stored guard event, not UI-only sample data.
    state
        .guards
        .record_event(crate::store::NewGuardEvent {
            session_id: third.id.clone(),
            step_id: Some(step.id.clone()),
            rule_id: "builtin-dangerous-command".to_string(),
            kind: GuardRuleKind::DangerousCommand,
            action: GuardAction::Pause,
            severity: GuardSeverity::High,
            status: GuardEventStatus::Pending,
            title: "Deploy the landing page?".to_string(),
            description: "Gemini wants to publish the site to production. This command is recorded and waits for your answer.".to_string(),
            command: Some("pnpm deploy --prod".to_string()),
            evidence: vec![GuardEvidence {
                field: Some("command".to_string()),
                excerpt: Some("pnpm deploy --prod".to_string()),
                ..GuardEvidence::default()
            }],
            metadata: Some(json!({ "demo": true })),
        })
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "demo_seed_failed",
                error.to_string(),
            )
        })?;

    state
        .store
        .set_setting("demo.seeded", &now_iso())
        .map_err(store_error)?;
    state.live.publish(
        "demo.seeded",
        None,
        None,
        json!({ "sessionIds": sessions.iter().map(|session| session.id.clone()).collect::<Vec<_>>() }),
    );

    Ok(sessions)
}

fn publish_demo_started(state: &AppState, session: &Session) {
    state.live.publish(
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
            "demo": true,
        }),
    );
}

fn demo_headers() -> BTreeMap<String, String> {
    BTreeMap::from([("content-type".to_string(), "application/json".to_string())])
}

fn demo_request(
    protocol: ProviderProtocol,
    path: &str,
    model: &str,
    system: &str,
    prompt: &str,
) -> CapturedRequest {
    CapturedRequest {
        protocol,
        method: "POST".to_string(),
        path: path.to_string(),
        model: Some(model.to_string()),
        stream: false,
        headers: BTreeMap::from([
            ("content-type".to_string(), "application/json".to_string()),
            ("user-agent".to_string(), "claude-cli/2.1.0".to_string()),
        ]),
        body: Some(json!({
            "model": model,
            "stream": false,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": prompt },
            ],
        })),
        system_prompt: Some(system.to_string()),
        prompt_text: Some(prompt.to_string()),
        redaction_count: 0,
    }
}
