//! Ed25519 signing helpers for the registry.
//!
//! The private key is a 32-byte seed kept offline by maintainers. It is never
//! embedded in the binary or the repository. The public key is embedded in
//! `market::mod` and every index and revocation list is verified against it
//! before Cockpit parses an entry.

use std::path::Path;

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde_json::Value;

use super::{
    ACTIVE_INDEX_FILE, ACTIVE_REVOKED_FILE, MarketError, SignedIndex, SignedRevocation,
    canonical_json, verify_signature,
};

pub const KEY_HEADER: &str = "-----BEGIN COCKPIT MARKET SIGNING KEY-----";
pub const KEY_FOOTER: &str = "-----END COCKPIT MARKET SIGNING KEY-----";

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode(value: &str) -> Result<Vec<u8>, MarketError> {
    base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| MarketError::Signature("The signing key is not valid base64.".into()))
}

/// Generate a keypair. Returns `(public_key_base64, private_key_file_contents)`.
pub fn generate() -> (String, String) {
    let signing = SigningKey::generate(&mut OsRng);
    let public = encode(signing.verifying_key().as_bytes());
    let private = format!(
        "{KEY_HEADER}\n{}\n{KEY_FOOTER}\n",
        encode(&signing.to_bytes())
    );
    (public, private)
}

pub fn load_signing_key(path: &Path) -> Result<SigningKey, MarketError> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        MarketError::Signature(format!(
            "Could not read the signing key {}: {error}",
            path.display()
        ))
    })?;
    let encoded: String = text
        .lines()
        .filter(|line| !line.trim_start().starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    let bytes = decode(&encoded)?;
    let seed: [u8; 32] = bytes.try_into().map_err(|_| {
        MarketError::Signature("The signing key must be a 32-byte Ed25519 seed.".into())
    })?;
    Ok(SigningKey::from_bytes(&seed))
}

pub fn save_signing_key(path: &Path, contents: &str) -> Result<(), MarketError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            MarketError::Signature(format!("Could not create the key directory: {error}"))
        })?;
    }
    std::fs::write(path, contents).map_err(|error| {
        MarketError::Signature(format!("Could not write the signing key: {error}"))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn public_key_base64(key: &SigningKey) -> String {
    encode(key.verifying_key().as_bytes())
}

pub fn sign_value(value: &Value, key: &SigningKey) -> String {
    let signature = key.sign(&canonical_json(value));
    encode(&signature.to_bytes())
}

pub fn sign_index(index: &mut SignedIndex, key: &SigningKey) {
    index.signature = sign_value(&index.payload(), key);
}

pub fn sign_revocation(revoked: &mut SignedRevocation, key: &SigningKey) {
    revoked.signature = sign_value(&revoked.payload(), key);
}

/// Verify a payload against an arbitrary public key. Used by tests and the
/// maintainer tooling; the daemon always uses the embedded key.
pub fn verify_with_public_key(
    payload: &Value,
    signature_base64: &str,
    public_key_base64: &str,
) -> Result<(), MarketError> {
    let public = decode(public_key_base64)?;
    let public: [u8; 32] = public
        .try_into()
        .map_err(|_| MarketError::Signature("The public key must be 32 bytes.".into()))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&public)
        .map_err(|_| MarketError::Signature("The public key is invalid.".into()))?;
    let signature = decode(signature_base64)?;
    let signature: [u8; 64] = signature
        .try_into()
        .map_err(|_| MarketError::Signature("The signature must be 64 bytes.".into()))?;
    key.verify_strict(
        &canonical_json(payload),
        &ed25519_dalek::Signature::from_bytes(&signature),
    )
    .map_err(|_| MarketError::Signature("The signature is invalid.".into()))
}

/// Sign the active registry variant in a directory in place. Debug builds sign
/// `index.test.json` / `revoked.test.json` with the test key; release builds
/// sign `index.json` / `revoked.json` with the production key. The JSON is
/// rewritten with the signature included, using the same camelCase shape the
/// daemon deserializes.
pub fn sign_registry_dir(dir: &Path, key: &SigningKey) -> Result<(), MarketError> {
    let index_path = dir.join(ACTIVE_INDEX_FILE);
    let index_bytes = std::fs::read(&index_path).map_err(|error| {
        MarketError::Registry(format!("Could not read {}: {error}", index_path.display()))
    })?;
    let mut index: SignedIndex = serde_json::from_slice(&index_bytes)
        .map_err(|error| MarketError::Registry(format!("index.json is invalid: {error}")))?;
    sign_index(&mut index, key);
    write_json(&index_path, &index)?;

    let revoked_path = dir.join(ACTIVE_REVOKED_FILE);
    let revoked_bytes = std::fs::read(&revoked_path).map_err(|error| {
        MarketError::Registry(format!(
            "Could not read {}: {error}",
            revoked_path.display()
        ))
    })?;
    let mut revoked: SignedRevocation = serde_json::from_slice(&revoked_bytes)
        .map_err(|error| MarketError::Registry(format!("revoked.json is invalid: {error}")))?;
    sign_revocation(&mut revoked, key);
    write_json(&revoked_path, &revoked)?;

    // Refuse to report success unless the embedded key accepts the result.
    verify_signature(&index.payload(), &index.signature)?;
    verify_signature(&revoked.payload(), &revoked.signature)?;
    Ok(())
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), MarketError> {
    let mut text = serde_json::to_string_pretty(value)
        .map_err(|error| MarketError::Registry(format!("Could not serialize JSON: {error}")))?;
    text.push('\n');
    std::fs::write(path, text).map_err(|error| {
        MarketError::Registry(format!("Could not write {}: {error}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn generated_keys_sign_and_verify() {
        let (public, private) = generate();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private.key");
        save_signing_key(&path, &private).unwrap();
        let key = load_signing_key(&path).unwrap();
        assert_eq!(public_key_base64(&key), public);
        let payload = json!({"b": 2, "a": 1});
        let signature = sign_value(&payload, &key);
        verify_with_public_key(&payload, &signature, &public).unwrap();
        assert!(verify_with_public_key(&json!({"a": 1, "b": 3}), &signature, &public).is_err());
    }
}
