//! Shared domain model for Cockpit.
//!
//! Phase 1 adds the unified flight model (sessions, steps, tool calls, token
//! usage, cost), redaction, SSE observation, pricing, and the data-driven
//! adapter model. This crate stays free of I/O and platform dependencies so it
//! can be tested quickly and reused by the daemon, CLI, and desktop app.

/// The Cockpit version compiled into this crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The schema version of the local database.
///
/// The value changes whenever a migration is added. The daemon refuses to open
/// a database written by a newer schema than it understands.
pub const SCHEMA_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_not_empty() {
        assert!(!VERSION.is_empty());
    }

    #[test]
    fn schema_version_starts_at_one() {
        assert_eq!(SCHEMA_VERSION, 1);
    }
}
