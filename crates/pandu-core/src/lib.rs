//! Shared domain model for Pandu.
//!
//! This crate is deliberately free of network and database I/O. It owns the
//! vocabulary every capture mode shares: flights (sessions), steps, token
//! usage, cost, redaction, SSE observation, and proxy route parsing. The
//! daemon and desktop app build on it.

pub mod adapter;
pub mod agent;
pub mod brand;
pub mod collector;
pub mod context;
pub mod cost;
pub mod guard;
pub mod ids;
pub mod model;
pub mod provider;
pub mod redact;
pub mod replay;
pub mod request_meta;
pub mod routing;
pub mod similarity;
pub mod sse;
pub mod text;
pub mod update;
pub mod usage;

/// The Pandu version compiled into this crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_not_empty() {
        assert!(!VERSION.is_empty());
    }
}
