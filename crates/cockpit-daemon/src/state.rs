use std::sync::Arc;
use std::time::Instant;

use reqwest::redirect::Policy;

use crate::adapters;
use crate::budget::BudgetService;
use crate::config::Config;
use crate::error::Result;
use crate::guards::GuardService;
use crate::live::LiveBus;
use crate::logwatch::LogWatcher;
use crate::pairing::PairingManager;
use crate::recorder::Recorder;
use crate::sessions::SessionManager;
use crate::snapshots::GitSnapshotService;
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Arc<Store>,
    pub live: Arc<LiveBus>,
    pub sessions: Arc<SessionManager>,
    pub recorder: Arc<Recorder>,
    pub guards: Arc<GuardService>,
    pub budgets: Arc<BudgetService>,
    pub snapshots: Arc<GitSnapshotService>,
    pub adapters: Arc<cockpit_core::adapter::AdapterRegistry>,
    pub logwatch: Arc<LogWatcher>,
    pub pairing: Arc<PairingManager>,
    pub client: reqwest::Client,
    pub started_at: Instant,
}

impl AppState {
    pub fn new(config: Config) -> Result<Self> {
        let store = Arc::new(Store::open(&config.database_path)?);
        let initial_sequence = store.max_live_sequence().unwrap_or(0);
        let live = LiveBus::new(store.clone(), initial_sequence);
        let guards = GuardService::new(
            store.clone(),
            live.clone(),
            config.guard_approval_timeout_ms,
        );
        let budgets = BudgetService::new(
            store.clone(),
            live.clone(),
            guards.broker(),
            config.guard_approval_timeout_ms,
        );
        let snapshots = GitSnapshotService::new(
            store.clone(),
            live.clone(),
            config.workspace_path.clone(),
            config.snapshots_directory.clone(),
            Some(guards.clone()),
        );
        let sessions = SessionManager::new(
            store.clone(),
            live.clone(),
            config.session_idle_ms,
            config.workspace_path.clone(),
            Some(guards.clone()),
            Some(snapshots.clone()),
        );
        let recorder = Recorder::new(
            store.clone(),
            live.clone(),
            Some(guards.clone()),
            Some(snapshots.clone()),
        );
        let adapters = Arc::new(adapters::load_registry_with(
            &config.home,
            config.builtin_adapters,
        ));
        let logwatch = Arc::new(LogWatcher::new(
            store.clone(),
            adapters.clone(),
            live.clone(),
        ));
        let pairing = PairingManager::new();
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|error| crate::error::DaemonError::other(error.to_string()))?;

        Ok(Self {
            config: Arc::new(config),
            store,
            live,
            sessions,
            recorder,
            guards,
            budgets,
            snapshots,
            adapters,
            logwatch,
            pairing,
            client,
            started_at: Instant::now(),
        })
    }
}
