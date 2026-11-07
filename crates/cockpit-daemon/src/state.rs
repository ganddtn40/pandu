use std::sync::Arc;
use std::time::Instant;

use reqwest::redirect::Policy;

use crate::config::Config;
use crate::error::Result;
use crate::live::LiveBus;
use crate::recorder::Recorder;
use crate::sessions::SessionManager;
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Arc<Store>,
    pub live: Arc<LiveBus>,
    pub sessions: Arc<SessionManager>,
    pub recorder: Arc<Recorder>,
    pub client: reqwest::Client,
    pub started_at: Instant,
}

impl AppState {
    pub fn new(config: Config) -> Result<Self> {
        let store = Arc::new(Store::open(&config.database_path)?);
        let initial_sequence = store.max_live_sequence().unwrap_or(0);
        let live = LiveBus::new(store.clone(), initial_sequence);
        let sessions = SessionManager::new(store.clone(), live.clone(), config.session_idle_ms);
        let recorder = Recorder::new(store.clone(), live.clone());
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
            client,
            started_at: Instant::now(),
        })
    }
}
