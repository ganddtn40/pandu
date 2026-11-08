//! Remote access service.
//!
//! Remote access is off by default and can only be turned on from the host
//! (loopback) UI. The remote listener is a *separate* router: it serves the
//! dashboard, a scoped read/respond/prompt API, and a live WebSocket. Model
//! proxy routes are never mounted there.
//!
//! Everything safety-relevant lives here: device tokens (hash only), scopes,
//! idle expiry, one-time WebSocket tickets, the revocation epoch, pending
//! remote prompts, audit rows, and tool detection. No prompt text is ever
//! written to the audit log.

pub mod api;
pub mod auth;
pub mod host;
pub mod pairing;
pub mod ui;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{DaemonError, Result};
use crate::store::{NewRemoteAudit, RemoteDeviceRow, Store, now_iso};

pub use auth::{RemotePrincipal, Scope, ScopeSet};
pub use pairing::{PairingError, PairingManager};

pub const DEFAULT_REMOTE_PORT: u16 = 4320;
pub const IDLE_EXPIRY_DAYS: i64 = 30;
pub const MAX_PROMPT_CHARS: usize = 2_000;
pub const MAX_REMOTE_CONNECTIONS: usize = 32;
pub const WS_TICKET_TTL_SECONDS: u64 = 30;
pub const PAIR_CLAIM_TTL_SECONDS: i64 = pairing::CLAIM_TTL_SECONDS as i64;
pub const PROMPT_TTL_SECONDS: i64 = 120;

/// How the optional listener is exposed. `Loopback` means "off".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteMode {
    Loopback,
    Tailscale,
    Tunnel,
    Lan,
}

impl RemoteMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Loopback => "loopback",
            Self::Tailscale => "tailscale",
            Self::Tunnel => "tunnel",
            Self::Lan => "lan",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "loopback" | "off" => Some(Self::Loopback),
            "tailscale" => Some(Self::Tailscale),
            "tunnel" | "cloudflare" => Some(Self::Tunnel),
            "lan" => Some(Self::Lan),
            _ => None,
        }
    }

    pub fn uses_tls(self) -> bool {
        matches!(self, Self::Lan)
    }

    pub fn binds_loopback(self) -> bool {
        matches!(self, Self::Tunnel)
    }

    pub fn warning(self) -> &'static str {
        match self {
            Self::Loopback => "Remote access is off. This is the safest choice.",
            Self::Tailscale => {
                "Recommended. Only devices on your private tailnet can reach Cockpit."
            }
            Self::Tunnel => {
                "The tunnel URL is public on the internet. Cockpit authentication is still enforced, but a named tunnel with Cloudflare Access is safer."
            }
            Self::Lan => {
                "Strongly discouraged. Any device on your local network can try to connect. LAN mode requires HTTPS with a pinned certificate."
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub detail: Option<String>,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTools {
    pub tailscale: ToolStatus,
    pub cloudflared: ToolStatus,
    pub lan_ip: Option<String>,
    pub tailscale_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationStatus {
    pub enabled: bool,
    pub server: String,
    pub topic: Option<String>,
    pub third_party: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub mode: RemoteMode,
    pub url: Option<String>,
    pub fingerprint: Option<String>,
    pub port: u16,
    pub started_at: Option<String>,
    pub last_error: Option<String>,
    pub devices: u64,
    pub pending_pairings: usize,
    pub pending_prompts: usize,
    pub notifications: NotificationStatus,
    pub tools: RemoteTools,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointScope {
    pub method: &'static str,
    pub path: &'static str,
    pub scope: &'static str,
    pub note: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPrompt {
    pub id: String,
    pub device_id: String,
    pub device_name: String,
    pub session_id: String,
    pub created_at: String,
    pub expires_at: String,
    pub size_bytes: u64,
    pub content_hash: String,
    #[serde(skip)]
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct WsTicket {
    pub device_id: String,
    pub epoch: u64,
    pub expires_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteAuthError {
    Missing,
    Invalid,
    Revoked,
    Expired,
}

impl RemoteAuthError {
    pub fn status(self) -> u16 {
        match self {
            Self::Missing | Self::Invalid => 401,
            Self::Revoked | Self::Expired => 403,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Missing => "remote_token_missing",
            Self::Invalid => "remote_token_invalid",
            Self::Revoked => "remote_device_revoked",
            Self::Expired => "remote_device_expired",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Missing => "This device needs to pair with Cockpit first.",
            Self::Invalid => "That Cockpit token is not valid.",
            Self::Revoked => "This device was revoked by the host.",
            Self::Expired => "This device has not been used for 30 days. Pair it again.",
        }
    }
}

struct RemoteInner {
    enabled: bool,
    mode: RemoteMode,
    url: Option<String>,
    fingerprint: Option<String>,
    bound_host: Option<String>,
    port: u16,
    started_at: Option<String>,
    last_error: Option<String>,
}

pub struct RemoteAccess {
    store: Arc<Store>,
    pairing: Arc<PairingManager>,
    rate: auth::RateLimiter,
    inner: Mutex<RemoteInner>,
    epoch: AtomicU64,
    prompts: Mutex<HashMap<String, PendingPrompt>>,
    tickets: Mutex<HashMap<String, WsTicket>>,
    touched: Mutex<HashMap<String, Instant>>,
    tools_cache: tokio::sync::Mutex<Option<(Instant, RemoteTools)>>,
    notify_client: reqwest::Client,
    pub connections: Arc<tokio::sync::Semaphore>,
    server: Mutex<Option<RemoteServerHandle>>,
}

/// A running remote listener owned by the daemon. TLS uses `axum-server` so
/// LAN mode can present the pinned self-signed certificate.
pub enum RemoteServerHandle {
    Plain {
        shutdown: tokio::sync::oneshot::Sender<()>,
        task: tokio::task::JoinHandle<()>,
    },
    Tls {
        handle: axum_server::Handle,
        task: tokio::task::JoinHandle<()>,
    },
}

impl RemoteServerHandle {
    pub async fn stop(self, immediate: bool) {
        match self {
            Self::Plain { shutdown, task } => {
                let _ = shutdown.send(());
                if immediate {
                    task.abort();
                } else {
                    let abort = task.abort_handle();
                    if tokio::time::timeout(Duration::from_secs(2), task)
                        .await
                        .is_err()
                    {
                        abort.abort();
                    }
                }
            }
            Self::Tls { handle, task } => {
                handle.graceful_shutdown(Some(Duration::from_secs(if immediate { 0 } else { 2 })));
                if immediate {
                    task.abort();
                } else {
                    let abort = task.abort_handle();
                    if tokio::time::timeout(Duration::from_secs(3), task)
                        .await
                        .is_err()
                    {
                        abort.abort();
                    }
                }
            }
        }
    }
}

impl RemoteAccess {
    pub fn new(store: Arc<Store>, pairing: Arc<PairingManager>) -> Arc<Self> {
        let notify_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Arc::new(Self {
            store,
            pairing,
            rate: auth::RateLimiter::new(),
            inner: Mutex::new(RemoteInner {
                enabled: false,
                mode: RemoteMode::Loopback,
                url: None,
                fingerprint: None,
                bound_host: None,
                port: DEFAULT_REMOTE_PORT,
                started_at: None,
                last_error: None,
            }),
            epoch: AtomicU64::new(1),
            prompts: Mutex::new(HashMap::new()),
            tickets: Mutex::new(HashMap::new()),
            touched: Mutex::new(HashMap::new()),
            tools_cache: tokio::sync::Mutex::new(None),
            notify_client,
            connections: Arc::new(tokio::sync::Semaphore::new(MAX_REMOTE_CONNECTIONS)),
            server: Mutex::new(None),
        })
    }

    pub fn pairing(&self) -> &Arc<PairingManager> {
        &self.pairing
    }

    pub fn is_enabled(&self) -> bool {
        self.lock_inner().enabled
    }

    pub fn mode(&self) -> RemoteMode {
        self.lock_inner().mode
    }

    pub fn url(&self) -> Option<String> {
        self.lock_inner().url.clone()
    }

    pub fn fingerprint(&self) -> Option<String> {
        self.lock_inner().fingerprint.clone()
    }

    pub fn bound_host(&self) -> Option<String> {
        self.lock_inner().bound_host.clone()
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    pub fn bump_epoch(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn set_started(
        &self,
        mode: RemoteMode,
        url: String,
        bound_host: String,
        port: u16,
        fingerprint: Option<String>,
    ) {
        let mut inner = self.lock_inner();
        inner.enabled = true;
        inner.mode = mode;
        inner.url = Some(url);
        inner.bound_host = Some(bound_host);
        inner.port = port;
        inner.fingerprint = fingerprint;
        inner.started_at = Some(now_iso());
        inner.last_error = None;
    }

    pub fn set_stopped(&self) {
        let mut inner = self.lock_inner();
        inner.enabled = false;
        inner.mode = RemoteMode::Loopback;
        inner.url = None;
        inner.fingerprint = None;
        inner.bound_host = None;
        inner.started_at = None;
    }

    pub fn set_server(&self, handle: RemoteServerHandle) {
        let mut server = self
            .server
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *server = Some(handle);
    }

    pub fn take_server(&self) -> Option<RemoteServerHandle> {
        self.server
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }

    pub fn set_error(&self, message: impl Into<String>) {
        let mut inner = self.lock_inner();
        inner.enabled = false;
        inner.last_error = Some(message.into());
    }

    pub async fn status(&self) -> RemoteStatus {
        let inner = {
            let inner = self.lock_inner();
            (
                inner.enabled,
                inner.mode,
                inner.url.clone(),
                inner.fingerprint.clone(),
                inner.port,
                inner.started_at.clone(),
                inner.last_error.clone(),
            )
        };
        let devices = self.store.count_active_remote_devices().unwrap_or(0);
        let notifications = self.notification_status();
        let tools = self.tools(inner.4).await;
        RemoteStatus {
            enabled: inner.0,
            mode: inner.1,
            url: inner.2,
            fingerprint: inner.3,
            port: inner.4,
            started_at: inner.5,
            last_error: inner.6,
            devices,
            pending_pairings: self.pairing.pending().len(),
            pending_prompts: self.list_prompts().len(),
            notifications,
            tools,
        }
    }

    // ----- Authentication -------------------------------------------------

    pub fn allow_attempt(&self, key: &str, limit: u32, window: Duration) -> bool {
        self.rate.allow(key, limit, window)
    }

    pub fn lockout_for(&self, key: &str) -> Option<Duration> {
        self.rate.locked_for(key)
    }

    pub fn record_auth_failure(&self, key: &str) -> Duration {
        self.rate.record_failure(key)
    }

    pub fn clear_auth_failures(&self, key: &str) {
        self.rate.clear_failures(key);
    }

    /// Resolve a bearer token into a principal. Only the hash is compared, and
    /// the comparison is constant time. Idle devices expire after 30 days.
    pub fn authorize(&self, token: &str) -> std::result::Result<RemotePrincipal, RemoteAuthError> {
        let token = token.trim();
        if token.is_empty() {
            return Err(RemoteAuthError::Missing);
        }
        let hash = auth::hash_token(token);
        let Some(device) = self
            .store
            .find_remote_device_by_token_hash(&hash)
            .map_err(|_| RemoteAuthError::Invalid)?
        else {
            return Err(RemoteAuthError::Invalid);
        };
        if device.revoked_at.is_some() {
            return Err(RemoteAuthError::Revoked);
        }
        if self.device_is_idle(&device) {
            let _ = self.store.revoke_remote_device(&device.id, &now_iso());
            self.bump_epoch();
            self.audit(
                "auth.expired",
                Some((device.id.as_str(), device.name.as_str())),
                None,
                json!({ "reason": "idle_30_days" }),
                None,
                None,
            );
            return Err(RemoteAuthError::Expired);
        }
        self.touch_device(&device.id);
        Ok(principal_from_row(&device))
    }

    /// Re-check a device without a token, used by the live socket loop so a
    /// revocation closes an already-open connection.
    pub fn principal_by_id(&self, device_id: &str) -> Option<RemotePrincipal> {
        let device = self.store.get_remote_device(device_id).ok().flatten()?;
        if device.revoked_at.is_some() || self.device_is_idle(&device) {
            return None;
        }
        Some(principal_from_row(&device))
    }

    fn device_is_idle(&self, device: &RemoteDeviceRow) -> bool {
        let reference = device
            .last_seen_at
            .as_deref()
            .or(Some(device.created_at.as_str()));
        let Some(reference) = reference else {
            return false;
        };
        let Ok(seen) = DateTime::parse_from_rfc3339(reference) else {
            return false;
        };
        Utc::now().signed_duration_since(seen.with_timezone(&Utc))
            > chrono::Duration::days(IDLE_EXPIRY_DAYS)
    }

    fn touch_device(&self, device_id: &str) {
        let mut touched = self.lock_touched();
        if touched.len() > 4_096 {
            touched.clear();
        }
        let now = Instant::now();
        if touched
            .get(device_id)
            .is_some_and(|last| now.duration_since(*last) < Duration::from_secs(60))
        {
            return;
        }
        touched.insert(device_id.to_string(), now);
        let _ = self.store.touch_remote_device(device_id, &now_iso());
    }

    // ----- WebSocket tickets ---------------------------------------------

    pub fn issue_ws_ticket(&self, device_id: &str) -> String {
        let ticket = auth::new_token();
        let mut tickets = self.lock_tickets();
        let now = Instant::now();
        tickets.retain(|_, entry| entry.expires_at > now);
        tickets.insert(
            ticket.clone(),
            WsTicket {
                device_id: device_id.to_string(),
                epoch: self.epoch(),
                expires_at: now + Duration::from_secs(WS_TICKET_TTL_SECONDS),
            },
        );
        ticket
    }

    pub fn consume_ws_ticket(&self, ticket: &str) -> Option<WsTicket> {
        let mut tickets = self.lock_tickets();
        let entry = tickets.remove(ticket)?;
        if entry.expires_at <= Instant::now() || entry.epoch != self.epoch() {
            return None;
        }
        Some(entry)
    }

    // ----- Remote prompts -------------------------------------------------

    pub fn prompt_rate_ok(&self, device_id: &str) -> bool {
        self.rate
            .allow(&format!("prompt:{device_id}"), 6, Duration::from_secs(60))
    }

    pub fn queue_prompt(
        &self,
        principal: &RemotePrincipal,
        session_id: &str,
        text: &str,
        ip: Option<&str>,
    ) -> PendingPrompt {
        let now = Utc::now();
        let prompt = PendingPrompt {
            id: uuid::Uuid::new_v4().to_string(),
            device_id: principal.device_id.clone(),
            device_name: principal.device_name.clone(),
            session_id: session_id.to_string(),
            created_at: now.to_rfc3339(),
            expires_at: (now + chrono::Duration::seconds(PROMPT_TTL_SECONDS)).to_rfc3339(),
            size_bytes: text.len() as u64,
            content_hash: hash_content(text),
            text: text.to_string(),
        };
        {
            let mut prompts = self.lock_prompts();
            prompts.retain(|_, item| !prompt_expired(item));
            prompts.insert(prompt.id.clone(), prompt.clone());
        }
        self.audit(
            "prompt.requested",
            Some((principal.device_id.as_str(), principal.device_name.as_str())),
            ip,
            json!({
                "promptId": prompt.id,
                "sessionId": prompt.session_id,
                "requiresHostConfirmation": principal.require_host_confirmation,
            }),
            Some(prompt.size_bytes),
            Some(&prompt.content_hash),
        );
        prompt
    }

    pub fn list_prompts(&self) -> Vec<PendingPrompt> {
        let mut prompts = self.lock_prompts();
        prompts.retain(|_, item| !prompt_expired(item));
        let mut items: Vec<PendingPrompt> = prompts.values().cloned().collect();
        items.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        items
    }

    pub fn approve_prompt(&self, id: &str) -> Option<PendingPrompt> {
        let mut prompts = self.lock_prompts();
        prompts.retain(|_, item| !prompt_expired(item));
        prompts.remove(id)
    }

    pub fn deny_prompt(&self, id: &str) -> Option<PendingPrompt> {
        let mut prompts = self.lock_prompts();
        prompts.retain(|_, item| !prompt_expired(item));
        prompts.remove(id)
    }

    pub fn clear_prompts(&self) {
        self.lock_prompts().clear();
    }

    // ----- Audit ----------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn audit(
        &self,
        event: &str,
        device: Option<(&str, &str)>,
        ip: Option<&str>,
        detail: Value,
        size_bytes: Option<u64>,
        content_hash: Option<&str>,
    ) {
        let row = NewRemoteAudit {
            id: uuid::Uuid::new_v4().to_string(),
            at: now_iso(),
            event: event.to_string(),
            device_id: device.map(|(id, _)| id.to_string()),
            device_name: device.map(|(_, name)| name.to_string()),
            ip: ip.map(str::to_string),
            detail: detail.to_string(),
            size_bytes,
            content_hash: content_hash.map(str::to_string),
        };
        if let Err(error) = self.store.insert_remote_audit(&row) {
            tracing::warn!(%error, "could not append a remote access audit row");
        }
    }

    // ----- Notifications --------------------------------------------------

    pub fn notification_status(&self) -> NotificationStatus {
        let enabled = self
            .store
            .get_setting("remote.notify.enabled")
            .ok()
            .flatten()
            .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "on"));
        let server = self
            .store
            .get_setting("remote.notify.server")
            .ok()
            .flatten()
            .unwrap_or_else(|| "https://ntfy.sh".to_string());
        let topic = self.store.get_setting("remote.notify.topic").ok().flatten();
        NotificationStatus {
            enabled,
            server,
            topic,
            third_party: true,
        }
    }

    pub fn update_notifications(
        &self,
        enabled: bool,
        server: Option<String>,
    ) -> Result<NotificationStatus> {
        let server = server
            .unwrap_or_else(|| "https://ntfy.sh".to_string())
            .trim()
            .trim_end_matches('/')
            .to_string();
        let local = server.starts_with("http://127.0.0.1")
            || server.starts_with("http://localhost")
            || server.starts_with("http://[::1]");
        if !server.starts_with("https://") && !local {
            return Err(DaemonError::config(
                "Notification servers must use https:// (or http://127.0.0.1 for self-hosting).",
            ));
        }
        let mut topic = self.store.get_setting("remote.notify.topic")?;
        if enabled && topic.as_deref().unwrap_or("").is_empty() {
            topic = Some(auth::new_token());
            self.store
                .set_setting("remote.notify.topic", topic.as_deref().unwrap_or(""))?;
        }
        self.store
            .set_setting("remote.notify.enabled", if enabled { "1" } else { "0" })?;
        self.store.set_setting("remote.notify.server", &server)?;
        self.audit(
            if enabled {
                "notification.enabled"
            } else {
                "notification.disabled"
            },
            None,
            None,
            json!({ "server": server }),
            None,
            None,
        );
        Ok(self.notification_status())
    }

    /// Generic payload only. The topic is a random secret; the body never
    /// contains prompt text, device names, or repository paths.
    pub async fn send_notification(&self, kind: &str) {
        let status = self.notification_status();
        if !status.enabled {
            return;
        }
        let Some(topic) = status.topic else {
            return;
        };
        let body = match kind {
            "pairing" => "A device is waiting for pairing confirmation.",
            "prompt" => "A paired device sent a prompt that needs host confirmation.",
            "approval" => "A paired device needs a decision.",
            _ => "Cockpit needs you at the computer.",
        };
        let url = format!("{}/{}", status.server.trim_end_matches('/'), topic);
        let result = tokio::time::timeout(
            Duration::from_secs(6),
            self.notify_client
                .post(url)
                .header("Title", "Cockpit")
                .header("Tags", "bell")
                .body(body)
                .send(),
        )
        .await;
        if let Ok(Err(error)) = result {
            tracing::warn!(%error, "could not send an ntfy notification");
        }
    }

    // ----- Tools ----------------------------------------------------------

    pub async fn tools(&self, port: u16) -> RemoteTools {
        {
            let cache = self.tools_cache.lock().await;
            if let Some((at, tools)) = cache.as_ref() {
                if at.elapsed() < Duration::from_secs(30) {
                    return tools.clone();
                }
            }
        }
        let tools = detect_tools(port).await;
        let mut cache = self.tools_cache.lock().await;
        *cache = Some((Instant::now(), tools.clone()));
        tools
    }

    pub fn scope_matrix() -> Vec<EndpointScope> {
        vec![
            EndpointScope {
                method: "POST",
                path: "/api/remote/pair/claim",
                scope: "none",
                note: "Pairing code + device name",
            },
            EndpointScope {
                method: "POST",
                path: "/api/remote/pair/claim/{id}",
                scope: "none",
                note: "One-time claim secret",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/session",
                scope: "view",
                note: "This device's scopes",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/overview",
                scope: "view",
                note: "Flights and totals",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/sessions",
                scope: "view",
                note: "Flight list",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/sessions/{id}",
                scope: "view",
                note: "Flight detail",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/sessions/{id}/steps",
                scope: "view",
                note: "Captured steps",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/guards/events",
                scope: "view",
                note: "Pending and past approvals",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/agents",
                scope: "view",
                note: "Running agent sessions",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/agents/{id}",
                scope: "view",
                note: "Sanitized terminal output",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/agent-events",
                scope: "view",
                note: "Inbox events",
            },
            EndpointScope {
                method: "GET",
                path: "/api/remote/live",
                scope: "view",
                note: "WebSocket ticket in Sec-WebSocket-Protocol",
            },
            EndpointScope {
                method: "POST",
                path: "/api/remote/ws-ticket",
                scope: "view",
                note: "30-second single-use ticket",
            },
            EndpointScope {
                method: "POST",
                path: "/api/remote/guards/events/{id}/decision",
                scope: "respond",
                note: "Approve or deny; high risk needs the pairing PIN",
            },
            EndpointScope {
                method: "POST",
                path: "/api/remote/agents/{id}/prompt",
                scope: "prompt",
                note: "Keystrokes only; host confirmation by default",
            },
            EndpointScope {
                method: "POST",
                path: "/api/remote/logout",
                scope: "view",
                note: "Revoke this device",
            },
        ]
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, RemoteInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn lock_prompts(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingPrompt>> {
        self.prompts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn lock_tickets(&self) -> std::sync::MutexGuard<'_, HashMap<String, WsTicket>> {
        self.tickets
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn lock_touched(&self) -> std::sync::MutexGuard<'_, HashMap<String, Instant>> {
        self.touched
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

fn principal_from_row(device: &RemoteDeviceRow) -> RemotePrincipal {
    RemotePrincipal {
        device_id: device.id.clone(),
        device_name: device.name.clone(),
        scopes: ScopeSet::from_strings(&device.scopes),
        require_host_confirmation: device.require_host_confirmation,
        pin_salt: device.pin_salt.clone(),
        pin_hash: device.pin_hash.clone(),
    }
}

fn prompt_expired(prompt: &PendingPrompt) -> bool {
    DateTime::parse_from_rfc3339(&prompt.expires_at)
        .map(|expires| expires.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true)
}

pub fn hash_content(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

async fn detect_tools(port: u16) -> RemoteTools {
    let tailscale_path = find_in_path("tailscale");
    let cloudflared_path = find_in_path("cloudflared");
    let lan_ip = detect_lan_ip();

    let mut tailscale_ip = None;
    let mut tailscale_detail = None;
    if let Some(path) = &tailscale_path {
        let output = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::process::Command::new(path)
                .args(["ip", "-4"])
                .output(),
        )
        .await;
        match output {
            Ok(Ok(output)) if output.status.success() => {
                tailscale_ip = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .map(str::to_string);
            }
            Ok(Ok(output)) => {
                tailscale_detail = Some(format!("`tailscale ip -4` exited with {}", output.status));
            }
            Ok(Err(error)) => tailscale_detail = Some(error.to_string()),
            Err(_) => tailscale_detail = Some("tailscale did not answer within 2 seconds".into()),
        }
    }

    let tailscale_command = match &tailscale_ip {
        Some(ip) => format!("tailscale serve --bg http://{ip}:{port}"),
        None => "tailscale up  # then: tailscale ip -4".to_string(),
    };
    let cloudflared_command = format!("cloudflared tunnel --url http://127.0.0.1:{port}");

    RemoteTools {
        tailscale: ToolStatus {
            installed: tailscale_path.is_some(),
            path: tailscale_path.map(|path| path.display().to_string()),
            detail: tailscale_detail,
            command: tailscale_command,
        },
        cloudflared: ToolStatus {
            installed: cloudflared_path.is_some(),
            path: cloudflared_path.map(|path| path.display().to_string()),
            detail: None,
            command: cloudflared_command,
        },
        lan_ip,
        tailscale_ip,
    }
}

fn find_in_path(binary: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        vec![format!("{binary}.exe"), binary.to_string()]
    } else {
        vec![binary.to_string()]
    };
    for directory in std::env::split_paths(&path) {
        for candidate in &candidates {
            let full = directory.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

fn detect_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?;
    let ip = address.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip.to_string())
    }
}

/// UI files are read from disk, not embedded: `ui/dist` is a build artifact
/// and is intentionally gitignored. The daemon falls back to a small
/// placeholder when the UI has not been built yet.
pub fn default_ui_dir() -> std::path::PathBuf {
    if let Some(value) = std::env::var_os("COCKPIT_UI_DIR") {
        return std::path::PathBuf::from(value);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let candidate = cwd.join("ui").join("dist");
    if candidate.is_dir() {
        return candidate;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(directory) = exe.parent() {
            let beside = directory.join("ui").join("dist");
            if beside.is_dir() {
                return beside;
            }
        }
    }
    candidate
}

pub fn ui_dir_from(config: &crate::config::Config) -> &Path {
    &config.ui_dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_matrix_never_uses_a_wildcard() {
        let matrix = RemoteAccess::scope_matrix();
        assert!(!matrix.is_empty());
        for endpoint in matrix {
            assert!(
                matches!(endpoint.scope, "view" | "respond" | "prompt" | "none"),
                "unexpected scope {}",
                endpoint.scope
            );
        }
    }

    #[test]
    fn modes_parse_and_explain_risk() {
        assert_eq!(RemoteMode::parse("tailscale"), Some(RemoteMode::Tailscale));
        assert_eq!(RemoteMode::parse("off"), Some(RemoteMode::Loopback));
        assert!(RemoteMode::Lan.uses_tls());
        assert!(!RemoteMode::Tailscale.uses_tls());
        assert!(RemoteMode::Tunnel.binds_loopback());
        assert!(RemoteMode::Lan.warning().contains("discouraged"));
    }

    #[test]
    fn content_hashes_are_stable_and_do_not_leak_text() {
        let hash = hash_content("secret prompt");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, hash_content("secret prompt"));
        assert_ne!(hash, hash_content("other prompt"));
    }
}
