//! Host-confirmed device pairing.
//!
//! A code is 128 bits, expires after two minutes, is single use, and is stored
//! only as a hash. A successful claim does **not** issue a token by itself: the
//! host sees `Pair <device name>?` and must confirm before the waiting device
//! receives its one-time token. A new device always starts with Status only.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::Notify;

use crate::remote::auth::{
    constant_time_eq, hash_pin, hash_token, new_pair_code, new_token, valid_pair_code, valid_pin,
};
use crate::store::{NewRemoteDevice, Store, now_iso};

pub const PAIR_CODE_TTL_SECONDS: i64 = 2 * 60;
pub const MAX_ATTEMPTS: u8 = 5;
pub const CLAIM_TTL_SECONDS: u64 = 90;
/// At most this many requests may sit waiting for the host at once. The host
/// has to answer or deny one before another device can join the queue.
pub const MAX_PENDING_CLAIMS: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedCode {
    pub code: String,
    pub expires_at: DateTime<Utc>,
    pub expires_in_seconds: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairing {
    pub id: String,
    pub device_name: String,
    pub requested_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    pub has_pin: bool,
    /// Four digits shown on the waiting device. The host must compare it and
    /// send it back before the device receives a token.
    pub verification_code: String,
}

/// What the host is allowed to see after confirming. The token is deliberately
/// absent: it belongs to the waiting device and is handed out exactly once by
/// `poll_claim`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedPairing {
    pub device_id: String,
    pub device_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPoll {
    pub status: ClaimStatusView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatusView {
    Pending,
    Confirmed,
    Denied,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingError {
    NoCode,
    Expired,
    TooManyAttempts,
    Invalid,
    ClaimNotFound,
    AlreadyResolved,
    BadPin,
    BadVerification,
    VerificationMismatch,
    Internal,
    Busy,
}

impl PairingError {
    pub fn message(self) -> &'static str {
        match self {
            Self::NoCode => "There is no active pairing code. Create one on the host first.",
            Self::Expired => "That pairing code expired. Create a new code on the host.",
            Self::TooManyAttempts => {
                "That pairing code was entered too many times. Create a new code on the host."
            }
            Self::Invalid => "That pairing code is not correct.",
            Self::ClaimNotFound => "That pairing request is no longer waiting.",
            Self::AlreadyResolved => "That pairing request was already answered.",
            Self::BadPin => "The PIN must be 6 to 12 digits.",
            Self::BadVerification => "The verification code must be four digits.",
            Self::VerificationMismatch => {
                "That verification code does not match the one shown on the device."
            }
            Self::Internal => "Pandu could not secure the PIN. Try pairing again.",
            Self::Busy => {
                "Too many pairing requests are waiting for the host. Answer or deny one first."
            }
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::NoCode => "no_pairing_code",
            Self::Expired => "pairing_expired",
            Self::TooManyAttempts => "pairing_locked",
            Self::Invalid => "pairing_invalid",
            Self::ClaimNotFound => "pairing_missing",
            Self::AlreadyResolved => "pairing_resolved",
            Self::BadPin => "pairing_bad_pin",
            Self::BadVerification => "pairing_bad_verification",
            Self::VerificationMismatch => "pairing_verification_mismatch",
            Self::Internal => "pairing_internal",
            Self::Busy => "pairing_busy",
        }
    }
}

impl std::fmt::Display for PairingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for PairingError {}

pub type PairingResult<T> = std::result::Result<T, PairingError>;

pub struct PairingManager {
    store: Arc<Store>,
    state: Mutex<PairingState>,
}

#[derive(Default)]
struct PairingState {
    code: Option<PendingCode>,
    claims: HashMap<String, PendingClaim>,
}

struct PendingCode {
    hash: [u8; 32],
    expires_at: DateTime<Utc>,
    attempts: u8,
}

struct PendingClaim {
    id: String,
    secret: String,
    device_name: String,
    verification_code: String,
    pin_salt: Option<String>,
    pin_hash: Option<String>,
    ip: Option<String>,
    requested_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    status: ClaimStatus,
    notify: Arc<Notify>,
    token: Option<String>,
    confirmed: Option<ConfirmedPairing>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimStatus {
    Pending,
    Confirmed,
    Denied,
}

#[derive(Debug)]
pub struct ClaimTicket {
    pub claim_id: String,
    pub claim_secret: String,
    notify: Arc<Notify>,
}

#[derive(Debug, Clone)]
pub struct ConfirmedPairingWithToken {
    pub device_id: String,
    pub device_name: String,
    pub token: String,
    pub created_at: String,
}

#[derive(Debug)]
pub enum ClaimOutcome {
    Confirmed(ConfirmedPairingWithToken),
    Denied,
    Expired,
}

impl PairingManager {
    pub fn new(store: Arc<Store>) -> Arc<Self> {
        Arc::new(Self {
            store,
            state: Mutex::new(PairingState::default()),
        })
    }

    /// Issue a fresh code. Issuing a new code replaces any code still active.
    pub fn issue_code(&self) -> IssuedCode {
        let code = new_pair_code();
        let expires_at = Utc::now() + chrono::Duration::seconds(PAIR_CODE_TTL_SECONDS);
        let mut state = self.lock();
        state.code = Some(PendingCode {
            hash: hash_bytes(&code),
            expires_at,
            attempts: 0,
        });
        IssuedCode {
            code,
            expires_at,
            expires_in_seconds: PAIR_CODE_TTL_SECONDS,
        }
    }

    pub fn active_code_expires_at(&self) -> Option<DateTime<Utc>> {
        let mut state = self.lock();
        expire_code_if_needed(&mut state);
        state.code.as_ref().map(|code| code.expires_at)
    }

    /// Consume a code and open a claim that waits for host confirmation. The
    /// device chooses the four-digit verification code it displays; the host
    /// must echo it before the claim is confirmed.
    pub fn begin_claim(
        &self,
        code: &str,
        device_name: &str,
        pin: Option<&str>,
        verification_code: &str,
        ip: Option<&str>,
    ) -> PairingResult<ClaimTicket> {
        let normalized = code.trim().to_ascii_lowercase();
        if !valid_pair_code(&normalized) {
            return Err(PairingError::Invalid);
        }
        let verification_code = verification_code.trim();
        if !valid_verification_code(verification_code) {
            return Err(PairingError::BadVerification);
        }
        let pin = pin.map(str::trim).filter(|value| !value.is_empty());
        if pin.is_some_and(|value| !valid_pin(value)) {
            return Err(PairingError::BadPin);
        }

        let mut state = self.lock();
        let expired = expire_code_if_needed(&mut state);
        let Some(pending) = state.code.as_mut() else {
            return Err(if expired {
                PairingError::Expired
            } else {
                PairingError::NoCode
            });
        };
        if pending.attempts >= MAX_ATTEMPTS {
            state.code = None;
            return Err(PairingError::TooManyAttempts);
        }
        if !constant_time_eq(&hash_bytes(&normalized), &pending.hash) {
            pending.attempts = pending.attempts.saturating_add(1);
            let exhausted = pending.attempts >= MAX_ATTEMPTS;
            if exhausted {
                state.code = None;
            }
            return Err(if exhausted {
                PairingError::TooManyAttempts
            } else {
                PairingError::Invalid
            });
        }

        // The code stays active when the queue is full so the user can answer a
        // waiting request and retry without creating a new code.
        expire_claims(&mut state);
        let waiting = state
            .claims
            .values()
            .filter(|claim| claim.status == ClaimStatus::Pending)
            .count();
        if waiting >= MAX_PENDING_CLAIMS {
            return Err(PairingError::Busy);
        }

        // The code is single use, even if the host later denies the request.
        state.code = None;
        let claim_id = uuid::Uuid::new_v4().to_string();
        let claim_secret = new_token();
        let notify = Arc::new(Notify::new());
        let (pin_salt, pin_hash) = match pin {
            Some(pin) => {
                let hash = hash_pin(pin).ok_or(PairingError::Internal)?;
                (None, Some(hash))
            }
            None => (None, None),
        };
        let device_name = clean_device_name(device_name);
        state.claims.insert(
            claim_id.clone(),
            PendingClaim {
                id: claim_id.clone(),
                secret: claim_secret.clone(),
                device_name,
                verification_code: verification_code.to_string(),
                pin_salt,
                pin_hash,
                ip: ip.map(str::to_string),
                requested_at: Utc::now(),
                expires_at: Utc::now() + chrono::Duration::seconds(CLAIM_TTL_SECONDS as i64),
                status: ClaimStatus::Pending,
                notify: notify.clone(),
                token: None,
                confirmed: None,
            },
        );
        Ok(ClaimTicket {
            claim_id,
            claim_secret,
            notify,
        })
    }

    /// Wait for the host to confirm or deny. The claim is removed when it
    /// resolves so a token can only be handed out once.
    pub async fn wait_for_claim(&self, ticket: ClaimTicket) -> ClaimOutcome {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(CLAIM_TTL_SECONDS);
        loop {
            if let Some(outcome) = self.take_resolved(&ticket.claim_id) {
                return outcome;
            }
            if tokio::time::Instant::now() >= deadline {
                return self.expire_claim(&ticket.claim_id);
            }
            tokio::select! {
                _ = ticket.notify.notified() => {}
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    fn take_resolved(&self, claim_id: &str) -> Option<ClaimOutcome> {
        let mut state = self.lock();
        let claim = state.claims.get(claim_id)?;
        match claim.status {
            ClaimStatus::Pending => None,
            ClaimStatus::Denied => {
                state.claims.remove(claim_id);
                Some(ClaimOutcome::Denied)
            }
            ClaimStatus::Confirmed => {
                let claim = state.claims.remove(claim_id)?;
                let (Some(confirmed), Some(token)) = (claim.confirmed, claim.token) else {
                    return Some(ClaimOutcome::Denied);
                };
                Some(ClaimOutcome::Confirmed(ConfirmedPairingWithToken {
                    device_id: confirmed.device_id,
                    device_name: confirmed.device_name,
                    token,
                    created_at: confirmed.created_at,
                }))
            }
        }
    }

    fn expire_claim(&self, claim_id: &str) -> ClaimOutcome {
        let mut state = self.lock();
        state.claims.remove(claim_id);
        ClaimOutcome::Expired
    }

    pub fn pending(&self) -> Vec<PendingPairing> {
        let mut state = self.lock();
        expire_claims(&mut state);
        let mut pending: Vec<PendingPairing> = state
            .claims
            .values()
            .filter(|claim| claim.status == ClaimStatus::Pending)
            .map(|claim| PendingPairing {
                id: claim.id.clone(),
                device_name: claim.device_name.clone(),
                requested_at: claim.requested_at,
                ip: claim.ip.clone(),
                has_pin: claim.pin_hash.is_some(),
                verification_code: claim.verification_code.clone(),
            })
            .collect();
        pending.sort_by_key(|left| left.requested_at);
        pending
    }

    /// Host confirmation. Creates the device with Status only and hands the
    /// one-time token to the waiting claim. The host must send the four-digit
    /// code the device is showing.
    pub fn confirm(
        &self,
        claim_id: &str,
        verification_code: &str,
        expires_at: Option<String>,
    ) -> PairingResult<ConfirmedPairing> {
        let mut state = self.lock();
        let claim = state
            .claims
            .get_mut(claim_id)
            .ok_or(PairingError::ClaimNotFound)?;
        if claim.status != ClaimStatus::Pending {
            return Err(PairingError::AlreadyResolved);
        }
        if claim.expires_at <= Utc::now() {
            state.claims.remove(claim_id);
            return Err(PairingError::Expired);
        }
        if !constant_time_eq(
            claim.verification_code.as_bytes(),
            verification_code.trim().as_bytes(),
        ) {
            return Err(PairingError::VerificationMismatch);
        }

        let token = new_token();
        let device_id = uuid::Uuid::new_v4().to_string();
        let created_at = now_iso();
        self.store
            .insert_remote_device(&NewRemoteDevice {
                id: device_id.clone(),
                name: claim.device_name.clone(),
                token_hash: hash_token(&token),
                pin_salt: claim.pin_salt.clone(),
                pin_hash: claim.pin_hash.clone(),
                scopes: vec!["view:status".to_string()],
                require_host_confirmation: true,
                expires_at,
                created_at: created_at.clone(),
            })
            .map_err(|_| PairingError::ClaimNotFound)?;
        let confirmed = ConfirmedPairing {
            device_id,
            device_name: claim.device_name.clone(),
            created_at,
        };
        claim.status = ClaimStatus::Confirmed;
        claim.token = Some(token);
        claim.confirmed = Some(confirmed.clone());
        claim.notify.notify_waiters();
        Ok(confirmed)
    }

    /// Poll a claim using the one-time secret returned by `begin_claim`.
    /// A confirmed claim hands out its token exactly once.
    pub fn poll_claim(&self, claim_id: &str, secret: &str) -> PairingResult<ClaimPoll> {
        let mut state = self.lock();
        let (status, device_name, expired) = {
            let Some(claim) = state.claims.get(claim_id) else {
                return Ok(ClaimPoll {
                    status: ClaimStatusView::Expired,
                    device_id: None,
                    device_name: None,
                    token: None,
                    created_at: None,
                });
            };
            if !constant_time_eq(claim.secret.as_bytes(), secret.as_bytes()) {
                return Err(PairingError::ClaimNotFound);
            }
            (
                claim.status,
                claim.device_name.clone(),
                claim.status == ClaimStatus::Pending && claim.expires_at <= Utc::now(),
            )
        };
        if expired {
            state.claims.remove(claim_id);
            return Ok(ClaimPoll {
                status: ClaimStatusView::Expired,
                device_id: None,
                device_name: Some(device_name),
                token: None,
                created_at: None,
            });
        }
        match status {
            ClaimStatus::Pending => Ok(ClaimPoll {
                status: ClaimStatusView::Pending,
                device_id: None,
                device_name: Some(device_name),
                token: None,
                created_at: None,
            }),
            ClaimStatus::Denied => {
                state.claims.remove(claim_id);
                Ok(ClaimPoll {
                    status: ClaimStatusView::Denied,
                    device_id: None,
                    device_name: Some(device_name),
                    token: None,
                    created_at: None,
                })
            }
            ClaimStatus::Confirmed => {
                let Some(claim) = state.claims.remove(claim_id) else {
                    return Ok(ClaimPoll {
                        status: ClaimStatusView::Expired,
                        device_id: None,
                        device_name: Some(device_name),
                        token: None,
                        created_at: None,
                    });
                };
                let Some(token) = claim.token else {
                    return Ok(ClaimPoll {
                        status: ClaimStatusView::Denied,
                        device_id: None,
                        device_name: Some(device_name),
                        token: None,
                        created_at: None,
                    });
                };
                Ok(ClaimPoll {
                    status: ClaimStatusView::Confirmed,
                    device_id: claim.confirmed.as_ref().map(|item| item.device_id.clone()),
                    device_name: Some(claim.device_name),
                    token: Some(token),
                    created_at: claim.confirmed.map(|item| item.created_at),
                })
            }
        }
    }

    pub fn deny(&self, claim_id: &str) -> PairingResult<()> {
        let mut state = self.lock();
        let claim = state
            .claims
            .get_mut(claim_id)
            .ok_or(PairingError::ClaimNotFound)?;
        if claim.status != ClaimStatus::Pending {
            return Err(PairingError::AlreadyResolved);
        }
        claim.status = ClaimStatus::Denied;
        claim.notify.notify_waiters();
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PairingState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

fn valid_verification_code(value: &str) -> bool {
    value.len() == 4 && value.chars().all(|character| character.is_ascii_digit())
}

fn clean_device_name(value: &str) -> String {
    let name: String = value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    if name.is_empty() {
        "Unnamed device".to_string()
    } else {
        name
    }
}

fn expire_code_if_needed(state: &mut PairingState) -> bool {
    let expired = state
        .code
        .as_ref()
        .is_some_and(|code| code.expires_at <= Utc::now());
    if expired {
        state.code = None;
    }
    expired
}

fn expire_claims(state: &mut PairingState) {
    let now = Utc::now();
    state
        .claims
        .retain(|_, claim| claim.status != ClaimStatus::Pending || claim.expires_at > now);
}

fn hash_bytes(value: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(value.as_bytes());
    let mut output = [0u8; 32];
    output.copy_from_slice(&digest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERIFY: &str = "4821";

    fn manager() -> Arc<PairingManager> {
        let store = Arc::new(Store::open(":memory:").expect("in-memory store"));
        PairingManager::new(store)
    }

    #[tokio::test]
    async fn a_claim_waits_for_the_host_and_the_code_is_single_use() {
        let pairing = manager();
        let issued = pairing.issue_code();
        assert_eq!(issued.code.len(), 32);

        let ticket = pairing
            .begin_claim(
                &issued.code,
                "Pixel",
                Some("123456"),
                VERIFY,
                Some("127.0.0.1"),
            )
            .expect("claim starts");
        assert_eq!(pairing.pending().len(), 1);
        assert_eq!(pairing.pending()[0].device_name, "Pixel");
        assert_eq!(pairing.pending()[0].verification_code, VERIFY);

        // The code is consumed even before the host answers.
        assert!(
            pairing
                .begin_claim(&issued.code, "Other", None, VERIFY, None)
                .is_err()
        );

        // A wrong verification code leaves the claim waiting.
        assert_eq!(
            pairing.confirm(&ticket.claim_id, "0000", None).unwrap_err(),
            PairingError::VerificationMismatch
        );
        assert_eq!(pairing.pending().len(), 1);

        let confirmed = pairing
            .confirm(&ticket.claim_id, VERIFY, None)
            .expect("host confirms");
        assert_eq!(confirmed.device_name, "Pixel");
        let outcome = pairing.wait_for_claim(ticket).await;
        match outcome {
            ClaimOutcome::Confirmed(claim) => {
                assert_eq!(claim.device_id, confirmed.device_id);
                assert_eq!(claim.token.len(), 64);
                assert_eq!(claim.device_name, "Pixel");
            }
            other => panic!("expected confirmation, got {other:?}"),
        }
        let devices = pairing.store.list_remote_devices().unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].scopes, vec!["view:status".to_string()]);
        let hash = devices[0].pin_hash.as_deref().unwrap();
        assert!(hash.starts_with("$argon2"));
        assert!(devices[0].pin_salt.is_none());
    }

    #[tokio::test]
    async fn a_denied_claim_never_issues_a_token() {
        let pairing = manager();
        let issued = pairing.issue_code();
        let ticket = pairing
            .begin_claim(&issued.code, "Laptop", None, VERIFY, None)
            .unwrap();
        pairing.deny(&ticket.claim_id).unwrap();
        assert!(matches!(
            pairing.wait_for_claim(ticket).await,
            ClaimOutcome::Denied
        ));
        assert!(pairing.store.list_remote_devices().unwrap().is_empty());
    }

    #[test]
    fn a_wrong_code_is_limited_and_locks_the_code() {
        let pairing = manager();
        let issued = pairing.issue_code();
        for _ in 0..MAX_ATTEMPTS - 1 {
            assert_eq!(
                pairing
                    .begin_claim(&"0".repeat(32), "X", None, VERIFY, None)
                    .unwrap_err(),
                PairingError::Invalid
            );
        }
        assert_eq!(
            pairing
                .begin_claim(&"0".repeat(32), "X", None, VERIFY, None)
                .unwrap_err(),
            PairingError::TooManyAttempts
        );
        // Even the correct code is gone after the attempt limit.
        assert!(
            pairing
                .begin_claim(&issued.code, "X", None, VERIFY, None)
                .is_err()
        );
    }

    #[test]
    fn an_expired_code_is_refused() {
        let pairing = manager();
        let issued = pairing.issue_code();
        {
            let mut state = pairing.lock();
            state.code.as_mut().unwrap().expires_at = Utc::now() - chrono::Duration::seconds(1);
        }
        assert_eq!(
            pairing
                .begin_claim(&issued.code, "X", None, VERIFY, None)
                .unwrap_err(),
            PairingError::Expired
        );
    }

    #[test]
    fn malformed_codes_pins_and_verification_codes_are_rejected() {
        let pairing = manager();
        let issued = pairing.issue_code();
        assert_eq!(
            pairing
                .begin_claim("123456", "X", None, VERIFY, None)
                .unwrap_err(),
            PairingError::Invalid
        );
        assert_eq!(
            pairing
                .begin_claim(&issued.code, "X", Some("12345"), VERIFY, None)
                .unwrap_err(),
            PairingError::BadPin
        );
        assert_eq!(
            pairing
                .begin_claim(&issued.code, "X", None, "12", None)
                .unwrap_err(),
            PairingError::BadVerification
        );
        assert_eq!(
            pairing
                .begin_claim(&issued.code, "X", None, "12a4", None)
                .unwrap_err(),
            PairingError::BadVerification
        );
        // None of the malformed attempts consumed the code.
        assert!(
            pairing
                .begin_claim(&issued.code, "X", None, VERIFY, None)
                .is_ok()
        );
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let pairing = manager();
        let first = pairing.issue_code();
        let second = pairing.issue_code();
        assert!(
            pairing
                .begin_claim(&first.code, "X", None, VERIFY, None)
                .is_err()
        );
        assert!(
            pairing
                .begin_claim(&second.code, "X", None, VERIFY, None)
                .is_ok()
        );
    }

    #[test]
    fn only_three_claims_wait_for_the_host_at_once() {
        let pairing = manager();
        let mut tickets = Vec::new();
        for index in 0..MAX_PENDING_CLAIMS {
            let issued = pairing.issue_code();
            let ticket = pairing
                .begin_claim(&issued.code, &format!("Device {index}"), None, VERIFY, None)
                .expect("claim starts below the cap");
            tickets.push(ticket);
        }
        assert_eq!(pairing.pending().len(), MAX_PENDING_CLAIMS);

        let issued = pairing.issue_code();
        assert_eq!(
            pairing
                .begin_claim(&issued.code, "Extra", None, VERIFY, None)
                .unwrap_err(),
            PairingError::Busy
        );
        // A full queue does not burn the code; the host can answer one and the
        // waiting device can retry.
        pairing.deny(&tickets[0].claim_id).unwrap();
        assert!(
            pairing
                .begin_claim(&issued.code, "Extra", None, VERIFY, None)
                .is_ok()
        );
    }
}
