use std::net::SocketAddr;

use axum::Router;
use axum::http::{HeaderValue, Method};
use axum::routing::{get, patch, post};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior, interval_at};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::api;
use crate::config::Config;
use crate::error::{DaemonError, Result};
use crate::logwatch;
use crate::proxy::proxy_handler;
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
        .route("/pair/code", post(api::pair_code))
        .route("/pair/claim", post(api::pair_claim))
        .route("/pair/status", get(api::pair_status))
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
        .with_state(state)
}

fn cors_layer(state: &AppState) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any);

    if state.config.allowed_origins.is_empty() {
        return layer.allow_origin(Any);
    }

    let origins: Vec<HeaderValue> = state
        .config
        .allowed_origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();
    if origins.is_empty() {
        layer.allow_origin(Any)
    } else {
        layer.allow_origin(AllowOrigin::list(origins))
    }
}

/// Bind the listener and create the shared application state.
pub async fn bind(config: Config) -> Result<(TcpListener, AppState)> {
    let state = AppState::new(config)?;
    let listener = TcpListener::bind((state.config.host.as_str(), state.config.port)).await?;
    Ok((listener, state))
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
