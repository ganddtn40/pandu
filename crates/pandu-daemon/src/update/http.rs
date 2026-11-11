use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use pandu_core::model::SessionStatus;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::process::Command;

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

/// The body every apply or rollback request must carry.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmBody {
    /// Explicit consent. Absent or false always refuses.
    #[serde(default)]
    pub confirm: bool,
    /// The active session ids the user saw and accepted. Required when any
    /// agent session is running.
    #[serde(default)]
    pub session_ids: Vec<String>,
}

/// Download, verify, and install the update. Host-only and CSRF-protected.
///
/// The daemon never installs silently: `confirm` must be true, and when agent
/// sessions are running the caller must echo their ids. The install itself runs
/// the same `pandu update --yes --json` path as the CLI so there is exactly one
/// verifier. Demo mode refuses before doing any work.
pub async fn apply(
    State(state): State<AppState>,
    Json(body): Json<ConfirmBody>,
) -> Result<Json<Value>, ApiError> {
    let outcome = run_confirmed(&state, body, Action::Apply).await?;
    Ok(Json(json!({
        "applied": true,
        "outcome": outcome,
    })))
}

/// Restore the previous binary. Same confirmation rules as [`apply`].
pub async fn rollback(
    State(state): State<AppState>,
    Json(body): Json<ConfirmBody>,
) -> Result<Json<Value>, ApiError> {
    let outcome = run_confirmed(&state, body, Action::Rollback).await?;
    Ok(Json(json!({
        "rolledBack": true,
        "outcome": outcome,
    })))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Apply,
    Rollback,
}

impl Action {
    fn verb(self) -> &'static str {
        match self {
            Self::Apply => "update",
            Self::Rollback => "rollback",
        }
    }
}

async fn run_confirmed(
    state: &AppState,
    body: ConfirmBody,
    action: Action,
) -> Result<Value, ApiError> {
    if state.config.demo_mode {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "demo_mode",
            "Demo mode never installs or rolls back updates.",
        ));
    }
    if !body.confirm {
        let sessions = active_sessions(state)?;
        return Err(confirmation_required(sessions));
    }

    let sessions = active_sessions(state)?;
    if !sessions.is_empty() {
        let mut expected = sessions
            .iter()
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let mut supplied = body.session_ids.clone();
        expected.sort();
        supplied.sort();
        if supplied != expected {
            return Err(confirmation_required(sessions));
        }
    }

    let executable = std::env::current_exe().map_err(|error| {
        tracing::error!(%error, "could not locate the running binary");
        ApiError::internal("Pandu could not locate its own binary.")
    })?;
    let args: &[&str] = match action {
        Action::Apply => &["update", "--yes", "--json"],
        Action::Rollback => &["rollback", "--json"],
    };
    let output = tokio::time::timeout(
        Duration::from_secs(180),
        Command::new(&executable)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "update_timeout",
            "The update did not finish in time. Nothing else will run.",
        )
    })?
    .map_err(|error| {
        tracing::error!(%error, "could not start the updater");
        ApiError::internal("Pandu could not start its updater.")
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!(
                "`{} {}` failed with {}. Nothing was changed.",
                pandu_core::brand::CLI_COMMAND,
                action.verb(),
                output.status
            )
        } else {
            stderr
        };
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "update_failed",
            message,
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| {
        tracing::error!(%error, "the updater returned an unexpected response");
        ApiError::internal("The updater returned an unexpected response.")
    })
}

fn active_sessions(state: &AppState) -> Result<Vec<pandu_core::model::Session>, ApiError> {
    state
        .store
        .list_sessions(50, 0, Some(SessionStatus::Active))
        .map_err(|error| ApiError::internal(error.to_string()))
}

fn confirmation_required(sessions: Vec<pandu_core::model::Session>) -> ApiError {
    let details = sessions
        .iter()
        .map(|session| {
            json!({
                "id": session.id,
                "title": session.title,
                "agent": session.agent.as_ref().and_then(|agent| agent.name.clone()),
            })
        })
        .collect::<Vec<_>>();
    ApiError::new(
        StatusCode::CONFLICT,
        "confirmation_required",
        if details.is_empty() {
            "Confirm the update before it runs.".to_string()
        } else {
            format!(
                "{} agent session(s) are running. Confirm them before the update.",
                details.len()
            )
        },
    )
    .with_details(json!({ "sessions": details }))
}

fn update_error(error: pandu_core::update::UpdateError) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "update_error", error.to_string())
}
