//! The single source of truth for every brand string.
//!
//! Values come from `brand.json` at the repository root through `build.rs`.
//! Nothing in the workspace should hard-code a product name, an identifier, a
//! directory, an environment variable prefix, or a title: use these constants
//! instead. The `brand::tests` module and the repository-wide name test keep
//! the two from drifting.

/// Product name as shown to people: `Pandu`.
pub const PRODUCT_NAME: &str = env!("PANDU_BRAND_NAME");
/// Lowercase slug used in paths and identifiers: `pandu`.
pub const SLUG: &str = env!("PANDU_BRAND_SLUG");
/// Lowercase wordmark drawn next to the mark.
pub const WORDMARK: &str = env!("PANDU_BRAND_WORDMARK");
/// One-line product description.
pub const TAGLINE: &str = env!("PANDU_BRAND_TAGLINE");
/// The sentence that keeps the product distinct from the agents it watches.
pub const DISAMBIGUATION: &str = env!("PANDU_BRAND_DISAMBIGUATION");

/// The command people type: `pandu`.
pub const CLI_COMMAND: &str = env!("PANDU_BRAND_CLI_COMMAND");
/// Cargo package name of the domain crate.
pub const CRATE_CORE: &str = env!("PANDU_BRAND_CRATE_CORE");
/// Cargo package name of the daemon crate.
pub const CRATE_DAEMON: &str = env!("PANDU_BRAND_CRATE_DAEMON");
/// Cargo package name of the CLI crate.
pub const CRATE_CLI: &str = env!("PANDU_BRAND_CRATE_CLI");

/// Prefix for every environment variable, including the trailing underscore.
pub const ENV_PREFIX: &str = env!("PANDU_BRAND_ENV_PREFIX");
/// Default per-user data directory name.
pub const DATA_DIR: &str = env!("PANDU_BRAND_DATA_DIR");
/// Default SQLite file name.
pub const DATABASE_FILE: &str = env!("PANDU_BRAND_DATABASE_FILE");

/// Reverse-domain application identifier for the desktop and Android shells.
pub const APP_ID: &str = env!("PANDU_BRAND_APP_ID");
/// Android package name.
pub const ANDROID_PACKAGE: &str = env!("PANDU_BRAND_ANDROID_PACKAGE");
/// Deep-link URL scheme.
pub const URL_SCHEME: &str = env!("PANDU_BRAND_URL_SCHEME");

/// Canonical repository URL.
pub const REPOSITORY: &str = env!("PANDU_BRAND_REPOSITORY");
/// Default signed registry URL.
pub const REGISTRY_URL: &str = env!("PANDU_BRAND_REGISTRY_URL");
/// Production registry signing key id.
pub const MARKET_KEY_ID: &str = env!("PANDU_BRAND_MARKET_KEY_ID");
/// Test registry signing key id.
pub const MARKET_TEST_KEY_ID: &str = env!("PANDU_BRAND_MARKET_TEST_KEY_ID");

/// Versioned theme JSON schema name.
pub const THEME_SCHEMA: &str = env!("PANDU_BRAND_THEME_SCHEMA");
/// Prefix for every browser storage key, including the trailing dot.
pub const STORAGE_PREFIX: &str = env!("PANDU_BRAND_STORAGE_PREFIX");

/// Desktop window title.
pub const WINDOW_TITLE: &str = env!("PANDU_BRAND_WINDOW_TITLE");
/// Tray icon tooltip.
pub const TRAY_TOOLTIP: &str = env!("PANDU_BRAND_TRAY_TOOLTIP");
/// Operating-system notification title.
pub const NOTIFICATION_TITLE: &str = env!("PANDU_BRAND_NOTIFICATION_TITLE");
/// Accessible label for the logo mark.
pub const LOGO_ARIA_LABEL: &str = env!("PANDU_BRAND_LOGO_ARIA_LABEL");

/// Internal API key sentinel used for the local proxy.
pub const PROXY_KEY_SENTINEL: &str = concat!(env!("PANDU_BRAND_SLUG"), "-proxy");

/// Actor recorded on audit rows written by the daemon rather than a person.
pub const AUDIT_ACTOR: &str = SLUG;
/// File name used when exporting the remote audit log.
pub const REMOTE_AUDIT_FILE: &str = concat!(env!("PANDU_BRAND_SLUG"), "-remote-audit.json");
/// Domain separator for the remote audit hash chain.
pub const REMOTE_AUDIT_HASH_DOMAIN: &str = concat!(env!("PANDU_BRAND_SLUG"), "-remote-audit-v1");
/// Prefix for the short-lived WebSocket ticket subprotocol.
pub const WS_PROTOCOL_PREFIX: &str = concat!(env!("PANDU_BRAND_SLUG"), ".");
/// Local hostname advertised by LAN remote access.
pub const LOCAL_HOSTNAME: &str = concat!(env!("PANDU_BRAND_SLUG"), ".local");
/// Git author and committer name for snapshot commits.
pub const GIT_AUTHOR_NAME: &str = PRODUCT_NAME;
/// Git author and committer email for snapshot commits.
pub const GIT_AUTHOR_EMAIL: &str = concat!(env!("PANDU_BRAND_SLUG"), "@localhost");
/// Prefix for snapshot commit subjects, including the trailing colon.
pub const SNAPSHOT_COMMIT_PREFIX: &str = concat!(env!("PANDU_BRAND_SLUG"), ":");

/// Prefix for every header the product owns, including the trailing dash.
pub const HEADER_PREFIX: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-");
/// CSRF header shared with the UI.
pub const CSRF_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-csrf");
/// Rotated bearer-token header used by the remote listener.
pub const TOKEN_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-token");
/// Marks a response as coming from the remote listener.
pub const REMOTE_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-remote");
/// Declares the upstream protocol on a proxied request.
pub const PROTOCOL_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-protocol");
/// Optional agent-name override on a proxied request.
pub const AGENT_NAME_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-agent-name");
/// Optional agent-version override on a proxied request.
pub const AGENT_VERSION_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-agent-version");
/// Optional provider override on a proxied request.
pub const PROVIDER_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-provider");
/// Session id the proxy attaches to a captured request.
pub const SESSION_ID_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-session-id");
/// Step id the proxy attaches to a captured request.
pub const STEP_ID_HEADER: &str = concat!("x-", env!("PANDU_BRAND_SLUG"), "-step-id");

/// Build an environment variable name from its suffix, for example
/// `env_name("HOME")` returns `PANDU_HOME`.
pub fn env_name(suffix: &str) -> String {
    format!("{ENV_PREFIX}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_brand_value_is_present() {
        for (label, value) in [
            ("name", PRODUCT_NAME),
            ("slug", SLUG),
            ("wordmark", WORDMARK),
            ("tagline", TAGLINE),
            ("disambiguation", DISAMBIGUATION),
            ("cli", CLI_COMMAND),
            ("crate core", CRATE_CORE),
            ("crate daemon", CRATE_DAEMON),
            ("crate cli", CRATE_CLI),
            ("env prefix", ENV_PREFIX),
            ("data dir", DATA_DIR),
            ("database file", DATABASE_FILE),
            ("app id", APP_ID),
            ("android package", ANDROID_PACKAGE),
            ("url scheme", URL_SCHEME),
            ("repository", REPOSITORY),
            ("registry url", REGISTRY_URL),
            ("market key id", MARKET_KEY_ID),
            ("market test key id", MARKET_TEST_KEY_ID),
            ("theme schema", THEME_SCHEMA),
            ("storage prefix", STORAGE_PREFIX),
            ("window title", WINDOW_TITLE),
            ("tray tooltip", TRAY_TOOLTIP),
            ("notification title", NOTIFICATION_TITLE),
            ("logo aria label", LOGO_ARIA_LABEL),
        ] {
            assert!(!value.trim().is_empty(), "{label} must not be empty");
        }
    }

    #[test]
    fn names_are_consistent() {
        assert_eq!(PRODUCT_NAME, "Pandu");
        assert_eq!(SLUG, "pandu");
        assert_eq!(CLI_COMMAND, SLUG);
        assert_eq!(WORDMARK, SLUG);
        assert_eq!(CRATE_CORE, format!("{SLUG}-core"));
        assert_eq!(CRATE_DAEMON, format!("{SLUG}-daemon"));
        assert_eq!(CRATE_CLI, format!("{SLUG}-cli"));
        assert_eq!(ENV_PREFIX, format!("{}_", SLUG.to_uppercase()));
        assert_eq!(DATA_DIR, format!(".{SLUG}"));
        assert_eq!(DATABASE_FILE, format!("{SLUG}.db"));
        assert_eq!(THEME_SCHEMA, format!("{SLUG}.theme"));
        assert_eq!(STORAGE_PREFIX, format!("{SLUG}."));
        assert_eq!(AUDIT_ACTOR, SLUG);
        assert_eq!(REMOTE_AUDIT_FILE, format!("{SLUG}-remote-audit.json"));
        assert_eq!(REMOTE_AUDIT_HASH_DOMAIN, format!("{SLUG}-remote-audit-v1"));
        assert_eq!(WS_PROTOCOL_PREFIX, format!("{SLUG}."));
        assert_eq!(LOCAL_HOSTNAME, format!("{SLUG}.local"));
        assert_eq!(GIT_AUTHOR_NAME, PRODUCT_NAME);
        assert_eq!(GIT_AUTHOR_EMAIL, format!("{SLUG}@localhost"));
        assert_eq!(SNAPSHOT_COMMIT_PREFIX, format!("{SLUG}:"));
        assert_eq!(WINDOW_TITLE, PRODUCT_NAME);
        assert_eq!(NOTIFICATION_TITLE, PRODUCT_NAME);
        assert_eq!(LOGO_ARIA_LABEL, PRODUCT_NAME);
        assert!(REGISTRY_URL.contains(&format!("/{SLUG}/")));
        assert!(REPOSITORY.ends_with(&format!("/{SLUG}")));
    }

    #[test]
    fn identifiers_are_well_formed() {
        assert!(ENV_PREFIX.ends_with('_'));
        assert!(DATA_DIR.starts_with('.'));
        assert_eq!(APP_ID.split('.').count(), 4, "reverse-domain id");
        assert_eq!(ANDROID_PACKAGE, APP_ID);
        assert!(URL_SCHEME.chars().all(|c| c.is_ascii_lowercase()));
        assert!(MARKET_KEY_ID.starts_with(SLUG));
        assert!(MARKET_TEST_KEY_ID.starts_with(SLUG));
        assert_ne!(MARKET_KEY_ID, MARKET_TEST_KEY_ID);
    }

    #[test]
    fn env_names_carry_the_prefix() {
        assert_eq!(env_name("HOME"), format!("{ENV_PREFIX}HOME"));
        assert!(env_name("REMOTE_PORT").starts_with("PANDU_"));
    }

    #[test]
    fn the_disambiguation_keeps_the_product_separate_from_agents() {
        assert!(DISAMBIGUATION.contains("not an AI agent"));
    }
}
