use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use cockpit_core::agent::{AgentEventInput, AgentEventType};
use cockpit_core::collector::{CollectedResponse, IngestedEvent, ProtocolCollector};
use cockpit_core::context::{ContextMeter, build_context_meter, parse_context_threshold};
use cockpit_core::cost::{ModelPricing, estimate_usage_cost, resolve_model_pricing};
use cockpit_core::model::{
    CapturedRequest, FinishReason, Step, StepKind, StepStatus, StreamChunk, ToolCall,
    ToolCallStatus,
};
use cockpit_core::provider::ProviderProtocol;
use cockpit_core::redact::{
    CaptureLocation, RedactionCollector, redact_headers, redact_json, redact_text,
};
use cockpit_core::request_meta::extract_request_metadata;
use cockpit_core::sse::SseEvent;
use cockpit_core::text::{
    MAX_RESPONSE_CHARS, MAX_STREAM_DATA_CHARS, MAX_STREAM_DELTA_CHARS, MAX_THINKING_CHARS,
    append_limited, extract_file_paths, parse_json_body, truncate_text,
};
use serde_json::{Value, json};

use crate::agents::AgentControl;
use crate::error::Result;
use crate::guards::{GuardService, GuardStepInput};
use crate::live::LiveBus;
use crate::remote::RemoteAccess;
use crate::sessions::totals_payload;
use crate::snapshots::GitSnapshotService;
use crate::store::{BeginStep, CompleteStep, Store, now_iso};

const MAX_STORED_CHUNK_BYTES: usize = 32 * 1024 * 1024;

pub struct BeginRecordedStep {
    pub session_id: String,
    pub protocol: ProviderProtocol,
    pub provider: Option<String>,
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body_text: String,
}

pub struct FinishRecordedStep {
    pub status: StepStatus,
    pub response_status: u16,
    pub response_headers: BTreeMap<String, String>,
    pub collected: Option<CollectedResponse>,
    pub error: Option<String>,
    pub ttft_ms: Option<u64>,
    /// Host-only model/effort override that was applied to the forwarded
    /// request. `None` means the request was forwarded byte-identically.
    pub override_info: Option<Value>,
}

pub struct RecordedStep {
    pub step: Step,
    collector: ProtocolCollector,
    redactions: RedactionCollector,
    started_at: Instant,
    model: Option<String>,
    first_byte_at: Option<Instant>,
    chunk_seq: u64,
    chunks: Vec<StreamChunk>,
    stored_chunk_bytes: usize,
    finalized: bool,
}

impl RecordedStep {
    pub fn step_id(&self) -> &str {
        &self.step.id
    }

    pub fn session_id(&self) -> &str {
        &self.step.session_id
    }
}

/// Records proxy traffic into SQLite and the live bus.
///
/// Every operation is fail-open at the call site: the proxy logs a recording
/// error and continues forwarding bytes.
pub struct Recorder {
    store: Arc<Store>,
    bus: Arc<LiveBus>,
    guards: Option<Arc<GuardService>>,
    snapshots: Option<Arc<GitSnapshotService>>,
    agents: Option<Arc<AgentControl>>,
    remote: Option<Arc<RemoteAccess>>,
}

impl Recorder {
    pub fn new(
        store: Arc<Store>,
        bus: Arc<LiveBus>,
        guards: Option<Arc<GuardService>>,
        snapshots: Option<Arc<GitSnapshotService>>,
        agents: Option<Arc<AgentControl>>,
        remote: Option<Arc<RemoteAccess>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            bus,
            guards,
            snapshots,
            agents,
            remote,
        })
    }

    pub fn begin(&self, input: BeginRecordedStep) -> Result<RecordedStep> {
        let mut redactions = RedactionCollector::new();
        let captured_headers = redact_headers(
            &input.headers,
            &mut redactions,
            CaptureLocation::RequestHeaders,
        );
        let parsed = parse_json_body(&input.body_text);
        let captured_body = match (&parsed.value, parsed.is_json) {
            (Some(value), true) => Some(redact_json(
                value,
                &mut redactions,
                CaptureLocation::RequestBody,
            )),
            _ if !parsed.text.is_empty() => Some(Value::String(redact_text(
                &parsed.text,
                &mut redactions,
                CaptureLocation::RequestBody,
            ))),
            _ => None,
        };

        let metadata =
            extract_request_metadata(input.protocol, &input.path, captured_body.as_ref());
        let request_redaction_count = redactions.total(Some(CaptureLocation::RequestHeaders))
            + redactions.total(Some(CaptureLocation::RequestBody));

        let request = CapturedRequest {
            protocol: input.protocol,
            method: truncate_text(&input.method, 16),
            path: truncate_text(&input.path, 2048),
            model: metadata.model.clone(),
            stream: metadata.stream,
            headers: captured_headers,
            body: captured_body,
            system_prompt: metadata.system_prompt.clone(),
            prompt_text: metadata.prompt_text.clone(),
            redaction_count: request_redaction_count,
        };

        let step = self.store.begin_step(BeginStep {
            session_id: input.session_id.clone(),
            kind: StepKind::Model,
            provider: input.provider.clone(),
            model: metadata.model.clone(),
            request,
        })?;

        self.bus.publish(
            "step.started",
            Some(&input.session_id),
            Some(&step.id),
            json!({
                "seq": step.seq,
                "kind": step.kind.as_str(),
                "protocol": input.protocol.as_str(),
                "provider": input.provider,
                "model": metadata.model,
                "stream": metadata.stream,
            }),
        );

        if let Some(snapshots) = &self.snapshots {
            snapshots.note_step_started(&input.session_id, &step.id);
        }

        Ok(RecordedStep {
            step,
            collector: ProtocolCollector::new(input.protocol, &input.path),
            redactions,
            started_at: Instant::now(),
            model: metadata.model,
            first_byte_at: None,
            chunk_seq: 0,
            chunks: Vec::new(),
            stored_chunk_bytes: 0,
            finalized: false,
        })
    }

    pub fn record_stream_event(
        &self,
        handle: &mut RecordedStep,
        event: &SseEvent,
    ) -> IngestedEvent {
        let ingested = handle.collector.ingest(event);
        let seq = handle.chunk_seq;
        handle.chunk_seq += 1;

        if handle.stored_chunk_bytes < MAX_STORED_CHUNK_BYTES {
            let data = truncate_text(&event.raw, MAX_STREAM_DATA_CHARS);
            let delta_text = ingested
                .delta_text
                .as_deref()
                .map(|delta| truncate_text(delta, MAX_STREAM_DELTA_CHARS));
            handle.stored_chunk_bytes += data.len() + delta_text.as_ref().map_or(0, String::len);
            handle.chunks.push(StreamChunk {
                id: cockpit_core::ids::create_id(),
                step_id: handle.step.id.clone(),
                seq,
                kind: ingested.kind,
                data,
                delta_text,
                received_at: now_iso(),
            });
        }

        self.bus.publish_transient(
            "stream.chunk",
            Some(&handle.step.session_id),
            Some(&handle.step.id),
            json!({
                "seq": seq,
                "kind": ingested.kind.as_str(),
                "deltaText": ingested.delta_text.as_deref().map(|delta| truncate_text(delta, 20_000)),
            }),
        );

        ingested
    }

    pub fn mark_first_byte(&self, handle: &mut RecordedStep) {
        if handle.first_byte_at.is_none() {
            handle.first_byte_at = Some(Instant::now());
        }
    }

    pub fn finish(&self, handle: &mut RecordedStep, input: FinishRecordedStep) -> Result<bool> {
        if handle.finalized {
            return Ok(false);
        }
        handle.finalized = true;

        let collected = input
            .collected
            .unwrap_or_else(|| handle.collector.snapshot());
        let model = collected
            .model
            .clone()
            .or_else(|| handle.model.clone())
            .or_else(|| handle.step.model.clone());
        let status = if collected.error.is_some() && input.status == StepStatus::Completed {
            StepStatus::Failed
        } else {
            input.status
        };

        if let Some(guards) = &self.guards {
            let guard_input = GuardStepInput {
                session_id: handle.step.session_id.clone(),
                step_id: handle.step.id.clone(),
                response_text: (!collected.text.is_empty()).then(|| collected.text.clone()),
                response_thinking: (!collected.thinking.is_empty())
                    .then(|| collected.thinking.clone()),
                tool_calls: collected
                    .tool_calls
                    .iter()
                    .map(|call| (call.name.clone(), call.input.clone()))
                    .collect(),
            };
            if let Err(error) = guards.evaluate_step(guard_input) {
                tracing::warn!(%error, "post-step guard evaluation failed");
            }
        }

        let response_text = truncate_text(
            &redact_text(
                &collected.text,
                &mut handle.redactions,
                CaptureLocation::ResponseBody,
            ),
            MAX_RESPONSE_CHARS,
        );
        let response_thinking = truncate_text(
            &redact_text(
                &collected.thinking,
                &mut handle.redactions,
                CaptureLocation::ResponseBody,
            ),
            MAX_THINKING_CHARS,
        );
        let response_headers = redact_headers(
            &input.response_headers,
            &mut handle.redactions,
            CaptureLocation::ResponseHeaders,
        );

        let error_text = input
            .error
            .or_else(|| collected.error.clone())
            .or_else(|| {
                (input.response_status >= 400).then(|| format!("HTTP {}", input.response_status))
            })
            .map(|error| {
                redact_text(
                    &truncate_text(&error, 2_000),
                    &mut handle.redactions,
                    CaptureLocation::ResponseBody,
                )
            });

        let latency_ms = handle.started_at.elapsed().as_millis() as u64;
        let ttft_ms = input.ttft_ms.or_else(|| {
            handle.first_byte_at.map(|first| {
                first
                    .saturating_duration_since(handle.started_at)
                    .as_millis() as u64
            })
        });

        let provider = handle.step.provider.clone().or_else(|| {
            handle
                .step
                .request
                .as_ref()
                .map(|request| request.protocol.default_provider().to_string())
        });
        let overrides = self.pricing_overrides();
        let pricing = model.as_deref().and_then(|model| {
            resolve_model_pricing(model, provider.as_deref(), &overrides).pricing
        });
        let cost = match model.as_deref() {
            Some(model) => {
                estimate_usage_cost(collected.usage, model, provider.as_deref(), &overrides)
            }
            None => {
                estimate_usage_cost(collected.usage, "unknown", provider.as_deref(), &overrides)
            }
        };
        let cost_known = cost.known;
        let cost_usd = cost.usd;

        let threshold = self
            .store
            .get_setting("context.threshold")
            .ok()
            .flatten()
            .as_deref()
            .map(|raw| parse_context_threshold(Some(raw)))
            .unwrap_or_else(|| parse_context_threshold(None));
        let previous_tokens = self
            .store
            .previous_context_tokens(&handle.step.session_id, handle.step.seq)
            .ok()
            .flatten();
        let context = build_context_meter(
            model.as_deref().unwrap_or("unknown"),
            handle
                .step
                .request
                .as_ref()
                .and_then(|request| request.body.as_ref()),
            Some(collected.usage),
            pricing.as_ref().and_then(|pricing| pricing.context_window),
            previous_tokens,
            threshold,
        );

        let finish_reason = collected.finish_reason.or(match status {
            StepStatus::Failed => Some(FinishReason::Error),
            StepStatus::Cancelled => Some(FinishReason::Cancelled),
            _ => None,
        });

        let tool_calls: Vec<ToolCall> = collected
            .tool_calls
            .iter()
            .map(|call| {
                let input = call.input.clone().map(|value| {
                    redact_json(
                        &value,
                        &mut handle.redactions,
                        CaptureLocation::ResponseBody,
                    )
                });
                let file_paths = extract_file_paths(input.as_ref());
                ToolCall {
                    id: cockpit_core::ids::create_id(),
                    session_id: handle.step.session_id.clone(),
                    step_id: Some(handle.step.id.clone()),
                    provider_tool_call_id: call.provider_tool_call_id.clone(),
                    name: call.name.clone(),
                    status: ToolCallStatus::Completed,
                    input,
                    output: None,
                    error: None,
                    file_paths,
                    started_at: now_iso(),
                    ended_at: Some(now_iso()),
                }
            })
            .collect();

        let mut metadata = serde_json::Map::new();
        metadata.insert(
            "context".to_string(),
            serde_json::to_value(&context).unwrap_or(Value::Null),
        );
        if let Some(info) = input.override_info.clone() {
            metadata.insert("override".to_string(), info);
        }
        let metadata = Some(Value::Object(metadata));

        let completed = self.store.complete_step(
            &handle.step.id,
            CompleteStep {
                status,
                response_status: input.response_status,
                response_headers,
                response_text: (!response_text.is_empty()).then_some(response_text),
                response_thinking: (!response_thinking.is_empty()).then_some(response_thinking),
                finish_reason,
                usage: collected.usage,
                cost_usd,
                cost_known,
                model: model.clone(),
                error: error_text,
                ttft_ms,
                latency_ms,
                metadata,
            },
            tool_calls.len() as u64,
        )?;

        let Some(step) = completed else {
            return Ok(false);
        };

        if let Err(error) = self
            .store
            .insert_redactions(&step.id, &handle.redactions.rows())
        {
            tracing::warn!(%error, "could not persist redaction metadata");
        }
        if let Err(error) = self.store.insert_stream_chunks(&handle.chunks) {
            tracing::warn!(%error, "could not persist stream chunks");
        }
        if let Err(error) = self.store.insert_tool_calls(&tool_calls) {
            tracing::warn!(%error, "could not persist tool calls");
        }

        for call in &tool_calls {
            self.bus.publish(
                "tool.completed",
                Some(&handle.step.session_id),
                Some(&step.id),
                json!({
                    "name": call.name,
                    "status": call.status.as_str(),
                    "providerToolCallId": call.provider_tool_call_id,
                    "filePaths": call.file_paths,
                }),
            );
        }

        self.bus.publish(
            "step.completed",
            Some(&handle.step.session_id),
            Some(&step.id),
            json!({
                "status": step.status.as_str(),
                "durationMs": latency_ms,
                "usage": {
                    "inputTokens": collected.usage.input_tokens,
                    "outputTokens": collected.usage.output_tokens,
                    "cacheReadTokens": collected.usage.cache_read_tokens,
                    "cacheWriteTokens": collected.usage.cache_write_tokens,
                    "reasoningTokens": collected.usage.reasoning_tokens,
                },
                "costKnown": cost_known,
                "costUsd": cost_usd,
                "finishReason": step.response.as_ref().and_then(|response| response.finish_reason).map(|reason| reason.as_str()),
                "model": model,
                "context": context,
            }),
        );

        if context.high
            && !self
                .store
                .previous_context_high(&step.session_id, step.seq)
                .unwrap_or(false)
        {
            self.notify_context_high(&step, &context);
        }

        if let Ok(Some(session)) = self.store.get_session(&handle.step.session_id) {
            self.bus.publish(
                "session.updated",
                Some(&session.id),
                None,
                json!({ "totals": totals_payload(&session) }),
            );
        }

        Ok(true)
    }

    fn notify_context_high(&self, step: &Step, meter: &ContextMeter) {
        let Some(agents) = &self.agents else {
            return;
        };
        let session = self.store.get_session(&step.session_id).ok().flatten();
        let agent_name = session
            .as_ref()
            .and_then(|session| session.agent.as_ref())
            .and_then(|agent| agent.name.clone())
            .unwrap_or_else(|| "Agent".to_string());
        let project_name = session
            .as_ref()
            .and_then(|session| session.workspace_path.as_deref())
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Workspace")
            .to_string();
        let message = match (meter.percent, meter.window) {
            (Some(percent), Some(window)) => {
                format!("Context is at {percent:.0}% of the {window}-token window.")
            }
            (Some(percent), None) => format!("Context is at {percent:.0}% of the model window."),
            _ => "The agent context is nearly full.".to_string(),
        };
        let input = AgentEventInput {
            event_type: AgentEventType::ContextHigh,
            message,
            metadata: Some(json!({
                "stepId": step.id,
                "model": meter.model,
                "tokens": meter.tokens,
                "window": meter.window,
                "percent": meter.percent,
                "threshold": meter.threshold,
            })),
        };
        if let Err(error) =
            agents.record_event_for(&step.session_id, &agent_name, &project_name, input)
        {
            tracing::warn!(%error, "could not record the context.high event");
        }
        if let Some(remote) = &self.remote {
            if tokio::runtime::Handle::try_current().is_ok() {
                let remote = remote.clone();
                tokio::spawn(async move {
                    remote.send_notification("context").await;
                });
            }
        }
    }

    fn pricing_overrides(&self) -> Vec<ModelPricing> {
        match self.store.get_setting("pricing.overrides") {
            Ok(Some(raw)) => {
                serde_json::from_str::<Vec<ModelPricing>>(&raw).unwrap_or_else(|error| {
                    tracing::warn!(%error, "ignoring invalid pricing overrides");
                    Vec::new()
                })
            }
            Ok(None) => Vec::new(),
            Err(error) => {
                tracing::warn!(%error, "could not read pricing overrides");
                Vec::new()
            }
        }
    }
}

/// Append helper kept public for future adapters that build text incrementally.
pub fn append_text(target: &mut String, addition: &str, maximum: usize) {
    append_limited(target, addition, maximum);
}
