//! The `pandu` command-line entry point.
//!
//! `pandu serve` (the default) runs the daemon. `pandu run -- <agent>`
//! starts a daemon if needed, points the agent at the local proxy, and runs it.
//! `pandu doctor` and `pandu report` are local, read-only diagnostics, and
//! `pandu pair` issues a short-lived code for the phone companion.

use std::io::{IsTerminal, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};
use pandu_core::adapter::{Adapter, AdapterIssue, AdapterProtocol, AdapterRegistry};
use pandu_core::brand;
use pandu_daemon::Config;
use pandu_daemon::ServerHandle;
use pandu_daemon::adapters;
use pandu_daemon::config::PROXY_KEY_SENTINEL;
use pandu_daemon::logwatch;
use pandu_daemon::store::Store;
use serde::Serialize;
use serde_json::{Value, json};
use tracing_subscriber::EnvFilter;

mod pty;
mod updater;

#[derive(Debug, Parser)]
#[command(name = brand::CLI_COMMAND, version, about = brand::TAGLINE)]
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
    /// `pandu run -- claude`.
    Run(RunArgs),
    /// Check the database, adapters, log watcher, and running daemon.
    Doctor(DoctorArgs),
    /// Write a local diagnostic report. Nothing is uploaded.
    Report(ReportArgs),
    /// Issue a pairing code for the phone companion.
    Pair(PairArgs),
    /// Inspect and verify the local audit log.
    Audit(AuditArgs),
    /// Inspect the bundled model registry.
    Models(ModelsArgs),
    /// Maintain the signed skill and MCP registry. Maintainer tooling only.
    Market(MarketArgs),
    /// Check for and install a verified update. Never runs in the background.
    Update(UpdateArgs),
    /// Restore the binary kept by the last update.
    Rollback(RollbackArgs),
    /// Write a local backup of the database and settings.
    Backup(BackupArgs),
    /// Restore a local backup. Remote access is off afterwards.
    Restore(RestoreArgs),
}

#[derive(Debug, Args, Default, Clone)]
struct ServeArgs {
    /// Interface to bind, for example 127.0.0.1.
    #[arg(long)]
    host: Option<String>,
    /// Port to bind. Use 0 to ask the operating system for a free port.
    #[arg(long)]
    port: Option<u16>,
    /// Directory for the database and future Pandu state.
    #[arg(long)]
    home: Option<PathBuf>,
    /// SQLite database path. Defaults to <home>/pandu.db.
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
            config.database_path = home.join(brand::DATABASE_FILE);
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
    /// Directory for the database and Pandu state.
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
    /// Directory for the database and Pandu state.
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
    /// Remote listener URL from the pairing QR, used with --claim.
    #[arg(long, value_name = "URL")]
    url: Option<String>,
    /// Pairing PIN for high-risk approvals, used with --claim.
    #[arg(long, value_name = "PIN")]
    pin: Option<String>,
    /// Four-digit code shown to the host, used with --claim. Generated when omitted.
    #[arg(long = "verification-code", value_name = "CODE")]
    verification_code: Option<String>,
    /// Print JSON instead of a human-readable summary.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct AuditArgs {
    #[command(subcommand)]
    action: AuditAction,
}

#[derive(Debug, Subcommand)]
enum AuditAction {
    /// Verify every audit entry against its hash and the previous entry.
    Verify(AuditVerifyArgs),
}

#[derive(Debug, Args, Default)]
struct AuditVerifyArgs {
    /// Directory for the database and Pandu state.
    #[arg(long)]
    home: Option<PathBuf>,
    /// SQLite database path. Defaults to <home>/pandu.db.
    #[arg(long)]
    database: Option<PathBuf>,
    /// Print JSON instead of a human-readable summary.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct ModelsArgs {
    #[command(subcommand)]
    action: ModelsAction,
}

#[derive(Debug, Subcommand)]
enum ModelsAction {
    /// Fail when a bundled model row lacks control type, source, verifiedOn,
    /// or price evidence.
    Audit(ModelsAuditArgs),
}

#[derive(Debug, Args, Default)]
struct ModelsAuditArgs {
    /// Print JSON instead of a human-readable summary.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct MarketArgs {
    #[command(subcommand)]
    action: MarketAction,
}

#[derive(Debug, Subcommand)]
enum MarketAction {
    /// Generate an Ed25519 keypair for signing the registry.
    Keygen(MarketKeygenArgs),
    /// Sign the active registry variant in a directory. Debug builds sign
    /// index.test.json/revoked.test.json with the test key; release builds sign
    /// index.json/revoked.json with the production key.
    Sign(MarketSignArgs),
    /// Validate a registry directory, its signatures, hashes, and files.
    Check(MarketCheckArgs),
}

#[derive(Debug, Args)]
struct MarketKeygenArgs {
    /// Write the private key here. Keep it offline; never commit it.
    #[arg(long, value_name = "PATH")]
    out: PathBuf,
    /// Overwrite an existing key file.
    #[arg(long)]
    force: bool,
}

#[derive(Debug, Args)]
struct MarketSignArgs {
    /// Private signing key written by `pandu market keygen`.
    #[arg(long, value_name = "PATH")]
    key: PathBuf,
    /// Registry directory. Defaults to ./registry.
    #[arg(long, value_name = "PATH", default_value = "registry")]
    dir: PathBuf,
}

#[derive(Debug, Args)]
struct MarketCheckArgs {
    /// Registry directory. Defaults to ./registry.
    #[arg(long, value_name = "PATH", default_value = "registry")]
    dir: PathBuf,
    /// Download pinned sources and verify their content hashes. Without this,
    /// only the signed index, schema, and local example fixtures are checked.
    #[arg(long)]
    online: bool,
    /// Validate loose skills/*.yaml and mcp/*.yaml files without requiring a
    /// signed index. Use this on contributor pull requests; publication still
    /// requires re-signing the index.
    #[arg(long)]
    staged: bool,
    /// Also check source and homepage links. Implies --online.
    #[arg(long)]
    links: bool,
    /// Print JSON instead of a human-readable report.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args, Default)]
struct UpdateArgs {
    /// Only check for an update. Do not download or install anything.
    #[arg(long)]
    check: bool,
    /// Install even when agent sessions are running.
    #[arg(long, short = 'y')]
    yes: bool,
    /// Print JSON instead of a human-readable summary.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args, Default)]
struct RollbackArgs {
    /// Print JSON instead of a human-readable summary.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args, Default)]
struct BackupArgs {
    /// Directory for the database and Pandu state.
    #[arg(long)]
    home: Option<PathBuf>,
    /// SQLite database path. Defaults to <home>/pandu.db.
    #[arg(long)]
    database: Option<PathBuf>,
    /// Write the archive here. Defaults to <home>/backups/<name>-backup-<time>.tar.gz.
    #[arg(long, value_name = "PATH")]
    output: Option<PathBuf>,
    /// Encrypt the archive with XChaCha20-Poly1305 and an Argon2id key.
    /// Reads the passphrase from a terminal prompt, or from
    /// PANDU_BACKUP_PASSPHRASE for non-interactive use.
    #[arg(long)]
    encrypt: bool,
    /// Include remote device tokens in the archive. The archive becomes
    /// sensitive; keep it private.
    #[arg(long = "include-remote")]
    include_remote: bool,
    /// Print JSON instead of a human-readable summary.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct RestoreArgs {
    /// The backup archive to restore.
    #[arg(value_name = "ARCHIVE")]
    archive: PathBuf,
    /// Directory for the database and Pandu state.
    #[arg(long)]
    home: Option<PathBuf>,
    /// SQLite database path. Defaults to <home>/pandu.db.
    #[arg(long)]
    database: Option<PathBuf>,
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

    let config = Config::load()
        .with_context(|| format!("could not read {} configuration", brand::PRODUCT_NAME))?;

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
        Command::Audit(args) => match args.action {
            AuditAction::Verify(args) => {
                let config = apply_local_args(config, args.home, None, None);
                audit_verify(config, args.database, args.json)
            }
        },
        Command::Models(args) => match args.action {
            ModelsAction::Audit(args) => models_audit(args),
        },
        Command::Market(args) => match args.action {
            MarketAction::Keygen(args) => market_keygen(args),
            MarketAction::Sign(args) => market_sign(args),
            MarketAction::Check(args) => market_check(args),
        },
        Command::Update(args) => runtime()?.block_on(run_update(config, args)),
        Command::Rollback(args) => run_rollback(args),
        Command::Backup(args) => run_backup(config, args),
        Command::Restore(args) => runtime()?.block_on(run_restore(config, args)),
    }
}

fn run_daemon(config: Config) -> anyhow::Result<()> {
    runtime()?.block_on(async move {
        pandu_daemon::run(config)
            .await
            .with_context(|| format!("the {} daemon stopped with an error", brand::PRODUCT_NAME))
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
        config.database_path = home.join(brand::DATABASE_FILE);
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
// market
// ---------------------------------------------------------------------------

fn market_keygen(args: MarketKeygenArgs) -> anyhow::Result<()> {
    if args.out.exists() && !args.force {
        bail!(
            "{} already exists. Pass --force to overwrite it.",
            args.out.display()
        );
    }
    let (public, private) = pandu_daemon::market::signing::generate();
    pandu_daemon::market::signing::save_signing_key(&args.out, &private)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    println!("public key: {public}");
    println!("private key: {}", args.out.display());
    println!(
        "Keep the private key offline. Embed the public key in \
         crates/pandu-daemon/src/market/mod.rs before publishing a registry."
    );
    Ok(())
}

fn market_sign(args: MarketSignArgs) -> anyhow::Result<()> {
    use pandu_daemon::market::{ACTIVE_INDEX_FILE, ACTIVE_REVOKED_FILE};
    let key = pandu_daemon::market::signing::load_signing_key(&args.key)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let public = pandu_daemon::market::signing::public_key_base64(&key);
    let Some(expected) = pandu_daemon::market::REGISTRY_PUBLIC_KEY_BASE64 else {
        bail!(
            "This build embeds no production registry key. Generate the key offline and set \
             PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64 before signing a production registry."
        );
    };
    if public != expected {
        bail!(
            "This key's public half is {public}, but {} embeds {expected}. \
             Signing with it would produce a registry every {} refuses.",
            brand::PRODUCT_NAME,
            brand::PRODUCT_NAME
        );
    }
    pandu_daemon::market::signing::sign_registry_dir(&args.dir, &key)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    println!(
        "signed {}/{ACTIVE_INDEX_FILE} and {}/{ACTIVE_REVOKED_FILE} with {public}",
        args.dir.display(),
        args.dir.display()
    );
    Ok(())
}

fn market_check(args: MarketCheckArgs) -> anyhow::Result<()> {
    use pandu_daemon::market::registry_check;

    let online = args.online || args.links;
    let report = if args.staged {
        if online {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(30))
                .build()
                .context("could not build the registry HTTP client")?;
            let runtime = runtime()?;
            runtime.block_on(registry_check::check_staged(&args.dir, &client, args.links))
        } else {
            registry_check::check_staged_offline(&args.dir)
        }
    } else if online {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .build()
            .context("could not build the registry HTTP client")?;
        let runtime = runtime()?;
        runtime.block_on(registry_check::check_registry(
            &args.dir, &client, args.links,
        ))
    } else {
        registry_check::check_registry_offline(&args.dir)
    }
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", registry_check::report_text(&report));
    }
    if !report.ok {
        bail!("the registry check failed");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// update, rollback, backup, restore
// ---------------------------------------------------------------------------

async fn run_update(config: Config, args: UpdateArgs) -> anyhow::Result<()> {
    if !args.check {
        confirm_running_sessions(&config, args.yes).await?;
    }
    let outcome = updater::run(args.check).await?;
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&updater::outcome_json(&outcome))?
        );
    } else {
        updater::print_outcome(&outcome);
    }
    Ok(())
}

/// Pandu does not stop PTY sessions to install an update. Tell the user exactly
/// what is running and ask before replacing the binary.
async fn confirm_running_sessions(config: &Config, assume_yes: bool) -> anyhow::Result<()> {
    let url = format!("{}/api/overview", daemon_base_url(config));
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return Ok(());
    };
    let Ok(response) = client.get(&url).send().await else {
        return Ok(());
    };
    if !response.status().is_success() {
        return Ok(());
    }
    let Ok(body) = response.json::<Value>().await else {
        return Ok(());
    };
    let sessions = body
        .get("activeSessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if sessions.is_empty() {
        return Ok(());
    }

    eprintln!(
        "warning: {} Pandu-owned agent session(s) are running:",
        sessions.len()
    );
    for line in active_session_summary(&sessions).lines() {
        eprintln!("  {line}");
    }
    eprintln!(
        "Pandu will not stop them. The update replaces the binary on disk, and a \
         running session keeps using the old build until it exits."
    );
    if cfg!(windows) {
        eprintln!(
            "Windows may refuse to replace a binary that is still running. If the \
             update stops, close the sessions and try again."
        );
    }
    if assume_yes {
        eprintln!("Continuing because --yes was passed.");
        return Ok(());
    }
    if std::io::stdin().is_terminal() {
        eprint!("Continue and install the update? [y/N] ");
        std::io::stderr().flush()?;
        let mut answer = String::new();
        std::io::stdin().read_line(&mut answer)?;
        if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            return Ok(());
        }
        bail!("Update cancelled. Nothing was installed.");
    }
    bail!(
        "Refusing to update while agents are running. Stop the sessions, or re-run \
         with --yes to continue."
    );
}

fn active_session_summary(sessions: &[Value]) -> String {
    sessions
        .iter()
        .take(5)
        .map(|session| {
            let title = session
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or("Untitled session");
            let agent = session
                .get("agent")
                .and_then(|agent| agent.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|agent| !agent.is_empty());
            match agent {
                Some(agent) => format!("- {title} ({agent})"),
                None => format!("- {title}"),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_rollback(args: RollbackArgs) -> anyhow::Result<()> {
    let previous = updater::rollback()?;
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "rolledBack": true,
                "previousBinary": previous.display().to_string(),
            }))?
        );
    } else {
        println!("Restored the previous binary from {}.", previous.display());
        println!("Start {} again to use it.", brand::PRODUCT_NAME);
    }
    Ok(())
}

fn run_backup(mut config: Config, args: BackupArgs) -> anyhow::Result<()> {
    let BackupArgs {
        home,
        database,
        output,
        encrypt,
        include_remote,
        json: as_json,
    } = args;
    if let Some(home) = home {
        config.database_path = home.join(brand::DATABASE_FILE);
        config.home = home;
    }
    let database = database.unwrap_or_else(|| config.database_path.clone());
    let passphrase = if encrypt {
        Some(read_backup_passphrase(true)?)
    } else {
        None
    };
    let output =
        output.unwrap_or_else(|| pandu_daemon::backup::default_backup_path(&config.home, encrypt));
    if include_remote {
        eprintln!(
            "warning: this backup includes remote device tokens and pairing data. \
             Keep the archive private."
        );
    }
    eprintln!(
        "note: the archive contains flight history: prompts, responses, tool output, \
         and code snapshots."
    );
    let summary = pandu_daemon::backup::create_backup(
        &database,
        &output,
        include_remote,
        passphrase.as_deref(),
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if as_json {
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        println!("Backup written to {}.", summary.path);
        println!(
            "{} settings, database schema v{}, {:.1} MiB.",
            summary.settings_count,
            summary.database_schema,
            summary.bytes as f64 / (1024.0 * 1024.0)
        );
        if summary.encrypted {
            println!("The archive is encrypted. Keep the passphrase safe.");
        }
        if summary.include_remote {
            println!("Remote device tokens are included. Keep this archive private.");
        } else {
            println!("Remote device tokens and secret settings are not included.");
        }
        println!("The archive is readable only by your user account.");
    }
    Ok(())
}

/// Read a backup passphrase from the environment or an interactive terminal.
/// The passphrase is never placed in argv and never logged.
fn read_backup_passphrase(confirm: bool) -> anyhow::Result<String> {
    let env_name = brand::env_name("BACKUP_PASSPHRASE");
    if let Ok(value) = std::env::var(&env_name) {
        if value.is_empty() {
            bail!("{env_name} is set but empty.");
        }
        return Ok(value);
    }
    let passphrase = rpassword::prompt_password("Backup passphrase: ").map_err(|error| {
        anyhow::anyhow!(
            "could not read a passphrase from the terminal: {error}. \
             Set {env_name} for non-interactive use."
        )
    })?;
    if passphrase.is_empty() {
        bail!("the passphrase is empty.");
    }
    if confirm {
        let repeated = rpassword::prompt_password("Repeat passphrase: ")?;
        if repeated != passphrase {
            bail!("the passphrases do not match.");
        }
    }
    Ok(passphrase)
}

async fn run_restore(mut config: Config, args: RestoreArgs) -> anyhow::Result<()> {
    let RestoreArgs {
        archive,
        home,
        database,
        json: as_json,
    } = args;
    if let Some(home) = home {
        config.database_path = home.join(brand::DATABASE_FILE);
        config.home = home;
    }
    let database = database.unwrap_or_else(|| config.database_path.clone());
    if daemon_is_running(&config).await {
        bail!(
            "{} is running. Stop it before restoring a backup, then try again.",
            brand::PRODUCT_NAME
        );
    }
    let passphrase = if archive.exists()
        && pandu_daemon::backup::is_encrypted_archive(&archive)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
    {
        Some(read_backup_passphrase(false)?)
    } else {
        None
    };
    let summary = pandu_daemon::backup::restore_backup(&archive, &database, passphrase.as_deref())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if as_json {
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        println!("Restored {} from {}.", summary.database, summary.archive);
        println!(
            "{} settings, database schema v{}.",
            summary.settings_count, summary.database_schema
        );
        if let Some(previous) = &summary.pre_restore_backup {
            println!("The database before the restore is at {previous}.");
        }
        println!("Remote access is off. Pair your phone again if you need it.");
    }
    Ok(())
}

async fn daemon_is_running(config: &Config) -> bool {
    let url = format!("{}/health", daemon_base_url(config));
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    let Ok(response) = client.get(&url).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(body) = response.json::<Value>().await else {
        return false;
    };
    body.get("version").is_some() && body.get("database").is_some()
}

fn daemon_base_url(config: &Config) -> String {
    let host = match config.host.as_str() {
        "0.0.0.0" => "127.0.0.1".to_string(),
        "::" | "[::]" => "::1".to_string(),
        other => other.to_string(),
    };
    let authority = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    format!("http://{authority}:{}", config.port)
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

fn audit_verify(config: Config, database: Option<PathBuf>, as_json: bool) -> anyhow::Result<()> {
    let path = database.unwrap_or(config.database_path);
    verify_audit_database(&path, as_json)
}

fn verify_audit_database(path: &Path, as_json: bool) -> anyhow::Result<()> {
    let store = Store::open(path).with_context(|| format!("could not open {}", path.display()))?;
    let report = store
        .verify_remote_audit_chain()
        .context("could not verify the audit log")?;

    if as_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "database": path.display().to_string(),
                "entries": report.entries,
                "valid": report.valid,
                "brokenAt": report.broken_at.as_deref(),
                "reason": report.reason.as_deref(),
            }))?
        );
    } else if report.valid {
        println!(
            "Audit log verified: {} entries, hash chain intact ({}).",
            report.entries,
            path.display()
        );
    } else {
        println!(
            "Audit log FAILED verification at entry {} ({}).",
            report.broken_at.as_deref().unwrap_or("unknown"),
            path.display()
        );
        if let Some(reason) = &report.reason {
            println!("{reason}.");
        }
    }

    if !report.valid {
        bail!("the audit log hash chain is broken");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

fn models_audit(args: ModelsAuditArgs) -> anyhow::Result<()> {
    let rows = pandu_core::cost::BUILT_IN_PRICING.len();
    let issues = pandu_core::cost::audit_built_in_pricing();
    let deprecated_without_date = pandu_core::cost::BUILT_IN_PRICING
        .iter()
        .filter(|row| row.deprecated && row.verified_on.is_none())
        .count();

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "rows": rows,
                "deprecatedWithoutVerifiedOn": deprecated_without_date,
                "issues": issues,
            }))?
        );
    } else if issues.is_empty() {
        println!(
            "Model registry verified: {rows} rows, every row has a control type, source, \
             and price evidence ({deprecated_without_date} deprecated without a verification date)."
        );
    } else {
        for issue in &issues {
            eprintln!("{} {}: {}", issue.provider, issue.model, issue.issue);
        }
        eprintln!(
            "Model registry FAILED: {} issue(s) in {rows} rows.",
            issues.len()
        );
    }

    if !issues.is_empty() {
        bail!("the model registry audit failed");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

enum Daemon {
    External,
    Owned(Box<ServerHandle>),
}

async fn run_agent(config: Config, args: RunArgs) -> anyhow::Result<()> {
    let registry = adapters::load_registry(&config.home);
    let program = args
        .agent
        .first()
        .with_context(|| {
            format!(
                "give an agent command after `--`, for example: {} run -- claude",
                brand::CLI_COMMAND
            )
        })?
        .clone();
    let adapter = find_adapter(&registry, &program).cloned();
    let (daemon, addr) = ensure_daemon(&config).await?;

    let environment = adapter
        .as_ref()
        .map(|adapter| proxy_environment(adapter, addr))
        .unwrap_or_default();

    println!(
        "{} {} recording on http://{addr}",
        brand::PRODUCT_NAME,
        pandu_core::VERSION
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

    let (program, arguments) = resolve_agent_command(&args.agent);
    let agent_name = adapter
        .as_ref()
        .map(|adapter| adapter.name.clone())
        .unwrap_or_else(|| {
            Path::new(&program)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(&program)
                .to_string()
        });
    let adapter_id = adapter
        .as_ref()
        .map(|adapter| adapter.id.clone())
        .unwrap_or_else(|| agent_name.clone());

    let outcome = pty::run(pty::PtyRequest {
        program: &program,
        args: &arguments,
        env: &environment,
        agent_name: &agent_name,
        adapter_id: &adapter_id,
        addr,
    })
    .await;

    if let Daemon::Owned(handle) = daemon {
        handle.shutdown().await?;
    }

    let outcome = outcome?;
    match outcome.exit_code {
        Some(0) => Ok(()),
        Some(code) => std::process::exit(code),
        None if outcome.killed => std::process::exit(130),
        None => bail!("`{program}` ended without an exit code"),
    }
}

async fn ensure_daemon(config: &Config) -> anyhow::Result<(Daemon, SocketAddr)> {
    if let Some(health) = probe_daemon(config).await {
        let version = health
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if version != pandu_core::VERSION {
            bail!(
                "port {} is serving {} {version}, but this CLI is {}. \
                 Start the new daemon on another port with --port.",
                config.port,
                brand::PRODUCT_NAME,
                pandu_core::VERSION
            );
        }
        let addr = daemon_addr(config)?;
        return Ok((Daemon::External, addr));
    }

    let handle = pandu_daemon::spawn(config.clone())
        .await
        .with_context(|| format!("could not start the {} daemon", brand::PRODUCT_NAME))?;
    let addr = handle.addr;
    Ok((Daemon::Owned(Box::new(handle)), addr))
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

/// Resolve the user's command to an executable path. Windows `.cmd`/`.bat`
/// shims (how npm and most agent CLIs install themselves) must run through
/// `cmd /C`; nothing else is ever added to the command.
fn resolve_agent_command(agent: &[String]) -> (String, Vec<String>) {
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
                let mut arguments = vec!["/C".to_string(), path.display().to_string()];
                arguments.extend(agent[1..].iter().cloned());
                return ("cmd".to_string(), arguments);
            }
        }
    }

    let program = resolved
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| program.clone());
    (program, agent[1..].to_vec())
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
        warnings.push(format!(
            "the database does not exist yet; start the daemon or run `{} demo` once",
            brand::CLI_COMMAND
        ));
    }

    let registry = adapters::load_registry(&config.home);
    let statuses = adapters::statuses(&registry);
    let adapters_installed = statuses.iter().filter(|status| status.installed).count();
    let adapters_verified = statuses.iter().filter(|status| status.verified).count();
    if adapters_verified < statuses.len() {
        warnings.push(format!(
            "{} of {} adapters are unverified; run `{} doctor` after checking vendor docs",
            statuses.len() - adapters_verified,
            statuses.len(),
            brand::CLI_COMMAND
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
    if daemon_running && daemon_version.as_deref() != Some(pandu_core::VERSION) {
        warnings.push(format!(
            "the daemon at {daemon_url} is not this {} version",
            brand::PRODUCT_NAME
        ));
    }

    Diagnostics {
        version: pandu_core::VERSION.to_string(),
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

    println!("{} doctor {}", brand::PRODUCT_NAME, diagnostics.version);
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
    let _ = writeln!(output, "# {} report\n", brand::PRODUCT_NAME);
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
                pandu_core::model::CaptureMode::Proxy => "proxy",
                pandu_core::model::CaptureMode::LogWatch => "log-watch",
                pandu_core::model::CaptureMode::HookOtel => "hook",
                pandu_core::model::CaptureMode::Pty => "pty",
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

/// Fetch the per-process token that every state-changing host request needs.
/// The token is only served by the loopback listener; a remote page cannot
/// read it because its origin is not in the CORS allowlist.
pub(crate) async fn host_csrf(client: &reqwest::Client, base: &str) -> anyhow::Result<String> {
    let response = client
        .get(format!("{base}/api/csrf"))
        .send()
        .await
        .with_context(|| format!("could not reach the {} daemon", brand::PRODUCT_NAME))?;
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
                .unwrap_or("could not obtain a CSRF token")
        );
    }
    body.get("token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .context("the daemon did not return a CSRF token")
}

async fn pair(config: Config, args: PairArgs) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("could not create the HTTP client")?;

    if let Some(code) = args.claim {
        // Device side: the URL comes from the host's QR code. Fall back to the
        // default remote port on this machine for local testing.
        let base = args
            .url
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", config.remote_port))
            .trim_end_matches('/')
            .to_string();
        let device_name = args
            .device_name
            .clone()
            .unwrap_or_else(|| format!("{} CLI", brand::PRODUCT_NAME));
        let verification_code = args
            .verification_code
            .clone()
            .unwrap_or_else(|| format!("{:04}", rand::random::<u16>() % 10_000));
        eprintln!(
            "Verification code: {verification_code}\nCompare this code with the host before it confirms."
        );
        let response = client
            .post(format!("{base}/api/remote/pair/claim"))
            .json(&json!({
                "code": code,
                "deviceName": device_name,
                "pin": args.pin,
                "verificationCode": verification_code,
            }))
            .send()
            .await
            .with_context(|| {
                format!(
                    "could not reach the {} remote listener",
                    brand::PRODUCT_NAME
                )
            })?;
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
        let claim_id = body
            .get("claimId")
            .and_then(Value::as_str)
            .context("the daemon did not return a claim id")?
            .to_string();
        let claim_secret = body
            .get("claimSecret")
            .and_then(Value::as_str)
            .context("the daemon did not return a claim secret")?
            .to_string();
        let expires = body
            .get("expiresInSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(90);
        eprintln!("Waiting for the host to confirm this device (up to {expires}s)...");
        let deadline = std::time::Instant::now() + Duration::from_secs(expires + 5);
        loop {
            let response = client
                .post(format!("{base}/api/remote/pair/claim/{claim_id}"))
                .header("x-pairing-secret", &claim_secret)
                .send()
                .await
                .with_context(|| {
                    format!(
                        "could not reach the {} remote listener",
                        brand::PRODUCT_NAME
                    )
                })?;
            let status = response.status();
            let poll: Value = response
                .json()
                .await
                .context("the daemon returned an unreadable response")?;
            if !status.is_success() {
                bail!(
                    "{}",
                    poll.pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("pairing failed")
                );
            }
            match poll.get("status").and_then(Value::as_str) {
                Some("confirmed") => {
                    let token = poll
                        .get("token")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if args.json {
                        println!("{}", serde_json::to_string_pretty(&poll)?);
                    } else {
                        println!(
                            "Paired with {}. Device token (shown once, keep it secret):\n{token}",
                            brand::PRODUCT_NAME
                        );
                    }
                    return Ok(());
                }
                Some("denied") => bail!("The host denied this pairing request."),
                Some("expired") => {
                    bail!("The pairing request expired. Ask the host for a new code.")
                }
                _ => {}
            }
            if std::time::Instant::now() > deadline {
                bail!("The host did not confirm in time. Ask for a new pairing code.");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    // Host side: issue a code through the loopback listener.
    if config.port == 0 {
        bail!(
            "pairing needs a running daemon on a known port; start `{} serve --port <port>` first",
            brand::CLI_COMMAND
        );
    }
    let base = format!("http://{}:{}", client_host(&config.host), config.port);
    let csrf = host_csrf(&client, &base).await?;
    let response = client
        .post(format!("{base}/api/remote/pair/code"))
        .header("origin", &base)
        .header(pandu_core::brand::CSRF_HEADER, &csrf)
        .header("content-type", "application/json")
        .send()
        .await
        .with_context(|| format!("could not reach the {} daemon", brand::PRODUCT_NAME))?;
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
        let code = body.get("code").and_then(Value::as_str).unwrap_or_default();
        println!(
            "Pairing code: {code}\nExpires in {} seconds.\nRemote URL: {}\nEnter the code on the device, then confirm the device in Settings > Remote access on this computer.",
            body.get("expiresInSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(120),
            body.get("url").and_then(Value::as_str).unwrap_or_default(),
        );
        if let Some(fingerprint) = body.get("fingerprint").and_then(Value::as_str) {
            println!("TLS fingerprint: {fingerprint}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use pandu_core::adapter::ProxySpec;
    use pandu_core::model::CaptureMode;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn the_cli_name_comes_from_the_brand() {
        assert_eq!(Cli::command().get_name(), brand::CLI_COMMAND);
    }

    #[test]
    fn running_sessions_are_listed_by_title_and_agent() {
        let sessions = vec![
            json!({"title": "Fix the login flow", "agent": {"name": "Claude Code"}}),
            json!({"title": "  ", "agent": null}),
        ];
        assert_eq!(
            active_session_summary(&sessions),
            "- Fix the login flow (Claude Code)\n- Untitled session"
        );
    }

    #[test]
    fn the_running_session_warning_caps_the_list() {
        let sessions = (0..8)
            .map(|index| json!({"title": format!("Session {index}")}))
            .collect::<Vec<_>>();
        assert_eq!(active_session_summary(&sessions).lines().count(), 5);
    }

    fn adapter() -> Adapter {
        Adapter {
            schema_version: 1,
            id: "example".to_string(),
            name: "Example Agent".to_string(),
            verified: false,
            docs_url: "https://example.com/docs".to_string(),
            capture: vec![CaptureMode::Proxy],
            detect: pandu_core::adapter::Detect {
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
            skills: None,
            mcp: None,
            model_switch: None,
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
            PathBuf::from("elsewhere").join(brand::DATABASE_FILE)
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

    #[test]
    fn audit_verify_accepts_an_intact_chain_and_rejects_tampering() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join(brand::DATABASE_FILE);
        let store = Store::open(&database).unwrap();
        store
            .insert_remote_audit(&pandu_daemon::store::NewRemoteAudit {
                id: "entry-1".to_string(),
                at: pandu_daemon::store::now_iso(),
                event: "remote.enabled".to_string(),
                device_id: None,
                device_name: None,
                ip: None,
                detail: "{}".to_string(),
                size_bytes: None,
                content_hash: None,
            })
            .unwrap();
        drop(store);

        assert!(verify_audit_database(&database, true).is_ok());

        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute("UPDATE remote_audit SET event = 'remote.disabled'", [])
            .unwrap();
        drop(connection);

        let error = verify_audit_database(&database, true).unwrap_err();
        assert!(error.to_string().contains("hash chain is broken"));
    }
}
