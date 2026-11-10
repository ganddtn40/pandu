use uuid::Uuid;

/// Create a new random identifier.
///
/// Pandu uses UUID v4 strings everywhere so a flight can be identified by
/// the same value in SQLite, the API, and the UI.
pub fn create_id() -> String {
    Uuid::new_v4().to_string()
}

/// Return true when `value` is a canonical UUID string.
pub fn is_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_are_valid() {
        let id = create_id();
        assert!(is_id(&id));
        assert_ne!(id, create_id());
    }

    #[test]
    fn rejects_non_uuids() {
        assert!(!is_id("not-a-session"));
        assert!(!is_id(""));
    }
}
