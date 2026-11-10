//! Host-only HTTP surface for the market.
//!
//! These handlers are mounted on the loopback listener only. The remote
//! listener never sees them: `HOST_ONLY_PREFIX` is asserted by the remote
//! isolation test. Network access happens only on an explicit refresh or
//! install action, or on the opt-in daily refresh.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::ApiError;
use crate::market::install::{
    InstallOutcome, InstallPreview, UndoOutcome, UninstallOutcome, UninstallPreview,
};
use crate::market::service::{
    CatalogResponse, InstalledResponse, MarketDetail, MarketService, MarketSettings,
};
use crate::market::{InstallScope, MarketError, MarketKind};
use crate::state::AppState;

fn market_error(error: MarketError) -> ApiError {
    let status = match &error {
        MarketError::NotFound(_) => StatusCode::NOT_FOUND,
        MarketError::Signature(_) => StatusCode::CONFLICT,
        MarketError::Network(_) => StatusCode::BAD_GATEWAY,
        MarketError::Install(_) => StatusCode::CONFLICT,
        MarketError::Registry(_)
        | MarketError::Entry(_)
        | MarketError::Archive(_)
        | MarketError::Config(_)
        | MarketError::Manifest(_) => StatusCode::BAD_REQUEST,
    };
    ApiError::new(status, error.code(), error.to_string())
}

fn service(state: &AppState) -> &MarketService {
    state.market.as_ref()
}

fn parse_kind(value: &str) -> Result<MarketKind, ApiError> {
    MarketKind::parse(value).ok_or_else(|| ApiError::bad_request("The market kind is not valid."))
}

pub async fn catalog(State(state): State<AppState>) -> Result<Json<CatalogResponse>, ApiError> {
    service(&state)
        .catalog(true)
        .await
        .map(Json)
        .map_err(market_error)
}

pub async fn refresh(State(state): State<AppState>) -> Result<Json<CatalogResponse>, ApiError> {
    service(&state)
        .refresh()
        .await
        .map(Json)
        .map_err(market_error)
}

pub async fn detail(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Json<MarketDetail>, ApiError> {
    let kind = parse_kind(&kind)?;
    service(&state)
        .detail(kind, &id)
        .await
        .map(Json)
        .map_err(market_error)
}

pub async fn installed(State(state): State<AppState>) -> Result<Json<InstalledResponse>, ApiError> {
    service(&state)
        .installed_checked()
        .await
        .map(Json)
        .map_err(market_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequest {
    pub kind: String,
    pub id: String,
    pub agent: String,
    pub scope: InstallScope,
}

pub async fn preview(
    State(state): State<AppState>,
    Json(request): Json<PreviewRequest>,
) -> Result<Json<InstallPreview>, ApiError> {
    let kind = parse_kind(&request.kind)?;
    service(&state)
        .preview(kind, &request.id, &request.agent, request.scope)
        .await
        .map(Json)
        .map_err(market_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub preview_id: String,
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}

pub async fn install(
    State(state): State<AppState>,
    Json(request): Json<InstallRequest>,
) -> Result<Json<InstallOutcome>, ApiError> {
    service(&state)
        .install(&request.preview_id, request.secrets)
        .map(Json)
        .map_err(market_error)
}

pub async fn preview_uninstall(
    State(state): State<AppState>,
    Path(install_id): Path<String>,
) -> Result<Json<UninstallPreview>, ApiError> {
    service(&state)
        .preview_uninstall(&install_id)
        .map(Json)
        .map_err(market_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallRequest {
    #[serde(default)]
    pub confirm_edited: bool,
}

pub async fn uninstall(
    State(state): State<AppState>,
    Path(install_id): Path<String>,
    Json(request): Json<UninstallRequest>,
) -> Result<Json<UninstallOutcome>, ApiError> {
    service(&state)
        .uninstall(&install_id, request.confirm_edited)
        .map(Json)
        .map_err(market_error)
}

pub async fn undo(
    State(state): State<AppState>,
    Path(install_id): Path<String>,
    Json(request): Json<UninstallRequest>,
) -> Result<Json<UndoOutcome>, ApiError> {
    service(&state)
        .undo(&install_id, request.confirm_edited)
        .map(Json)
        .map_err(market_error)
}

pub async fn settings(State(state): State<AppState>) -> Json<MarketSettings> {
    Json(service(&state).settings())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsRequest {
    pub auto_refresh: bool,
}

pub async fn update_settings(
    State(state): State<AppState>,
    Json(request): Json<SettingsRequest>,
) -> Result<Json<MarketSettings>, ApiError> {
    service(&state)
        .set_auto_refresh(request.auto_refresh)
        .map(Json)
        .map_err(market_error)
}

/// A tiny discovery endpoint so the UI can show which registry source is in
/// use without guessing. It never triggers network access.
pub async fn status(State(state): State<AppState>) -> Json<Value> {
    let settings = service(&state).settings();
    Json(json!({
        "hostOnly": true,
        "autoRefresh": settings.auto_refresh,
        "lastRefresh": settings.last_refresh,
    }))
}
