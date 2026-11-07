//! The `cockpit` command-line entry point.
//!
//! `cockpit serve` (the default) runs the daemon. `cockpit run -- <agent>`
//! starts a daemon if needed, points the agent at the local proxy, and runs it.
//! `cockpit doctor` and `cockpit report` are local, read-only diagnostics, and
//! `cockpit pair` issues a short-lived code for the phone companion.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};
use cockpit_core::adapter::{Adapter, AdapterIssue, AdapterProtocol, AdapterRegistry};
use cockpit_daemon::Config;
use cockpit_daemon::ServerHandle;
use cockpit_daemon::adapters;
use cockpit_daemon::config::PROXY_KEY_SENTINEL;
use cockpit_daemon::logwatch;
use cockpit_daemon::store::Store;
use serde::Serialize;
use serde_json::{Value, json};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "cockpit",
    version,
    about = "Local flight recorder for coding agents",
    long_about = "Cockpit records what your coding agent sends to model providers, keeps the receipts in SQLite, and shows you every flight."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the daemon (the default when no command is given).
    Serve(ServeArgs),
    /// Start the daemon with demo flights already seeded.
    Demo(ServeArgs),
    /// Start the daemon if needed, then run an agent through the local proxy.
    ///
    /// Put the agent and its arguments after `--`, for example:
    /// `cockpit run -- claude`.
    Run(RunArgs),
    /// Check the database, adapters, log watcher, and running daemon.
    Doctor(DoctorArgs),
    /// Write a local diagnostic report. Nothing is uploaded.
    Report(ReportArgs),
    /// Issue a pairing code for the phone companion.
    Pair(PairArgs),
}

#[derive(Debug, Args, Default, Clone)]
struct ServeArgs {
    /// Interface to bind, for example 127.0.0.1.
    #[arg(long)]
    host: Option<String>,
    /// Port to bind. Use 0 to ask the operating system for a free port.
    #[arg(long)]
    port: Option<u16>,
    /// Directory for the database and future Cockpit state.
    #[arg(long)]
    home: Option<PathBuf>,
    /// SQLite database path. Defaults to <home>/cockpit.db.
    #[arg(long)]
    database: Option<PathBuf>,
    /// Override the OpenAI upstream base URL.
    #[arg(long = "openai-upstream")]
    openai_upstream: Option<String>,
    /// Override the Anthropic upstream base URL.
    #[arg(long = "anthropic-upstream")]
    anthropic_upstream: Option<String>,
    /// Override the Gemini upstream base URL.
    #[arg(long = "gemini-upstream")]
    gemini_upstream: Option<String>,
    /// Seed demo flights on first start.
    #[arg(long)]
    demo: bool,
}

impl ServeArgs {
    fn apply(self, mut config: Config, force_demo: bool) -> Config {
        if let Some(host) = self.host {
            config.host = host;
        }
        if let Some(port) = self.port {
            config.port = port;
        }
        let database = self.database;
        if let Some(home) = self.home {
            // A custom home must also move the default database; otherwise the
            // daemon keeps writing to the default home's database.
            config.database_path = home.join("cockpit.db");
            config.home = home;
        }
        if let Some(database) = database {
            config.database_path = database;
        }
        if let Some(base) = self.openai_upstream {
            config.openai.base_url = base.trim_end_matches('/').to_string();
        }
        if let Some(base) = self.anthropic_upstream {
            config.anthropic.base_url = base.trim_end_matches('/').to_string();
        }
        if let Some(base) = self.gemini_upstream {
            config.gemini.base_url = base.trim_end_matches('/').to_string();
        }
        config.demo_mode = config.demo_mode || self.demo || force_demo;
        config
    }
}

#[derive(Debug, Args, Clone)]
struct RunArgs {
    #[command(flatten)]
    serve: ServeArgs,
    /// The agent command and its arguments, after `--`.
    #[arg(last = true, required = true, value_name = "AGENT")]
    agent: Vec<String>,
}

#[derive(Debug, Args, Default)]
struct DoctorArgs {
    /// Directory for the database and Cockpit state.
    #[arg(long)]
    home: Option<PathBuf>,
    /// Daemon host to probe.
    #[arg(long)]
    host: Option<String>,
    /// Daemon port to probe.
    #[arg(long)]
    port: Option<u16>,
    /// Print JSON instead of a human-readable summary.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args, Default)]
struct ReportArgs {
    /// Directory for the database and Cockpit state.
    #[arg(long)]
    home: Option<PathBuf>,
    /// Write the report to this file instead of standard output.
    #[arg(long)]
    output: Option<PathBuf>,
    /// Print JSON instead of Markdown.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args, Default)]
struct PairArgs {
    /// Daemon host.
    #[arg(long)]
    host: Option<String>,
    /// Daemon port.
    #[arg(long)]
    port: Option<u16>,
    /// Claim this code instead of issuing a new one.
    #[arg(long, value_name = "CODE")]
    claim: Option<String>,
    /// A friendly name for the device, used with --claim.
    #[arg(long = "device-name", value_name = "NAME")]
    device_name: Option<String>,
    /// Print JSON instead of a human-readable summary.
    #[arg(long)]
    json: bool,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .compact()
        .init();

    let config = Config::load().context("could not read Cockpit configuration")?;

    match cli
        .command
        .unwrap_or_else(|| Command::Serve(ServeArgs::default()))
    {
        Command::Serve(args) => run_daemon(args.apply(config, false)),
        Command::Demo(args) => run_daemon(args.apply(config, true)),
        Command::Run(args) => {
            let config = args.serve.clone().apply(config, false);
            runtime()?.block_on(run_agent(config, args))
        }
        Command::Doctor(args) => {
            let config = apply_local_args(config, args.home, args.host, args.port);
            runtime()?.block_on(doctor(config, args.json))
        }
        Command::Report(args) => {
            let config = apply_local_args(config, args.home.clone(), None, None);
            runtime()?.block_on(report(config, args))
        }
        Command::Pair(args) => {
            let config = apply_local_args(config, None, args.host.clone(), args.port);
            runtime()?.block_on(pair(config, args))
        }
    }
}

fn run_daemon(config: Config) -> anyhow::Result<()> {
    runtime()?.block_on(async move {
        cockpit_daemon::run(config)
            .await
            .context("the Cockpit daemon stopped with an error")
    })
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("could not start the async runtime")
}

fn apply_local_args(
    mut config: Config,
    home: Option<PathBuf>,
    host: Option<String>,
    port: Option<u16>,
) -> Config {
    if let Some(home) = home {
        config.database_path = home.join("cockpit.db");
        config.home = home;
    }
    if let Some(host) = host {
        config.host = host;
    }
    if let Some(port) = port {
        config.port = port;
    }
    config
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

enum Daemon {
    External,
    Owned(ServerHandle),
}

async fn run_agent(config: Config, args: RunArgs) -> anyhow::Result<()> {
    let registry = adapters::load_registry(&config.home);
    let program = args
        .agent
        .first()
        .context("give an agent command after `--`, for example: cockpit run -- claude")?
        .clone();
    let adapter = find_adapter(&registry, &program).cloned();
    let (daemon, addr) = ensure_daemon(&config).await?;

    let environment = adapter
        .as_ref()
        .map(|adapter| proxy_environment(adapter, addr))
        .unwrap_or_default();

    println!(
        "Cockpit {} recording on http://{addr}",
        cockpit_core::VERSION
    );
    match &adapter {
        Some(adapter) if !environment.is_empty() => {
            println!(
                "Using the {} adapter. Proxy variables: {}",
                adapter.name,
                environment
                    .iter()
                    .map(|(name, _)| name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        Some(adapter) => {
            println!(
                "Using the {} adapter. It captures logs only, so no proxy variables were set.",
                adapter.name
            );
        }
        None => println!("No adapter matched `{program}`. Running it without proxy settings."),
    }

    let mut command = agent_command(&args.agent);
    command.envs(environment.iter().cloned());
    let status = command
        .status()
        .await
        .with_context(|| format!("could not run `{program}`"))?;

    if let Daemon::Owned(handle) = daemon {
        handle.shutdown().await?;
    }

    match status.code() {
        Some(0) => Ok(()),
        Some(code) => std::process::exit(code),
        None => bail!("`{program}` ended without an exit code"),
    }
}

async fn ensure_daemon(config: &Config) -> anyhow::Result<(Daemon, SocketAddr)> {
    if let Some(health) = probe_daemon(config).await {
        let version = health
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if version != cockpit_core::VERSION {
            bail!(
                "port {} is serving Cockpit {version}, but this CLI is {}. \
                 Start the new daemon on another port with --port.",
                config.port,
                cockpit_core::VERSION
            );
        }
        let addr = daemon_addr(config)?;
        return Ok((Daemon::External, addr));
    }

    let handle = cockpit_daemon::spawn(config.clone())
        .await
        .context("could not start the Cockpit daemon")?;
    let addr = handle.addr;
    Ok((Daemon::Owned(handle), addr))
}

async fn probe_daemon(config: &Config) -> Option<Value> {
    if config.port == 0 {
        return None;
    }
    let url = format!(
        "http://{}:{}/api/health",
        client_host(&config.host),
        config.port
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .ok()?;
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

fn daemon_addr(config: &Config) -> anyhow::Result<SocketAddr> {
    format!("{}:{}", client_host(&config.host), config.port)
        .parse()
        .with_context(|| format!("`{}:{}` is not a usable address", config.host, config.port))
}

fn client_host(host: &str) -> &str {
    match host {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        other => other,
    }
}

fn find_adapter<'a>(registry: &'a AdapterRegistry, command: &str) -> Option<&'a Adapter> {
    let stem = Path::new(command)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(command);
    registry.find(stem).or_else(|| {
        registry
            .all()
            .iter()
            .find(|adapter| adapter.detect.command.eq_ignore_ascii_case(stem))
    })
}

/// Build the environment an adapter needs for proxy capture. The key value is a
/// local sentinel, never the user's real key; the proxy swaps in the real key.
fn proxy_environment(adapter: &Adapter, addr: SocketAddr) -> Vec<(String, String)> {
    let Some(proxy) = &adapter.proxy else {
        return Vec::new();
    };
    let base = match proxy.protocols.first() {
        Some(AdapterProtocol::OpenaiChat | AdapterProtocol::OpenaiResponses) => {
            format!("http://{addr}/v1")
        }
        _ => format!("http://{addr}"),
    };

    let mut environment = Vec::new();
    for name in &proxy.base_url_env {
        environment.push((name.clone(), base.clone()));
    }
    for name in &proxy.api_key_env {
        environment.push((name.clone(), PROXY_KEY_SENTINEL.to_string()));
    }
    environment
}

fn agent_command(agent: &[String]) -> tokio::process::Command {
    let program = &agent[0];
    let resolved = adapters::find_executable(program);

    #[cfg(windows)]
    {
        if let Some(path) = &resolved {
            let extension = path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if extension == "cmd" || extension == "bat" {
                let mut command = tokio::process::Command::new("cmd");
                command.arg("/C").arg(path).args(&agent[1..]);
                return command;
            }
        }
    }

    let mut command = match &resolved {
        Some(path) => tokio::process::Command::new(path),
        None => tokio::process::Command::new(program),
    };
    command.args(&agent[1..]);
    command
}

// ---------------------------------------------------------------------------
// doctor and report
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    version: String,
    os: String,
    arch: String,
    home: String,
    database_path: String,
    database_exists: bool,
    database_ok: bool,
    sessions: u64,
    active_sessions: u64,
    steps: u64,
    daemon_url: String,
    daemon_running: bool,
    daemon_version: Option<String>,
    adapters_total: usize,
    adapters_installed: usize,
    adapters_verified: usize,
    adapter_issues: Vec<AdapterIssue>,
    log_watch_enabled: bool,
    log_watch_files: usize,
    log_watch_records: u64,
    warnings: Vec<String>,
}

async fn collect_diagnostics(config: &Config) -> Diagnostics {
    let mut warnings = Vec::new();
    let database_exists = config.database_path.exists();
    let mut database_ok = false;
    let mut sessions = 0;
    let mut active_sessions = 0;
    let mut steps = 0;
    let mut log_watch_files = 0;
    let mut log_watch_records = 0;

    if database_exists {
        match Store::open(&config.database_path) {
            Ok(store) => {
                database_ok = store.ping();
                if database_ok {
                    match store.overview() {
                        Ok(overview) => {
                            sessions = overview.session_count;
                            active_sessions = overview.active_session_count;
                            steps = overview.step_count;
                        }
                        Err(error) => {
                            warnings.push(format!("could not read flight totals: {error}"))
                        }
                    }
                    (log_watch_files, log_watch_records) = logwatch::stored_state(&store);
                }
            }
            Err(error) => warnings.push(format!("the database could not be opened: {error}")),
        }
    } else {
        warnings.push(
            "the database does not exist yet; start the daemon or run `cockpit demo` once"
                .to_string(),
        );
    }

    let registry = adapters::load_registry(&config.home);
    let statuses = adapters::statuses(&registry);
    let adapters_installed = statuses.iter().filter(|status| status.installed).count();
    let adapters_verified = statuses.iter().filter(|status| status.verified).count();
    if adapters_verified < statuses.len() {
        warnings.push(format!(
            "{} of {} adapters are unverified; run `cockpit doctor` after checking vendor docs",
            statuses.len() - adapters_verified,
            statuses.len()
        ));
    }
    for issue in registry.issues() {
        warnings.push(format!("{}: {}", issue.source, issue.message));
    }

    let daemon_url = format!("http://{}:{}", client_host(&config.host), config.port);
    let health = probe_daemon(config).await;
    let daemon_running = health.is_some();
    let daemon_version = health
        .as_ref()
        .and_then(|health| health.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if daemon_running && daemon_version.as_deref() != Some(cockpit_core::VERSION) {
        warnings.push(format!(
            "the daemon at {daemon_url} is not this Cockpit version"
        ));
    }

    Diagnostics {
        version: cockpit_core::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: config.home.display().to_string(),
        database_path: config.database_path.display().to_string(),
        database_exists,
        database_ok,
        sessions,
        active_sessions,
        steps,
        daemon_url,
        daemon_running,
        daemon_version,
        adapters_total: statuses.len(),
        adapters_installed,
        adapters_verified,
        adapter_issues: registry.issues().to_vec(),
        log_watch_enabled: config.log_watch,
        log_watch_files,
        log_watch_records,
        warnings,
    }
}

async fn doctor(config: Config, as_json: bool) -> anyhow::Result<()> {
    let diagnostics = collect_diagnostics(&config).await;

    if as_json {
        println!("{}", serde_json::to_string_pretty(&diagnostics)?);
        return Ok(());
    }

    println!("Cockpit doctor {}", diagnostics.version);
    println!("  home        {}", diagnostics.home);
    if diagnostics.database_exists {
        println!(
            "  database    {} · {} flights · {} steps{}",
            if diagnostics.database_ok {
                "ok"
            } else {
                "unavailable"
            },
            diagnostics.sessions,
            diagnostics.steps,
            if diagnostics.active_sessions > 0 {
                format!(" · {} active", diagnostics.active_sessions)
            } else {
                String::new()
            }
        );
    } else {
        println!("  database    not created yet");
    }
    if diagnostics.daemon_running {
        println!(
            "  daemon      running at {} ({})",
            diagnostics.daemon_url,
            diagnostics
                .daemon_version
                .as_deref()
                .unwrap_or("unknown version")
        );
    } else {
        println!("  daemon      not running at {}", diagnostics.daemon_url);
    }
    println!(
        "  adapters    {} total · {} installed · {} verified",
        diagnostics.adapters_total, diagnostics.adapters_installed, diagnostics.adapters_verified
    );
    println!(
        "  log watch   {} · {} files · {} records",
        if diagnostics.log_watch_enabled {
            "enabled"
        } else {
            "disabled"
        },
        diagnostics.log_watch_files,
        diagnostics.log_watch_records
    );

    if !diagnostics.warnings.is_empty() {
        println!("\nWarnings");
        for warning in &diagnostics.warnings {
            println!("  · {warning}");
        }
    }

    Ok(())
}

async fn report(config: Config, args: ReportArgs) -> anyhow::Result<()> {
    let diagnostics = collect_diagnostics(&config).await;
    let registry = adapters::load_registry(&config.home);
    let body = if args.json {
        serde_json::to_string_pretty(&diagnostics)?
    } else {
        render_markdown_report(&diagnostics, &registry)
    };

    match args.output {
        Some(path) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            std::fs::write(&path, body)
                .with_context(|| format!("could not write {}", path.display()))?;
            println!("Wrote {}", path.display());
        }
        None => print!("{body}"),
    }
    Ok(())
}

fn render_markdown_report(diagnostics: &Diagnostics, registry: &AdapterRegistry) -> String {
    use std::fmt::Write;

    let mut output = String::new();
    let _ = writeln!(output, "# Cockpit report\n");
    let _ = writeln!(output, "- Version: {}", diagnostics.version);
    let _ = writeln!(
        output,
        "- Platform: {} {}",
        diagnostics.os, diagnostics.arch
    );
    let _ = writeln!(output, "- Home: `{}`", diagnostics.home);
    let _ = writeln!(output, "- Database: `{}`", diagnostics.database_path);
    let _ = writeln!(
        output,
        "- Flights: {} ({} active), {} steps",
        diagnostics.sessions, diagnostics.active_sessions, diagnostics.steps
    );
    let _ = writeln!(
        output,
        "- Daemon: {}",
        if diagnostics.daemon_running {
            format!(
                "running at {} ({})",
                diagnostics.daemon_url,
                diagnostics
                    .daemon_version
                    .as_deref()
                    .unwrap_or("unknown version")
            )
        } else {
            format!("not running at {}", diagnostics.daemon_url)
        }
    );
    let _ = writeln!(
        output,
        "- Log watch: {} · {} files · {} records\n",
        if diagnostics.log_watch_enabled {
            "enabled"
        } else {
            "disabled"
        },
        diagnostics.log_watch_files,
        diagnostics.log_watch_records
    );

    let _ = writeln!(output, "## Adapters\n");
    let _ = writeln!(output, "| Adapter | Installed | Verified | Capture |");
    let _ = writeln!(output, "| --- | --- | --- | --- |");
    for adapter in registry.all() {
        let status = adapters::status_for(adapter);
        let capture = adapter
            .capture
            .iter()
            .map(|mode| match mode {
                cockpit_core::model::CaptureMode::Proxy => "proxy",
                cockpit_core::model::CaptureMode::LogWatch => "log-watch",
                cockpit_core::model::CaptureMode::HookOtel => "hook",
            })
            .collect::<Vec<_>>()
            .join(", ");
        let _ = writeln!(
            output,
            "| {} | {} | {} | {} |",
            adapter.name,
            if status.installed { "yes" } else { "no" },
            if adapter.verified { "yes" } else { "no" },
            capture
        );
    }

    if !diagnostics.adapter_issues.is_empty() {
        let _ = writeln!(output, "\n## Adapter issues\n");
        for issue in &diagnostics.adapter_issues {
            let _ = writeln!(output, "- `{}`: {}", issue.source, issue.message);
        }
    }
    if !diagnostics.warnings.is_empty() {
        let _ = writeln!(output, "\n## Warnings\n");
        for warning in &diagnostics.warnings {
            let _ = writeln!(output, "- {warning}");
        }
    }

    output
}

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

async fn pair(config: Config, args: PairArgs) -> anyhow::Result<()> {
    if config.port == 0 {
        bail!(
            "pairing needs a running daemon on a known port; start `cockpit serve --port <port>` first"
        );
    }
    let base = format!("http://{}:{}", client_host(&config.host), config.port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .context("could not create the HTTP client")?;

    if let Some(code) = args.claim {
        let response = client
            .post(format!("{base}/api/pair/claim"))
            .json(&json!({
                "code": code,
                "deviceName": args.device_name,
            }))
            .send()
            .await
            .context("could not reach the Cockpit daemon")?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("the daemon returned an unreadable response")?;
        if !status.is_success() {
            bail!(
                "{}",
                body.pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("pairing failed")
            );
        }
        if args.json {
            println!("{}", serde_json::to_string_pretty(&body)?);
        } else {
            println!(
                "Paired{}. Device token (shown once):\n{}",
                body.get("deviceName")
                    .and_then(Value::as_str)
                    .map(|name| format!(" with {name}"))
                    .unwrap_or_default(),
                body.get("token")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            );
        }
        return Ok(());
    }

    let response = client
        .post(format!("{base}/api/pair/code"))
        .send()
        .await
        .context("could not reach the Cockpit daemon")?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .context("the daemon returned an unreadable response")?;
    if !status.is_success() {
        bail!(
            "{}",
            body.pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("could not issue a pairing code")
        );
    }

    if args.json {
        println!("{}", serde_json::to_string_pretty(&body)?);
    } else {
        println!(
            "Pairing code: {}\nExpires in {} seconds. Claim it with `cockpit pair --claim {}`.",
            body.get("code").and_then(Value::as_str).unwrap_or_default(),
            body.get("expiresInSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(300),
            body.get("code").and_then(Value::as_str).unwrap_or_default()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cockpit_core::adapter::ProxySpec;
    use cockpit_core::model::CaptureMode;
    use std::net::{IpAddr, Ipv4Addr};

    fn adapter() -> Adapter {
        Adapter {
            schema_version: 1,
            id: "example".to_string(),
            name: "Example Agent".to_string(),
            verified: false,
            docs_url: "https://example.com/docs".to_string(),
            capture: vec![CaptureMode::Proxy],
            detect: cockpit_core::adapter::Detect {
                command: "example".to_string(),
                version_args: Vec::new(),
            },
            proxy: Some(ProxySpec {
                protocols: vec![AdapterProtocol::OpenaiChat],
                base_url_env: vec!["OPENAI_BASE_URL".to_string()],
                api_key_env: vec!["OPENAI_API_KEY".to_string()],
                setup_note: String::new(),
                verified: false,
            }),
            log_watch: None,
            hook_otel: None,
        }
    }

    #[test]
    fn a_custom_home_moves_the_default_database() {
        let config = Config::for_home("default-home");
        let args = ServeArgs {
            home: Some(PathBuf::from("elsewhere")),
            ..ServeArgs::default()
        };

        let config = args.apply(config, false);

        assert_eq!(config.home, PathBuf::from("elsewhere"));
        assert_eq!(
            config.database_path,
            PathBuf::from("elsewhere").join("cockpit.db")
        );
    }

    #[test]
    fn an_explicit_database_wins_over_the_home() {
        let config = Config::for_home("default-home");
        let args = ServeArgs {
            home: Some(PathBuf::from("elsewhere")),
            database: Some(PathBuf::from("custom.db")),
            ..ServeArgs::default()
        };

        let config = args.apply(config, false);

        assert_eq!(config.database_path, PathBuf::from("custom.db"));
    }

    #[test]
    fn proxy_environment_uses_the_local_sentinel() {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4319);
        let environment = proxy_environment(&adapter(), address);
        assert_eq!(
            environment,
            vec![
                (
                    "OPENAI_BASE_URL".to_string(),
                    "http://127.0.0.1:4319/v1".to_string()
                ),
                ("OPENAI_API_KEY".to_string(), PROXY_KEY_SENTINEL.to_string()),
            ]
        );
    }

    #[test]
    fn adapters_are_found_by_executable_name() {
        let registry = AdapterRegistry::new(vec![adapter()], Vec::new());
        assert_eq!(find_adapter(&registry, "example").unwrap().id, "example");
        assert_eq!(
            find_adapter(&registry, "Example Agent").unwrap().id,
            "example"
        );
        assert!(find_adapter(&registry, "missing").is_none());
    }
}
