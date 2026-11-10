//! Host-only remote access management.
//!
//! Every handler in this module is mounted on the loopback router only. The
//! remote listener never exposes enable/disable, device management, the audit
//! log, or pairing confirmation.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::ApiError;
use crate::remote::auth::{Scope, ScopeSet};
use crate::remote::{
    DEFAULT_DEVICE_EXPIRY_DAYS, DEVICE_EXPIRY_CHOICES, RemoteAccess, RemoteMode,
    TUNNEL_DEVICE_EXPIRY_DAYS,
};
use crate::state::AppState;
use crate::store::{RemoteDeviceRow, now_iso};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableInput {
    pub mode: String,
    #[serde(default)]
    pub public_url: Option<String>,
}

pub async fn status(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.remote.status().await))
}

pub async fn settings(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "revokeOnDisable": state.remote.revoke_on_disable() }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsInput {
    pub revoke_on_disable: bool,
}

pub async fn update_settings(
    State(state): State<AppState>,
    Json(input): Json<RemoteSettingsInput>,
) -> Result<Json<Value>, ApiError> {
    state
        .remote
        .set_revoke_on_disable(input.revoke_on_disable)
        .map_err(store_error)?;
    state.remote.audit(
        "remote.settings",
        None,
        None,
        json!({ "revokeOnDisable": input.revoke_on_disable }),
        None,
        None,
    );
    Ok(Json(
        json!({ "revokeOnDisable": state.remote.revoke_on_disable() }),
    ))
}

pub async fn enable(
    State(state): State<AppState>,
    Json(input): Json<EnableInput>,
) -> Result<Json<Value>, ApiError> {
    let mode = RemoteMode::parse(&input.mode)
        .ok_or_else(|| ApiError::bad_request("mode must be tailscale, tunnel, or lan"))?;
    if mode == RemoteMode::Loopback {
        return Err(ApiError::bad_request(
            "Choose Tailscale, tunnel, or LAN to turn remote access on.",
        ));
    }
    if state.config.remote_port == 0 {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "remote_disabled",
            "This daemon was started with PANDU_REMOTE_PORT=0, so the remote listener is disabled.",
        ));
    }
    crate::server::start_remote(&state, mode, input.public_url)
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "remote_start_failed",
                error.to_string(),
            )
        })?;
    let status = state.remote.status().await;
    state.remote.audit(
        "remote.enabled",
        None,
        None,
        json!({
            "mode": mode.as_str(),
            "url": status.url,
            "fingerprint": status.fingerprint,
        }),
        None,
        None,
    );
    Ok(Json(json!(status)))
}

pub async fn disable(State(state): State<AppState>) -> Json<Value> {
    crate::server::stop_remote(&state, false).await;
    let revoked = if state.remote.revoke_on_disable() {
        let revoked = state
            .store
            .revoke_all_remote_devices(&now_iso())
            .unwrap_or(0);
        if revoked > 0 {
            state.remote.bump_epoch();
        }
        revoked
    } else {
        0
    };
    state.remote.audit(
        "remote.disabled",
        None,
        None,
        json!({ "reason": "host_disabled", "revokedDevices": revoked }),
        None,
        None,
    );
    Json(json!(state.remote.status().await))
}

pub async fn panic(State(state): State<AppState>) -> Json<Value> {
    crate::server::stop_remote(&state, true).await;
    let revoked = state
        .store
        .revoke_all_remote_devices(&now_iso())
        .unwrap_or(0);
    state.remote.bump_epoch();
    state.remote.clear_prompts();
    state.remote.audit(
        "remote.panic",
        None,
        None,
        json!({ "revokedDevices": revoked }),
        None,
        None,
    );
    Json(json!({
        "stopped": true,
        "revokedDevices": revoked,
        "status": state.remote.status().await,
    }))
}

// ----- Pairing ------------------------------------------------------------

pub async fn pair_code(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    if !state.remote.is_enabled() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "remote_off",
            "Turn remote access on before pairing a device.",
        ));
    }
    let Some(url) = state.remote.url() else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "remote_off",
            "The remote listener has no address yet.",
        ));
    };
    let issued = state.pairing.issue_code();
    let fingerprint = state.remote.fingerprint();
    let payload = json!({
        "v": 1,
        "url": url,
        "code": issued.code,
        "fingerprint": fingerprint,
    });
    let qr_svg = qr_svg(&payload.to_string()).unwrap_or_default();
    state.remote.audit(
        "pair.code",
        None,
        None,
        json!({
            "expiresAt": issued.expires_at,
            "url": url,
        }),
        None,
        None,
    );
    Ok(Json(json!({
        "code": issued.code,
        "expiresAt": issued.expires_at,
        "expiresInSeconds": issued.expires_in_seconds,
        "url": url,
        "fingerprint": fingerprint,
        "qrSvg": qr_svg,
        "qrPayload": payload,
    })))
}

pub async fn pending_pairings(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "pairings": state.pairing.pending() }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPairingInput {
    pub verification_code: String,
    #[serde(default)]
    pub expires_in_days: Option<u32>,
}

fn expiry_from_days(days: u32) -> String {
    (Utc::now() + chrono::Duration::days(i64::from(days))).to_rfc3339()
}

fn valid_expiry_days(days: u32) -> bool {
    DEVICE_EXPIRY_CHOICES.contains(&days)
}

pub async fn confirm_pairing(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<ConfirmPairingInput>,
) -> Result<Json<Value>, ApiError> {
    let days = input.expires_in_days.unwrap_or_else(|| {
        if state.remote.mode() == RemoteMode::Tunnel {
            TUNNEL_DEVICE_EXPIRY_DAYS
        } else {
            DEFAULT_DEVICE_EXPIRY_DAYS
        }
    });
    if !valid_expiry_days(days) {
        return Err(ApiError::bad_request(
            "Device access must be 7, 14, 30, or 90 days.",
        ));
    }
    let expires_at = expiry_from_days(days);
    let pairing =
        match state
            .pairing
            .confirm(&id, &input.verification_code, Some(expires_at.clone()))
        {
            Ok(pairing) => pairing,
            Err(error) => {
                if error == crate::remote::pairing::PairingError::VerificationMismatch {
                    state.remote.audit(
                        "pair.verify_failed",
                        None,
                        None,
                        json!({ "claimId": id }),
                        None,
                        None,
                    );
                }
                return Err(pairing_error(error));
            }
        };
    state.remote.audit(
        "pair.confirm",
        Some((&pairing.device_id, &pairing.device_name)),
        None,
        json!({ "claimId": id, "expiresInDays": days, "expiresAt": expires_at }),
        None,
        None,
    );
    Ok(Json(json!({ "pairing": pairing })))
}

pub async fn deny_pairing(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state.pairing.deny(&id).map_err(pairing_error)?;
    state.remote.audit(
        "pair.deny",
        None,
        None,
        json!({ "claimId": id }),
        None,
        None,
    );
    Ok(Json(json!({ "denied": true })))
}

// ----- Devices ------------------------------------------------------------

pub async fn devices(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = state.store.list_remote_devices().map_err(store_error)?;
    let devices: Vec<RemoteDeviceView> = rows.iter().map(RemoteDeviceView::from_row).collect();
    Ok(Json(json!({ "devices": devices })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePatch {
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub require_host_confirmation: Option<bool>,
    #[serde(default)]
    pub expires_in_days: Option<u32>,
}

pub async fn update_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(patch): Json<DevicePatch>,
) -> Result<Json<Value>, ApiError> {
    let scopes = match patch.scopes {
        Some(values) => {
            for value in &values {
                if Scope::parse(value).is_none() {
                    return Err(ApiError::bad_request(format!(
                        "`{value}` is not a known scope."
                    )));
                }
            }
            ScopeSet::from_strings(&values).to_strings()
        }
        None => {
            let Some(device) = state.store.get_remote_device(&id).map_err(store_error)? else {
                return Err(ApiError::not_found("That device does not exist."));
            };
            device.scopes
        }
    };
    let updated = state
        .store
        .update_remote_device(&id, &scopes, patch.require_host_confirmation)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That device does not exist."))?;
    if let Some(days) = patch.expires_in_days {
        if !valid_expiry_days(days) {
            return Err(ApiError::bad_request(
                "Device access must be 7, 14, 30, or 90 days.",
            ));
        }
        let expires_at = expiry_from_days(days);
        state
            .store
            .set_remote_device_expiry(&id, &expires_at)
            .map_err(store_error)?;
        state.remote.audit(
            "device.expiry",
            Some((&updated.id, &updated.name)),
            None,
            json!({ "expiresInDays": days, "expiresAt": expires_at }),
            None,
            None,
        );
    }
    let updated = state
        .store
        .get_remote_device(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That device does not exist."))?;
    // A scope change closes every open socket for this device, then the
    // device reconnects with its new permissions.
    state.remote.bump_epoch();
    state.remote.audit(
        "device.scopes",
        Some((&updated.id, &updated.name)),
        None,
        json!({
            "scopes": updated.scopes,
            "requireHostConfirmation": updated.require_host_confirmation,
        }),
        None,
        None,
    );
    Ok(Json(
        json!({ "device": RemoteDeviceView::from_row(&updated) }),
    ))
}

pub async fn reset_device_respond(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let device = state
        .store
        .get_remote_device(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That device does not exist."))?;
    state
        .store
        .clear_remote_pin_failures(&id)
        .map_err(store_error)?;
    let updated = state
        .store
        .get_remote_device(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That device does not exist."))?;
    state.remote.audit(
        "device.respond_reset",
        Some((&device.id, &device.name)),
        None,
        json!({ "previousFailures": device.pin_failures }),
        None,
        None,
    );
    Ok(Json(
        json!({ "device": RemoteDeviceView::from_row(&updated) }),
    ))
}

pub async fn revoke_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let device = state
        .store
        .get_remote_device(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That device does not exist."))?;
    let revoked = state
        .store
        .revoke_remote_device(&id, &now_iso())
        .map_err(store_error)?;
    state.remote.bump_epoch();
    state.remote.audit(
        "device.revoke",
        Some((&device.id, &device.name)),
        None,
        json!({ "revoked": revoked }),
        None,
        None,
    );
    Ok(Json(json!({ "revoked": true })))
}

pub async fn rotate_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let device = state
        .store
        .get_remote_device(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That device does not exist."))?;
    if device.revoked_at.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "device_revoked",
            "Revoked devices cannot be rotated. Pair the device again.",
        ));
    }
    let token = crate::remote::auth::new_token();
    state
        .store
        .set_remote_device_token_hash(&id, &crate::remote::auth::hash_token(&token))
        .map_err(store_error)?;
    let updated = state
        .store
        .get_remote_device(&id)
        .map_err(store_error)?
        .ok_or_else(|| ApiError::not_found("That device does not exist."))?;
    state.remote.bump_epoch();
    state.remote.audit(
        "device.rotate",
        Some((&device.id, &device.name)),
        None,
        json!({ "reason": "host" }),
        None,
        None,
    );
    Ok(Json(json!({
        "token": token,
        "device": RemoteDeviceView::from_row(&updated),
        "note": "Copy this token now. It is shown once and replaces the old token immediately.",
    })))
}

// ----- Audit --------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

pub async fn audit(
    State(state): State<AppState>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.unwrap_or(100).clamp(1, 1_000);
    let offset = query.offset.unwrap_or(0);
    let entries = state
        .store
        .list_remote_audit(limit, offset)
        .map_err(store_error)?;
    let total = state.store.count_remote_audit().map_err(store_error)?;
    Ok(Json(json!({
        "entries": entries,
        "total": total,
        "limit": limit,
        "offset": offset,
    })))
}

pub async fn audit_export(State(state): State<AppState>) -> Result<Response, ApiError> {
    let entries = state
        .store
        .list_remote_audit(10_000, 0)
        .map_err(store_error)?;
    let body = json!({
        "exportedAt": now_iso(),
        "product": "Pandu",
        "entries": entries,
    });
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_static("attachment; filename=\"pandu-remote-audit.json\""),
    );
    Ok(response)
}

// ----- Remote prompts -----------------------------------------------------

pub async fn pending_prompts(State(state): State<AppState>) -> Json<Value> {
    // The host must be able to read the exact text it is about to send. This
    // response exists only on the loopback listener; the remote device never
    // sees another device's pending prompt text.
    let prompts: Vec<Value> = state
        .remote
        .list_prompts()
        .into_iter()
        .map(|prompt| {
            let mut value = serde_json::to_value(&prompt).unwrap_or_else(|_| json!({}));
            if let Some(object) = value.as_object_mut() {
                object.insert("text".to_string(), json!(prompt.text));
            }
            value
        })
        .collect();
    Json(json!({ "prompts": prompts }))
}

pub async fn approve_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(prompt) = state.remote.approve_prompt(&id) else {
        return Err(ApiError::not_found(
            "That remote prompt expired or was already handled.",
        ));
    };
    match crate::remote::api::push_prompt(&state, &prompt) {
        Ok(sequence) => {
            state.remote.audit(
                "prompt.sent",
                Some((&prompt.device_id, &prompt.device_name)),
                None,
                json!({
                    "promptId": prompt.id,
                    "sessionId": prompt.session_id,
                    "sequence": sequence,
                    "hostConfirmation": true,
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
                    "deviceName": prompt.device_name,
                    "sessionId": prompt.session_id,
                }),
            );
            Ok(Json(json!({
                "sent": true,
                "sequence": sequence,
                "promptId": prompt.id,
            })))
        }
        Err(message) => {
            state.remote.audit(
                "prompt.failed",
                Some((&prompt.device_id, &prompt.device_name)),
                None,
                json!({ "promptId": prompt.id, "sessionId": prompt.session_id }),
                Some(prompt.size_bytes),
                Some(&prompt.content_hash),
            );
            Err(ApiError::new(
                StatusCode::CONFLICT,
                "prompt_failed",
                message,
            ))
        }
    }
}

pub async fn deny_prompt(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(prompt) = state.remote.deny_prompt(&id) else {
        return Err(ApiError::not_found(
            "That remote prompt expired or was already handled.",
        ));
    };
    state.remote.audit(
        "prompt.denied",
        Some((&prompt.device_id, &prompt.device_name)),
        None,
        json!({ "promptId": prompt.id, "sessionId": prompt.session_id }),
        Some(prompt.size_bytes),
        Some(&prompt.content_hash),
    );
    Ok(Json(json!({ "denied": true })))
}

// ----- Tools, notifications, matrix --------------------------------------

pub async fn tools(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.remote.tools(state.config.remote_port).await))
}

pub async fn matrix() -> Json<Value> {
    Json(json!({ "endpoints": RemoteAccess::scope_matrix() }))
}

pub async fn notifications(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.remote.notification_status()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInput {
    pub enabled: bool,
    #[serde(default)]
    pub server: Option<String>,
}

pub async fn update_notifications(
    State(state): State<AppState>,
    Json(input): Json<NotificationInput>,
) -> Result<Json<Value>, ApiError> {
    let status = state
        .remote
        .update_notifications(input.enabled, input.server)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(Json(json!(status)))
}

pub async fn test_notification(State(state): State<AppState>) -> Json<Value> {
    state.remote.send_notification("test").await;
    Json(json!({ "sent": true }))
}

// ----- Helpers ------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeviceView {
    pub id: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub require_host_confirmation: bool,
    pub has_pin: bool,
    pub pin_failures: u32,
    pub respond_locked: bool,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
}

impl RemoteDeviceView {
    fn from_row(row: &RemoteDeviceRow) -> Self {
        Self {
            id: row.id.clone(),
            name: row.name.clone(),
            scopes: ScopeSet::from_strings(&row.scopes).to_strings(),
            require_host_confirmation: row.require_host_confirmation,
            has_pin: row.pin_hash.is_some(),
            pin_failures: row.pin_failures,
            respond_locked: row.respond_locked_at.is_some(),
            created_at: row.created_at.clone(),
            last_seen_at: row.last_seen_at.clone(),
            expires_at: row.expires_at.clone(),
            revoked_at: row.revoked_at.clone(),
        }
    }
}

fn qr_svg(payload: &str) -> Option<String> {
    let code = qrcode::QrCode::new(payload.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(240, 240)
            .dark_color(qrcode::render::svg::Color("#0b0f16"))
            .light_color(qrcode::render::svg::Color("#ffffff"))
            .build(),
    )
}

fn pairing_error(error: crate::remote::pairing::PairingError) -> ApiError {
    let status = match error {
        crate::remote::pairing::PairingError::ClaimNotFound
        | crate::remote::pairing::PairingError::AlreadyResolved => StatusCode::NOT_FOUND,
        crate::remote::pairing::PairingError::Expired => StatusCode::GONE,
        _ => StatusCode::BAD_REQUEST,
    };
    ApiError::new(status, error.code(), error.message())
}

fn store_error(error: crate::error::DaemonError) -> ApiError {
    tracing::error!(%error, "a remote access database operation failed");
    ApiError::internal("Pandu could not read its local database.")
}
