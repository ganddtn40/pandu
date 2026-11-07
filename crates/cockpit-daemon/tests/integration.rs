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
use cockpit_daemon::{Config, ServerHandle};
use http::StatusCode;
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
        headers,
        body: body.clone(),
    });

    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let stream = parsed
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if path.ends_with("/chat/completions") && stream {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(SSE_BODY))
            .unwrap();
    }
    if path.ends_with("/chat/completions") {
        return json_response(json!({
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "model": "gpt-4.1",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": "Hello from the mock" },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 12, "completion_tokens": 5 }
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
    cockpit_daemon::spawn(config(home, upstream))
        .await
        .expect("the daemon should start")
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
        if let Some(step) = payload["steps"].as_array().and_then(|steps| steps.first()) {
            if step["status"] != "running" {
                return step.clone();
            }
        }
        assert!(
            Instant::now() < deadline,
            "the step did not finish in time: {payload}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn records_openai_requests_and_redacts_stored_headers() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = config(home.path(), mock.addr);
    config.openai.api_key = Some("configured-key".to_string());
    let daemon = cockpit_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let response = client
        .post(format!("http://{}/v1/chat/completions", daemon.addr))
        .header("authorization", "Bearer agent-key")
        .header("content-type", "application/json")
        .header("x-cockpit-provider", "deepseek")
        .json(&json!({
            "model": "gpt-4.1",
            "messages": [{ "role": "user", "content": "Say hi" }]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response.headers()["x-cockpit-session-id"]
        .to_str()
        .unwrap()
        .to_string();
    let step_id = response.headers()["x-cockpit-step-id"]
        .to_str()
        .unwrap()
        .to_string();
    let body = response.text().await.unwrap();
    assert!(body.contains("Hello from the mock"));

    let captured = mock.last();
    assert_eq!(captured.path, "/v1/chat/completions");
    assert_eq!(captured.headers["authorization"], "Bearer agent-key");
    assert_eq!(captured.headers["accept-encoding"], "identity");
    assert!(!captured.headers.contains_key("x-cockpit-provider"));
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
    let session_id = response.headers()["x-cockpit-session-id"]
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
async fn sentinel_swaps_in_configured_anthropic_key() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = config(home.path(), mock.addr);
    config.anthropic.api_key = Some("real-anthropic-key".to_string());
    let daemon = cockpit_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let response = client
        .post(format!("http://{}/v1/messages", daemon.addr))
        .header("x-api-key", "cockpit-proxy")
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
    let session_id = response.headers()["x-cockpit-session-id"]
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
    let daemon = cockpit_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let response = client
        .post(format!(
            "http://{}/v1beta/models/gemini-2.5-pro:generateContent",
            daemon.addr
        ))
        .header("x-goog-api-key", "cockpit-proxy")
        .header("content-type", "application/json")
        .json(&json!({
            "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let session_id = response.headers()["x-cockpit-session-id"]
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
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(seeded["seeded"], 3);

    let again: Value = client
        .post(format!("http://{}/api/demo/seed", daemon.addr))
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
    assert_eq!(overview["stats"]["sessionCount"], 3);
    assert_eq!(overview["stats"]["activeSessionCount"], 1);
    assert_eq!(overview["stats"]["unknownCostCalls"], 1);
    assert!(overview["stats"]["totalCostUsd"].as_f64().unwrap() > 0.0);
    assert_eq!(overview["activeSessions"].as_array().unwrap().len(), 1);

    let sessions: Value = client
        .get(format!("http://{}/api/sessions", daemon.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sessions["total"], 3);
    let list = sessions["sessions"].as_array().unwrap();
    assert_eq!(list.len(), 3);

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
    assert!(page.text().await.unwrap().contains("Cockpit is recording"));

    daemon.shutdown().await.unwrap();
}
