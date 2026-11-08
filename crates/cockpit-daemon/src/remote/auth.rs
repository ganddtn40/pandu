//! Remote authentication primitives.
//!
//! Everything in this module is deliberately small and boring: tokens are
//! 256-bit random values shown once, only their SHA-256 hash is stored, every
//! comparison is constant time, and the rate limiter is in memory so a restart
//! forgets old failures instead of locking the owner out forever.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const TOKEN_BYTES: usize = 32;
pub const PAIR_CODE_BYTES: usize = 16;
pub const PIN_MIN_DIGITS: usize = 4;
pub const PIN_MAX_DIGITS: usize = 8;

/// Server-enforced scopes. A new device always starts with `View` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    View,
    Respond,
    Prompt,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Respond => "respond",
            Self::Prompt => "prompt",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "view" => Some(Self::View),
            "respond" => Some(Self::Respond),
            "prompt" => Some(Self::Prompt),
            _ => None,
        }
    }

    /// Plain-language warning shown when the host raises a scope.
    pub fn warning(self) -> &'static str {
        match self {
            Self::View => "View lets this device read flights, inbox items, and live events.",
            Self::Respond => {
                "Respond lets this device approve or deny actions your agent asks about."
            }
            Self::Prompt => {
                "Prompt lets this device make your agent run commands in a running session."
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScopeSet(Vec<Scope>);

impl ScopeSet {
    pub fn view_only() -> Self {
        Self(vec![Scope::View])
    }

    pub fn from_strings(values: &[String]) -> Self {
        let mut scopes: Vec<Scope> = values
            .iter()
            .filter_map(|value| Scope::parse(value))
            .collect();
        scopes.sort();
        scopes.dedup();
        if scopes.is_empty() {
            scopes.push(Scope::View);
        }
        // View is the floor: every paired device can read what it is paired to.
        if !scopes.contains(&Scope::View) {
            scopes.insert(0, Scope::View);
        }
        Self(scopes)
    }

    pub fn to_strings(&self) -> Vec<String> {
        self.0
            .iter()
            .map(|scope| scope.as_str().to_string())
            .collect()
    }

    pub fn contains(&self, scope: Scope) -> bool {
        self.0.contains(&scope)
    }

    pub fn iter(&self) -> impl Iterator<Item = Scope> + '_ {
        self.0.iter().copied()
    }
}

#[derive(Debug, Clone)]
pub struct RemotePrincipal {
    pub device_id: String,
    pub device_name: String,
    pub scopes: ScopeSet,
    pub require_host_confirmation: bool,
    pub pin_salt: Option<String>,
    pub pin_hash: Option<String>,
}

impl RemotePrincipal {
    pub fn allows(&self, scope: Scope) -> bool {
        self.scopes.contains(scope)
    }

    pub fn has_pin(&self) -> bool {
        self.pin_hash.is_some()
    }

    pub fn verify_pin(&self, pin: &str) -> bool {
        verify_pin(self.pin_salt.as_deref(), self.pin_hash.as_deref(), pin)
    }
}

/// A 256-bit device token, hex encoded. Shown exactly once.
pub fn new_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

/// A 128-bit pairing code, hex encoded. Short-lived and single use.
pub fn new_pair_code() -> String {
    let mut bytes = [0u8; PAIR_CODE_BYTES];
    OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

pub fn new_salt() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

pub fn hash_token(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

pub fn hash_pin(salt: &str, pin: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(pin.as_bytes());
    hex(&hasher.finalize())
}

pub fn verify_pin(salt: Option<&str>, expected: Option<&str>, pin: &str) -> bool {
    let (Some(salt), Some(expected)) = (salt, expected) else {
        return false;
    };
    constant_time_eq(hash_pin(salt, pin).as_bytes(), expected.as_bytes())
}

/// Compare two byte slices without early exit. Length is allowed to leak
/// because all secret hashes in Cockpit are fixed-length hex strings.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

pub fn valid_pin(pin: &str) -> bool {
    let length = pin.chars().count();
    (PIN_MIN_DIGITS..=PIN_MAX_DIGITS).contains(&length)
        && pin.chars().all(|character| character.is_ascii_digit())
}

pub fn valid_pair_code(code: &str) -> bool {
    code.len() == PAIR_CODE_BYTES * 2 && code.chars().all(|character| character.is_ascii_hexdigit())
}

/// Fixed-window request limits plus exponential lockout for failed
/// authentication attempts.
#[derive(Default)]
pub struct RateLimiter {
    windows: Mutex<HashMap<String, Window>>,
    failures: Mutex<HashMap<String, Failures>>,
}

struct Window {
    started: Instant,
    count: u32,
}

struct Failures {
    count: u32,
    level: u32,
    locked_until: Option<Instant>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns false when `key` has used its budget for the current window.
    pub fn allow(&self, key: &str, limit: u32, window: Duration) -> bool {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let now = Instant::now();
        if windows.len() > 4_096 {
            windows.retain(|_, entry| now.duration_since(entry.started) < Duration::from_secs(600));
        }
        let entry = windows.entry(key.to_string()).or_insert(Window {
            started: now,
            count: 0,
        });
        if now.duration_since(entry.started) >= window {
            entry.started = now;
            entry.count = 0;
        }
        if entry.count >= limit {
            return false;
        }
        entry.count += 1;
        true
    }

    /// How long this key is locked out, if at all.
    pub fn locked_for(&self, key: &str) -> Option<Duration> {
        let failures = self
            .failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let entry = failures.get(key)?;
        let until = entry.locked_until?;
        let now = Instant::now();
        if until > now {
            Some(until.duration_since(now))
        } else {
            None
        }
    }

    /// Record a failed code or token attempt. Five free attempts, then a
    /// doubling lockout from 30 seconds up to 15 minutes.
    pub fn record_failure(&self, key: &str) -> Duration {
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let entry = failures.entry(key.to_string()).or_insert(Failures {
            count: 0,
            level: 0,
            locked_until: None,
        });
        entry.count = entry.count.saturating_add(1);
        if entry.count < 5 {
            return Duration::ZERO;
        }
        entry.count = 0;
        let seconds = 30u64.saturating_mul(1u64 << entry.level.min(5)).min(900);
        entry.level = entry.level.saturating_add(1);
        entry.locked_until = Some(Instant::now() + Duration::from_secs(seconds));
        Duration::from_secs(seconds)
    }

    pub fn clear_failures(&self, key: &str) {
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        failures.remove(key);
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_256_bit_and_only_the_hash_is_stable() {
        let token = new_token();
        assert_eq!(token.len(), 64);
        assert_eq!(hash_token(&token).len(), 64);
        assert_ne!(token, hash_token(&token));
        assert_ne!(new_token(), token);
    }

    #[test]
    fn constant_time_comparison_matches_normal_equality() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"short", b"longer"));
        let hash = hash_token("secret");
        assert!(constant_time_eq(
            hash.as_bytes(),
            hash_token("secret").as_bytes()
        ));
        assert!(!constant_time_eq(
            hash.as_bytes(),
            hash_token("other").as_bytes()
        ));
    }

    #[test]
    fn pins_are_salted_and_verified() {
        let salt = new_salt();
        let hash = hash_pin(&salt, "1234");
        assert!(verify_pin(Some(&salt), Some(&hash), "1234"));
        assert!(!verify_pin(Some(&salt), Some(&hash), "1235"));
        assert!(!verify_pin(None, Some(&hash), "1234"));
        assert!(valid_pin("1234"));
        assert!(valid_pin("12345678"));
        assert!(!valid_pin("123"));
        assert!(!valid_pin("12a4"));
    }

    #[test]
    fn pairing_codes_are_128_bit_hex() {
        let code = new_pair_code();
        assert_eq!(code.len(), 32);
        assert!(valid_pair_code(&code));
        assert!(!valid_pair_code("123456"));
        assert_ne!(new_pair_code(), code);
    }

    #[test]
    fn scopes_always_include_view() {
        let scopes = ScopeSet::from_strings(&["prompt".to_string()]);
        assert!(scopes.contains(Scope::View));
        assert!(scopes.contains(Scope::Prompt));
        assert!(!scopes.contains(Scope::Respond));
    }

    #[test]
    fn rate_limiter_blocks_after_the_budget() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..3 {
            assert!(limiter.allow("ip", 3, window));
        }
        assert!(!limiter.allow("ip", 3, window));
        assert!(limiter.allow("other-ip", 3, window));
    }

    #[test]
    fn failures_lock_out_exponentially() {
        let limiter = RateLimiter::new();
        for _ in 0..4 {
            assert_eq!(limiter.record_failure("ip"), Duration::ZERO);
        }
        assert!(limiter.record_failure("ip") >= Duration::from_secs(30));
        assert!(limiter.locked_for("ip").is_some());
        limiter.clear_failures("ip");
        assert!(limiter.locked_for("ip").is_none());
    }
}
