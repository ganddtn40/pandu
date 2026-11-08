//! The remote listener's HTTP surface.
//!
//! This router is deliberately separate from the loopback router. It mounts
//! only the dashboard, the scoped remote API, and the live WebSocket. Model
//! proxy paths are rejected with 404 before the dashboard fallback can see
//! them.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use cockpit_core::guard::{
    ApprovalChoice, ApprovalDecisionInput, GuardEvent, GuardRuleKind, GuardSeverity,
};
use cockpit_core::ids::is_id;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;

use crate::api as loopback;
use crate::api::ApiError;
use crate::remote::auth::Scope;
use crate::remote::{
    MAX_PROMPT_CHARS, PendingPrompt, RemoteAuthError, RemoteMode, RemotePrincipal,
    sanitize_prompt_text,
};
use crate::state::AppState;

pub const REMOTE_BODY_LIMIT: usize = 64 * 1024;
/// Wrong high-risk PINs before Respond locks for this device until a host reset.
pub const MAX_PIN_FAILURES: u32 = 5;

pub fn build_remote_router(state: AppState) -> Router {
    let public = Router::new()
        .route("/remote/health", get(remote_health))
        .route("/remote/pair/claim", post(pair_claim))
        .route("/remote/pair/claim/{id}", post(pair_poll));

    let authenticated = Router::new()
        .route("/remote/session", get(session_info))
        .route("/remote/overview", get(overview))
        .route("/remote/sessions", get(list_sessions))
        .route("/remote/sessions/{id}", get(get_session))
        .route("/remote/sessions/{id}/steps", get(list_steps))
        .route("/remote/guards/events", get(list_guard_events))
        .route("/remote/guards/events/{id}/decision", post(guard_decision))
        .route("/remote/agents", get(list_agents))
        .route("/remote/agents/{id}", get(get_agent))
        .route("/remote/agents/{id}/prompt", post(send_prompt))
        .route("/remote/agent-events", get(list_agent_events))
        .route("/remote/ws-ticket", post(ws_ticket))
        .route("/remote/logout", post(logout))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));

    // The live socket authenticates with a single-use ticket carried in the
    // WebSocket subprotocol, never with a bearer token in the URL. It therefore
    // lives outside the bearer-auth layer and validates its own ticket.
    let live_socket = Router::new().route("/remote/live", get(live));

    let api = public
        .merge(authenticated)
        .merge(live_socket)
        .fallback(api_not_found)
        .with_state(state.clone());

    Router::new()
        .nest("/api", api)
        .merge(super::ui::router(&state.config.ui_dir))
        .layer(middleware::from_fn(block_proxy_paths))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            capture_client_ip,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            check_host_and_origin,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            limit_connections,
        ))
        .layer(DefaultBodyLimit::max(REMOTE_BODY_LIMIT))
        .layer(tower_http::trace::TraceLayer::new_for_http())
}

async fn remote_health(
    State(state): State<AppState>,
    Extension(identity): Extension<ClientIdentity>,
    headers: HeaderMap,
) -> Response {
    // Health is not an unauthenticated fingerprint. A paired device may read
    // it, and a real loopback caller may read it, but everyone else gets the
    // same 404 as an unknown path.
    let authenticated = bearer_token(&headers)
        .and_then(|token| state.remote.authorize(token).ok())
        .is_some();
    let loopback = identity.trusted
        && identity
            .ip
            .as_deref()
            .and_then(|ip| ip.parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
    if !authenticated && !loopback {
        return api_not_found().await;
    }
    let mut body = json!({ "ok": true, "remote": true });
    if authenticated {
        body["version"] = json!(cockpit_core::VERSION);
    }
    Json(body).into_response()
}

// ----- Pairing ------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairClaimInput {
    code: String,
    device_name: String,
    #[serde(default)]
    pin: Option<String>,
    verification_code: String,
}

async fn pair_claim(
    State(state): State<AppState>,
    Extension(identity): Extension<ClientIdentity>,
    Json(input): Json<PairClaimInput>,
) -> Response {
    let key = identity.rate_key("pair");
    let audit_ip = identity.audit_ip().map(str::to_string);
    if let Some(remaining) = state.remote.lockout_for(&key) {
        return rate_limited(remaining);
    }
    if !state
        .remote
        .allow_attempt(&key, 12, Duration::from_secs(60))
    {
        state.remote.audit(
            "pair.rate_limited",
            None,
            audit_ip.as_deref(),
            json!({ "reason": "per_client_window" }),
            None,
            None,
        );
        return rate_limited(Duration::from_secs(60));
    }
    match state.remote.pairing().begin_claim(
        &input.code,
        &input.device_name,
        input.pin.as_deref(),
        &input.verification_code,
        audit_ip.as_deref(),
    ) {
        Ok(ticket) => {
            state.remote.audit(
                "pair.request",
                None,
                audit_ip.as_deref(),
                json!({
                    "claimId": ticket.claim_id,
                    "deviceName": input.device_name.chars().take(80).collect::<String>(),
                    "hasPin": input.pin.as_deref().is_some_and(|pin| !pin.trim().is_empty()),
                }),
                None,
                None,
            );
            state.remote.send_notification("pairing").await;
            Json(json!({
                "claimId": ticket.claim_id,
                "claimSecret": ticket.claim_secret,
                "expiresInSeconds": super::PAIR_CLAIM_TTL_SECONDS,
            }))
            .into_response()
        }
        Err(error) => {
            let lock = state.remote.record_auth_failure(&key);
            state.remote.audit(
                "pair.failed",
                None,
                audit_ip.as_deref(),
                json!({ "code": error.code() }),
                None,
                None,
            );
            if lock > Duration::ZERO {
                return rate_limited(lock);
            }
            api_error(StatusCode::BAD_REQUEST, error.code(), error.message())
        }
    }
}

async fn pair_poll(
    State(state): State<AppState>,
    Extension(identity): Extension<ClientIdentity>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    // Polls belong to one claim, so a device waiting on one code cannot spend
    // another claim's budget and an IP change does not reset the wait.
    let key = format!("pair-poll:{id}");
    if !state
        .remote
        .allow_attempt(&key, 120, Duration::from_secs(60))
    {
        return rate_limited(Duration::from_secs(60));
    }
    let Some(secret) = headers
        .get("x-pairing-secret")
        .and_then(|value| value.to_str().ok())
    else {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "pairing_secret_missing",
            "The pairing secret is missing.",
        );
    };
    match state.remote.pairing().poll_claim(&id, secret) {
        Ok(poll) => {
            if poll.status == super::pairing::ClaimStatusView::Confirmed {
                state.remote.audit(
                    "pair.claimed",
                    poll.device_id.as_deref().zip(poll.device_name.as_deref()),
                    identity.audit_ip(),
                    json!({ "claimId": id }),
                    None,
                    None,
                );
            }
            Json(json!(poll)).into_response()
        }
        Err(error) => api_error(StatusCode::BAD_REQUEST, error.code(), error.message()),
    }
}

// ----- Read-only API ------------------------------------------------------

async fn session_info(
    State(state): State<AppState>,
    Extension(principal): Extension<RemotePrincipal>,
) -> Json<Value> {
    Json(json!({
        "deviceId": principal.device_id,
        "deviceName": principal.device_name,
        "scopes": principal.scopes.to_strings(),
        "requireHostConfirmation": principal.require_host_confirmation,
        "hasPin": principal.has_pin(),
        "pinFailures": principal.pin_failures,
        "respondLocked": principal.respond_locked,
        "mode": state.remote.mode().as_str(),
        "url": state.remote.url(),
    }))
}

async fn overview(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    loopback::overview(State(state)).await
}

async fn list_sessions(
    State(state): State<AppState>,
    Query(query): Query<loopback::SessionQuery>,
) -> Result<Json<Value>, ApiError> {
    loopback::list_sessions(State(state), Query(query)).await
}

async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    loopback::get_session(State(state), Path(id)).await
}

async fn list_steps(
    State(state): State<AppState>,
    Extension(principal): Extension<RemotePrincipal>,
    Path(id): Path<String>,
) -> Response {
    if let Some(response) = require_scope(&principal, Scope::ViewContent) {
        return response;
    }
    match loopback::list_steps(State(state), Path(id)).await {
        Ok(Json(value)) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn list_guard_events(
    State(state): State<AppState>,
    Query(query): Query<loopback::GuardEventQuery>,
) -> Result<Json<Value>, ApiError> {
    loopback::list_guard_events(State(state), Query(query)).await
}

async fn list_agents(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    loopback::list_agents(State(state)).await
}

async fn get_agent(
    State(state): State<AppState>,
    Extension(principal): Extension<RemotePrincipal>,
    Path(id): Path<String>,
) -> Response {
    if let Some(response) = require_scope(&principal, Scope::ViewContent) {
        return response;
    }
    match loopback::get_agent(State(state), Path(id)).await {
        Ok(Json(value)) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn list_agent_events(
    State(state): State<AppState>,
    Query(query): Query<loopback::AgentEventQuery>,
) -> Result<Json<Value>, ApiError> {
    loopback::list_agent_events(State(state), Query(query)).await
}

// ----- Remote decisions ---------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDecisionInput {
    decision: ApprovalChoice,
    nonce: String,
    session_id: String,
    #[serde(default)]
    pin: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

async fn guard_decision(
    State(state): State<AppState>,
    Extension(principal): Extension<RemotePrincipal>,
    Extension(identity): Extension<ClientIdentity>,
    Path(id): Path<String>,
    Json(input): Json<RemoteDecisionInput>,
) -> Response {
    if let Some(response) = require_scope(&principal, Scope::Respond) {
        return response;
    }
    if principal.respond_locked {
        return api_error(
            StatusCode::LOCKED,
            "respond_locked",
            "Too many wrong PINs. Unlock Respond from the host before this device can approve or deny again.",
        );
    }
    if !is_id(&id) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "The guard event id is not valid.",
        );
    }
    let Some(event) = state.store.get_guard_event(&id).ok().flatten() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "not_found",
            "That approval does not exist.",
        );
    };
    if is_auth_prompt(&event) {
        state.remote.audit(
            "approval.needs_host",
            Some((&principal.device_id, &principal.device_name)),
            identity.audit_ip(),
            json!({ "eventId": event.id, "reason": "authentication_prompt" }),
            None,
            None,
        );
        return api_error(
            StatusCode::CONFLICT,
            "needs_host",
            "Authentication and login prompts must be completed at the computer.",
        );
    }

    let high_risk = matches!(
        event.severity,
        GuardSeverity::High | GuardSeverity::Critical
    ) || event.kind == GuardRuleKind::DangerousCommand;
    if high_risk {
        if !principal.has_pin() {
            return api_error(
                StatusCode::CONFLICT,
                "pin_required",
                "This approval needs a PIN. Revoke the device and pair it again with a PIN.",
            );
        }
        let Some(pin) = input.pin.as_deref().filter(|pin| !pin.trim().is_empty()) else {
            return api_error(
                StatusCode::CONFLICT,
                "pin_required",
                "This is a high-risk approval. Enter the PIN you set when pairing.",
            );
        };
        if !principal.verify_pin(pin) {
            let updated = state
                .store
                .record_remote_pin_failure(&principal.device_id, MAX_PIN_FAILURES)
                .ok()
                .flatten();
            let failures = updated
                .as_ref()
                .map(|device| device.pin_failures)
                .unwrap_or(principal.pin_failures.saturating_add(1));
            let locked = updated
                .as_ref()
                .is_some_and(|device| device.respond_locked_at.is_some());
            if locked {
                state.remote.audit(
                    "device.respond_locked",
                    Some((&principal.device_id, &principal.device_name)),
                    identity.audit_ip(),
                    json!({ "eventId": event.id, "failures": failures }),
                    None,
                    None,
                );
                return api_error(
                    StatusCode::LOCKED,
                    "respond_locked",
                    "Too many wrong PINs. Unlock Respond from the host before this device can approve or deny again.",
                );
            }
            state.remote.audit(
                "approval.pin_failed",
                Some((&principal.device_id, &principal.device_name)),
                identity.audit_ip(),
                json!({ "eventId": event.id, "failures": failures }),
                None,
                None,
            );
            let remaining = MAX_PIN_FAILURES.saturating_sub(failures);
            return api_error(
                StatusCode::FORBIDDEN,
                "pin_invalid",
                format!("That PIN is not correct. {remaining} attempts left before Respond locks."),
            );
        }
        let _ = state.store.clear_remote_pin_failures(&principal.device_id);
        state
            .remote
            .clear_auth_failures(&format!("pin:{}", principal.device_id));
    }

    let decision = ApprovalDecisionInput {
        decision: input.decision,
        note: input.note.clone(),
        actor: Some(format!("remote:{}", principal.device_name)),
        channel: "remote".to_string(),
        provider: None,
        nonce: Some(input.nonce),
        session_id: Some(input.session_id),
    };
    match state.guards.resolve_event(&id, decision).await {
        Ok(resolved) => {
            let approved = input.decision == ApprovalChoice::Approve;
            state.remote.audit(
                if approved {
                    "approval.approve"
                } else {
                    "approval.deny"
                },
                Some((&principal.device_id, &principal.device_name)),
                identity.audit_ip(),
                json!({
                    "eventId": resolved.id,
                    "severity": resolved.severity.as_str(),
                    "kind": resolved.kind.as_str(),
                    "highRisk": high_risk,
                    "pinUsed": high_risk,
                }),
                None,
                None,
            );
            state.remote.send_notification("approval").await;
            Json(json!({ "event": resolved })).into_response()
        }
        Err(error) => {
            let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::BAD_REQUEST);
            api_error(status, error.code(), error.to_string())
        }
    }
}

fn is_auth_prompt(event: &GuardEvent) -> bool {
    let mut text = format!("{} {} {}", event.title, event.description, event.rule_id);
    if let Some(command) = &event.command {
        text.push(' ');
        text.push_str(command);
    }
    for evidence in &event.evidence {
        if let Some(excerpt) = &evidence.excerpt {
            text.push(' ');
            text.push_str(excerpt);
        }
    }
    let lower = text.to_ascii_lowercase();
    [
        "password",
        "passcode",
        "2fa",
        "two-factor",
        "one-time code",
        "login",
        "log in",
        "sign in",
        "authenticate",
        "authentication",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

// ----- Remote prompts -----------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePromptInput {
    text: String,
}

async fn send_prompt(
    State(state): State<AppState>,
    Extension(principal): Extension<RemotePrincipal>,
    Extension(identity): Extension<ClientIdentity>,
    Path(id): Path<String>,
    Json(input): Json<RemotePromptInput>,
) -> Response {
    if let Some(response) = require_scope(&principal, Scope::Prompt) {
        return response;
    }
    if !is_id(&id) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "The agent session id is not valid.",
        );
    }
    let text = sanitize_prompt_text(&input.text);
    if text.is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "empty_prompt",
            "Write printable text before sending.",
        );
    }
    if text.chars().count() > MAX_PROMPT_CHARS {
        return api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "prompt_too_large",
            format!("Remote prompts are limited to {MAX_PROMPT_CHARS} characters."),
        );
    }
    let Some(view) = state.agents.get(&id).ok().flatten() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "agent_missing",
            "That agent session is not running.",
        );
    };
    if view.status != crate::agents::AgentSessionStatus::Running {
        return api_error(
            StatusCode::CONFLICT,
            "agent_ended",
            "That agent session has already ended.",
        );
    }
    if !view.prompt_state.is_awaiting_prompt() {
        state.remote.audit(
            "prompt.rejected",
            Some((&principal.device_id, &principal.device_name)),
            identity.audit_ip(),
            json!({
                "sessionId": id,
                "reason": view.prompt_state.as_str(),
            }),
            None,
            None,
        );
        return api_error(
            StatusCode::CONFLICT,
            "prompt_not_awaiting",
            format!(
                "This session is not waiting for typed input ({}). Handle it at the computer.",
                view.prompt_state.as_str()
            ),
        );
    }
    if !state.remote.prompt_rate_ok(&principal.device_id) {
        state.remote.audit(
            "prompt.rate_limited",
            Some((&principal.device_id, &principal.device_name)),
            identity.audit_ip(),
            json!({ "sessionId": id }),
            None,
            None,
        );
        return rate_limited(Duration::from_secs(60));
    }

    let prompt = state.remote.queue_prompt(
        &principal,
        &id,
        &text,
        identity.audit_ip(),
        view.auto_approve,
    );
    // An adapter started with a skip-approvals flag is exactly where a remote
    // prompt is most dangerous, so every prompt in that session stays behind
    // the host confirmation gate.
    if principal.require_host_confirmation || view.auto_approve {
        state.remote.send_notification("prompt").await;
        state.live.publish(
            "remote.prompt",
            Some(&id),
            None,
            json!({
                "promptId": prompt.id,
                "deviceName": principal.device_name,
                "sessionId": id,
                "sizeBytes": prompt.size_bytes,
                "needsHostConfirmation": true,
            }),
        );
        return (
            StatusCode::ACCEPTED,
            Json(json!({
                "status": "pending_host",
                "promptId": prompt.id,
                "message": "Sent to the host for confirmation.",
            })),
        )
            .into_response();
    }

    let Some(prompt) = state.remote.approve_prompt(&prompt.id) else {
        return api_error(
            StatusCode::CONFLICT,
            "prompt_expired",
            "That prompt expired before it was sent.",
        );
    };
    match push_prompt(&state, &prompt) {
        Ok(sequence) => {
            state.remote.audit(
                "prompt.sent",
                Some((&principal.device_id, &principal.device_name)),
                identity.audit_ip(),
                json!({
                    "promptId": prompt.id,
                    "sessionId": prompt.session_id,
                    "sequence": sequence,
                    "hostConfirmation": false,
                }),
                Some(prompt.size_bytes),
                Some(&prompt.content_hash),
            );
            state.live.publish(
                "remote.prompt.sent",
                Some(&prompt.session_id),
                None,
                json!({
                    "promptId": prompt.id,
                    "deviceName": principal.device_name,
                    "sessionId": prompt.session_id,
                }),
            );
            Json(json!({
                "status": "sent",
                "promptId": prompt.id,
                "sequence": sequence,
            }))
            .into_response()
        }
        Err(message) => api_error(StatusCode::CONFLICT, "prompt_failed", message),
    }
}

pub(crate) fn push_prompt(state: &AppState, prompt: &PendingPrompt) -> Result<Option<u64>, String> {
    // Exactly one Enter, regardless of how the host edited the prompt.
    let mut data = prompt.text.trim_end_matches(['\r', '\n']).to_string();
    data.push('\r');
    state
        .agents
        .push_input(&prompt.session_id, &data)
        .map_err(|error| error.to_string())
}

async fn logout(
    State(state): State<AppState>,
    Extension(principal): Extension<RemotePrincipal>,
    Extension(identity): Extension<ClientIdentity>,
) -> Json<Value> {
    let revoked = state
        .store
        .revoke_remote_device(&principal.device_id, &crate::store::now_iso())
        .unwrap_or(false);
    state.remote.bump_epoch();
    state.remote.audit(
        "device.self_revoke",
        Some((&principal.device_id, &principal.device_name)),
        identity.audit_ip(),
        json!({ "revoked": revoked }),
        None,
        None,
    );
    Json(json!({ "revoked": true }))
}

// ----- WebSocket ----------------------------------------------------------

async fn ws_ticket(
    State(state): State<AppState>,
    Extension(principal): Extension<RemotePrincipal>,
) -> Response {
    if let Some(response) = require_scope(&principal, Scope::ViewStatus) {
        return response;
    }
    let ticket = state.remote.issue_ws_ticket(&principal.device_id);
    Json(json!({
        "ticket": ticket,
        "expiresInSeconds": super::WS_TICKET_TTL_SECONDS,
        "protocol": format!("cockpit.{ticket}"),
    }))
    .into_response()
}

async fn live(ws: WebSocketUpgrade, State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(protocol) = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .find(|item| item.starts_with("cockpit."))
                .map(str::to_string)
        })
    else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "ws_ticket_missing",
            "Open the live socket with a short-lived Cockpit ticket.",
        );
    };
    let ticket = protocol.trim_start_matches("cockpit.");
    let Some(ticket) = state.remote.consume_ws_ticket(ticket) else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "ws_ticket_invalid",
            "That live socket ticket expired or was already used.",
        );
    };
    let Some(principal) = state.remote.principal_by_id(&ticket.device_id) else {
        return api_error(
            StatusCode::FORBIDDEN,
            "remote_device_revoked",
            "This device was revoked by the host.",
        );
    };
    if !principal.allows(Scope::ViewStatus) {
        return api_error(
            StatusCode::FORBIDDEN,
            "scope_required",
            "This device does not have the View status scope.",
        );
    }
    ws.protocols([protocol])
        .on_upgrade(move |socket| remote_live_socket(socket, state, principal))
}

async fn remote_live_socket(mut socket: WebSocket, state: AppState, principal: RemotePrincipal) {
    let mut receiver = state.live.subscribe();
    let mut last_sequence = 0;
    let mut content = principal.allows(Scope::ViewContent);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut revocation_check = tokio::time::interval(Duration::from_secs(3));
    revocation_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    if send_json(
        &mut socket,
        &json!({
            "type": "live.ready",
            "sequence": state.live.current_sequence(),
            "deviceId": principal.device_id,
        }),
    )
    .await
    .is_err()
    {
        return;
    }

    for event in state.live.replay(50) {
        last_sequence = event.sequence;
        // Status-only devices get the event stream, not terminal output or
        // file paths. Content events are skipped but still advance the cursor
        // so a later content grant does not replay old output.
        if event_needs_content(&event.event_type) && !content {
            continue;
        }
        if send_json(&mut socket, &event).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            received = receiver.recv() => {
                match received {
                    Ok(event) => {
                        if event.sequence <= last_sequence {
                            continue;
                        }
                        // Re-check the device on every outgoing event, not
                        // only on a timer: revocation and scope changes must
                        // stop the stream immediately.
                        let Some(current) = state.remote.principal_by_id(&principal.device_id) else {
                            let _ = close_revoked(&mut socket, "revoked").await;
                            return;
                        };
                        if !current.allows(Scope::ViewStatus) {
                            let _ = close_revoked(&mut socket, "scope").await;
                            return;
                        }
                        content = current.allows(Scope::ViewContent);
                        if event_needs_content(&event.event_type) && !content {
                            last_sequence = event.sequence;
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
            _ = heartbeat.tick() => {
                if send_json(&mut socket, &json!({ "type": "live.ping" })).await.is_err() {
                    return;
                }
            }
            _ = revocation_check.tick() => {
                if state.remote.principal_by_id(&principal.device_id).is_none() {
                    let _ = close_revoked(&mut socket, "revoked").await;
                    return;
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Err(_)) => return,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            return;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn close_revoked(socket: &mut WebSocket, reason: &str) -> Result<(), ()> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: reason.to_string().into(),
        })))
        .await
        .map_err(|_| ())
}

async fn send_json<T: serde::Serialize>(socket: &mut WebSocket, value: &T) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

// ----- Middleware ---------------------------------------------------------

async fn authenticate(
    State(state): State<AppState>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let identity = client_identity(&request);
    let audit_ip = identity.audit_ip().map(str::to_string);
    let Some(token) = bearer_token(request.headers()).map(str::to_string) else {
        if let Some(response) = auth_ip_budget(&state, &identity) {
            return response;
        }
        state.remote.audit(
            "auth.missing",
            None,
            audit_ip.as_deref(),
            json!({}),
            None,
            None,
        );
        return remote_auth_error(RemoteAuthError::Missing);
    };

    // A valid token is checked before the per-IP failure budget so a lockout
    // earned by unauthenticated attempts never cuts off an already-paired
    // device. The device still has its own generous request budget.
    match state.remote.authorize(&token) {
        Ok(principal) => {
            let device_key = format!("auth-device:{}", principal.device_id);
            if !state
                .remote
                .allow_attempt(&device_key, 600, Duration::from_secs(60))
            {
                state.remote.audit(
                    "auth.rate_limited",
                    Some((&principal.device_id, &principal.device_name)),
                    audit_ip.as_deref(),
                    json!({ "reason": "per_device_window" }),
                    None,
                    None,
                );
                return rate_limited(Duration::from_secs(60));
            }
            state.remote.clear_auth_failures(&identity.rate_key("auth"));
            request.extensions_mut().insert(principal);
            next.run(request).await
        }
        Err(error) => {
            if let Some(response) = auth_ip_budget(&state, &identity) {
                return response;
            }
            let key = identity.rate_key("auth");
            let lock = state.remote.record_auth_failure(&key);
            state.remote.audit(
                "auth.failure",
                None,
                audit_ip.as_deref(),
                json!({ "reason": error.code() }),
                None,
                None,
            );
            if lock > Duration::ZERO {
                return rate_limited(lock);
            }
            remote_auth_error(error)
        }
    }
}

/// Spend the unauthenticated budget for this client. Untrusted tunnel traffic
/// shares one bucket instead of ever being keyed by the loopback peer.
fn auth_ip_budget(state: &AppState, identity: &ClientIdentity) -> Option<Response> {
    let key = identity.rate_key("auth");
    if let Some(remaining) = state.remote.lockout_for(&key) {
        return Some(rate_limited(remaining));
    }
    if !state
        .remote
        .allow_attempt(&key, 120, Duration::from_secs(60))
    {
        state.remote.audit(
            "auth.rate_limited",
            None,
            identity.audit_ip(),
            json!({ "reason": "per_client_window" }),
            None,
            None,
        );
        return Some(rate_limited(Duration::from_secs(60)));
    }
    None
}

async fn security_headers(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; \
             frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // Same-origin UI detection marker. The host listener never sets this.
    headers.insert("x-cockpit-remote", HeaderValue::from_static("1"));
    if state.remote.mode().uses_tls() {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    response
}

async fn check_host_and_origin(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !host_allowed(&state, host) {
        return api_error(
            StatusCode::FORBIDDEN,
            "forbidden_host",
            "This Host header is not allowed for the remote listener.",
        );
    }
    if let Some(value) = host {
        state.remote.mark_expected_host(&host_without_port(value));
    }
    if let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        if !origin_allowed(&state, origin, host) {
            return api_error(
                StatusCode::FORBIDDEN,
                "forbidden_origin",
                "Cross-origin requests are not allowed.",
            );
        }
    }
    next.run(request).await
}

async fn limit_connections(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let Ok(permit) = state.remote.connections.clone().try_acquire_owned() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "too_many_connections",
            "Cockpit is handling too many remote connections. Try again shortly.",
        );
    };
    let response = next.run(request).await;
    drop(permit);
    response
}

fn host_allowed(state: &AppState, value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let host = host_without_port(value)
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if crate::config::is_loopback_host(&host) {
        return true;
    }
    // Every exposed mode has an exact allowlist. Tunnel mode has only the
    // public hostname from the tunnel URL; Tailscale has the tailnet IP and
    // MagicDNS name; LAN has its bound address and pinned local name.
    state
        .remote
        .allowed_hosts()
        .iter()
        .any(|allowed| allowed == &host)
}

fn origin_allowed(state: &AppState, origin: &str, host: Option<&str>) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let origin_host = host_without_port(rest.split('/').next().unwrap_or(rest))
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let Some(host) = host else {
        return false;
    };
    let request_host = host_without_port(host)
        .trim_end_matches('.')
        .to_ascii_lowercase();
    // Loopback origins only belong to the local host UI. A browser on the host
    // must not be able to drive the public tunnel address cross-origin.
    if crate::config::is_loopback_host(&origin_host) {
        return crate::config::is_loopback_host(&request_host);
    }
    if !origin_host.eq_ignore_ascii_case(&request_host) {
        return false;
    }
    match state.remote.mode() {
        RemoteMode::Tunnel => scheme.eq_ignore_ascii_case("https"),
        RemoteMode::Lan => scheme.eq_ignore_ascii_case("https"),
        RemoteMode::Tailscale => scheme.eq_ignore_ascii_case("http"),
        RemoteMode::Loopback => false,
    }
}

fn host_without_port(value: &str) -> String {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest).to_string();
    }
    if let Some((host, port)) = value.rsplit_once(':') {
        if !port.is_empty() && port.chars().all(|character| character.is_ascii_digit()) {
            return host.to_string();
        }
    }
    value.to_string()
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Where a remote request really came from. `ip` is only set when Cockpit can
/// prove it: in tunnel mode the TCP peer is always the local tunnel connector,
/// so only a validated `CF-Connecting-IP` from a loopback peer counts. An
/// untrusted identity is never keyed by the loopback address and never shown
/// to the host.
#[derive(Debug, Clone, Default)]
struct ClientIdentity {
    ip: Option<String>,
    trusted: bool,
}

impl ClientIdentity {
    fn audit_ip(&self) -> Option<&str> {
        if self.trusted {
            self.ip.as_deref()
        } else {
            None
        }
    }

    fn rate_key(&self, prefix: &str) -> String {
        match self.audit_ip() {
            Some(ip) => format!("{prefix}:{ip}"),
            None => format!("{prefix}:untrusted"),
        }
    }
}

async fn capture_client_ip(
    State(state): State<AppState>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let socket_ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    let identity = match state.remote.mode() {
        // The tunnel binds loopback, so the TCP peer is cloudflared itself.
        // Trust the forwarded address only when it is a real IP; otherwise the
        // request has no trustworthy client identity at all.
        RemoteMode::Tunnel => {
            let forwarded = if socket_ip.is_some_and(|ip| ip.is_loopback()) {
                request
                    .headers()
                    .get("cf-connecting-ip")
                    .and_then(|value| value.to_str().ok())
                    .map(str::trim)
                    .and_then(|value| value.parse::<IpAddr>().ok())
                    .map(|ip| ip.to_string())
            } else {
                None
            };
            ClientIdentity {
                trusted: forwarded.is_some(),
                ip: forwarded,
            }
        }
        // Tailscale, LAN, and loopback clients connect directly, so the socket
        // address is the client address.
        _ => ClientIdentity {
            trusted: socket_ip.is_some(),
            ip: socket_ip.map(|ip| ip.to_string()),
        },
    };
    request.extensions_mut().insert(identity);
    next.run(request).await
}

fn client_identity(request: &axum::extract::Request) -> ClientIdentity {
    request
        .extensions()
        .get::<ClientIdentity>()
        .cloned()
        .unwrap_or_default()
}

/// Live events that carry terminal text or file paths. A status-only device
/// still receives the event stream, but these are filtered out.
fn event_needs_content(event_type: &str) -> bool {
    matches!(event_type, "agent.output" | "tool.completed")
}

fn require_scope(principal: &RemotePrincipal, scope: Scope) -> Option<Response> {
    if principal.allows(scope) {
        None
    } else {
        Some(api_error(
            StatusCode::FORBIDDEN,
            "scope_required",
            format!(
                "This device needs the {} scope. The host can raise it in Settings.",
                scope.as_str()
            ),
        ))
    }
}

fn remote_auth_error(error: RemoteAuthError) -> Response {
    let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::UNAUTHORIZED);
    api_error(status, error.code(), error.message())
}

fn rate_limited(remaining: Duration) -> Response {
    let seconds = remaining.as_secs().max(1).to_string();
    let mut response = api_error(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "Too many attempts. Wait a moment and try again.",
    );
    if let Ok(value) = HeaderValue::from_str(&seconds) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn api_error(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    ApiError::new(status, code, message).into_response()
}

async fn api_not_found() -> Response {
    api_error(
        StatusCode::NOT_FOUND,
        "not_found",
        "No remote Cockpit route matches this path.",
    )
}

/// The remote listener is not a proxy. These paths must never resolve there.
pub fn is_proxy_path(path: &str) -> bool {
    let path = path.trim_start_matches('/');
    path == "v1"
        || path.starts_with("v1/")
        || path == "openai"
        || path.starts_with("openai/")
        || path == "anthropic"
        || path.starts_with("anthropic/")
        || path == "gemini"
        || path.starts_with("gemini/")
        || path == "s"
        || path.starts_with("s/")
}

/// Exposed for tests: reject proxy paths before the dashboard fallback.
pub async fn block_proxy_paths(request: axum::extract::Request, next: Next) -> Response {
    if is_proxy_path(request.uri().path()) {
        return api_error(
            StatusCode::NOT_FOUND,
            "not_found",
            "The remote listener does not serve model proxy routes.",
        );
    }
    next.run(request).await
}
