use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use pandu_core::brand;
use pandu_core::update::{
    PRODUCTION_UPDATER_PUBLIC_KEY_BASE64, UpdateError, VersionRelation, compare_versions,
    notes_summary, resolve_update_trust_root, sanitize_release_notes, update_signing,
};
use serde_json::json;

use super::{
    GitHubRelease, LatestRelease, STATE_AVAILABLE, STATE_ERROR, STATE_IDLE, STATE_OFFLINE,
    STATE_RATE_LIMITED, STATE_SKIPPED, STATE_SNOOZED, STATE_UNAVAILABLE, STATE_UP_TO_DATE,
    UpdateStatus,
};
use crate::live::LiveBus;
use crate::store::Store;

pub const DEFAULT_INTERVAL_HOURS: u64 = 24;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_API_BYTES: usize = 2 * 1024 * 1024;
const SETTING_ENABLED: &str = "update.enabled";
const SETTING_LAST_CHECK: &str = "update.lastCheck";
const SETTING_ETAG: &str = "update.etag";
const SETTING_SNOOZE_UNTIL: &str = "update.snoozeUntil";
const SETTING_SKIP_VERSION: &str = "update.skipVersion";
const SETTING_NOTIFIED_VERSION: &str = "update.notifiedVersion";

#[derive(Debug, Default)]
struct Runtime {
    state: String,
    latest: Option<LatestRelease>,
    message: Option<String>,
    checking: bool,
}

enum FetchOutcome {
    NotModified,
    Release(GitHubRelease, Option<String>),
    RateLimited(Option<String>),
    NotFound,
    Offline,
    Error(String),
}

/// The host-only update checker.
pub struct UpdateService {
    store: Arc<Store>,
    live: Arc<LiveBus>,
    client: reqwest::Client,
    api_url: String,
    fixture: Option<PathBuf>,
    runtime: Mutex<Runtime>,
}

impl UpdateService {
    pub fn new(store: Arc<Store>, live: Arc<LiveBus>, client: reqwest::Client) -> Self {
        let api_url =
            debug_override("UPDATE_API_URL").unwrap_or_else(|| brand::UPDATE_API_URL.to_string());
        let fixture = debug_override("UPDATE_FIXTURE").map(PathBuf::from);
        Self {
            store,
            live,
            client,
            api_url,
            fixture,
            runtime: Mutex::new(Runtime {
                state: STATE_IDLE.to_string(),
                ..Runtime::default()
            }),
        }
    }

    /// Test-only constructor that points at a local fixture server.
    #[cfg(test)]
    pub fn for_test(
        store: Arc<Store>,
        live: Arc<LiveBus>,
        client: reqwest::Client,
        api_url: String,
    ) -> Self {
        Self {
            store,
            live,
            client,
            api_url,
            fixture: None,
            runtime: Mutex::new(Runtime {
                state: STATE_IDLE.to_string(),
                ..Runtime::default()
            }),
        }
    }

    fn setting(&self, key: &str) -> Option<String> {
        self.store.get_setting(key).ok().flatten()
    }

    pub fn enabled(&self) -> bool {
        self.setting(SETTING_ENABLED).as_deref() != Some("0")
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<UpdateStatus, UpdateError> {
        self.store
            .set_setting(SETTING_ENABLED, if enabled { "1" } else { "0" })
            .map_err(|error| UpdateError::Io(error.to_string()))?;
        Ok(self.status())
    }

    /// Whether an automatic check is due. A never-checked install is due.
    pub fn is_due(&self) -> bool {
        if !self.enabled() {
            return false;
        }
        let Some(last) = self.setting(SETTING_LAST_CHECK) else {
            return true;
        };
        let Ok(last) = DateTime::parse_from_rfc3339(&last) else {
            return true;
        };
        let interval = ChronoDuration::hours(brand::update_interval_hours() as i64);
        last.with_timezone(&Utc) + interval <= Utc::now()
    }

    pub fn status(&self) -> UpdateStatus {
        let enabled = self.enabled();
        let trust =
            resolve_update_trust_root(cfg!(debug_assertions), PRODUCTION_UPDATER_PUBLIC_KEY_BASE64);
        let signing = update_signing(cfg!(debug_assertions), PRODUCTION_UPDATER_PUBLIC_KEY_BASE64);
        let runtime = self.runtime.lock().expect("update state");
        let last_checked_at = self.setting(SETTING_LAST_CHECK);
        let snoozed_until = self.setting(SETTING_SNOOZE_UNTIL);
        let skipped_version = self.setting(SETTING_SKIP_VERSION);
        let latest = runtime.latest.clone();

        let mut state = if runtime.state.is_empty() {
            STATE_IDLE.to_string()
        } else {
            runtime.state.clone()
        };
        let mut message = runtime.message.clone();

        if let Some(latest) = &latest {
            if skipped_version.as_deref() == Some(latest.version.as_str()) {
                state = STATE_SKIPPED.to_string();
                message = Some(format!(
                    "You skipped version {}. Pandu will tell you about the next one.",
                    latest.version
                ));
            } else if snoozed_until
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|until| until.with_timezone(&Utc) > Utc::now())
            {
                state = STATE_SNOOZED.to_string();
                message = Some("Reminder snoozed. You can still update now.".to_string());
            } else {
                state = STATE_AVAILABLE.to_string();
            }
        }

        if trust != pandu_core::update::UpdateTrustRoot::Ready {
            message = Some(if trust == pandu_core::update::UpdateTrustRoot::Preparing {
                pandu_core::update::UPDATE_PREPARING_MESSAGE.to_string()
            } else {
                "This build embedded the test updater key. Release builds refuse updates."
                    .to_string()
            });
        }

        let next_check_at = if enabled {
            last_checked_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|last| {
                    (last.with_timezone(&Utc)
                        + ChronoDuration::hours(brand::update_interval_hours() as i64))
                    .to_rfc3339_opts(SecondsFormat::Secs, true)
                })
        } else {
            None
        };

        UpdateStatus {
            enabled,
            channel: brand::UPDATE_CHANNEL.to_string(),
            current_version: pandu_core::VERSION.to_string(),
            state,
            latest_version: latest.as_ref().map(|release| release.version.clone()),
            release_name: latest.as_ref().map(|release| release.name.clone()),
            notes: latest.as_ref().map(|release| release.notes.clone()),
            notes_summary: latest.as_ref().map(|release| release.notes_summary.clone()),
            release_url: latest
                .as_ref()
                .map(|release| release.release_url.clone())
                .or_else(|| Some(brand::UPDATE_RELEASES_URL.to_string())),
            published_at: latest
                .as_ref()
                .and_then(|release| release.published_at.clone()),
            last_checked_at,
            next_check_at,
            snoozed_until,
            skipped_version,
            trust: trust.as_str().to_string(),
            signing: signing.as_str().to_string(),
            signing_label: signing.label().to_string(),
            message,
            can_install: trust == pandu_core::update::UpdateTrustRoot::Ready && latest.is_some(),
            install_command: format!("{} update", brand::CLI_COMMAND),
            checking: runtime.checking,
        }
    }

    /// Check once. A manual check runs even when automatic checks are off.
    pub async fn check(&self, manual: bool) -> UpdateStatus {
        if !manual && !self.enabled() {
            return self.status();
        }
        {
            let mut runtime = self.runtime.lock().expect("update state");
            runtime.checking = true;
        }

        let etag = self.setting(SETTING_ETAG);
        let outcome = self.fetch(etag.as_deref()).await;
        let checked_at = now_iso();
        let _ = self.store.set_setting(SETTING_LAST_CHECK, &checked_at);

        {
            let mut runtime = self.runtime.lock().expect("update state");
            runtime.checking = false;
            match outcome {
                FetchOutcome::NotModified => {
                    if runtime.latest.is_none() {
                        runtime.state = STATE_UP_TO_DATE.to_string();
                    }
                    runtime.message = None;
                }
                FetchOutcome::Release(release, etag) => {
                    if let Some(etag) = etag {
                        let _ = self.store.set_setting(SETTING_ETAG, &etag);
                    }
                    apply_release(&mut runtime, release);
                }
                FetchOutcome::RateLimited(reset) => {
                    runtime.state = STATE_RATE_LIMITED.to_string();
                    runtime.message = Some(match reset {
                        Some(reset) => format!(
                            "GitHub is limiting update checks. Pandu will try again after {reset}."
                        ),
                        None => "GitHub is limiting update checks. Pandu will try again later."
                            .to_string(),
                    });
                }
                FetchOutcome::NotFound => {
                    runtime.state = STATE_UNAVAILABLE.to_string();
                    runtime.message = Some(
                        "Update checks are not available yet. The release repository may be private or not published."
                            .to_string(),
                    );
                }
                FetchOutcome::Offline => {
                    runtime.state = STATE_OFFLINE.to_string();
                    runtime.message =
                        Some("You are offline. Pandu will try again later.".to_string());
                }
                FetchOutcome::Error(message) => {
                    runtime.state = STATE_ERROR.to_string();
                    runtime.message = Some(message);
                }
            }
        }

        let status = self.status();
        self.publish_if_available(&status);
        status
    }

    async fn fetch(&self, etag: Option<&str>) -> FetchOutcome {
        if let Some(fixture) = &self.fixture {
            return match std::fs::read(fixture) {
                Ok(bytes) => match serde_json::from_slice::<GitHubRelease>(&bytes) {
                    Ok(release) => FetchOutcome::Release(release, None),
                    Err(error) => FetchOutcome::Error(format!(
                        "The update fixture is not valid JSON: {error}"
                    )),
                },
                Err(error) => {
                    FetchOutcome::Error(format!("The update fixture could not be read: {error}"))
                }
            };
        }

        let url = format!("{}/latest", self.api_url.trim_end_matches('/'));
        let mut request = self
            .client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .header(
                reqwest::header::USER_AGENT,
                format!("{}-{}", brand::SLUG, pandu_core::VERSION),
            )
            .timeout(REQUEST_TIMEOUT);
        if let Some(etag) = etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) if error.is_connect() || error.is_timeout() => {
                return FetchOutcome::Offline;
            }
            Err(error) => {
                tracing::debug!(%error, "update check request failed");
                return FetchOutcome::Error(
                    "The update check failed. Pandu will try again later.".to_string(),
                );
            }
        };

        let status = response.status();
        if status == reqwest::StatusCode::NOT_MODIFIED {
            return FetchOutcome::NotModified;
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return FetchOutcome::NotFound;
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::FORBIDDEN
            || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
        {
            let remaining = response
                .headers()
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS || remaining == Some("0") {
                return FetchOutcome::RateLimited(rate_limit_reset(&response));
            }
            if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                return FetchOutcome::Error(
                    "The update service is temporarily unavailable. Pandu will try again later."
                        .to_string(),
                );
            }
        }
        if !status.is_success() {
            return FetchOutcome::Error(
                "The update check failed. Pandu will try again later.".to_string(),
            );
        }

        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) if error.is_connect() || error.is_timeout() => {
                return FetchOutcome::Offline;
            }
            Err(error) => {
                tracing::debug!(%error, "update check body failed");
                return FetchOutcome::Error(
                    "The update check failed. Pandu will try again later.".to_string(),
                );
            }
        };
        if bytes.len() > MAX_API_BYTES {
            return FetchOutcome::Error("The update response was unexpectedly large.".to_string());
        }
        match serde_json::from_slice::<GitHubRelease>(&bytes) {
            Ok(release) => FetchOutcome::Release(release, etag),
            Err(_) => FetchOutcome::Error(
                "The update service returned a response this build does not understand."
                    .to_string(),
            ),
        }
    }

    pub fn snooze(&self, choice: &str) -> Result<UpdateStatus, UpdateError> {
        let latest = self.runtime.lock().expect("update state").latest.clone();
        let now = Utc::now();
        match choice {
            "tomorrow" => {
                self.store
                    .set_setting(
                        SETTING_SNOOZE_UNTIL,
                        &(now + ChronoDuration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
                    )
                    .map_err(|error| UpdateError::Io(error.to_string()))?;
            }
            "week" => {
                self.store
                    .set_setting(
                        SETTING_SNOOZE_UNTIL,
                        &(now + ChronoDuration::days(7)).to_rfc3339_opts(SecondsFormat::Secs, true),
                    )
                    .map_err(|error| UpdateError::Io(error.to_string()))?;
            }
            "version" => {
                let latest = latest.ok_or_else(|| {
                    UpdateError::Manifest(
                        "There is no update to skip. Check again first.".to_string(),
                    )
                })?;
                self.store
                    .set_setting(SETTING_SKIP_VERSION, &latest.version)
                    .map_err(|error| UpdateError::Io(error.to_string()))?;
                self.store
                    .delete_setting(SETTING_SNOOZE_UNTIL)
                    .map_err(|error| UpdateError::Io(error.to_string()))?;
            }
            _ => {
                return Err(UpdateError::Manifest(
                    "Choose `tomorrow`, `week`, or `version`.".to_string(),
                ));
            }
        }
        Ok(self.status())
    }

    fn publish_if_available(&self, status: &UpdateStatus) {
        let Some(version) = status.latest_version.as_deref() else {
            return;
        };
        if status.state == STATE_SKIPPED {
            return;
        }
        if self.setting(SETTING_NOTIFIED_VERSION).as_deref() == Some(version) {
            return;
        }
        let _ = self.store.set_setting(SETTING_NOTIFIED_VERSION, version);
        self.live.publish(
            "update.available",
            None,
            None,
            json!({
                "version": version,
                "currentVersion": status.current_version,
                "notesSummary": status.notes_summary,
                "releaseUrl": status.release_url,
            }),
        );
    }
}

fn apply_release(runtime: &mut Runtime, release: GitHubRelease) {
    if release.draft || release.prerelease {
        runtime.latest = None;
        runtime.state = STATE_UP_TO_DATE.to_string();
        runtime.message = Some(
            "The newest release is not on the stable channel yet. Pandu will check again later."
                .to_string(),
        );
        return;
    }
    match compare_versions(pandu_core::VERSION, &release.tag_name) {
        Ok(VersionRelation::Newer) => {
            let notes = sanitize_release_notes(release.body.as_deref().unwrap_or_default());
            let name = sanitize_release_notes(release.name.as_deref().unwrap_or(""));
            let release_url = release
                .html_url
                .filter(|url| url.starts_with("https://"))
                .unwrap_or_else(|| brand::UPDATE_RELEASES_URL.to_string());
            runtime.latest = Some(LatestRelease {
                version: release.tag_name.trim().trim_start_matches('v').to_string(),
                name: if name.trim().is_empty() {
                    format!("{} {}", brand::PRODUCT_NAME, release.tag_name.trim())
                } else {
                    name
                },
                notes_summary: notes_summary(&notes, 180),
                notes,
                release_url,
                published_at: release.published_at,
            });
            runtime.state = STATE_AVAILABLE.to_string();
            runtime.message = None;
        }
        Ok(VersionRelation::Same) | Ok(VersionRelation::Older) => {
            runtime.latest = None;
            runtime.state = STATE_UP_TO_DATE.to_string();
            runtime.message = None;
        }
        Err(error) => {
            runtime.latest = None;
            runtime.state = STATE_ERROR.to_string();
            runtime.message = Some(error.to_string());
        }
    }
}

fn rate_limit_reset(response: &reqwest::Response) -> Option<String> {
    let seconds = response
        .headers()
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())?;
    let at = DateTime::<Utc>::from_timestamp(seconds, 0)?;
    Some(at.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn debug_override(suffix: &str) -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var(brand::env_name(suffix))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Check once at launch, then every fifteen minutes, and only perform a
/// network request when the configured interval has elapsed.
pub async fn scheduler(service: Arc<UpdateService>) {
    // A fixture is a local file. Check it immediately so the UI and the
    // screenshot tests never wait on the launch delay meant for the network.
    let launch_delay = if service.fixture.is_some() {
        Duration::ZERO
    } else {
        Duration::from_secs(5)
    };
    tokio::time::sleep(launch_delay).await;
    loop {
        if service.is_due() {
            let _ = service.check(false).await;
        }
        tokio::time::sleep(Duration::from_secs(15 * 60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::get;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct MockState {
        requests: Arc<AtomicUsize>,
        seen_etags: Arc<Mutex<Vec<Option<String>>>>,
        response: Arc<Mutex<MockResponse>>,
    }

    #[derive(Clone)]
    enum MockResponse {
        Release { body: String, etag: &'static str },
        NotModified,
        RateLimited,
        NotFound,
        Garbage,
    }

    async fn latest(
        State(state): State<MockState>,
        headers: HeaderMap,
    ) -> axum::response::Response {
        state.requests.fetch_add(1, Ordering::SeqCst);
        state.seen_etags.lock().unwrap().push(
            headers
                .get(reqwest::header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        );
        let response = state.response.lock().unwrap().clone();
        match response {
            MockResponse::Release { body, etag } => axum::response::Response::builder()
                .status(StatusCode::OK)
                .header(reqwest::header::ETAG, etag)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap(),
            MockResponse::NotModified => axum::response::Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .body(Body::empty())
                .unwrap(),
            MockResponse::RateLimited => axum::response::Response::builder()
                .status(StatusCode::FORBIDDEN)
                .header("x-ratelimit-remaining", "0")
                .header("x-ratelimit-reset", "1767225600")
                .body(Body::empty())
                .unwrap(),
            MockResponse::NotFound => axum::response::Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap(),
            MockResponse::Garbage => axum::response::Response::builder()
                .status(StatusCode::OK)
                .body(Body::from("this is not JSON"))
                .unwrap(),
        }
    }

    async fn mock_server(
        response: MockResponse,
    ) -> (String, MockState, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = MockState {
            requests: Arc::new(AtomicUsize::new(0)),
            seen_etags: Arc::new(Mutex::new(Vec::new())),
            response: Arc::new(Mutex::new(response)),
        };
        let app = Router::new()
            .route("/latest", get(latest))
            .with_state(state.clone());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}"), state, handle)
    }

    fn release(version: &str, body: &str) -> String {
        json!({
            "tag_name": version,
            "name": format!("Pandu {version}"),
            "body": body,
            "html_url": format!("https://example.com/releases/{version}"),
            "published_at": "2026-01-01T00:00:00Z",
            "draft": false,
            "prerelease": false,
            "assets": [],
        })
        .to_string()
    }

    fn service(api_url: String) -> (Arc<UpdateService>, Arc<Store>, Arc<LiveBus>) {
        let store = Arc::new(Store::open(":memory:").unwrap());
        let live = LiveBus::new(store.clone(), 0);
        let client = reqwest::Client::builder().build().unwrap();
        (
            Arc::new(UpdateService::for_test(
                store.clone(),
                live.clone(),
                client,
                api_url,
            )),
            store,
            live,
        )
    }

    #[tokio::test]
    async fn a_newer_release_is_available_and_uses_the_etag_next_time() {
        let (url, state, _server) = mock_server(MockResponse::Release {
            body: release(
                "v9.9.9",
                "## Highlights\n\n- Faster flights\n- Safer updates",
            ),
            etag: "\"release-1\"",
        })
        .await;
        let (service, store, _live) = service(url);

        let status = service.check(false).await;
        assert_eq!(status.state, STATE_AVAILABLE);
        assert_eq!(status.latest_version.as_deref(), Some("9.9.9"));
        assert_eq!(status.notes_summary.as_deref(), Some("## Highlights"));
        assert_eq!(
            store.get_setting(SETTING_ETAG).unwrap().as_deref(),
            Some("\"release-1\"")
        );
        assert!(store.get_setting(SETTING_LAST_CHECK).unwrap().is_some());

        *state.response.lock().unwrap() = MockResponse::NotModified;
        let status = service.check(false).await;
        assert_eq!(status.state, STATE_AVAILABLE);
        assert_eq!(status.latest_version.as_deref(), Some("9.9.9"));

        let etags = state.seen_etags.lock().unwrap().clone();
        assert_eq!(etags.len(), 2);
        assert_eq!(etags[0], None);
        assert_eq!(etags[1].as_deref(), Some("\"release-1\""));
    }

    #[tokio::test]
    async fn a_304_without_a_cached_release_is_up_to_date() {
        let (url, _state, _server) = mock_server(MockResponse::NotModified).await;
        let (service, _store, _live) = service(url);

        let status = service.check(false).await;
        assert_eq!(status.state, STATE_UP_TO_DATE);
        assert_eq!(status.latest_version, None);
        assert_eq!(status.message, None);
    }

    #[tokio::test]
    async fn offline_checks_stay_silent_and_clear() {
        // Bind and immediately release a port so nothing is listening there.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let (service, _store, _live) = service(format!("http://{address}"));

        let status = service.check(false).await;
        assert_eq!(status.state, STATE_OFFLINE);
        assert_eq!(
            status.message.as_deref(),
            Some("You are offline. Pandu will try again later.")
        );
        assert!(!status.can_install);
    }

    #[tokio::test]
    async fn rate_limits_report_when_github_will_try_again() {
        let (url, _state, _server) = mock_server(MockResponse::RateLimited).await;
        let (service, _store, _live) = service(url);

        let status = service.check(false).await;
        assert_eq!(status.state, STATE_RATE_LIMITED);
        let message = status.message.unwrap();
        assert!(message.contains("limiting update checks"), "{message}");
        assert!(message.contains("2026-01-01T00:00:00Z"), "{message}");
    }

    #[tokio::test]
    async fn a_missing_repository_is_unavailable_not_an_error() {
        let (url, _state, _server) = mock_server(MockResponse::NotFound).await;
        let (service, _store, _live) = service(url);

        let status = service.check(false).await;
        assert_eq!(status.state, STATE_UNAVAILABLE);
        let message = status.message.unwrap();
        assert!(message.contains("private or not published"), "{message}");
    }

    #[tokio::test]
    async fn an_unreadable_response_is_reported_without_crashing() {
        let (url, _state, _server) = mock_server(MockResponse::Garbage).await;
        let (service, _store, _live) = service(url);

        let status = service.check(false).await;
        assert_eq!(status.state, STATE_ERROR);
        assert!(
            status
                .message
                .as_deref()
                .unwrap()
                .contains("does not understand")
        );
    }

    #[tokio::test]
    async fn drafts_prereleases_and_older_versions_are_not_offered() {
        for body in [
            release("v9.9.9", "soon").replace("\"draft\":false", "\"draft\":true"),
            release("v9.9.9", "soon").replace("\"prerelease\":false", "\"prerelease\":true"),
            release("v0.0.1", "old"),
        ] {
            let (url, _state, _server) = mock_server(MockResponse::Release {
                body,
                etag: "\"stable\"",
            })
            .await;
            let (service, _store, _live) = service(url);
            let status = service.check(false).await;
            assert_eq!(status.state, STATE_UP_TO_DATE);
            assert_eq!(status.latest_version, None);
        }
    }

    #[tokio::test]
    async fn release_notes_are_sanitized_before_the_ui_sees_them() {
        let (url, _state, _server) = mock_server(MockResponse::Release {
            body: release(
                "v9.9.9",
                "<script>alert('x')</script>\n![tracker](https://tracker.example/pixel.png)\n- Real note",
            ),
            etag: "\"notes\"",
        })
        .await;
        let (service, _store, _live) = service(url);

        let status = service.check(false).await;
        let notes = status.notes.unwrap();
        assert!(!notes.contains("<script>"), "{notes}");
        assert!(!notes.contains("tracker.example"), "{notes}");
        assert!(notes.contains("Real note"), "{notes}");
    }

    #[tokio::test]
    async fn snooze_tomorrow_survives_a_restart() {
        let (url, _state, _server) = mock_server(MockResponse::Release {
            body: release("v9.9.9", "- Faster flights"),
            etag: "\"snooze\"",
        })
        .await;
        let (first, store, live) = service(url.clone());
        assert_eq!(first.check(false).await.state, STATE_AVAILABLE);

        let status = first.snooze("tomorrow").unwrap();
        assert_eq!(status.state, STATE_SNOOZED);
        let until = status.snoozed_until.clone().expect("a snooze timestamp");
        let until = DateTime::parse_from_rfc3339(&until).unwrap();
        assert!(until > Utc::now());

        // A new process with the same database sees the snooze.
        let restarted = UpdateService::for_test(store.clone(), live, reqwest::Client::new(), url);
        let status = restarted.check(false).await;
        assert_eq!(status.state, STATE_SNOOZED);
        assert_eq!(
            status.message.as_deref(),
            Some("Reminder snoozed. You can still update now.")
        );
    }

    #[tokio::test]
    async fn a_week_snooze_is_seven_days_out() {
        let (url, _state, _server) = mock_server(MockResponse::Release {
            body: release("v9.9.9", "- Faster flights"),
            etag: "\"week\"",
        })
        .await;
        let (service, _store, _live) = service(url);
        service.check(false).await;

        let status = service.snooze("week").unwrap();
        let until = DateTime::parse_from_rfc3339(status.snoozed_until.as_deref().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        let days = (until - Utc::now()).num_days();
        assert!((6..=7).contains(&days), "{days} days");
    }

    #[tokio::test]
    async fn skipping_a_version_survives_a_restart_and_is_per_version() {
        let (url, state, _server) = mock_server(MockResponse::Release {
            body: release("v9.9.9", "- Faster flights"),
            etag: "\"skip\"",
        })
        .await;
        let (first, store, live) = service(url.clone());
        first.check(false).await;

        let status = first.snooze("version").unwrap();
        assert_eq!(status.state, STATE_SKIPPED);
        assert_eq!(status.skipped_version.as_deref(), Some("9.9.9"));

        let mut receiver = live.subscribe();
        let restarted = UpdateService::for_test(store.clone(), live, reqwest::Client::new(), url);
        let status = restarted.check(false).await;
        assert_eq!(status.state, STATE_SKIPPED);
        assert!(
            receiver.try_recv().is_err(),
            "a skipped version must not notify again"
        );

        // The next release is offered normally.
        *state.response.lock().unwrap() = MockResponse::Release {
            body: release("v9.9.10", "- Even faster flights"),
            etag: "\"skip-next\"",
        };
        let status = restarted.check(false).await;
        assert_eq!(status.state, STATE_AVAILABLE);
        assert_eq!(status.latest_version.as_deref(), Some("9.9.10"));
    }

    #[tokio::test]
    async fn skipping_without_a_known_release_is_refused() {
        let (service, _store, _live) = service("http://127.0.0.1:9".to_string());
        let error = service.snooze("version").unwrap_err().to_string();
        assert!(error.contains("no update to skip"), "{error}");

        let error = service.snooze("forever").unwrap_err().to_string();
        assert!(error.contains("tomorrow"), "{error}");
    }

    #[tokio::test]
    async fn update_available_is_published_once_per_version() {
        let (url, _state, _server) = mock_server(MockResponse::Release {
            body: release("v9.9.9", "## Highlights\n\n- Faster flights"),
            etag: "\"notify\"",
        })
        .await;
        let (service, store, live) = service(url);
        let mut receiver = live.subscribe();

        service.check(false).await;
        let event = receiver.try_recv().expect("an update notification");
        assert_eq!(event.event_type, "update.available");
        assert_eq!(event.payload["version"], "9.9.9");
        assert_eq!(event.payload["notesSummary"], "## Highlights");
        assert_eq!(
            event.payload["releaseUrl"],
            "https://example.com/releases/v9.9.9"
        );

        service.check(false).await;
        assert!(
            receiver.try_recv().is_err(),
            "the same version must only notify once"
        );
        let events = store.recent_live_events(10).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type == "update.available")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn automatic_checks_respect_the_setting_but_manual_checks_do_not() {
        let (url, state, _server) = mock_server(MockResponse::Release {
            body: release("v9.9.9", "- Faster flights"),
            etag: "\"manual\"",
        })
        .await;
        let (service, _store, _live) = service(url);

        let status = service.set_enabled(false).unwrap();
        assert!(!status.enabled);
        assert_eq!(status.next_check_at, None);

        let status = service.check(false).await;
        assert_eq!(status.state, STATE_IDLE);
        assert_eq!(state.requests.load(Ordering::SeqCst), 0);

        let status = service.check(true).await;
        assert_eq!(status.state, STATE_AVAILABLE);
        assert_eq!(state.requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn is_due_honors_the_interval_and_the_setting() {
        let (service, store, _live) = service("http://127.0.0.1:9".to_string());
        assert!(service.is_due(), "a fresh install checks once");

        store
            .set_setting(
                SETTING_LAST_CHECK,
                &Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            )
            .unwrap();
        assert!(!service.is_due());

        store
            .set_setting(
                SETTING_LAST_CHECK,
                &(Utc::now() - ChronoDuration::hours(25))
                    .to_rfc3339_opts(SecondsFormat::Secs, true),
            )
            .unwrap();
        assert!(service.is_due());

        service.set_enabled(false).unwrap();
        assert!(!service.is_due());
    }

    #[tokio::test]
    async fn status_reports_the_build_trust_root_honestly() {
        let (service, _store, _live) = service("http://127.0.0.1:9".to_string());
        let status = service.status();
        assert_eq!(status.channel, brand::UPDATE_CHANNEL);
        assert_eq!(status.current_version, pandu_core::VERSION);
        assert_eq!(
            status.install_command,
            format!("{} update", brand::CLI_COMMAND)
        );
        // Debug and test builds embed the test key, so they may install test
        // updates but must never claim one is ready before a check. A release
        // build with no production key must report that it cannot update.
        if cfg!(debug_assertions) {
            assert_eq!(status.trust, "ready");
            assert_eq!(status.signing, "test");
            assert_eq!(status.signing_label, "Test key (development)");
        } else {
            assert_eq!(status.trust, "preparing");
            assert_eq!(status.signing, "disabled");
            assert_eq!(status.signing_label, "No production key: updates disabled");
            assert_eq!(
                status.message.as_deref(),
                Some(pandu_core::update::UPDATE_PREPARING_MESSAGE)
            );
        }
        assert!(!status.can_install);
    }
}
