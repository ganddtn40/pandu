//! End-to-end tests for the Phase 1 daemon.
//!
//! These tests start a mock provider, the real daemon on an ephemeral port, and
//! speak HTTP to both. They verify the promises that matter: bytes are
//! forwarded unchanged, credentials are forwarded (or replaced only when the
//! sentinel is used), captures are stored with secrets redacted, and the API
//! can read everything back.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::StatusCode;
use pandu_daemon::{Config, ServerHandle};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

const SSE_BODY: &str = concat!(
    "data: {\"id\":\"chatcmpl-1\",\"model\":\"gpt-4.1\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
    "data: {\"id\":\"chatcmpl-1\",\"model\":\"gpt-4.1\",\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n",
    "data: {\"id\":\"chatcmpl-1\",\"model\":\"gpt-4.1\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n",
    "data: [DONE]\n\n",
);

#[derive(Debug, Clone)]
struct Captured {
    path: String,
    headers: BTreeMap<String, String>,
    body: String,
}

struct MockUpstream {
    addr: SocketAddr,
    captured: Arc<Mutex<Vec<Captured>>>,
    task: JoinHandle<()>,
}

impl MockUpstream {
    async fn start() -> Self {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/health", get(|| async { "ok" }))
            .fallback(mock_handler)
            .with_state(captured.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            addr,
            captured,
            task,
        }
    }

    fn last(&self) -> Captured {
        self.captured
            .lock()
            .expect("mock capture lock")
            .last()
            .cloned()
            .expect("the mock received no request")
    }

    fn count(&self) -> usize {
        self.captured.lock().expect("mock capture lock").len()
    }
}

impl Drop for MockUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn mock_handler(
    State(captured): State<Arc<Mutex<Vec<Captured>>>>,
    request: Request,
) -> Response {
    let path = request.uri().path().to_string();
    let headers = collect_headers(request.headers());
    let bytes = to_bytes(request.into_body(), 10 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let body = String::from_utf8_lossy(&bytes).to_string();
    captured.lock().expect("mock capture lock").push(Captured {
        path: path.clone(),
        headers: headers.clone(),
        body: body.clone(),
    });

    // Fixtures are driven by request headers so a test can make the provider
    // reject an overridden request or report no usage without changing paths.
    if let Some(status) = headers.get("x-mock-reject") {
        let status = status
            .parse::<u16>()
            .ok()
            .and_then(|value| StatusCode::from_u16(value).ok())
            .unwrap_or(StatusCode::BAD_REQUEST);
        return Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "error": {
                        "message": "unsupported parameter: reasoning_effort",
                        "type": "invalid_request_error",
                        "param": "reasoning_effort"
                    }
                })
                .to_string(),
            ))
            .unwrap();
    }

    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let stream = parsed
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let zero_usage = headers.contains_key("x-mock-zero-usage");

    if path.ends_with("/chat/completions") && stream {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(SSE_BODY))
            .unwrap();
    }
    if path.ends_with("/chat/completions") {
        let usage = if zero_usage {
            json!({ "prompt_tokens": 0, "completion_tokens": 0 })
        } else {
            json!({ "prompt_tokens": 12, "completion_tokens": 5 })
        };
        return json_response(json!({
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "model": "gpt-4.1",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": "Hello from the mock" },
                "finish_reason": "stop"
            }],
            "usage": usage
        }));
    }
    if path.ends_with("/messages") {
        return json_response(json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4",
            "content": [{ "type": "text", "text": "Anthropic mock reply" }],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 9, "output_tokens": 4 }
        }));
    }
    if path.contains(":generateContent") {
        return json_response(json!({
            "candidates": [{
                "content": { "parts": [{ "text": "Gemini mock reply" }] },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 7,
                "candidatesTokenCount": 3,
                "cachedContentTokenCount": 0
            },
            "modelVersion": "gemini-2.5-pro"
        }));
    }

    (StatusCode::NOT_FOUND, "no mock route").into_response()
}

fn json_response(payload: Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap()
}

fn collect_headers(headers: &http::HeaderMap) -> BTreeMap<String, String> {
    let mut collected = BTreeMap::new();
    for (name, value) in headers {
        let name = name.as_str().to_ascii_lowercase();
        let value = value.to_str().unwrap_or_default();
        collected
            .entry(name)
            .and_modify(|existing: &mut String| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.to_string());
    }
    collected
}

fn config(home: &std::path::Path, upstream: SocketAddr) -> Config {
    let mut config = Config::for_home(home);
    config.host = "127.0.0.1".to_string();
    config.port = 0;
    let base = format!("http://{upstream}");
    config.openai.base_url = base.clone();
    config.anthropic.base_url = base.clone();
    config.gemini.base_url = base;
    config
}

async fn start_daemon(home: &std::path::Path, upstream: SocketAddr) -> ServerHandle {
    pandu_daemon::spawn(config(home, upstream))
        .await
        .expect("the daemon should start")
}

/// Headers every state-changing host request must carry.
fn host_headers(daemon: &ServerHandle) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ORIGIN,
        format!("http://{}", daemon.addr).parse().unwrap(),
    );
    headers.insert("x-pandu-csrf", daemon.state.csrf.parse().unwrap());
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    headers
}

async fn wait_for_step(client: &reqwest::Client, daemon: &ServerHandle, session_id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = client
            .get(format!(
                "http://{}/api/sessions/{session_id}/steps",
                daemon.addr
            ))
            .send()
            .await
            .expect("steps request");
        let payload: Value = response.json().await.expect("steps JSON");
        if let Some(step) = payload["steps"].as_array().and_then(|steps| steps.first())
            && step["status"] != "running"
        {
            return step.clone();
        }
        assert!(
            Instant::now() < deadline,
            "the step did not finish in time: {payload}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Wait for the Nth step (1-based, oldest first) to leave the running state.
async fn wait_for_step_number(
    client: &reqwest::Client,
    daemon: &ServerHandle,
    session_id: &str,
    number: usize,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = client
            .get(format!(
                "http://{}/api/sessions/{session_id}/steps",
                daemon.addr
            ))
            .send()
            .await
            .expect("steps request");
        let payload: Value = response.json().await.expect("steps JSON");
        let steps = payload["steps"].as_array().cloned().unwrap_or_default();
        if let Some(step) = steps.get(number.saturating_sub(1))
            && step["status"] != "running"
        {
            return step.clone();
        }
        assert!(
            Instant::now() < deadline,
            "step {number} did not finish in time: {payload}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Insert a completed step carrying a provider-reported context meter. The
/// context-window guard reads the latest meter, so this is the smallest way to
/// model a flight that has already grown past a smaller model's window.
fn seed_context(daemon: &ServerHandle, session_id: &str, tokens: u64) {
    use pandu_core::model::{CapturedRequest, StepKind, StepStatus};
    use pandu_core::provider::ProviderProtocol;
    use pandu_core::usage::TokenUsage;
    use pandu_daemon::store::{BeginStep, CompleteStep};

    let request = CapturedRequest {
        protocol: ProviderProtocol::Openai,
        method: "POST".to_string(),
        path: "/v1/chat/completions".to_string(),
        model: Some("gpt-4.1".to_string()),
        stream: false,
        headers: BTreeMap::new(),
        body: None,
        system_prompt: None,
        prompt_text: None,
        redaction_count: 0,
    };
    let step = daemon
        .state
        .store
        .begin_step(BeginStep {
            session_id: session_id.to_string(),
            kind: StepKind::Model,
            provider: Some("openai".to_string()),
            model: Some("gpt-4.1".to_string()),
            request,
        })
        .expect("seed step");
    daemon
        .state
        .store
        .complete_step(
            &step.id,
            CompleteStep {
                status: StepStatus::Completed,
                response_status: 200,
                response_headers: BTreeMap::new(),
                response_text: None,
                response_thinking: None,
                finish_reason: None,
                usage: TokenUsage::default(),
                cost_usd: None,
                cost_known: false,
                model: None,
                error: None,
                ttft_ms: None,
                latency_ms: 0,
                metadata: Some(json!({
                    "context": {
                        "tokens": tokens,
                        "window": 1_048_576,
                        "percent": 0.48,
                        "source": "provider"
                    }
                })),
            },
            0,
        )
        .expect("complete seed step");
}

#[tokio::test(flavor = "multi_thread")]
async fn records_openai_requests_and_redacts_stored_headers() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = config(home.path(), mock.addr);
    config.openai.api_key = Some("configured-key".to_string());
    let daemon = pandu_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let response = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("authorization", "Bearer agent-key")
        .header("content-type", "application/json")
        .header("x-pandu-provider", "deepseek")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "Say hi" }]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let step_id = response.headers()["x-pandu-step-id"]
        .to_str()
        .unwrap()
        .to_string();
    let body = response.text().await.unwrap();
    assert!(body.contains("Hello from the mock"));

    let captured = mock.last();
    assert_eq!(captured.path, "/v1/chat/completions");
    assert_eq!(captured.headers["authorization"], "Bearer agent-key");
    assert_eq!(captured.headers["accept-encoding"], "identity");
    assert!(!captured.headers.contains_key("x-pandu-provider"));
    let sent: Value = serde_json::from_str(&captured.body).unwrap();
    assert_eq!(sent["model"], "gpt-4.1");

    let step: Value = client
        .get(format!("http://{}/api/steps/{step_id}", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(step["step"]["status"], "completed");
    assert_eq!(step["step"]["provider"], "deepseek");
    assert_eq!(step["step"]["model"], "gpt-4.1");
    assert_eq!(step["step"]["usage"]["inputTokens"], 12);
    assert_eq!(step["step"]["usage"]["outputTokens"], 5);
    assert_eq!(step["step"]["response"]["text"], "Hello from the mock");
    assert_eq!(
        step["step"]["request"]["headers"]["authorization"],
        "[REDACTED]"
    );
    assert_eq!(step["redactions"][0]["location"], "request_headers");
    assert_eq!(step["redactions"][0]["occurrences"], 1);

    let session: Value = client
        .get(format!("http://{}/api/sessions/{session_id}", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(session["totals"]["stepCount"], 1);
    assert_eq!(session["totals"]["inputTokens"], 12);
    assert_eq!(session["provider"], "deepseek");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_sse_bytes_unchanged_and_collects_the_response() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "stream": true,
            "messages": [{ "role": "user", "content": "Stream hi" }]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let session_id = response.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let bytes = response.bytes().await.unwrap();
    assert_eq!(bytes.as_ref(), SSE_BODY.as_bytes());

    let step = wait_for_step(&client, &daemon, &session_id).await;
    assert_eq!(step["status"], "completed");
    assert_eq!(step["response"]["text"], "Hello");
    assert_eq!(step["usage"]["inputTokens"], 10);
    assert_eq!(step["usage"]["outputTokens"], 2);
    assert_eq!(step["response"]["finishReason"], "stop");

    let detail: Value = client
        .get(format!(
            "http://{}/api/steps/{}",
            daemon.addr,
            step["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail["streamChunks"].as_array().unwrap().len(), 4);
    assert_eq!(detail["streamChunks"][0]["deltaText"], "Hel");
    assert_eq!(detail["streamChunks"][1]["deltaText"], "lo");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn host_override_rewrites_only_the_forwarded_request() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    // First request establishes the ambient OpenAI flight.
    let first = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "first" }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let session_id = first.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = first.bytes().await.unwrap();

    let preview: Value = client
        .get(format!(
            "http://{}/api/sessions/{session_id}/model/preview?model=gpt-5.5&effort=high",
            daemon.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(preview["requiresConfirmation"], true);
    assert_eq!(preview["override"]["model"], "gpt-5.5");
    assert_eq!(preview["override"]["effort"], "high");
    assert_eq!(preview["relativeCost"]["known"], true);
    assert_eq!(preview["relativeCost"]["direction"], "more");
    assert_eq!(preview["relativeCost"]["fromModel"], "gpt-4.1");
    assert_eq!(preview["relativeCost"]["usage"]["inputTokens"], 12);
    assert_eq!(preview["relativeCost"]["usage"]["outputTokens"], 5);
    assert_eq!(preview["relativeCost"]["usage"]["calls"], 1);
    assert!(preview["relativeCost"].get("referenceTokens").is_none());
    assert_eq!(preview["relativeCost"]["firstRequest"]["contextTokens"], 12);
    assert!(
        preview["relativeCost"]["firstRequest"]["uncachedUsd"]
            .as_f64()
            .unwrap()
            > 0.0
    );

    let applied = client
        .put(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gpt-5.5", "effort": "high" }))
        .send()
        .await
        .unwrap();
    assert_eq!(applied.status(), StatusCode::OK);
    let applied: Value = applied.json().await.unwrap();
    assert_eq!(applied["override"]["originalModel"], "gpt-4.1");
    assert_eq!(applied["override"]["provider"], "openai");

    let response = client
        .post(format!(
            "http://{}/s/{session_id}/v1/chat/completions",
            daemon.addr
        ))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "reasoning_effort": "low",
            "temperature": 0.25,
            "messages": [{ "role": "user", "content": "override me" }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let step_id = response.headers()["x-pandu-step-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = response.bytes().await.unwrap();

    // The provider saw the rewritten model and effort; nothing else changed.
    let captured = mock.last();
    let forwarded: Value = serde_json::from_str(&captured.body).unwrap();
    assert_eq!(forwarded["model"], "gpt-5.5");
    assert_eq!(forwarded["reasoning_effort"], "high");
    assert_eq!(forwarded["temperature"], 0.25);
    assert_eq!(forwarded["messages"][0]["content"], "override me");

    // The recorded request keeps the original bytes; the rewrite lives in
    // step metadata only.
    let step: Value = client
        .get(format!("http://{}/api/steps/{step_id}", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let recorded = &step["step"]["request"]["body"];
    assert_eq!(recorded["model"], "gpt-4.1");
    assert_eq!(recorded["reasoning_effort"], "low");
    assert_eq!(step["step"]["metadata"]["override"]["applied"], true);
    assert_eq!(step["step"]["metadata"]["override"]["modifiedBy"], "pandu");
    assert_eq!(
        step["step"]["metadata"]["override"]["model"]["from"],
        "gpt-4.1"
    );
    assert_eq!(
        step["step"]["metadata"]["override"]["model"]["to"],
        "gpt-5.5"
    );
    assert_eq!(
        step["step"]["metadata"]["override"]["effort"]["from"],
        "low"
    );
    assert_eq!(step["step"]["metadata"]["override"]["effort"]["to"], "high");
    assert!(step["step"]["metadata"]["context"]["percent"].is_number());

    // Ending the flight drops the override.
    let ended = client
        .post(format!(
            "http://{}/api/sessions/{session_id}/end",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert_eq!(ended.status(), StatusCode::OK);
    let model: Value = client
        .get(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(model["override"], Value::Null);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn override_rewrites_streaming_requests_and_passes_sse_bytes_through() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let first = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "first" }]
        }))
        .send()
        .await
        .unwrap();
    let session_id = first.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = first.bytes().await.unwrap();

    client
        .put(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gpt-5.5" }))
        .send()
        .await
        .unwrap();

    let response = client
        .post(format!(
            "http://{}/s/{session_id}/v1/chat/completions",
            daemon.addr
        ))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "stream": true,
            "messages": [{ "role": "user", "content": "stream override" }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let step_id = response.headers()["x-pandu-step-id"]
        .to_str()
        .unwrap()
        .to_string();
    let bytes = response.bytes().await.unwrap();
    // The response is the provider's bytes, never re-encoded by Pandu.
    assert_eq!(bytes.as_ref(), SSE_BODY.as_bytes());

    let captured = mock.last();
    let forwarded: Value = serde_json::from_str(&captured.body).unwrap();
    assert_eq!(forwarded["model"], "gpt-5.5");
    assert_eq!(forwarded["stream"], true);

    let step: Value = client
        .get(format!("http://{}/api/steps/{step_id}", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(step["step"]["metadata"]["override"]["applied"], true);
    assert_eq!(
        step["step"]["metadata"]["override"]["model"]["to"],
        "gpt-5.5"
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn with_the_override_off_the_forwarded_bytes_are_identical() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    // Deliberately odd whitespace and key order: a byte-identical forward must
    // not reserialize the body.
    let raw = r#"{"model": "gpt-4.1",   "messages" :[{"role":"user","content":"bytes"}],"temperature":0.5}"#;
    let first = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("content-type", "application/json")
        .body(raw)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let session_id = first.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = first.bytes().await.unwrap();
    assert_eq!(mock.last().body, raw);

    // Turning an override on rewrites; turning it back off restores the
    // byte-identical path for the very next request.
    client
        .put(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gpt-5.5" }))
        .send()
        .await
        .unwrap();
    client
        .delete(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();

    let second = client
        .post(format!(
            "http://{}/s/{session_id}/v1/chat/completions",
            daemon.addr
        ))
        .header("content-type", "application/json")
        .body(raw)
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let _ = second.bytes().await.unwrap();
    assert_eq!(mock.last().body, raw);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_overrides_are_rejected_and_audited() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let first = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "first" }]
        }))
        .send()
        .await
        .unwrap();
    let session_id = first.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = first.bytes().await.unwrap();

    for (body, code) in [
        (json!({ "model": "claude-opus-5-5" }), "provider_mismatch"),
        (json!({ "model": "mystery-model" }), "model_not_found"),
        (
            json!({ "model": "gpt-5.5", "effort": "impossible" }),
            "effort_unsupported",
        ),
        (
            json!({ "model": "gpt-4.1", "effort": "high" }),
            "effort_not_supported",
        ),
    ] {
        let response = client
            .put(format!(
                "http://{}/api/sessions/{session_id}/model",
                daemon.addr
            ))
            .headers(host_headers(&daemon))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
        let payload: Value = response.json().await.unwrap();
        assert_eq!(payload["error"]["code"], code, "{body}");
    }

    // A rejected override never installs.
    let model: Value = client
        .get(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(model["override"], Value::Null);

    let audit: Value = client
        .get(format!("http://{}/api/remote/audit?limit=50", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let denied: Vec<&Value> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["event"] == "model.override.denied")
        .collect();
    assert_eq!(denied.len(), 4);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn sentinel_swaps_in_configured_anthropic_key() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = config(home.path(), mock.addr);
    config.anthropic.api_key = Some("real-anthropic-key".to_string());
    let daemon = pandu_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let response = client
        .post(format!("http://{}/v1/messages", daemon.addr))
        .header("x-api-key", "pandu-proxy")
        .header("content-type", "application/json")
        .json(&json!({
            "model": "claude-sonnet-4",
            "max_tokens": 128,
            "messages": [{ "role": "user", "content": "Hello" }]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["content"][0]["text"], "Anthropic mock reply");

    let captured = mock.last();
    assert_eq!(captured.path, "/v1/messages");
    assert_eq!(captured.headers["x-api-key"], "real-anthropic-key");
    assert_eq!(captured.headers["anthropic-version"], "2023-06-01");
    assert!(!captured.headers.contains_key("authorization"));

    let step = wait_for_step(&client, &daemon, &session_id).await;
    assert_eq!(step["request"]["protocol"], "anthropic");
    assert_eq!(step["response"]["text"], "Anthropic mock reply");
    assert_eq!(step["usage"]["inputTokens"], 9);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn routes_gemini_paths_and_replaces_the_google_key() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = config(home.path(), mock.addr);
    config.gemini.api_key = Some("real-google-key".to_string());
    let daemon = pandu_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let response = client
        .post(format!(
            "http://{}/v1beta/models/gemini-2.5-pro:generateContent",
            daemon.addr
        ))
        .header("x-goog-api-key", "pandu-proxy")
        .header("content-type", "application/json")
        .json(&json!({
            "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let body: Value = response.json().await.unwrap();
    assert_eq!(
        body["candidates"][0]["content"]["parts"][0]["text"],
        "Gemini mock reply"
    );

    let captured = mock.last();
    assert_eq!(
        captured.path,
        "/v1beta/models/gemini-2.5-pro:generateContent"
    );
    assert_eq!(captured.headers["x-goog-api-key"], "real-google-key");

    let step = wait_for_step(&client, &daemon, &session_id).await;
    assert_eq!(step["request"]["protocol"], "gemini");
    assert_eq!(step["usage"]["inputTokens"], 7);
    assert_eq!(step["usage"]["outputTokens"], 3);
    assert_eq!(step["response"]["text"], "Gemini mock reply");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn gemini_effort_overrides_translate_between_budget_and_levels() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = config(home.path(), mock.addr);
    config.gemini.api_key = Some("real-google-key".to_string());
    let daemon = pandu_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let first = client
        .post(format!(
            "http://{}/v1beta/models/gemini-3.8-flash:generateContent",
            daemon.addr
        ))
        .header("content-type", "application/json")
        .json(&json!({
            "contents": [{ "role": "user", "parts": [{ "text": "first" }] }],
            "generationConfig": { "thinkingConfig": { "thinkingLevel": "low" } }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let session_id = first.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = first.bytes().await.unwrap();

    // Gemini 3.8 -> Gemini 2.5: the level is replaced by a numeric budget.
    let applied = client
        .put(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gemini-2.5-pro", "effort": "8192" }))
        .send()
        .await
        .unwrap();
    assert_eq!(applied.status(), StatusCode::OK);
    let applied: Value = applied.json().await.unwrap();
    assert_eq!(applied["override"]["effort"], "8192");

    let second = client
        .post(format!(
            "http://{}/s/{session_id}/v1beta/models/gemini-3.8-flash:generateContent",
            daemon.addr
        ))
        .header("content-type", "application/json")
        .json(&json!({
            "contents": [{ "role": "user", "parts": [{ "text": "second" }] }],
            "generationConfig": { "thinkingConfig": { "thinkingLevel": "low" } }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let _ = second.bytes().await.unwrap();

    let captured = mock.last();
    assert_eq!(
        captured.path,
        "/v1beta/models/gemini-2.5-pro:generateContent"
    );
    let forwarded: Value = serde_json::from_str(&captured.body).unwrap();
    assert_eq!(
        forwarded["generationConfig"]["thinkingConfig"]["thinkingBudget"],
        8192
    );
    assert!(
        forwarded["generationConfig"]["thinkingConfig"]
            .get("thinkingLevel")
            .is_none()
    );

    // Gemini 2.5 -> Gemini 3.8: the budget is replaced by a level, and the two
    // fields never coexist.
    let applied = client
        .put(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gemini-3.8-flash", "effort": "high" }))
        .send()
        .await
        .unwrap();
    assert_eq!(applied.status(), StatusCode::OK);

    let third = client
        .post(format!(
            "http://{}/s/{session_id}/v1beta/models/gemini-2.5-pro:generateContent",
            daemon.addr
        ))
        .header("content-type", "application/json")
        .json(&json!({
            "contents": [{ "role": "user", "parts": [{ "text": "third" }] }],
            "generationConfig": { "thinkingConfig": { "thinkingBudget": 4096 } }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(third.status(), StatusCode::OK);
    let _ = third.bytes().await.unwrap();

    let captured = mock.last();
    assert_eq!(
        captured.path,
        "/v1beta/models/gemini-3.8-flash:generateContent"
    );
    let forwarded: Value = serde_json::from_str(&captured.body).unwrap();
    assert_eq!(
        forwarded["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "high"
    );
    assert!(
        forwarded["generationConfig"]["thinkingConfig"]
            .get("thinkingBudget")
            .is_none()
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_provider_4xx_reverts_the_override_and_never_retries() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let first = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "first" }]
        }))
        .send()
        .await
        .unwrap();
    let session_id = first.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = first.bytes().await.unwrap();
    let _ = wait_for_step(&client, &daemon, &session_id).await;

    let applied = client
        .put(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gpt-5.5", "effort": "high" }))
        .send()
        .await
        .unwrap();
    assert_eq!(applied.status(), StatusCode::OK);
    let applied: Value = applied.json().await.unwrap();
    assert_eq!(applied["override"]["model"], "gpt-5.5");

    let rejected = client
        .post(format!(
            "http://{}/s/{session_id}/v1/chat/completions",
            daemon.addr
        ))
        .header("content-type", "application/json")
        .header("x-mock-reject", "400")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "reject me" }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let rejected_body: Value = rejected.json().await.unwrap();
    assert_eq!(
        rejected_body["error"]["message"],
        "unsupported parameter: reasoning_effort"
    );
    assert_eq!(
        mock.count(),
        2,
        "Pandu must not retry a request the provider rejected"
    );

    // The rejected step stays in the history and explains what happened.
    let step = wait_for_step_number(&client, &daemon, &session_id, 2).await;
    assert_eq!(step["status"], "failed");
    assert_eq!(step["response"]["status"], 400);
    let info = &step["metadata"]["override"];
    assert_eq!(info["applied"], true);
    assert_eq!(info["providerRejected"], true);
    assert_eq!(info["reverted"], true);
    assert_eq!(info["revertReason"], "provider_rejected");
    assert_eq!(info["providerStatus"], 400);
    assert!(
        info["providerError"]
            .as_str()
            .unwrap()
            .contains("unsupported parameter")
    );

    let model: Value = client
        .get(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(model["override"], Value::Null);

    // The next request goes out with the original model and no leftover
    // effort field.
    let third = client
        .post(format!(
            "http://{}/s/{session_id}/v1/chat/completions",
            daemon.addr
        ))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "after revert" }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(third.status(), StatusCode::OK);
    let _ = third.bytes().await.unwrap();
    assert_eq!(mock.count(), 3);
    let forwarded: Value = serde_json::from_str(&mock.last().body).unwrap();
    assert_eq!(forwarded["model"], "gpt-4.1");
    assert!(forwarded.get("reasoning_effort").is_none());

    let audit: Value = client
        .get(format!("http://{}/api/remote/audit?limit=50", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let reverted: Vec<&Value> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["event"] == "model.override.reverted")
        .collect();
    assert_eq!(reverted.len(), 1);
    assert_eq!(reverted[0]["detail"]["actor"], "pandu");
    assert_eq!(reverted[0]["detail"]["reason"], "provider_rejected");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_override_that_exceeds_the_target_context_window_is_blocked() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let first = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("content-type", "application/json")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "first" }]
        }))
        .send()
        .await
        .unwrap();
    let session_id = first.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = first.bytes().await.unwrap();
    let _ = wait_for_step(&client, &daemon, &session_id).await;

    // gpt-5.4-mini has a 400,000-token window; the flight has already used
    // 500,000 tokens, so the switch would fail on the very next request.
    seed_context(&daemon, &session_id, 500_000);

    let preview = client
        .get(format!(
            "http://{}/api/sessions/{session_id}/model/preview?model=gpt-5.4-mini",
            daemon.addr
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::CONFLICT);
    let preview: Value = preview.json().await.unwrap();
    assert_eq!(preview["error"]["code"], "context_window_exceeded");

    let applied = client
        .put(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gpt-5.4-mini" }))
        .send()
        .await
        .unwrap();
    assert_eq!(applied.status(), StatusCode::CONFLICT);
    let applied: Value = applied.json().await.unwrap();
    assert_eq!(applied["error"]["code"], "context_window_exceeded");

    let model: Value = client
        .get(format!(
            "http://{}/api/sessions/{session_id}/model",
            daemon.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(model["override"], Value::Null);
    assert_eq!(
        mock.count(),
        1,
        "a blocked override never reaches the provider"
    );

    let audit: Value = client
        .get(format!("http://{}/api/remote/audit?limit=50", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let denied: Vec<&Value> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| {
            entry["event"] == "model.override.denied"
                && entry["detail"]["reason"] == "context_window_exceeded"
        })
        .collect();
    assert_eq!(denied.len(), 1, "the apply attempt is audited");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn api_lists_adapters() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let adapters: Value = client
        .get(format!("http://{}/api/adapters", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(adapters["total"], 15);
    assert_eq!(adapters["verified"], 0);
    assert_eq!(adapters["adapters"].as_array().unwrap().len(), 15);
    assert!(adapters["issues"].as_array().unwrap().is_empty());
    assert_eq!(adapters["logWatchEnabled"], false);

    let one: Value = client
        .get(format!("http://{}/api/adapters/opencode", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(one["adapter"]["id"], "opencode");
    assert_eq!(one["status"]["verified"], false);
    assert!(one["adapter"]["logWatch"]["parser"].is_string());

    let missing = client
        .get(format!("http://{}/api/adapters/nope", daemon.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    // Remote access is off by default; enabling it is a host-only action and
    // is covered by the dedicated remote access tests.
    let remote: Value = client
        .get(format!("http://{}/api/remote/status", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(remote["enabled"], false);
    assert_eq!(remote["mode"], "loopback");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_user_adapter_and_a_log_scan_create_an_observed_flight() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let logs = home.path().join("logs");
    let adapters = home.path().join("adapters");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::create_dir_all(&adapters).unwrap();
    std::fs::write(
        logs.join("session.jsonl"),
        concat!(
            "{\"role\":\"user\",\"content\":\"Fix the login redirect\",\"timestamp\":\"2020-01-01T10:00:00Z\"}\n",
            "{\"role\":\"assistant\",\"model\":\"gpt-4.1\",\"content\":\"Done.\",\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20},\"timestamp\":\"2020-01-01T10:00:02Z\"}\n",
        ),
    )
    .unwrap();
    let root = logs.display().to_string().replace('\\', "/");
    std::fs::write(
        adapters.join("test-agent.toml"),
        format!(
            r#"
schema_version = 1
id = "test-agent"
name = "Test Agent"
verified = false
docs_url = "https://example.com/docs"
capture = ["log_watch"]

[detect]
command = "test-agent"

[log_watch]
roots = ["{root}"]
include = ["**/*.jsonl"]
parser = "generic-jsonl"
"#
        ),
    )
    .unwrap();

    let mut config = config(home.path(), mock.addr);
    config.builtin_adapters = false;
    let daemon = pandu_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let scan: Value = client
        .post(format!("http://{}/api/logwatch/scan", daemon.addr))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(scan["status"]["lastScanSteps"], 1);
    assert_eq!(scan["status"]["filesTracked"], 1);

    let sessions: Value = client
        .get(format!("http://{}/api/sessions", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["source"] == "log_watch")
        .expect("an observed flight");
    assert_eq!(session["captureMode"], "log_watch");
    assert_eq!(session["title"], "Fix the login redirect");
    assert_eq!(session["sourceLabel"], "Observed from logs · Test Agent");
    assert_eq!(session["status"], "completed");

    let steps: Value = client
        .get(format!(
            "http://{}/api/sessions/{}/steps",
            daemon.addr,
            session["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let steps = steps["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0]["response"]["text"], "Done.");
    assert_eq!(steps[0]["usage"]["inputTokens"], 100);
    assert_eq!(steps[0]["usage"]["outputTokens"], 20);
    assert_eq!(steps[0]["costKnown"], true);

    let again: Value = client
        .post(format!("http://{}/api/logwatch/scan", daemon.addr))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["status"]["lastScanSteps"], 0);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn backup_api_is_csrf_protected_and_reports_real_paths() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let health: Value = client
        .get(format!("http://{}/api/health", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["dataDir"], home.path().display().to_string());
    assert_eq!(
        health["backupsDir"],
        home.path().join("backups").display().to_string()
    );

    let denied = client
        .post(format!("http://{}/api/backup", daemon.addr))
        .header(reqwest::header::ORIGIN, format!("http://{}", daemon.addr))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    let response = client
        .post(format!("http://{}/api/backup", daemon.addr))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let created: Value = response.json().await.unwrap();
    let path = created["path"].as_str().expect("backup path");
    let archive = std::path::Path::new(path);
    assert!(archive.is_file(), "{path}");
    assert_eq!(
        archive.parent(),
        Some(home.path().join("backups").as_path())
    );
    assert_eq!(created["encrypted"], false);
    assert_eq!(created["includeRemote"], false);

    // The reveal endpoint accepts only a closed set of folder names, never a
    // client-supplied path.
    let bad = client
        .post(format!("http://{}/api/reveal", daemon.addr))
        .headers(host_headers(&daemon))
        .json(&json!({ "target": "C:\\Windows" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn update_apply_and_rollback_require_csrf_confirmation_and_a_real_build() {
    use pandu_core::model::{SessionSource, SessionStatus};
    use pandu_core::provider::AgentInfo;
    use pandu_daemon::store::NewSession;

    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let cfg = config(home.path(), mock.addr);
    let daemon = pandu_daemon::spawn(cfg)
        .await
        .expect("the daemon should start");
    let client = reqwest::Client::new();

    daemon
        .state
        .store
        .create_session(NewSession {
            title: "Refactor auth".to_string(),
            source: SessionSource::Manual,
            status: SessionStatus::Active,
            agent: Some(AgentInfo {
                name: Some("Claude Code".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .unwrap();

    for path in ["/api/update/apply", "/api/update/rollback"] {
        let denied = client
            .post(format!("http://{}{path}", daemon.addr))
            .header(reqwest::header::ORIGIN, format!("http://{}", daemon.addr))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&json!({ "confirm": true, "sessionIds": [] }))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN, "{path}");

        // Without explicit consent the endpoint lists the running sessions.
        let unconfirmed = client
            .post(format!("http://{}{path}", daemon.addr))
            .headers(host_headers(&daemon))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(unconfirmed.status(), StatusCode::CONFLICT, "{path}");
        let body: Value = unconfirmed.json().await.unwrap();
        assert_eq!(body["error"]["code"], "confirmation_required", "{path}");
        assert_eq!(
            body["error"]["details"]["sessions"][0]["title"],
            "Refactor auth"
        );
        assert_eq!(
            body["error"]["details"]["sessions"][0]["agent"],
            "Claude Code"
        );

        // Confirming without echoing the session ids is still refused.
        let stale = client
            .post(format!("http://{}{path}", daemon.addr))
            .headers(host_headers(&daemon))
            .json(&json!({ "confirm": true, "sessionIds": [] }))
            .send()
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT, "{path}");
        let body: Value = stale.json().await.unwrap();
        assert_eq!(body["error"]["code"], "confirmation_required", "{path}");
    }

    daemon.shutdown().await.unwrap();

    // Demo mode refuses a confirmed update before the updater is ever started.
    let demo_home = tempfile::tempdir().unwrap();
    let mut demo_cfg = config(demo_home.path(), mock.addr);
    demo_cfg.demo_mode = true;
    let demo_daemon = pandu_daemon::spawn(demo_cfg)
        .await
        .expect("the demo daemon should start");
    for path in ["/api/update/apply", "/api/update/rollback"] {
        let response = client
            .post(format!("http://{}{path}", demo_daemon.addr))
            .headers(host_headers(&demo_daemon))
            .json(&json!({ "confirm": true, "sessionIds": [] }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT, "{path}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "demo_mode", "{path}");
    }
    demo_daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn api_seeds_demo_flights_and_serves_settings() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let health: Value = client
        .get(format!("http://{}/api/health", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["ok"], true);

    let empty: Value = client
        .get(format!("http://{}/api/overview", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(empty["stats"]["sessionCount"], 0);

    let seeded: Value = client
        .post(format!("http://{}/api/demo/seed", daemon.addr))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(seeded["seeded"], 3);

    let again: Value = client
        .post(format!("http://{}/api/demo/seed", daemon.addr))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["seeded"], 0);

    let overview: Value = client
        .get(format!("http://{}/api/overview", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(overview["stats"]["sessionCount"], 4);
    assert_eq!(overview["stats"]["activeSessionCount"], 2);
    assert_eq!(overview["stats"]["unknownCostCalls"], 1);
    assert!(overview["stats"]["totalCostUsd"].as_f64().unwrap() > 0.0);
    assert_eq!(overview["activeSessions"].as_array().unwrap().len(), 2);

    let sessions: Value = client
        .get(format!("http://{}/api/sessions", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sessions["total"], 4);
    let list = sessions["sessions"].as_array().unwrap();
    assert_eq!(list.len(), 4);

    // Every demo flight names the vendor that actually serves its model, so
    // Home and Flights never have to fall back to an "Unknown" label.
    for session in list {
        let title = session["title"].as_str().expect("demo flight title");
        let agent = session["agent"]["name"]
            .as_str()
            .unwrap_or_else(|| panic!("{title} has no agent"));
        let provider = session["provider"]
            .as_str()
            .unwrap_or_else(|| panic!("{title} has no provider"));
        let model = session["model"]
            .as_str()
            .unwrap_or_else(|| panic!("{title} has no model"));
        let expected = match agent {
            "Codex CLI" => "openai",
            "Claude Code" => "anthropic",
            "Gemini CLI" => "google",
            other => panic!("{title} uses an unexpected agent: {other}"),
        };
        assert_eq!(provider, expected, "{title} must use its agent's vendor");
        let prefix = match provider {
            "openai" => "gpt-",
            "anthropic" => "claude-",
            "google" => "gemini-",
            other => panic!("{title} uses an unexpected provider: {other}"),
        };
        assert!(
            model.starts_with(prefix),
            "{title} pairs {agent} with {provider}/{model}"
        );
    }

    let agent_events: Value = client
        .get(format!(
            "http://{}/api/agent-events?status=open",
            daemon.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(agent_events["openCount"], 3);
    let types: Vec<&str> = agent_events["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|event| event["type"].as_str())
        .collect();
    assert!(types.contains(&"permission"));
    assert!(types.contains(&"auth_required"));
    assert!(types.contains(&"done"));

    let completed = list
        .iter()
        .find(|session| session["title"] == "Refactor auth middleware")
        .expect("the refactor demo flight");
    let steps: Value = client
        .get(format!(
            "http://{}/api/sessions/{}/steps",
            daemon.addr,
            completed["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(steps["steps"].as_array().unwrap().len(), 2);

    let step_detail: Value = client
        .get(format!(
            "http://{}/api/steps/{}",
            daemon.addr,
            steps["steps"][0]["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(step_detail["toolCalls"][0]["name"], "read_file");

    let settings: Value = client
        .put(format!("http://{}/api/settings", daemon.addr))
        .headers(host_headers(&daemon))
        .json(&json!({ "theme": "glass", "budget": { "usd": 5 } }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(settings["settings"]["theme"], "glass");
    assert_eq!(settings["settings"]["budget"], "{\"usd\":5}");

    let active_id = overview["activeSessions"][0]["id"].as_str().unwrap();
    let ended: Value = client
        .post(format!(
            "http://{}/api/sessions/{active_id}/end",
            daemon.addr
        ))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ended["session"]["status"], "completed");

    let completed_only: Value = client
        .get(format!(
            "http://{}/api/sessions?status=completed",
            daemon.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(completed_only["sessions"].as_array().unwrap().len(), 3);

    let bad_status = client
        .get(format!("http://{}/api/sessions?status=lost", daemon.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_status.status(), StatusCode::BAD_REQUEST);

    let missing = client
        .get(format!("http://{}/api/nope", daemon.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let missing_body: Value = missing.json().await.unwrap();
    assert_eq!(missing_body["error"]["code"], "not_found");

    let page = client
        .get(format!("http://{}/", daemon.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert!(page.text().await.unwrap().contains("Pandu is recording"));

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn guards_and_budgets_stop_requests_before_they_reach_the_provider() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = config(home.path(), mock.addr);
    // Keep the pause path fast; a real installation waits two minutes.
    config.guard_approval_timeout_ms = 25;
    let daemon = pandu_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();
    let prompt = json!({
        "model": "gpt-4.1",
        "messages": [{ "role": "user", "content": "Say hi" }]
    });

    // A built-in guard pauses on a destructive command; without an approval
    // the pause expires and the request never reaches the provider.
    let blocked = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "please rm -rf / now" }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
    let blocked_body: Value = blocked.json().await.unwrap();
    assert_eq!(blocked_body["error"]["code"], "guard_blocked");
    assert!(
        mock.captured.lock().unwrap().is_empty(),
        "the guard-blocked request must not reach the provider"
    );

    let allowed = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .json(&prompt)
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    let session_id = allowed.headers()["x-pandu-session-id"]
        .to_str()
        .unwrap()
        .to_string();

    // A zero-dollar session budget blocks as soon as the session has spend.
    let created = client
        .post(format!("http://{}/api/budgets", daemon.addr))
        .headers(host_headers(&daemon))
        .json(&json!({
            "name": "Tiny",
            "scope": "session",
            "period": "session",
            "sessionId": session_id,
            "limitUsd": 0.0,
            "enforcement": "block",
            "enabled": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);

    let denied = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .json(&prompt)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::PAYMENT_REQUIRED);
    let denied_body: Value = denied.json().await.unwrap();
    assert_eq!(denied_body["error"]["code"], "budget_exceeded");
    assert_eq!(mock.captured.lock().unwrap().len(), 1);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_control_relays_sanitized_output_and_queues_input() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let base = format!("http://{}", daemon.addr);

    // Register a PTY session. The daemon stores the claim but never spawns it.
    let registered: Value = client
        .post(format!("{base}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "Claude Code",
            "projectName": "checkout-service",
            "workingDir": "C:\\work\\checkout-service",
            "adapter": "claude-code",
            "pid": 1234
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(registered["session"]["status"], "running");
    assert_eq!(registered["session"]["agentName"], "Claude Code");
    // No adapter in this build is verified yet, so detection must not guess.
    assert_eq!(registered["session"]["verified"], false);

    // Output arriving over HTTP is sanitized again on the daemon side.
    let output = client
        .post(format!("{base}/api/agents/{id}/output"))
        .headers(host_headers(&daemon))
        .json(&json!({ "data": "\u{1b}[31mred\u{1b}[0m plain\r\nnext" }))
        .send()
        .await
        .unwrap();
    assert_eq!(output.status(), StatusCode::OK);

    let detail: Value = client
        .get(format!("{base}/api/agents/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail["output"], "red plain\nnext");
    assert_eq!(detail["session"]["outputSequence"], 1);

    // Two keystroke batches, then a long poll starting from the beginning.
    let first: Value = client
        .post(format!("{base}/api/agents/{id}/input"))
        .headers(host_headers(&daemon))
        .json(&json!({ "data": "y\n" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["sequence"], 0);
    let second: Value = client
        .post(format!("{base}/api/agents/{id}/input"))
        .headers(host_headers(&daemon))
        .json(&json!({ "data": "n\n" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(second["sequence"], 1);

    let poll: Value = client
        .get(format!("{base}/api/agents/{id}/input?after=0&waitMs=1000"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(poll["chunks"].as_array().unwrap().len(), 2);
    assert_eq!(poll["chunks"][0]["data"], "y\n");
    assert_eq!(poll["chunks"][1]["data"], "n\n");

    // Advancing the cursor drains the queue and frees its budget.
    let drained: Value = client
        .get(format!("{base}/api/agents/{id}/input?after=2&waitMs=0"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(drained["chunks"].as_array().unwrap().is_empty());

    // An oversized keystroke batch is rejected instead of buffered.
    let oversized = client
        .post(format!("{base}/api/agents/{id}/input"))
        .headers(host_headers(&daemon))
        .json(&json!({ "data": "x".repeat(5_000) }))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::BAD_REQUEST);

    // A typed event lands in the persisted Inbox.
    let created: Value = client
        .post(format!("{base}/api/agents/{id}/events"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "type": "permission",
            "message": "Permission requested: write 3 files.",
            "metadata": { "source": "test" }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let event_id = created["event"]["id"].as_str().unwrap().to_string();
    assert_eq!(created["event"]["type"], "permission");
    assert_eq!(created["event"]["status"], "open");
    assert_eq!(created["event"]["agentName"], "Claude Code");
    assert_eq!(created["event"]["projectName"], "checkout-service");

    let inbox: Value = client
        .get(format!("{base}/api/agent-events?status=open"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(inbox["openCount"], 1);
    assert_eq!(inbox["events"].as_array().unwrap().len(), 1);

    let acked: Value = client
        .post(format!("{base}/api/agent-events/{event_id}/ack"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(acked["event"]["status"], "acknowledged");
    let after_ack: Value = client
        .get(format!("{base}/api/agent-events?status=open"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after_ack["openCount"], 0);

    // Unknown agent sessions are a 404, not an empty 200.
    let missing = client
        .get(format!(
            "{base}/api/agents/{}",
            pandu_core::ids::create_id()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    // Ending the session is idempotent and closes the stored flight.
    let ended: Value = client
        .post(format!("{base}/api/agents/{id}/end"))
        .headers(host_headers(&daemon))
        .json(&json!({ "exitCode": 0 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ended["session"]["status"], "exited");
    assert_eq!(ended["session"]["exitCode"], 0);

    let flight: Value = client
        .get(format!("{base}/api/sessions/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(flight["captureMode"], "pty");
    assert_eq!(flight["status"], "completed");

    let late_input = client
        .post(format!("{base}/api/agents/{id}/input"))
        .headers(host_headers(&daemon))
        .json(&json!({ "data": "late\n" }))
        .send()
        .await
        .unwrap();
    assert_eq!(late_input.status(), StatusCode::BAD_REQUEST);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn pty_model_switch_needs_a_verified_adapter_command() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let base = format!("http://{}", daemon.addr);

    let registered: Value = client
        .post(format!("{base}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "Claude Code",
            "workingDir": "C:\\work\\checkout-service",
            "adapter": "claude-code"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(registered["session"]["modelSwitch"]["available"], true);
    assert_eq!(
        registered["session"]["modelSwitch"]["command"],
        "/model {model}"
    );

    let switched: Value = client
        .post(format!("{base}/api/sessions/{id}/model/switch"))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gpt-5.5" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(switched["mode"], "pty");
    assert_eq!(switched["command"], "/model gpt-5.5");
    assert_eq!(switched["adapter"], "claude-code");

    let poll: Value = client
        .get(format!("{base}/api/agents/{id}/input?after=0&waitMs=0"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(poll["chunks"][0]["data"], "/model gpt-5.5\n");

    // An adapter without a verified command never receives keystrokes.
    let manual: Value = client
        .post(format!("{base}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "OpenCode",
            "workingDir": "C:\\work\\checkout-service",
            "adapter": "opencode"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let manual_id = manual["session"]["sessionId"].as_str().unwrap().to_string();
    assert_eq!(manual["session"]["modelSwitch"]["available"], false);
    let fallback: Value = client
        .post(format!("{base}/api/sessions/{manual_id}/model/switch"))
        .headers(host_headers(&daemon))
        .json(&json!({ "model": "gpt-5.5" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(fallback["mode"], "manual");
    assert_eq!(fallback["command"], Value::Null);
    assert!(
        fallback["instructions"]
            .as_str()
            .unwrap()
            .contains("no verified model switch")
    );
    let manual_poll: Value = client
        .get(format!(
            "{base}/api/agents/{manual_id}/input?after=0&waitMs=0"
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(manual_poll["chunks"].as_array().unwrap().is_empty());

    let audit: Value = client
        .get(format!("{base}/api/remote/audit?limit=50"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events: Vec<&str> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["event"].as_str())
        .collect();
    assert!(events.contains(&"model.switch"));
    assert!(events.contains(&"model.switch.manual"));

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_foreign_host_header_is_rejected() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let daemon = start_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("http://{}/api/health", daemon.addr))
        .header(reqwest::header::HOST, "pandu.attacker.example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "forbidden_host");

    // The loopback host header still works.
    let ok = client
        .get(format!("http://{}/api/health", daemon.addr))
        .header(
            reqwest::header::HOST,
            format!("127.0.0.1:{}", daemon.addr.port()),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);

    daemon.shutdown().await.unwrap();
}
