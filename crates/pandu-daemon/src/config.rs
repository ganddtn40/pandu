use std::env;
use std::path::{Path, PathBuf};

use pandu_core::brand;

use crate::error::{DaemonError, Result};

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 4319;
pub const DEFAULT_REMOTE_PORT: u16 = 4320;
pub const DEFAULT_SESSION_IDLE_MS: u64 = 30 * 60 * 1000;
pub const DEFAULT_MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_LOG_WATCH_INTERVAL_MS: u64 = 2_000;
pub const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";
pub const DEFAULT_GUARD_APPROVAL_MS: u64 = 120_000;
pub const PROXY_KEY_SENTINEL: &str = brand::PROXY_KEY_SENTINEL;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamConfig {
    pub base_url: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnthropicConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub home: PathBuf,
    pub host: String,
    pub port: u16,
    /// Optional remote listener port. `0` disables the listener entirely.
    pub remote_port: u16,
    /// Public URL used in pairing QR codes for tunnel/HTTPS modes.
    pub remote_public_url: Option<String>,
    /// Built dashboard assets served by the remote listener.
    pub ui_dir: PathBuf,
    pub database_path: PathBuf,
    pub openai: UpstreamConfig,
    pub anthropic: AnthropicConfig,
    pub gemini: UpstreamConfig,
    pub allowed_origins: Vec<String>,
    pub session_idle_ms: u64,
    pub max_body_bytes: usize,
    pub log_watch: bool,
    pub log_watch_interval_ms: u64,
    pub builtin_adapters: bool,
    pub demo_mode: bool,
    /// Desktop notifications for agent events. Disabled in tests and in the
    /// e2e harness so a headless run never pops a toast.
    pub notifications: bool,
    /// Workspace captured by git snapshots. Unset in tests so they never
    /// snapshot the developer's repository.
    pub workspace_path: Option<PathBuf>,
    pub snapshots_directory: PathBuf,
    pub guard_approval_timeout_ms: u64,
}

impl Config {
    pub fn load() -> Result<Self> {
        let vars: Vec<(String, String)> = env::vars().collect();
        let home_var = brand::env_name("HOME");
        let home_override = vars.iter().any(|(key, _)| key == &home_var);
        let config = Self::from_env(vars)?;
        // Only the default location is migrated: an explicit home override is
        // the user's choice and must be used exactly as given.
        if !home_override && let Err(error) = crate::migrate::migrate_default_home() {
            tracing::warn!(%error, "could not copy the old data directory");
        }
        Ok(config)
    }

    pub fn from_env<I>(vars: I) -> Result<Self>
    where
        I: IntoIterator<Item = (String, String)>,
    {
        let mut env: std::collections::HashMap<String, String> = vars.into_iter().collect();

        fn take(env: &mut std::collections::HashMap<String, String>, key: &str) -> Option<String> {
            env.remove(key).and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
        }

        let home = take(&mut env, &brand::env_name("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(default_home);

        let database_path = take(&mut env, &brand::env_name("DATABASE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(brand::DATABASE_FILE));

        let host =
            take(&mut env, &brand::env_name("HOST")).unwrap_or_else(|| DEFAULT_HOST.to_string());
        if !is_loopback_host(&host) {
            return Err(DaemonError::config(format!(
                "{} must be a loopback address in this build (got `{host}`). \
                 Remote access is not enabled until the phone pairing phase.",
                brand::env_name("HOST")
            )));
        }
        let port = match take(&mut env, &brand::env_name("PORT")) {
            Some(value) => value.parse::<u16>().map_err(|_| {
                DaemonError::config(format!(
                    "{} must be a number from 0 to 65535",
                    brand::env_name("PORT")
                ))
            })?,
            None => DEFAULT_PORT,
        };
        let remote_port = match take(&mut env, &brand::env_name("REMOTE_PORT")) {
            Some(value) => value.parse::<u16>().map_err(|_| {
                DaemonError::config(format!(
                    "{} must be a number from 0 to 65535",
                    brand::env_name("REMOTE_PORT")
                ))
            })?,
            None => DEFAULT_REMOTE_PORT,
        };
        let ui_dir = take(&mut env, &brand::env_name("UI_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(crate::remote::default_ui_dir);
        let remote_public_url =
            take(&mut env, &brand::env_name("REMOTE_PUBLIC_URL")).map(|value| {
                if value.starts_with("https://") || value.starts_with("http://") {
                    value.trim_end_matches('/').to_string()
                } else {
                    value
                }
            });

        let openai_base = take(&mut env, &brand::env_name("OPENAI_UPSTREAM"))
            .or_else(|| take(&mut env, &brand::env_name("OPENAI_BASE_URL")))
            .unwrap_or_else(|| "https://api.openai.com".to_string());
        let anthropic_base = take(&mut env, &brand::env_name("ANTHROPIC_UPSTREAM"))
            .or_else(|| take(&mut env, &brand::env_name("ANTHROPIC_BASE_URL")))
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());
        let gemini_base = take(&mut env, &brand::env_name("GEMINI_UPSTREAM"))
            .or_else(|| take(&mut env, &brand::env_name("GEMINI_BASE_URL")))
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());

        let openai_key = take(&mut env, &brand::env_name("OPENAI_API_KEY"))
            .or_else(|| take(&mut env, "OPENAI_API_KEY"));
        let anthropic_key = take(&mut env, &brand::env_name("ANTHROPIC_API_KEY"))
            .or_else(|| take(&mut env, "ANTHROPIC_API_KEY"));
        let gemini_key = take(&mut env, &brand::env_name("GEMINI_API_KEY"))
            .or_else(|| take(&mut env, "GEMINI_API_KEY"))
            .or_else(|| take(&mut env, "GOOGLE_API_KEY"));

        let allowed_origins: Vec<String> = take(&mut env, &brand::env_name("ALLOWED_ORIGINS"))
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|origin| !origin.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        for origin in &allowed_origins {
            if !is_loopback_origin(origin) {
                return Err(DaemonError::config(format!(
                    "{} only accepts loopback origins in this build (got `{origin}`).",
                    brand::env_name("ALLOWED_ORIGINS")
                )));
            }
        }

        let session_idle_ms = parse_u64(
            take(&mut env, &brand::env_name("SESSION_IDLE_MS")),
            DEFAULT_SESSION_IDLE_MS,
            &brand::env_name("SESSION_IDLE_MS"),
        )?;
        let max_body_bytes = parse_u64(
            take(&mut env, &brand::env_name("MAX_BODY_BYTES")),
            DEFAULT_MAX_BODY_BYTES as u64,
            &brand::env_name("MAX_BODY_BYTES"),
        )? as usize;

        let demo_mode = take(&mut env, &brand::env_name("DEMO"))
            .map(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false);

        let log_watch = take(&mut env, &brand::env_name("LOG_WATCH"))
            .map(|value| {
                !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
            })
            .unwrap_or(true);
        let log_watch_interval_ms = parse_u64(
            take(&mut env, &brand::env_name("LOG_WATCH_INTERVAL_MS")),
            DEFAULT_LOG_WATCH_INTERVAL_MS,
            &brand::env_name("LOG_WATCH_INTERVAL_MS"),
        )?;
        let builtin_adapters = take(&mut env, &brand::env_name("BUILTIN_ADAPTERS"))
            .map(|value| {
                !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
            })
            .unwrap_or(true);
        let notifications = take(&mut env, &brand::env_name("NOTIFICATIONS"))
            .map(|value| {
                !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
            })
            .unwrap_or(true);

        let anthropic_version = take(&mut env, &brand::env_name("ANTHROPIC_VERSION"))
            .unwrap_or_else(|| DEFAULT_ANTHROPIC_VERSION.to_string());

        let workspace_path = take(&mut env, &brand::env_name("WORKSPACE"))
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok());
        let snapshots_directory = take(&mut env, &brand::env_name("SNAPSHOTS_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("snapshots"));
        let guard_approval_timeout_ms = parse_u64(
            take(&mut env, &brand::env_name("GUARD_APPROVAL_MS")),
            DEFAULT_GUARD_APPROVAL_MS,
            &brand::env_name("GUARD_APPROVAL_MS"),
        )?;

        Ok(Self {
            home,
            host,
            port,
            remote_port,
            remote_public_url,
            ui_dir,
            database_path,
            openai: UpstreamConfig {
                base_url: strip_trailing_slashes(&openai_base),
                api_key: openai_key,
            },
            anthropic: AnthropicConfig {
                base_url: strip_trailing_slashes(&anthropic_base),
                api_key: anthropic_key,
                version: anthropic_version,
            },
            gemini: UpstreamConfig {
                base_url: strip_trailing_slashes(&gemini_base),
                api_key: gemini_key,
            },
            allowed_origins,
            session_idle_ms,
            max_body_bytes,
            log_watch,
            log_watch_interval_ms,
            builtin_adapters,
            demo_mode,
            notifications,
            workspace_path,
            snapshots_directory,
            guard_approval_timeout_ms,
        })
    }

    /// A config rooted in a temporary or test directory with no real keys.
    pub fn for_home(home: impl AsRef<Path>) -> Self {
        let home = home.as_ref().to_path_buf();
        let snapshots_directory = home.join("snapshots");
        Self {
            database_path: home.join(brand::DATABASE_FILE),
            home,
            host: DEFAULT_HOST.to_string(),
            port: 0,
            // Tests opt in to the remote listener explicitly.
            remote_port: 0,
            remote_public_url: None,
            ui_dir: crate::remote::default_ui_dir(),
            openai: UpstreamConfig {
                base_url: "https://api.openai.com".to_string(),
                api_key: None,
            },
            anthropic: AnthropicConfig {
                base_url: "https://api.anthropic.com".to_string(),
                api_key: None,
                version: DEFAULT_ANTHROPIC_VERSION.to_string(),
            },
            gemini: UpstreamConfig {
                base_url: "https://generativelanguage.googleapis.com".to_string(),
                api_key: None,
            },
            allowed_origins: Vec::new(),
            session_idle_ms: DEFAULT_SESSION_IDLE_MS,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            // Tests must never walk the developer's home directory. A real
            // daemon starts with log watching on.
            log_watch: false,
            log_watch_interval_ms: DEFAULT_LOG_WATCH_INTERVAL_MS,
            builtin_adapters: true,
            demo_mode: false,
            notifications: false,
            // Tests must never snapshot the repository they run in.
            workspace_path: None,
            snapshots_directory,
            guard_approval_timeout_ms: DEFAULT_GUARD_APPROVAL_MS,
        }
    }

    pub fn upstream_base(&self, protocol: pandu_core::provider::ProviderProtocol) -> &str {
        use pandu_core::provider::ProviderProtocol;
        match protocol {
            ProviderProtocol::Openai => &self.openai.base_url,
            ProviderProtocol::Anthropic => &self.anthropic.base_url,
            ProviderProtocol::Gemini => &self.gemini.base_url,
        }
    }
}

fn default_home() -> PathBuf {
    // Keep 0.2.0 state beside, not on top of, an older data directory.
    if let Some(base) = directories::BaseDirs::new() {
        base.home_dir().join(brand::DATA_DIR).join("v2")
    } else {
        PathBuf::from(brand::DATA_DIR).join("v2")
    }
}

fn strip_trailing_slashes(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

/// This build is local-only. Accept a loopback IP literal or `localhost`.
pub fn is_loopback_host(host: &str) -> bool {
    let trimmed = host.trim();
    let without_brackets = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed);
    if without_brackets.eq_ignore_ascii_case("localhost") {
        return true;
    }
    without_brackets
        .parse::<std::net::IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

/// Accept `http(s)://localhost[:port]` and loopback IP origins only.
pub fn is_loopback_origin(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or(rest);
    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or(bracketed)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    is_loopback_host(host)
}

fn parse_u64(value: Option<String>, fallback: u64, name: &str) -> Result<u64> {
    match value {
        Some(value) => value
            .parse::<u64>()
            .map_err(|_| DaemonError::config(format!("{name} must be a positive integer"))),
        None => Ok(fallback),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(suffix: &str) -> String {
        brand::env_name(suffix)
    }

    fn config(pairs: Vec<(String, String)>) -> Config {
        Config::from_env(pairs).unwrap()
    }

    #[test]
    fn uses_defaults() {
        let config = config(Vec::new());
        assert_eq!(config.host, DEFAULT_HOST);
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.openai.base_url, "https://api.openai.com");
        assert_eq!(config.anthropic.version, DEFAULT_ANTHROPIC_VERSION);
        assert_eq!(config.max_body_bytes, DEFAULT_MAX_BODY_BYTES);
        assert!(config.log_watch);
        assert_eq!(config.log_watch_interval_ms, DEFAULT_LOG_WATCH_INTERVAL_MS);
    }

    #[test]
    fn reads_environment_overrides() {
        let config = config(vec![
            (var("HOST"), "127.0.0.1".to_string()),
            (var("PORT"), "9999".to_string()),
            (var("OPENAI_UPSTREAM"), "http://localhost:8080/".to_string()),
            (var("OPENAI_API_KEY"), "sk-test".to_string()),
            (
                var("ALLOWED_ORIGINS"),
                "http://127.0.0.1:5174, http://localhost:4174".to_string(),
            ),
            (var("DEMO"), "yes".to_string()),
        ]);
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 9999);
        assert_eq!(config.openai.base_url, "http://localhost:8080");
        assert_eq!(config.openai.api_key.as_deref(), Some("sk-test"));
        assert_eq!(config.allowed_origins.len(), 2);
        assert!(config.demo_mode);
    }

    #[test]
    fn rejects_non_loopback_hosts() {
        for host in ["0.0.0.0", "::", "192.168.1.10", "example.com"] {
            let result = Config::from_env([(var("HOST"), host.to_string())]);
            assert!(result.is_err(), "{host} should be rejected");
        }
        for host in ["127.0.0.1", "::1", "[::1]", "localhost"] {
            let result = Config::from_env([(var("HOST"), host.to_string())]);
            assert!(result.is_ok(), "{host} should be accepted");
        }
    }

    #[test]
    fn rejects_non_loopback_origins() {
        let result =
            Config::from_env([(var("ALLOWED_ORIGINS"), "https://evil.example".to_string())]);
        assert!(result.is_err());
    }

    #[test]
    fn prefers_branded_keys_over_provider_keys() {
        let config = config(vec![
            ("OPENAI_API_KEY".to_string(), "provider".to_string()),
            (var("OPENAI_API_KEY"), "local".to_string()),
        ]);
        assert_eq!(config.openai.api_key.as_deref(), Some("local"));
    }

    #[test]
    fn rejects_bad_port() {
        let result = Config::from_env([(var("PORT"), "nope".to_string())]);
        assert!(result.is_err());
    }
}
