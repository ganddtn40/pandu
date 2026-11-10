use std::collections::BTreeMap;

use axum::body::Body;
use axum::response::Response;
use http::StatusCode;
use http::header::{HeaderMap, HeaderName, HeaderValue};
use pandu_core::brand::{HEADER_PREFIX, SESSION_ID_HEADER, STEP_ID_HEADER};
use pandu_core::provider::ProviderProtocol;
use serde_json::json;

use crate::config::{Config, PROXY_KEY_SENTINEL};

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

const STRIPPED_REQUEST_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "accept-encoding",
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "cookie",
    "origin",
    "referer",
];

const STRIPPED_RESPONSE_HEADERS: &[&str] = &[
    "content-length",
    "content-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

pub fn is_sentinel(value: &str) -> bool {
    let trimmed = value.trim();
    let token = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .unwrap_or(trimmed)
        .trim();
    token.eq_ignore_ascii_case(PROXY_KEY_SENTINEL)
}

pub fn collect_header_map(headers: &HeaderMap) -> BTreeMap<String, String> {
    let mut record = BTreeMap::new();
    for (name, value) in headers.iter() {
        let name = name.as_str().to_ascii_lowercase();
        let value = value.to_str().unwrap_or_default();
        record
            .entry(name)
            .and_modify(|existing: &mut String| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.to_string());
    }
    record
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn set_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), value);
    }
}

/// Build the headers sent upstream.
///
/// Pandu never mutates credentials it does not own: an agent's auth header is
/// forwarded unchanged unless it is the literal `pandu-proxy` sentinel, in
/// which case the key from the environment is used.
pub fn build_upstream_headers(
    incoming: &HeaderMap,
    protocol: ProviderProtocol,
    config: &Config,
) -> HeaderMap {
    let mut headers = HeaderMap::new();

    for (name, value) in incoming.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.contains(&lower.as_str()) {
            continue;
        }
        if STRIPPED_REQUEST_HEADERS.contains(&lower.as_str()) {
            continue;
        }
        if lower.starts_with(HEADER_PREFIX) || lower.starts_with("sec-") {
            continue;
        }
        headers.append(name.clone(), value.clone());
    }

    headers.insert(
        HeaderName::from_static("accept-encoding"),
        HeaderValue::from_static("identity"),
    );

    let authorization = header_str(incoming, "authorization");
    let api_key = header_str(incoming, "x-api-key");
    let goog_key = header_str(incoming, "x-goog-api-key");

    match protocol {
        ProviderProtocol::Anthropic => {
            if let Some(key) = api_key.filter(|value| !is_sentinel(value)) {
                set_header(&mut headers, "x-api-key", key);
            } else if let Some(key) = config.anthropic.api_key.as_deref() {
                set_header(&mut headers, "x-api-key", key);
            }
            if let Some(value) = authorization.filter(|value| !is_sentinel(value)) {
                set_header(&mut headers, "authorization", value);
            }
            if !headers.contains_key("anthropic-version") {
                set_header(
                    &mut headers,
                    "anthropic-version",
                    config.anthropic.version.as_str(),
                );
            }
        }
        ProviderProtocol::Openai => {
            if let Some(key) = api_key.filter(|value| !is_sentinel(value)) {
                set_header(&mut headers, "x-api-key", key);
            }
            if let Some(key) = goog_key.filter(|value| !is_sentinel(value)) {
                set_header(&mut headers, "x-goog-api-key", key);
            }
            if let Some(value) = authorization.filter(|value| !is_sentinel(value)) {
                set_header(&mut headers, "authorization", value);
            } else if let Some(key) = config.openai.api_key.as_deref() {
                set_header(&mut headers, "authorization", &format!("Bearer {key}"));
            }
        }
        ProviderProtocol::Gemini => {
            if let Some(key) = goog_key.filter(|value| !is_sentinel(value)) {
                set_header(&mut headers, "x-goog-api-key", key);
            } else if let Some(key) = config.gemini.api_key.as_deref() {
                set_header(&mut headers, "x-goog-api-key", key);
            }
            if let Some(key) = api_key.filter(|value| !is_sentinel(value)) {
                set_header(&mut headers, "x-api-key", key);
            }
            if let Some(value) = authorization.filter(|value| !is_sentinel(value)) {
                set_header(&mut headers, "authorization", value);
            }
        }
    }

    headers
}

pub fn build_response_headers(
    upstream: &HeaderMap,
    stream: bool,
    session_id: Option<&str>,
    step_id: Option<&str>,
) -> HeaderMap {
    let mut headers = HeaderMap::new();

    for (name, value) in upstream.iter() {
        if STRIPPED_RESPONSE_HEADERS.contains(&name.as_str().to_ascii_lowercase().as_str()) {
            continue;
        }
        headers.append(name.clone(), value.clone());
    }

    if stream {
        headers.insert(
            HeaderName::from_static("cache-control"),
            HeaderValue::from_static("no-cache, no-transform"),
        );
        headers.insert(
            HeaderName::from_static("x-accel-buffering"),
            HeaderValue::from_static("no"),
        );
    }
    if let Some(session_id) = session_id {
        set_header(&mut headers, SESSION_ID_HEADER, session_id);
    }
    if let Some(step_id) = step_id {
        set_header(&mut headers, STEP_ID_HEADER, step_id);
    }

    headers
}

fn anthropic_error_type(status: StatusCode) -> &'static str {
    match status.as_u16() {
        429 => "rate_limit_error",
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        status if status >= 500 => "api_error",
        _ => "invalid_request_error",
    }
}

fn openai_error_type(status: StatusCode) -> &'static str {
    match status.as_u16() {
        429 => "rate_limit_error",
        401 => "authentication_error",
        status if status >= 500 => "proxy_error",
        _ => "invalid_request_error",
    }
}

fn gemini_error_status(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 => "INVALID_ARGUMENT",
        401 => "UNAUTHENTICATED",
        403 => "PERMISSION_DENIED",
        404 => "NOT_FOUND",
        409 => "ABORTED",
        429 => "RESOURCE_EXHAUSTED",
        500 => "INTERNAL",
        502 | 503 => "UNAVAILABLE",
        504 => "DEADLINE_EXCEEDED",
        _ => "UNKNOWN",
    }
}

pub fn proxy_error_response(
    protocol: ProviderProtocol,
    status: StatusCode,
    message: &str,
    code: Option<&str>,
) -> Response {
    let body = match protocol {
        ProviderProtocol::Anthropic => json!({
            "type": "error",
            "error": {
                "type": anthropic_error_type(status),
                "message": message,
                "code": code,
            }
        }),
        ProviderProtocol::Gemini => json!({
            "error": {
                "code": status.as_u16(),
                "message": message,
                "status": gemini_error_status(status),
            }
        }),
        ProviderProtocol::Openai => json!({
            "error": {
                "message": message,
                "type": openai_error_type(status),
                "code": code.unwrap_or_else(|| {
                    if status == StatusCode::PAYLOAD_TOO_LARGE {
                        "payload_too_large"
                    } else {
                        "proxy_error"
                    }
                }),
            }
        }),
    };

    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    response.headers_mut().insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

pub fn is_recordable_path(method: &http::Method, path: &str) -> bool {
    if method != http::Method::POST {
        return false;
    }
    let normalized = path.split('?').next().unwrap_or(path).trim_end_matches('/');

    normalized.ends_with("/chat/completions")
        || normalized.ends_with("/responses")
        || normalized.ends_with("/completions")
        || normalized.ends_with("/messages")
        || normalized.ends_with("/embeddings")
        || normalized.contains(":generateContent")
        || normalized.contains(":streamGenerateContent")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use pandu_core::brand::PROVIDER_HEADER;

    fn config() -> Config {
        let mut config = Config::for_home(".");
        config.openai.api_key = Some("openai-key".to_string());
        config.anthropic.api_key = Some("anthropic-key".to_string());
        config.gemini.api_key = Some("gemini-key".to_string());
        config
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        headers
    }

    #[test]
    fn forwards_agent_auth_and_strips_product_headers() {
        let incoming = headers(&[
            ("authorization", "Bearer agent-key"),
            (PROVIDER_HEADER, "deepseek"),
            ("content-type", "application/json"),
            ("host", "localhost:4319"),
        ]);
        let upstream = build_upstream_headers(&incoming, ProviderProtocol::Openai, &config());

        assert_eq!(upstream["authorization"], "Bearer agent-key");
        assert_eq!(upstream["content-type"], "application/json");
        assert_eq!(upstream["accept-encoding"], "identity");
        assert!(!upstream.contains_key(PROVIDER_HEADER));
        assert!(!upstream.contains_key("host"));
    }

    #[test]
    fn sentinel_uses_configured_key() {
        let incoming = headers(&[("authorization", &format!("Bearer {PROXY_KEY_SENTINEL}"))]);
        let upstream = build_upstream_headers(&incoming, ProviderProtocol::Openai, &config());
        assert_eq!(upstream["authorization"], "Bearer openai-key");
    }

    #[test]
    fn anthropic_gets_version_and_key() {
        let upstream = build_upstream_headers(
            &headers(&[("x-api-key", PROXY_KEY_SENTINEL)]),
            ProviderProtocol::Anthropic,
            &config(),
        );
        assert_eq!(upstream["x-api-key"], "anthropic-key");
        assert_eq!(upstream["anthropic-version"], "2023-06-01");
    }

    #[test]
    fn gemini_gets_google_key() {
        let upstream =
            build_upstream_headers(&HeaderMap::new(), ProviderProtocol::Gemini, &config());
        assert_eq!(upstream["x-goog-api-key"], "gemini-key");
    }

    #[test]
    fn response_headers_strip_encoding_and_add_ids() {
        let upstream = headers(&[
            ("content-type", "text/event-stream"),
            ("content-length", "10"),
            ("content-encoding", "gzip"),
        ]);
        let headers = build_response_headers(&upstream, true, Some("session"), Some("step"));
        assert_eq!(headers["content-type"], "text/event-stream");
        assert!(!headers.contains_key("content-length"));
        assert!(!headers.contains_key("content-encoding"));
        assert_eq!(headers["x-accel-buffering"], "no");
        assert_eq!(headers[SESSION_ID_HEADER], "session");
        assert_eq!(headers[STEP_ID_HEADER], "step");
    }

    #[test]
    fn detects_recordable_paths() {
        assert!(is_recordable_path(
            &http::Method::POST,
            "/v1/chat/completions"
        ));
        assert!(is_recordable_path(
            &http::Method::POST,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent"
        ));
        assert!(!is_recordable_path(
            &http::Method::GET,
            "/v1/chat/completions"
        ));
        assert!(!is_recordable_path(&http::Method::POST, "/v1/models"));
    }

    #[test]
    fn collects_duplicate_headers() {
        let mut headers = HeaderMap::new();
        headers.append("accept", HeaderValue::from_static("a"));
        headers.append("accept", HeaderValue::from_static("b"));
        assert_eq!(collect_header_map(&headers)["accept"], "a, b");
    }
}
