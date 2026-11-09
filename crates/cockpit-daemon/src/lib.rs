//! Cockpit's local daemon.
//!
//! Phase 1 adds the axum proxy and API, SSE passthrough, recording, redaction,
//! and SQLite storage. Phase 2 adds adapter loading and log watchers. Phase 3
//! adds git snapshots, guards, budgets, and approvals.
//!
//! The daemon is designed to fail open: a recording or storage failure must
//! never change or block the bytes travelling to the upstream provider.

pub mod adapters;
pub mod agents;
pub mod api;
pub mod budget;
pub mod config;
pub mod error;
pub mod guards;
pub mod live;
pub mod logparse;
pub mod logwatch;
pub mod market;
pub mod proxy;
pub mod recorder;
pub mod remote;
pub mod server;
pub mod sessions;
pub mod snapshots;
pub mod state;
pub mod store;
pub mod ui;

pub use config::Config;
pub use error::{DaemonError, Result};
pub use server::{ServerHandle, run, spawn};
pub use state::AppState;

pub use cockpit_core::VERSION;

/// Human-readable crate purpose used by `cockpit doctor` once the CLI lands.
pub const DESCRIPTION: &str = "Cockpit local daemon";

/// Returns the daemon's version.
pub fn version() -> &'static str {
    VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_core() {
        assert_eq!(version(), cockpit_core::VERSION);
    }
}
