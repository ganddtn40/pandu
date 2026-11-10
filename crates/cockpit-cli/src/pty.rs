//! The pseudo-terminal owned by `cockpit run`.
//!
//! Security boundary: this module spawns exactly the command the user typed,
//! in the directory they ran Cockpit from. The daemon never supplies a command
//! or a working directory; it can only queue keystrokes for a session that is
//! already running.
//!
//! On Windows this uses ConPTY through `portable-pty`. On Unix it uses the
//! platform PTY. The agent's terminal is a child of this process, so closing
//! the master (or killing the child) tears the whole session down.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, bail};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};

pub struct PtyRequest<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub env: &'a [(String, String)],
    pub agent_name: &'a str,
    pub adapter_id: &'a str,
    pub addr: std::net::SocketAddr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyOutcome {
    pub exit_code: Option<i32>,
    pub killed: bool,
}

struct SpawnedPty {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

fn resize_master(master: &(dyn MasterPty + Send), cols: u16, rows: u16) {
    let _ = master.resize(PtySize {
        rows: rows.max(10),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    });
}

/// Open a PTY and spawn exactly `program` with `args`. Environment variables
/// from the parent are inherited, then `env` overrides are applied.
fn spawn_pty(
    program: &str,
    args: &[String],
    env: &[(String, String)],
) -> anyhow::Result<SpawnedPty> {
    let (cols, rows) = crossterm::terminal::size().unwrap_or((120, 32));
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(10),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("could not open a pseudo-terminal")?;

    let mut command = CommandBuilder::new(program);
    command.args(args);
    command.cwd(std::env::current_dir().context("could not read the working directory")?);
    for (key, value) in std::env::vars_os() {
        command.env(key, value);
    }
    for (key, value) in env {
        command.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .with_context(|| format!("could not run `{program}`"))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let reader = pair
        .master
        .try_clone_reader()
        .context("could not read the pseudo-terminal")?;
    let writer = pair
        .master
        .take_writer()
        .context("could not write to the pseudo-terminal")?;

    Ok(SpawnedPty {
        master: pair.master,
        reader,
        writer,
        child,
        killer,
    })
}

/// Run the agent in a PTY and mirror it into the daemon control plane.
///
/// Any daemon failure is non-fatal for the agent: if the control plane goes
/// away, the user keeps their terminal and the agent keeps running.
pub async fn run(request: PtyRequest<'_>) -> anyhow::Result<PtyOutcome> {
    let mut spawned = spawn_pty(request.program, request.args, request.env)?;
    let pid = spawned.child.process_id();
    let cwd = std::env::current_dir().context("could not read the working directory")?;

    let base = format!("http://{}", request.addr);
    let bootstrap = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("could not build the daemon client")?;
    let csrf = match crate::host_csrf(&bootstrap, &base).await {
        Ok(token) => token,
        Err(error) => {
            // Never leave a spawned agent behind when the daemon refuses.
            let _ = spawned.killer.kill();
            let _ = spawned.child.wait();
            return Err(error);
        }
    };
    let mut host_headers = reqwest::header::HeaderMap::new();
    host_headers.insert(
        reqwest::header::ORIGIN,
        base.parse()
            .context("could not build the host Origin header")?,
    );
    host_headers.insert(
        "x-cockpit-csrf",
        csrf.parse()
            .context("the daemon returned an invalid CSRF token")?,
    );
    host_headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .default_headers(host_headers)
        .build()
        .context("could not build the daemon client")?;
    let command_line = std::iter::once(request.program)
        .chain(request.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");

    let session_id = match register_session(
        &client,
        &base,
        request.agent_name,
        request.adapter_id,
        &cwd,
        pid,
        &command_line,
    )
    .await
    {
        Ok(session_id) => session_id,
        Err(error) => {
            // Never leave a spawned agent behind when registration fails.
            let _ = spawned.killer.kill();
            let _ = spawned.child.wait();
            return Err(error);
        }
    };

    // Raw mode forwards single keystrokes (y/n, arrows) to the agent instead
    // of waiting for Enter. It is best-effort: a pipe or CI shell keeps
    // working in cooked mode.
    let _raw = RawMode::enable();
    let SpawnedPty {
        master,
        reader,
        writer: pty_writer,
        child,
        killer,
    } = spawned;
    let mut killer = killer;
    let writer = Arc::new(Mutex::new(pty_writer));
    let (output_tx, mut output_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    let reader_thread = {
        let mut reader = reader;
        let writer = writer.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8_192];
            // ConPTY asks the terminal for the cursor position with `ESC[6n`
            // and waits for an answer. Without a reply, cmd.exe and anything
            // that queries the cursor can hang before producing output.
            let mut scan = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        scan.extend_from_slice(&buffer[..count]);
                        if scan.windows(4).any(|window| window == b"\x1b[6n") {
                            if let Ok(mut writer) = writer.lock() {
                                let _ = writer.write_all(b"\x1b[1;1R");
                                let _ = writer.flush();
                            }
                            scan.clear();
                        } else if scan.len() > 3 {
                            let keep = scan.len() - 3;
                            scan.drain(..keep);
                        }
                        if output_tx.send(buffer[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        })
    };

    let stdin_thread = {
        let writer = writer.clone();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buffer = [0u8; 1_024];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let Ok(mut writer) = writer.lock() else { break };
                        if writer.write_all(&buffer[..count]).is_err() {
                            break;
                        }
                        let _ = writer.flush();
                    }
                }
            }
        })
    };

    let (exit_tx, mut exit_rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let mut child = child;
        tokio::task::spawn_blocking(move || {
            let _ = exit_tx.send(child.wait());
        });
    }

    let poll_handle = spawn_input_poll(
        client.clone(),
        base.clone(),
        session_id.clone(),
        writer.clone(),
    );

    let mut pending = String::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(50));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut resize_ticker = tokio::time::interval(Duration::from_secs(1));
    let outcome;

    loop {
        tokio::select! {
            chunk = output_rx.recv() => {
                match chunk {
                    Some(bytes) => {
                        pending.push_str(&String::from_utf8_lossy(&bytes));
                        if pending.len() >= 8 * 1_024 {
                            flush_output(&client, &base, &session_id, &mut pending).await;
                        }
                    }
                    None => {
                        outcome = PtyOutcome { exit_code: None, killed: false };
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                if !pending.is_empty() {
                    flush_output(&client, &base, &session_id, &mut pending).await;
                }
            }
            _ = resize_ticker.tick() => {
                if let Ok((cols, rows)) = crossterm::terminal::size() {
                    resize_master(master.as_ref(), cols, rows);
                }
            }
            status = exit_rx.recv() => {
                outcome = match status {
                    Some(Ok(status)) => PtyOutcome {
                        exit_code: Some(status.exit_code() as i32),
                        killed: false,
                    },
                    Some(Err(error)) => {
                        tracing::debug!(%error, "could not read the agent exit status");
                        PtyOutcome { exit_code: None, killed: false }
                    }
                    None => PtyOutcome { exit_code: None, killed: false },
                };
                break;
            }
            _ = tokio::signal::ctrl_c() => {
                // With raw mode this is normally forwarded as a byte by the
                // stdin thread. This branch only fires if the terminal driver
                // still turns Ctrl-C into a signal; pass it on, then kill.
                let writer = writer.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    if let Ok(mut writer) = writer.lock() {
                        let _ = writer.write_all(&[3]);
                        let _ = writer.flush();
                    }
                })
                .await;
                tokio::time::sleep(Duration::from_secs(2)).await;
                let _ = killer.kill();
                tokio::time::sleep(Duration::from_millis(300)).await;
                outcome = PtyOutcome { exit_code: None, killed: true };
                break;
            }
        }
    }

    // Give the reader a moment to deliver output that was produced just
    // before the child exited, then flush it.
    let drain = async {
        while let Some(bytes) = output_rx.recv().await {
            pending.push_str(&String::from_utf8_lossy(&bytes));
            if pending.len() >= 8 * 1_024 {
                flush_output(&client, &base, &session_id, &mut pending).await;
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_millis(250), drain).await;
    flush_output(&client, &base, &session_id, &mut pending).await;

    poll_handle.abort();
    let _ = &reader_thread;
    let _ = &stdin_thread;

    let _ = client
        .post(format!("{base}/api/agents/{session_id}/end"))
        .json(&json!({
            "exitCode": outcome.exit_code,
            "killed": outcome.killed,
        }))
        .send()
        .await;

    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
async fn register_session(
    client: &reqwest::Client,
    base: &str,
    agent_name: &str,
    adapter_id: &str,
    cwd: &Path,
    pid: Option<u32>,
    command_line: &str,
) -> anyhow::Result<String> {
    let project = cwd
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace")
        .to_string();
    let response = client
        .post(format!("{base}/api/agents/register"))
        .json(&json!({
            "agentName": agent_name,
            "projectName": project,
            "workingDir": cwd.display().to_string(),
            "adapter": adapter_id,
            "pid": pid,
            "commandLine": command_line,
        }))
        .send()
        .await
        .context("could not reach the Cockpit daemon")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        bail!("the Cockpit daemon rejected this session ({status}): {body}");
    }
    let payload: Value = response
        .json()
        .await
        .context("the Cockpit daemon returned an invalid registration")?;
    payload["session"]["sessionId"]
        .as_str()
        .map(str::to_string)
        .context("the Cockpit daemon did not return a session id")
}

fn spawn_input_poll(
    client: reqwest::Client,
    base: String,
    session_id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut after = 0u64;
        loop {
            let url = format!("{base}/api/agents/{session_id}/input?after={after}&waitMs=1000");
            let response = match client.get(&url).send().await {
                Ok(response) if response.status().is_success() => response,
                _ => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            let payload: Value = match response.json().await {
                Ok(value) => value,
                Err(_) => continue,
            };
            let status = payload["status"].as_str().unwrap_or("running");
            if let Some(chunks) = payload["chunks"].as_array() {
                for chunk in chunks {
                    let Some(data) = chunk["data"].as_str() else {
                        continue;
                    };
                    if let Some(sequence) = chunk["sequence"].as_u64() {
                        after = sequence.saturating_add(1);
                    }
                    let bytes = data.as_bytes().to_vec();
                    let writer = writer.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Ok(mut writer) = writer.lock() {
                            let _ = writer.write_all(&bytes);
                            let _ = writer.flush();
                        }
                    })
                    .await;
                }
            }
            if status != "running" {
                break;
            }
        }
    })
}

async fn flush_output(
    client: &reqwest::Client,
    base: &str,
    session_id: &str,
    pending: &mut String,
) {
    if pending.is_empty() {
        return;
    }
    let data = std::mem::take(pending);
    let result = client
        .post(format!("{base}/api/agents/{session_id}/output"))
        .json(&json!({ "data": data }))
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    match result {
        Ok(response) if !response.status().is_success() => {
            tracing::debug!(status = %response.status(), "the daemon rejected agent output");
        }
        Err(error) => tracing::debug!(%error, "could not send agent output to the daemon"),
        _ => {}
    }
}

/// Restore the terminal mode even on an early return or panic.
struct RawMode {
    enabled: bool,
}

impl RawMode {
    fn enable() -> Self {
        if crossterm::terminal::is_raw_mode_enabled().unwrap_or(false) {
            return Self { enabled: false };
        }
        match crossterm::terminal::enable_raw_mode() {
            Ok(()) => Self { enabled: true },
            Err(error) => {
                tracing::debug!(%error, "could not enable raw terminal mode");
                Self { enabled: false }
            }
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        if self.enabled {
            let _ = crossterm::terminal::disable_raw_mode();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// ConPTY tests each own a pseudoconsole but share the host console. Run
    /// them one at a time so a keystroke or control event from one test cannot
    /// reach another.
    static PTY_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serialize() -> std::sync::MutexGuard<'static, ()> {
        PTY_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(windows)]
    fn echo_command() -> (String, Vec<String>) {
        (
            "cmd.exe".to_string(),
            vec!["/C".to_string(), "echo cockpit-pty-ok".to_string()],
        )
    }

    #[cfg(not(windows))]
    fn echo_command() -> (String, Vec<String>) {
        (
            "sh".to_string(),
            vec!["-c".to_string(), "echo cockpit-pty-ok".to_string()],
        )
    }

    #[cfg(windows)]
    fn long_command() -> (String, Vec<String>) {
        (
            "cmd.exe".to_string(),
            vec!["/C".to_string(), "pause".to_string()],
        )
    }

    #[cfg(not(windows))]
    fn long_command() -> (String, Vec<String>) {
        (
            "sh".to_string(),
            vec!["-c".to_string(), "sleep 60".to_string()],
        )
    }

    /// A child that announces it is ready, then blocks on one key and exits
    /// with 42 only when that key is Ctrl+C. This is the contract the session
    /// API relies on: an interrupt is an input byte, not a console event.
    #[cfg(windows)]
    fn interrupt_command() -> (String, Vec<String>) {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "[Console]::TreatControlCAsInput = $true; Write-Host READY; \
                 $key = [Console]::ReadKey($true); \
                 if ($key.KeyChar -eq [char]3) { exit 42 } else { exit 1 }"
                    .to_string(),
            ],
        )
    }

    #[cfg(not(windows))]
    fn interrupt_command() -> (String, Vec<String>) {
        (
            "sh".to_string(),
            vec![
                "-c".to_string(),
                "stty raw -echo; printf 'READY\\n'; \
                 byte=$(dd bs=1 count=1 2>/dev/null); \
                 if [ \"$byte\" = \"$(printf '\\003')\" ]; then exit 42; fi; exit 1"
                    .to_string(),
            ],
        )
    }

    /// Answer the ConPTY cursor-position query the way a terminal would.
    fn answer_cursor_query(output: &str, writer: &mut Box<dyn Write + Send>) {
        if output.contains("\x1b[6n") {
            let _ = writer.write_all(b"\x1b[1;1R");
            let _ = writer.flush();
        }
    }

    fn wait_with_deadline(child: &mut Box<dyn Child + Send + Sync>) -> portable_pty::ExitStatus {
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return status;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the child did not exit in time"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn the_pty_runs_a_command_and_returns_its_output() {
        let _serial = serialize();
        let (program, args) = echo_command();
        let mut spawned = spawn_pty(&program, &args, &[]).unwrap();
        let mut writer = spawned.writer;
        let mut reader = spawned.reader;

        let (output_tx, output_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut output = String::new();
            let mut answered = false;
            let mut buffer = [0u8; 4_096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        output.push_str(&String::from_utf8_lossy(&buffer[..count]));
                        if !answered && output.contains("\x1b[6n") {
                            answer_cursor_query(&output, &mut writer);
                            answered = true;
                        }
                        if output.contains("cockpit-pty-ok") {
                            break;
                        }
                    }
                }
            }
            let _ = output_tx.send(output);
        });

        let output = output_rx
            .recv_timeout(Duration::from_secs(20))
            .expect("the PTY should produce output without hanging");
        let status = wait_with_deadline(&mut spawned.child);
        assert_eq!(status.exit_code(), 0);
        assert!(
            output.contains("cockpit-pty-ok"),
            "the PTY did not carry the command output: {output:?}"
        );
    }

    #[test]
    fn an_interrupt_reaches_the_child_as_a_zero_three_byte() {
        let _serial = serialize();
        let (program, args) = interrupt_command();
        let mut spawned = spawn_pty(&program, &args, &[]).unwrap();
        let mut writer = spawned.writer;
        let mut reader = spawned.reader;

        // Wait for the child to say it is ready, answering the ConPTY cursor
        // query on the way, so the byte is not written before it reads stdin.
        // The reader runs on its own thread so a silent child cannot block the
        // deadline below.
        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4_096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if chunk_tx.send(buffer[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let mut output = String::new();
        let mut answered = false;
        let started = Instant::now();
        loop {
            let remaining = Duration::from_secs(30).saturating_sub(started.elapsed());
            let chunk = chunk_rx
                .recv_timeout(remaining)
                .unwrap_or_else(|_| panic!("the child never became ready: {output:?}"));
            output.push_str(&String::from_utf8_lossy(&chunk));
            if !answered && output.contains("\x1b[6n") {
                writer.write_all(b"\x1b[1;1R").unwrap();
                writer.flush().unwrap();
                answered = true;
            }
            if output.contains("READY") {
                break;
            }
        }

        writer.write_all(&[3]).unwrap();
        writer.flush().unwrap();

        let status = wait_with_deadline(&mut spawned.child);
        assert_eq!(
            status.exit_code(),
            42,
            "the child did not receive 0x03 as an interrupt: {output:?}"
        );
    }

    #[test]
    fn killing_the_child_closes_the_pty_without_waiting_for_it() {
        let _serial = serialize();
        let (program, args) = long_command();
        let mut spawned = spawn_pty(&program, &args, &[]).unwrap();
        let mut killer = spawned.killer;
        // portable-pty 0.9 reports a stale Windows error even when the kill
        // succeeds; the deadline below is the real assertion.
        let _ = killer.kill();

        // `wait` must return promptly; a hanging wait means an orphan.
        let started = Instant::now();
        let _ = wait_with_deadline(&mut spawned.child);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the child did not exit after kill"
        );

        // Closing the master closes the pseudoconsole and releases its pipes.
        drop(spawned.master);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let mut reader = spawned.reader;
        std::thread::spawn(move || {
            let mut buffer = [0u8; 1_024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            let _ = done_tx.send(());
        });
        assert!(
            done_rx.recv_timeout(Duration::from_secs(10)).is_ok(),
            "the PTY reader stayed open after the child was killed"
        );
    }
}
