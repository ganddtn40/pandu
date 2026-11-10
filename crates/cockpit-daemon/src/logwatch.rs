//! Read-only log watching.
//!
//! The watcher polls every adapter's declared roots, parses new session files,
//! and stores the result as an observed flight. It never writes to an agent's
//! files, never changes an agent's configuration, and never blocks an agent.
//!
//! Files are re-read in full when they change. That keeps prompt context and
//! streamed-message merging correct across scans. Stable per-record keys stored
//! in the watcher state make the re-read idempotent: a step is inserted once,
//! even after a daemon restart.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use cockpit_core::adapter::{Adapter, AdapterRegistry, LogWatchSpec};
use cockpit_core::cost::{ModelPricing, estimate_usage_cost};
use cockpit_core::model::{CaptureMode, Session, SessionSource, SessionStatus, StepKind, ToolCall};
use cockpit_core::provider::{AgentInfo, DetectedFrom};
use cockpit_core::redact::{CaptureLocation, RedactionCollector, redact_json, redact_text};
use glob::{MatchOptions, Pattern};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::adapters;
use crate::error::{DaemonError, Result};
use crate::live::LiveBus;
use crate::logparse::{self, ParsedBatch, ParsedModelStep, ParsedRecord, ParsedToolResult};
use crate::store::{NewSession, ObservedStep, Store, now_iso};

/// The settings key that stores per-file cursors.
pub const STATE_KEY: &str = "logwatch.state.v1";

/// How often the watcher looks for new data.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);

/// A record without an explicit end-of-turn marker is held until its file has
/// been quiet for this long.
const OPEN_RECORD_GRACE: Duration = Duration::from_secs(4);

/// An observed flight is marked complete when its log has been quiet this long.
const ACTIVE_WINDOW: Duration = Duration::from_secs(10 * 60);

/// A single JSON session file larger than this is skipped.
const MAX_JSON_BYTES: u64 = 32 * 1024 * 1024;

/// JSONL files are re-read from the tail when they exceed this size.
const MAX_JSONL_READ_BYTES: u64 = 32 * 1024 * 1024;

const MAX_FILES_PER_ADAPTER: usize = 2_000;
const MAX_TRACKED_FILES: usize = 5_000;
const MAX_WALK_DEPTH: usize = 12;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub last_scan_at: Option<String>,
    pub last_scan_steps: u64,
    pub files_tracked: usize,
    pub files_imported: usize,
    pub steps_imported: u64,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
}

/// The log watcher is cheap to clone: every field is shared.
#[derive(Clone)]
pub struct LogWatcher {
    store: Arc<Store>,
    registry: Arc<AdapterRegistry>,
    live: Arc<LiveBus>,
    status: Arc<Mutex<WatchStatus>>,
}

impl LogWatcher {
    pub fn new(store: Arc<Store>, registry: Arc<AdapterRegistry>, live: Arc<LiveBus>) -> Self {
        Self {
            store,
            registry,
            live,
            status: Arc::new(Mutex::new(WatchStatus::default())),
        }
    }

    pub fn status(&self) -> WatchStatus {
        self.status
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// One full pass over every log-watch adapter. Never returns an error: a
    /// broken adapter or unreadable file becomes a warning so the daemon keeps
    /// running.
    pub fn scan(&self) -> WatchStatus {
        let mut report = WatchReport::default();
        let mut state = self.load_state(&mut report);
        let overrides = pricing_overrides(&self.store);
        let mut seen: BTreeSet<String> = BTreeSet::new();

        let adapters: Vec<Adapter> = self.registry.log_watch_adapters().cloned().collect();
        for adapter in adapters {
            let Some(spec) = adapter.log_watch.clone() else {
                continue;
            };
            let patterns = match compile_patterns(&spec.include) {
                Ok(patterns) => patterns,
                Err(error) => {
                    report.warn(format!("{}: {error}", adapter.id));
                    continue;
                }
            };
            for root_text in &spec.roots {
                let root = match adapters::expand_path(root_text) {
                    Ok(root) => root,
                    Err(error) => {
                        report.warn(format!("{}: {error}", adapter.id));
                        continue;
                    }
                };
                if !root.is_dir() {
                    continue;
                }
                for path in walk_files(&root, &patterns, MAX_FILES_PER_ADAPTER) {
                    let key = file_key(&adapter.id, &path);
                    seen.insert(key.clone());
                    report.files_seen += 1;
                    if let Err(error) = self.process_file(
                        &adapter,
                        &spec,
                        &path,
                        &key,
                        &mut state,
                        &overrides,
                        &mut report,
                    ) {
                        report.warn(format!("{}: {error}", path.display()));
                    }
                }
            }
        }

        // A flight whose log has gone quiet is complete. This also closes
        // historical files the first time they are imported.
        let mut finished: Vec<String> = Vec::new();
        for (key, cursor) in &state.files {
            if cursor.completed || cursor.session_id.is_empty() {
                continue;
            }
            let Some(last) = cursor.last_timestamp.as_deref() else {
                continue;
            };
            if !is_older_than(last, ACTIVE_WINDOW) {
                continue;
            }
            match self.store.finish_observed_session(&cursor.session_id, last) {
                Ok(()) => {
                    finished.push(key.clone());
                    report.state_changed = true;
                }
                Err(error) => report.warn(format!("{}: {error}", cursor.session_id)),
            }
        }
        for key in finished {
            if let Some(cursor) = state.files.get_mut(&key) {
                cursor.completed = true;
            }
        }

        if state.files.len() > MAX_TRACKED_FILES {
            let mut entries: Vec<(String, String)> = state
                .files
                .iter()
                .map(|(key, cursor)| (key.clone(), cursor.last_seen_at.clone().unwrap_or_default()))
                .collect();
            entries.sort_by(|left, right| right.1.cmp(&left.1));
            let keep: BTreeSet<String> = entries
                .into_iter()
                .take(MAX_TRACKED_FILES)
                .map(|(key, _)| key)
                .collect();
            state.files.retain(|key, _| keep.contains(key));
            report.state_changed = true;
        }

        if report.state_changed {
            match serde_json::to_string(&state) {
                Ok(raw) => {
                    if let Err(error) = self.store.set_setting(STATE_KEY, &raw) {
                        report.warn(format!("could not save the watcher state: {error}"));
                    }
                }
                Err(error) => report.warn(format!("could not encode the watcher state: {error}")),
            }
        }

        let scan_at = now_iso();
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        status.last_scan_at = Some(scan_at);
        status.last_scan_steps = report.steps_imported;
        status.files_tracked = state.files.len();
        status.files_imported = state
            .files
            .values()
            .filter(|cursor| !cursor.session_id.is_empty())
            .count();
        status.steps_imported += report.steps_imported;
        status.warnings = report.warnings.iter().take(20).cloned().collect();
        status.last_error = status.warnings.first().cloned();
        status.clone()
    }

    fn load_state(&self, report: &mut WatchReport) -> WatchState {
        match self.store.get_setting(STATE_KEY) {
            Ok(Some(raw)) => serde_json::from_str::<WatchState>(&raw).unwrap_or_else(|error| {
                report.warn(format!(
                    "the watcher state was unreadable and was reset: {error}"
                ));
                WatchState::default()
            }),
            Ok(None) => WatchState::default(),
            Err(error) => {
                report.warn(format!("could not read the watcher state: {error}"));
                WatchState::default()
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn process_file(
        &self,
        adapter: &Adapter,
        spec: &LogWatchSpec,
        path: &Path,
        key: &str,
        state: &mut WatchState,
        overrides: &[ModelPricing],
        report: &mut WatchReport,
    ) -> Result<()> {
        let metadata = fs::metadata(path)?;
        if !metadata.is_file() {
            return Ok(());
        }
        let is_jsonl = spec.parser.ends_with("jsonl");
        if !is_jsonl && metadata.len() > MAX_JSON_BYTES {
            report.warn(format!(
                "{}: the file is larger than {} MB and was skipped",
                path.display(),
                MAX_JSON_BYTES / (1024 * 1024)
            ));
            return Ok(());
        }

        let fingerprint = fingerprint(path)?;
        let previous = state.files.get(key).cloned();
        let previous = previous.filter(|cursor| cursor.fingerprint == fingerprint);
        let mut imported: BTreeSet<u64> = previous
            .as_ref()
            .map(|cursor| cursor.imported.iter().copied().collect())
            .unwrap_or_default();
        let mut session_id = previous
            .as_ref()
            .map(|cursor| cursor.session_id.clone())
            .filter(|id| !id.is_empty());
        if let Some(id) = &session_id {
            if self.store.get_session(id)?.is_none() {
                session_id = None;
                imported.clear();
            }
        }

        let contents = read_text(
            path,
            if is_jsonl {
                MAX_JSONL_READ_BYTES
            } else {
                MAX_JSON_BYTES
            },
        )?;
        if contents.trim().is_empty() {
            return Ok(());
        }

        let quiet = is_quiet(&metadata);
        let batch = match logparse::parse(&spec.parser, &contents, 0) {
            Ok(batch) => batch,
            Err(error) => {
                // A JSON session file is often incomplete while it is being
                // written. Only report the error once the file has settled.
                if quiet {
                    report.warn(format!("{}: {error}", path.display()));
                }
                return Ok(());
            }
        };
        if quiet {
            for warning in &batch.warnings {
                report.warn(format!("{}: {warning}", path.display()));
            }
        }

        let external_id = batch.session.external_id.clone();
        let mut last_timestamp = previous
            .as_ref()
            .and_then(|cursor| cursor.last_timestamp.clone());
        let mut created_steps = 0u64;
        let mut changed = false;

        for record in &batch.records {
            match record {
                ParsedRecord::Model(step) => {
                    if imported.contains(&step.key) {
                        continue;
                    }
                    // Hold an unfinished turn until the file settles, so a
                    // streamed message is stored once and in full.
                    if !step.closed && !quiet {
                        continue;
                    }
                    if session_id.is_none() {
                        let session = self.create_session(adapter, spec, path, &batch, step)?;
                        session_id = Some(session.id.clone());
                    }
                    let id = session_id.clone().ok_or_else(|| {
                        DaemonError::other("the observed session was not created")
                    })?;
                    let observed =
                        build_observed_step(step, external_id.as_deref(), &id, overrides);
                    let created = self.store.insert_observed_step(&id, observed)?;
                    self.live.publish(
                        "step.observed",
                        Some(&id),
                        Some(&created.id),
                        json!({
                            "source": "log_watch",
                            "adapter": adapter.id,
                            "parser": spec.parser,
                        }),
                    );
                    imported.insert(step.key);
                    created_steps += 1;
                    changed = true;
                    last_timestamp = latest_timestamp(
                        last_timestamp,
                        step.ended_at.as_deref().unwrap_or(&step.started_at),
                    );
                }
                ParsedRecord::ToolResult(result) => {
                    let Some(id) = session_id.clone() else {
                        continue;
                    };
                    let (output, error) = redacted_tool_result(result);
                    if self.store.update_tool_call_output(
                        &id,
                        &result.provider_tool_call_id,
                        output,
                        error,
                        result.ended_at.clone(),
                    )? {
                        changed = true;
                    }
                }
            }
        }

        if let Some(id) = &session_id {
            if created_steps > 0 {
                if previous.as_ref().is_some_and(|cursor| cursor.completed) {
                    self.store.mark_observed_active(id)?;
                }
                let mut collector = RedactionCollector::new();
                let title =
                    batch.session.title.as_deref().map(|title| {
                        redact_text(title, &mut collector, CaptureLocation::RequestBody)
                    });
                self.store.update_observed_session(
                    id,
                    title.as_deref(),
                    batch.session.workspace_path.as_deref(),
                    batch.session.git_branch.as_deref(),
                    batch.session.model.as_deref(),
                )?;
            }
        }

        let completed =
            previous.as_ref().is_some_and(|cursor| cursor.completed) && created_steps == 0;
        let next = FileCursor {
            adapter_id: adapter.id.clone(),
            session_id: session_id.unwrap_or_default(),
            fingerprint,
            last_timestamp,
            completed,
            imported: imported.into_iter().collect(),
            last_seen_at: if changed {
                Some(now_iso())
            } else {
                previous
                    .as_ref()
                    .and_then(|cursor| cursor.last_seen_at.clone())
            },
        };

        if previous.as_ref() != Some(&next) {
            state.files.insert(key.to_string(), next);
            report.state_changed = true;
        }
        report.steps_imported += created_steps;
        report.files_updated += usize::from(changed);
        Ok(())
    }

    fn create_session(
        &self,
        adapter: &Adapter,
        spec: &LogWatchSpec,
        path: &Path,
        batch: &ParsedBatch,
        step: &ParsedModelStep,
    ) -> Result<Session> {
        let raw_title = batch
            .session
            .title
            .clone()
            .or_else(|| step.prompt.as_deref().map(title_from_prompt))
            .unwrap_or_else(|| format!("Observed {}", file_stem(path)));
        let mut collector = RedactionCollector::new();
        let title = redact_text(&raw_title, &mut collector, CaptureLocation::RequestBody);
        let started_at = batch
            .session
            .started_at
            .clone()
            .unwrap_or_else(|| step.started_at.clone());
        let agent = AgentInfo {
            name: Some(adapter.name.clone()),
            version: batch.session.agent_version.clone(),
            user_agent: None,
            detected_from: DetectedFrom::LogWatch,
        };

        self.store.create_session(NewSession {
            title,
            source: SessionSource::LogWatch,
            capture_mode: CaptureMode::LogWatch,
            source_label: Some(format!("Observed from logs · {}", adapter.name)),
            status: SessionStatus::Active,
            protocol: Some(step.provider),
            provider: Some(step.provider.default_provider().to_string()),
            model: step.model.clone().or_else(|| batch.session.model.clone()),
            agent: Some(agent),
            workspace_path: batch.session.workspace_path.clone(),
            git_branch: batch.session.git_branch.clone(),
            git_base_commit: None,
            started_at: Some(started_at),
            ended_at: None,
            tags: vec!["log-watch".to_string(), adapter.id.clone()],
            metadata: Some(json!({
                "observedFrom": adapter.id,
                "parser": spec.parser,
                "logFile": path.display().to_string(),
                "externalId": batch.session.external_id,
            })),
        })
    }
}

/// Poll the watcher until the task is aborted by the server.
pub async fn watch_loop(watcher: Arc<LogWatcher>, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let scan = watcher.clone();
        match tokio::task::spawn_blocking(move || scan.scan()).await {
            Ok(status) => {
                if status.last_scan_steps > 0 {
                    tracing::debug!(
                        steps = status.last_scan_steps,
                        files = status.files_tracked,
                        "imported observed steps"
                    );
                }
            }
            Err(error) => tracing::warn!(%error, "the log watcher scan could not run"),
        }
    }
}

/// The persisted watcher state is useful to `cockpit doctor` without running a
/// scan.
pub fn stored_state(store: &Store) -> (usize, u64) {
    match store.get_setting(STATE_KEY) {
        Ok(Some(raw)) => match serde_json::from_str::<WatchState>(&raw) {
            Ok(state) => (
                state.files.len(),
                state
                    .files
                    .values()
                    .map(|cursor| cursor.imported.len() as u64)
                    .sum(),
            ),
            Err(_) => (0, 0),
        },
        _ => (0, 0),
    }
}

#[derive(Debug, Default)]
struct WatchReport {
    files_seen: usize,
    files_updated: usize,
    steps_imported: u64,
    warnings: Vec<String>,
    state_changed: bool,
}

impl WatchReport {
    fn warn(&mut self, message: impl Into<String>) {
        if self.warnings.len() < 50 {
            self.warnings.push(message.into());
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchState {
    #[serde(default = "state_version")]
    version: u32,
    #[serde(default)]
    files: BTreeMap<String, FileCursor>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            version: state_version(),
            files: BTreeMap::new(),
        }
    }
}

fn state_version() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileCursor {
    adapter_id: String,
    session_id: String,
    fingerprint: String,
    last_timestamp: Option<String>,
    completed: bool,
    imported: Vec<u64>,
    last_seen_at: Option<String>,
}

fn build_observed_step(
    step: &ParsedModelStep,
    external_id: Option<&str>,
    session_id: &str,
    overrides: &[ModelPricing],
) -> ObservedStep {
    let (mut request, mut response) = logparse::observed_step_parts(step, external_id);
    let mut collector = RedactionCollector::new();
    request.system_prompt = request
        .system_prompt
        .map(|text| redact_text(&text, &mut collector, CaptureLocation::RequestBody));
    request.prompt_text = request
        .prompt_text
        .map(|text| redact_text(&text, &mut collector, CaptureLocation::RequestBody));
    response.text = response
        .text
        .map(|text| redact_text(&text, &mut collector, CaptureLocation::ResponseBody));
    response.thinking = response
        .thinking
        .map(|text| redact_text(&text, &mut collector, CaptureLocation::ResponseBody));
    response.error = response
        .error
        .map(|text| redact_text(&text, &mut collector, CaptureLocation::ResponseBody));

    let tool_calls: Vec<ToolCall> = step
        .tool_calls
        .iter()
        .map(|call| {
            let mut call = call.clone();
            call.input = call
                .input
                .map(|value| redact_json(&value, &mut collector, CaptureLocation::RequestBody));
            call.output = call
                .output
                .map(|value| redact_json(&value, &mut collector, CaptureLocation::ResponseBody));
            call.error = call
                .error
                .map(|text| redact_text(&text, &mut collector, CaptureLocation::ResponseBody));
            logparse::to_tool_call(session_id, &call)
        })
        .collect();

    let error = step
        .error
        .clone()
        .map(|text| redact_text(&text, &mut collector, CaptureLocation::ResponseBody));
    request.redaction_count = collector.total(None);

    let cost = estimate_usage_cost(
        step.usage,
        step.model.as_deref().unwrap_or("unknown"),
        Some(step.provider.default_provider()),
        overrides,
    );
    let duration_ms = step
        .ended_at
        .as_deref()
        .and_then(|ended_at| duration_between(&step.started_at, ended_at));

    ObservedStep {
        kind: StepKind::Model,
        status: step.status,
        provider: Some(step.provider.default_provider().to_string()),
        model: step.model.clone(),
        request,
        response: Some(response),
        usage: step.usage,
        cost_usd: cost.usd,
        cost_known: cost.known,
        started_at: step.started_at.clone(),
        ended_at: step.ended_at.clone(),
        duration_ms,
        error,
        metadata: step.metadata.clone(),
        tool_calls,
    }
}

fn redacted_tool_result(result: &ParsedToolResult) -> (Option<serde_json::Value>, Option<String>) {
    let mut collector = RedactionCollector::new();
    let output = result
        .output
        .as_ref()
        .map(|value| redact_json(value, &mut collector, CaptureLocation::ResponseBody));
    let error = result
        .error
        .as_deref()
        .map(|text| redact_text(text, &mut collector, CaptureLocation::ResponseBody));
    (output, error)
}

fn pricing_overrides(store: &Store) -> Vec<ModelPricing> {
    match store.get_setting("pricing.overrides") {
        Ok(Some(raw)) => serde_json::from_str::<Vec<ModelPricing>>(&raw).unwrap_or_else(|error| {
            tracing::warn!(%error, "ignoring invalid pricing overrides");
            Vec::new()
        }),
        Ok(None) => Vec::new(),
        Err(error) => {
            tracing::warn!(%error, "could not read pricing overrides");
            Vec::new()
        }
    }
}

fn compile_patterns(patterns: &[String]) -> Result<Vec<Pattern>> {
    patterns
        .iter()
        .map(|pattern| {
            Pattern::new(pattern).map_err(|error| {
                DaemonError::other(format!("invalid include pattern \"{pattern}\": {error}"))
            })
        })
        .collect()
}

fn walk_files(root: &Path, patterns: &[Pattern], limit: usize) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited: BTreeSet<PathBuf> = BTreeSet::new();
    let options = match_options();

    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_WALK_DEPTH || files.len() >= limit {
            continue;
        }
        let canonical = fs::canonicalize(&directory).unwrap_or_else(|_| directory.clone());
        if !visited.insert(canonical) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let mut entries: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            if files.len() >= limit {
                break;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Never follow links: a log directory must not become a way to
            // read files outside the declared root.
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if matches!(name.as_str(), ".git" | "node_modules" | "target") {
                    continue;
                }
                stack.push((path, depth + 1));
            } else if file_type.is_file() {
                let Ok(relative) = path.strip_prefix(root) else {
                    continue;
                };
                let relative = relative.to_string_lossy().replace('\\', "/");
                if patterns
                    .iter()
                    .any(|pattern| pattern.matches_with(&relative, options))
                {
                    files.push(path);
                }
            }
        }
    }

    files.sort();
    files
}

fn match_options() -> MatchOptions {
    MatchOptions {
        case_sensitive: !cfg!(windows),
        require_literal_separator: true,
        require_literal_leading_dot: false,
    }
}

fn file_key(adapter_id: &str, path: &Path) -> String {
    format!("{adapter_id}:{}", path.to_string_lossy().replace('\\', "/"))
}

fn read_text(path: &Path, max_bytes: u64) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(max_bytes);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        // The tail may start in the middle of a line.
        match text.find('\n') {
            Some(newline) => {
                text.drain(..=newline);
            }
            None => text.clear(),
        }
    }
    Ok(text)
}

fn fingerprint(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path)?;
    file_identity(&metadata)
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(metadata: &fs::Metadata) -> Result<String> {
    created_identity(metadata)
}

#[cfg(not(any(unix, windows)))]
fn file_identity(metadata: &fs::Metadata) -> Result<String> {
    created_identity(metadata)
}

/// A file's identity must not change when an agent appends to its log, so a
/// content hash is not suitable. Fall back to the creation time when the
/// platform has no file id.
fn created_identity(metadata: &fs::Metadata) -> Result<String> {
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_default();
    Ok(format!("created:{created}"))
}

fn is_quiet(metadata: &fs::Metadata) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= OPEN_RECORD_GRACE)
}

fn is_older_than(timestamp: &str, window: Duration) -> bool {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|parsed| {
            let age = Utc::now().signed_duration_since(parsed.with_timezone(&Utc));
            age.num_seconds() > window.as_secs() as i64
        })
        .unwrap_or(false)
}

fn duration_between(started_at: &str, ended_at: &str) -> Option<u64> {
    let started = DateTime::parse_from_rfc3339(started_at).ok()?;
    let ended = DateTime::parse_from_rfc3339(ended_at).ok()?;
    let millis = ended.signed_duration_since(started).num_milliseconds();
    (millis >= 0).then_some(millis as u64)
}

fn latest_timestamp(current: Option<String>, candidate: &str) -> Option<String> {
    match current {
        Some(current) if current.as_str() >= candidate => Some(current),
        _ => Some(candidate.to_string()),
    }
}

fn title_from_prompt(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Observed flight");
    let title: String = line.chars().take(80).collect();
    if title.is_empty() {
        "Observed flight".to_string()
    } else {
        title
    }
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("flight")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::adapter::Detect;
    use cockpit_core::model::SessionSource;

    fn test_adapter(root: &Path, parser: &str, include: &str) -> Adapter {
        Adapter {
            schema_version: 1,
            id: "test-agent".to_string(),
            name: "Test Agent".to_string(),
            verified: false,
            docs_url: "https://example.com/docs".to_string(),
            capture: vec![CaptureMode::LogWatch],
            detect: Detect {
                command: "test-agent".to_string(),
                version_args: Vec::new(),
            },
            proxy: None,
            log_watch: Some(LogWatchSpec {
                roots: vec![root.display().to_string()],
                include: vec![include.to_string()],
                parser: parser.to_string(),
                verified: false,
            }),
            hook_otel: None,
            skills: None,
            mcp: None,
            model_switch: None,
        }
    }

    fn watcher(store: Arc<Store>, adapter: Adapter) -> LogWatcher {
        let registry = Arc::new(AdapterRegistry::new(vec![adapter], Vec::new()));
        let live = LiveBus::new(store.clone(), 0);
        LogWatcher::new(store, registry, live)
    }

    fn write_jsonl(path: &Path, records: &[&str]) {
        fs::write(path, records.join("\n") + "\n").unwrap();
    }

    #[test]
    fn imports_a_log_and_redacts_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("session.jsonl");
        write_jsonl(
            &file,
            &[
                r#"{"role":"user","content":"Fix the login redirect","timestamp":"2026-01-01T10:00:00Z"}"#,
                r#"{"role":"assistant","model":"gpt-4.1","content":"Done. The key was sk-abcdefghijklmnopqrstuvwxyz0123456789.","usage":{"prompt_tokens":100,"completion_tokens":20},"timestamp":"2026-01-01T10:00:02Z"}"#,
            ],
        );
        let store = Arc::new(Store::open(":memory:").unwrap());
        let watcher = watcher(
            store.clone(),
            test_adapter(directory.path(), "generic-jsonl", "**/*.jsonl"),
        );

        let status = watcher.scan();
        assert_eq!(status.last_scan_steps, 1);
        assert_eq!(status.files_tracked, 1);

        let sessions = store.list_sessions(10, 0, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].source, SessionSource::LogWatch);
        assert_eq!(sessions[0].capture_mode, CaptureMode::LogWatch);
        assert_eq!(sessions[0].title, "Fix the login redirect");
        assert_eq!(sessions[0].status, SessionStatus::Completed);

        let steps = store.list_steps(&sessions[0].id, 10).unwrap();
        assert_eq!(steps.len(), 1);
        let response = steps[0].response.as_ref().unwrap();
        let text = response.text.as_deref().unwrap();
        assert!(text.contains("[REDACTED"));
        assert!(!text.contains("sk-abcdefghijklmnopqrstuvwxyz0123456789"));
        assert!(steps[0].request.as_ref().unwrap().redaction_count > 0);
        assert_eq!(steps[0].usage.input_tokens, 100);
        assert_eq!(steps[0].usage.output_tokens, 20);
        assert!(steps[0].cost_known);
    }

    #[test]
    fn a_second_scan_does_not_duplicate_steps() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("session.jsonl");
        write_jsonl(
            &file,
            &[
                r#"{"role":"user","content":"First","timestamp":"2026-01-01T10:00:00Z"}"#,
                r#"{"role":"assistant","content":"One","timestamp":"2026-01-01T10:00:01Z"}"#,
            ],
        );
        let store = Arc::new(Store::open(":memory:").unwrap());
        let watcher = watcher(
            store.clone(),
            test_adapter(directory.path(), "generic-jsonl", "**/*.jsonl"),
        );

        watcher.scan();
        let status = watcher.scan();
        assert_eq!(status.last_scan_steps, 0);

        let sessions = store.list_sessions(10, 0, None).unwrap();
        assert_eq!(store.list_steps(&sessions[0].id, 10).unwrap().len(), 1);
    }

    #[test]
    fn a_new_watcher_resumes_from_the_saved_state() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("session.jsonl");
        write_jsonl(
            &file,
            &[
                r#"{"role":"user","content":"First","timestamp":"2026-01-01T10:00:00Z"}"#,
                r#"{"role":"assistant","content":"One","timestamp":"2026-01-01T10:00:01Z"}"#,
            ],
        );
        let store = Arc::new(Store::open(":memory:").unwrap());
        watcher(
            store.clone(),
            test_adapter(directory.path(), "generic-jsonl", "**/*.jsonl"),
        )
        .scan();

        // Simulate a daemon restart with the same database.
        let restarted = watcher(
            store.clone(),
            test_adapter(directory.path(), "generic-jsonl", "**/*.jsonl"),
        );
        let status = restarted.scan();
        assert_eq!(status.last_scan_steps, 0);

        let sessions = store.list_sessions(10, 0, None).unwrap();
        assert_eq!(store.list_steps(&sessions[0].id, 10).unwrap().len(), 1);
    }

    #[test]
    fn appended_records_become_new_steps() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("session.jsonl");
        write_jsonl(
            &file,
            &[
                r#"{"role":"user","content":"First","timestamp":"2026-01-01T10:00:00Z"}"#,
                r#"{"role":"assistant","content":"One","timestamp":"2026-01-01T10:00:01Z"}"#,
            ],
        );
        let store = Arc::new(Store::open(":memory:").unwrap());
        let watcher = watcher(
            store.clone(),
            test_adapter(directory.path(), "generic-jsonl", "**/*.jsonl"),
        );
        watcher.scan();

        let mut contents = fs::read_to_string(&file).unwrap();
        contents.push_str(
            "{\"role\":\"user\",\"content\":\"Second\",\"timestamp\":\"2026-01-01T10:00:10Z\"}\n{\"role\":\"assistant\",\"content\":\"Two\",\"timestamp\":\"2026-01-01T10:00:11Z\"}\n",
        );
        fs::write(&file, contents).unwrap();

        let status = watcher.scan();
        assert_eq!(status.last_scan_steps, 1);

        let sessions = store.list_sessions(10, 0, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(store.list_steps(&sessions[0].id, 10).unwrap().len(), 2);
    }

    #[test]
    fn a_tool_result_updates_its_tool_call() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("session.jsonl");
        write_jsonl(
            &file,
            &[
                r#"{"role":"user","content":"List files","timestamp":"2026-01-01T10:00:00Z"}"#,
                r#"{"role":"assistant","model":"gpt-4.1","content":"","tool_calls":[{"id":"call-1","function":{"name":"shell","arguments":"{\"cmd\":\"ls\"}"}}],"timestamp":"2026-01-01T10:00:01Z"}"#,
                r#"{"role":"tool","tool_call_id":"call-1","content":"a.txt\nb.txt","timestamp":"2026-01-01T10:00:02Z"}"#,
            ],
        );
        let store = Arc::new(Store::open(":memory:").unwrap());
        let watcher = watcher(
            store.clone(),
            test_adapter(directory.path(), "generic-jsonl", "**/*.jsonl"),
        );
        watcher.scan();

        let sessions = store.list_sessions(10, 0, None).unwrap();
        let steps = store.list_steps(&sessions[0].id, 10).unwrap();
        let calls = store.list_tool_calls(&steps[0].id).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "shell");
        assert_eq!(calls[0].output.as_ref().unwrap(), &json!("a.txt\nb.txt"));
    }

    #[test]
    fn an_open_turn_is_held_until_the_file_is_quiet() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("claude.jsonl");
        write_jsonl(
            &file,
            &[
                r#"{"type":"assistant","message":{"id":"msg-1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"Partial"}],"usage":{"input_tokens":10,"output_tokens":2}},"timestamp":"2026-01-01T10:00:01Z"}"#,
            ],
        );
        let store = Arc::new(Store::open(":memory:").unwrap());
        let watcher = watcher(
            store.clone(),
            test_adapter(directory.path(), "claude-code-jsonl", "claude.jsonl"),
        );

        // A freshly written file is hot, so the unfinished turn is not stored.
        watcher.scan();
        assert_eq!(store.count_sessions().unwrap(), 0);

        // Once the file has settled, the same record is imported once.
        let quiet_at = std::time::SystemTime::now() - Duration::from_secs(10);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(quiet_at)
            .unwrap();
        let status = watcher.scan();
        assert_eq!(status.last_scan_steps, 1);
        assert_eq!(store.count_sessions().unwrap(), 1);
        assert_eq!(store.overview().unwrap().step_count, 1);

        let again = watcher.scan();
        assert_eq!(again.last_scan_steps, 0);
        assert_eq!(store.overview().unwrap().step_count, 1);
    }

    #[test]
    fn oversized_json_files_are_skipped_with_a_warning() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("session.json");
        let padding = "x".repeat((MAX_JSON_BYTES + 1) as usize);
        fs::write(
            &file,
            format!("{{\"messages\":[],\"padding\":\"{padding}\"}}"),
        )
        .unwrap();
        let store = Arc::new(Store::open(":memory:").unwrap());
        let watcher = watcher(
            store,
            test_adapter(directory.path(), "generic-json", "**/*.json"),
        );
        let status = watcher.scan();
        assert!(
            status
                .warnings
                .iter()
                .any(|warning| warning.contains("larger than"))
        );
    }
}
