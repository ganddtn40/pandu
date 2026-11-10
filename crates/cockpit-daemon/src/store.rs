use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use cockpit_core::agent::{AgentEvent, AgentEventInput, AgentEventStatus, AgentEventType};
use cockpit_core::guard::{
    BudgetEnforcement, BudgetPeriod, BudgetPolicy, BudgetPolicyInput, BudgetPolicyPatch,
    BudgetScope, GuardAction, GuardEvent, GuardEventListQuery, GuardEventStatus, GuardEvidence,
    GuardRule, GuardRuleInput, GuardRuleKind, GuardRulePatch, GuardRuleSource, GuardSeverity,
};
use cockpit_core::model::{
    CaptureMode, CapturedRequest, CapturedResponse, FinishReason, LiveEvent, Session,
    SessionSource, SessionStatus, SessionTotals, Step, StepKind, StepStatus, StreamChunk,
    StreamChunkKind, ToolCall, ToolCallStatus,
};
use cockpit_core::provider::{AgentInfo, DetectedFrom, ProviderProtocol};
use cockpit_core::redact::{CaptureLocation, RedactionRow};
use cockpit_core::replay::{FileChangeType, ReplayFileChange, ReplaySnapshot, SnapshotKind};
use cockpit_core::usage::TokenUsage;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{DaemonError, Result};

pub const SCHEMA_VERSION: u32 = 4;

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

CREATE TABLE IF NOT EXISTS guard_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guard_rules_priority ON guard_rules(priority, id);

CREATE TABLE IF NOT EXISTS guard_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES steps(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  command TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  requested_at TEXT NOT NULL,
  approval_nonce TEXT,
  approval_expires_at TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_guard_events_session ON guard_events(session_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_guard_events_status ON guard_events(status, requested_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_events_status ON agent_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS budget_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  limit_usd REAL NOT NULL,
  enforcement TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES steps(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  commit_sha TEXT,
  parent_commit_sha TEXT,
  branch TEXT,
  worktree_path TEXT,
  patch TEXT,
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_git_snapshots_session ON git_snapshots(session_id, created_at);

CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES git_snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  old_path TEXT,
  change_type TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  diff TEXT,
  ai_authored INTEGER
);

CREATE INDEX IF NOT EXISTS idx_file_changes_snapshot ON file_changes(snapshot_id, path);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Phase 7 remote access. Tokens are only ever stored as SHA-256 hashes; the
-- audit table is append-only at the API layer and never contains prompt text.
CREATE TABLE IF NOT EXISTS remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  pin_salt TEXT,
  pin_hash TEXT,
  scopes TEXT NOT NULL DEFAULT '["view:status"]',
  require_host_confirmation INTEGER NOT NULL DEFAULT 1,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  respond_locked_at TEXT,
  expires_at TEXT,
  previous_token_hash TEXT,
  previous_token_expires_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_remote_devices_created ON remote_devices(created_at DESC);

CREATE TABLE IF NOT EXISTS remote_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  device_id TEXT,
  device_name TEXT,
  ip TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  size_bytes INTEGER,
  content_hash TEXT,
  prev_hash TEXT,
  entry_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_remote_audit_at ON remote_audit(at DESC);
CREATE INDEX IF NOT EXISTS idx_remote_audit_event ON remote_audit(event, at DESC);
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
    /// Recorder-owned metadata (context meter, model override). This never
    /// alters the recorded request or response.
    pub metadata: Option<Value>,
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

#[derive(Debug, Clone)]
pub struct NewGuardEvent {
    pub session_id: String,
    pub step_id: Option<String>,
    pub rule_id: String,
    pub kind: GuardRuleKind,
    pub action: GuardAction,
    pub severity: GuardSeverity,
    pub status: GuardEventStatus,
    pub title: String,
    pub description: String,
    pub command: Option<String>,
    pub evidence: Vec<GuardEvidence>,
    pub metadata: Option<Value>,
    /// Filled by `GuardService::record_event` for pending approvals.
    pub approval_nonce: Option<String>,
    pub approval_expires_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct GuardEventPatch {
    pub status: Option<GuardEventStatus>,
    pub resolved_at: Option<String>,
    pub resolved_by: Option<String>,
    pub resolution_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRedactionRow {
    pub step_id: String,
    pub rule_id: String,
    pub label: String,
    pub location: CaptureLocation,
    pub occurrences: u64,
}

#[derive(Debug, Clone)]
pub struct NewFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub change_type: FileChangeType,
    pub additions: u64,
    pub deletions: u64,
    pub diff: Option<String>,
    pub ai_authored: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct NewSnapshot {
    pub session_id: String,
    pub step_id: Option<String>,
    pub kind: SnapshotKind,
    pub commit_sha: Option<String>,
    pub parent_commit_sha: Option<String>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub patch: Option<String>,
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
    pub created_at: Option<String>,
    pub file_changes: Vec<NewFileChange>,
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

/// Bring an older database up to the current schema. `SCHEMA` already creates
/// any missing tables, so this only adds columns that `CREATE TABLE IF NOT
/// EXISTS` cannot add to an existing table.
fn migrate_schema(connection: &Connection, from: u32) -> Result<()> {
    if from < 2 {
        add_column_if_missing(connection, "guard_events", "approval_nonce", "TEXT")?;
        add_column_if_missing(connection, "guard_events", "approval_expires_at", "TEXT")?;
    }
    if from < 4 {
        add_column_if_missing(
            connection,
            "remote_devices",
            "pin_failures",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(connection, "remote_devices", "respond_locked_at", "TEXT")?;
        add_column_if_missing(connection, "remote_devices", "expires_at", "TEXT")?;
        add_column_if_missing(connection, "remote_devices", "previous_token_hash", "TEXT")?;
        add_column_if_missing(
            connection,
            "remote_devices",
            "previous_token_expires_at",
            "TEXT",
        )?;
        add_column_if_missing(connection, "remote_audit", "prev_hash", "TEXT")?;
        add_column_if_missing(connection, "remote_audit", "entry_hash", "TEXT")?;
    }
    Ok(())
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    if columns.iter().any(|existing| existing == column) {
        return Ok(());
    }
    connection.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition}"
    ))?;
    Ok(())
}

/// Seal audit rows written before the hash chain existed.
///
/// The whole table is hashed in rowid (insertion) order inside one immediate
/// transaction. The `audit_chain` marker is written in the same transaction, so
/// a crash leaves either the old unsealed state or a complete chain. Re-running
/// the migration is deterministic, but it only runs while the marker is absent.
fn backfill_remote_audit_hashes(connection: &mut Connection) -> Result<()> {
    let marked: Option<String> = connection
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'audit_chain'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if marked.as_deref() == Some("1") {
        return Ok(());
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let entries = {
        let mut statement = transaction.prepare(
            "SELECT id, at, event, device_id, device_name, ip, detail, size_bytes, content_hash
             FROM remote_audit ORDER BY rowid ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(AuditHashFields {
                id: row.get(0)?,
                at: row.get(1)?,
                event: row.get(2)?,
                device_id: row.get(3)?,
                device_name: row.get(4)?,
                ip: row.get(5)?,
                detail: row.get(6)?,
                size_bytes: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
                content_hash: row.get(8)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let mut previous: Option<String> = None;
    for entry in entries {
        let entry_hash = audit_entry_hash(previous.as_deref(), &entry);
        transaction.execute(
            "UPDATE remote_audit SET prev_hash = ?1, entry_hash = ?2 WHERE id = ?3",
            params![previous, entry_hash, entry.id],
        )?;
        previous = Some(entry_hash);
    }
    transaction.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('audit_chain', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

/// The exact fields covered by an audit entry's hash.
///
/// `detail` is the raw JSON string stored in the database, not a re-serialized
/// value, so reformatting or reordering the JSON is tampering too.
struct AuditHashFields {
    id: String,
    at: String,
    event: String,
    device_id: Option<String>,
    device_name: Option<String>,
    ip: Option<String>,
    detail: String,
    size_bytes: Option<u64>,
    content_hash: Option<String>,
}

/// SHA-256 over a fixed domain tag and length-prefixed fields.
///
/// Length prefixes make the encoding unambiguous: moving bytes between fields
/// or embedding separators cannot produce the same digest.
fn audit_entry_hash(prev_hash: Option<&str>, entry: &AuditHashFields) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"cockpit-remote-audit-v1");
    hash_optional_field(&mut hasher, prev_hash);
    hash_optional_field(&mut hasher, Some(entry.id.as_str()));
    hash_optional_field(&mut hasher, Some(entry.at.as_str()));
    hash_optional_field(&mut hasher, Some(entry.event.as_str()));
    hash_optional_field(&mut hasher, entry.device_id.as_deref());
    hash_optional_field(&mut hasher, entry.device_name.as_deref());
    hash_optional_field(&mut hasher, entry.ip.as_deref());
    hash_optional_field(&mut hasher, Some(entry.detail.as_str()));
    match entry.size_bytes {
        Some(value) => {
            hasher.update([1u8]);
            hasher.update(value.to_be_bytes());
        }
        None => hasher.update([0u8]),
    }
    hash_optional_field(&mut hasher, entry.content_hash.as_deref());
    hex_string(&hasher.finalize())
}

fn hash_optional_field(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hasher.update([1u8]);
            hasher.update((value.len() as u64).to_be_bytes());
            hasher.update(value.as_bytes());
        }
        None => hasher.update([0u8]),
    }
}

fn hex_string(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
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

        let mut connection = Connection::open(path)?;
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
                if version < SCHEMA_VERSION {
                    migrate_schema(&connection, version)?;
                    connection.execute(
                        "UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'",
                        params![SCHEMA_VERSION.to_string()],
                    )?;
                }
            }
            None => {
                migrate_schema(&connection, 0)?;
                connection.execute(
                    "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?1)",
                    params![SCHEMA_VERSION.to_string()],
                )?;
            }
        }

        // Audit rows written before the hash chain existed have no hashes.
        // Seal them once, in insertion order, before the store accepts new
        // writes. The marker makes the migration one-shot: a later edit that
        // deletes a hash is evidence, not something the next open silently
        // repairs.
        backfill_remote_audit_hashes(&mut connection)?;

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

    /// One-based creation order for a session. Remote status views use this to
    /// label a flight without exposing its prompt-derived title.
    pub fn session_ordinal(&self, id: &str) -> Result<Option<u64>> {
        let connection = self.lock()?;
        let ordinal: Option<i64> = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM sessions WHERE rowid <= s.rowid)
                 FROM sessions s WHERE s.id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(ordinal.map(|value| value.max(0) as u64))
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

    /// Move a session's recorded window into the past.
    ///
    /// Demo seeding creates rows through the normal write path (so every
    /// invariant holds), then rewrites the timestamps so the demo does not
    /// pretend three flights all started in the same second.
    pub fn backdate_session(
        &self,
        id: &str,
        started_at: &str,
        ended_at: Option<&str>,
    ) -> Result<()> {
        let duration = ended_at.and_then(|end| duration_between(started_at, end));
        self.lock()?.execute(
            "UPDATE sessions SET started_at = ?1, ended_at = ?2, duration_ms = ?3 WHERE id = ?4",
            params![started_at, ended_at, duration, id],
        )?;
        Ok(())
    }

    /// Move a step's recorded window into the past and keep its duration honest.
    pub fn backdate_step(&self, id: &str, started_at: &str, ended_at: Option<&str>) -> Result<()> {
        let duration = ended_at.and_then(|end| duration_between(started_at, end));
        self.lock()?.execute(
            "UPDATE steps SET started_at = ?1, ended_at = ?2, duration_ms = ?3 WHERE id = ?4",
            params![started_at, ended_at, duration, id],
        )?;
        Ok(())
    }

    /// Move a guard event's request time into the past.
    pub fn backdate_guard_event(&self, id: &str, requested_at: &str) -> Result<()> {
        self.lock()?.execute(
            "UPDATE guard_events SET requested_at = ?1 WHERE id = ?2",
            params![requested_at, id],
        )?;
        Ok(())
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
        let metadata = input
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        transaction.execute(
            "UPDATE steps SET
               status = ?1, model = COALESCE(?2, model), response_status = ?3,
               response_headers = ?4, response_finish_reason = ?5, response_text = ?6,
               response_thinking = ?7, response_ttft_ms = ?8, response_latency_ms = ?9,
               response_error = ?10, input_tokens = ?11, output_tokens = ?12,
               cache_read_tokens = ?13, cache_write_tokens = ?14, reasoning_tokens = ?15,
               cost_usd = ?16, cost_known = ?17, ended_at = ?18, duration_ms = ?19,
               error = ?20, metadata = COALESCE(?22, metadata)
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
                metadata,
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

    /// The context size recorded for the most recent earlier step in a flight.
    /// Steps without a context meter (log imports, tool-only steps) are skipped
    /// so compaction detection still finds the last real model request.
    pub fn previous_context_tokens(
        &self,
        session_id: &str,
        before_seq: u64,
    ) -> Result<Option<u64>> {
        Ok(self
            .previous_context(session_id, before_seq)?
            .and_then(|context| context.get("tokens").and_then(Value::as_u64)))
    }

    /// Whether the previous step was already above the context threshold, used
    /// to avoid firing `context.high` on every request in a long flight.
    pub fn previous_context_high(&self, session_id: &str, before_seq: u64) -> Result<bool> {
        Ok(self
            .previous_context(session_id, before_seq)?
            .and_then(|context| context.get("high").and_then(Value::as_bool))
            .unwrap_or(false))
    }

    fn previous_context(&self, session_id: &str, before_seq: u64) -> Result<Option<Value>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT metadata FROM steps
             WHERE session_id = ?1 AND seq < ?2 AND metadata IS NOT NULL
             ORDER BY seq DESC LIMIT 8",
        )?;
        let rows = statement.query_map(params![session_id, before_seq as i64], |row| {
            row.get::<_, String>(0)
        })?;
        for row in rows {
            let raw = row?;
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if let Some(context) = value.get("context") {
                return Ok(Some(context.clone()));
            }
        }
        Ok(None)
    }

    /// The most recent context meter recorded for a flight. Remote status uses
    /// only the percentage from this value.
    pub fn latest_context(&self, session_id: &str) -> Result<Option<Value>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT metadata FROM steps
             WHERE session_id = ?1 AND metadata IS NOT NULL
             ORDER BY seq DESC LIMIT 8",
        )?;
        let rows = statement.query_map(params![session_id], |row| row.get::<_, String>(0))?;
        for row in rows {
            let raw = row?;
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if let Some(context) = value.get("context") {
                return Ok(Some(context.clone()));
            }
        }
        Ok(None)
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

    // ----- Guard rules -----------------------------------------------------

    /// Insert a built-in rule once. Existing rows are left untouched so a user
    /// can keep a built-in disabled or tuned across restarts.
    pub fn seed_guard_rule(&self, id: &str, input: &GuardRuleInput) -> Result<bool> {
        let now = now_iso();
        let config = serde_json::to_string(&input.config)?;
        let connection = self.lock()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO guard_rules
               (id, name, description, kind, action, severity, source, enabled, priority, config,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'builtin', ?7, ?8, ?9, ?10, ?10)",
            params![
                id,
                input.name,
                input.description,
                input.kind.as_str(),
                input.action.as_str(),
                input.severity.as_str(),
                input.enabled as i64,
                input.priority as i64,
                config,
                now,
            ],
        )?;
        Ok(inserted > 0)
    }

    pub fn list_guard_rules(&self) -> Result<Vec<GuardRule>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {GUARD_RULE_COLUMNS} FROM guard_rules ORDER BY priority ASC, id ASC"
        ))?;
        let rows = statement.query_map([], row_to_guard_rule)?;
        let mut rules = Vec::new();
        for row in rows {
            rules.push(row?);
        }
        Ok(rules)
    }

    pub fn get_guard_rule(&self, id: &str) -> Result<Option<GuardRule>> {
        let connection = self.lock()?;
        let rule = connection
            .query_row(
                &format!("SELECT {GUARD_RULE_COLUMNS} FROM guard_rules WHERE id = ?1"),
                params![id],
                row_to_guard_rule,
            )
            .optional()?;
        Ok(rule)
    }

    pub fn create_guard_rule(
        &self,
        id: Option<&str>,
        input: &GuardRuleInput,
        source: GuardRuleSource,
    ) -> Result<GuardRule> {
        let id = id
            .map(str::to_string)
            .unwrap_or_else(cockpit_core::ids::create_id);
        let now = now_iso();
        let config = serde_json::to_string(&input.config)?;
        {
            let connection = self.lock()?;
            connection.execute(
                "INSERT INTO guard_rules
                   (id, name, description, kind, action, severity, source, enabled, priority, config,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                params![
                    id,
                    input.name,
                    input.description,
                    input.kind.as_str(),
                    input.action.as_str(),
                    input.severity.as_str(),
                    source.as_str(),
                    input.enabled as i64,
                    input.priority as i64,
                    config,
                    now,
                ],
            )?;
        }
        self.get_guard_rule(&id)?
            .ok_or_else(|| DaemonError::other("guard rule disappeared after insert"))
    }

    pub fn update_guard_rule(&self, id: &str, patch: &GuardRulePatch) -> Result<Option<GuardRule>> {
        let Some(mut rule) = self.get_guard_rule(id)? else {
            return Ok(None);
        };
        if let Some(name) = &patch.name {
            rule.name = name.clone();
        }
        if let Some(description) = &patch.description {
            rule.description = description.clone();
        }
        if let Some(kind) = patch.kind {
            rule.kind = kind;
        }
        if let Some(action) = patch.action {
            rule.action = action;
        }
        if let Some(severity) = patch.severity {
            rule.severity = severity;
        }
        if let Some(enabled) = patch.enabled {
            rule.enabled = enabled;
        }
        if let Some(priority) = patch.priority {
            rule.priority = priority;
        }
        if let Some(config) = &patch.config {
            rule.config = config.clone();
        }
        rule.updated_at = Some(now_iso());
        let config = serde_json::to_string(&rule.config)?;
        let connection = self.lock()?;
        connection.execute(
            "UPDATE guard_rules SET
               name = ?1, description = ?2, kind = ?3, action = ?4, severity = ?5,
               enabled = ?6, priority = ?7, config = ?8, updated_at = ?9
             WHERE id = ?10",
            params![
                rule.name,
                rule.description,
                rule.kind.as_str(),
                rule.action.as_str(),
                rule.severity.as_str(),
                rule.enabled as i64,
                rule.priority as i64,
                config,
                rule.updated_at,
                id,
            ],
        )?;
        drop(connection);
        self.get_guard_rule(id)
    }

    pub fn delete_guard_rule(&self, id: &str) -> Result<bool> {
        let connection = self.lock()?;
        let removed = connection.execute("DELETE FROM guard_rules WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    // ----- Guard events ----------------------------------------------------

    pub fn insert_guard_event(&self, input: NewGuardEvent) -> Result<GuardEvent> {
        let id = cockpit_core::ids::create_id();
        let requested_at = now_iso();
        let evidence = serde_json::to_string(&input.evidence)?;
        let metadata = input
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        {
            let connection = self.lock()?;
            connection.execute(
                "INSERT INTO guard_events
                   (id, session_id, step_id, rule_id, kind, action, severity, status, title,
                    description, command, evidence, requested_at, approval_nonce,
                    approval_expires_at, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    id,
                    input.session_id,
                    input.step_id,
                    input.rule_id,
                    input.kind.as_str(),
                    input.action.as_str(),
                    input.severity.as_str(),
                    input.status.as_str(),
                    input.title,
                    input.description,
                    input.command,
                    evidence,
                    requested_at,
                    input.approval_nonce,
                    input.approval_expires_at,
                    metadata,
                ],
            )?;
        }
        self.get_guard_event(&id)?
            .ok_or_else(|| DaemonError::other("guard event disappeared after insert"))
    }

    pub fn get_guard_event(&self, id: &str) -> Result<Option<GuardEvent>> {
        let connection = self.lock()?;
        let event = connection
            .query_row(
                &format!("SELECT {GUARD_EVENT_COLUMNS} FROM guard_events WHERE id = ?1"),
                params![id],
                row_to_guard_event,
            )
            .optional()?;
        Ok(event)
    }

    pub fn list_guard_events(&self, query: &GuardEventListQuery) -> Result<Vec<GuardEvent>> {
        let limit = if query.limit == 0 {
            100
        } else {
            query.limit.min(1_000)
        };
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {GUARD_EVENT_COLUMNS} FROM guard_events
             WHERE (?1 IS NULL OR session_id = ?1)
               AND (?2 IS NULL OR status = ?2)
               AND (?3 IS NULL OR kind = ?3)
             ORDER BY requested_at DESC, id DESC
             LIMIT ?4"
        ))?;
        let rows = statement.query_map(
            params![
                query.session_id,
                query.status.map(GuardEventStatus::as_str),
                query.kind.map(GuardRuleKind::as_str),
                limit,
            ],
            row_to_guard_event,
        )?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        Ok(events)
    }

    pub fn list_pending_guard_events(&self, session_id: Option<&str>) -> Result<Vec<GuardEvent>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {GUARD_EVENT_COLUMNS} FROM guard_events
             WHERE status = 'pending' AND (?1 IS NULL OR session_id = ?1)
             ORDER BY requested_at ASC"
        ))?;
        let rows = statement.query_map(params![session_id], row_to_guard_event)?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        Ok(events)
    }

    pub fn update_guard_event(
        &self,
        id: &str,
        patch: &GuardEventPatch,
    ) -> Result<Option<GuardEvent>> {
        let Some(mut event) = self.get_guard_event(id)? else {
            return Ok(None);
        };
        if let Some(status) = patch.status {
            event.status = status;
        }
        if patch.resolved_at.is_some() {
            event.resolved_at = patch.resolved_at.clone();
        }
        if patch.resolved_by.is_some() {
            event.resolved_by = patch.resolved_by.clone();
        }
        if patch.resolution_note.is_some() {
            event.resolution_note = patch.resolution_note.clone();
        }
        let connection = self.lock()?;
        connection.execute(
            "UPDATE guard_events SET
               status = ?1, resolved_at = ?2, resolved_by = ?3, resolution_note = ?4
             WHERE id = ?5",
            params![
                event.status.as_str(),
                event.resolved_at,
                event.resolved_by,
                event.resolution_note,
                id,
            ],
        )?;
        drop(connection);
        self.get_guard_event(id)
    }

    /// Resolve a pending approval exactly once.
    ///
    /// The `WHERE` clause is the security boundary: the nonce must still be
    /// attached to this event and the event must still be pending. A replayed
    /// or late decision updates nothing and returns `None`.
    pub fn resolve_guard_event_once(
        &self,
        id: &str,
        nonce: &str,
        patch: &GuardEventPatch,
    ) -> Result<Option<GuardEvent>> {
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE guard_events SET
               status = ?1, resolved_at = ?2, resolved_by = ?3, resolution_note = ?4,
               approval_nonce = NULL
             WHERE id = ?5 AND status = 'pending' AND approval_nonce = ?6",
            params![
                patch
                    .status
                    .map(GuardEventStatus::as_str)
                    .unwrap_or("pending"),
                patch.resolved_at,
                patch.resolved_by,
                patch.resolution_note,
                id,
                nonce,
            ],
        )?;
        drop(connection);
        if updated == 0 {
            return Ok(None);
        }
        self.get_guard_event(id)
    }

    /// Mark every pending approval whose window elapsed as expired. Returns
    /// only the rows this call actually changed so the caller can emit one
    /// live event per real transition.
    pub fn expire_pending_guard_events(&self, now: &str) -> Result<Vec<GuardEvent>> {
        let ids: Vec<String> = {
            let connection = self.lock()?;
            let mut statement = connection.prepare(
                "SELECT id FROM guard_events
                 WHERE status = 'pending'
                   AND approval_expires_at IS NOT NULL
                   AND approval_expires_at <= ?1",
            )?;
            let rows = statement.query_map(params![now], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };

        let mut expired = Vec::new();
        for id in ids {
            let connection = self.lock()?;
            let changed = connection.execute(
                "UPDATE guard_events SET
                   status = 'expired', resolved_at = ?1, resolved_by = 'cockpit',
                   resolution_note = 'The approval window elapsed.', approval_nonce = NULL
                 WHERE id = ?2 AND status = 'pending'",
                params![now, id],
            )?;
            if changed == 0 {
                continue;
            }
            let event = connection
                .query_row(
                    &format!("SELECT {GUARD_EVENT_COLUMNS} FROM guard_events WHERE id = ?1"),
                    params![id],
                    row_to_guard_event,
                )
                .optional()?;
            expired.extend(event);
        }
        Ok(expired)
    }

    // ----- Agent control events --------------------------------------------

    pub fn insert_agent_event(
        &self,
        session_id: &str,
        agent_name: &str,
        project_name: &str,
        input: &AgentEventInput,
    ) -> Result<AgentEvent> {
        let id = cockpit_core::ids::create_id();
        let created_at = now_iso();
        let metadata = input
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        {
            let connection = self.lock()?;
            connection.execute(
                "INSERT INTO agent_events
                   (id, session_id, agent_name, project_name, type, message, status,
                    created_at, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8)",
                params![
                    id,
                    session_id,
                    agent_name,
                    project_name,
                    input.event_type.as_str(),
                    input.message,
                    created_at,
                    metadata,
                ],
            )?;
        }
        self.get_agent_event(&id)?
            .ok_or_else(|| DaemonError::other("agent event disappeared after insert"))
    }

    pub fn get_agent_event(&self, id: &str) -> Result<Option<AgentEvent>> {
        let connection = self.lock()?;
        let event = connection
            .query_row(
                &format!("SELECT {AGENT_EVENT_COLUMNS} FROM agent_events WHERE id = ?1"),
                params![id],
                row_to_agent_event,
            )
            .optional()?;
        Ok(event)
    }

    pub fn list_agent_events(
        &self,
        status: Option<AgentEventStatus>,
        limit: u32,
    ) -> Result<Vec<AgentEvent>> {
        let limit = if limit == 0 { 100 } else { limit.min(1_000) };
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {AGENT_EVENT_COLUMNS} FROM agent_events
             WHERE (?1 IS NULL OR status = ?1)
             ORDER BY created_at DESC, id DESC
             LIMIT ?2"
        ))?;
        let rows = statement.query_map(
            params![status.map(AgentEventStatus::as_str), limit],
            row_to_agent_event,
        )?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        Ok(events)
    }

    pub fn acknowledge_agent_event(&self, id: &str) -> Result<Option<AgentEvent>> {
        let now = now_iso();
        let connection = self.lock()?;
        connection.execute(
            "UPDATE agent_events SET status = 'acknowledged', acknowledged_at = ?1
             WHERE id = ?2 AND status = 'open'",
            params![now, id],
        )?;
        drop(connection);
        self.get_agent_event(id)
    }

    /// Remove only rows produced by a historical rescan. Request-time findings
    /// stay visible because they are part of the flight record.
    pub fn delete_secret_scan_events(&self, session_id: &str) -> Result<u64> {
        let connection = self.lock()?;
        let removed = connection.execute(
            "DELETE FROM guard_events
             WHERE session_id = ?1
               AND rule_id LIKE 'secret-scan:%'
               AND status != 'pending'
               AND COALESCE(json_extract(metadata, '$.source'), 'scan') = 'scan'",
            params![session_id],
        )?;
        Ok(removed as u64)
    }

    // ----- Budgets ---------------------------------------------------------

    pub fn list_budget_policies(&self) -> Result<Vec<BudgetPolicy>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {BUDGET_COLUMNS} FROM budget_policies ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = statement.query_map([], row_to_budget_policy)?;
        let mut policies = Vec::new();
        for row in rows {
            policies.push(row?);
        }
        Ok(policies)
    }

    pub fn get_budget_policy(&self, id: &str) -> Result<Option<BudgetPolicy>> {
        let connection = self.lock()?;
        let policy = connection
            .query_row(
                &format!("SELECT {BUDGET_COLUMNS} FROM budget_policies WHERE id = ?1"),
                params![id],
                row_to_budget_policy,
            )
            .optional()?;
        Ok(policy)
    }

    pub fn create_budget_policy(&self, input: &BudgetPolicyInput) -> Result<BudgetPolicy> {
        let id = cockpit_core::ids::create_id();
        let now = now_iso();
        {
            let connection = self.lock()?;
            connection.execute(
                "INSERT INTO budget_policies
                   (id, name, scope, period, project_id, session_id, limit_usd, enforcement, enabled,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    id,
                    input.name,
                    input.scope.as_str(),
                    input.period.as_str(),
                    input.project_id,
                    input.session_id,
                    input.limit_usd,
                    input.enforcement.as_str(),
                    input.enabled as i64,
                    now,
                ],
            )?;
        }
        self.get_budget_policy(&id)?
            .ok_or_else(|| DaemonError::other("budget policy disappeared after insert"))
    }

    pub fn update_budget_policy(
        &self,
        id: &str,
        patch: &BudgetPolicyPatch,
    ) -> Result<Option<BudgetPolicy>> {
        let Some(mut policy) = self.get_budget_policy(id)? else {
            return Ok(None);
        };
        if let Some(name) = &patch.name {
            policy.name = name.clone();
        }
        if let Some(scope) = patch.scope {
            policy.scope = scope;
        }
        if let Some(period) = patch.period {
            policy.period = period;
        }
        if patch.project_id.is_some() {
            policy.project_id = patch.project_id.clone();
        }
        if patch.session_id.is_some() {
            policy.session_id = patch.session_id.clone();
        }
        if let Some(limit_usd) = patch.limit_usd {
            policy.limit_usd = limit_usd;
        }
        if let Some(enforcement) = patch.enforcement {
            policy.enforcement = enforcement;
        }
        if let Some(enabled) = patch.enabled {
            policy.enabled = enabled;
        }
        policy.updated_at = now_iso();
        let connection = self.lock()?;
        connection.execute(
            "UPDATE budget_policies SET
               name = ?1, scope = ?2, period = ?3, project_id = ?4, session_id = ?5,
               limit_usd = ?6, enforcement = ?7, enabled = ?8, updated_at = ?9
             WHERE id = ?10",
            params![
                policy.name,
                policy.scope.as_str(),
                policy.period.as_str(),
                policy.project_id,
                policy.session_id,
                policy.limit_usd,
                policy.enforcement.as_str(),
                policy.enabled as i64,
                policy.updated_at,
                id,
            ],
        )?;
        drop(connection);
        self.get_budget_policy(id)
    }

    pub fn delete_budget_policy(&self, id: &str) -> Result<bool> {
        let connection = self.lock()?;
        let removed =
            connection.execute("DELETE FROM budget_policies WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Total spend for a period. Project-scoped policies never apply in 0.2.0
    /// because sessions do not carry a project id yet.
    pub fn spend_since(&self, period_start: &str, project_id: Option<&str>) -> Result<f64> {
        if project_id.is_some() {
            return Ok(0.0);
        }
        let connection = self.lock()?;
        let spend: f64 = connection.query_row(
            "SELECT COALESCE(SUM(total_cost_usd), 0) FROM sessions WHERE started_at >= ?1",
            params![period_start],
            |row| row.get(0),
        )?;
        Ok(spend)
    }

    pub fn session_cost_usd(&self, session_id: &str) -> Result<f64> {
        let connection = self.lock()?;
        let spend: f64 = connection.query_row(
            "SELECT COALESCE(total_cost_usd, 0) FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        Ok(spend)
    }

    // ----- Replay and redactions ------------------------------------------

    pub fn list_recent_prompt_texts(&self, session_id: &str, limit: u32) -> Result<Vec<String>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT request_prompt_text FROM steps
             WHERE session_id = ?1 AND request_prompt_text IS NOT NULL
             ORDER BY seq DESC LIMIT ?2",
        )?;
        let rows =
            statement.query_map(params![session_id, limit], |row| row.get::<_, String>(0))?;
        let mut prompts = Vec::new();
        for row in rows {
            prompts.push(row?);
        }
        Ok(prompts)
    }

    pub fn list_session_redactions(&self, session_id: &str) -> Result<Vec<SessionRedactionRow>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT redactions.step_id, redactions.rule_id, redactions.label, redactions.location,
                    redactions.occurrences
             FROM redactions
             INNER JOIN steps ON redactions.step_id = steps.id
             WHERE steps.session_id = ?1",
        )?;
        let rows = statement.query_map(params![session_id], |row| {
            Ok(SessionRedactionRow {
                step_id: row.get(0)?,
                rule_id: row.get(1)?,
                label: row.get(2)?,
                location: CaptureLocation::parse(&row.get::<_, String>(3)?)
                    .unwrap_or(CaptureLocation::RequestBody),
                occurrences: row.get::<_, i64>(4)? as u64,
            })
        })?;
        let mut redactions = Vec::new();
        for row in rows {
            redactions.push(row?);
        }
        Ok(redactions)
    }

    pub fn update_session_git(
        &self,
        session_id: &str,
        branch: Option<&str>,
        base_commit: Option<&str>,
    ) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE sessions SET
               git_branch = COALESCE(?1, git_branch),
               git_base_commit = COALESCE(?2, git_base_commit)
             WHERE id = ?3",
            params![branch, base_commit, session_id],
        )?;
        Ok(())
    }

    pub fn insert_snapshot(&self, input: NewSnapshot) -> Result<ReplaySnapshot> {
        let id = cockpit_core::ids::create_id();
        let created_at = input.created_at.unwrap_or_else(now_iso);
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO git_snapshots
               (id, session_id, step_id, kind, commit_sha, parent_commit_sha, branch,
                worktree_path, patch, files_changed, insertions, deletions, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                input.session_id,
                input.step_id,
                input.kind.as_str(),
                input.commit_sha,
                input.parent_commit_sha,
                input.branch,
                input.worktree_path,
                input.patch,
                input.files_changed as i64,
                input.insertions as i64,
                input.deletions as i64,
                created_at,
            ],
        )?;
        for change in &input.file_changes {
            transaction.execute(
                "INSERT INTO file_changes
                   (id, snapshot_id, path, old_path, change_type, additions, deletions, diff,
                    ai_authored)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    cockpit_core::ids::create_id(),
                    id,
                    change.path,
                    change.old_path,
                    change.change_type.as_str(),
                    change.additions as i64,
                    change.deletions as i64,
                    change.diff,
                    change.ai_authored.map(|value| value as i64),
                ],
            )?;
        }
        transaction.commit()?;
        drop(connection);
        self.get_snapshot(&id)?
            .ok_or_else(|| DaemonError::other("snapshot disappeared after insert"))
    }

    pub fn get_snapshot(&self, id: &str) -> Result<Option<ReplaySnapshot>> {
        let connection = self.lock()?;
        let snapshot = connection
            .query_row(
                &format!("SELECT {SNAPSHOT_COLUMNS} FROM git_snapshots WHERE id = ?1"),
                params![id],
                row_to_snapshot,
            )
            .optional()?;
        Ok(snapshot)
    }

    pub fn list_snapshots(&self, session_id: &str) -> Result<Vec<ReplaySnapshot>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {SNAPSHOT_COLUMNS} FROM git_snapshots
             WHERE session_id = ?1 ORDER BY created_at ASC, rowid ASC"
        ))?;
        let rows = statement.query_map(params![session_id], row_to_snapshot)?;
        let mut snapshots = Vec::new();
        for row in rows {
            snapshots.push(row?);
        }
        Ok(snapshots)
    }

    pub fn latest_snapshot(&self, session_id: &str) -> Result<Option<ReplaySnapshot>> {
        Ok(self.list_snapshots(session_id)?.pop())
    }

    pub fn list_snapshot_file_changes(&self, snapshot_id: &str) -> Result<Vec<ReplayFileChange>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, snapshot_id, path, old_path, change_type, additions, deletions, diff,
                    ai_authored
             FROM file_changes WHERE snapshot_id = ?1 ORDER BY path ASC",
        )?;
        let rows = statement.query_map(params![snapshot_id], row_to_file_change)?;
        let mut changes = Vec::new();
        for row in rows {
            changes.push(row?);
        }
        Ok(changes)
    }

    // ----- Remote access ---------------------------------------------------

    pub fn insert_remote_device(&self, device: &NewRemoteDevice) -> Result<RemoteDeviceRow> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO remote_devices
                (id, name, token_hash, pin_salt, pin_hash, scopes,
                 require_host_confirmation, pin_failures, respond_locked_at,
                 expires_at, previous_token_hash, previous_token_expires_at,
                 created_at, last_seen_at, revoked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, ?8, NULL, NULL, ?9, NULL, NULL)",
            params![
                device.id,
                device.name,
                device.token_hash,
                device.pin_salt,
                device.pin_hash,
                serde_json::to_string(&device.scopes).unwrap_or_else(|_| "[]".to_string()),
                device.require_host_confirmation as i64,
                device.expires_at,
                device.created_at,
            ],
        )?;
        self.get_remote_device_with(&connection, &device.id)?
            .ok_or_else(|| DaemonError::other("the new remote device could not be read back"))
    }

    pub fn list_remote_devices(&self) -> Result<Vec<RemoteDeviceRow>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, name, token_hash, pin_salt, pin_hash, scopes,
                    require_host_confirmation, pin_failures, respond_locked_at,
                    expires_at, previous_token_hash, previous_token_expires_at,
                    created_at, last_seen_at, revoked_at
             FROM remote_devices ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], row_to_remote_device)?;
        let mut devices = Vec::new();
        for row in rows {
            devices.push(row?);
        }
        Ok(devices)
    }

    pub fn get_remote_device(&self, id: &str) -> Result<Option<RemoteDeviceRow>> {
        let connection = self.lock()?;
        self.get_remote_device_with(&connection, id)
    }

    pub fn find_remote_device_by_token_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<RemoteDeviceRow>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                "SELECT id, name, token_hash, pin_salt, pin_hash, scopes,
                        require_host_confirmation, pin_failures, respond_locked_at,
                    expires_at, previous_token_hash, previous_token_expires_at,
                    created_at, last_seen_at, revoked_at
                 FROM remote_devices WHERE token_hash = ?1",
                params![token_hash],
                row_to_remote_device,
            )
            .optional()?)
    }

    pub fn count_active_remote_devices(&self) -> Result<u64> {
        let connection = self.lock()?;
        Ok(connection.query_row(
            "SELECT COUNT(*) FROM remote_devices WHERE revoked_at IS NULL",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64)
    }

    fn get_remote_device_with(
        &self,
        connection: &Connection,
        id: &str,
    ) -> Result<Option<RemoteDeviceRow>> {
        Ok(connection
            .query_row(
                "SELECT id, name, token_hash, pin_salt, pin_hash, scopes,
                        require_host_confirmation, pin_failures, respond_locked_at,
                    expires_at, previous_token_hash, previous_token_expires_at,
                    created_at, last_seen_at, revoked_at
                 FROM remote_devices WHERE id = ?1",
                params![id],
                row_to_remote_device,
            )
            .optional()?)
    }

    pub fn set_remote_device_token_hash(&self, id: &str, token_hash: &str) -> Result<bool> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE remote_devices
             SET token_hash = ?1, previous_token_hash = NULL, previous_token_expires_at = NULL
             WHERE id = ?2",
            params![token_hash, id],
        )?;
        Ok(changed > 0)
    }

    /// Rotate a token on use. The old hash stays valid only until the overlap
    /// deadline, and only one rotation can be in flight at a time.
    pub fn rotate_remote_device_token_on_use(
        &self,
        id: &str,
        current_hash: &str,
        new_hash: &str,
        overlap_until: &str,
        now: &str,
    ) -> Result<bool> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE remote_devices
             SET previous_token_hash = token_hash,
                 previous_token_expires_at = ?1,
                 token_hash = ?2
             WHERE id = ?3
               AND token_hash = ?4
               AND (previous_token_expires_at IS NULL OR previous_token_expires_at <= ?5)",
            params![overlap_until, new_hash, id, current_hash, now],
        )?;
        Ok(changed > 0)
    }

    pub fn find_remote_device_by_previous_token_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<RemoteDeviceRow>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                "SELECT id, name, token_hash, pin_salt, pin_hash, scopes,
                        require_host_confirmation, pin_failures, respond_locked_at,
                        expires_at, previous_token_hash, previous_token_expires_at,
                        created_at, last_seen_at, revoked_at
                 FROM remote_devices WHERE previous_token_hash = ?1",
                params![token_hash],
                row_to_remote_device,
            )
            .optional()?)
    }

    pub fn set_remote_device_expiry(&self, id: &str, expires_at: &str) -> Result<bool> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE remote_devices SET expires_at = ?1 WHERE id = ?2",
            params![expires_at, id],
        )?;
        Ok(changed > 0)
    }

    pub fn update_remote_device(
        &self,
        id: &str,
        scopes: &[String],
        require_host_confirmation: Option<bool>,
    ) -> Result<Option<RemoteDeviceRow>> {
        let connection = self.lock()?;
        if let Some(required) = require_host_confirmation {
            connection.execute(
                "UPDATE remote_devices
                 SET scopes = ?1, require_host_confirmation = ?2
                 WHERE id = ?3",
                params![
                    serde_json::to_string(scopes).unwrap_or_else(|_| "[]".to_string()),
                    required as i64,
                    id
                ],
            )?;
        } else {
            connection.execute(
                "UPDATE remote_devices SET scopes = ?1 WHERE id = ?2",
                params![
                    serde_json::to_string(scopes).unwrap_or_else(|_| "[]".to_string()),
                    id
                ],
            )?;
        }
        self.get_remote_device_with(&connection, id)
    }

    /// Count a wrong high-risk PIN. The fifth failure locks Respond for this
    /// device until the host explicitly resets it. The update and the read are
    /// one statement so two concurrent attempts cannot both see "four".
    pub fn record_remote_pin_failure(
        &self,
        id: &str,
        threshold: u32,
    ) -> Result<Option<RemoteDeviceRow>> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE remote_devices
             SET pin_failures = pin_failures + 1,
                 respond_locked_at = CASE
                     WHEN pin_failures + 1 >= ?2 AND respond_locked_at IS NULL THEN ?3
                     ELSE respond_locked_at
                 END
             WHERE id = ?1",
            params![id, threshold as i64, now_iso()],
        )?;
        self.get_remote_device_with(&connection, id)
    }

    /// Clear the PIN failure count and the Respond lock after a correct PIN or
    /// an explicit host reset.
    pub fn clear_remote_pin_failures(&self, id: &str) -> Result<bool> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE remote_devices
             SET pin_failures = 0, respond_locked_at = NULL
             WHERE id = ?1",
            params![id],
        )?;
        Ok(changed > 0)
    }

    pub fn revoke_remote_device(&self, id: &str, at: &str) -> Result<bool> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE remote_devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
            params![at, id],
        )?;
        Ok(changed > 0)
    }

    pub fn revoke_all_remote_devices(&self, at: &str) -> Result<u64> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE remote_devices SET revoked_at = ?1 WHERE revoked_at IS NULL",
            params![at],
        )?;
        Ok(changed as u64)
    }

    pub fn touch_remote_device(&self, id: &str, at: &str) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE remote_devices SET last_seen_at = ?1 WHERE id = ?2",
            params![at, id],
        )?;
        Ok(())
    }

    pub fn insert_remote_audit(&self, row: &NewRemoteAudit) -> Result<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Chain to the most recently appended entry. The immediate transaction
        // keeps a concurrent writer from inserting between this read and write.
        let previous: Option<String> = transaction
            .query_row(
                "SELECT entry_hash FROM remote_audit
                 WHERE entry_hash IS NOT NULL
                 ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let fields = AuditHashFields {
            id: row.id.clone(),
            at: row.at.clone(),
            event: row.event.clone(),
            device_id: row.device_id.clone(),
            device_name: row.device_name.clone(),
            ip: row.ip.clone(),
            detail: row.detail.clone(),
            size_bytes: row.size_bytes,
            content_hash: row.content_hash.clone(),
        };
        let entry_hash = audit_entry_hash(previous.as_deref(), &fields);
        transaction.execute(
            "INSERT INTO remote_audit
                (id, at, event, device_id, device_name, ip, detail, size_bytes, content_hash, prev_hash, entry_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                row.id,
                row.at,
                row.event,
                row.device_id,
                row.device_name,
                row.ip,
                row.detail,
                row.size_bytes,
                row.content_hash,
                previous,
                entry_hash,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_remote_audit(&self, limit: u32, offset: u32) -> Result<Vec<RemoteAuditRow>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, at, event, device_id, device_name, ip, detail, size_bytes, content_hash,
                    prev_hash, entry_hash
             FROM remote_audit ORDER BY at DESC, id DESC LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![limit, offset], row_to_remote_audit)?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    pub fn count_remote_audit(&self) -> Result<u64> {
        let connection = self.lock()?;
        Ok(
            connection.query_row("SELECT COUNT(*) FROM remote_audit", [], |row| {
                row.get::<_, i64>(0)
            })? as u64,
        )
    }

    /// Walk the audit log in append order and prove every entry still matches
    /// its hash and names its predecessor.
    pub fn verify_remote_audit_chain(&self) -> Result<AuditChainReport> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, at, event, device_id, device_name, ip, detail, size_bytes, content_hash,
                    prev_hash, entry_hash
             FROM remote_audit ORDER BY rowid ASC",
        )?;
        let mut rows = statement.query([])?;
        let mut expected_previous: Option<String> = None;
        let mut entries: u64 = 0;

        while let Some(row) = rows.next()? {
            entries += 1;
            let fields = AuditHashFields {
                id: row.get(0)?,
                at: row.get(1)?,
                event: row.get(2)?,
                device_id: row.get(3)?,
                device_name: row.get(4)?,
                ip: row.get(5)?,
                detail: row.get(6)?,
                size_bytes: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
                content_hash: row.get(8)?,
            };
            let stored_previous: Option<String> = row.get(9)?;
            let stored_hash: Option<String> = row.get(10)?;

            if stored_previous != expected_previous {
                return Ok(AuditChainReport {
                    entries,
                    valid: false,
                    broken_at: Some(fields.id),
                    reason: Some(
                        "the previous hash does not match the preceding entry".to_string(),
                    ),
                });
            }

            let computed = audit_entry_hash(expected_previous.as_deref(), &fields);
            if stored_hash.as_deref() != Some(computed.as_str()) {
                return Ok(AuditChainReport {
                    entries,
                    valid: false,
                    broken_at: Some(fields.id),
                    reason: Some("the entry hash does not match its contents".to_string()),
                });
            }
            expected_previous = Some(computed);
        }

        Ok(AuditChainReport {
            entries,
            valid: true,
            broken_at: None,
            reason: None,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| DaemonError::other("database lock was poisoned"))
    }
}

#[derive(Debug, Clone)]
pub struct NewRemoteDevice {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub pin_salt: Option<String>,
    pub pin_hash: Option<String>,
    pub scopes: Vec<String>,
    pub require_host_confirmation: bool,
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct RemoteDeviceRow {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub pin_salt: Option<String>,
    pub pin_hash: Option<String>,
    pub scopes: Vec<String>,
    pub require_host_confirmation: bool,
    pub pin_failures: u32,
    pub respond_locked_at: Option<String>,
    pub expires_at: Option<String>,
    pub previous_token_hash: Option<String>,
    pub previous_token_expires_at: Option<String>,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewRemoteAudit {
    pub id: String,
    pub at: String,
    pub event: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub ip: Option<String>,
    pub detail: String,
    pub size_bytes: Option<u64>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAuditRow {
    pub id: String,
    pub at: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    pub detail: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_hash: Option<String>,
}

/// Result of walking the audit hash chain.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditChainReport {
    pub entries: u64,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broken_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn row_to_remote_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteDeviceRow> {
    let scopes: String = row.get(5)?;
    Ok(RemoteDeviceRow {
        id: row.get(0)?,
        name: row.get(1)?,
        token_hash: row.get(2)?,
        pin_salt: row.get(3)?,
        pin_hash: row.get(4)?,
        scopes: serde_json::from_str(&scopes).unwrap_or_default(),
        require_host_confirmation: row.get::<_, i64>(6)? != 0,
        pin_failures: row.get::<_, i64>(7)? as u32,
        respond_locked_at: row.get(8)?,
        expires_at: row.get(9)?,
        previous_token_hash: row.get(10)?,
        previous_token_expires_at: row.get(11)?,
        created_at: row.get(12)?,
        last_seen_at: row.get(13)?,
        revoked_at: row.get(14)?,
    })
}

fn row_to_remote_audit(row: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteAuditRow> {
    let detail: String = row.get(6)?;
    Ok(RemoteAuditRow {
        id: row.get(0)?,
        at: row.get(1)?,
        event: row.get(2)?,
        device_id: row.get(3)?,
        device_name: row.get(4)?,
        ip: row.get(5)?,
        detail: serde_json::from_str(&detail).unwrap_or(Value::Null),
        size_bytes: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
        content_hash: row.get(8)?,
        prev_hash: row.get(9)?,
        entry_hash: row.get(10)?,
    })
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

const GUARD_RULE_COLUMNS: &str = "id, name, description, kind, action, severity, source, enabled,
    priority, config, created_at, updated_at";

fn row_to_guard_rule(row: &rusqlite::Row<'_>) -> rusqlite::Result<GuardRule> {
    let config: String = row.get(9)?;
    Ok(GuardRule {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        kind: GuardRuleKind::parse(&row.get::<_, String>(3)?).unwrap_or(GuardRuleKind::Custom),
        action: GuardAction::parse(&row.get::<_, String>(4)?).unwrap_or(GuardAction::Warn),
        severity: GuardSeverity::parse(&row.get::<_, String>(5)?).unwrap_or(GuardSeverity::Medium),
        source: GuardRuleSource::parse(&row.get::<_, String>(6)?).unwrap_or(GuardRuleSource::User),
        enabled: row.get::<_, i64>(7)? != 0,
        priority: row.get::<_, i64>(8)? as u32,
        config: serde_json::from_str(&config).unwrap_or(Value::Object(serde_json::Map::new())),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const GUARD_EVENT_COLUMNS: &str =
    "id, session_id, step_id, rule_id, kind, action, severity, status,
    title, description, command, evidence, requested_at, approval_nonce,
    approval_expires_at, resolved_at, resolved_by, resolution_note, metadata";

fn row_to_guard_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<GuardEvent> {
    let evidence: String = row.get(11)?;
    let metadata: Option<String> = row.get(18)?;
    Ok(GuardEvent {
        id: row.get(0)?,
        session_id: row.get(1)?,
        step_id: row.get(2)?,
        rule_id: row.get(3)?,
        kind: GuardRuleKind::parse(&row.get::<_, String>(4)?).unwrap_or(GuardRuleKind::Custom),
        action: GuardAction::parse(&row.get::<_, String>(5)?).unwrap_or(GuardAction::Warn),
        severity: GuardSeverity::parse(&row.get::<_, String>(6)?).unwrap_or(GuardSeverity::Medium),
        status: GuardEventStatus::parse(&row.get::<_, String>(7)?)
            .unwrap_or(GuardEventStatus::Warned),
        title: row.get(8)?,
        description: row.get(9)?,
        command: row.get(10)?,
        evidence: serde_json::from_str(&evidence).unwrap_or_default(),
        requested_at: row.get(12)?,
        approval_nonce: row.get(13)?,
        approval_expires_at: row.get(14)?,
        resolved_at: row.get(15)?,
        resolved_by: row.get(16)?,
        resolution_note: row.get(17)?,
        metadata: metadata.and_then(|value| serde_json::from_str(&value).ok()),
    })
}

const AGENT_EVENT_COLUMNS: &str = "id, session_id, agent_name, project_name, type, message,
    status, created_at, acknowledged_at, metadata";

fn row_to_agent_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentEvent> {
    let metadata: Option<String> = row.get(9)?;
    Ok(AgentEvent {
        id: row.get(0)?,
        session_id: row.get(1)?,
        agent_name: row.get(2)?,
        project_name: row.get(3)?,
        event_type: AgentEventType::parse(&row.get::<_, String>(4)?)
            .unwrap_or(AgentEventType::Question),
        message: row.get(5)?,
        status: AgentEventStatus::parse(&row.get::<_, String>(6)?)
            .unwrap_or(AgentEventStatus::Open),
        created_at: row.get(7)?,
        acknowledged_at: row.get(8)?,
        metadata: metadata.and_then(|value| serde_json::from_str(&value).ok()),
    })
}

const BUDGET_COLUMNS: &str = "id, name, scope, period, project_id, session_id, limit_usd,
    enforcement, enabled, created_at, updated_at";

fn row_to_budget_policy(row: &rusqlite::Row<'_>) -> rusqlite::Result<BudgetPolicy> {
    Ok(BudgetPolicy {
        id: row.get(0)?,
        name: row.get(1)?,
        scope: BudgetScope::parse(&row.get::<_, String>(2)?).unwrap_or(BudgetScope::Global),
        period: BudgetPeriod::parse(&row.get::<_, String>(3)?).unwrap_or(BudgetPeriod::Month),
        project_id: row.get(4)?,
        session_id: row.get(5)?,
        limit_usd: row.get(6)?,
        enforcement: BudgetEnforcement::parse(&row.get::<_, String>(7)?)
            .unwrap_or(BudgetEnforcement::Warn),
        enabled: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

const SNAPSHOT_COLUMNS: &str = "id, session_id, step_id, kind, commit_sha, parent_commit_sha,
    branch, worktree_path, patch, files_changed, insertions, deletions, created_at";

fn row_to_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReplaySnapshot> {
    Ok(ReplaySnapshot {
        id: row.get(0)?,
        session_id: row.get(1)?,
        step_id: row.get(2)?,
        kind: SnapshotKind::parse(&row.get::<_, String>(3)?).unwrap_or(SnapshotKind::After),
        commit_sha: row.get(4)?,
        parent_commit_sha: row.get(5)?,
        branch: row.get(6)?,
        worktree_path: row.get(7)?,
        patch: row.get(8)?,
        files_changed: row.get::<_, i64>(9)? as u64,
        insertions: row.get::<_, i64>(10)? as u64,
        deletions: row.get::<_, i64>(11)? as u64,
        created_at: row.get(12)?,
    })
}

fn row_to_file_change(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReplayFileChange> {
    Ok(ReplayFileChange {
        id: row.get(0)?,
        snapshot_id: row.get(1)?,
        path: row.get(2)?,
        old_path: row.get(3)?,
        change_type: FileChangeType::parse(&row.get::<_, String>(4)?)
            .unwrap_or(FileChangeType::Modified),
        additions: row.get::<_, i64>(5)? as u64,
        deletions: row.get::<_, i64>(6)? as u64,
        diff: row.get(7)?,
        ai_authored: row.get::<_, Option<i64>>(8)?.map(|value| value != 0),
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
                    metadata: None,
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
            metadata: None,
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

    fn audit_entry(store: &Store, event: &str, detail: &str) -> RemoteAuditRow {
        let id = uuid::Uuid::new_v4().to_string();
        store
            .insert_remote_audit(&NewRemoteAudit {
                id: id.clone(),
                at: now_iso(),
                event: event.to_string(),
                device_id: Some("device-1".to_string()),
                device_name: Some("Phone".to_string()),
                ip: Some("203.0.113.7".to_string()),
                detail: detail.to_string(),
                size_bytes: Some(12),
                content_hash: Some("abc123".to_string()),
            })
            .unwrap();
        store
            .list_remote_audit(100, 0)
            .unwrap()
            .into_iter()
            .find(|row| row.id == id)
            .unwrap()
    }

    #[test]
    fn audit_hash_chain_verifies_and_detects_tampering() {
        let store = store();
        let first = audit_entry(&store, "remote.enabled", "{}");
        let second = audit_entry(&store, "prompt.sent", "{\"sessionId\":\"s\"}");

        assert!(first.prev_hash.is_none());
        assert!(
            first
                .entry_hash
                .as_deref()
                .is_some_and(|hash| hash.len() == 64)
        );
        assert_eq!(second.prev_hash, first.entry_hash);

        let report = store.verify_remote_audit_chain().unwrap();
        assert!(report.valid, "{report:?}");
        assert_eq!(report.entries, 2);
        assert!(report.broken_at.is_none());

        // Editing a stored field without recomputing the hash is detected.
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE remote_audit SET detail = ?1 WHERE id = ?2",
                params!["{\"sessionId\":\"tampered\"}", second.id],
            )
            .unwrap();
        let report = store.verify_remote_audit_chain().unwrap();
        assert!(!report.valid);
        assert_eq!(report.broken_at.as_deref(), Some(second.id.as_str()));
        assert_eq!(
            report.reason.as_deref(),
            Some("the entry hash does not match its contents")
        );
    }

    #[test]
    fn audit_hash_chain_detects_a_removed_link() {
        let store = store();
        audit_entry(&store, "remote.enabled", "{}");
        let second = audit_entry(&store, "remote.disabled", "{}");

        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE remote_audit SET prev_hash = NULL WHERE id = ?1",
                params![second.id],
            )
            .unwrap();
        let report = store.verify_remote_audit_chain().unwrap();
        assert!(!report.valid);
        assert_eq!(report.broken_at.as_deref(), Some(second.id.as_str()));
        assert_eq!(
            report.reason.as_deref(),
            Some("the previous hash does not match the preceding entry")
        );
    }

    #[test]
    fn legacy_audit_rows_are_sealed_once_on_open() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cockpit.db");
        let first_id = {
            let store = Store::open(&path).unwrap();
            let first = audit_entry(&store, "remote.enabled", "{}");
            audit_entry(&store, "remote.disabled", "{}");
            let connection = store.lock().unwrap();
            connection
                .execute(
                    "UPDATE remote_audit SET prev_hash = NULL, entry_hash = NULL",
                    [],
                )
                .unwrap();
            connection
                .execute("DELETE FROM schema_meta WHERE key = 'audit_chain'", [])
                .unwrap();
            first.id
        };

        let reopened = Store::open(&path).unwrap();
        let report = reopened.verify_remote_audit_chain().unwrap();
        assert!(report.valid, "{report:?}");
        assert_eq!(report.entries, 2);
        assert!(
            reopened
                .list_remote_audit(10, 0)
                .unwrap()
                .iter()
                .all(|row| row
                    .entry_hash
                    .as_deref()
                    .is_some_and(|hash| hash.len() == 64))
        );

        // Once sealed, reopening must not repair a later edit.
        reopened
            .lock()
            .unwrap()
            .execute(
                "UPDATE remote_audit SET event = 'tampered' WHERE id = ?1",
                params![first_id],
            )
            .unwrap();
        drop(reopened);
        let reopened = Store::open(&path).unwrap();
        assert!(!reopened.verify_remote_audit_chain().unwrap().valid);
    }
}
