//! Host-only model/effort rewriting for the proxy.
//!
//! The override is deliberately narrow: Cockpit rewrites only the `model`
//! field and the provider-specific reasoning effort field. Everything else in
//! the request body is preserved. When the override cannot be applied safely
//! (unknown model, unsupported effort, non-JSON body, missing model field) the
//! request is forwarded unchanged and the step is flagged as a fail-open.

use bytes::Bytes;
use cockpit_core::cost::{EffortControl, find_builtin_model};
use cockpit_core::provider::ProviderProtocol;
use serde_json::{Map, Value, json};

use crate::sessions::ModelOverride;

/// Every effort spelling Cockpit knows about. Fields that do not apply to the
/// target model are removed so a switch cannot leave an incompatible parameter
/// behind. Gemini 2.5 uses `thinkingBudget` while Gemini 3 and 4 use
/// `thinkingLevel`; both paths are listed so a cross-generation switch always
/// clears the other generation's field.
const EFFORT_PATHS: &[&str] = &[
    "reasoning_effort",
    "reasoning.effort",
    "output_config.effort",
    "generationConfig.thinkingConfig.thinkingLevel",
    "thinkingConfig.thinkingLevel",
    "generationConfig.thinkingConfig.thinkingBudget",
    "thinkingConfig.thinkingBudget",
];

#[derive(Debug, Clone)]
pub struct RewriteOutcome {
    pub body: Bytes,
    pub path: String,
    /// Step metadata describing the rewrite. `None` means the request was
    /// forwarded exactly as it arrived.
    pub info: Option<Value>,
}

/// Rewrite a proxy request when an override is active.
///
/// With no override the returned body is the same `Bytes` handle and the path
/// is unchanged, which keeps the forwarded bytes byte-identical.
pub fn rewrite_request(
    body: &Bytes,
    path: &str,
    protocol: ProviderProtocol,
    provider: &str,
    override_: Option<&ModelOverride>,
) -> RewriteOutcome {
    let Some(override_) = override_ else {
        return RewriteOutcome {
            body: body.clone(),
            path: path.to_string(),
            info: None,
        };
    };

    match apply(body, path, protocol, provider, override_) {
        Ok((body, path, info)) => RewriteOutcome {
            body: Bytes::from(body),
            path,
            info: Some(info),
        },
        Err(reason) => RewriteOutcome {
            body: body.clone(),
            path: path.to_string(),
            info: Some(json!({
                "applied": false,
                "modifiedBy": "cockpit",
                "failedOpen": true,
                "reason": reason,
                "model": { "to": override_.model },
                "effort": override_.effort,
            })),
        },
    }
}

fn apply(
    body: &[u8],
    path: &str,
    protocol: ProviderProtocol,
    provider: &str,
    override_: &ModelOverride,
) -> std::result::Result<(Vec<u8>, String, Value), &'static str> {
    let pricing = find_builtin_model(&override_.model, Some(provider)).ok_or("model_not_found")?;
    if cockpit_core::cost::canonical_provider(&pricing.provider)
        != cockpit_core::cost::canonical_provider(provider)
    {
        return Err("provider_mismatch");
    }

    let mut value: Value = serde_json::from_slice(body).map_err(|_| "body_not_json")?;
    let object = value.as_object_mut().ok_or("body_not_object")?;

    let (original_model, new_path) = if protocol == ProviderProtocol::Gemini {
        let original = model_from_path(path)
            .ok_or("model_not_in_path")?
            .to_string();
        let new_path = rewrite_gemini_path(path, &override_.model).ok_or("model_not_in_path")?;
        if let Some(model) = object.get_mut("model") {
            *model = Value::String(override_.model.clone());
        }
        (original, new_path)
    } else {
        let original = object
            .get("model")
            .and_then(Value::as_str)
            .ok_or("model_not_in_request")?
            .to_string();
        object.insert("model".to_string(), Value::String(override_.model.clone()));
        (original, path.to_string())
    };

    let control = pricing.effort.as_ref();
    let parameter = control.map(|control| control.parameter_for(protocol, path));
    let original_effort = parameter
        .and_then(|parameter| get_path(object, parameter))
        .and_then(effort_from_value)
        .or_else(|| {
            EFFORT_PATHS
                .iter()
                .find_map(|candidate| get_path(object, candidate).and_then(effort_from_value))
        });

    let target_effort = match (control, override_.effort.as_deref()) {
        (Some(control), Some(level)) => Some(control.normalize(level).ok_or("effort_unsupported")?),
        (Some(control), None) => original_effort
            .clone()
            .and_then(|level| control.normalize(&level)),
        (None, Some(_)) => return Err("effort_not_supported"),
        (None, None) => None,
    };

    for candidate in EFFORT_PATHS {
        remove_path(object, candidate);
    }
    if let (Some(control), Some(level)) = (control, target_effort.as_deref()) {
        set_path(
            object,
            control.parameter_for(protocol, path),
            effort_value(control, level),
        );
    }

    let bytes = serde_json::to_vec(&value).map_err(|_| "body_not_serializable")?;
    Ok((
        bytes,
        new_path,
        json!({
            "applied": true,
            "modifiedBy": "cockpit",
            "provider": provider,
            "model": { "from": original_model, "to": override_.model },
            "effort": { "from": original_effort, "to": target_effort },
        }),
    ))
}

fn effort_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.trim().to_ascii_lowercase()),
        Value::Number(number) => {
            if number.as_i64() == Some(-1) {
                Some("dynamic".to_string())
            } else {
                Some(number.to_string())
            }
        }
        _ => None,
    }
}

/// Serialize a normalized effort for the target control. Budget models take a
/// JSON number; level models take a string.
fn effort_value(control: &EffortControl, effort: &str) -> Value {
    if control.is_budget() {
        let numeric = if effort == "dynamic" {
            -1
        } else {
            effort.parse::<i64>().unwrap_or_default()
        };
        Value::Number(numeric.into())
    } else {
        Value::String(effort.to_string())
    }
}

fn model_from_path(path: &str) -> Option<&str> {
    let after = path.split_once("/models/")?.1;
    let end = after.find([':', '/', '?']).unwrap_or(after.len());
    let model = &after[..end];
    (!model.is_empty()).then_some(model)
}

fn rewrite_gemini_path(path: &str, model: &str) -> Option<String> {
    let marker = "/models/";
    let index = path.find(marker)?;
    let after = &path[index + marker.len()..];
    let end = after.find([':', '/', '?']).unwrap_or(after.len());
    if end == 0 {
        return None;
    }
    let mut rewritten = String::with_capacity(path.len() + model.len());
    rewritten.push_str(&path[..index + marker.len()]);
    rewritten.push_str(model);
    rewritten.push_str(&after[end..]);
    Some(rewritten)
}

fn get_path<'a>(object: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let mut current = object.get(path.split('.').next()?)?;
    for part in path.split('.').skip(1) {
        current = current.as_object()?.get(part)?;
    }
    Some(current)
}

fn set_path(object: &mut Map<String, Value>, path: &str, value: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    set_parts(object, &parts, value);
}

fn set_parts(object: &mut Map<String, Value>, parts: &[&str], value: Value) {
    if parts.len() == 1 {
        object.insert(parts[0].to_string(), value);
        return;
    }
    let entry = object
        .entry(parts[0].to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    if let Some(child) = entry.as_object_mut() {
        set_parts(child, &parts[1..], value);
    }
}

fn remove_path(object: &mut Map<String, Value>, path: &str) {
    let parts: Vec<&str> = path.split('.').collect();
    remove_parts(object, &parts);
}

fn remove_parts(object: &mut Map<String, Value>, parts: &[&str]) -> bool {
    if parts.len() == 1 {
        return object.remove(parts[0]).is_some();
    }
    let Some(child) = object.get_mut(parts[0]).and_then(Value::as_object_mut) else {
        return false;
    };
    let removed = remove_parts(child, &parts[1..]);
    if removed && child.is_empty() {
        object.remove(parts[0]);
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn override_row(model: &str, effort: Option<&str>) -> ModelOverride {
        ModelOverride {
            session_id: "session".into(),
            provider: "openai".into(),
            model: model.into(),
            effort: effort.map(str::to_string),
            original_model: Some("gpt-4.1".into()),
            original_effort: None,
            set_at: "2026-11-10T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn passthrough_is_byte_identical() {
        let body = Bytes::from_static(
            br#"{"model":"gpt-4.1",  "messages":[{"role":"user","content":"hi"}]}"#,
        );
        let outcome = rewrite_request(
            &body,
            "/v1/chat/completions",
            ProviderProtocol::Openai,
            "openai",
            None,
        );
        assert_eq!(outcome.body, body);
        assert_eq!(outcome.path, "/v1/chat/completions");
        assert!(outcome.info.is_none());
    }

    #[test]
    fn rewrites_openai_model_and_effort() {
        let body = Bytes::from_static(
            br#"{"model":"gpt-4.1","reasoning_effort":"low","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        );
        let outcome = rewrite_request(
            &body,
            "/v1/chat/completions",
            ProviderProtocol::Openai,
            "openai",
            Some(&override_row("gpt-5.5", Some("high"))),
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(value["model"], "gpt-5.5");
        assert_eq!(value["reasoning_effort"], "high");
        assert_eq!(value["stream"], true);
        assert_eq!(value["messages"][0]["content"], "hi");
        assert_eq!(outcome.path, "/v1/chat/completions");
        let info = outcome.info.unwrap();
        assert_eq!(info["applied"], true);
        assert_eq!(info["modifiedBy"], "cockpit");
        assert_eq!(info["model"]["from"], "gpt-4.1");
        assert_eq!(info["model"]["to"], "gpt-5.5");
        assert_eq!(info["effort"]["from"], "low");
        assert_eq!(info["effort"]["to"], "high");
    }

    #[test]
    fn rewrites_responses_effort_path() {
        let body =
            Bytes::from_static(br#"{"model":"gpt-4.1","reasoning":{"effort":"low"},"input":"hi"}"#);
        let outcome = rewrite_request(
            &body,
            "/v1/responses",
            ProviderProtocol::Openai,
            "openai",
            Some(&override_row("gpt-5.5", Some("xhigh"))),
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(value["model"], "gpt-5.5");
        assert_eq!(value["reasoning"]["effort"], "xhigh");
    }

    #[test]
    fn rewrites_anthropic_effort_and_removes_openai_spelling() {
        let body = Bytes::from_static(
            br#"{"model":"claude-sonnet-4","reasoning_effort":"low","messages":[{"role":"user","content":"hi"}]}"#,
        );
        let mut row = override_row("claude-opus-5-5", Some("max"));
        row.provider = "anthropic".into();
        let outcome = rewrite_request(
            &body,
            "/v1/messages",
            ProviderProtocol::Anthropic,
            "anthropic",
            Some(&row),
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(value["model"], "claude-opus-5-5");
        assert_eq!(value["output_config"]["effort"], "max");
        assert!(value.get("reasoning_effort").is_none());
        assert_eq!(value["messages"][0]["content"], "hi");
    }

    #[test]
    fn rewrites_gemini_model_in_path_and_effort() {
        let body = Bytes::from_static(
            br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}}"#,
        );
        let mut row = override_row("gemini-3.8-flash", Some("high"));
        row.provider = "google".into();
        let outcome = rewrite_request(
            &body,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
            ProviderProtocol::Gemini,
            "google",
            Some(&row),
        );
        assert_eq!(
            outcome.path,
            "/v1beta/models/gemini-3.8-flash:streamGenerateContent"
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(
            value["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "high"
        );
        assert_eq!(value["contents"][0]["parts"][0]["text"], "hi");
    }

    #[test]
    fn rewrites_gemini_2_5_budget_to_a_level_model() {
        let body = Bytes::from_static(
            br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingBudget":8192}}}"#,
        );
        let mut row = override_row("gemini-3.8-flash", Some("high"));
        row.provider = "google".into();
        let outcome = rewrite_request(
            &body,
            "/v1beta/models/gemini-2.5-pro:generateContent",
            ProviderProtocol::Gemini,
            "google",
            Some(&row),
        );
        assert_eq!(
            outcome.path,
            "/v1beta/models/gemini-3.8-flash:generateContent"
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(
            value["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "high"
        );
        assert!(
            value["generationConfig"]["thinkingConfig"]
                .get("thinkingBudget")
                .is_none()
        );
        assert_eq!(outcome.info.unwrap()["effort"]["from"], "8192");
    }

    #[test]
    fn rewrites_a_level_model_to_gemini_2_5_budget() {
        let body = Bytes::from_static(
            br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}}"#,
        );
        let mut row = override_row("gemini-2.5-pro", Some("8192"));
        row.provider = "google".into();
        let outcome = rewrite_request(
            &body,
            "/v1beta/models/gemini-3.8-flash:streamGenerateContent",
            ProviderProtocol::Gemini,
            "google",
            Some(&row),
        );
        assert_eq!(
            outcome.path,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent"
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(
            value["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            8192
        );
        assert!(
            value["generationConfig"]["thinkingConfig"]
                .get("thinkingLevel")
                .is_none()
        );
        assert_eq!(outcome.info.unwrap()["effort"]["from"], "low");
    }

    #[test]
    fn rewrites_openai_effort_to_gemini_dynamic_budget() {
        let body = Bytes::from_static(
            br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"reasoning_effort":"high"}"#,
        );
        let mut row = override_row("gemini-2.5-pro", Some("dynamic"));
        row.provider = "google".into();
        let outcome = rewrite_request(
            &body,
            "/v1beta/models/gemini-3.8-flash:generateContent",
            ProviderProtocol::Gemini,
            "google",
            Some(&row),
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(
            value["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            -1
        );
        assert!(value.get("reasoning_effort").is_none());
        assert!(value.get("thinkingConfig").is_none());
    }

    #[test]
    fn rewrites_gemini_to_anthropic_and_removes_thinking_config() {
        let body = Bytes::from_static(
            br#"{"model":"claude-sonnet-4","messages":[],"generationConfig":{"thinkingConfig":{"thinkingLevel":"high","thinkingBudget":4096}}}"#,
        );
        let mut row = override_row("claude-opus-5-5", Some("max"));
        row.provider = "anthropic".into();
        let outcome = rewrite_request(
            &body,
            "/v1/messages",
            ProviderProtocol::Anthropic,
            "anthropic",
            Some(&row),
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(value["output_config"]["effort"], "max");
        assert!(value.get("generationConfig").is_none());
    }

    #[test]
    fn out_of_range_budget_fails_open() {
        let body = Bytes::from_static(br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}"#);
        let mut row = override_row("gemini-2.5-pro", Some("999999"));
        row.provider = "google".into();
        let outcome = rewrite_request(
            &body,
            "/v1beta/models/gemini-2.5-pro:generateContent",
            ProviderProtocol::Gemini,
            "google",
            Some(&row),
        );
        assert_eq!(outcome.body, body);
        assert_eq!(outcome.info.unwrap()["reason"], "effort_unsupported");
    }

    #[test]
    fn unknown_model_fails_open_with_the_original_bytes() {
        let body = Bytes::from_static(br#"{"model":"gpt-4.1","messages":[]}"#);
        let outcome = rewrite_request(
            &body,
            "/v1/chat/completions",
            ProviderProtocol::Openai,
            "openai",
            Some(&override_row("mystery-model", None)),
        );
        assert_eq!(outcome.body, body);
        let info = outcome.info.unwrap();
        assert_eq!(info["applied"], false);
        assert_eq!(info["failedOpen"], true);
        assert_eq!(info["reason"], "model_not_found");
    }

    #[test]
    fn unsupported_effort_fails_open() {
        let body = Bytes::from_static(br#"{"model":"gpt-4.1","messages":[]}"#);
        let outcome = rewrite_request(
            &body,
            "/v1/chat/completions",
            ProviderProtocol::Openai,
            "openai",
            Some(&override_row("gpt-5.5", Some("impossible"))),
        );
        assert_eq!(outcome.body, body);
        assert_eq!(outcome.info.unwrap()["reason"], "effort_unsupported");
    }

    #[test]
    fn provider_mismatch_fails_open() {
        let body = Bytes::from_static(br#"{"model":"gpt-4.1","messages":[]}"#);
        let outcome = rewrite_request(
            &body,
            "/v1/chat/completions",
            ProviderProtocol::Openai,
            "openai",
            Some(&override_row("claude-opus-5-5", None)),
        );
        assert_eq!(outcome.body, body);
        assert_eq!(outcome.info.unwrap()["reason"], "model_not_found");
    }

    #[test]
    fn switching_to_a_model_without_effort_removes_effort_fields() {
        let body = Bytes::from_static(
            br#"{"model":"gpt-5.5","reasoning":{"effort":"high"},"messages":[]}"#,
        );
        let outcome = rewrite_request(
            &body,
            "/v1/chat/completions",
            ProviderProtocol::Openai,
            "openai",
            Some(&override_row("gpt-4.1", None)),
        );
        let value: Value = serde_json::from_slice(&outcome.body).unwrap();
        assert_eq!(value["model"], "gpt-4.1");
        assert!(value.get("reasoning").is_none());
        assert_eq!(outcome.info.unwrap()["effort"]["to"], Value::Null);
    }

    #[test]
    fn non_json_bodies_fail_open() {
        let body = Bytes::from_static(b"not json");
        let outcome = rewrite_request(
            &body,
            "/v1/chat/completions",
            ProviderProtocol::Openai,
            "openai",
            Some(&override_row("gpt-5.5", None)),
        );
        assert_eq!(outcome.body, body);
        assert_eq!(outcome.info.unwrap()["reason"], "body_not_json");
    }
}
