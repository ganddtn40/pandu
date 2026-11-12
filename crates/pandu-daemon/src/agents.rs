//! Local agent control plane for PTY sessions.
//!
//! The CLI owns the pseudo-terminal. This module only stores sanitized output,
//! queues keystrokes for the CLI to read, records agent events, and emits
//! notification payloads that contain no prompts, code, or file contents.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use pandu_core::adapter::{Adapter, AdapterRegistry};
use pandu_core::agent::{
    AgentEvent, AgentEventInput, AgentEventStatus, AgentEventType, NotificationPayload,
};
use pandu_core::brand;
use pandu_core::model::{CaptureMode, SessionSource, SessionStatus};
use pandu_core::provider::{AgentInfo, DetectedFrom};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::error::{DaemonError, Result};
use crate::live::LiveBus;
use crate::store::{NewSession, Store, now_iso};

/// A terminal needs a bounded history. Older output is trimmed from the front
/// so one runaway agent cannot exhaust daemon memory.
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_LINE_CHARS: usize = 2_000;
const TAIL_BYTES: usize = 4_096;
const MAX_INPUT_QUEUE_BYTES: usize = 64 * 1024;
const MAX_INPUT_CHUNK_CHARS: usize = 4_096;
const MAX_MESSAGE_CHARS: usize = 2_000;
const DETECTION_COOLDOWN: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionStatus {
    Running,
    Exited,
    Killed,
}

impl AgentSessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Killed => "killed",
        }
    }
}

/// What the agent was last seen waiting for. Remote prompts are only allowed
/// in `AwaitingPrompt`; every other state must be handled at the computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPromptState {
    AwaitingPrompt,
    Permission,
    Choice,
    Question,
    Auth,
    Unknown,
}

impl AgentPromptState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingPrompt => "awaiting_prompt",
            Self::Permission => "permission",
            Self::Choice => "choice",
            Self::Question => "question",
            Self::Auth => "auth",
            Self::Unknown => "unknown",
        }
    }

    pub fn is_awaiting_prompt(self) -> bool {
        self == Self::AwaitingPrompt
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSwitchSupport {
    /// True only when the adapter declares a verified command and the session
    /// is a PTY Pandu can type into.
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub instructions: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSwitchOutcome {
    /// `pty` when the command was queued, `manual` when the host must do it.
    pub mode: &'static str,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionView {
    pub session_id: String,
    pub agent_name: String,
    pub project_name: String,
    pub working_dir: String,
    pub adapter: String,
    pub verified: bool,
    pub status: AgentSessionStatus,
    pub needs_you: bool,
    pub prompt_state: AgentPromptState,
    /// The agent was started with a flag that skips its own approvals. Every
    /// remote prompt in this session must still be confirmed by the host.
    pub auto_approve: bool,
    /// Whether Pandu may switch this agent's model from the terminal, and
    /// what to tell the host when it may not.
    pub model_switch: ModelSwitchSupport,
    pub exit_code: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
    pub output_sequence: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutput {
    pub session: AgentSessionView,
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputChunk {
    pub sequence: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputPoll {
    pub chunks: Vec<InputChunk>,
    pub status: AgentSessionStatus,
    pub needs_you: bool,
    pub output_sequence: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterAgentInput {
    pub agent_name: String,
    #[serde(default)]
    pub project_name: Option<String>,
    pub working_dir: String,
    #[serde(default)]
    pub adapter: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    /// The exact command line the CLI launched, when it knows it. Used only to
    /// detect adapter auto-approve flags so remote prompts stay host-gated.
    #[serde(default)]
    pub command_line: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndAgentInput {
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub killed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInput {
    pub data: String,
}

struct SessionEntry {
    view: AgentSessionView,
    output: String,
    tail: String,
    input: VecDeque<InputChunk>,
    input_bytes: usize,
    next_input_sequence: u64,
    input_tx: watch::Sender<u64>,
    last_detection: Option<(String, std::time::Instant)>,
}

struct Inner {
    sessions: HashMap<String, SessionEntry>,
}

/// Owns in-memory PTY control state. Everything persisted (sessions, agent
/// events) goes through `Store`; this map only exists while the daemon runs.
pub struct AgentControl {
    store: Arc<Store>,
    live: Arc<LiveBus>,
    registry: Arc<AdapterRegistry>,
    notifications: bool,
    demo_mode: bool,
    inner: StdMutex<Inner>,
}

fn model_switch_support(adapter: Option<&Adapter>) -> ModelSwitchSupport {
    match adapter
        .and_then(|adapter| adapter.model_switch.as_ref())
        .filter(|spec| spec.verified)
    {
        Some(spec) => ModelSwitchSupport {
            available: true,
            command: Some(spec.command.clone()),
            instructions: format!(
                "{} can send `{}` to this terminal.",
                brand::PRODUCT_NAME,
                spec.command.replace("{model}", "<model>")
            ),
        },
        None => ModelSwitchSupport {
            available: false,
            command: None,
            instructions: "This agent has no verified model switch. Change the model inside the agent, then start a new flight.".to_string(),
        },
    }
}

impl AgentControl {
    pub fn new(
        store: Arc<Store>,
        live: Arc<LiveBus>,
        registry: Arc<AdapterRegistry>,
        notifications: bool,
        demo_mode: bool,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            live,
            registry,
            notifications,
            demo_mode,
            inner: StdMutex::new(Inner {
                sessions: HashMap::new(),
            }),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| DaemonError::other("agent control lock was poisoned"))
    }

    pub fn register(&self, input: RegisterAgentInput) -> Result<AgentSessionView> {
        let agent_name = clean_label(&input.agent_name, 120, "Agent");
        let working_dir = clean_label(&input.working_dir, 500, "Workspace");
        let project_name = input
            .project_name
            .as_deref()
            .map(|value| clean_label(value, 120, "Workspace"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| project_from_path(&working_dir));
        let adapter = input
            .adapter
            .as_deref()
            .map(|value| clean_label(value, 120, "Agent"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| agent_name.clone());
        let verified = self
            .registry
            .get(&adapter)
            .map(|adapter| adapter.verified)
            .unwrap_or(false);
        let model_switch = model_switch_support(self.registry.find(&adapter));

        let session = self.store.create_session(NewSession {
            title: format!("{agent_name} · {project_name}"),
            source: SessionSource::Manual,
            capture_mode: CaptureMode::Pty,
            source_label: Some("Live PTY session".to_string()),
            status: SessionStatus::Active,
            agent: Some(AgentInfo {
                name: Some(agent_name.clone()),
                version: None,
                user_agent: None,
                detected_from: DetectedFrom::Manual,
            }),
            workspace_path: Some(working_dir.clone()),
            tags: vec!["pty".to_string()],
            metadata: Some(json!({
                "pty": true,
                "pid": input.pid,
                "adapter": adapter,
                "verified": verified,
            })),
            ..NewSession::default()
        })?;

        let now = now_iso();
        let (input_tx, _) = watch::channel(0);
        let auto_approve = input
            .command_line
            .as_deref()
            .is_some_and(detect_auto_approve);
        let view = AgentSessionView {
            session_id: session.id.clone(),
            agent_name,
            project_name,
            working_dir,
            adapter,
            verified,
            status: AgentSessionStatus::Running,
            needs_you: false,
            prompt_state: AgentPromptState::Unknown,
            auto_approve,
            model_switch,
            exit_code: None,
            created_at: now.clone(),
            updated_at: now,
            output_sequence: 0,
        };
        {
            let mut inner = self.lock()?;
            inner.sessions.insert(
                session.id.clone(),
                SessionEntry {
                    view: view.clone(),
                    output: String::new(),
                    tail: String::new(),
                    input: VecDeque::new(),
                    input_bytes: 0,
                    next_input_sequence: 0,
                    input_tx,
                    last_detection: None,
                },
            );
        }

        self.live.publish(
            "session.started",
            Some(&session.id),
            None,
            json!({
                "title": session.title,
                "source": session.source.as_str(),
                "captureMode": "pty",
                "status": "active",
                "agentName": view.agent_name,
                "projectName": view.project_name,
            }),
        );
        self.live.publish(
            "agent.started",
            Some(&session.id),
            None,
            json!({ "session": view }),
        );
        Ok(view)
    }

    pub fn list(&self) -> Result<Vec<AgentSessionView>> {
        let inner = self.lock()?;
        let mut sessions: Vec<AgentSessionView> = inner
            .sessions
            .values()
            .map(|entry| entry.view.clone())
            .collect();
        sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(sessions)
    }

    pub fn get(&self, session_id: &str) -> Result<Option<AgentSessionView>> {
        Ok(self
            .lock()?
            .sessions
            .get(session_id)
            .map(|entry| entry.view.clone()))
    }

    pub fn output(&self, session_id: &str) -> Result<Option<AgentOutput>> {
        let inner = self.lock()?;
        Ok(inner.sessions.get(session_id).map(|entry| AgentOutput {
            session: entry.view.clone(),
            output: entry.output.clone(),
        }))
    }

    /// Append a chunk of agent output. The chunk is sanitized here even though
    /// the CLI also owns a real terminal: the daemon must never trust bytes it
    /// received over HTTP.
    pub fn append_output(&self, session_id: &str, data: &str) -> Result<Option<AgentOutput>> {
        let sanitized = sanitize_output(data);
        if sanitized.is_empty() {
            return self.output(session_id);
        }

        let (view, sequence, tail, detection) = {
            let mut inner = self.lock()?;
            let Some(entry) = inner.sessions.get_mut(session_id) else {
                return Ok(None);
            };
            if entry.view.status != AgentSessionStatus::Running {
                return Ok(None);
            }
            entry.output.push_str(&sanitized);
            trim_output(&mut entry.output);
            push_tail(&mut entry.tail, &sanitized);
            entry.view.output_sequence = entry.view.output_sequence.saturating_add(1);
            entry.view.updated_at = now_iso();
            let verified = entry.view.verified;
            let adapter = entry.view.adapter.clone();
            let raw_detection = detect_prompt(&adapter, &entry.tail, verified);
            entry.view.prompt_state = raw_detection
                .as_ref()
                .map(prompt_state_for_detection)
                .unwrap_or(AgentPromptState::Unknown);
            let detection = raw_detection.and_then(|detection| {
                let key = detection_key(&detection);
                let duplicate = entry
                    .last_detection
                    .as_ref()
                    .is_some_and(|(last, at)| last == &key && at.elapsed() < DETECTION_COOLDOWN);
                if duplicate {
                    None
                } else {
                    entry.last_detection = Some((key, std::time::Instant::now()));
                    Some(detection)
                }
            });
            let view = entry.view.clone();
            let sequence = entry.view.output_sequence;
            let tail = entry.tail.clone();
            (view, sequence, tail, detection)
        };

        self.live.publish(
            "agent.output",
            Some(session_id),
            None,
            json!({
                "sessionId": session_id,
                "sequence": sequence,
                "data": sanitized,
            }),
        );

        if let Some(detection) = detection {
            self.apply_detection(&view, &tail, detection)?;
        }
        self.output(session_id)
    }

    fn apply_detection(
        &self,
        view: &AgentSessionView,
        _tail: &str,
        detection: Detection,
    ) -> Result<()> {
        match detection {
            Detection::Event(event_type) => {
                self.record_event(
                    &view.session_id,
                    AgentEventInput {
                        event_type,
                        message: default_message(event_type).to_string(),
                        metadata: Some(json!({
                            "source": "output_detection",
                            "verified": view.verified,
                            "adapter": view.adapter,
                        })),
                    },
                )?;
            }
            Detection::NeedsYou { reason } => {
                {
                    let mut inner = self.lock()?;
                    if let Some(entry) = inner.sessions.get_mut(&view.session_id) {
                        entry.view.needs_you = true;
                        entry.view.updated_at = now_iso();
                    }
                }
                self.live.publish(
                    "agent.needs_you",
                    Some(&view.session_id),
                    None,
                    json!({ "sessionId": view.session_id, "reason": reason }),
                );
            }
            Detection::AwaitingPrompt => {
                self.live.publish(
                    "agent.awaiting_prompt",
                    Some(&view.session_id),
                    None,
                    json!({ "sessionId": view.session_id }),
                );
            }
        }
        Ok(())
    }

    pub fn push_input(&self, session_id: &str, data: &str) -> Result<Option<u64>> {
        if data.contains('\0') {
            return Err(DaemonError::other("terminal input cannot contain NUL"));
        }
        let count = data.chars().count();
        if count == 0 {
            return Ok(None);
        }
        if count > MAX_INPUT_CHUNK_CHARS {
            return Err(DaemonError::other("that keystroke batch is too large"));
        }
        let bytes = data.len();
        let (sequence, sender) = {
            let mut inner = self.lock()?;
            let Some(entry) = inner.sessions.get_mut(session_id) else {
                return Ok(None);
            };
            if entry.view.status != AgentSessionStatus::Running {
                return Err(DaemonError::other("the agent session has already ended"));
            }
            if entry.input_bytes + bytes > MAX_INPUT_QUEUE_BYTES {
                return Err(DaemonError::other(
                    "the agent is not reading input fast enough",
                ));
            }
            let sequence = entry.next_input_sequence;
            entry.next_input_sequence = entry.next_input_sequence.saturating_add(1);
            entry.input_bytes += bytes;
            entry.input.push_back(InputChunk {
                sequence,
                data: data.to_string(),
            });
            entry.view.needs_you = false;
            entry.view.prompt_state = AgentPromptState::Unknown;
            entry.view.updated_at = now_iso();
            (sequence, entry.input_tx.clone())
        };
        let _ = sender.send(sequence);
        Ok(Some(sequence))
    }

    /// Queue a model switch for a PTY agent, or explain how the host should do
    /// it manually. Hook and log-watch flights never have a terminal, so they
    /// always fall back to instructions.
    pub fn switch_model(
        &self,
        session_id: &str,
        adapter_id: Option<&str>,
        model: &str,
    ) -> Result<ModelSwitchOutcome> {
        let adapter = adapter_id.and_then(|id| self.registry.find(id));
        let adapter_name = adapter
            .map(|adapter| adapter.name.clone())
            .unwrap_or_else(|| "This agent".to_string());
        let command = adapter.and_then(|adapter| adapter.model_switch_command(model));
        let has_terminal = {
            let inner = self.lock()?;
            inner.sessions.contains_key(session_id)
        };

        if let Some(command) = command {
            if has_terminal {
                self.push_input(session_id, &format!("{command}\n"))?;
                return Ok(ModelSwitchOutcome {
                    mode: "pty",
                    model: model.to_string(),
                    command: Some(command.clone()),
                    instructions: format!(
                        "{} sent `{command}` to {adapter_name}.",
                        brand::PRODUCT_NAME
                    ),
                });
            }
            return Ok(ModelSwitchOutcome {
                mode: "manual",
                model: model.to_string(),
                command: Some(command.clone()),
                instructions: format!("Run `{command}` in {adapter_name} to switch models."),
            });
        }

        Ok(ModelSwitchOutcome {
            mode: "manual",
            model: model.to_string(),
            command: None,
            instructions: format!(
                "{adapter_name} has no verified model switch. Change the model inside the agent, then start a new flight."
            ),
        })
    }

    /// Long-poll for queued keystrokes. The CLI calls this while it waits for
    /// local input; the response also reports when the session has ended.
    pub async fn wait_for_input(
        &self,
        session_id: &str,
        after: u64,
        wait: Duration,
    ) -> Result<Option<InputPoll>> {
        let deadline = tokio::time::Instant::now() + wait.min(Duration::from_secs(30));
        let mut receiver = {
            let inner = self.lock()?;
            let Some(entry) = inner.sessions.get(session_id) else {
                return Ok(None);
            };
            entry.input_tx.subscribe()
        };

        loop {
            if let Some(poll) = self.read_input(session_id, after)? {
                return Ok(Some(poll));
            }
            if tokio::time::Instant::now() >= deadline {
                return self.read_input(session_id, after);
            }
            tokio::select! {
                changed = receiver.changed() => {
                    if changed.is_err() {
                        return self.read_input(session_id, after);
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return self.read_input(session_id, after);
                }
            }
        }
    }

    fn read_input(&self, session_id: &str, after: u64) -> Result<Option<InputPoll>> {
        let mut inner = self.lock()?;
        let Some(entry) = inner.sessions.get_mut(session_id) else {
            return Ok(None);
        };
        // `after` is the first sequence the CLI still needs. Everything below
        // it has been delivered and acknowledged, so drop it and release the
        // queue budget. Without this drain the input queue fills up and every
        // later keystroke is rejected.
        let mut freed = 0usize;
        while let Some(front) = entry.input.front() {
            if front.sequence >= after {
                break;
            }
            if let Some(chunk) = entry.input.pop_front() {
                freed += chunk.data.len();
            }
        }
        entry.input_bytes = entry.input_bytes.saturating_sub(freed);

        let chunks: Vec<InputChunk> = entry
            .input
            .iter()
            .filter(|chunk| chunk.sequence >= after)
            .cloned()
            .collect();
        Ok(Some(InputPoll {
            chunks,
            status: entry.view.status,
            needs_you: entry.view.needs_you,
            output_sequence: entry.view.output_sequence,
        }))
    }

    pub fn end(&self, session_id: &str, input: EndAgentInput) -> Result<Option<AgentSessionView>> {
        let (view, sender) = {
            let mut inner = self.lock()?;
            let Some(entry) = inner.sessions.get_mut(session_id) else {
                return Ok(None);
            };
            if entry.view.status == AgentSessionStatus::Running {
                entry.view.status = if input.killed {
                    AgentSessionStatus::Killed
                } else {
                    AgentSessionStatus::Exited
                };
                entry.view.exit_code = input.exit_code;
                entry.view.updated_at = now_iso();
                entry.input.clear();
                entry.input_bytes = 0;
            }
            (entry.view.clone(), entry.input_tx.clone())
        };
        let _ = sender.send(u64::MAX);

        let status = match view.status {
            AgentSessionStatus::Killed => SessionStatus::Killed,
            AgentSessionStatus::Exited if input.exit_code.unwrap_or(0) == 0 => {
                SessionStatus::Completed
            }
            AgentSessionStatus::Exited => SessionStatus::Failed,
            AgentSessionStatus::Running => SessionStatus::Active,
        };
        if status != SessionStatus::Active {
            self.store.end_session(session_id, status)?;
        }

        // Every finished session leaves one typed event behind, so the Inbox
        // has a durable record even if nobody was watching the terminal.
        let event_type =
            if view.status == AgentSessionStatus::Killed || input.exit_code.unwrap_or(0) != 0 {
                AgentEventType::Error
            } else {
                AgentEventType::Done
            };
        let message = match (event_type, view.status) {
            (AgentEventType::Done, _) => "The agent finished.".to_string(),
            (_, AgentSessionStatus::Killed) => "The agent session was stopped.".to_string(),
            _ => "The agent exited with an error.".to_string(),
        };
        let _ = self.record_event(
            session_id,
            AgentEventInput {
                event_type,
                message,
                metadata: Some(json!({
                    "source": "pty_exit",
                    "exitCode": view.exit_code,
                    "killed": view.status == AgentSessionStatus::Killed,
                })),
            },
        );

        self.live.publish(
            "agent.ended",
            Some(session_id),
            None,
            json!({
                "sessionId": session_id,
                "status": view.status,
                "exitCode": view.exit_code,
            }),
        );
        self.live.publish(
            "session.ended",
            Some(session_id),
            None,
            json!({ "status": status.as_str() }),
        );
        Ok(Some(view))
    }

    pub fn record_event(
        &self,
        session_id: &str,
        input: AgentEventInput,
    ) -> Result<Option<AgentEvent>> {
        let view = {
            let inner = self.lock()?;
            inner
                .sessions
                .get(session_id)
                .map(|entry| entry.view.clone())
        };
        let Some(view) = view else {
            return Ok(None);
        };
        self.record_event_for(session_id, &view.agent_name, &view.project_name, input)
    }

    /// Record an event for a flight that is not backed by a registered agent
    /// terminal (for example a proxy flight). The caller supplies the labels so
    /// the same persistence, live-bus, and toast path is used.
    pub fn record_event_for(
        &self,
        session_id: &str,
        agent_name: &str,
        project_name: &str,
        input: AgentEventInput,
    ) -> Result<Option<AgentEvent>> {
        let mut input = input;
        input.message = sanitize_output(&input.message)
            .chars()
            .take(MAX_MESSAGE_CHARS)
            .collect();
        if input.message.trim().is_empty() {
            input.message = default_message(input.event_type).to_string();
        }
        if let Some(metadata) = &input.metadata
            && serde_json::to_string(metadata)
                .map(|value| value.len())
                .unwrap_or(0)
                > 8_192
        {
            input.metadata = None;
        }
        let event = self
            .store
            .insert_agent_event(session_id, agent_name, project_name, &input)?;
        self.live.publish(
            "agent.event",
            Some(session_id),
            None,
            json!({ "event": event }),
        );
        self.notify(&event);
        Ok(Some(event))
    }

    fn notify(&self, event: &AgentEvent) {
        if !self.notifications || self.demo_mode {
            return;
        }
        // Starting a session is not worth interrupting the user for. Only
        // attention events and finished/error events produce a toast.
        if !(event.event_type.needs_you()
            || matches!(
                event.event_type,
                AgentEventType::Done | AgentEventType::Error
            ))
        {
            return;
        }
        let toast_enabled = self
            .store
            .get_setting("notify.toast")
            .ok()
            .flatten()
            .map(|value| setting_is_on(&value))
            .unwrap_or(true);
        if !toast_enabled {
            return;
        }
        let payload = NotificationPayload {
            event_type: event.event_type.as_str().to_string(),
            agent_name: event.agent_name.clone(),
            project_name: event.project_name.clone(),
        };
        // The payload has no message field on purpose. See docs/security.md.
        tokio::task::spawn_blocking(move || show_toast(&payload));
    }

    pub fn acknowledge(&self, event_id: &str) -> Result<Option<AgentEvent>> {
        let event = self.store.acknowledge_agent_event(event_id)?;
        if let Some(event) = &event {
            self.live.publish(
                "agent.event.acknowledged",
                Some(&event.session_id),
                None,
                json!({ "id": event.id }),
            );
        }
        Ok(event)
    }

    /// Seed one live PTY session and a few inbox events for demo mode. This is
    /// stored in SQLite and marked `demo: true`, never presented as real work.
    pub fn seed_demo(&self) -> Result<()> {
        if self.store.get_setting("demo.agents.seeded")?.is_some() {
            return Ok(());
        }
        let session = self.store.create_session(NewSession {
            title: "Claude Code · checkout-service".to_string(),
            source: SessionSource::Demo,
            capture_mode: CaptureMode::Pty,
            source_label: Some("Live PTY session".to_string()),
            status: SessionStatus::Active,
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-5-5".to_string()),
            agent: Some(AgentInfo {
                name: Some("Claude Code".to_string()),
                version: Some("2.1.0".to_string()),
                user_agent: None,
                detected_from: DetectedFrom::Demo,
            }),
            workspace_path: Some("~/projects/checkout-service".to_string()),
            git_branch: Some("feature/auth-cleanup".to_string()),
            tags: vec!["demo".to_string(), "pty".to_string()],
            metadata: Some(json!({ "demo": true, "pty": true })),
            ..NewSession::default()
        })?;
        let now = now_iso();
        let (input_tx, _) = watch::channel(0);
        let view = AgentSessionView {
            session_id: session.id.clone(),
            agent_name: "Claude Code".to_string(),
            project_name: "checkout-service".to_string(),
            working_dir: "~/projects/checkout-service".to_string(),
            adapter: "claude-code".to_string(),
            verified: false,
            status: AgentSessionStatus::Running,
            needs_you: true,
            prompt_state: AgentPromptState::Permission,
            auto_approve: false,
            model_switch: model_switch_support(self.registry.find("claude-code")),
            exit_code: None,
            created_at: now.clone(),
            updated_at: now,
            output_sequence: 0,
        };
        {
            let mut inner = self.lock()?;
            inner.sessions.insert(
                session.id.clone(),
                SessionEntry {
                    view: view.clone(),
                    output: String::new(),
                    tail: String::new(),
                    input: VecDeque::new(),
                    input_bytes: 0,
                    next_input_sequence: 0,
                    input_tx,
                    last_detection: None,
                },
            );
        }
        let demo_output = concat!(
            "\u{1b}[2mClaude Code v2.1.0\u{1b}[0m\r\n",
            "Workspace  ~/projects/checkout-service\r\n",
            "Branch     feature/auth-cleanup\r\n",
            "\r\n",
            "> Refactor the auth middleware and run the tests.\r\n",
            "\r\n",
            "\u{1b}[36m●\u{1b}[0m Read src/auth/middleware.rs\r\n",
            "\u{1b}[36m●\u{1b}[0m Edit src/auth/session.rs\r\n",
            "\u{1b}[36m●\u{1b}[0m Edit src/auth/token.rs\r\n",
            "\u{1b}[36m●\u{1b}[0m Ran cargo test auth\r\n",
            "   18 passed, 0 failed\r\n",
            "\r\n",
            "The middleware is now split into session.rs and token.rs.\r\n",
            "Do you want to proceed with the file writes? [y/N]\r\n",
        );
        self.append_output(&session.id, demo_output)?;
        self.record_event(
            &session.id,
            AgentEventInput {
                event_type: AgentEventType::Permission,
                message: "Permission requested: write 3 files.".to_string(),
                metadata: Some(json!({ "demo": true, "source": "demo" })),
            },
        )?;

        // Recorded flights are not live PTY sessions, so their demo events are
        // inserted directly instead of going through the control plane.
        if let Some(gemini) = self
            .store
            .list_sessions(20, 0, None)?
            .into_iter()
            .find(|session| {
                session
                    .agent
                    .as_ref()
                    .and_then(|agent| agent.name.as_deref())
                    == Some("Gemini CLI")
            })
        {
            let agent_name = gemini
                .agent
                .as_ref()
                .and_then(|agent| agent.name.clone())
                .unwrap_or_else(|| "Gemini CLI".to_string());
            let project_name = gemini
                .workspace_path
                .as_deref()
                .map(project_from_path)
                .unwrap_or_else(|| "workspace".to_string());
            self.store.insert_agent_event(
                &gemini.id,
                &agent_name,
                &project_name,
                &AgentEventInput {
                    event_type: AgentEventType::AuthRequired,
                    message: "Needs you at the computer to sign in.".to_string(),
                    metadata: Some(json!({ "demo": true, "source": "demo" })),
                },
            )?;
        }
        if let Some(codex) = self
            .store
            .list_sessions(20, 0, None)?
            .into_iter()
            .find(|session| {
                session
                    .agent
                    .as_ref()
                    .and_then(|agent| agent.name.as_deref())
                    == Some("Codex CLI")
            })
        {
            let agent_name = codex
                .agent
                .as_ref()
                .and_then(|agent| agent.name.clone())
                .unwrap_or_else(|| "Codex CLI".to_string());
            let project_name = codex
                .workspace_path
                .as_deref()
                .map(project_from_path)
                .unwrap_or_else(|| "workspace".to_string());
            self.store.insert_agent_event(
                &codex.id,
                &agent_name,
                &project_name,
                &AgentEventInput {
                    event_type: AgentEventType::Done,
                    message: "Finished the auth refactor.".to_string(),
                    metadata: Some(json!({ "demo": true, "source": "demo" })),
                },
            )?;
        }

        self.store.set_setting("demo.agents.seeded", &now_iso())?;
        Ok(())
    }
}

fn clean_label(value: &str, max: usize, fallback: &str) -> String {
    let cleaned = sanitize_output(value)
        .replace('\n', " ")
        .trim()
        .chars()
        .take(max)
        .collect::<String>();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn project_from_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "workspace".to_string())
}

fn setting_is_on(value: &str) -> bool {
    !matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "no" | "off"
    )
}

fn push_tail(tail: &mut String, text: &str) {
    tail.push_str(text);
    if tail.len() > TAIL_BYTES {
        let mut cut = tail.len() - TAIL_BYTES;
        while cut < tail.len() && !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
}

fn trim_output(output: &mut String) {
    const PREFIX: &str = "… earlier output trimmed …\n";
    if output.len() <= MAX_OUTPUT_BYTES {
        return;
    }
    let keep = MAX_OUTPUT_BYTES.saturating_sub(PREFIX.len());
    let mut cut = output.len().saturating_sub(keep);
    while cut < output.len() && !output.is_char_boundary(cut) {
        cut += 1;
    }
    let tail = output[cut..].to_string();
    output.clear();
    output.push_str(PREFIX);
    output.push_str(&tail);
}

/// A conservative terminal sanitizer. It understands enough of ANSI/VT to
/// remove color, cursor movement, OSC titles, and other control sequences
/// without letting a malformed sequence swallow the rest of the stream.
pub fn sanitize_output(input: &str) -> String {
    let mut cleaned = String::with_capacity(input.len());
    let mut characters = input.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\u{1b}' => match characters.peek() {
                Some('[') => {
                    characters.next();
                    for item in characters.by_ref() {
                        if ('@'..='~').contains(&item) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    characters.next();
                    let mut previous_escape = false;
                    for item in characters.by_ref() {
                        if item == '\u{7}' {
                            break;
                        }
                        if previous_escape && item == '\\' {
                            break;
                        }
                        previous_escape = item == '\u{1b}';
                    }
                }
                Some('P' | 'X' | '^' | '_') => {
                    characters.next();
                    let mut previous_escape = false;
                    for item in characters.by_ref() {
                        if previous_escape && item == '\\' {
                            break;
                        }
                        previous_escape = item == '\u{1b}';
                    }
                }
                Some(_) => {
                    characters.next();
                }
                None => {}
            },
            '\r' => {
                if characters.peek() != Some(&'\n') {
                    cleaned.push('\n');
                }
            }
            '\n' => cleaned.push('\n'),
            '\t' => cleaned.push_str("    "),
            character if character.is_control() => {}
            character if is_bidi_control(character) => {}
            character => cleaned.push(character),
        }
    }

    let mut result = String::with_capacity(cleaned.len());
    for (index, line) in cleaned.split('\n').enumerate() {
        if index > 0 {
            result.push('\n');
        }
        let count = line.chars().count();
        if count > MAX_LINE_CHARS {
            result.extend(line.chars().take(MAX_LINE_CHARS));
            result.push('…');
        } else {
            result.push_str(line);
        }
    }
    result
}

fn is_bidi_control(character: char) -> bool {
    matches!(
        character,
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}'
    )
}

/// Detect adapter flags that turn off the agent's own approval prompts. These
/// sessions are still allowed to receive remote prompts, but the host must
/// confirm every single one.
pub fn detect_auto_approve(command_line: &str) -> bool {
    let lower = command_line.to_ascii_lowercase();
    [
        "dangerously-skip-permissions",
        "skip-permissions",
        "dangerously-bypass-approvals",
        "--yolo",
        "--yes-always",
        "--auto-approve",
        "--full-auto",
        "-a never",
        "approval_policy=never",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Detection {
    Event(AgentEventType),
    NeedsYou {
        reason: &'static str,
    },
    /// The agent explicitly asked the user to type a response. This is the
    /// only state in which a remote prompt may be sent.
    AwaitingPrompt,
}

fn detection_key(detection: &Detection) -> String {
    match detection {
        Detection::Event(event_type) => format!("event:{}", event_type.as_str()),
        Detection::NeedsYou { reason } => format!("needs:{reason}"),
        Detection::AwaitingPrompt => "awaiting_prompt".to_string(),
    }
}

fn prompt_state_for_detection(detection: &Detection) -> AgentPromptState {
    match detection {
        Detection::Event(AgentEventType::Permission) => AgentPromptState::Permission,
        Detection::Event(AgentEventType::Choice) => AgentPromptState::Choice,
        Detection::Event(AgentEventType::Question) => AgentPromptState::Question,
        Detection::Event(AgentEventType::AuthRequired) => AgentPromptState::Auth,
        Detection::NeedsYou { reason } => match *reason {
            "permission" => AgentPromptState::Permission,
            "choice" => AgentPromptState::Choice,
            "question" => AgentPromptState::Question,
            "auth" => AgentPromptState::Auth,
            _ => AgentPromptState::Unknown,
        },
        Detection::AwaitingPrompt => AgentPromptState::AwaitingPrompt,
        Detection::Event(_) => AgentPromptState::Unknown,
    }
}

/// Detect a small, explicit set of prompts. Unverified adapters never get a
/// typed event: they are marked "needs you" so the UI asks a human instead of
/// guessing what the agent wants.
pub fn detect_prompt(adapter: &str, tail: &str, verified: bool) -> Option<Detection> {
    let recent: String = {
        let mut characters: Vec<char> = tail.chars().rev().take(800).collect();
        characters.reverse();
        characters.into_iter().collect()
    };
    let lower = recent.to_ascii_lowercase();
    let trimmed = lower.trim_end();

    const AUTH: &[&str] = &[
        "please log in",
        "please login",
        "please sign in",
        "authentication required",
        "api key is required",
        "invalid api key",
        "set your api key",
        "paste your api key",
        "oauth token",
        "authorize this device",
    ];
    if AUTH.iter().any(|pattern| trimmed.contains(pattern)) {
        return Some(if verified {
            Detection::Event(AgentEventType::AuthRequired)
        } else {
            Detection::NeedsYou { reason: "auth" }
        });
    }

    let adapter_name = adapter.to_ascii_lowercase();
    let adapter_patterns: &[&str] = if adapter_name.contains("claude") {
        &[
            "do you want to proceed",
            "allow this tool",
            "permission to use",
            "would you like to",
        ]
    } else if adapter_name.contains("codex") {
        &[
            "allow command",
            "approve command",
            "would you like to run",
            "do you want to run",
        ]
    } else if adapter_name.contains("aider") {
        &[
            "(y)es/(n)o",
            "add these files to the chat",
            "apply these changes",
        ]
    } else if adapter_name.contains("gemini") {
        &[
            "do you want to continue",
            "allow this action",
            "approve this plan",
        ]
    } else {
        &[]
    };

    const GENERIC_PERMISSION: &[&str] = &[
        "do you want to proceed",
        "do you want to continue",
        "allow this action",
        "allow this command",
        "approve this command",
        "permission required",
        "waiting for permission",
        "[y/n]",
        "(y/n)",
        "[y/n]",
        "yes/no",
    ];
    let permission = adapter_patterns
        .iter()
        .chain(GENERIC_PERMISSION.iter())
        .any(|pattern| trimmed.contains(pattern));
    if permission {
        return Some(if verified {
            Detection::Event(AgentEventType::Permission)
        } else {
            Detection::NeedsYou {
                reason: "permission",
            }
        });
    }

    const CHOICE: &[&str] = &[
        "select an option",
        "choose an option",
        "pick one",
        "press 1",
        "enter a number",
    ];
    if CHOICE.iter().any(|pattern| trimmed.contains(pattern)) {
        return Some(if verified {
            Detection::Event(AgentEventType::Choice)
        } else {
            Detection::NeedsYou { reason: "choice" }
        });
    }

    const STUCK: &[&str] = &[
        "waiting for your input",
        "press enter to continue",
        "type your response",
        "awaiting input",
    ];
    if STUCK.iter().any(|pattern| trimmed.contains(pattern)) {
        // These are explicit "type here" prompts, not permission questions.
        return Some(Detection::AwaitingPrompt);
    }

    if trimmed.ends_with('?') {
        return Some(if verified {
            Detection::Event(AgentEventType::Question)
        } else {
            Detection::NeedsYou { reason: "question" }
        });
    }

    None
}

fn default_message(event_type: AgentEventType) -> &'static str {
    match event_type {
        AgentEventType::Started => "The agent started.",
        AgentEventType::Done => "The agent finished.",
        AgentEventType::Permission => "The agent is waiting for permission.",
        AgentEventType::Question => "The agent asked a question.",
        AgentEventType::Choice => "The agent is waiting for a choice.",
        AgentEventType::AuthRequired => "Needs you at the computer to sign in.",
        AgentEventType::Error => "The agent reported an error.",
        AgentEventType::Stuck => "The agent may be stuck.",
        AgentEventType::BudgetWarn => "A budget threshold was reached.",
        AgentEventType::ContextHigh => "The agent context is nearly full.",
    }
}

#[cfg(windows)]
fn event_label(event_type: &str) -> &'static str {
    match event_type {
        "agent.started" => "started",
        "done" => "finished",
        "permission" => "needs permission",
        "question" => "has a question",
        "choice" => "needs a choice",
        "auth_required" => "needs you at the computer",
        "error" => "hit an error",
        "stuck" => "may be stuck",
        "budget.warn" => "reached a budget limit",
        "context.high" => "is running low on context",
        _ => "needs you",
    }
}

#[cfg(windows)]
fn show_toast(payload: &NotificationPayload) {
    use tauri_winrt_notification::Toast;
    let line = format!(
        "{} {}",
        payload.agent_name,
        event_label(&payload.event_type)
    );
    if let Err(error) = Toast::new(Toast::POWERSHELL_APP_ID)
        .title(brand::NOTIFICATION_TITLE)
        .text1(&line)
        .text2(&payload.project_name)
        .show()
    {
        tracing::debug!(%error, "could not show a Windows notification");
    }
}

#[cfg(not(windows))]
fn show_toast(payload: &NotificationPayload) {
    tracing::debug!(
        agent = %payload.agent_name,
        project = %payload.project_name,
        event = %payload.event_type,
        "desktop notifications are only implemented on Windows"
    );
}

/// The public projection of an agent event, safe to expose to the UI.
pub fn agent_event_payload(event: &AgentEvent) -> Value {
    json!({
        "id": event.id,
        "sessionId": event.session_id,
        "agentName": event.agent_name,
        "projectName": event.project_name,
        "type": event.event_type,
        "message": event.message,
        "status": event.status,
        "createdAt": event.created_at,
        "acknowledgedAt": event.acknowledged_at,
    })
}

pub fn open_agent_events(store: &Store, limit: u32) -> Result<Vec<AgentEvent>> {
    store.list_agent_events(Some(AgentEventStatus::Open), limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_colors_and_cursor_movement() {
        assert_eq!(sanitize_output("\u{1b}[31mred\u{1b}[0m plain"), "red plain");
        assert_eq!(sanitize_output("before\u{1b}[2K\rafter"), "before\nafter");
        assert_eq!(
            sanitize_output("\u{1b}]0;spoofed title\u{7}visible"),
            "visible"
        );
        assert_eq!(
            sanitize_output("\u{1b}]8;;https://evil.example\u{1b}\\link"),
            "link"
        );
    }

    #[test]
    fn drops_incomplete_and_malformed_sequences() {
        assert_eq!(sanitize_output("keep\u{1b}[999"), "keep");
        assert_eq!(sanitize_output("keep\u{1b}"), "keep");
        assert_eq!(sanitize_output("keep\u{1b}]0;never ends"), "keep");
        assert_eq!(sanitize_output("a\u{7}b\u{8}c\u{0}d"), "abcd");
    }

    #[test]
    fn removes_bidi_and_control_characters() {
        assert_eq!(
            sanitize_output("safe\u{202E}txet\u{2066} text"),
            "safetxet text"
        );
        assert_eq!(sanitize_output("line\u{85}break"), "linebreak");
    }

    #[test]
    fn caps_line_length() {
        let long = "x".repeat(MAX_LINE_CHARS + 50);
        let sanitized = sanitize_output(&long);
        assert_eq!(sanitized.chars().count(), MAX_LINE_CHARS + 1);
        assert!(sanitized.ends_with('…'));
    }

    #[test]
    fn caps_output_buffer() {
        let mut output = "x".repeat(MAX_OUTPUT_BYTES + 10_000);
        trim_output(&mut output);
        assert!(output.len() <= MAX_OUTPUT_BYTES);
        assert!(output.starts_with("… earlier output trimmed …"));
    }

    #[test]
    fn detects_claude_permission_fixture() {
        let tail = "Do you want to proceed with the file writes? [y/N]";
        assert_eq!(
            detect_prompt("claude-code", tail, true),
            Some(Detection::Event(AgentEventType::Permission))
        );
        assert_eq!(
            detect_prompt("claude-code", tail, false),
            Some(Detection::NeedsYou {
                reason: "permission"
            })
        );
    }

    #[test]
    fn detects_codex_and_gemini_fixtures() {
        assert_eq!(
            detect_prompt("codex", "Allow command execution? [y/N]", true),
            Some(Detection::Event(AgentEventType::Permission))
        );
        assert_eq!(
            detect_prompt("gemini-cli", "Do you want to continue? (y/n)", true),
            Some(Detection::Event(AgentEventType::Permission))
        );
        assert_eq!(
            detect_prompt("gemini-cli", "Approve this plan? [y/N]", false),
            Some(Detection::NeedsYou {
                reason: "permission"
            })
        );
    }

    #[test]
    fn detects_auth_fixtures_without_guessing() {
        assert_eq!(
            detect_prompt("claude-code", "Please log in to continue.", true),
            Some(Detection::Event(AgentEventType::AuthRequired))
        );
        assert_eq!(
            detect_prompt("aider", "Invalid API key. Set your API key first.", false),
            Some(Detection::NeedsYou { reason: "auth" })
        );
    }

    #[test]
    fn detects_question_only_when_verified() {
        let tail = "Which migration should I run?";
        assert_eq!(
            detect_prompt("codex", tail, true),
            Some(Detection::Event(AgentEventType::Question))
        );
        assert_eq!(
            detect_prompt("codex", tail, false),
            Some(Detection::NeedsYou { reason: "question" })
        );
    }

    #[test]
    fn explicit_type_prompts_are_the_only_awaiting_state() {
        assert_eq!(
            detect_prompt("claude-code", "Type your response and press Enter", true),
            Some(Detection::AwaitingPrompt)
        );
        assert_eq!(
            detect_prompt("codex", "Waiting for your input", false),
            Some(Detection::AwaitingPrompt)
        );
        assert_eq!(
            detect_prompt("claude-code", "Do you want to proceed? [y/N]", true),
            Some(Detection::Event(AgentEventType::Permission))
        );
        assert_eq!(
            detect_prompt("claude-code", "Which migration should I run?", true),
            Some(Detection::Event(AgentEventType::Question))
        );
    }

    #[test]
    fn auto_approve_flags_are_detected() {
        assert!(detect_auto_approve("claude --dangerously-skip-permissions"));
        assert!(detect_auto_approve("gemini --yolo"));
        assert!(detect_auto_approve("aider --yes-always"));
        assert!(!detect_auto_approve("claude"));
    }

    #[test]
    fn every_detection_maps_to_the_expected_prompt_state() {
        let states = [
            (
                Detection::Event(AgentEventType::Permission),
                AgentPromptState::Permission,
            ),
            (
                Detection::Event(AgentEventType::Choice),
                AgentPromptState::Choice,
            ),
            (
                Detection::Event(AgentEventType::Question),
                AgentPromptState::Question,
            ),
            (
                Detection::Event(AgentEventType::AuthRequired),
                AgentPromptState::Auth,
            ),
            (
                Detection::NeedsYou { reason: "auth" },
                AgentPromptState::Auth,
            ),
            (
                Detection::NeedsYou {
                    reason: "permission",
                },
                AgentPromptState::Permission,
            ),
            (
                Detection::NeedsYou { reason: "choice" },
                AgentPromptState::Choice,
            ),
            (
                Detection::NeedsYou { reason: "question" },
                AgentPromptState::Question,
            ),
            (Detection::AwaitingPrompt, AgentPromptState::AwaitingPrompt),
            (
                Detection::Event(AgentEventType::Stuck),
                AgentPromptState::Unknown,
            ),
        ];
        for (detection, expected) in states {
            assert_eq!(prompt_state_for_detection(&detection), expected);
        }
        assert!(AgentPromptState::AwaitingPrompt.is_awaiting_prompt());
        for state in [
            AgentPromptState::Permission,
            AgentPromptState::Choice,
            AgentPromptState::Question,
            AgentPromptState::Auth,
            AgentPromptState::Unknown,
        ] {
            assert!(!state.is_awaiting_prompt());
        }
    }

    #[test]
    fn ignores_ordinary_output() {
        assert_eq!(
            detect_prompt("claude-code", "18 tests passed, 0 failed", true),
            None
        );
    }

    #[test]
    fn notification_payload_has_no_content_fields() {
        let payload = NotificationPayload {
            event_type: "permission".to_string(),
            agent_name: "Claude Code".to_string(),
            project_name: "checkout-service".to_string(),
        };
        let value = serde_json::to_value(&payload).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert!(object.contains_key("eventType"));
        assert!(object.contains_key("agentName"));
        assert!(object.contains_key("projectName"));
        assert!(!object.contains_key("message"));
        assert!(!object.contains_key("prompt"));
        assert!(!object.contains_key("code"));
    }
}
