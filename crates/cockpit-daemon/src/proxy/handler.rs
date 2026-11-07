use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::response::Response;
use bytes::Bytes;
use cockpit_core::agent::{detect_agent, provider_override};
use cockpit_core::collector::collect_non_stream_response;
use cockpit_core::model::StepStatus;
use cockpit_core::routing::{RouteError, parse_proxy_route};
use cockpit_core::sse::SseParser;
use cockpit_core::text::{parse_json_body, truncate_text};
use futures_util::StreamExt;
use http::StatusCode;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::proxy::headers::{
    build_response_headers, build_upstream_headers, collect_header_map, is_recordable_path,
    proxy_error_response,
};
use crate::recorder::{BeginRecordedStep, FinishRecordedStep};
use crate::state::AppState;

/// The catch-all proxy. Every path that is not an API or UI route lands here.
pub async fn proxy_handler(State(state): State<AppState>, request: Request) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();

    let protocol_header = headers
        .get("x-cockpit-protocol")
        .and_then(|value| value.to_str().ok());
    let route = match parse_proxy_route(uri.path(), protocol_header) {
        Ok(route) => route,
        Err(RouteError::InvalidSession) => {
            return proxy_error_response(
                cockpit_core::provider::ProviderProtocol::Openai,
                StatusCode::BAD_REQUEST,
                "The session id in the proxy path is not a valid UUID.",
                Some("invalid_session"),
            );
        }
        Err(RouteError::InvalidPath) => {
            return proxy_error_response(
                cockpit_core::provider::ProviderProtocol::Openai,
                StatusCode::BAD_REQUEST,
                "The proxy path is missing an API endpoint.",
                Some("invalid_path"),
            );
        }
        Err(RouteError::NotProxy) => {
            return proxy_error_response(
                cockpit_core::provider::ProviderProtocol::Openai,
                StatusCode::NOT_FOUND,
                "No Cockpit route matches this path.",
                Some("not_found"),
            );
        }
    };

    let recordable = is_recordable_path(&method, &route.upstream_path);
    let agent = detect_agent(&headers);
    let provider = provider_override(&headers)
        .unwrap_or_else(|| route.protocol.default_provider().to_string());

    let session = match route.session_id.as_deref() {
        Some(id) => match state.store.get_session(id) {
            Ok(Some(session)) => {
                if session.status != cockpit_core::model::SessionStatus::Active {
                    return proxy_error_response(
                        route.protocol,
                        StatusCode::CONFLICT,
                        "The requested Cockpit session has already ended.",
                        Some("session_ended"),
                    );
                }
                Some(session)
            }
            Ok(None) => {
                return proxy_error_response(
                    route.protocol,
                    StatusCode::NOT_FOUND,
                    "The requested Cockpit session does not exist.",
                    Some("session_not_found"),
                );
            }
            Err(error) => {
                tracing::error!(%error, "could not read the requested session");
                return proxy_error_response(
                    route.protocol,
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Cockpit could not read its database.",
                    Some("database_error"),
                );
            }
        },
        None => {
            if recordable {
                match state
                    .sessions
                    .resolve_ambient(route.protocol, agent.clone())
                {
                    Ok(session) => Some(session),
                    Err(error) => {
                        tracing::warn!(%error, "could not create an ambient flight");
                        None
                    }
                }
            } else {
                None
            }
        }
    };

    if let Some(session) = &session {
        state.sessions.mark_used(&session.id);
        if recordable {
            if let Err(error) =
                state
                    .store
                    .touch_session(&session.id, agent.as_ref(), Some(provider.as_str()))
            {
                tracing::warn!(%error, "could not update the session agent");
            }
        }
    }

    if let Some(declared) = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if declared > state.config.max_body_bytes as u64 {
            return proxy_error_response(
                route.protocol,
                StatusCode::PAYLOAD_TOO_LARGE,
                "The request body is larger than Cockpit allows.",
                None,
            );
        }
    }

    let body_bytes = match to_bytes(request.into_body(), state.config.max_body_bytes).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return proxy_error_response(
                route.protocol,
                StatusCode::PAYLOAD_TOO_LARGE,
                "The request body is larger than Cockpit allows.",
                None,
            );
        }
    };
    let body_text = String::from_utf8_lossy(&body_bytes).to_string();

    if let Some(session) = &session {
        if recordable {
            // Budgets run first: a blocked budget must not spend time on the
            // guard detectors or on a git snapshot.
            match state.budgets.check(&session.id).await {
                Ok(result) => {
                    if let Some(blocked) = result.blocked {
                        let message = format!(
                            "Cockpit blocked this request: the \"{}\" budget is exhausted ({:.4} USD of {:.4} USD).",
                            blocked.policy.name, blocked.status.spent_usd, blocked.status.limit_usd
                        );
                        return proxy_error_response(
                            route.protocol,
                            StatusCode::PAYMENT_REQUIRED,
                            &message,
                            Some("budget_exceeded"),
                        );
                    }
                }
                Err(error) => {
                    // Fail open: a budget lookup failure must never break the
                    // proxy, and the request is still recorded and guarded.
                    tracing::warn!(%error, "Cockpit budget evaluation failed");
                }
            }

            let guard_input = crate::guards::GuardRequestInput {
                session_id: session.id.clone(),
                protocol: route.protocol,
                path: route.upstream_path.clone(),
                headers: collect_header_map(&headers),
                body_text: body_text.clone(),
            };
            match state.guards.evaluate_request(guard_input).await {
                Ok(result) => {
                    if !result.allowed {
                        let status = result
                            .status
                            .and_then(|value| StatusCode::from_u16(value).ok())
                            .unwrap_or(StatusCode::FORBIDDEN);
                        return proxy_error_response(
                            route.protocol,
                            status,
                            result.message.as_deref().unwrap_or(
                                "Cockpit blocked this request because a guard rule matched.",
                            ),
                            result.code.as_deref().or(Some("guard_blocked")),
                        );
                    }
                }
                Err(error) => {
                    // Guard evaluation fails open by design. The recorder
                    // still redacts secrets and stores every step.
                    tracing::warn!(%error, "Cockpit guard evaluation failed");
                }
            }

            if let Err(error) = state.snapshots.ensure_baseline(session).await {
                tracing::warn!(%error, session_id = session.id, "could not capture a baseline snapshot");
            }
            if let Err(error) = state.snapshots.settle_pending_step(&session.id).await {
                tracing::warn!(%error, session_id = session.id, "could not settle a pending snapshot");
            }
        }
    }

    let mut handle = if recordable {
        session.as_ref().and_then(|session| {
            let input = BeginRecordedStep {
                session_id: session.id.clone(),
                protocol: route.protocol,
                provider: Some(provider.clone()),
                method: method.as_str().to_string(),
                path: route.upstream_path.clone(),
                headers: collect_header_map(&headers),
                body_text: body_text.clone(),
            };
            match state.recorder.begin(input) {
                Ok(handle) => Some(handle),
                Err(error) => {
                    tracing::warn!(%error, "could not begin recording a proxy step");
                    None
                }
            }
        })
    } else {
        None
    };

    let mut upstream_url = format!(
        "{}{}",
        state.config.upstream_base(route.protocol),
        route.upstream_path
    );
    if let Some(query) = uri.query() {
        upstream_url.push('?');
        upstream_url.push_str(query);
    }

    let upstream_headers = build_upstream_headers(&headers, route.protocol, &state.config);
    let mut builder = state
        .client
        .request(method.clone(), &upstream_url)
        .headers(upstream_headers);
    if method != http::Method::GET && method != http::Method::HEAD && !body_bytes.is_empty() {
        builder = builder.body(body_bytes.to_vec());
    }

    let upstream = match builder.send().await {
        Ok(upstream) => upstream,
        Err(error) => {
            let message = truncate_text(
                &format!("Cockpit could not reach the upstream: {error}"),
                1_000,
            );
            if let Some(handle) = handle.as_mut() {
                let _ = state.recorder.finish(
                    handle,
                    FinishRecordedStep {
                        status: StepStatus::Failed,
                        response_status: 502,
                        response_headers: Default::default(),
                        collected: None,
                        error: Some(message.clone()),
                        ttft_ms: None,
                    },
                );
            }
            tracing::warn!(%error, "upstream request failed");
            return proxy_error_response(
                route.protocol,
                StatusCode::BAD_GATEWAY,
                &message,
                Some("upstream_unreachable"),
            );
        }
    };

    let upstream_status = upstream.status();
    let is_event_stream = upstream
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    let response_headers = build_response_headers(
        upstream.headers(),
        is_event_stream,
        session.as_ref().map(|session| session.id.as_str()),
        handle.as_ref().map(|handle| handle.step_id()),
    );

    let Some(handle) = handle.take() else {
        if method == http::Method::HEAD
            || upstream_status == StatusCode::NO_CONTENT
            || upstream_status == StatusCode::NOT_MODIFIED
        {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = upstream_status;
            *response.headers_mut() = response_headers;
            return response;
        }

        let stream = upstream
            .bytes_stream()
            .map(|result| result.map_err(std::io::Error::other));
        let mut response = Response::new(Body::from_stream(stream));
        *response.status_mut() = upstream_status;
        *response.headers_mut() = response_headers;
        return response;
    };

    if is_event_stream {
        let recorder = state.recorder.clone();
        let response_header_map = collect_header_map(upstream.headers());
        let (sender, receiver) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);

        tokio::spawn(async move {
            let mut handle = handle;
            let mut parser = SseParser::new();
            let mut cancelled = false;
            let mut stream_error: Option<String> = None;
            let mut stream = upstream.bytes_stream();

            while let Some(item) = stream.next().await {
                match item {
                    Ok(bytes) => {
                        recorder.mark_first_byte(&mut handle);
                        for event in parser.feed(&bytes) {
                            recorder.record_stream_event(&mut handle, &event);
                        }
                        if sender.send(Ok(bytes)).await.is_err() {
                            cancelled = true;
                            break;
                        }
                    }
                    Err(error) => {
                        stream_error = Some(error.to_string());
                        break;
                    }
                }
            }

            for event in parser.end() {
                recorder.record_stream_event(&mut handle, &event);
            }

            let status = if cancelled {
                StepStatus::Cancelled
            } else if stream_error.is_some() || upstream_status.as_u16() >= 400 {
                StepStatus::Failed
            } else {
                StepStatus::Completed
            };
            let error = if cancelled {
                Some("The client disconnected before the stream completed.".to_string())
            } else {
                stream_error.clone()
            };
            let _ = recorder.finish(
                &mut handle,
                FinishRecordedStep {
                    status,
                    response_status: upstream_status.as_u16(),
                    response_headers: response_header_map,
                    collected: None,
                    error,
                    ttft_ms: None,
                },
            );

            if let Some(error) = stream_error {
                let _ = sender.send(Err(std::io::Error::other(error))).await;
            }
        });

        let mut response = Response::new(Body::from_stream(ReceiverStream::new(receiver)));
        *response.status_mut() = upstream_status;
        *response.headers_mut() = response_headers;
        return response;
    }

    let final_response_headers = collect_header_map(upstream.headers());
    let response_body = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            let message = truncate_text(
                &format!("Cockpit could not read the upstream response: {error}"),
                1_000,
            );
            let mut handle = handle;
            let _ = state.recorder.finish(
                &mut handle,
                FinishRecordedStep {
                    status: StepStatus::Failed,
                    response_status: upstream_status.as_u16(),
                    response_headers: final_response_headers.clone(),
                    collected: None,
                    error: Some(message.clone()),
                    ttft_ms: None,
                },
            );
            return proxy_error_response(
                route.protocol,
                StatusCode::BAD_GATEWAY,
                &message,
                Some("upstream_read_error"),
            );
        }
    };

    let response_text = String::from_utf8_lossy(&response_body).to_string();
    let parsed = parse_json_body(&response_text);
    let collected = parsed
        .value
        .as_ref()
        .map(|value| collect_non_stream_response(route.protocol, &route.upstream_path, value));
    let status = if upstream_status.as_u16() >= 400
        || collected
            .as_ref()
            .is_some_and(|response| response.error.is_some())
    {
        StepStatus::Failed
    } else {
        StepStatus::Completed
    };
    let error = if upstream_status.as_u16() >= 400 {
        collected
            .as_ref()
            .and_then(|response| response.error.clone())
            .or_else(|| Some(truncate_text(&response_text, 2_000)))
    } else {
        None
    };

    let mut handle = handle;
    if let Err(error) = state.recorder.finish(
        &mut handle,
        FinishRecordedStep {
            status,
            response_status: upstream_status.as_u16(),
            response_headers: final_response_headers,
            collected,
            error,
            ttft_ms: None,
        },
    ) {
        tracing::warn!(%error, "could not finalize a recorded step");
    }

    if method == http::Method::HEAD
        || upstream_status == StatusCode::NO_CONTENT
        || upstream_status == StatusCode::NOT_MODIFIED
    {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = upstream_status;
        *response.headers_mut() = response_headers;
        return response;
    }

    let mut response = Response::new(Body::from(response_body));
    *response.status_mut() = upstream_status;
    *response.headers_mut() = response_headers;
    response
}
