//! The `cockpit` command-line entry point.
//!
//! Phase 1 starts the local daemon. Phase 2 grows the rest of the commands:
//! `cockpit run -- <agent>`, `cockpit demo`, `cockpit doctor`,
//! `cockpit report`, and `cockpit pair`.

use std::path::PathBuf;

use anyhow::Context;
use clap::{Args, Parser, Subcommand};
use cockpit_daemon::Config;
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
}

#[derive(Debug, Args, Default)]
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

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .compact()
        .init();

    let (args, force_demo) = match cli.command {
        Some(Command::Serve(args)) => (args, false),
        Some(Command::Demo(args)) => (args, true),
        None => (ServeArgs::default(), false),
    };

    let config = Config::load().context("could not read Cockpit configuration")?;
    let config = args.apply(config, force_demo);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("could not start the async runtime")?;

    runtime.block_on(async move {
        cockpit_daemon::run(config)
            .await
            .context("the Cockpit daemon stopped with an error")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
