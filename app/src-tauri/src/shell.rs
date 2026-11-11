//! Shared shell helpers: deep-link parsing, external-link validation, and the
//! small JavaScript bridge injected before the UI boots.
//!
//! Nothing here trusts the webview. The bridge only forwards requests to Rust
//! commands that validate their arguments again.

use url::Url;

use pandu_core::brand;

/// Longest deep link we accept. A route is not a document.
const MAX_DEEP_LINK: usize = 512;
/// Longest external URL we accept.
const MAX_EXTERNAL_URL: usize = 2_048;

/// Turn a `pandu://` link into an in-app route.
///
/// Only the five product tabs and the explicit `open` form are accepted. The
/// parser never returns a scheme, a host, or a path that could escape the app.
pub fn route_from_deep_link(raw: &str) -> Option<String> {
    if raw.len() > MAX_DEEP_LINK {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != brand::URL_SCHEME {
        return None;
    }
    let route = match url.host_str() {
        None => "/".to_string(),
        Some("open") => url
            .query_pairs()
            .find(|(key, _)| key == "path")
            .map(|(_, value)| value.into_owned())?,
        Some("home") => "/".to_string(),
        Some(tab @ ("inbox" | "flights" | "market" | "settings")) => tab_route(tab, &url)?,
        Some(_) => return None,
    };
    if !valid_route(&route) {
        return None;
    }
    Some(route)
}

/// Turn `pandu://flights/<id>` into `/flights?session=<id>` and keep a normal
/// query intact. Other tabs accept a query but no path segment.
fn tab_route(tab: &str, url: &Url) -> Option<String> {
    let segment = url.path().trim_matches('/');
    let mut params: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    if !segment.is_empty() {
        let safe = segment
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'));
        if tab != "flights" || !safe {
            return None;
        }
        params.insert(0, ("session".to_string(), segment.to_string()));
    }
    if params.is_empty() {
        return Some(format!("/{tab}"));
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params)
        .finish();
    Some(format!("/{tab}?{query}"))
}

fn valid_route(route: &str) -> bool {
    if !route.starts_with('/') || route.len() > MAX_DEEP_LINK {
        return false;
    }
    if route.contains("..") || route.contains("//") {
        return false;
    }
    route.chars().all(|value| {
        value.is_ascii_alphanumeric()
            || matches!(value, '/' | '-' | '_' | '?' | '=' | '&' | '.' | '%')
    })
}

/// Validate a link before it is shown in a native confirmation dialog.
///
/// External links must be HTTPS, must have a host, and must not carry
/// credentials. The confirmation is the user's decision; this function only
/// removes the dangerous shapes.
pub fn validate_external_url(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_EXTERNAL_URL {
        return Err("That link is too long.".to_string());
    }
    if raw
        .chars()
        .any(|value| value.is_control() || value.is_whitespace())
    {
        return Err("That link contains whitespace or control characters.".to_string());
    }
    let url = Url::parse(raw).map_err(|_| "That link is not a valid URL.".to_string())?;
    if url.scheme() != "https" {
        return Err("Only HTTPS links can be opened in the browser.".to_string());
    }
    if url.host_str().is_none() {
        return Err("That link has no host.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Links with embedded credentials are refused.".to_string());
    }
    Ok(url)
}

/// The initialization script that runs before any UI module.
///
/// It points the UI at the embedded daemon, intercepts every external link, and
/// exposes only the shell commands the UI is allowed to call. The script never
/// contains user input.
pub fn init_script(origin: &str) -> String {
    let origin = serde_json::to_string(origin).expect("a URL is always serializable");
    let platform = serde_json::to_string(std::env::consts::OS).expect("an OS is serializable");
    format!(
        r#"
window.__panduDaemonUrl = {origin};
(function () {{
  var invoke = function (command, args) {{
    return window.__TAURI_INTERNALS__.invoke(command, args);
  }};
  var openExternal = function (url) {{
    return invoke('confirm_open_external', {{ url: String(url) }});
  }};
  window.__panduDesktop = {{
    mode: 'desktop',
    platform: {platform},
    openExternal: openExternal,
    takeDeepLink: function () {{ return invoke('take_deep_link'); }},
    setAutostart: function (enabled) {{
      return invoke('set_autostart', {{ enabled: !!enabled }});
    }},
    autostartEnabled: function () {{
      return invoke('desktop_info').then(function (info) {{ return !!info.autostart; }});
    }}
  }};
  var originalOpen = window.open;
  window.open = function (url) {{
    if (url) {{
      void openExternal(url);
      return null;
    }}
    return originalOpen.apply(window, arguments);
  }};
  document.addEventListener('click', function (event) {{
    var target = event.target;
    if (!target || !target.closest) return;
    var anchor = target.closest('a[href]');
    if (!anchor) return;
    var href = anchor.href;
    if (!href) return;
    var internal = href === location.origin || href.indexOf(location.origin + '/') === 0;
    if (anchor.target !== '_blank' && internal) return;
    event.preventDefault();
    event.stopPropagation();
    void openExternal(href);
  }}, true);
}})();
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_five_tabs_and_open_form() {
        assert_eq!(
            route_from_deep_link("pandu://flights/abc").as_deref(),
            Some("/flights?session=abc")
        );
        assert_eq!(
            route_from_deep_link("pandu://flights?session=abc").as_deref(),
            Some("/flights?session=abc")
        );
        assert_eq!(
            route_from_deep_link("pandu://open?path=%2Finbox").as_deref(),
            Some("/inbox")
        );
        assert_eq!(route_from_deep_link("pandu://home").as_deref(), Some("/"));
        assert_eq!(route_from_deep_link("pandu://").as_deref(), Some("/"));
    }

    #[test]
    fn rejects_routes_that_escape_the_app() {
        assert!(route_from_deep_link("pandu://open?path=https://example.com").is_none());
        assert!(route_from_deep_link("pandu://open?path=/../../etc/passwd").is_none());
        assert!(route_from_deep_link("pandu://unknown/x").is_none());
        assert!(route_from_deep_link("https://example.com").is_none());
        assert!(route_from_deep_link("javascript:alert(1)").is_none());
    }

    #[test]
    fn accepts_only_clean_https_external_links() {
        assert!(validate_external_url("https://example.com/docs").is_ok());
        assert!(validate_external_url("http://example.com").is_err());
        assert!(validate_external_url("https://user:pass@example.com").is_err());
        assert!(validate_external_url("https://example.com/a b").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn the_bridge_points_at_the_given_origin() {
        let script = init_script("http://127.0.0.1:4319");
        assert!(script.contains("http://127.0.0.1:4319"));
        assert!(script.contains("__panduDesktop"));
    }
}
