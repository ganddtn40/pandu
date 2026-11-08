use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior, interval_at};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::api;
use crate::config::{Config, is_loopback_host};
use crate::error::{DaemonError, Result};
use crate::logwatch;
use crate::proxy::proxy_handler;
use crate::remote::{RemoteMode, RemoteServerHandle, host};
use crate::state::AppState;
use crate::ui;

/// Build the complete HTTP surface: API, UI, and the catch-all proxy.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(api::health))
        .route("/overview", get(api::overview))
        .route("/stats", get(api::stats))
        .route("/sessions", get(api::list_sessions))
        .route("/sessions/{id}", get(api::get_session))
        .route("/sessions/{id}/steps", get(api::list_steps))
        .route("/sessions/{id}/end", post(api::end_session))
        .route("/sessions/{id}/replay", get(api::session_replay))
        .route("/sessions/{id}/scan", post(api::session_scan))
        .route("/sessions/{id}/budgets", get(api::session_budgets))
        .route("/steps/{id}", get(api::get_step))
        .route("/snapshots/{id}", get(api::snapshot_detail))
        .route(
            "/guards/rules",
            get(api::list_guard_rules).post(api::create_guard_rule),
        )
        .route(
            "/guards/rules/{id}",
            patch(api::update_guard_rule).delete(api::delete_guard_rule),
        )
        .route("/guards/events", get(api::list_guard_events))
        .route("/guards/events/{id}/decision", post(api::guard_decision))
        .route("/budgets", get(api::list_budgets).post(api::create_budget))
        .route(
            "/budgets/{id}",
            patch(api::update_budget).delete(api::delete_budget),
        )
        .route("/settings", get(api::get_settings).put(api::put_settings))
        .route("/adapters", get(api::list_adapters))
        .route("/adapters/{id}", get(api::get_adapter))
        .route("/logwatch", get(api::log_watch_status))
        .route("/logwatch/scan", post(api::scan_log_watch))
        .route("/agents", get(api::list_agents))
        .route("/agents/register", post(api::register_agent))
        .route("/agents/{id}", get(api::get_agent))
        .route("/agents/{id}/output", post(api::agent_output))
        .route(
            "/agents/{id}/input",
            get(api::agent_input_poll).post(api::agent_input),
        )
        .route("/agents/{id}/events", post(api::record_agent_event))
        .route("/agents/{id}/end", post(api::end_agent))
        .route("/agent-events", get(api::list_agent_events))
        .route("/agent-events/{id}/ack", post(api::acknowledge_agent_event))
        // Remote access management is host-only: these routes exist on the
        // loopback listener and never on the remote listener.
        .route("/remote/status", get(host::status))
        .route("/remote/enable", post(host::enable))
        .route("/remote/disable", post(host::disable))
        .route("/remote/panic", post(host::panic))
        .route("/remote/pair/code", post(host::pair_code))
        .route("/remote/pair/pending", get(host::pending_pairings))
        .route(
            "/remote/pair/pending/{id}/confirm",
            post(host::confirm_pairing),
        )
        .route("/remote/pair/pending/{id}/deny", post(host::deny_pairing))
        .route("/remote/devices", get(host::devices))
        .route("/remote/devices/{id}", patch(host::update_device))
        .route("/remote/devices/{id}/revoke", post(host::revoke_device))
        .route("/remote/devices/{id}/rotate", post(host::rotate_device))
        .route("/remote/audit", get(host::audit))
        .route("/remote/audit/export", get(host::audit_export))
        .route("/remote/prompts", get(host::pending_prompts))
        .route(
            "/remote/prompts/{id}/approve",
            post(host::approve_prompt),
        )
        .route("/remote/prompts/{id}/deny", post(host::deny_prompt))
        .route("/remote/tools", get(host::tools))
        .route("/remote/matrix", get(host::matrix))
        .route(
            "/remote/notifications",
            get(host::notifications).put(host::update_notifications),
        )
        .route(
            "/remote/notifications/test",
            post(host::test_notification),
        )
        .route("/demo/seed", post(api::seed_demo))
        .route("/live", get(api::live))
        .fallback(api::not_found)
        .with_state(state.clone());

    Router::new()
        .route("/", get(ui::index))
        .route("/index.html", get(ui::index))
        .nest("/api", api)
        .fallback(proxy_handler)
        .layer(cors_layer(&state))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(require_loopback_host))
        .with_state(state)
}

/// Only loopback origins may talk to the daemon from a browser. The embedded
/// UI is same-origin; the Vite dev and preview servers are explicitly allowed.
fn cors_layer(state: &AppState) -> CorsLayer {
    let mut origins: Vec<HeaderValue> = Vec::new();
    let mut add = |origin: &str| {
        if let Ok(value) = HeaderValue::from_str(origin) {
            if !origins.contains(&value) {
                origins.push(value);
            }
        }
    };

    for port in [state.config.port, 5174, 4174] {
        if port == 0 {
            continue;
        }
        add(&format!("http://127.0.0.1:{port}"));
        add(&format!("http://localhost:{port}"));
    }
    for origin in &state.config.allowed_origins {
        add(origin);
    }

    CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        .allow_origin(AllowOrigin::list(origins))
}

/// Reject DNS-rebinding attempts: a browser must not be able to reach this
/// daemon through a hostname that merely resolves to 127.0.0.1.
async fn require_loopback_host(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    match host {
        Some(value) if host_header_is_loopback(value) => next.run(request).await,
        None => next.run(request).await,
        Some(_) => (
            StatusCode::FORBIDDEN,
            axum::Json(json!({
                "error": {
                    "code": "forbidden_host",
                    "message": "Cockpit only accepts loopback host names in this build."
                }
            })),
        )
            .into_response(),
    }
}

fn host_header_is_loopback(value: &str) -> bool {
    let host = if let Some(rest) = value.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else if let Some((host, port)) = value.rsplit_once(':') {
        if !port.is_empty() && port.chars().all(|character| character.is_ascii_digit()) {
            host
        } else {
            value
        }
    } else {
        value
    };
    is_loopback_host(host)
}

/// Bind the listener and create the shared application state.
pub async fn bind(config: Config) -> Result<(TcpListener, AppState)> {
    if !is_loopback_host(&config.host) {
        return Err(DaemonError::config(format!(
            "Cockpit only listens on loopback addresses in this build (got `{}`).",
            config.host
        )));
    }
    let state = AppState::new(config)?;
    let listener = TcpListener::bind((state.config.host.as_str(), state.config.port)).await?;
    Ok((listener, state))
}

/// Start the optional remote listener.
///
/// Safety rules enforced here:
/// * `Loopback` (off) never starts a listener.
/// * A daemon started with `COCKPIT_REMOTE_PORT=0` refuses to start one.
/// * Tailscale binds only the detected tailnet IP, never `0.0.0.0`.
/// * LAN binds only the detected LAN IP and always uses TLS.
/// * Tunnel stays on loopback and needs an explicit public URL so the pairing
///   QR points at the right address.
pub async fn start_remote(
    state: &AppState,
    mode: RemoteMode,
    public_url: Option<String>,
) -> Result<()> {
    if mode == RemoteMode::Loopback {
        return Err(DaemonError::config(
            "Remote access is off. Choose Tailscale, tunnel, or LAN to turn it on.",
        ));
    }
    if state.config.remote_port == 0 {
        return Err(DaemonError::config(
            "COCKPIT_REMOTE_PORT=0 disables the remote listener for this daemon.",
        ));
    }
    if state.remote.is_enabled() {
        stop_remote(state, false).await;
    }

    let port = state.config.remote_port;
    let router = crate::remote::api::build_remote_router(state.clone());
    match mode {
        RemoteMode::Tailscale => {
            let tools = state.remote.tools(state.config.remote_port).await;
            let Some(ip) = tools.tailscale_ip else {
                return Err(DaemonError::config(
                    "Tailscale is installed but not connected. Run `tailscale up`, then try again.",
                ));
            };
            let addr = parse_bind(&ip, port)?;
            let listener = TcpListener::bind(addr).await.map_err(|error| {
                DaemonError::config(format!(
                    "Could not bind the tailnet address {addr}: {error}"
                ))
            })?;
            let bound = listener.local_addr()?;
            let url = format!("http://{bound}");
            let mut allowed_hosts = vec![ip.clone()];
            if let Some(dns) = tools.tailscale_dns_name.clone() {
                allowed_hosts.push(dns);
            }
            let (shutdown, receiver) = oneshot::channel();
            let task = tokio::spawn(async move {
                let service = router.into_make_service_with_connect_info::<SocketAddr>();
                let result = axum::serve(listener, service)
                    .with_graceful_shutdown(async move {
                        let _ = receiver.await;
                    })
                    .await;
                if let Err(error) = result {
                    tracing::warn!(%error, "the remote listener stopped with an error");
                }
            });
            state
                .remote
                .set_started(mode, url, ip, port, None, allowed_hosts);
            state
                .remote
                .set_server(RemoteServerHandle::Plain { shutdown, task });
        }
        RemoteMode::Tunnel => {
            let url = public_url
                .or_else(|| state.config.remote_public_url.clone())
                .ok_or_else(|| {
                    DaemonError::config(
                        "Tunnel mode needs the public URL from your tunnel \
                         (set COCKPIT_REMOTE_PUBLIC_URL or pass publicUrl).",
                    )
                })?;
            let url = normalize_public_url(&url)?;
            let public_host = url_host(&url).unwrap_or_default();
            let listener = TcpListener::bind(("127.0.0.1", port))
                .await
                .map_err(|error| {
                    DaemonError::config(format!(
                        "Could not bind the tunnel listener on 127.0.0.1:{port}: {error}"
                    ))
                })?;
            let (shutdown, receiver) = oneshot::channel();
            let task = tokio::spawn(async move {
                let service = router.into_make_service_with_connect_info::<SocketAddr>();
                let result = axum::serve(listener, service)
                    .with_graceful_shutdown(async move {
                        let _ = receiver.await;
                    })
                    .await;
                if let Err(error) = result {
                    tracing::warn!(%error, "the remote listener stopped with an error");
                }
            });
            state.remote.set_started(
                mode,
                url,
                "127.0.0.1".to_string(),
                port,
                None,
                vec![public_host],
            );
            state
                .remote
                .set_server(RemoteServerHandle::Plain { shutdown, task });
        }
        RemoteMode::Lan => {
            let tools = state.remote.tools(state.config.remote_port).await;
            let Some(ip) = tools.lan_ip else {
                return Err(DaemonError::config(
                    "Could not detect a local network address. Connect to Wi-Fi or use Tailscale instead.",
                ));
            };
            let (cert_path, key_path, fingerprint) =
                ensure_lan_certificate(&state.config.home, &ip)?;
            let addr = parse_bind(&ip, port)?;
            let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert_path, key_path)
                .await
                .map_err(|error| {
                    DaemonError::config(format!("Could not load the LAN TLS certificate: {error}"))
                })?;
            let handle = axum_server::Handle::new();
            let server_handle = handle.clone();
            let task = tokio::spawn(async move {
                let result = axum_server::bind_rustls(addr, config)
                    .handle(server_handle)
                    .serve(router.into_make_service())
                    .await;
                if let Err(error) = result {
                    tracing::warn!(%error, "the remote TLS listener stopped with an error");
                }
            });
            let url = format!("https://{addr}");
            state.remote.set_started(
                mode,
                url,
                ip.clone(),
                port,
                Some(fingerprint),
                vec![ip, "cockpit.local".to_string()],
            );
            state
                .remote
                .set_server(RemoteServerHandle::Tls { handle, task });
        }
        RemoteMode::Loopback => unreachable!("handled above"),
    }
    Ok(())
}

/// Stop the remote listener and close every open remote connection.
pub async fn stop_remote(state: &AppState, immediate: bool) {
    if let Some(server) = state.remote.take_server() {
        server.stop(immediate).await;
    }
    state.remote.bump_epoch();
    state.remote.set_stopped();
    state.remote.clear_prompts();
}

fn parse_bind(ip: &str, port: u16) -> Result<SocketAddr> {
    format!("{ip}:{port}")
        .parse::<SocketAddr>()
        .map_err(|_| DaemonError::config(format!("`{ip}` is not a usable IP address.")))
}

fn normalize_public_url(value: &str) -> Result<String> {
    let value = value.trim().trim_end_matches('/');
    let Some((scheme, rest)) = value.split_once("://") else {
        return Err(DaemonError::config(
            "The public URL must be the https:// hostname your tunnel forwards to Cockpit.",
        ));
    };
    let host = rest.split('/').next().unwrap_or(rest);
    let host_only = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    if host_only.is_empty() || host_only.contains('*') || host_only.contains('@') {
        return Err(DaemonError::config(
            "The public URL must name one exact hostname, never a wildcard.",
        ));
    }
    if scheme.eq_ignore_ascii_case("https") {
        if host_only.parse::<std::net::IpAddr>().is_ok() || host_only == "localhost" {
            return Err(DaemonError::config(
                "The tunnel URL must use the public hostname, not an IP address or localhost.",
            ));
        }
        if !host_only.contains('.') {
            return Err(DaemonError::config(
                "The tunnel URL must use a public hostname such as cockpit.example.com.",
            ));
        }
        return Ok(value.to_string());
    }
    // Debug builds keep the loopback tunnel test path usable. Release builds
    // always demand the real HTTPS hostname a phone can reach.
    #[cfg(debug_assertions)]
    if scheme.eq_ignore_ascii_case("http") && is_loopback_host(&host_only) {
        return Ok(value.to_string());
    }
    Err(DaemonError::config(
        "Public tunnel URLs must use https:// with the hostname your tunnel serves.",
    ))
}

fn url_host(value: &str) -> Option<String> {
    let (_, rest) = value.split_once("://")?;
    let host = rest.split('/').next()?.split(':').next()?;
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() { None } else { Some(host) }
}

/// LAN mode always uses TLS. The self-signed certificate is generated once and
/// pinned by the pairing QR; its SHA-256 fingerprint is stored next to it.
fn ensure_lan_certificate(home: &Path, ip: &str) -> Result<(PathBuf, PathBuf, String)> {
    let directory = home.join("remote-tls");
    std::fs::create_dir_all(&directory)?;
    let cert_path = directory.join("cert.pem");
    let key_path = directory.join("key.pem");
    let fingerprint_path = directory.join("fingerprint.txt");
    if cert_path.is_file() && key_path.is_file() && fingerprint_path.is_file() {
        let fingerprint = std::fs::read_to_string(&fingerprint_path)?
            .trim()
            .to_string();
        if !fingerprint.is_empty() {
            return Ok((cert_path, key_path, fingerprint));
        }
    }

    let names = vec!["cockpit.local".to_string(), ip.to_string()];
    let generated = rcgen::generate_simple_self_signed(names).map_err(|error| {
        DaemonError::other(format!("Could not generate a TLS certificate: {error}"))
    })?;
    let cert_pem = generated.cert.pem();
    let key_pem = generated.key_pair.serialize_pem();
    let fingerprint = fingerprint_of(generated.cert.der());
    std::fs::write(&cert_path, cert_pem)?;
    std::fs::write(&key_path, key_pem)?;
    std::fs::write(&fingerprint_path, format!("{fingerprint}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }
    Ok((cert_path, key_path, fingerprint))
}

fn fingerprint_of(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// A running daemon owned by a test or by `cockpit serve`.
pub struct ServerHandle {
    pub addr: SocketAddr,
    pub state: AppState,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<()>>,
}

impl ServerHandle {
    /// Ask the server to stop and wait for in-flight requests to finish.
    pub async fn shutdown(mut self) -> Result<()> {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
        match self.task.await {
            Ok(result) => result,
            Err(error) => Err(DaemonError::other(format!(
                "the server task could not be joined: {error}"
            ))),
        }
    }

    /// Wait until the server stops on its own (for example on Ctrl-C).
    pub async fn wait(self) -> Result<()> {
        match self.task.await {
            Ok(result) => result,
            Err(error) => Err(DaemonError::other(format!(
                "the server task could not be joined: {error}"
            ))),
        }
    }
}

/// Start the daemon in the background and return its address.
pub async fn spawn(config: Config) -> Result<ServerHandle> {
    let demo_mode = config.demo_mode;
    let (listener, state) = bind(config).await?;
    let addr = listener.local_addr()?;

    if demo_mode {
        match state.store.count_sessions() {
            Ok(0) => {
                if let Err(error) = api::seed_demo_sessions(&state) {
                    tracing::warn!(?error, "could not seed the demo flights");
                }
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "could not check for demo flights"),
        }
        // The agent control plane has its own seed marker, so this stays
        // idempotent even when the demo flights already exist.
        if let Err(error) = state.agents.seed_demo() {
            tracing::warn!(?error, "could not seed the demo agent session");
        }
    }

    let (shutdown, receiver) = oneshot::channel();
    let task_state = state.clone();
    let task = tokio::spawn(async move { serve_on(listener, task_state, receiver).await });

    Ok(ServerHandle {
        addr,
        state,
        shutdown: Some(shutdown),
        task,
    })
}

/// Start the daemon and run until Ctrl-C or SIGTERM.
pub async fn run(config: Config) -> Result<()> {
    let handle = spawn(config).await?;
    tracing::info!(address = %handle.addr, "Cockpit is listening");
    println!(
        "Cockpit {} listening on http://{}",
        cockpit_core::VERSION,
        handle.addr
    );
    println!("Proxy base: http://{}/v1", handle.addr);
    println!(
        "Open http://{}/ in a browser to see the workspace.",
        handle.addr
    );
    handle.wait().await
}

async fn serve_on(
    listener: TcpListener,
    state: AppState,
    shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    let router = build_router(state.clone());
    let sweeper = tokio::spawn(sweep_sessions(state.clone()));
    let watcher = state.config.log_watch.then(|| {
        tokio::spawn(logwatch::watch_loop(
            state.logwatch.clone(),
            Duration::from_millis(state.config.log_watch_interval_ms.max(250)),
        ))
    });

    let graceful = async move {
        tokio::select! {
            _ = shutdown => {}
            _ = shutdown_signal() => {}
        }
    };

    let result = axum::serve(listener, router)
        .with_graceful_shutdown(graceful)
        .await;

    stop_remote(&state, true).await;
    sweeper.abort();
    if let Some(watcher) = watcher {
        watcher.abort();
    }
    state.sessions.shutdown();

    result.map_err(DaemonError::from)
}

async fn sweep_sessions(state: AppState) {
    let mut ticker = interval_at(
        Instant::now() + Duration::from_secs(60),
        Duration::from_secs(60),
    );
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let ended = state.sessions.sweep();
        if !ended.is_empty() {
            tracing::info!(count = ended.len(), "closed idle ambient flights");
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_urls_must_name_one_https_hostname() {
        assert_eq!(
            normalize_public_url("https://cockpit.example.com/").unwrap(),
            "https://cockpit.example.com"
        );
        assert!(normalize_public_url("https://192.0.2.10").is_err());
        assert!(normalize_public_url("https://localhost").is_err());
        assert!(normalize_public_url("https://*.example.com").is_err());
        assert!(normalize_public_url("https://user@example.com").is_err());
        assert!(normalize_public_url("http://cockpit.example.com").is_err());
        assert!(normalize_public_url("cockpit.example.com").is_err());
        #[cfg(debug_assertions)]
        assert!(normalize_public_url("http://127.0.0.1:4320").is_ok());
    }
}
