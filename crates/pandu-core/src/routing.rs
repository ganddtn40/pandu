use percent_encoding::percent_decode_str;

use crate::ids::is_id;
use crate::provider::ProviderProtocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteError {
    NotProxy,
    InvalidSession,
    InvalidPath,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyRoute {
    pub session_id: Option<String>,
    pub protocol: ProviderProtocol,
    pub upstream_path: String,
    pub forced_protocol: bool,
}

fn strip_forced_prefix(path: &str, prefix: &str, base: &str) -> Option<String> {
    if path == prefix {
        return Some(base.to_string());
    }
    if path.starts_with(&format!("{prefix}/v1")) {
        return Some(path[prefix.len()..].to_string());
    }
    None
}

fn strip_gemini_prefix(path: &str) -> Option<String> {
    if path == "/gemini" {
        return Some("/v1beta".to_string());
    }
    if path.starts_with("/gemini/v1beta") || path.starts_with("/gemini/v1") {
        return Some(path["/gemini".len()..].to_string());
    }
    None
}

fn detect_path_protocol(path: &str) -> ProviderProtocol {
    if path == "/v1/messages"
        || path.starts_with("/v1/messages/")
        || path == "/v1/complete"
        || path.starts_with("/v1/complete/")
    {
        return ProviderProtocol::Anthropic;
    }
    if path.starts_with("/v1beta/")
        || path.contains(":generateContent")
        || path.contains(":streamGenerateContent")
    {
        return ProviderProtocol::Gemini;
    }
    ProviderProtocol::Openai
}

fn protocol_from_header(value: Option<&str>) -> Option<ProviderProtocol> {
    value.and_then(ProviderProtocol::parse)
}

/// Parse a request path into a proxy route.
///
/// Compatibility surface:
/// - `/v1/...` — OpenAI-compatible default
/// - `/openai/v1/...` — force OpenAI
/// - `/anthropic/v1/...` — force Anthropic
/// - `/gemini/v1beta/...` — force Gemini
/// - `/s/:session/...` — bind to a known session, then apply the same rules
pub fn parse_proxy_route(
    pathname: &str,
    protocol_header: Option<&str>,
) -> Result<ProxyRoute, RouteError> {
    let mut remainder = pathname.to_string();
    let mut session_id = None;

    if let Some(rest) = pathname.strip_prefix("/s/") {
        let (raw_session, tail) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, "/"),
        };
        if raw_session.is_empty() {
            return Err(RouteError::InvalidSession);
        }
        let decoded = percent_decode_str(raw_session)
            .decode_utf8()
            .map_err(|_| RouteError::InvalidSession)?;
        if !is_id(&decoded) {
            return Err(RouteError::InvalidSession);
        }
        session_id = Some(decoded.into_owned());
        remainder = tail.to_string();
    }

    let mut forced_protocol = None;
    if let Some(stripped) = strip_forced_prefix(&remainder, "/openai", "/v1") {
        forced_protocol = Some(ProviderProtocol::Openai);
        remainder = stripped;
    }
    if let Some(stripped) = strip_forced_prefix(&remainder, "/anthropic", "/v1") {
        forced_protocol = Some(ProviderProtocol::Anthropic);
        remainder = stripped;
    }
    if let Some(stripped) = strip_gemini_prefix(&remainder) {
        forced_protocol = Some(ProviderProtocol::Gemini);
        remainder = stripped;
    }

    if remainder != "/v1"
        && remainder != "/v1beta"
        && !remainder.starts_with("/v1/")
        && !remainder.starts_with("/v1beta/")
    {
        return Err(RouteError::NotProxy);
    }
    if remainder == "/v1" || remainder == "/v1beta" {
        return Err(RouteError::InvalidPath);
    }

    let protocol = forced_protocol
        .or_else(|| protocol_from_header(protocol_header))
        .unwrap_or_else(|| detect_path_protocol(&remainder));

    Ok(ProxyRoute {
        session_id,
        protocol,
        upstream_path: remainder,
        forced_protocol: forced_protocol.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(path: &str) -> ProxyRoute {
        parse_proxy_route(path, None).unwrap()
    }

    #[test]
    fn defaults_to_openai() {
        let route = route("/v1/chat/completions");
        assert_eq!(route.protocol, ProviderProtocol::Openai);
        assert_eq!(route.upstream_path, "/v1/chat/completions");
        assert_eq!(route.session_id, None);
    }

    #[test]
    fn detects_anthropic_by_path() {
        assert_eq!(route("/v1/messages").protocol, ProviderProtocol::Anthropic);
        assert_eq!(
            route("/v1/messages/count_tokens").protocol,
            ProviderProtocol::Anthropic
        );
    }

    #[test]
    fn detects_gemini_by_path() {
        let route = route("/v1beta/models/gemini-2.5-pro:generateContent");
        assert_eq!(route.protocol, ProviderProtocol::Gemini);
    }

    #[test]
    fn forced_prefixes_win_over_headers() {
        let route = parse_proxy_route("/anthropic/v1/chat/completions", Some("openai")).unwrap();
        assert_eq!(route.protocol, ProviderProtocol::Anthropic);
        assert!(route.forced_protocol);
        assert_eq!(route.upstream_path, "/v1/chat/completions");
    }

    #[test]
    fn header_overrides_path_detection() {
        let route = parse_proxy_route("/v1/chat/completions", Some("gemini")).unwrap();
        assert_eq!(route.protocol, ProviderProtocol::Gemini);
        assert!(!route.forced_protocol);
    }

    #[test]
    fn parses_session_prefix() {
        let id = "3f7a1c2e-1111-4222-8333-444455556666";
        let route = route(&format!("/s/{id}/v1/chat/completions"));
        assert_eq!(route.session_id.as_deref(), Some(id));
        assert_eq!(route.upstream_path, "/v1/chat/completions");
    }

    #[test]
    fn rejects_bad_paths() {
        assert_eq!(parse_proxy_route("/v1", None), Err(RouteError::InvalidPath));
        assert_eq!(
            parse_proxy_route("/v1beta", None),
            Err(RouteError::InvalidPath)
        );
        assert_eq!(
            parse_proxy_route("/health", None),
            Err(RouteError::NotProxy)
        );
        assert_eq!(
            parse_proxy_route("/s/not-a-uuid/v1/messages", None),
            Err(RouteError::InvalidSession)
        );
    }
}
