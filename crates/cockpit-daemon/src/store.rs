use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use cockpit_core::model::{
    CaptureMode, CapturedRequest, CapturedResponse, FinishReason, LiveEvent, Session,
    SessionSource, SessionStatus, SessionTotals, Step, StepKind, StepStatus, StreamChunk,
    StreamChunkKind, ToolCall, ToolCallStatus,
};
use cockpit_core::provider::{AgentInfo, DetectedFrom, ProviderProtocol};
use cockpit_core::redact::{CaptureLocation, RedactionRow};
use cockpit_core::usage::TokenUsage;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{DaemonError, Result};

pub const SCHEMA_VERSION: u32 = 1;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'proxy',
  capture_mode TEXT NOT NULL DEFAULT 'proxy',
  source_label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  protocol TEXT,
  provider TEXT,
  model TEXT,
  agent_name TEXT,
  agent_version TEXT,
  agent_user_agent TEXT,
  agent_detected_from TEXT,
  workspace_path TEXT,
  git_branch TEXT,
  git_base_commit TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  step_count INTEGER NOT NULL DEFAULT 0,
  model_call_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  unknown_cost_calls INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_step_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  protocol TEXT,
  method TEXT,
  path TEXT,
  request_headers TEXT,
  request_body TEXT,
  request_stream INTEGER NOT NULL DEFAULT 0,
  request_system_prompt TEXT,
  request_prompt_text TEXT,
  request_redaction_count INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  response_headers TEXT,
  response_finish_reason TEXT,
  response_text TEXT,
  response_thinking TEXT,
  response_ttft_ms INTEGER,
  response_latency_ms INTEGER,
  response_error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  cost_known INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  metadata TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_session_seq ON steps(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id, started_at);

CREATE TABLE IF NOT EXISTS redactions (
  step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  label TEXT NOT NULL,
  location TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (step_id, rule_id, label, location)
);

CREATE TABLE IF NOT EXISTS stream_chunks (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  delta_text TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stream_chunks_step ON stream_chunks(step_id, seq);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES steps(id) ON DELETE CASCADE,
  provider_tool_call_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  file_paths TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_step ON tool_calls(step_id);

CREATE TABLE IF NOT EXISTS live_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  session_id TEXT,
  step_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_live_events_at ON live_events(sequence DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

#[derive(Debug, Clone, Default)]
pub struct NewSession {
    pub title: String,
    pub source: SessionSource,
    pub capture_mode: CaptureMode,
    pub source_label: Option<String>,
    pub status: SessionStatus,
    pub protocol: Option<ProviderProtocol>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub agent: Option<AgentInfo>,
    pub workspace_path: Option<String>,
    pub git_branch: Option<String>,
    pub git_base_commit: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub tags: Vec<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct BeginStep {
    pub session_id: String,
    pub kind: StepKind,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub request: CapturedRequest,
}

#[derive(Debug, Clone)]
pub struct CompleteStep {
    pub status: StepStatus,
    pub response_status: u16,
    pub response_headers: BTreeMap<String, String>,
    pub response_text: Option<String>,
    pub response_thinking: Option<String>,
    pub finish_reason: Option<FinishReason>,
    pub usage: TokenUsage,
    pub cost_usd: Option<f64>,
    pub cost_known: bool,
    pub model: Option<String>,
    pub error: Option<String>,
    pub ttft_ms: Option<u64>,
    pub latency_ms: u64,
}

/// A completed step reconstructed from an agent's own log file.
///
/// Unlike a proxied step it never passes through the "running" state, so it is
/// inserted directly with its historical timestamps.
#[derive(Debug, Clone)]
pub struct ObservedStep {
    pub kind: StepKind,
    pub status: StepStatus,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub request: CapturedRequest,
    pub response: Option<CapturedResponse>,
    pub usage: TokenUsage,
    pub cost_usd: Option<f64>,
    pub cost_known: bool,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    pub metadata: Option<Value>,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub session_count: u64,
    pub active_session_count: u64,
    pub step_count: u64,
    pub tool_call_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_cost_usd: f64,
    pub unknown_cost_calls: u64,
    pub error_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_session_at: Option<String>,
}

pub struct Store {
    connection: Mutex<Connection>,
}

/// Refuse to open a 0.1.0 database.
///
/// `CREATE TABLE IF NOT EXISTS` would silently leave the old `sessions` table
/// in place and then fail at query time, so check the shape before touching
/// anything. A fresh database has no `sessions` table yet.
fn ensure_compatible_schema(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(sessions)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    if !columns.is_empty() && !columns.iter().any(|column| column == "capture_mode") {
        return Err(DaemonError::config(
            "this database was written by Cockpit 0.1.0 and the 0.2.0 schema is not compatible. \
             Move the old database aside or start with a fresh --home.",
        ));
    }

    Ok(())
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if path != Path::new(":memory:") {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
        }

        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        ensure_compatible_schema(&connection)?;
        connection.execute_batch(SCHEMA)?;

        let existing: Option<String> = connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;

        match existing {
            Some(version) => {
                let version = version.parse::<u32>().unwrap_or(0);
                if version > SCHEMA_VERSION {
                    return Err(DaemonError::config(format!(
                        "the database uses schema version {version}, but this build understands {SCHEMA_VERSION}"
                    )));
                }
            }
            None => {
                connection.execute(
                    "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?1)",
                    params![SCHEMA_VERSION.to_string()],
                )?;
            }
        }

        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn ping(&self) -> bool {
        self.connection
            .lock()
            .ok()
            .and_then(|connection| {
                connection
                    .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                    .ok()
            })
            .is_some()
    }

    pub fn overview(&self) -> Result<Overview> {
        let connection = self.lock()?;
        let row = connection.query_row(
            "SELECT
               COUNT(*),
               COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(step_count), 0),
               COALESCE(SUM(tool_call_count), 0),
               COALESCE(SUM(input_tokens), 0),
               COALESCE(SUM(output_tokens), 0),
               COALESCE(SUM(cache_read_tokens), 0),
               COALESCE(SUM(cache_write_tokens), 0),
               COALESCE(SUM(reasoning_tokens), 0),
               COALESCE(SUM(total_cost_usd), 0),
               COALESCE(SUM(unknown_cost_calls), 0),
               COALESCE(SUM(error_count), 0),
               MAX(started_at)
             FROM sessions",
            [],
            |row| {
                Ok(Overview {
                    session_count: row.get::<_, i64>(0)? as u64,
                    active_session_count: row.get::<_, i64>(1)? as u64,
                    step_count: row.get::<_, i64>(2)? as u64,
                    tool_call_count: row.get::<_, i64>(3)? as u64,
                    input_tokens: row.get::<_, i64>(4)? as u64,
                    output_tokens: row.get::<_, i64>(5)? as u64,
                    cache_read_tokens: row.get::<_, i64>(6)? as u64,
                    cache_write_tokens: row.get::<_, i64>(7)? as u64,
                    reasoning_tokens: row.get::<_, i64>(8)? as u64,
                    total_cost_usd: row.get::<_, f64>(9)?,
                    unknown_cost_calls: row.get::<_, i64>(10)? as u64,
                    error_count: row.get::<_, i64>(11)? as u64,
                    last_session_at: row.get::<_, Option<String>>(12)?,
                })
            },
        )?;
        Ok(row)
    }

    pub fn create_session(&self, input: NewSession) -> Result<Session> {
        let id = cockpit_core::ids::create_id();
        let started_at = input.started_at.unwrap_or_else(now_iso);
        let duration_ms = input
            .ended_at
            .as_deref()
            .and_then(|ended_at| duration_between(&started_at, ended_at));
        let tags = serde_json::to_string(&input.tags)?;
        let metadata = input
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let (agent_name, agent_version, agent_user_agent, agent_detected_from) = match &input.agent
        {
            Some(agent) => (
                agent.name.clone(),
                agent.version.clone(),
                agent.user_agent.clone(),
                Some(detected_from_str(agent.detected_from).to_string()),
            ),
            None => (None, None, None, None),
        };

        {
            let connection = self.lock()?;
            connection.execute(
                "INSERT INTO sessions (
                   id, title, source, capture_mode, source_label, status, protocol, provider, model,
                   agent_name, agent_version, agent_user_agent, agent_detected_from,
                   workspace_path, git_branch, git_base_commit, started_at, ended_at, duration_ms,
                   tags, metadata
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                           ?16, ?17, ?18, ?19, ?20, ?21)",
                params![
                    id,
                    input.title,
                    input.source.as_str(),
                    input.capture_mode.as_str(),
                    input.source_label,
                    input.status.as_str(),
                    input.protocol.map(|protocol| protocol.as_str()),
                    input.provider,
                    input.model,
                    agent_name,
                    agent_version,
                    agent_user_agent,
                    agent_detected_from,
                    input.workspace_path,
                    input.git_branch,
                    input.git_base_commit,
                    started_at,
                    input.ended_at,
                    duration_ms,
                    tags,
                    metadata,
                ],
            )?;
        }

        self.get_session(&id)?
            .ok_or_else(|| DaemonError::other("session disappeared after insert"))
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>> {
        let connection = self.lock()?;
        let session = connection
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"),
                params![id],
                row_to_session,
            )
            .optional()?;
        Ok(session)
    }

    pub fn list_sessions(
        &self,
        limit: u32,
        offset: u32,
        status: Option<SessionStatus>,
    ) -> Result<Vec<Session>> {
        let connection = self.lock()?;
        let mut sessions = Vec::new();
        match status {
            Some(status) => {
                let mut statement = connection.prepare(&format!(
                    "SELECT {SESSION_COLUMNS} FROM sessions WHERE status = ?1 ORDER BY started_at DESC LIMIT ?2 OFFSET ?3"
                ))?;
                let rows =
                    statement.query_map(params![status.as_str(), limit, offset], row_to_session)?;
                for row in rows {
                    sessions.push(row?);
                }
            }
            None => {
                let mut statement = connection.prepare(&format!(
                    "SELECT {SESSION_COLUMNS} FROM sessions ORDER BY started_at DESC LIMIT ?1 OFFSET ?2"
                ))?;
                let rows = statement.query_map(params![limit, offset], row_to_session)?;
                for row in rows {
                    sessions.push(row?);
                }
            }
        }
        Ok(sessions)
    }

    pub fn count_sessions(&self) -> Result<u64> {
        let connection = self.lock()?;
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?;
        Ok(count as u64)
    }

    pub fn list_active_sessions(&self) -> Result<Vec<Session>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM sessions WHERE status = 'active' ORDER BY started_at DESC"
        ))?;
        let rows = statement.query_map([], row_to_session)?;
        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row?);
        }
        Ok(sessions)
    }

    pub fn end_session(&self, id: &str, status: SessionStatus) -> Result<Option<Session>> {
        let ended_at = now_iso();
        {
            let connection = self.lock()?;
            let started_at: Option<String> = connection
                .query_row(
                    "SELECT started_at FROM sessions WHERE id = ?1 AND status = 'active'",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(started_at) = started_at else {
                drop(connection);
                return self.get_session(id);
            };
            let duration = duration_between(&started_at, &ended_at);
            connection.execute(
                "UPDATE sessions SET status = ?1, ended_at = ?2, duration_ms = ?3 WHERE id = ?4",
                params![status.as_str(), ended_at, duration, id],
            )?;
        }
        self.get_session(id)
    }

    pub fn touch_session(
        &self,
        id: &str,
        agent: Option<&AgentInfo>,
        provider: Option<&str>,
    ) -> Result<()> {
        if agent.is_none() && provider.is_none() {
            return Ok(());
        }
        let connection = self.lock()?;
        match agent {
            Some(agent) => {
                connection.execute(
                    "UPDATE sessions SET
                       provider = COALESCE(?1, provider),
                       agent_name = COALESCE(?2, agent_name),
                       agent_version = COALESCE(?3, agent_version),
                       agent_user_agent = COALESCE(?4, agent_user_agent),
                       agent_detected_from = COALESCE(?5, agent_detected_from)
                     WHERE id = ?6",
                    params![
                        provider,
                        agent.name,
                        agent.version,
                        agent.user_agent,
                        detected_from_str(agent.detected_from),
                        id
                    ],
                )?;
            }
            None => {
                connection.execute(
                    "UPDATE sessions SET provider = COALESCE(?1, provider) WHERE id = ?2",
                    params![provider, id],
                )?;
            }
        }
        Ok(())
    }

    pub fn begin_step(&self, input: BeginStep) -> Result<Step> {
        let id = cockpit_core::ids::create_id();
        let started_at = now_iso();
        let request = &input.request;
        let headers = serde_json::to_string(&request.headers)?;
        let body = request
            .body
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        let seq: i64 = {
            let connection = self.lock()?;
            let seq: i64 = connection.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE session_id = ?1",
                params![input.session_id],
                |row| row.get(0),
            )?;
            connection.execute(
                "INSERT INTO steps (
                   id, session_id, seq, kind, status, provider, model, protocol, method, path,
                   request_headers, request_body, request_stream, request_system_prompt,
                   request_prompt_text, request_redaction_count, started_at
                 ) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    id,
                    input.session_id,
                    seq,
                    input.kind.as_str(),
                    input.provider,
                    input.model,
                    request.protocol.as_str(),
                    request.method,
                    request.path,
                    headers,
                    body,
                    request.stream as i64,
                    request.system_prompt,
                    request.prompt_text,
                    request.redaction_count as i64,
                    started_at,
                ],
            )?;
            seq
        };

        self.get_step(&id)?
            .ok_or_else(|| DaemonError::other("step disappeared after insert"))
            .map(|mut step| {
                step.seq = seq as u64;
                step
            })
    }

    /// Finalize a running step and update the session totals atomically.
    /// Returns `None` when the step was already finalized.
    pub fn complete_step(
        &self,
        step_id: &str,
        input: CompleteStep,
        tool_call_count: u64,
    ) -> Result<Option<Step>> {
        let ended_at = now_iso();
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;

        let session_id: Option<String> = transaction
            .query_row(
                "SELECT session_id FROM steps WHERE id = ?1 AND status = 'running'",
                params![step_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(session_id) = session_id else {
            return Ok(None);
        };

        let response_headers = serde_json::to_string(&input.response_headers)?;
        transaction.execute(
            "UPDATE steps SET
               status = ?1, model = COALESCE(?2, model), response_status = ?3,
               response_headers = ?4, response_finish_reason = ?5, response_text = ?6,
               response_thinking = ?7, response_ttft_ms = ?8, response_latency_ms = ?9,
               response_error = ?10, input_tokens = ?11, output_tokens = ?12,
               cache_read_tokens = ?13, cache_write_tokens = ?14, reasoning_tokens = ?15,
               cost_usd = ?16, cost_known = ?17, ended_at = ?18, duration_ms = ?19,
               error = ?20
             WHERE id = ?21 AND status = 'running'",
            params![
                input.status.as_str(),
                input.model,
                input.response_status as i64,
                response_headers,
                input.finish_reason.map(|reason| reason.as_str()),
                input.response_text,
                input.response_thinking,
                input.ttft_ms.map(|value| value as i64),
                input.latency_ms as i64,
                input.error,
                input.usage.input_tokens as i64,
                input.usage.output_tokens as i64,
                input.usage.cache_read_tokens as i64,
                input.usage.cache_write_tokens as i64,
                input.usage.reasoning_tokens as i64,
                input.cost_usd,
                input.cost_known as i64,
                ended_at,
                input.latency_ms as i64,
                input.error,
                step_id,
            ],
        )?;

        let error_increment = if input.status == StepStatus::Failed {
            1
        } else {
            0
        };
        let unknown_cost_increment = if input.cost_known { 0 } else { 1 };
        transaction.execute(
            "UPDATE sessions SET
               step_count = step_count + 1,
               model_call_count = model_call_count + 1,
               tool_call_count = tool_call_count + ?1,
               input_tokens = input_tokens + ?2,
               output_tokens = output_tokens + ?3,
               cache_read_tokens = cache_read_tokens + ?4,
               cache_write_tokens = cache_write_tokens + ?5,
               reasoning_tokens = reasoning_tokens + ?6,
               total_cost_usd = total_cost_usd + ?7,
               unknown_cost_calls = unknown_cost_calls + ?8,
               error_count = error_count + ?9,
               model = COALESCE(?10, model)
             WHERE id = ?11",
            params![
                tool_call_count as i64,
                input.usage.input_tokens as i64,
                input.usage.output_tokens as i64,
                input.usage.cache_read_tokens as i64,
                input.usage.cache_write_tokens as i64,
                input.usage.reasoning_tokens as i64,
                input.cost_usd.unwrap_or(0.0),
                unknown_cost_increment,
                error_increment,
                input.model,
                session_id,
            ],
        )?;

        transaction.commit()?;
        drop(connection);

        self.get_step(step_id)
    }

    /// Insert a completed step reconstructed from an agent log.
    ///
    /// Tool calls are written in the same transaction, and the session totals
    /// are updated exactly once. No live event is emitted for historical data.
    pub fn insert_observed_step(&self, session_id: &str, input: ObservedStep) -> Result<Step> {
        let id = cockpit_core::ids::create_id();
        let request = &input.request;
        let request_headers = serde_json::to_string(&request.headers)?;
        let request_body = request
            .body
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let response = input.response.as_ref();
        let response_headers = match response {
            Some(response) => serde_json::to_string(&response.headers)?,
            None => "{}".to_string(),
        };
        let metadata = input
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let duration_ms = input.duration_ms.or_else(|| {
            input
                .ended_at
                .as_deref()
                .and_then(|ended_at| duration_between(&input.started_at, ended_at))
                .map(|value| value.max(0) as u64)
        });
        let is_model = input.kind == StepKind::Model;
        let model_call_increment = i64::from(is_model);
        let unknown_cost_increment = i64::from(is_model && !input.cost_known);
        let error_increment = i64::from(input.status == StepStatus::Failed);

        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let seq: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;

        transaction.execute(
            "INSERT INTO steps (
               id, session_id, seq, kind, status, provider, model, protocol, method, path,
               request_headers, request_body, request_stream, request_system_prompt,
               request_prompt_text, request_redaction_count, response_status, response_headers,
               response_finish_reason, response_text, response_thinking, response_ttft_ms,
               response_latency_ms, response_error, input_tokens, output_tokens,
               cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, cost_known,
               started_at, ended_at, duration_ms, error, metadata
             ) VALUES (
               :id, :session_id, :seq, :kind, :status, :provider, :model, :protocol, :method,
               :path, :request_headers, :request_body, :request_stream, :request_system_prompt,
               :request_prompt_text, :request_redaction_count, :response_status,
               :response_headers, :response_finish_reason, :response_text, :response_thinking,
               :response_ttft_ms, :response_latency_ms, :response_error, :input_tokens,
               :output_tokens, :cache_read_tokens, :cache_write_tokens, :reasoning_tokens,
               :cost_usd, :cost_known, :started_at, :ended_at, :duration_ms, :error, :metadata
             )",
            rusqlite::named_params! {
                ":id": id,
                ":session_id": session_id,
                ":seq": seq,
                ":kind": input.kind.as_str(),
                ":status": input.status.as_str(),
                ":provider": input.provider,
                ":model": input.model,
                ":protocol": request.protocol.as_str(),
                ":method": request.method,
                ":path": request.path,
                ":request_headers": request_headers,
                ":request_body": request_body,
                ":request_stream": request.stream as i64,
                ":request_system_prompt": request.system_prompt,
                ":request_prompt_text": request.prompt_text,
                ":request_redaction_count": request.redaction_count as i64,
                ":response_status": response.map(|response| response.status as i64),
                ":response_headers": response_headers,
                ":response_finish_reason": response
                    .and_then(|response| response.finish_reason)
                    .map(|reason| reason.as_str()),
                ":response_text": response.and_then(|response| response.text.clone()),
                ":response_thinking": response.and_then(|response| response.thinking.clone()),
                ":response_ttft_ms": response
                    .and_then(|response| response.ttft_ms)
                    .map(|value| value as i64),
                ":response_latency_ms": response
                    .and_then(|response| response.latency_ms)
                    .map(|value| value as i64),
                ":response_error": response.and_then(|response| response.error.clone()),
                ":input_tokens": input.usage.input_tokens as i64,
                ":output_tokens": input.usage.output_tokens as i64,
                ":cache_read_tokens": input.usage.cache_read_tokens as i64,
                ":cache_write_tokens": input.usage.cache_write_tokens as i64,
                ":reasoning_tokens": input.usage.reasoning_tokens as i64,
                ":cost_usd": input.cost_usd,
                ":cost_known": input.cost_known as i64,
                ":started_at": input.started_at,
                ":ended_at": input.ended_at,
                ":duration_ms": duration_ms.map(|value| value as i64),
                ":error": input.error,
                ":metadata": metadata,
            },
        )?;

        for call in &input.tool_calls {
            transaction.execute(
                "INSERT OR REPLACE INTO tool_calls
                   (id, session_id, step_id, provider_tool_call_id, name, status, input, output,
                    error, file_paths, started_at, ended_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    call.id,
                    session_id,
                    id,
                    call.provider_tool_call_id,
                    call.name,
                    call.status.as_str(),
                    call.input.as_ref().map(serde_json::to_string).transpose()?,
                    call.output
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    call.error,
                    serde_json::to_string(&call.file_paths)?,
                    call.started_at,
                    call.ended_at,
                ],
            )?;
        }

        transaction.execute(
            "UPDATE sessions SET
               step_count = step_count + 1,
               model_call_count = model_call_count + ?1,
               tool_call_count = tool_call_count + ?2,
               input_tokens = input_tokens + ?3,
               output_tokens = output_tokens + ?4,
               cache_read_tokens = cache_read_tokens + ?5,
               cache_write_tokens = cache_write_tokens + ?6,
               reasoning_tokens = reasoning_tokens + ?7,
               total_cost_usd = total_cost_usd + ?8,
               unknown_cost_calls = unknown_cost_calls + ?9,
               error_count = error_count + ?10,
               model = COALESCE(?11, model)
             WHERE id = ?12",
            params![
                model_call_increment,
                input.tool_calls.len() as i64,
                input.usage.input_tokens as i64,
                input.usage.output_tokens as i64,
                input.usage.cache_read_tokens as i64,
                input.usage.cache_write_tokens as i64,
                input.usage.reasoning_tokens as i64,
                input.cost_usd.unwrap_or(0.0),
                unknown_cost_increment,
                error_increment,
                input.model,
                session_id,
            ],
        )?;

        transaction.commit()?;
        drop(connection);

        self.get_step(&id)?
            .ok_or_else(|| DaemonError::other("observed step disappeared after insert"))
    }

    /// Attach a tool result that arrived after its tool call was stored.
    pub fn update_tool_call_output(
        &self,
        session_id: &str,
        provider_tool_call_id: &str,
        output: Option<Value>,
        error: Option<String>,
        ended_at: Option<String>,
    ) -> Result<bool> {
        let status = if error.is_some() {
            ToolCallStatus::Failed
        } else {
            ToolCallStatus::Completed
        };
        let output = output.as_ref().map(serde_json::to_string).transpose()?;
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE tool_calls SET output = ?1, error = ?2, status = ?3, ended_at = ?4
             WHERE session_id = ?5 AND provider_tool_call_id = ?6",
            params![
                output,
                error,
                status.as_str(),
                ended_at,
                session_id,
                provider_tool_call_id,
            ],
        )?;
        Ok(changed > 0)
    }

    /// Mark an observed flight as finished and keep its latest log timestamp.
    pub fn finish_observed_session(&self, session_id: &str, ended_at: &str) -> Result<()> {
        let Some(session) = self.get_session(session_id)? else {
            return Ok(());
        };
        let duration_ms = duration_between(&session.started_at, ended_at);
        let connection = self.lock()?;
        connection.execute(
            "UPDATE sessions SET status = 'completed', ended_at = ?1, duration_ms = ?2
             WHERE id = ?3 AND source IN ('log_watch', 'hook_otel')",
            params![ended_at, duration_ms, session_id],
        )?;
        Ok(())
    }

    /// Reopen an observed flight when its log starts growing again.
    pub fn mark_observed_active(&self, session_id: &str) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE sessions SET status = 'active', ended_at = NULL, duration_ms = NULL
             WHERE id = ?1 AND source IN ('log_watch', 'hook_otel')",
            params![session_id],
        )?;
        Ok(())
    }

    /// Fill in session details that only become clear after a log is parsed.
    pub fn update_observed_session(
        &self,
        session_id: &str,
        title: Option<&str>,
        workspace_path: Option<&str>,
        git_branch: Option<&str>,
        model: Option<&str>,
    ) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE sessions SET
               title = COALESCE(?1, title),
               workspace_path = COALESCE(?2, workspace_path),
               git_branch = COALESCE(?3, git_branch),
               model = COALESCE(?4, model)
             WHERE id = ?5 AND source IN ('log_watch', 'hook_otel')",
            params![title, workspace_path, git_branch, model, session_id],
        )?;
        Ok(())
    }

    pub fn get_step(&self, id: &str) -> Result<Option<Step>> {
        let connection = self.lock()?;
        let step = connection
            .query_row(
                &format!("SELECT {STEP_COLUMNS} FROM steps WHERE id = ?1"),
                params![id],
                row_to_step,
            )
            .optional()?;
        Ok(step)
    }

    pub fn list_steps(&self, session_id: &str, limit: u32) -> Result<Vec<Step>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {STEP_COLUMNS} FROM steps WHERE session_id = ?1 ORDER BY seq ASC LIMIT ?2"
        ))?;
        let rows = statement.query_map(params![session_id, limit], row_to_step)?;
        let mut steps = Vec::new();
        for row in rows {
            steps.push(row?);
        }
        Ok(steps)
    }

    pub fn insert_redactions(&self, step_id: &str, rows: &[RedactionRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        for row in rows {
            transaction.execute(
                "INSERT INTO redactions (step_id, rule_id, label, location, occurrences)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(step_id, rule_id, label, location)
                 DO UPDATE SET occurrences = occurrences + excluded.occurrences",
                params![
                    step_id,
                    row.rule_id,
                    row.label,
                    row.location.as_str(),
                    row.occurrences as i64
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_redactions(&self, step_id: &str) -> Result<Vec<RedactionRow>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT rule_id, label, location, occurrences FROM redactions WHERE step_id = ?1 ORDER BY label ASC",
        )?;
        let rows = statement.query_map(params![step_id], |row| {
            Ok(RedactionRow {
                rule_id: row.get(0)?,
                label: row.get(1)?,
                location: CaptureLocation::parse(&row.get::<_, String>(2)?)
                    .unwrap_or(CaptureLocation::RequestBody),
                occurrences: row.get::<_, i64>(3)? as u64,
            })
        })?;
        let mut redactions = Vec::new();
        for row in rows {
            redactions.push(row?);
        }
        Ok(redactions)
    }

    pub fn insert_stream_chunks(&self, chunks: &[StreamChunk]) -> Result<()> {
        if chunks.is_empty() {
            return Ok(());
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        for chunk in chunks {
            transaction.execute(
                "INSERT OR REPLACE INTO stream_chunks
                   (id, step_id, seq, kind, data, delta_text, received_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    chunk.id,
                    chunk.step_id,
                    chunk.seq as i64,
                    chunk.kind.as_str(),
                    chunk.data,
                    chunk.delta_text,
                    chunk.received_at
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_stream_chunks(&self, step_id: &str) -> Result<Vec<StreamChunk>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, step_id, seq, kind, data, delta_text, received_at
             FROM stream_chunks WHERE step_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = statement.query_map(params![step_id], |row| {
            Ok(StreamChunk {
                id: row.get(0)?,
                step_id: row.get(1)?,
                seq: row.get::<_, i64>(2)? as u64,
                kind: StreamChunkKind::parse(&row.get::<_, String>(3)?)
                    .unwrap_or(StreamChunkKind::Event),
                data: row.get(4)?,
                delta_text: row.get(5)?,
                received_at: row.get(6)?,
            })
        })?;
        let mut chunks = Vec::new();
        for row in rows {
            chunks.push(row?);
        }
        Ok(chunks)
    }

    pub fn insert_tool_calls(&self, calls: &[ToolCall]) -> Result<()> {
        if calls.is_empty() {
            return Ok(());
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        for call in calls {
            transaction.execute(
                "INSERT OR REPLACE INTO tool_calls
                   (id, session_id, step_id, provider_tool_call_id, name, status, input, output,
                    error, file_paths, started_at, ended_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    call.id,
                    call.session_id,
                    call.step_id,
                    call.provider_tool_call_id,
                    call.name,
                    call.status.as_str(),
                    call.input.as_ref().map(serde_json::to_string).transpose()?,
                    call.output
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    call.error,
                    serde_json::to_string(&call.file_paths)?,
                    call.started_at,
                    call.ended_at
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_tool_calls(&self, step_id: &str) -> Result<Vec<ToolCall>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, session_id, step_id, provider_tool_call_id, name, status, input, output,
                    error, file_paths, started_at, ended_at
             FROM tool_calls WHERE step_id = ?1 ORDER BY started_at ASC",
        )?;
        let rows = statement.query_map(params![step_id], |row| {
            let input: Option<String> = row.get(6)?;
            let output: Option<String> = row.get(7)?;
            let file_paths: String = row.get(9)?;
            Ok(ToolCall {
                id: row.get(0)?,
                session_id: row.get(1)?,
                step_id: row.get(2)?,
                provider_tool_call_id: row.get(3)?,
                name: row.get(4)?,
                status: ToolCallStatus::parse(&row.get::<_, String>(5)?)
                    .unwrap_or(ToolCallStatus::Completed),
                input: input.and_then(|value| serde_json::from_str(&value).ok()),
                output: output.and_then(|value| serde_json::from_str(&value).ok()),
                error: row.get(8)?,
                file_paths: serde_json::from_str(&file_paths).unwrap_or_default(),
                started_at: row.get(10)?,
                ended_at: row.get(11)?,
            })
        })?;
        let mut calls = Vec::new();
        for row in rows {
            calls.push(row?);
        }
        Ok(calls)
    }

    pub fn insert_live_event(&self, event: &LiveEvent) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO live_events (type, at, session_id, step_id, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                event.event_type,
                event.at,
                event.session_id,
                event.step_id,
                serde_json::to_string(&event.payload)?
            ],
        )?;
        Ok(())
    }

    pub fn max_live_sequence(&self) -> Result<u64> {
        let connection = self.lock()?;
        let sequence: i64 = connection.query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM live_events",
            [],
            |row| row.get(0),
        )?;
        Ok(sequence as u64)
    }

    pub fn recent_live_events(&self, limit: u32) -> Result<Vec<LiveEvent>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT sequence, type, at, session_id, step_id, payload
             FROM live_events ORDER BY sequence DESC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit], |row| {
            let payload: String = row.get(5)?;
            Ok(LiveEvent {
                sequence: row.get::<_, i64>(0)? as u64,
                event_type: row.get(1)?,
                at: row.get(2)?,
                session_id: row.get(3)?,
                step_id: row.get(4)?,
                payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
            })
        })?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        events.reverse();
        Ok(events)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let connection = self.lock()?;
        let value = connection
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn all_settings(&self) -> Result<BTreeMap<String, String>> {
        let connection = self.lock()?;
        let mut statement =
            connection.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut settings = BTreeMap::new();
        for row in rows {
            let (key, value) = row?;
            settings.insert(key, value);
        }
        Ok(settings)
    }

    /// Delete sessions older than the retention window. Steps, chunks, and tool
    /// calls cascade. Returns the number of removed sessions.
    pub fn prune_sessions(&self, older_than_iso: &str) -> Result<u64> {
        let connection = self.lock()?;
        let removed = connection.execute(
            "DELETE FROM sessions WHERE started_at < ?1",
            params![older_than_iso],
        )?;
        Ok(removed as u64)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| DaemonError::other("database lock was poisoned"))
    }
}

const SESSION_COLUMNS: &str = "id, title, source, capture_mode, source_label, status, protocol,
    provider, model, agent_name, agent_version, agent_user_agent, agent_detected_from,
    workspace_path, git_branch, git_base_commit, started_at, ended_at, duration_ms,
    step_count, model_call_count, tool_call_count, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, reasoning_tokens, total_cost_usd,
    unknown_cost_calls, error_count, tags, metadata";

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    let agent_name: Option<String> = row.get(9)?;
    let agent_version: Option<String> = row.get(10)?;
    let agent_user_agent: Option<String> = row.get(11)?;
    let agent_detected_from: Option<String> = row.get(12)?;
    let agent =
        if agent_name.is_some() || agent_user_agent.is_some() || agent_detected_from.is_some() {
            Some(AgentInfo {
                name: agent_name,
                version: agent_version,
                user_agent: agent_user_agent,
                detected_from: agent_detected_from
                    .as_deref()
                    .and_then(parse_detected_from)
                    .unwrap_or_default(),
            })
        } else {
            None
        };

    let tags: String = row.get(30)?;
    let metadata: Option<String> = row.get(31)?;

    Ok(Session {
        id: row.get(0)?,
        title: row.get(1)?,
        source: SessionSource::parse(&row.get::<_, String>(2)?).unwrap_or_default(),
        capture_mode: CaptureMode::parse(&row.get::<_, String>(3)?).unwrap_or_default(),
        source_label: row.get(4)?,
        status: SessionStatus::parse(&row.get::<_, String>(5)?).unwrap_or(SessionStatus::Active),
        protocol: row
            .get::<_, Option<String>>(6)?
            .as_deref()
            .and_then(ProviderProtocol::parse),
        provider: row.get(7)?,
        model: row.get(8)?,
        agent,
        workspace_path: row.get(13)?,
        git_branch: row.get(14)?,
        git_base_commit: row.get(15)?,
        started_at: row.get(16)?,
        ended_at: row.get(17)?,
        duration_ms: row.get::<_, Option<i64>>(18)?.map(|value| value as u64),
        totals: SessionTotals {
            step_count: row.get::<_, i64>(19)? as u64,
            model_call_count: row.get::<_, i64>(20)? as u64,
            tool_call_count: row.get::<_, i64>(21)? as u64,
            input_tokens: row.get::<_, i64>(22)? as u64,
            output_tokens: row.get::<_, i64>(23)? as u64,
            cache_read_tokens: row.get::<_, i64>(24)? as u64,
            cache_write_tokens: row.get::<_, i64>(25)? as u64,
            reasoning_tokens: row.get::<_, i64>(26)? as u64,
            total_cost_usd: row.get(27)?,
            unknown_cost_calls: row.get::<_, i64>(28)? as u64,
            error_count: row.get::<_, i64>(29)? as u64,
        },
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        metadata: metadata.and_then(|value| serde_json::from_str(&value).ok()),
    })
}

const STEP_COLUMNS: &str = "id, session_id, parent_step_id, seq, kind, status, provider, model,
    protocol, method, path, request_headers, request_body, request_stream,
    request_system_prompt, request_prompt_text, request_redaction_count,
    response_status, response_headers, response_finish_reason, response_text,
    response_thinking, response_ttft_ms, response_latency_ms, response_error,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
    cost_usd, cost_known, started_at, ended_at, duration_ms, error, metadata";

fn row_to_step(row: &rusqlite::Row<'_>) -> rusqlite::Result<Step> {
    let protocol: Option<String> = row.get(8)?;
    let method: Option<String> = row.get(9)?;
    let request = match (protocol.as_deref(), method) {
        (Some(protocol), Some(method)) => {
            let headers: Option<String> = row.get(11)?;
            let body: Option<String> = row.get(12)?;
            Some(CapturedRequest {
                protocol: ProviderProtocol::parse(protocol).unwrap_or(ProviderProtocol::Openai),
                method,
                path: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
                model: row.get(7)?,
                stream: row.get::<_, i64>(13)? != 0,
                headers: headers
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or_default(),
                body: body.and_then(|value| serde_json::from_str(&value).ok()),
                system_prompt: row.get(14)?,
                prompt_text: row.get(15)?,
                redaction_count: row.get::<_, i64>(16)? as u64,
            })
        }
        _ => None,
    };

    let response_status: Option<i64> = row.get(17)?;
    let response = match response_status {
        Some(status) => {
            let headers: Option<String> = row.get(18)?;
            Some(CapturedResponse {
                status: status as u16,
                headers: headers
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or_default(),
                finish_reason: row
                    .get::<_, Option<String>>(19)?
                    .as_deref()
                    .and_then(FinishReason::parse),
                text: row.get(20)?,
                thinking: row.get(21)?,
                usage: TokenUsage {
                    input_tokens: row.get::<_, i64>(25).unwrap_or(0) as u64,
                    output_tokens: row.get::<_, i64>(26).unwrap_or(0) as u64,
                    cache_read_tokens: row.get::<_, i64>(27).unwrap_or(0) as u64,
                    cache_write_tokens: row.get::<_, i64>(28).unwrap_or(0) as u64,
                    reasoning_tokens: row.get::<_, i64>(29).unwrap_or(0) as u64,
                },
                ttft_ms: row.get::<_, Option<i64>>(22)?.map(|value| value as u64),
                latency_ms: row.get::<_, Option<i64>>(23)?.map(|value| value as u64),
                error: row.get(24)?,
            })
        }
        None => None,
    };

    let metadata: Option<String> = row.get(36)?;

    Ok(Step {
        id: row.get(0)?,
        session_id: row.get(1)?,
        parent_step_id: row.get(2)?,
        seq: row.get::<_, i64>(3)? as u64,
        kind: StepKind::parse(&row.get::<_, String>(4)?).unwrap_or(StepKind::Model),
        status: StepStatus::parse(&row.get::<_, String>(5)?).unwrap_or(StepStatus::Running),
        provider: row.get(6)?,
        model: row.get(7)?,
        request,
        response,
        usage: TokenUsage {
            input_tokens: row.get::<_, i64>(25)? as u64,
            output_tokens: row.get::<_, i64>(26)? as u64,
            cache_read_tokens: row.get::<_, i64>(27)? as u64,
            cache_write_tokens: row.get::<_, i64>(28)? as u64,
            reasoning_tokens: row.get::<_, i64>(29)? as u64,
        },
        cost_usd: row.get(30)?,
        cost_known: row.get::<_, i64>(31)? != 0,
        started_at: row.get(32)?,
        ended_at: row.get(33)?,
        duration_ms: row.get::<_, Option<i64>>(34)?.map(|value| value as u64),
        error: row.get(35)?,
        metadata: metadata.and_then(|value| serde_json::from_str(&value).ok()),
    })
}

fn detected_from_str(value: DetectedFrom) -> &'static str {
    match value {
        DetectedFrom::Headers => "headers",
        DetectedFrom::Wrapper => "wrapper",
        DetectedFrom::Manual => "manual",
        DetectedFrom::Demo => "demo",
        DetectedFrom::LogWatch => "log_watch",
        DetectedFrom::Hook => "hook",
        DetectedFrom::Unknown => "unknown",
    }
}

fn parse_detected_from(value: &str) -> Option<DetectedFrom> {
    match value {
        "headers" => Some(DetectedFrom::Headers),
        "wrapper" => Some(DetectedFrom::Wrapper),
        "manual" => Some(DetectedFrom::Manual),
        "demo" => Some(DetectedFrom::Demo),
        "log_watch" => Some(DetectedFrom::LogWatch),
        "hook" => Some(DetectedFrom::Hook),
        "unknown" => Some(DetectedFrom::Unknown),
        _ => None,
    }
}

fn duration_between(started_at: &str, ended_at: &str) -> Option<i64> {
    let start = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(ended_at).ok()?;
    Some((end - start).num_milliseconds().max(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::model::SessionSource;

    fn store() -> Store {
        Store::open(":memory:").unwrap()
    }

    fn session(store: &Store) -> Session {
        store
            .create_session(NewSession {
                title: "Test flight".to_string(),
                source: SessionSource::Proxy,
                capture_mode: CaptureMode::Proxy,
                ..NewSession::default()
            })
            .unwrap()
    }

    fn request(protocol: ProviderProtocol) -> CapturedRequest {
        CapturedRequest {
            protocol,
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            model: Some("gpt-4.1".to_string()),
            stream: false,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: Some(serde_json::json!({ "model": "gpt-4.1" })),
            system_prompt: None,
            prompt_text: Some("Hello".to_string()),
            redaction_count: 0,
        }
    }

    #[test]
    fn creates_and_lists_sessions() {
        let store = store();
        let session = session(&store);
        assert_eq!(session.status, SessionStatus::Active);
        assert_eq!(session.totals.step_count, 0);

        let sessions = store.list_sessions(10, 0, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, session.id);

        let overview = store.overview().unwrap();
        assert_eq!(overview.session_count, 1);
        assert_eq!(overview.active_session_count, 1);
    }

    #[test]
    fn completes_steps_and_updates_totals() {
        let store = store();
        let session = session(&store);
        let step = store
            .begin_step(BeginStep {
                session_id: session.id.clone(),
                kind: StepKind::Model,
                provider: Some("openai".to_string()),
                model: Some("gpt-4.1".to_string()),
                request: request(ProviderProtocol::Openai),
            })
            .unwrap();
        assert_eq!(step.seq, 1);
        assert_eq!(step.status, StepStatus::Running);

        let completed = store
            .complete_step(
                &step.id,
                CompleteStep {
                    status: StepStatus::Completed,
                    response_status: 200,
                    response_headers: BTreeMap::new(),
                    response_text: Some("Hi".to_string()),
                    response_thinking: None,
                    finish_reason: Some(FinishReason::Stop),
                    usage: TokenUsage {
                        input_tokens: 10,
                        output_tokens: 2,
                        ..TokenUsage::ZERO
                    },
                    cost_usd: Some(0.001),
                    cost_known: true,
                    model: Some("gpt-4.1".to_string()),
                    error: None,
                    ttft_ms: Some(12),
                    latency_ms: 40,
                },
                1,
            )
            .unwrap()
            .unwrap();

        assert_eq!(completed.status, StepStatus::Completed);
        assert_eq!(completed.usage.input_tokens, 10);
        assert_eq!(completed.response.as_ref().unwrap().status, 200);

        let session = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(session.totals.step_count, 1);
        assert_eq!(session.totals.input_tokens, 10);
        assert_eq!(session.totals.tool_call_count, 1);
        assert_eq!(session.totals.total_cost_usd, 0.001);

        let overview = store.overview().unwrap();
        assert_eq!(overview.step_count, 1);
        assert_eq!(overview.total_cost_usd, 0.001);
    }

    #[test]
    fn complete_step_is_idempotent() {
        let store = store();
        let session = session(&store);
        let step = store
            .begin_step(BeginStep {
                session_id: session.id.clone(),
                kind: StepKind::Model,
                provider: None,
                model: None,
                request: request(ProviderProtocol::Openai),
            })
            .unwrap();
        let complete = CompleteStep {
            status: StepStatus::Completed,
            response_status: 200,
            response_headers: BTreeMap::new(),
            response_text: None,
            response_thinking: None,
            finish_reason: None,
            usage: TokenUsage::ZERO,
            cost_usd: None,
            cost_known: false,
            model: None,
            error: None,
            ttft_ms: None,
            latency_ms: 1,
        };
        assert!(
            store
                .complete_step(&step.id, complete.clone(), 0)
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .complete_step(&step.id, complete, 0)
                .unwrap()
                .is_none()
        );
        let session = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(session.totals.step_count, 1);
        assert_eq!(session.totals.unknown_cost_calls, 1);
    }

    #[test]
    fn stores_redactions_chunks_and_tool_calls() {
        let store = store();
        let session = session(&store);
        let step = store
            .begin_step(BeginStep {
                session_id: session.id.clone(),
                kind: StepKind::Model,
                provider: None,
                model: None,
                request: request(ProviderProtocol::Openai),
            })
            .unwrap();

        store
            .insert_redactions(
                &step.id,
                &[RedactionRow {
                    rule_id: "sensitive-header".to_string(),
                    label: "Sensitive header: authorization".to_string(),
                    location: CaptureLocation::RequestHeaders,
                    occurrences: 1,
                }],
            )
            .unwrap();
        store
            .insert_stream_chunks(&[StreamChunk {
                id: cockpit_core::ids::create_id(),
                step_id: step.id.clone(),
                seq: 0,
                kind: StreamChunkKind::Text,
                data: "data: hi".to_string(),
                delta_text: Some("hi".to_string()),
                received_at: now_iso(),
            }])
            .unwrap();
        store
            .insert_tool_calls(&[ToolCall {
                id: cockpit_core::ids::create_id(),
                session_id: session.id.clone(),
                step_id: Some(step.id.clone()),
                provider_tool_call_id: Some("call_1".to_string()),
                name: "read_file".to_string(),
                status: ToolCallStatus::Completed,
                input: Some(serde_json::json!({ "path": "src/main.rs" })),
                output: None,
                error: None,
                file_paths: vec!["src/main.rs".to_string()],
                started_at: now_iso(),
                ended_at: None,
            }])
            .unwrap();

        assert_eq!(store.list_redactions(&step.id).unwrap().len(), 1);
        assert_eq!(store.list_stream_chunks(&step.id).unwrap().len(), 1);
        assert_eq!(
            store.list_tool_calls(&step.id).unwrap()[0].name,
            "read_file"
        );
    }

    #[test]
    fn stores_and_reads_settings() {
        let store = store();
        assert_eq!(store.get_setting("theme").unwrap(), None);
        store.set_setting("theme", "glass").unwrap();
        store.set_setting("theme", "dark").unwrap();
        assert_eq!(store.get_setting("theme").unwrap().as_deref(), Some("dark"));
        assert_eq!(store.all_settings().unwrap().len(), 1);
    }

    #[test]
    fn persists_live_events_with_sequences() {
        let store = store();
        store
            .insert_live_event(&LiveEvent {
                sequence: 1,
                event_type: "session.started".to_string(),
                at: now_iso(),
                session_id: Some("abc".to_string()),
                step_id: None,
                payload: serde_json::json!({ "title": "Hi" }),
            })
            .unwrap();
        assert_eq!(store.max_live_sequence().unwrap(), 1);
        let events = store.recent_live_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "session.started");
    }

    #[test]
    fn refuses_to_open_a_legacy_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cockpit.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta VALUES ('schema_version', '1');
                 CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT);",
            )
            .unwrap();
        drop(connection);

        let error = match Store::open(&path) {
            Ok(_) => panic!("the legacy database should be refused"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("0.1.0"));
    }
}
