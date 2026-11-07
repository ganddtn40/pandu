use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// Deterministic similarity primitives used by the loop detector.
///
/// These are intentionally simple, fast, and dependency-free. No embeddings
/// and no network calls: identical local input produces identical scores on
/// every machine.
fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn shingles(value: &str, size: usize) -> HashSet<String> {
    let normalized = normalize(value);
    if normalized.is_empty() {
        return HashSet::new();
    }
    let characters: Vec<char> = normalized.chars().collect();
    if characters.len() <= size {
        return HashSet::from([normalized]);
    }

    (0..=characters.len() - size)
        .map(|index| characters[index..index + size].iter().collect())
        .collect()
}

fn jaccard(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    let intersection = left.iter().filter(|item| right.contains(*item)).count();
    let union = left.len() + right.len() - intersection;
    if union == 0 {
        1.0
    } else {
        intersection as f64 / union as f64
    }
}

/// Character trigram Jaccard similarity. Useful for tool calls and error text
/// where small edits should still count as near duplicates.
pub fn text_similarity(left: &str, right: &str) -> f64 {
    if normalize(left) == normalize(right) {
        return 1.0;
    }
    jaccard(&shingles(left, 3), &shingles(right, 3))
}

static TOKEN_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}_./-]+").expect("valid token regex"));

fn token_set(value: &str) -> HashSet<String> {
    TOKEN_PATTERN
        .find_iter(&value.to_lowercase())
        .map(|item| item.as_str().to_string())
        .collect()
}

/// Token Jaccard similarity. Punctuation and formatting changes are ignored,
/// which makes it a better fit for near-identical command or error signatures.
pub fn token_similarity(left: &str, right: &str) -> f64 {
    jaccard(&token_set(left), &token_set(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_is_one() {
        assert_eq!(text_similarity("deploy the app", "Deploy   the APP"), 1.0);
        assert_eq!(token_similarity("deploy the app", "deploy the app"), 1.0);
    }

    #[test]
    fn empty_values_are_similar() {
        assert_eq!(text_similarity("", ""), 1.0);
        assert_eq!(token_similarity("", ""), 1.0);
    }

    #[test]
    fn small_edits_stay_close() {
        let score = text_similarity("cargo test --workspace", "cargo test --workspace all");
        assert!(score > 0.5, "score was {score}");
    }

    #[test]
    fn different_tokens_are_far() {
        let score = token_similarity("run the tests", "paint the fence");
        assert!(score < 0.5, "score was {score}");
    }

    #[test]
    fn punctuation_is_ignored_for_tokens() {
        assert_eq!(token_similarity("deploy: api, now!", "deploy api now"), 1.0);
    }
}
