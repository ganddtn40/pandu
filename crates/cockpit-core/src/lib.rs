//! Shared domain model for Cockpit.
//!
//! This crate is deliberately free of network and database I/O. It owns the
//! vocabulary every capture mode shares: flights (sessions), steps, token
//! usage, cost, redaction, SSE observation, and proxy route parsing. The
//! daemon and desktop app build on it.

pub mod agent;
pub mod collector;
pub mod cost;
pub mod ids;
pub mod model;
pub mod provider;
pub mod redact;
pub mod request_meta;
pub mod routing;
pub mod sse;
pub mod text;
pub mod usage;

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
