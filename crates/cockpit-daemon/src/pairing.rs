//! Pairing codes for the future phone companion.
//!
//! A code is six digits, expires after five minutes, can be claimed once, and
//! is stored only as a SHA-256 hash. A claim returns a random device token; the
//! daemon stores the token hash too. Token authentication of non-loopback
//! requests lands in Phase 6, but issuing and claiming a code works now.

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use rand::RngCore;
use rand::rngs::OsRng;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const CODE_TTL_SECONDS: i64 = 5 * 60;
pub const MAX_ATTEMPTS: u8 = 5;
const TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    pub expires_at: DateTime<Utc>,
    pub expires_in_seconds: i64,
    pub attempts_remaining: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedDevice {
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub claimed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub claimed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    pub attempts_remaining: u8,
    pub devices: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingError {
    NoCode,
    Expired,
    TooManyAttempts,
    Invalid,
}

impl PairingError {
    pub fn message(self) -> &'static str {
        match self {
            Self::NoCode => "There is no active pairing code. Run `cockpit pair` first.",
            Self::Expired => "That pairing code has expired. Run `cockpit pair` for a new one.",
            Self::TooManyAttempts => {
                "That pairing code was entered too many times. Run `cockpit pair` for a new one."
            }
            Self::Invalid => "That pairing code is not correct.",
        }
    }
}

impl std::fmt::Display for PairingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for PairingError {}

pub struct PairingManager {
    state: Mutex<PairingState>,
}

#[derive(Default)]
struct PairingState {
    pending: Option<PendingCode>,
    devices: Vec<Device>,
}

struct PendingCode {
    hash: [u8; 32],
    expires_at: DateTime<Utc>,
    attempts: u8,
}

struct Device {
    token_hash: [u8; 32],
    name: Option<String>,
    claimed_at: DateTime<Utc>,
}

impl PairingManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(PairingState::default()),
        })
    }

    /// Issue a fresh code. Issuing a new code replaces any code that is still
    /// active, so only the most recently printed code works.
    pub fn issue_code(&self) -> PairingCode {
        let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
        let expires_at = Utc::now() + Duration::seconds(CODE_TTL_SECONDS);
        let mut state = self.lock();
        state.pending = Some(PendingCode {
            hash: hash(&code),
            expires_at,
            attempts: 0,
        });
        PairingCode {
            code,
            expires_at,
            expires_in_seconds: CODE_TTL_SECONDS,
            attempts_remaining: MAX_ATTEMPTS,
        }
    }

    pub fn status(&self) -> PairingStatus {
        let mut state = self.lock();
        expire_if_needed(&mut state);
        match &state.pending {
            Some(pending) => PairingStatus {
                active: true,
                expires_at: Some(pending.expires_at),
                attempts_remaining: MAX_ATTEMPTS.saturating_sub(pending.attempts),
                devices: state.devices.len(),
            },
            None => PairingStatus {
                active: false,
                expires_at: None,
                attempts_remaining: 0,
                devices: state.devices.len(),
            },
        }
    }

    /// Claim a code. A successful claim consumes the code and returns a device
    /// token. The token is shown once; only its hash is kept.
    pub fn claim(
        &self,
        code: &str,
        device_name: Option<&str>,
    ) -> std::result::Result<ClaimedDevice, PairingError> {
        let normalized = code.trim();
        if normalized.len() != 6 || !normalized.chars().all(|ch| ch.is_ascii_digit()) {
            return Err(PairingError::Invalid);
        }

        let mut state = self.lock();
        let expired = expire_if_needed(&mut state);
        let Some(pending) = state.pending.as_mut() else {
            return Err(if expired {
                PairingError::Expired
            } else {
                PairingError::NoCode
            });
        };
        if pending.attempts >= MAX_ATTEMPTS {
            state.pending = None;
            return Err(PairingError::TooManyAttempts);
        }
        if hash(normalized) != pending.hash {
            pending.attempts += 1;
            let exhausted = pending.attempts >= MAX_ATTEMPTS;
            if exhausted {
                state.pending = None;
            }
            return Err(if exhausted {
                PairingError::TooManyAttempts
            } else {
                PairingError::Invalid
            });
        }

        let mut bytes = [0u8; TOKEN_BYTES];
        OsRng.fill_bytes(&mut bytes);
        let token = hex(&bytes);
        let claimed_at = Utc::now();
        let name = device_name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| name.chars().take(80).collect::<String>());
        state.devices.push(Device {
            token_hash: hash(&token),
            name: name.clone(),
            claimed_at,
        });
        // The code is single use.
        state.pending = None;
        Ok(ClaimedDevice {
            token,
            device_name: name,
            claimed_at,
        })
    }

    /// Check a token presented by a device. Phase 6 will require this on every
    /// non-loopback request; the endpoint exists now so pairing can be tested.
    pub fn verify_token(&self, token: &str) -> bool {
        let wanted = hash(token);
        let state = self.lock();
        state
            .devices
            .iter()
            .any(|device| constant_time_eq(&device.token_hash, &wanted))
    }

    /// Paired devices, without any secret material.
    pub fn paired_devices(&self) -> Vec<PairedDevice> {
        let state = self.lock();
        state
            .devices
            .iter()
            .map(|device| PairedDevice {
                name: device.name.clone(),
                claimed_at: device.claimed_at,
            })
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PairingState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

fn expire_if_needed(state: &mut PairingState) -> bool {
    let expired = state
        .pending
        .as_ref()
        .is_some_and(|pending| pending.expires_at <= Utc::now());
    if expired {
        state.pending = None;
    }
    expired
}

fn hash(value: &str) -> [u8; 32] {
    let digest = Sha256::digest(value.as_bytes());
    let mut output = [0u8; 32];
    output.copy_from_slice(&digest);
    output
}

fn constant_time_eq(left: &[u8; 32], right: &[u8; 32]) -> bool {
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= left ^ right;
    }
    difference == 0
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
    fn a_claimed_code_is_single_use() {
        let pairing = PairingManager::new();
        let issued = pairing.issue_code();
        assert_eq!(issued.code.len(), 6);

        let claimed = pairing.claim(&issued.code, Some("Pixel")).unwrap();
        assert_eq!(claimed.token.len(), 64);
        assert_eq!(claimed.device_name.as_deref(), Some("Pixel"));
        assert!(pairing.verify_token(&claimed.token));

        assert_eq!(
            pairing.claim(&issued.code, None).unwrap_err().to_string(),
            PairingError::NoCode.message()
        );
        assert_eq!(pairing.status().devices, 1);
    }

    #[test]
    fn a_wrong_code_is_limited() {
        let pairing = PairingManager::new();
        let issued = pairing.issue_code();
        for _ in 0..MAX_ATTEMPTS - 1 {
            let error = pairing.claim("000000", None).unwrap_err();
            assert_eq!(error.to_string(), PairingError::Invalid.message());
        }
        let error = pairing.claim("000000", None).unwrap_err();
        assert_eq!(error.to_string(), PairingError::TooManyAttempts.message());
        assert!(!pairing.status().active);
        // The correct code is gone after the attempt limit.
        assert!(pairing.claim(&issued.code, None).is_err());
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let pairing = PairingManager::new();
        let first = pairing.issue_code();
        let second = pairing.issue_code();
        assert!(pairing.claim(&first.code, None).is_err());
        assert!(pairing.claim(&second.code, None).is_ok());
    }

    #[test]
    fn malformed_codes_are_rejected_without_using_an_attempt() {
        let pairing = PairingManager::new();
        let issued = pairing.issue_code();
        assert!(pairing.claim("12ab", None).is_err());
        assert_eq!(pairing.status().attempts_remaining, MAX_ATTEMPTS);
        assert!(pairing.claim(&issued.code, None).is_ok());
    }
}
