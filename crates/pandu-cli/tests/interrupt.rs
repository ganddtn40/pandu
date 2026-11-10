//! An interrupt sent through the session API is a `0x03` byte for exactly one
//! agent. It must never be delivered as a console control event, because that
//! event can reach the daemon, the CLI that owns the terminal, or a sibling
//! session. `STATUS_CONTROL_C_EXIT` (0xC000013A) is the failure this guards
//! against.
//!
//! The scenario is Windows-only: ConPTY is where the byte/console-event
//! confusion exists. On Unix a PTY interrupt is a signal by design.

#![cfg(windows)]

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::process::{Child, Command};

/// Announces itself, then blocks on one key. Exits 42 only when that key is
/// Ctrl+C delivered as the byte `0x03`.
const TARGET_SCRIPT: &str = "[Console]::TreatControlCAsInput = $true; \
     Write-Host TARGET-READY; \
     $key = [Console]::ReadKey($true); \
     if ($key.KeyChar -eq [char]3) { exit 42 } else { exit 1 }";

/// A sibling session that must keep running while the target is interrupted.
const SIBLING_SCRIPT: &str = "Write-Host SIBLING-READY; Start-Sleep -Seconds 60";

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_pandu"))
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

async fn get_json(client: &reqwest::Client, url: &str) -> Option<Value> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

async fn sessions(client: &reqwest::Client, base: &str) -> Vec<Value> {
    get_json(client, &format!("{base}/api/agents"))
        .await
        .and_then(|value| value.get("sessions").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

async fn output_of(client: &reqwest::Client, base: &str, session_id: &str) -> String {
    get_json(client, &format!("{base}/api/agents/{session_id}"))
        .await
        .and_then(|value| {
            value
                .get("output")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// Wait until both agents have registered and their first output has reached
/// the daemon, then return the session ids by their markers.
async fn find_both_sessions(
    client: &reqwest::Client,
    base: &str,
) -> (Option<String>, Option<String>) {
    let mut target = None;
    let mut sibling = None;
    for session in sessions(client, base).await {
        let Some(session_id) = session.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let output = output_of(client, base, session_id).await;
        if output.contains("TARGET-READY") {
            target = Some(session_id.to_string());
        }
        if output.contains("SIBLING-READY") {
            sibling = Some(session_id.to_string());
        }
    }
    (target, sibling)
}

fn spawn_agent(home: &Path, port: u16, script: &str) -> Child {
    cli()
        .arg("run")
        .arg("--home")
        .arg(home)
        .arg("--port")
        .arg(port.to_string())
        .arg("--")
        .arg("powershell.exe")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("the pandu CLI should start")
}

/// Start a real daemon on a free port and wait for it to answer health checks.
/// A port can be claimed between the probe and the bind, so retry a few times.
async fn start_daemon(home: &Path, client: &reqwest::Client) -> (Child, u16, String) {
    for _ in 0..5 {
        let port = free_port();
        let child = cli()
            .arg("serve")
            .arg("--home")
            .arg(home)
            .arg("--port")
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("the pandu daemon should start");
        let base = format!("http://127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if get_json(client, &format!("{base}/api/health"))
                .await
                .is_some()
            {
                return (child, port, base);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        drop(child);
    }
    panic!("the daemon did not start on any probed port");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_interrupt_does_not_touch_the_daemon_cli_or_sibling() {
    let home = TempDir::new().expect("a temporary home");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    let (mut daemon, port, base) = start_daemon(home.path(), &client).await;
    let mut target = spawn_agent(home.path(), port, TARGET_SCRIPT);
    let mut sibling = spawn_agent(home.path(), port, SIBLING_SCRIPT);

    let started = Instant::now();
    let (target_id, sibling_id) = loop {
        let (target_id, sibling_id) = find_both_sessions(&client, &base).await;
        if let (Some(target_id), Some(sibling_id)) = (target_id, sibling_id) {
            break (target_id, sibling_id);
        }
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "the agents did not register in time"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };

    let csrf = get_json(&client, &format!("{base}/api/csrf"))
        .await
        .and_then(|value| {
            value
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .expect("the daemon should issue a CSRF token");

    let response = client
        .post(format!("{base}/api/agents/{target_id}/input"))
        .header("origin", &base)
        .header("x-pandu-csrf", &csrf)
        .header("content-type", "application/json")
        .json(&json!({ "data": "\u{3}" }))
        .send()
        .await
        .expect("the session API should accept the interrupt");
    assert!(
        response.status().is_success(),
        "the session API rejected the interrupt: {}",
        response.status()
    );

    let status = tokio::time::timeout(Duration::from_secs(30), target.wait())
        .await
        .expect("the target CLI did not exit after the interrupt")
        .expect("the target CLI could not be waited on");
    assert_eq!(
        status.code(),
        Some(42),
        "the target did not receive 0x03 as an input byte"
    );

    // The daemon survived and still serves the host API.
    assert!(
        get_json(&client, &format!("{base}/api/health"))
            .await
            .is_some(),
        "the daemon stopped answering after the interrupt"
    );
    assert!(
        daemon.try_wait().unwrap().is_none(),
        "the daemon process exited when the interrupt was delivered"
    );

    // The sibling CLI and its session are untouched.
    assert!(
        sibling.try_wait().unwrap().is_none(),
        "the sibling CLI exited when the target was interrupted"
    );
    let sibling_session = sessions(&client, &base)
        .await
        .into_iter()
        .find(|session| session.get("sessionId").and_then(Value::as_str) == Some(&sibling_id))
        .expect("the sibling session disappeared");
    assert_eq!(
        sibling_session.get("status").and_then(Value::as_str),
        Some("running"),
        "the sibling session stopped when the target was interrupted"
    );

    // The target ended through its own exit code, not through a signal.
    let target_session = sessions(&client, &base)
        .await
        .into_iter()
        .find(|session| session.get("sessionId").and_then(Value::as_str) == Some(&target_id))
        .expect("the target session disappeared");
    assert_eq!(
        target_session.get("status").and_then(Value::as_str),
        Some("exited")
    );
    assert_eq!(
        target_session.get("exitCode").and_then(Value::as_i64),
        Some(42)
    );
}
