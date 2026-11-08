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
use cockpit_core::guard::{GuardAction, GuardEventStatus, GuardRuleKind, GuardSeverity};
use cockpit_core::model::{CaptureMode, SessionSource, SessionStatus};
use cockpit_daemon::remote::{RemoteAccess, RemoteMode};
use cockpit_daemon::store::{NewGuardEvent, NewSession};
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
            .get(format!("{public_url}/api/remote/health"))
            .send()
            .await
        {
            if response.status().is_success() {
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
        .get(format!("{public_url}/api/remote/health"))
        .header("host", "evil.example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(mismatch.status(), StatusCode::FORBIDDEN);
    let mismatch_origin = client
        .get(format!("{public_url}/api/remote/health"))
        .header("origin", "https://evil.example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(mismatch_origin.status(), StatusCode::FORBIDDEN);

    let good = client
        .get(format!("{public_url}/api/remote/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), StatusCode::OK);
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
    let host = host_base(daemon);
    let client = reqwest::Client::new();
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 32);
    let mut body = json!({ "code": code, "deviceName": name });
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

    let confirmed = client
        .post(format!("{host}/api/remote/pair/pending/{claim_id}/confirm"))
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

async fn append_agent_output(client: &reqwest::Client, host: &str, session_id: &str, data: &str) {
    let response = client
        .post(format!("{host}/api/agents/{session_id}/output"))
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
    host: &str,
    session_id: &str,
    output: &str,
) {
    append_agent_output(client, host, session_id, &".".repeat(900)).await;
    append_agent_output(client, host, session_id, output).await;
}

async fn mark_awaiting_prompt(client: &reqwest::Client, host: &str, session_id: &str) {
    set_agent_prompt_state(
        client,
        host,
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
    let full = pair_device(&daemon, &remote, "Full", Some("1234")).await;
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
    append_agent_output(&client, &host, &session_id, "terminal-secret-value").await;
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
    append_agent_output(&client, &host, &session_id, "visible-now").await;
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
async fn pairing_is_single_use_host_confirmed_and_brute_force_limited() {
    let mock = MockUpstream::start().await;
    let home = tempfile::tempdir().unwrap();
    let (daemon, remote) = start_remote_daemon(home.path(), mock.addr).await;
    let client = reqwest::Client::new();
    let host = host_base(&daemon);

    // A wrong code consumes attempts and locks the IP after five failures.
    let issued: Value = client
        .post(format!("{host}/api/remote/pair/code"))
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
            .json(&json!({ "code": wrong, "deviceName": "Attacker" }))
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
        .json(&json!({ "code": good_code, "deviceName": "Attacker" }))
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
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();

    let claim: Value = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "code": code, "deviceName": "Pixel", "pin": "1234" }))
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
        .json(&json!({ "code": code, "deviceName": "Other" }))
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

    let confirmed = client
        .post(format!("{host}/api/remote/pair/pending/{claim_id}/confirm"))
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
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();
    let denied_claim: Value = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "code": code, "deviceName": "Denied" }))
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

    let issue = |client: reqwest::Client, host: String| async move {
        let issued: Value = client
            .post(format!("{host}/api/remote/pair/code"))
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
    let code = issue(client.clone(), host.clone()).await;
    let claim = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .header("cf-connecting-ip", "203.0.113.9")
        .json(&json!({ "code": code, "deviceName": "Tunnel phone" }))
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
    let code = issue(client.clone(), host.clone()).await;
    let claim = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "code": code, "deviceName": "Untrusted phone" }))
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
    let code = issue(client.clone(), host.clone()).await;
    let claim = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .header("cf-connecting-ip", "not-an-ip")
        .json(&json!({ "code": code, "deviceName": "Spoof phone" }))
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
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let code = issued["code"].as_str().unwrap().to_string();
        let claim: Value = client
            .post(format!("{remote}/api/remote/pair/claim"))
            .json(&json!({ "code": code, "deviceName": format!("Queue {index}") }))
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
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let code = issued["code"].as_str().unwrap().to_string();
    let blocked = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "code": code, "deviceName": "Queue 3" }))
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
        .send()
        .await
        .unwrap();
    assert!(confirmed.status().is_success());
    let retried = client
        .post(format!("{remote}/api/remote/pair/claim"))
        .json(&json!({ "code": code, "deviceName": "Queue 3" }))
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
    let device = pair_device(&daemon, &remote, "Approver", Some("1234")).await;
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
            "pin": "9999",
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
            "pin": "1234",
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
            "pin": "1234",
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
        .json(&json!({ "mode": "tunnel", "publicUrl": remote }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());

    let client = reqwest::Client::new();
    let device = pair_device(&daemon, &remote, "Slow", Some("1234")).await;
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
            "pin": "1234",
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
    let device = pair_device(&daemon, &remote, "Prompter", Some("1234")).await;
    set_scopes(&daemon, &device.id, &["view", "respond", "prompt"], false).await;

    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
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

    mark_awaiting_prompt(&client, &host, &session_id).await;

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
    mark_awaiting_prompt(&client, &host, &session_id).await;
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
        mark_awaiting_prompt(&client, &host, &session_id).await;
        let response = client
            .post(format!("{remote}/api/remote/agents/{session_id}/prompt"))
            .bearer_auth(&device.token)
            .json(&json!({ "text": "again" }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    mark_awaiting_prompt(&client, &host, &session_id).await;
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

    mark_awaiting_prompt(&client, &host, &session_id).await;

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
        set_agent_prompt_state(&client, &host, &session_id, output).await;
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
    mark_awaiting_prompt(&client, &host, &session_id).await;
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

    mark_awaiting_prompt(&client, &host, &session_id).await;
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
    let device = pair_device(&daemon, &remote, "Approver", Some("1234")).await;
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
            "pin": "1234",
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

    let device = pair_device(&daemon, &remote, "Audit phone", Some("1234")).await;
    set_scopes(&daemon, &device.id, &["view", "respond", "prompt"], false).await;

    let registered: Value = client
        .post(format!("{host}/api/agents/register"))
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
    mark_awaiting_prompt(&client, &host, &agent_session).await;
    let prompt_text = "audit-only prompt body";
    let sent = client
        .post(format!("{remote}/api/remote/agents/{agent_session}/prompt"))
        .bearer_auth(&device.token)
        .json(&json!({ "text": prompt_text }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), StatusCode::OK);

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
        .send()
        .await
        .unwrap();
    assert!(revoked.status().is_success());

    let disabled = client
        .post(format!("{host}/api/remote/disable"))
        .send()
        .await
        .unwrap();
    assert!(disabled.status().is_success());

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
        "approval.approve",
        "approval.deny",
        "pair.deny",
        "auth.failure",
        "device.revoke",
        "remote.disabled",
    ] {
        assert!(
            events.iter().any(|event| event == expected),
            "missing audit event {expected}: {events:?}"
        );
    }
    assert_eq!(audit["total"].as_u64().unwrap(), events.len() as u64);

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

    let health = client
        .get(format!("{remote}/api/remote/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);

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
