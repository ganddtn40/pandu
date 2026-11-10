//! Frozen production trust root from before the rename.
//!
//! The production signing key is kept offline and was not available while the
//! product was renamed, so `registry/index.json` and `registry/revoked.json`
//! still carry their original key id and signatures. Rewriting either field
//! would invalidate both signatures and break every release build.
//!
//! Rotating this identity is a release task, not a source edit: generate a new
//! production key, embed its public half in `market::mod`, set
//! `registry.keyId` in `brand.json`, re-sign both JSON documents, then delete
//! this module. The repository name test allows exactly this file and the two
//! signed documents.
pub const PRODUCTION_KEY_ID: &str = "cockpit-market-2026";
