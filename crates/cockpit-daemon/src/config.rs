use std::env;
use std::path::{Path, PathBuf};

use crate::error::{DaemonError, Result};

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 4319;
pub const DEFAULT_SESSION_IDLE_MS: u64 = 30 * 60 * 1000;
pub const DEFAULT_MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_LOG_WATCH_INTERVAL_MS: u64 = 2_000;
pub const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";
pub const PROXY_KEY_SENTINEL: &str = "cockpit-proxy";

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
}

impl Config {
    pub fn load() -> Result<Self> {
        Self::from_env(env::vars())
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

        let home = take(&mut env, "COCKPIT_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(default_home);

        let database_path = take(&mut env, "COCKPIT_DATABASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("cockpit.db"));

        let host = take(&mut env, "COCKPIT_HOST").unwrap_or_else(|| DEFAULT_HOST.to_string());
        let port = match take(&mut env, "COCKPIT_PORT") {
            Some(value) => value.parse::<u16>().map_err(|_| {
                DaemonError::config("COCKPIT_PORT must be a number from 0 to 65535")
            })?,
            None => DEFAULT_PORT,
        };

        let openai_base = take(&mut env, "COCKPIT_OPENAI_UPSTREAM")
            .or_else(|| take(&mut env, "COCKPIT_OPENAI_BASE_URL"))
            .unwrap_or_else(|| "https://api.openai.com".to_string());
        let anthropic_base = take(&mut env, "COCKPIT_ANTHROPIC_UPSTREAM")
            .or_else(|| take(&mut env, "COCKPIT_ANTHROPIC_BASE_URL"))
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());
        let gemini_base = take(&mut env, "COCKPIT_GEMINI_UPSTREAM")
            .or_else(|| take(&mut env, "COCKPIT_GEMINI_BASE_URL"))
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());

        let openai_key =
            take(&mut env, "COCKPIT_OPENAI_API_KEY").or_else(|| take(&mut env, "OPENAI_API_KEY"));
        let anthropic_key = take(&mut env, "COCKPIT_ANTHROPIC_API_KEY")
            .or_else(|| take(&mut env, "ANTHROPIC_API_KEY"));
        let gemini_key = take(&mut env, "COCKPIT_GEMINI_API_KEY")
            .or_else(|| take(&mut env, "GEMINI_API_KEY"))
            .or_else(|| take(&mut env, "GOOGLE_API_KEY"));

        let allowed_origins = take(&mut env, "COCKPIT_ALLOWED_ORIGINS")
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|origin| !origin.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let session_idle_ms = parse_u64(
            take(&mut env, "COCKPIT_SESSION_IDLE_MS"),
            DEFAULT_SESSION_IDLE_MS,
            "COCKPIT_SESSION_IDLE_MS",
        )?;
        let max_body_bytes = parse_u64(
            take(&mut env, "COCKPIT_MAX_BODY_BYTES"),
            DEFAULT_MAX_BODY_BYTES as u64,
            "COCKPIT_MAX_BODY_BYTES",
        )? as usize;

        let demo_mode = take(&mut env, "COCKPIT_DEMO")
            .map(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false);

        let log_watch = take(&mut env, "COCKPIT_LOG_WATCH")
            .map(|value| {
                !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
            })
            .unwrap_or(true);
        let log_watch_interval_ms = parse_u64(
            take(&mut env, "COCKPIT_LOG_WATCH_INTERVAL_MS"),
            DEFAULT_LOG_WATCH_INTERVAL_MS,
            "COCKPIT_LOG_WATCH_INTERVAL_MS",
        )?;
        let builtin_adapters = take(&mut env, "COCKPIT_BUILTIN_ADAPTERS")
            .map(|value| {
                !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
            })
            .unwrap_or(true);

        let anthropic_version = take(&mut env, "COCKPIT_ANTHROPIC_VERSION")
            .unwrap_or_else(|| DEFAULT_ANTHROPIC_VERSION.to_string());

        Ok(Self {
            home,
            host,
            port,
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
        })
    }

    /// A config rooted in a temporary or test directory with no real keys.
    pub fn for_home(home: impl AsRef<Path>) -> Self {
        let home = home.as_ref().to_path_buf();
        Self {
            database_path: home.join("cockpit.db"),
            home,
            host: DEFAULT_HOST.to_string(),
            port: 0,
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
        }
    }

    pub fn upstream_base(&self, protocol: cockpit_core::provider::ProviderProtocol) -> &str {
        use cockpit_core::provider::ProviderProtocol;
        match protocol {
            ProviderProtocol::Openai => &self.openai.base_url,
            ProviderProtocol::Anthropic => &self.anthropic.base_url,
            ProviderProtocol::Gemini => &self.gemini.base_url,
        }
    }
}

fn default_home() -> PathBuf {
    // Keep 0.2.0 state beside, not on top of, a 0.1.0 `~/.cockpit` directory.
    if let Some(base) = directories::BaseDirs::new() {
        base.home_dir().join(".cockpit").join("v2")
    } else {
        PathBuf::from(".cockpit").join("v2")
    }
}

fn strip_trailing_slashes(value: &str) -> String {
    value.trim_end_matches('/').to_string()
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

    fn config(pairs: &[(&str, &str)]) -> Config {
        Config::from_env(
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
        )
        .unwrap()
    }

    #[test]
    fn uses_defaults() {
        let config = config(&[]);
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
        let config = config(&[
            ("COCKPIT_HOST", "0.0.0.0"),
            ("COCKPIT_PORT", "9999"),
            ("COCKPIT_OPENAI_UPSTREAM", "http://localhost:8080/"),
            ("COCKPIT_OPENAI_API_KEY", "sk-test"),
            (
                "COCKPIT_ALLOWED_ORIGINS",
                "https://a.example, https://b.example",
            ),
            ("COCKPIT_DEMO", "yes"),
        ]);
        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, 9999);
        assert_eq!(config.openai.base_url, "http://localhost:8080");
        assert_eq!(config.openai.api_key.as_deref(), Some("sk-test"));
        assert_eq!(config.allowed_origins.len(), 2);
        assert!(config.demo_mode);
    }

    #[test]
    fn prefers_cockpit_keys_over_provider_keys() {
        let config = config(&[
            ("OPENAI_API_KEY", "provider"),
            ("COCKPIT_OPENAI_API_KEY", "cockpit"),
        ]);
        assert_eq!(config.openai.api_key.as_deref(), Some("cockpit"));
    }

    #[test]
    fn rejects_bad_port() {
        let result = Config::from_env([("COCKPIT_PORT".to_string(), "nope".to_string())]);
        assert!(result.is_err());
    }
}
