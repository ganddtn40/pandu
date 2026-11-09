//! Phase 7 remote access tests.
//!
//! These tests start the real daemon, enable the real remote listener in
//! tunnel mode on loopback, and speak HTTP/WebSocket to it. They cover the
//! promises that matter for remote access: the listener is off by default,
//! every route is scoped, model proxy routes never exist there, revocation
//! closes live sockets, pairing is host-confirmed and single use, and the
//! audit log never stores prompt contents.

use std::net::SocketAddr;
use std::path::Path;
use std::time::{Duration, Instant};

use axum::Router;
use cockpit_core::agent::{AgentEventInput, AgentEventType};
use cockpit_core::guard::{
    GuardAction, GuardEventStatus, GuardEvidence, GuardRuleKind, GuardSeverity,
};
use cockpit_core::model::{CaptureMode, SessionSource, SessionStatus};
use cockpit_core::provider::{AgentInfo, DetectedFrom};
use cockpit_daemon::remote::{RemoteAccess, RemoteMode};
use cockpit_daemon::store::{NewGuardEvent, NewSession, Store};
use cockpit_daemon::{Config, ServerHandle};
use futures_util::StreamExt;
use http::StatusCode;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const DUMMY_ID: &str = "00000000-0000-4000-8000-000000000000";

const PROMPT_SENTINEL: &str = "PROMPT_SENTINEL_4f9a";
const SOURCE_LABEL_SENTINEL: &str = "SOURCE_LABEL_SENTINEL_4f9a";
const WORKSPACE_SENTINEL: &str = "WORKSPACE_SENTINEL_4f9a";
const BRANCH_SENTINEL: &str = "BRANCH_SENTINEL_4f9a";
const TAG_SENTINEL: &str = "TAG_SENTINEL_4f9a";
const METADATA_SENTINEL: &str = "METADATA_SENTINEL_4f9a";
const GUARD_TITLE_SENTINEL: &str = "GUARD_TITLE_SENTINEL_4f9a";
const GUARD_DESCRIPTION_SENTINEL: &str = "GUARD_DESCRIPTION_SENTINEL_4f9a";
const COMMAND_SENTINEL: &str = "COMMAND_SENTINEL_4f9a";
const EVIDENCE_SENTINEL: &str = "EVIDENCE_SENTINEL_4f9a";
const EVIDENCE_PATH_SENTINEL: &str = "EVIDENCE_PATH_SENTINEL_4f9a";
const EVIDENCE_METADATA_SENTINEL: &str = "EVIDENCE_METADATA_SENTINEL_4f9a";
const GUARD_METADATA_SENTINEL: &str = "GUARD_METADATA_SENTINEL_4f9a";
const NONCE_SENTINEL: &str = "NONCE_SENTINEL_4f9a";
const WORKDIR_SENTINEL: &str = "WORKDIR_SENTINEL_4f9a";
const TERMINAL_MESSAGE_SENTINEL: &str = "TERMINAL_MESSAGE_SENTINEL_4f9a";
const EVENT_METADATA_SENTINEL: &str = "EVENT_METADATA_SENTINEL_4f9a";
const TERMINAL_OUTPUT_SENTINEL: &str = "TERMINAL_OUTPUT_SENTINEL_4f9a";

fn assert_no_status_leak(path: &str, body: &str) {
    for sentinel in [
        PROMPT_SENTINEL,
        SOURCE_LABEL_SENTINEL,
        WORKSPACE_SENTINEL,
        BRANCH_SENTINEL,
        TAG_SENTINEL,
        METADATA_SENTINEL,
        GUARD_TITLE_SENTINEL,
        GUARD_DESCRIPTION_SENTINEL,
        COMMAND_SENTINEL,
        EVIDENCE_SENTINEL,
        EVIDENCE_PATH_SENTINEL,
        EVIDENCE_METADATA_SENTINEL,
        GUARD_METADATA_SENTINEL,
        NONCE_SENTINEL,
        WORKDIR_SENTINEL,
        TERMINAL_MESSAGE_SENTINEL,
        EVENT_METADATA_SENTINEL,
        TERMINAL_OUTPUT_SENTINEL,
    ] {
        assert!(
            !body.contains(sentinel),
            "{path} leaked {sentinel} to a status-only device: {body}"
        );
    }
}

struct MockUpstream {
    addr: SocketAddr,
    task: JoinHandle<()>,
}

impl MockUpstream {
    async fn start() -> Self {
        let app = Router::new().fallback(|| async {
            axum::Json(json!({
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "model": "gpt-4.1",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "ok" },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
            }))
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { addr, task }
    }
}

impl Drop for MockUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn config(home: &Path, upstream: SocketAddr) -> Config {
    let mut config = Config::for_home(home);
    config.host = "127.0.0.1".to_string();
    config.port = 0;
    let base = format!("http://{upstream}");
    config.openai.base_url = base.clone();
    config.anthropic.base_url = base.clone();
    config.gemini.base_url = base;
    config
}

async fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

fn host_base(daemon: &ServerHandle) -> String {
    format!("http://{}", daemon.addr)
}

/// Headers every state-changing host request must carry: the loopback Origin,
/// the per-process CSRF token, and a JSON content type.
fn host_headers(daemon: &ServerHandle) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ORIGIN,
        format!("http://{}", daemon.addr).parse().unwrap(),
    );
    headers.insert("x-cockpit-csrf", daemon.state.csrf.parse().unwrap());
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    headers
}

#[allow(clippy::too_many_arguments)]
async fn send_host_mutation(
    client: &reqwest::Client,
    host: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    origin: Option<&str>,
    csrf: Option<&str>,
    content_type: &str,
) -> reqwest::Response {
    let mut builder = match method {
        "POST" => client.post(format!("{host}{path}")),
        "PATCH" => client.patch(format!("{host}{path}")),
        other => panic!("unexpected method {other}"),
    };
    if let Some(origin) = origin {
        builder = builder.header("origin", origin);
    }
    if let Some(csrf) = csrf {
        builder = builder.header("x-cockpit-csrf", csrf);
    }
    builder = builder.header("content-type", content_type);
    if let Some(body) = body {
        builder = builder.body(serde_json::to_vec(body).unwrap());
    }
    builder.send().await.unwrap()
}

/// Start a daemon with the remote listener enabled in tunnel mode on loopback.
async fn start_remote_daemon(home: &Path, upstream: SocketAddr) -> (ServerHandle, String) {
    let port = free_port().await;
    let mut config = config(home, upstream);
    config.remote_port = port;
    let daemon = cockpit_daemon::spawn(config).await.unwrap();
    let host = host_base(&daemon);
    let public_url = format!("http://127.0.0.1:{port}");
    let response = reqwest::Client::new()
        .post(format!("{host}/api/remote/enable"))
        .headers(host_headers(&daemon))
        .json(&json!({ "mode": "tunnel", "publicUrl": public_url }))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "enabling remote access failed: {}",
        response.text().await.unwrap()
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(response) = reqwest::Client::new()
            .get(format!("{public_url}/"))
            .send()
            .await
        {
            if response
                .headers()
                .get("x-cockpit-remote")
                .and_then(|value| value.to_str().ok())
                == Some("1")
            {
                break;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the remote listener did not become reachable"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    (daemon, public_url)
}

#[tokio::test(flavor = "multi_thread")]
async fn tunnel_status_waits_for_the_public_host_and_rejects_host_or_origin_mismatch() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let port = free_port().await;
    let mut config = config(home.path(), mock.addr);
    config.remote_port = port;
    let daemon = cockpit_daemon::spawn(config).await.unwrap();
    let host = host_base(&daemon);
    let public_url = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();

    let enabled: Value = client
        .post(format!("{host}/api/remote/enable"))
        .headers(host_headers(&daemon))
        .json(&json!({ "mode": "tunnel", "publicUrl": public_url }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(enabled["awaitingTunnel"], true);
    assert_eq!(enabled["url"], public_url);

    // A loopback Host is still allowed, but the configured host is what marks
    // the tunnel as actually reachable.
    let mismatch = client
        .get(format!("{public_url}/"))
        .header("host", "evil.example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(mismatch.status(), StatusCode::FORBIDDEN);
    let mismatch_origin = client
        .get(format!("{public_url}/"))
        .header("origin", "https://evil.example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(mismatch_origin.status(), StatusCode::FORBIDDEN);

    let good = client.get(format!("{public_url}/")).send().await.unwrap();
    assert_eq!(good.status(), StatusCode::OK);
    assert_eq!(good.headers()["x-cockpit-remote"], "1");
    let status: Value = client
        .get(format!("{host}/api/remote/status"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["awaitingTunnel"], false);

    daemon.shutdown().await.unwrap();
}

struct PairedDevice {
    id: String,
    token: String,
}

async fn pair_device(
    daemon: &ServerHandle,
    remote: &str,
    name: &str,
    pin: Option<&str>,
) -> PairedDevice {
    pair_device_with_expiry(daemon, remote, name, pin, None).await
}

async fn pair_device_with_expiry(
    daemon: &ServerHandle,
    remote: &str,
    name: &str,
    pin: Option<&str>,
    expires_in_days: Option<u32>,
) -> PairedDevice {
    let host = host_base(daemon);
    let client = reqwest::Client::new();
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .headers(host_headers(daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 32);
    let mut body = json!({ "verificationCode": "1234", "code": code, "deviceName": name });
    if let Some(pin) = pin {
        body["pin"] = json!(pin);
    }
    let claim: Value = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let claim_id = claim["claimId"].as_str().unwrap().to_string();
    let claim_secret = claim["claimSecret"].as_str().unwrap().to_string();

    let pending: Value = client
        .get(format!("{host}/api/remote/pair/pending"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        pending["pairings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|pairing| pairing["deviceName"] == name),
        "the host should see the waiting device"
    );

    let mut confirmation = json!({ "verificationCode": "1234" });
    if let Some(days) = expires_in_days {
        confirmation["expiresInDays"] = json!(days);
    }
    let confirmed = client
        .post(format!("{host}/api/remote/pair/pending/{claim_id}/confirm"))
        .headers(host_headers(daemon))
        .json(&confirmation)
        .send()
        .await
        .unwrap();
    assert!(confirmed.status().is_success());

    let poll: Value = client
        .post(format!("{remote}/api/remote/pair/claim/{claim_id}"))
        .header("x-pairing-secret", &claim_secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(poll["status"], "confirmed");
    let token = poll["token"]
        .as_str()
        .expect("the device gets a token")
        .to_string();
    assert_eq!(token.len(), 64);
    PairedDevice {
        id: poll["deviceId"].as_str().unwrap().to_string(),
        token,
    }
}

async fn set_scopes(
    daemon: &ServerHandle,
    device_id: &str,
    scopes: &[&str],
    require_host_confirmation: bool,
) {
    let response = reqwest::Client::new()
        .patch(format!(
            "{}/api/remote/devices/{device_id}",
            host_base(daemon)
        ))
        .headers(host_headers(daemon))
        .json(&json!({
            "scopes": scopes,
            "requireHostConfirmation": require_host_confirmation,
        }))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "scope update failed: {}",
        response.text().await.unwrap()
    );
}

async fn append_agent_output(
    client: &reqwest::Client,
    daemon: &ServerHandle,
    session_id: &str,
    data: &str,
) {
    let response = client
        .post(format!(
            "{}/api/agents/{session_id}/output",
            host_base(daemon)
        ))
        .headers(host_headers(daemon))
        .json(&json!({ "data": data }))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "agent output failed: {}",
        response.text().await.unwrap()
    );
}

/// Detection looks at the last 800 characters, so push old output out of the
/// window before setting the exact state the agent is waiting in.
async fn set_agent_prompt_state(
    client: &reqwest::Client,
    daemon: &ServerHandle,
    session_id: &str,
    output: &str,
) {
    append_agent_output(client, daemon, session_id, &".".repeat(900)).await;
    append_agent_output(client, daemon, session_id, output).await;
}

async fn mark_awaiting_prompt(client: &reqwest::Client, daemon: &ServerHandle, session_id: &str) {
    set_agent_prompt_state(
        client,
        daemon,
        session_id,
        "Type your response and press Enter",
    )
    .await;
}

fn request_body(path: &str) -> Option<Value> {
    if path.ends_with("/decision") {
        return Some(json!({
            "decision": "approve",
            "nonce": "wrong-nonce",
            "sessionId": DUMMY_ID,
        }));
    }
    if path.ends_with("/prompt") {
        return Some(json!({ "text": "hello" }));
    }
    if path == "/api/remote/pair/claim" {
        return Some(json!({
            "code": "00000000000000000000000000000000",
            "deviceName": "Fuzzer",
            "verificationCode": "1234",
        }));
    }
    None
}

async fn send_remote(
    client: &reqwest::Client,
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> reqwest::Response {
    let mut builder = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PATCH" => client.patch(url),
        "PUT" => client.put(url),
        other => panic!("unexpected method {other}"),
    };
    if let Some(token) = token {
        builder = builder.bearer_auth(token);
    }
    if let Some(body) = body {
        builder = builder.json(body);
    }
    builder.send().await.expect("remote request")
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_listener_never_mounts_proxy_routes_or_host_management() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    for path in [
        "/v1/models",
        "/v1/chat/completions",
        "/openai/v1/chat/completions",
        "/anthropic/v1/messages",
        "/gemini/v1beta/models/gemini-2.5-pro:generateContent",
        "/s/abc",
    ] {
        let response = client.get(format!("{remote}{path}")).send().await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "{path} must not exist on the remote listener"
        );
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "not_found");
    }

    // The dashboard is still served.
    let index = client.get(format!("{remote}/")).send().await.unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    assert!(
        index
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .contains("text/html")
    );

    // Host management routes are loopback-only. A paired device cannot turn
    // remote access off, list devices, or read the audit log remotely.
    let device = pair_device(&daemon, &remote, "Phone", None).await;
    for path in [
        "/api/remote/devices",
        "/api/remote/audit",
        "/api/remote/pair/pending",
        "/api/remote/enable",
        "/api/remote/panic",
    ] {
        let response = send_remote(
            &client,
            "GET",
            &format!("{remote}{path}"),
            Some(&device.token),
            None,
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "{path} must not be reachable from the remote listener"
        );
    }

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn every_remote_endpoint_enforces_its_scope() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();

    let viewer = pair_device(&daemon, &remote, "Viewer", None).await;
    let full = pair_device(&daemon, &remote, "Full", Some("123456")).await;
    set_scopes(
        &daemon,
        &full.id,
        &["view:status", "view:content", "respond", "prompt"],
        true,
    )
    .await;

    for endpoint in RemoteAccess::scope_matrix() {
        if endpoint.path.ends_with("/logout") {
            // Logout revokes the device; it has its own test.
            continue;
        }
        if endpoint.path.ends_with("/live") {
            // The live socket authenticates with a single-use ticket in the
            // WebSocket subprotocol; it is covered by its own test.
            continue;
        }
        let path = endpoint.path.replace("{id}", DUMMY_ID);
        let url = format!("{remote}{path}");
        let body = request_body(endpoint.path);
        let body_ref = body.as_ref();

        let unauthenticated = send_remote(&client, endpoint.method, &url, None, body_ref).await;
        if endpoint.scope == "none" {
            assert_ne!(
                unauthenticated.status(),
                StatusCode::FORBIDDEN,
                "{path} is public and must not be scope-gated"
            );
        } else {
            assert_eq!(
                unauthenticated.status(),
                StatusCode::UNAUTHORIZED,
                "{path} must require a token"
            );
            daemon.state.remote.clear_auth_failures("auth:127.0.0.1");
        }

        let as_viewer = send_remote(
            &client,
            endpoint.method,
            &url,
            Some(&viewer.token),
            body_ref,
        )
        .await;
        if endpoint.scope == "none" {
            assert_ne!(as_viewer.status(), StatusCode::FORBIDDEN, "{path}");
        } else if endpoint.scope == "view:status" {
            assert_ne!(
                as_viewer.status(),
                StatusCode::UNAUTHORIZED,
                "{path} should accept the View status scope"
            );
            assert_ne!(
                as_viewer.status(),
                StatusCode::FORBIDDEN,
                "{path} should accept the View status scope"
            );
        } else {
            assert_eq!(
                as_viewer.status(),
                StatusCode::FORBIDDEN,
                "{path} needs the {} scope",
                endpoint.scope
            );
            let payload: Value = as_viewer.json().await.unwrap();
            assert_eq!(payload["error"]["code"], "scope_required");
        }

        let as_full =
            send_remote(&client, endpoint.method, &url, Some(&full.token), body_ref).await;
        if endpoint.scope == "none" {
            assert_ne!(as_full.status(), StatusCode::FORBIDDEN, "{path}");
        } else {
            assert_ne!(
                as_full.status(),
                StatusCode::UNAUTHORIZED,
                "{path} should accept a paired device"
            );
            assert_ne!(
                as_full.status(),
                StatusCode::FORBIDDEN,
                "{path} should accept the {} scope",
                endpoint.scope
            );
        }
    }

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn revocation_closes_a_live_socket_immediately() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let device = pair_device(&daemon, &remote, "Live phone", None).await;

    let ticket: Value = client
        .post(format!("{remote}/api/remote/ws-ticket"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let protocol = ticket["protocol"].as_str().unwrap().to_string();

    let ws_url = remote.replacen("http://", "ws://", 1) + "/api/remote/live";
    let mut request = ws_url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("sec-websocket-protocol", protocol.parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("the live socket connects");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);

    let ready = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("a live.ready message")
        .expect("a message")
        .expect("a valid frame");
    assert!(ready.to_text().unwrap().contains("live.ready"));

    let revoked = client
        .post(format!(
            "{}/api/remote/devices/{}/revoke",
            host_base(&daemon),
            device.id
        ))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(revoked.status().is_success());

    let closed = tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(frame))) => {
                    return frame.map(|frame| frame.reason.to_string());
                }
                Some(Err(_)) | None => return None,
                _ => {}
            }
        }
    })
    .await
    .expect("the socket closes after revocation");
    if let Some(reason) = closed {
        assert!(reason.contains("revoked"), "close reason was {reason}");
    }

    // The old token is dead and a fresh ticket cannot be minted.
    let after = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(after.status(), StatusCode::FORBIDDEN);
    let body: Value = after.json().await.unwrap();
    assert_eq!(body["error"]["code"], "remote_device_revoked");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn live_events_hide_content_from_status_only_devices() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Status phone", None).await;

    let ticket: Value = client
        .post(format!("{remote}/api/remote/ws-ticket"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let protocol = ticket["protocol"].as_str().unwrap().to_string();
    let ws_url = remote.replacen("http://", "ws://", 1) + "/api/remote/live";
    let mut request = ws_url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("sec-websocket-protocol", protocol.parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("the live socket connects");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);

    let ready = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("a live.ready message")
        .expect("a message")
        .expect("a valid frame");
    assert!(ready.to_text().unwrap().contains("live.ready"));

    // Status events still flow to a status-only device.
    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "Live agent",
            "workingDir": "C:/work",
            "adapter": "opencode",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let saw_started = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Text(text) = frame {
                if text.contains("agent.started") {
                    return true;
                }
            }
        }
        false
    })
    .await
    .expect("agent.started reaches the status device");
    assert!(saw_started);

    // Terminal output is content, so it never leaves the daemon for this
    // device, and the payload text never appears on the socket.
    append_agent_output(&client, &daemon, &session_id, "terminal-secret-value").await;
    let leaked = tokio::time::timeout(Duration::from_millis(1200), async {
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Text(text) = frame {
                if text.contains("agent.output") || text.contains("terminal-secret-value") {
                    return true;
                }
            }
        }
        false
    })
    .await;
    assert!(
        leaked.is_err(),
        "status-only device received terminal output"
    );

    // Raising the Content scope takes effect on the existing socket without a
    // replay of anything it already missed.
    set_scopes(&daemon, &device.id, &["view:status", "view:content"], false).await;
    append_agent_output(&client, &daemon, &session_id, "visible-now").await;
    let saw_output = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Text(text) = frame {
                if text.contains("agent.output") && text.contains("visible-now") {
                    return true;
                }
            }
        }
        false
    })
    .await
    .expect("content events flow after the grant");
    assert!(saw_output);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn status_scope_never_returns_prompt_command_path_or_terminal_content() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Status only", None).await;
    set_scopes(&daemon, &device.id, &["view:status"], true).await;

    let session = daemon
        .state
        .store
        .create_session(NewSession {
            title: format!("{PROMPT_SENTINEL} refactor the checkout flow"),
            source: SessionSource::Proxy,
            capture_mode: CaptureMode::Proxy,
            source_label: Some(SOURCE_LABEL_SENTINEL.to_string()),
            status: SessionStatus::Active,
            agent: Some(AgentInfo {
                name: Some("Sentinel Agent".to_string()),
                version: None,
                user_agent: None,
                detected_from: DetectedFrom::Manual,
            }),
            workspace_path: Some(format!("C:\\{WORKSPACE_SENTINEL}\\repo")),
            git_branch: Some(BRANCH_SENTINEL.to_string()),
            tags: vec![TAG_SENTINEL.to_string()],
            metadata: Some(json!({ "prompt": METADATA_SENTINEL })),
            ..Default::default()
        })
        .unwrap();

    let secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339();
    daemon
        .state
        .store
        .insert_guard_event(NewGuardEvent {
            session_id: session.id.clone(),
            step_id: None,
            rule_id: "test.status.leak".to_string(),
            kind: GuardRuleKind::DangerousCommand,
            action: GuardAction::Pause,
            severity: GuardSeverity::Critical,
            status: GuardEventStatus::Pending,
            title: GUARD_TITLE_SENTINEL.to_string(),
            description: GUARD_DESCRIPTION_SENTINEL.to_string(),
            command: Some(format!("rm -rf / # {COMMAND_SENTINEL} {secret}")),
            evidence: vec![GuardEvidence {
                field: Some("command".to_string()),
                excerpt: Some(format!("{EVIDENCE_SENTINEL} {secret}")),
                path: Some(format!("C:\\{EVIDENCE_PATH_SENTINEL}")),
                line: Some(4),
                metadata: Some(json!({ "secret": EVIDENCE_METADATA_SENTINEL })),
            }],
            metadata: Some(json!({ "secret": GUARD_METADATA_SENTINEL })),
            approval_nonce: Some(NONCE_SENTINEL.to_string()),
            approval_expires_at: Some(expires_at),
        })
        .unwrap();

    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "Terminal Agent",
            "projectName": "repo",
            "workingDir": format!("C:\\{WORKDIR_SENTINEL}\\repo"),
            "adapter": "opencode",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let agent_id = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    daemon
        .state
        .store
        .insert_agent_event(
            &agent_id,
            "Terminal Agent",
            "repo",
            &AgentEventInput {
                event_type: AgentEventType::Question,
                message: TERMINAL_MESSAGE_SENTINEL.to_string(),
                metadata: Some(json!({ "prompt": EVENT_METADATA_SENTINEL })),
            },
        )
        .unwrap();

    let endpoints = [
        "/api/remote/session".to_string(),
        "/api/remote/overview".to_string(),
        "/api/remote/sessions".to_string(),
        format!("/api/remote/sessions/{}", session.id),
        "/api/remote/guards/events".to_string(),
        "/api/remote/agents".to_string(),
        "/api/remote/agent-events".to_string(),
    ];
    for path in endpoints {
        let response = client
            .get(format!("{remote}{path}"))
            .bearer_auth(&device.token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let body = response.text().await.unwrap();
        assert_no_status_leak(&path, &body);
        assert!(
            !body.contains(secret),
            "{path} leaked a raw credential to a status-only device: {body}"
        );
    }

    // The guard list keeps only risk, rule class, and a neutral label.
    let guards: Value = client
        .get(format!("{remote}/api/remote/guards/events"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let event = guards["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["ruleId"] == "test.status.leak")
        .expect("the status device sees the approval");
    assert_eq!(event["title"], "Approval requested");
    assert_eq!(event["ruleName"], "Dangerous command");
    assert_eq!(event["severity"], "critical");
    assert!(event.get("command").is_none());
    assert!(event.get("evidence").is_none());
    assert!(event.get("description").is_none());
    assert!(event.get("approvalNonce").is_none());

    // The flight keeps its ordinal and agent but loses the prompt title, path,
    // branch, source label, tags, and metadata.
    let sessions: Value = client
        .get(format!("{remote}/api/remote/sessions"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let flight = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == session.id)
        .expect("the status device sees the flight");
    let title = flight["title"].as_str().unwrap();
    assert!(
        title.starts_with("Flight ") && title.ends_with("Sentinel Agent"),
        "unexpected neutral title: {title}"
    );
    for key in [
        "workspacePath",
        "gitBranch",
        "gitBaseCommit",
        "sourceLabel",
        "tags",
        "metadata",
    ] {
        assert!(flight.get(key).is_none(), "status flight leaked {key}");
    }

    // The agent list and inbox lose workspace and terminal metadata.
    let agents: Value = client
        .get(format!("{remote}/api/remote/agents"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let agent = agents["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["sessionId"] == agent_id)
        .expect("the status device sees the agent");
    assert!(agent.get("workingDir").is_none());
    let inbox: Value = client
        .get(format!("{remote}/api/remote/agent-events"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let event = inbox["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["sessionId"] == agent_id)
        .expect("the status device sees the inbox event");
    assert_eq!(event["type"], "question");
    assert!(event.get("message").is_none());
    assert!(event.get("metadata").is_none());

    // A live ticket carries no content either.
    let ticket = client
        .post(format!("{remote}/api/remote/ws-ticket"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(ticket.status(), StatusCode::OK);
    assert_no_status_leak("/api/remote/ws-ticket", &ticket.text().await.unwrap());

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn respond_and_content_scopes_see_redacted_guard_evidence() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let content = pair_device(&daemon, &remote, "Content", None).await;
    set_scopes(
        &daemon,
        &content.id,
        &["view:status", "view:content"],
        false,
    )
    .await;
    let responder = pair_device(&daemon, &remote, "Responder", Some("123456")).await;
    set_scopes(&daemon, &responder.id, &["view:status", "respond"], true).await;

    let session = daemon
        .state
        .store
        .create_session(NewSession {
            title: "Guard evidence flight".to_string(),
            source: SessionSource::Proxy,
            capture_mode: CaptureMode::Proxy,
            status: SessionStatus::Active,
            ..Default::default()
        })
        .unwrap();
    let secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339();
    daemon
        .state
        .store
        .insert_guard_event(NewGuardEvent {
            session_id: session.id.clone(),
            step_id: None,
            rule_id: "test.content.guard".to_string(),
            kind: GuardRuleKind::DangerousCommand,
            action: GuardAction::Pause,
            severity: GuardSeverity::Critical,
            status: GuardEventStatus::Pending,
            title: GUARD_TITLE_SENTINEL.to_string(),
            description: GUARD_DESCRIPTION_SENTINEL.to_string(),
            command: Some(format!("rm -rf / # {COMMAND_SENTINEL} {secret}")),
            evidence: vec![GuardEvidence {
                field: Some("command".to_string()),
                excerpt: Some(format!("{EVIDENCE_SENTINEL} {secret}")),
                path: Some(format!("C:\\{EVIDENCE_PATH_SENTINEL}")),
                line: Some(4),
                metadata: None,
            }],
            metadata: None,
            approval_nonce: Some(NONCE_SENTINEL.to_string()),
            approval_expires_at: Some(expires_at),
        })
        .unwrap();

    for (label, device, expect_nonce) in [
        ("view:content", &content, false),
        ("respond", &responder, true),
    ] {
        let guards: Value = client
            .get(format!("{remote}/api/remote/guards/events"))
            .bearer_auth(&device.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let event = guards["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["ruleId"] == "test.content.guard")
            .unwrap_or_else(|| panic!("{label} should see the approval"));
        assert_eq!(event["title"], GUARD_TITLE_SENTINEL, "{label}");
        assert_eq!(event["description"], GUARD_DESCRIPTION_SENTINEL, "{label}");
        let command = event["command"].as_str().unwrap();
        assert!(command.contains(COMMAND_SENTINEL), "{label}");
        assert!(!command.contains(secret), "{label} leaked a raw credential");
        let excerpt = event["evidence"][0]["excerpt"].as_str().unwrap();
        assert!(excerpt.contains(EVIDENCE_SENTINEL), "{label}");
        assert!(!excerpt.contains(secret), "{label} leaked a raw credential");
        if expect_nonce {
            assert_eq!(event["approvalNonce"], NONCE_SENTINEL, "{label}");
        } else {
            assert!(
                event.get("approvalNonce").is_none(),
                "{label} must not receive the approval nonce"
            );
        }
    }

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn status_live_events_strip_titles_messages_and_paths() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let device = pair_device(&daemon, &remote, "Live status", None).await;
    set_scopes(&daemon, &device.id, &["view:status"], true).await;

    let ticket: Value = client
        .post(format!("{remote}/api/remote/ws-ticket"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let protocol = ticket["protocol"].as_str().unwrap().to_string();
    let ws_url = remote.replacen("http://", "ws://", 1) + "/api/remote/live";
    let mut request = ws_url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("sec-websocket-protocol", protocol.parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("the live socket connects");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);

    let ready = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("a live.ready message")
        .expect("a message")
        .expect("a valid frame");
    assert!(ready.to_text().unwrap().contains("live.ready"));

    let session = daemon
        .state
        .store
        .create_session(NewSession {
            title: PROMPT_SENTINEL.to_string(),
            source: SessionSource::Manual,
            capture_mode: CaptureMode::Pty,
            status: SessionStatus::Active,
            ..Default::default()
        })
        .unwrap();
    daemon.state.live.publish(
        "session.started",
        Some(&session.id),
        None,
        json!({
            "title": PROMPT_SENTINEL,
            "source": "manual",
            "captureMode": "pty",
            "status": "active",
            "agentName": "Live Sentinel Agent",
            "projectName": "repo",
            "workspacePath": format!("C:\\{WORKSPACE_SENTINEL}"),
        }),
    );
    daemon.state.live.publish(
        "agent.started",
        Some(&session.id),
        None,
        json!({
            "session": {
                "sessionId": session.id,
                "agentName": "Live Sentinel Agent",
                "projectName": "repo",
                "workingDir": format!("C:\\{WORKDIR_SENTINEL}"),
                "status": "running",
            }
        }),
    );
    daemon.state.live.publish(
        "guard.triggered",
        Some(&session.id),
        None,
        json!({
            "ruleId": "test.live.guard",
            "kind": "dangerous_command",
            "action": "pause",
            "severity": "critical",
            "status": "pending",
            "title": GUARD_TITLE_SENTINEL,
            "description": GUARD_DESCRIPTION_SENTINEL,
            "command": COMMAND_SENTINEL,
            "evidence": [EVIDENCE_SENTINEL],
        }),
    );
    daemon.state.live.publish(
        "agent.event",
        Some(&session.id),
        None,
        json!({
            "event": {
                "id": "00000000-0000-4000-8000-000000000000",
                "sessionId": session.id,
                "agentName": "Live Sentinel Agent",
                "projectName": "repo",
                "type": "question",
                "message": TERMINAL_MESSAGE_SENTINEL,
                "status": "open",
                "createdAt": "2026-01-01T00:00:00Z",
                "metadata": { "prompt": EVENT_METADATA_SENTINEL },
            }
        }),
    );
    daemon.state.live.publish(
        "agent.output",
        Some(&session.id),
        None,
        json!({ "sessionId": session.id, "sequence": 1, "data": TERMINAL_OUTPUT_SENTINEL }),
    );

    let mut saw_started = false;
    let mut saw_guard = false;
    let mut saw_agent_event = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !(saw_started && saw_guard && saw_agent_event) {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let frame = match tokio::time::timeout(remaining, socket.next()).await {
            Ok(Some(Ok(frame))) => frame,
            Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
        };
        let Message::Text(text) = frame else {
            continue;
        };
        assert_no_status_leak("/api/remote/live", &text);
        if text.contains("\"session.started\"") {
            let value: Value = serde_json::from_str(&text).unwrap();
            let title = value["payload"]["title"].as_str().unwrap();
            assert!(
                title.starts_with("Flight ") && title.ends_with("Live Sentinel Agent"),
                "unexpected neutral live title: {title}"
            );
            assert!(value["payload"].get("workspacePath").is_none());
            saw_started = true;
        }
        if text.contains("\"guard.triggered\"") {
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["payload"]["title"], "Approval requested");
            assert!(value["payload"].get("command").is_none());
            assert!(value["payload"].get("evidence").is_none());
            assert!(value["payload"].get("description").is_none());
            saw_guard = true;
        }
        if text.contains("\"agent.event\"") && !text.contains("\"agent.event.acknowledged\"") {
            let value: Value = serde_json::from_str(&text).unwrap();
            assert!(value["payload"]["event"].get("message").is_none());
            assert!(value["payload"]["event"].get("metadata").is_none());
            saw_agent_event = true;
        }
    }
    assert!(saw_started, "the status socket should see session.started");
    assert!(saw_guard, "the status socket should see guard.triggered");
    assert!(
        saw_agent_event,
        "the status socket should see the sanitized agent event"
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn pairing_is_single_use_host_confirmed_and_brute_force_limited() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);

    // A wrong code consumes attempts and locks the IP after five failures.
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let good_code = issued["code"].as_str().unwrap().to_string();
    assert_eq!(issued["expiresInSeconds"], 120);
    let wrong = "f".repeat(32);
    for attempt in 1..=5 {
        let response = client
            .post(format!("{remote}/api/remote/pair/claim"))
            .json(&json!({ "verificationCode": "1234", "code": wrong, "deviceName": "Attacker" }))
            .send()
            .await
            .unwrap();
        if attempt < 5 {
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "attempt {attempt}"
            );
        } else {
            assert_eq!(
                response.status(),
                StatusCode::TOO_MANY_REQUESTS,
                "the fifth failure locks the IP"
            );
        }
    }
    let locked = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": good_code, "deviceName": "Attacker" }))
        .send()
        .await
        .unwrap();
    assert_eq!(locked.status(), StatusCode::TOO_MANY_REQUESTS);

    daemon.shutdown().await.unwrap();

    // A fresh daemon lets us test single use and host confirmation.
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();

    // The PIN is set on the device and must be at least six digits.
    let short_pin = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Pixel", "pin": "12345" }))
        .send()
        .await
        .unwrap();
    assert_eq!(short_pin.status(), StatusCode::BAD_REQUEST);
    let short_pin: Value = short_pin.json().await.unwrap();
    assert_eq!(short_pin["error"]["code"], "pairing_bad_pin");

    let claim: Value = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Pixel", "pin": "123456" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let claim_id = claim["claimId"].as_str().unwrap().to_string();
    let secret = claim["claimSecret"].as_str().unwrap().to_string();
    assert_eq!(claim["expiresInSeconds"], 90);

    // The code is single use even before the host answers.
    let reused = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Other" }))
        .send()
        .await
        .unwrap();
    assert_eq!(reused.status(), StatusCode::BAD_REQUEST);

    // A pending claim has no token and needs the host.
    let pending: Value = client
        .post(format!("{remote}/api/remote/pair/claim/{claim_id}"))
        .header("x-pairing-secret", &secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pending["status"], "pending");
    assert!(pending.get("token").is_none());

    let wrong_secret = client
        .post(format!("{remote}/api/remote/pair/claim/{claim_id}"))
        .header("x-pairing-secret", "nope")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_secret.status(), StatusCode::BAD_REQUEST);

    // The host sees the four-digit code the device is showing.
    let pending: Value = client
        .get(format!("{host}/api/remote/pair/pending"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let visible = pending["pairings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pairing| pairing["deviceName"] == "Pixel")
        .expect("the pending device is listed");
    assert_eq!(visible["verificationCode"], "1234");

    // A host that types the wrong code does not pair the device.
    let mismatched = client
        .post(format!("{host}/api/remote/pair/pending/{claim_id}/confirm"))
        .headers(host_headers(&daemon))
        .json(&json!({ "verificationCode": "0000" }))
        .send()
        .await
        .unwrap();
    assert_eq!(mismatched.status(), StatusCode::BAD_REQUEST);
    let mismatched: Value = mismatched.json().await.unwrap();
    assert_eq!(mismatched["error"]["code"], "pairing_verification_mismatch");

    let confirmed = client
        .post(format!("{host}/api/remote/pair/pending/{claim_id}/confirm"))
        .headers(host_headers(&daemon))
        .json(&json!({ "verificationCode": "1234" }))
        .send()
        .await
        .unwrap();
    let confirmed_body: Value = confirmed.json().await.unwrap();
    assert!(
        confirmed_body["pairing"].get("token").is_none(),
        "the host never receives the device token"
    );

    let first: Value = client
        .post(format!("{remote}/api/remote/pair/claim/{claim_id}"))
        .header("x-pairing-secret", &secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["status"], "confirmed");
    assert_eq!(first["token"].as_str().unwrap().len(), 64);

    // The token is handed out exactly once.
    let second: Value = client
        .post(format!("{remote}/api/remote/pair/claim/{claim_id}"))
        .header("x-pairing-secret", &secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(second["status"], "expired");
    assert!(second.get("token").is_none());

    // Denying a request never creates a device.
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();
    let denied_claim: Value = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Denied" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let denied_id = denied_claim["claimId"].as_str().unwrap().to_string();
    let denied_secret = denied_claim["claimSecret"].as_str().unwrap().to_string();
    client
        .post(format!("{host}/api/remote/pair/pending/{denied_id}/deny"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    let denied: Value = client
        .post(format!("{remote}/api/remote/pair/claim/{denied_id}"))
        .header("x-pairing-secret", denied_secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(denied["status"], "denied");
    assert!(denied.get("token").is_none());

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn tunnel_identity_trusts_only_forwarded_addresses() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);

    let issue = |client: reqwest::Client, host: String, csrf: String| async move {
        let issued: Value = client
            .post(format!("{host}/api/remote/pair/code"))
            .header("origin", &host)
            .header("x-cockpit-csrf", csrf)
            .header("content-type", "application/json")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        issued["code"].as_str().unwrap().to_string()
    };

    // A validated forwarded address from the loopback tunnel connector is the
    // real client address.
    let code = issue(client.clone(), host.clone(), daemon.state.csrf.to_string()).await;
    let claim = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .header("cf-connecting-ip", "203.0.113.9")
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Tunnel phone" }))
        .send()
        .await
        .unwrap();
    assert!(claim.status().is_success());

    let pending: Value = client
        .get(format!("{host}/api/remote/pair/pending"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pairing = pending["pairings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pairing| pairing["deviceName"] == "Tunnel phone")
        .expect("the host sees the trusted claim");
    assert_eq!(pairing["ip"], "203.0.113.9");

    // Without a forwarded address the TCP peer is the tunnel connector, not
    // the user. That loopback address is never used as the client identity.
    let code = issue(client.clone(), host.clone(), daemon.state.csrf.to_string()).await;
    let claim = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Untrusted phone" }))
        .send()
        .await
        .unwrap();
    assert!(claim.status().is_success());
    let pending: Value = client
        .get(format!("{host}/api/remote/pair/pending"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pairing = pending["pairings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pairing| pairing["deviceName"] == "Untrusted phone")
        .expect("the host sees the untrusted claim");
    assert!(
        pairing.get("ip").is_none(),
        "an untrusted tunnel client has no displayable address: {pairing}"
    );
    assert!(!pairing.to_string().contains("127.0.0.1"));

    // A malformed forwarded value is not trusted either.
    let code = issue(client.clone(), host.clone(), daemon.state.csrf.to_string()).await;
    let claim = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .header("cf-connecting-ip", "not-an-ip")
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Spoof phone" }))
        .send()
        .await
        .unwrap();
    assert!(claim.status().is_success());
    let pending: Value = client
        .get(format!("{host}/api/remote/pair/pending"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pairing = pending["pairings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pairing| pairing["deviceName"] == "Spoof phone")
        .expect("the host sees the spoofed claim");
    assert!(pairing.get("ip").is_none());

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn pairing_queue_is_capped_at_three_claims() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);

    let mut first_claim = None;
    for index in 0..3 {
        let issued: Value = client
            .post(format!("{host}/api/remote/pair/code"))
            .headers(host_headers(&daemon))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let code = issued["code"].as_str().unwrap().to_string();
        let claim: Value = client
            .post(format!("{remote}/api/remote/pair/claim"))
            .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": format!("Queue {index}") }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let claim_id = claim["claimId"].as_str().unwrap().to_string();
        if first_claim.is_none() {
            first_claim = Some(claim_id);
        }
    }

    // A fourth request is refused, and the code is not consumed.
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();
    let blocked = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Queue 3" }))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::BAD_REQUEST);
    let body: Value = blocked.json().await.unwrap();
    assert_eq!(body["error"]["code"], "pairing_busy");

    // Answering one request makes room for the waiting device.
    let confirmed = client
        .post(format!(
            "{host}/api/remote/pair/pending/{}/confirm",
            first_claim.unwrap()
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "verificationCode": "1234" }))
        .send()
        .await
        .unwrap();
    assert!(confirmed.status().is_success());
    let retried = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "Queue 3" }))
        .send()
        .await
        .unwrap();
    assert!(retried.status().is_success());

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_valid_token_bypasses_an_untrusted_ip_lockout() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let device = pair_device(&daemon, &remote, "Locked phone", None).await;

    // Five bad tokens lock the untrusted tunnel bucket.
    for attempt in 1..=5 {
        let response = client
            .get(format!("{remote}/api/remote/session"))
            .bearer_auth("0".repeat(64))
            .send()
            .await
            .unwrap();
        if attempt < 5 {
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        } else {
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        }
    }

    // The already-paired device still gets through with its real token.
    let allowed = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn host_origin_cors_and_security_headers_are_enforced() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let device = pair_device(&daemon, &remote, "Browser", None).await;
    let remote_port = remote.rsplit(':').next().unwrap();

    // A Host header that is neither loopback nor the configured public host
    // is refused before authentication.
    let bad_host = client
        .get(format!("{remote}/api/remote/session"))
        .header("host", "evil.example")
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(bad_host.status(), StatusCode::FORBIDDEN);
    let body: Value = bad_host.json().await.unwrap();
    assert_eq!(body["error"]["code"], "forbidden_host");

    // Cross-origin reads are refused.
    let bad_origin = client
        .get(format!("{remote}/api/remote/session"))
        .header("origin", "https://evil.example")
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(bad_origin.status(), StatusCode::FORBIDDEN);
    let body: Value = bad_origin.json().await.unwrap();
    assert_eq!(body["error"]["code"], "forbidden_origin");

    // Same-origin requests work and never emit a wildcard CORS header.
    let same_origin = client
        .get(format!("{remote}/api/remote/session"))
        .header("origin", format!("http://127.0.0.1:{remote_port}"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(same_origin.status(), StatusCode::OK);
    assert!(
        same_origin
            .headers()
            .get("access-control-allow-origin")
            .is_none(),
        "the remote listener must not emit CORS headers"
    );
    let headers = same_origin.headers();
    assert!(headers.get("content-security-policy").is_some());
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(headers.get("referrer-policy").unwrap(), "no-referrer");
    assert_eq!(headers.get("x-frame-options").unwrap(), "DENY");
    assert!(headers.get("strict-transport-security").is_none());

    // A preflight from an evil origin is refused and carries no CORS grant.
    let preflight = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{remote}/api/remote/session"),
        )
        .header("origin", "https://evil.example")
        .header("access-control-request-method", "GET")
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::FORBIDDEN);
    assert!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .is_none()
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn host_mutations_reject_cross_origin_forms_and_require_csrf() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);

    // The token is served only by the host listener, and the header matches
    // the value the daemon enforces.
    let csrf_response = client.get(format!("{host}/api/csrf")).send().await.unwrap();
    assert_eq!(csrf_response.status(), StatusCode::OK);
    let header_token = csrf_response
        .headers()
        .get("x-cockpit-csrf")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let csrf_body: Value = csrf_response.json().await.unwrap();
    assert_eq!(csrf_body["token"], header_token.as_str());
    assert_eq!(header_token, daemon.state.csrf.as_str());

    let device = pair_device(&daemon, &remote, "CSRF phone", None).await;

    // A pending claim gives the confirm endpoint a real target.
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();
    let claim: Value = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "verificationCode": "1234", "code": code, "deviceName": "CSRF pending" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let claim_id = claim["claimId"].as_str().unwrap().to_string();
    let claim_secret = claim["claimSecret"].as_str().unwrap().to_string();

    // A pending guard event gives the approval endpoint a real target.
    let proxy = client.clone();
    let proxy_url = format!("{host}/v1/chat/completions");
    let pending_request = tokio::spawn(async move {
        proxy
            .post(proxy_url)
            .json(&destructive_request())
            .send()
            .await
            .unwrap()
    });
    let event = wait_for_pending_event(&client, &host).await;
    let event_id = event["id"].as_str().unwrap().to_string();
    let nonce = event["approvalNonce"].as_str().unwrap().to_string();
    let session_id = event["sessionId"].as_str().unwrap().to_string();

    struct HostMutation {
        name: &'static str,
        method: &'static str,
        path: String,
        body: Option<Value>,
    }

    let mutations = vec![
        HostMutation {
            name: "enable",
            method: "POST",
            path: "/api/remote/enable".to_string(),
            body: Some(json!({ "mode": "tunnel", "publicUrl": remote.clone() })),
        },
        HostMutation {
            name: "create code",
            method: "POST",
            path: "/api/remote/pair/code".to_string(),
            body: None,
        },
        HostMutation {
            name: "confirm pairing",
            method: "POST",
            path: format!("/api/remote/pair/pending/{claim_id}/confirm"),
            body: None,
        },
        HostMutation {
            name: "scope change",
            method: "PATCH",
            path: format!("/api/remote/devices/{}", device.id),
            body: Some(json!({
                "scopes": ["view:content"],
                "requireHostConfirmation": false,
            })),
        },
        HostMutation {
            name: "approval decision",
            method: "POST",
            path: format!("/api/guards/events/{event_id}/decision"),
            body: Some(json!({
                "decision": "deny",
                "nonce": nonce.clone(),
                "sessionId": session_id.clone(),
            })),
        },
        HostMutation {
            name: "revoke",
            method: "POST",
            path: format!("/api/remote/devices/{}/revoke", device.id),
            body: None,
        },
        HostMutation {
            name: "panic",
            method: "POST",
            path: "/api/remote/panic".to_string(),
            body: None,
        },
    ];

    let wrong_token = "0".repeat(64);
    for mutation in &mutations {
        // A `no-cors` page can only send text/plain and cannot set the token.
        let cross_origin = send_host_mutation(
            &client,
            &host,
            mutation.method,
            &mutation.path,
            mutation.body.as_ref(),
            Some("https://evil.example"),
            None,
            "text/plain",
        )
        .await;
        assert_eq!(
            cross_origin.status(),
            StatusCode::FORBIDDEN,
            "{} must reject a foreign Origin",
            mutation.name
        );
        let body: Value = cross_origin.json().await.unwrap();
        assert_eq!(
            body["error"]["code"], "forbidden_origin",
            "{}",
            mutation.name
        );

        // Native requests without an Origin are refused too.
        let no_origin = send_host_mutation(
            &client,
            &host,
            mutation.method,
            &mutation.path,
            mutation.body.as_ref(),
            None,
            None,
            "application/json",
        )
        .await;
        assert_eq!(
            no_origin.status(),
            StatusCode::FORBIDDEN,
            "{} must require an Origin",
            mutation.name
        );
        let body: Value = no_origin.json().await.unwrap();
        assert_eq!(
            body["error"]["code"], "origin_required",
            "{}",
            mutation.name
        );

        // A same-origin form post without the token is refused before JSON.
        let form = send_host_mutation(
            &client,
            &host,
            mutation.method,
            &mutation.path,
            mutation.body.as_ref(),
            Some(host.as_str()),
            None,
            "text/plain",
        )
        .await;
        assert_eq!(
            form.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{} must require JSON",
            mutation.name
        );
        let body: Value = form.json().await.unwrap();
        assert_eq!(
            body["error"]["code"], "content_type_required",
            "{}",
            mutation.name
        );

        // JSON without a token is still refused.
        let no_token = send_host_mutation(
            &client,
            &host,
            mutation.method,
            &mutation.path,
            mutation.body.as_ref(),
            Some(host.as_str()),
            None,
            "application/json",
        )
        .await;
        assert_eq!(
            no_token.status(),
            StatusCode::FORBIDDEN,
            "{} must require the CSRF token",
            mutation.name
        );
        let body: Value = no_token.json().await.unwrap();
        assert_eq!(body["error"]["code"], "csrf_missing", "{}", mutation.name);

        let wrong = send_host_mutation(
            &client,
            &host,
            mutation.method,
            &mutation.path,
            mutation.body.as_ref(),
            Some(host.as_str()),
            Some(&wrong_token),
            "application/json",
        )
        .await;
        assert_eq!(
            wrong.status(),
            StatusCode::FORBIDDEN,
            "{} must reject a wrong token",
            mutation.name
        );
        let body: Value = wrong.json().await.unwrap();
        assert_eq!(body["error"]["code"], "csrf_invalid", "{}", mutation.name);
    }

    // Rejected confirms did not consume the claim.
    let pending: Value = client
        .post(format!("{remote}/api/remote/pair/claim/{claim_id}"))
        .header("x-pairing-secret", &claim_secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pending["status"], "pending");

    // Rejected decisions did not resolve the approval.
    let still_pending: Value = client
        .get(format!("{host}/api/guards/events?status=pending"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        still_pending["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["id"] == event_id.as_str())
    );

    // Rejected revokes and panics left the device and listener alone.
    let session = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(session.status(), StatusCode::OK);

    // The same endpoints succeed with Origin + JSON + the real token.
    let confirmed = client
        .post(format!("{host}/api/remote/pair/pending/{claim_id}/confirm"))
        .headers(host_headers(&daemon))
        .json(&json!({ "verificationCode": "1234" }))
        .send()
        .await
        .unwrap();
    assert!(confirmed.status().is_success());

    let scoped = client
        .patch(format!("{host}/api/remote/devices/{}", device.id))
        .headers(host_headers(&daemon))
        .json(&json!({
            "scopes": ["view:content"],
            "requireHostConfirmation": false,
        }))
        .send()
        .await
        .unwrap();
    assert!(scoped.status().is_success());

    let decided = client
        .post(format!("{host}/api/guards/events/{event_id}/decision"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "decision": "deny",
            "nonce": nonce,
            "sessionId": session_id,
        }))
        .send()
        .await
        .unwrap();
    assert!(decided.status().is_success());
    let _ = tokio::time::timeout(Duration::from_secs(5), pending_request).await;

    let revoked = client
        .post(format!("{host}/api/remote/devices/{}/revoke", device.id))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(revoked.status().is_success());

    daemon.shutdown().await.unwrap();
}

async fn wait_for_pending_event(client: &reqwest::Client, host: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let payload: Value = client
            .get(format!("{host}/api/guards/events?status=pending"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if let Some(event) = payload["events"]
            .as_array()
            .and_then(|events| events.first())
        {
            return event.clone();
        }
        assert!(
            Instant::now() < deadline,
            "no pending approval appeared: {payload}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn destructive_request() -> Value {
    json!({
        "model": "gpt-4.1",
        "messages": [{ "role": "user", "content": "please rm -rf / now" }]
    })
}

/// Insert a pending guard event so the remote approval path can be exercised
/// without depending on which built-in rules happen to match.
fn insert_pending_event(
    daemon: &ServerHandle,
    title: &str,
    severity: GuardSeverity,
    nonce: &str,
) -> (String, String) {
    let session = daemon
        .state
        .store
        .create_session(NewSession {
            title: "Remote approval test".to_string(),
            source: SessionSource::Proxy,
            capture_mode: CaptureMode::Proxy,
            status: SessionStatus::Active,
            ..Default::default()
        })
        .unwrap();
    let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339();
    let event = daemon
        .state
        .store
        .insert_guard_event(NewGuardEvent {
            session_id: session.id.clone(),
            step_id: None,
            rule_id: "test.remote.approval".to_string(),
            kind: GuardRuleKind::Custom,
            action: GuardAction::Pause,
            severity,
            status: GuardEventStatus::Pending,
            title: title.to_string(),
            description: String::new(),
            command: None,
            evidence: Vec::new(),
            metadata: None,
            approval_nonce: Some(nonce.to_string()),
            approval_expires_at: Some(expires_at),
        })
        .unwrap();
    (event.id, session.id)
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_approvals_need_the_pin_and_cannot_be_replayed() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Approver", Some("123456")).await;
    set_scopes(&daemon, &device.id, &["view", "respond"], true).await;

    let proxy = client.clone();
    let proxy_url = format!("{host}/v1/chat/completions");
    let pending_request = tokio::spawn(async move {
        proxy
            .post(proxy_url)
            .json(&destructive_request())
            .send()
            .await
            .unwrap()
    });

    let event = wait_for_pending_event(&client, &host).await;
    let event_id = event["id"].as_str().unwrap().to_string();
    let nonce = event["approvalNonce"].as_str().unwrap().to_string();
    let session_id = event["sessionId"].as_str().unwrap().to_string();

    // A high-risk approval without the PIN is refused.
    let no_pin = client
        .post(format!(
            "{remote}/api/remote/guards/events/{event_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": nonce,
            "sessionId": session_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(no_pin.status(), StatusCode::CONFLICT);
    let body: Value = no_pin.json().await.unwrap();
    assert_eq!(body["error"]["code"], "pin_required");

    let wrong_pin = client
        .post(format!(
            "{remote}/api/remote/guards/events/{event_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": nonce,
            "sessionId": session_id,
            "pin": "999999",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_pin.status(), StatusCode::FORBIDDEN);

    let approved = client
        .post(format!(
            "{remote}/api/remote/guards/events/{event_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": nonce,
            "sessionId": session_id,
            "pin": "123456",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), StatusCode::OK);
    let approved_body: Value = approved.json().await.unwrap();
    assert_eq!(approved_body["event"]["status"], "approved");

    let forwarded = tokio::time::timeout(Duration::from_secs(5), pending_request)
        .await
        .expect("the proxy request finishes")
        .unwrap();
    assert_eq!(forwarded.status(), StatusCode::OK);

    // Replaying the same nonce is refused.
    let replay = client
        .post(format!(
            "{remote}/api/remote/guards/events/{event_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": nonce,
            "sessionId": session_id,
            "pin": "123456",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::CONFLICT);

    let audit: Value = client
        .get(format!("{host}/api/remote/audit?limit=200"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events: Vec<String> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["event"].as_str().map(str::to_string))
        .collect();
    assert!(events.iter().any(|event| event == "approval.approve"));
    assert!(events.iter().any(|event| event == "approval.pin_failed"));

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn respond_locks_after_five_wrong_pins_until_the_host_resets_it() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Locked", Some("123456")).await;
    set_scopes(&daemon, &device.id, &["view", "respond"], true).await;

    let proxy = client.clone();
    let proxy_url = format!("{host}/v1/chat/completions");
    let pending_request = tokio::spawn(async move {
        proxy
            .post(proxy_url)
            .json(&destructive_request())
            .send()
            .await
            .unwrap()
    });

    let event = wait_for_pending_event(&client, &host).await;
    let event_id = event["id"].as_str().unwrap().to_string();
    let nonce = event["approvalNonce"].as_str().unwrap().to_string();
    let session_id = event["sessionId"].as_str().unwrap().to_string();

    for attempt in 1..=5 {
        let response = client
            .post(format!(
                "{remote}/api/remote/guards/events/{event_id}/decision"
            ))
            .bearer_auth(&device.token)
            .json(&json!({
                "decision": "approve",
                "nonce": nonce,
                "sessionId": session_id,
                "pin": "999999",
            }))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        if attempt < 5 {
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert_eq!(body["error"]["code"], "pin_invalid");
        } else {
            assert_eq!(status, StatusCode::LOCKED);
            assert_eq!(body["error"]["code"], "respond_locked");
        }
    }

    // Even the right PIN is refused while Respond is locked.
    let locked = client
        .post(format!(
            "{remote}/api/remote/guards/events/{event_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": nonce,
            "sessionId": session_id,
            "pin": "123456",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(locked.status(), StatusCode::LOCKED);

    let listed: Value = client
        .get(format!("{host}/api/remote/devices"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let row = listed["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == device.id)
        .expect("the device is listed");
    assert_eq!(row["respondLocked"], true);
    assert_eq!(row["pinFailures"], 5);

    let reset = client
        .post(format!(
            "{host}/api/remote/devices/{}/reset-respond",
            device.id
        ))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(reset.status().is_success());
    let reset: Value = reset.json().await.unwrap();
    assert_eq!(reset["device"]["respondLocked"], false);
    assert_eq!(reset["device"]["pinFailures"], 0);

    let approved = client
        .post(format!(
            "{remote}/api/remote/guards/events/{event_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": nonce,
            "sessionId": session_id,
            "pin": "123456",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(5), pending_request)
        .await
        .expect("the proxy request finishes")
        .unwrap();

    let audit: Value = client
        .get(format!("{host}/api/remote/audit?limit=200"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events: Vec<String> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["event"].as_str().map(str::to_string))
        .collect();
    assert!(events.iter().any(|event| event == "device.respond_locked"));
    assert!(events.iter().any(|event| event == "device.respond_reset"));

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn expired_remote_approvals_are_refused() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let port = free_port().await;
    let mut config = config(home.path(), mock.addr);
    config.remote_port = port;
    config.guard_approval_timeout_ms = 1_500;
    let daemon = cockpit_daemon::spawn(config).await.unwrap();
    let host = host_base(&daemon);
    let remote = format!("http://127.0.0.1:{port}");
    let response = reqwest::Client::new()
        .post(format!("{host}/api/remote/enable"))
        .headers(host_headers(&daemon))
        .json(&json!({ "mode": "tunnel", "publicUrl": remote }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());

    let client = reqwest::Client::new();
    let device = pair_device(&daemon, &remote, "Slow", Some("123456")).await;
    set_scopes(&daemon, &device.id, &["view", "respond"], true).await;

    let proxy = client.clone();
    let proxy_url = format!("{host}/v1/chat/completions");
    let pending_request = tokio::spawn(async move {
        proxy
            .post(proxy_url)
            .json(&destructive_request())
            .send()
            .await
            .unwrap()
    });
    let event = wait_for_pending_event(&client, &host).await;
    let event_id = event["id"].as_str().unwrap().to_string();
    let nonce = event["approvalNonce"].as_str().unwrap().to_string();
    let session_id = event["sessionId"].as_str().unwrap().to_string();

    tokio::time::sleep(Duration::from_millis(1_800)).await;
    let late = client
        .post(format!(
            "{remote}/api/remote/guards/events/{event_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": nonce,
            "sessionId": session_id,
            "pin": "123456",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(late.status(), StatusCode::GONE);
    let body: Value = late.json().await.unwrap();
    assert_eq!(body["error"]["code"], "approval_expired");

    let blocked = tokio::time::timeout(Duration::from_secs(5), pending_request)
        .await
        .expect("the proxy request finishes")
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::FORBIDDEN);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_prompts_are_bounded_rate_limited_and_never_audited_verbatim() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Prompter", Some("123456")).await;
    set_scopes(&daemon, &device.id, &["view", "respond", "prompt"], false).await;

    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "Test agent",
            "workingDir": "C:/work",
            "adapter": "opencode",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    mark_awaiting_prompt(&client, &daemon, &session_id).await;

    let secret_prompt = "remote secret prompt";
    let sent = client
        .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": secret_prompt }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), StatusCode::OK);
    let sent_body: Value = sent.json().await.unwrap();
    assert_eq!(sent_body["status"], "sent");

    let input: Value = client
        .get(format!("{host}/api/agents/{session_id}/input"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let data = input["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|chunk| chunk["data"].as_str())
        .collect::<String>();
    assert_eq!(data, format!("{secret_prompt}\r"));

    // The audit log stores a size and a hash, never the prompt text.
    let audit: Value = client
        .get(format!("{host}/api/remote/audit?limit=200"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let serialized = audit.to_string();
    assert!(!serialized.contains(secret_prompt));
    let prompt_entry = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["event"] == "prompt.sent")
        .expect("prompt.sent audit row");
    assert_eq!(
        prompt_entry["sizeBytes"].as_u64().unwrap(),
        secret_prompt.len() as u64
    );
    assert_eq!(prompt_entry["contentHash"].as_str().unwrap().len(), 64);

    // Too large.
    let too_large = client
        .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": "x".repeat(2_001) }))
        .send()
        .await
        .unwrap();
    assert_eq!(too_large.status(), StatusCode::PAYLOAD_TOO_LARGE);

    // NUL, escape sequences, and control characters are stripped before the
    // prompt is queued; exactly one Enter is appended.
    mark_awaiting_prompt(&client, &daemon, &session_id).await;
    let sanitized = client
        .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({
            "text": "hello\u{0}\u{1b}[31mred\u{1b}[0m\u{7}world\n\n"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(sanitized.status(), StatusCode::OK);
    let sanitized_body: Value = sanitized.json().await.unwrap();
    let sequence = sanitized_body["sequence"].as_u64().unwrap();
    let input: Value = client
        .get(format!(
            "{host}/api/agents/{session_id}/input?after={sequence}"
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let data = input["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|chunk| chunk["data"].as_str())
        .collect::<String>();
    assert_eq!(data, "helloredworld\r");

    // Six prompts per minute per device. Two were already sent above.
    for _ in 0..4 {
        mark_awaiting_prompt(&client, &daemon, &session_id).await;
        let response = client
            .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
            .bearer_auth(&device.token)
            .json(&json!({ "text": "again" }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    mark_awaiting_prompt(&client, &daemon, &session_id).await;
    let limited = client
        .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": "one too many" }))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);

    // A request body over the remote limit is rejected before parsing.
    let huge = client
        .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
        .bearer_auth(&device.token)
        .body("x".repeat(70 * 1024))
        .header("content-type", "application/json")
        .send()
        .await
        .unwrap();
    assert_eq!(huge.status(), StatusCode::PAYLOAD_TOO_LARGE);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn host_confirmation_is_required_for_remote_prompts_by_default() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Default phone", None).await;
    set_scopes(&daemon, &device.id, &["view", "prompt"], true).await;

    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "Test agent",
            "workingDir": "C:/work",
            "adapter": "opencode",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    mark_awaiting_prompt(&client, &daemon, &session_id).await;

    let sent = client
        .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": "needs the host" }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), StatusCode::ACCEPTED);
    let sent_body: Value = sent.json().await.unwrap();
    assert_eq!(sent_body["status"], "pending_host");

    let prompts: Value = client
        .get(format!("{host}/api/remote/prompts"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prompt_id = prompts["prompts"].as_array().unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let approved = client
        .post(format!("{host}/api/remote/prompts/{prompt_id}/approve"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(approved.status().is_success());

    let input: Value = client
        .get(format!("{host}/api/agents/{session_id}/input"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let data = input["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|chunk| chunk["data"].as_str())
        .collect::<String>();
    assert_eq!(data, "needs the host\r");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_prompts_require_an_explicit_awaiting_state() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "State phone", None).await;
    set_scopes(&daemon, &device.id, &["view", "prompt"], false).await;

    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "State agent",
            "workingDir": "C:/work",
            "adapter": "opencode",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // Every state that is not an explicit "type here" prompt must be handled
    // at the computer. The remote device gets a conflict, never keystrokes.
    let rejected = [
        ("Do you want to proceed? [y/N]", "permission"),
        ("Select an option", "choice"),
        ("Which migration should I run?", "question"),
        ("Please log in to continue.", "auth"),
        ("18 tests passed, 0 failed", "unknown"),
    ];
    for (output, state) in rejected {
        set_agent_prompt_state(&client, &daemon, &session_id, output).await;
        let response = client
            .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
            .bearer_auth(&device.token)
            .json(&json!({ "text": "remote should not type this" }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::CONFLICT,
            "{state} should be rejected"
        );
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "prompt_not_awaiting");
    }

    // No keystrokes were queued for any rejected state.
    let input: Value = client
        .get(format!("{host}/api/agents/{session_id}/input"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(input["chunks"].as_array().unwrap().is_empty());

    let audit: Value = client
        .get(format!("{host}/api/remote/audit?limit=200"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let reasons: Vec<&str> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["event"] == "prompt.rejected")
        .filter_map(|entry| entry["detail"]["reason"].as_str())
        .collect();
    for (_, state) in rejected {
        assert!(reasons.contains(&state), "missing audit reason {state}");
    }

    // An explicit awaiting prompt is the only accepted state.
    mark_awaiting_prompt(&client, &daemon, &session_id).await;
    let accepted = client
        .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": "now it is allowed" }))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_approve_sessions_always_wait_for_the_host() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Auto phone", None).await;
    // Host confirmation is off for this device, but the agent's own approvals
    // are skipped, so the session flag must force confirmation anyway.
    set_scopes(&daemon, &device.id, &["view", "prompt"], false).await;

    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "Yolo agent",
            "workingDir": "C:/work",
            "adapter": "claude-code",
            "commandLine": "claude --dangerously-skip-permissions",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(registered["session"]["autoApprove"], true);
    let session_id = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    mark_awaiting_prompt(&client, &daemon, &session_id).await;
    let sent = client
        .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": "ship it" }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), StatusCode::ACCEPTED);

    let prompts: Value = client
        .get(format!("{host}/api/remote/prompts"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prompt = &prompts["prompts"].as_array().unwrap()[0];
    assert_eq!(prompt["autoApprove"], true);
    assert_eq!(prompt["text"], "ship it");
    let prompt_id = prompt["id"].as_str().unwrap().to_string();

    let approved = client
        .post(format!("{host}/api/remote/prompts/{prompt_id}/approve"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(approved.status().is_success());

    let input: Value = client
        .get(format!("{host}/api/agents/{session_id}/input"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let data = input["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|chunk| chunk["data"].as_str())
        .collect::<String>();
    assert_eq!(data, "ship it\r");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn authentication_prompts_must_be_completed_at_the_computer() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Approver", Some("123456")).await;
    set_scopes(&daemon, &device.id, &["view", "respond"], true).await;

    let (event_id, session_id) = insert_pending_event(
        &daemon,
        "Login password required",
        GuardSeverity::High,
        "auth-prompt-nonce",
    );

    let refused = client
        .post(format!(
            "{remote}/api/remote/guards/events/{event_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": "auth-prompt-nonce",
            "sessionId": session_id,
            "pin": "123456",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    let body: Value = refused.json().await.unwrap();
    assert_eq!(body["error"]["code"], "needs_host");

    // The event is untouched: a remote device can never complete an auth
    // prompt, even with the right PIN.
    let stored = daemon
        .state
        .store
        .get_guard_event(&event_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, GuardEventStatus::Pending);

    let audit: Value = client
        .get(format!("{host}/api/remote/audit?limit=200"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        audit["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["event"] == "approval.needs_host")
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_log_records_sensitive_transitions_and_exports() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);

    let device = pair_device(&daemon, &remote, "Audit phone", Some("123456")).await;
    set_scopes(&daemon, &device.id, &["view", "respond", "prompt"], false).await;

    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
        .headers(host_headers(&daemon))
        .json(&json!({
            "agentName": "Audit agent",
            "workingDir": "C:/work",
            "adapter": "opencode",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let agent_session = registered["session"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    mark_awaiting_prompt(&client, &daemon, &agent_session).await;
    let prompt_text = "audit-only prompt body";
    let sent = client
        .post(format!("{remote}/api/remote/agents/{agent_session}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": prompt_text }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), StatusCode::OK);

    // Pushing the prompt reset the session to Unknown, so a second prompt is
    // refused and audited as rejected rather than silently typed into a state
    // the device does not own.
    let rejected = client
        .post(format!("{remote}/api/remote/agents/{agent_session}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": "must not reach the agent" }))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::CONFLICT);

    // Host-confirmed prompts can be denied on the computer.
    set_scopes(&daemon, &device.id, &["view", "respond", "prompt"], true).await;
    mark_awaiting_prompt(&client, &daemon, &agent_session).await;
    let pending_prompt = client
        .post(format!("{remote}/api/remote/agents/{agent_session}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": "needs the host" }))
        .send()
        .await
        .unwrap();
    assert_eq!(pending_prompt.status(), StatusCode::ACCEPTED);
    let pending: Value = client
        .get(format!("{host}/api/remote/prompts"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let prompt_id = pending["prompts"][0]["id"].as_str().unwrap().to_string();
    let denied_prompt = client
        .post(format!("{host}/api/remote/prompts/{prompt_id}/deny"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(denied_prompt.status().is_success());

    let (approve_id, approve_session) =
        insert_pending_event(&daemon, "Approve me", GuardSeverity::Low, "audit-approve");
    let approved = client
        .post(format!(
            "{remote}/api/remote/guards/events/{approve_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "approve",
            "nonce": "audit-approve",
            "sessionId": approve_session,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), StatusCode::OK);

    let (deny_id, deny_session) =
        insert_pending_event(&daemon, "Deny me", GuardSeverity::Low, "audit-deny");
    let denied = client
        .post(format!(
            "{remote}/api/remote/guards/events/{deny_id}/decision"
        ))
        .bearer_auth(&device.token)
        .json(&json!({
            "decision": "deny",
            "nonce": "audit-deny",
            "sessionId": deny_session,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::OK);

    // A denied pairing and a failed login are audited too.
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let claim: Value = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({
            "code": issued["code"].as_str().unwrap(),
            "deviceName": "Denied phone",
            "verificationCode": "1234",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    client
        .post(format!(
            "{host}/api/remote/pair/pending/{}/deny",
            claim["claimId"].as_str().unwrap()
        ))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();

    let bad_login = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth("not-a-real-token")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_login.status(), StatusCode::UNAUTHORIZED);

    let revoked = client
        .post(format!("{host}/api/remote/devices/{}/revoke", device.id))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(revoked.status().is_success());

    let disabled = client
        .post(format!("{host}/api/remote/disable"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(disabled.status().is_success());

    let panicked = client
        .post(format!("{host}/api/remote/panic"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(panicked.status().is_success());

    let audit: Value = client
        .get(format!("{host}/api/remote/audit?limit=1000"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events: Vec<String> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["event"].as_str().map(str::to_string))
        .collect();
    for expected in [
        "remote.enabled",
        "pair.code",
        "pair.request",
        "pair.confirm",
        "pair.claimed",
        "device.scopes",
        "prompt.sent",
        "prompt.rejected",
        "prompt.denied",
        "approval.approve",
        "approval.deny",
        "pair.deny",
        "auth.failure",
        "device.revoke",
        "remote.disabled",
        "remote.panic",
    ] {
        assert!(
            events.iter().any(|event| event == expected),
            "missing audit event {expected}: {events:?}"
        );
    }
    assert_eq!(audit["total"].as_u64().unwrap(), events.len() as u64);

    // Every returned row names its predecessor and its own hash.
    let entries = audit["entries"].as_array().unwrap();
    for entry in entries {
        assert!(
            entry["entryHash"]
                .as_str()
                .is_some_and(|hash| hash.len() == 64)
        );
    }

    // The chain verifies in append order even though the API lists newest
    // first.
    let store = Store::open(home.path().join("cockpit.db")).unwrap();
    let report = store.verify_remote_audit_chain().unwrap();
    assert!(report.valid, "{report:?}");
    assert_eq!(report.entries, events.len() as u64);

    // The export is the same append-only log, and neither the audit list nor
    // the export ever contains a token or prompt contents.
    let export = client
        .get(format!("{host}/api/remote/audit/export"))
        .send()
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::OK);
    assert!(
        export
            .headers()
            .get("content-disposition")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .contains("cockpit-remote-audit.json")
    );
    let exported: Value = export.json().await.unwrap();
    assert_eq!(exported["product"], "Cockpit");
    assert!(exported["exportedAt"].is_string());
    assert_eq!(exported["entries"].as_array().unwrap().len(), events.len());
    let serialized = exported.to_string();
    assert!(!serialized.contains(&device.token));
    assert!(!serialized.contains(prompt_text));

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_requests_are_rejected_without_a_crash() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let device = pair_device(&daemon, &remote, "Fuzz", None).await;

    let bodies = [
        "".to_string(),
        "{".to_string(),
        "null".to_string(),
        "[]".to_string(),
        "\"text\"".to_string(),
        "{\"code\":1}".to_string(),
        format!("{{\"text\":\"{}\"}}", "x".repeat(10_000)),
        "{\"text\":\"\\u0000\"}".to_string(),
        "{\"decision\":\"maybe\"}".to_string(),
        "{\"deviceName\":{}}".to_string(),
    ];
    for body in &bodies {
        let response = client
            .post(format!("{remote}/api/remote/agents/{DUMMY_ID}/prompt"))
            .bearer_auth(&device.token)
            .header("content-type", "application/json")
            .body(body.clone())
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_client_error() || response.status().is_success(),
            "unexpected status {} for {body}",
            response.status()
        );
        let response = client
            .post(format!("{remote}/api/remote/pair/claim"))
            .header("content-type", "application/json")
            .body(body.clone())
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_client_error() || response.status().is_success(),
            "unexpected status {} for {body}",
            response.status()
        );
    }

    for path in [
        "/api/remote/sessions/%2e%2e%2fetc%2fpasswd",
        "/api/remote/%00",
        "/api/remote/sessions/not-a-uuid",
        "/v1/..%2Fhealth",
    ] {
        let response = client
            .get(format!("{remote}{path}"))
            .bearer_auth(&device.token)
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_client_error(),
            "{path} should be a client error, got {}",
            response.status()
        );
    }

    // reqwest normalizes dot segments before sending, so a traversal attempt
    // is sent over a raw socket. The remote listener must still answer 404 and
    // never expose a proxy path.
    let remote_addr = remote.trim_start_matches("http://").to_string();
    let mut stream = tokio::net::TcpStream::connect(&remote_addr).await.unwrap();
    stream
        .write_all(
            format!(
                "GET /v1/%2e%2e/health HTTP/1.1\r\nHost: {remote_addr}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let raw = String::from_utf8_lossy(&raw);
    assert!(
        raw.starts_with("HTTP/1.1 404"),
        "encoded traversal must be blocked, got {raw}"
    );

    // Health is not an unauthenticated fingerprint.
    let anonymous_health = client
        .get(format!("{remote}/api/remote/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous_health.status(), StatusCode::NOT_FOUND);
    assert!(anonymous_health.headers().get("x-cockpit-remote").is_some());

    // A real loopback caller can still probe it, but gets no version.
    let loopback_health = client
        .get(format!("{remote}/api/remote/health"))
        .header("cf-connecting-ip", "127.0.0.1")
        .send()
        .await
        .unwrap();
    assert_eq!(loopback_health.status(), StatusCode::OK);
    let loopback_health: Value = loopback_health.json().await.unwrap();
    assert_eq!(loopback_health["remote"], true);
    assert!(loopback_health.get("version").is_none());

    // A remote caller with a valid token may see the version.
    let authenticated_health = client
        .get(format!("{remote}/api/remote/health"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(authenticated_health.status(), StatusCode::OK);
    let authenticated_health: Value = authenticated_health.json().await.unwrap();
    assert_eq!(authenticated_health["remote"], true);
    assert!(authenticated_health["version"].as_str().is_some());

    let foreign_health = client
        .get(format!("{remote}/api/remote/health"))
        .header("cf-connecting-ip", "203.0.113.9")
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_health.status(), StatusCode::NOT_FOUND);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn panic_stops_the_listener_and_revokes_every_device() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Phone", None).await;

    let panic: Value = client
        .post(format!("{host}/api/remote/panic"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(panic["stopped"], true);
    assert_eq!(panic["revokedDevices"], 1);
    assert_eq!(panic["status"]["enabled"], false);
    assert_eq!(panic["status"]["mode"], "loopback");

    let after = client
        .get(format!("{remote}/api/remote/health"))
        .send()
        .await;
    assert!(
        after.is_err() || !after.unwrap().status().is_success(),
        "the remote listener must be down after panic"
    );

    let status: Value = client
        .get(format!("{host}/api/remote/status"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["enabled"], false);

    let devices: Value = client
        .get(format!("{host}/api/remote/devices"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let listed = devices["devices"].as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0]["revokedAt"].is_string());

    let audit: Value = client
        .get(format!("{host}/api/remote/audit?limit=200"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events: Vec<String> = audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["event"].as_str().map(str::to_string))
        .collect();
    for expected in ["pair.code", "pair.request", "pair.confirm", "remote.panic"] {
        assert!(
            events.iter().any(|event| event == expected),
            "missing audit event {expected}: {events:?}"
        );
    }

    // The old token cannot be used even if the listener is turned back on.
    let reenable = client
        .post(format!("{host}/api/remote/enable"))
        .headers(host_headers(&daemon))
        .json(&json!({ "mode": "tunnel", "publicUrl": remote }))
        .send()
        .await
        .unwrap();
    assert!(reenable.status().is_success());
    let old_token = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(old_token.status(), StatusCode::FORBIDDEN);

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_access_refuses_unauthenticated_configurations() {
    let home = tempfile::tempdir().unwrap();
    let mut config = Config::for_home(home.path());
    config.remote_port = 0;
    let state = cockpit_daemon::state::AppState::new(config).unwrap();

    let loopback = cockpit_daemon::server::start_remote(&state, RemoteMode::Loopback, None).await;
    assert!(loopback.is_err());

    let tailscale = cockpit_daemon::server::start_remote(&state, RemoteMode::Tailscale, None).await;
    assert!(tailscale.is_err(), "port 0 must refuse a listener");

    let mut config = Config::for_home(home.path());
    config.remote_port = free_port().await;
    let state = cockpit_daemon::state::AppState::new(config).unwrap();
    let tunnel = cockpit_daemon::server::start_remote(&state, RemoteMode::Tunnel, None).await;
    assert!(tunnel.is_err(), "tunnel mode needs an explicit public URL");
    let plain_http = cockpit_daemon::server::start_remote(
        &state,
        RemoteMode::Tunnel,
        Some("http://example.com".to_string()),
    )
    .await;
    assert!(plain_http.is_err(), "public tunnel URLs must be HTTPS");
}

#[tokio::test(flavor = "multi_thread")]
async fn device_expiry_is_chosen_and_tokens_rotate_with_an_overlap() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device_with_expiry(&daemon, &remote, "Phone", None, Some(7)).await;

    let devices: Value = client
        .get(format!("{host}/api/remote/devices"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let row = devices["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == device.id)
        .expect("the paired device is listed");
    let expires_at = row["expiresAt"].as_str().expect("devices carry an expiry");
    let expires = chrono::DateTime::parse_from_rfc3339(expires_at).unwrap();
    let days = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days();
    assert!((6..=7).contains(&days), "expected about 7 days, got {days}");
    assert!(
        row["lastSeenAt"].is_null() || row["lastSeenAt"].is_string(),
        "the device list exposes last seen"
    );

    // The first authenticated use rotates the token and returns the new one.
    let response = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let rotated = response
        .headers()
        .get("x-cockpit-token")
        .expect("the rotation header is present")
        .to_str()
        .unwrap()
        .to_string();
    assert_ne!(rotated, device.token);
    assert_eq!(rotated.len(), 64);

    // The old token still works inside the overlap and does not rotate again.
    let old = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth(&device.token)
        .send()
        .await
        .unwrap();
    assert_eq!(old.status(), StatusCode::OK);
    assert!(
        old.headers().get("x-cockpit-token").is_none(),
        "a second rotation must wait for the overlap to end"
    );

    let new = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth(&rotated)
        .send()
        .await
        .unwrap();
    assert_eq!(new.status(), StatusCode::OK);

    // Once the chosen expiry passes, the token stops working and the device is
    // revoked rather than silently kept alive.
    daemon
        .state
        .store
        .set_remote_device_expiry(&device.id, "2000-01-01T00:00:00+00:00")
        .unwrap();
    let expired = client
        .get(format!("{remote}/api/remote/session"))
        .bearer_auth(&rotated)
        .send()
        .await
        .unwrap();
    assert_eq!(expired.status(), StatusCode::FORBIDDEN);
    let expired: Value = expired.json().await.unwrap();
    assert_eq!(expired["error"]["code"], "remote_device_expired");

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn pairing_expiry_must_be_an_offered_choice_and_defaults_to_fourteen_in_a_tunnel() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);

    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();
    let claim: Value = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "code": code, "deviceName": "Tablet", "verificationCode": "4321" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let claim_id = claim["claimId"].as_str().unwrap().to_string();

    let invalid = client
        .post(format!("{host}/api/remote/pair/pending/{claim_id}/confirm"))
        .headers(host_headers(&daemon))
        .json(&json!({ "verificationCode": "4321", "expiresInDays": 10 }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    let confirmed = client
        .post(format!("{host}/api/remote/pair/pending/{claim_id}/confirm"))
        .headers(host_headers(&daemon))
        .json(&json!({ "verificationCode": "4321" }))
        .send()
        .await
        .unwrap();
    assert!(confirmed.status().is_success());

    let devices: Value = client
        .get(format!("{host}/api/remote/devices"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let expires_at = devices["devices"][0]["expiresAt"]
        .as_str()
        .expect("the default expiry is stored");
    let expires = chrono::DateTime::parse_from_rfc3339(expires_at).unwrap();
    let days = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days();
    assert!(
        (13..=14).contains(&days),
        "expected about 14 days, got {days}"
    );

    let patched = client
        .patch(format!(
            "{host}/api/remote/devices/{}",
            devices["devices"][0]["id"].as_str().unwrap()
        ))
        .headers(host_headers(&daemon))
        .json(&json!({ "expiresInDays": 90 }))
        .send()
        .await
        .unwrap();
    assert!(patched.status().is_success());
    let patched: Value = patched.json().await.unwrap();
    let expires =
        chrono::DateTime::parse_from_rfc3339(patched["device"]["expiresAt"].as_str().unwrap())
            .unwrap();
    let days = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days();
    assert!(
        (89..=90).contains(&days),
        "expected about 90 days, got {days}"
    );

    daemon.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_on_disable_is_opt_in_and_revokes_every_device() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);
    let device = pair_device(&daemon, &remote, "Phone", None).await;

    let settings: Value = client
        .get(format!("{host}/api/remote/settings"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(settings["revokeOnDisable"], false, "the default is off");

    let disabled = client
        .post(format!("{host}/api/remote/disable"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(disabled.status().is_success());
    let devices: Value = client
        .get(format!("{host}/api/remote/devices"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let row = devices["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == device.id)
        .expect("the device survives when the setting is off");
    assert!(row["revokedAt"].is_null());

    let enabled = client
        .post(format!("{host}/api/remote/enable"))
        .headers(host_headers(&daemon))
        .json(&json!({ "mode": "tunnel", "publicUrl": remote }))
        .send()
        .await
        .unwrap();
    assert!(enabled.status().is_success());

    let updated: Value = client
        .put(format!("{host}/api/remote/settings"))
        .headers(host_headers(&daemon))
        .json(&json!({ "revokeOnDisable": true }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(updated["revokeOnDisable"], true);

    let disabled = client
        .post(format!("{host}/api/remote/disable"))
        .headers(host_headers(&daemon))
        .send()
        .await
        .unwrap();
    assert!(disabled.status().is_success());
    let devices: Value = client
        .get(format!("{host}/api/remote/devices"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    for row in devices["devices"].as_array().unwrap() {
        assert!(
            row["revokedAt"].is_string(),
            "revoke-on-disable must revoke every device: {row}"
        );
    }

    daemon.shutdown().await.unwrap();
}
