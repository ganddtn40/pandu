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
    let daemon = cockpit_daemon::spawn(config).await.unwrap();
    let client = reqwest::Client::new();

    let scan: Value = client
        .post(format!("http://{}/api/logwatch/scan", daemon.addr))
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

#[tokio::test(flavor = "multi_thread")]
async fn guards_and_budgets_stop_requests_before_they_reach_the_provider() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = config(home.path(), mock.addr);
    // Keep the pause path fast; a real installation waits two minutes.
    config.guard_approval_timeout_ms = 25;
    let daemon = cockpit_daemon::spawn(config).await.unwrap();
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
    let session_id = allowed.headers()["x-cockpit-session-id"]
        .to_str()
        .unwrap()
        .to_string();

    // A zero-dollar session budget blocks as soon as the session has spend.
    let created = client
        .post(format!("http://{}/api/budgets", daemon.addr))
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
        .json(&json!({ "data": "x".repeat(5_000) }))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::BAD_REQUEST);

    // A typed event lands in the persisted Inbox.
    let created: Value = client
        .post(format!("{base}/api/agents/{id}/events"))
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
            cockpit_core::ids::create_id()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    // Ending the session is idempotent and closes the stored flight.
    let ended: Value = client
        .post(format!("{base}/api/agents/{id}/end"))
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
        .json(&json!({ "data": "late\n" }))
        .send()
        .await
        .unwrap();
    assert_eq!(late_input.status(), StatusCode::BAD_REQUEST);

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
        .header(reqwest::header::HOST, "cockpit.attacker.example")
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
