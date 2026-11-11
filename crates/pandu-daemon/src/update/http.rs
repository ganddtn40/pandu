use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use super::UpdateStatus;
use crate::api::ApiError;
use crate::state::AppState;

pub async fn status(State(state): State<AppState>) -> Json<UpdateStatus> {
    Json(state.update.status())
}

pub async fn check(State(state): State<AppState>) -> Json<UpdateStatus> {
    Json(state.update.check(true).await)
}

#[derive(Debug, Deserialize)]
pub struct SnoozeBody {
    pub choice: String,
}

pub async fn snooze(
    State(state): State<AppState>,
    Json(body): Json<SnoozeBody>,
) -> Result<Json<UpdateStatus>, ApiError> {
    state
        .update
        .snooze(body.choice.trim())
        .map(Json)
        .map_err(update_error)
}

#[derive(Debug, Deserialize)]
pub struct SettingsBody {
    pub enabled: bool,
}

pub async fn update_settings(
    State(state): State<AppState>,
    Json(body): Json<SettingsBody>,
) -> Result<Json<UpdateStatus>, ApiError> {
    state
        .update
        .set_enabled(body.enabled)
        .map(Json)
        .map_err(update_error)
}

pub async fn migrations(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let migration = state
        .store
        .last_migration()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(json!({ "migration": migration })))
}

fn update_error(error: pandu_core::update::UpdateError) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "update_error", error.to_string())
}
