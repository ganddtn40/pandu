//! Desktop-only startup and commands.
//!
//! The daemon is embedded in the app. If a `pandu serve` daemon already owns the
//! configured port and data directory, the app attaches to it instead of opening
//! a second writer on the same SQLite database.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::CheckMenuItem;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, State, WebviewUrl, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_deep_link::DeepLinkExt as _;
use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt as _;
use url::Url;

use pandu_core::brand;
use pandu_daemon::{Config, ServerHandle};

use crate::shell;
use crate::tray;

/// State shared by every command. The daemon handle is `None` when the app
/// attached to an already-running `pandu serve`.
pub struct ShellState {
    pub origin: String,
    pub handle: Mutex<Option<ServerHandle>>,
    pub deep_link: Mutex<Option<String>>,
    pub attached: bool,
    pub autostart_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    origin: String,
    version: String,
    platform: String,
    autostart: bool,
    attached: bool,
}

struct DaemonBoot {
    origin: String,
    handle: Option<ServerHandle>,
    attached: bool,
}

/// Start the daemon (or attach to one) before the first window loads.
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let boot =
        tauri::async_runtime::block_on(start_daemon(app.handle().clone())).map_err(|error| {
            show_fatal(app, &error);
            std::io::Error::other(error)
        })?;

    write_smoke_origin(&boot);

    app.manage(ShellState {
        origin: boot.origin.clone(),
        handle: Mutex::new(boot.handle),
        deep_link: Mutex::new(None),
        attached: boot.attached,
        autostart_item: Mutex::new(None),
    });

    create_window(app, &boot.origin)?;
    let item = tray::create(app)?;
    if let Ok(mut slot) = app.state::<ShellState>().autostart_item.lock() {
        *slot = Some(item);
    }
    register_deep_links(app);
    Ok(())
}

fn create_window(app: &tauri::App, origin: &str) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle().clone();
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(brand::WINDOW_TITLE)
        .inner_size(1180.0, 780.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .visible(false)
        .devtools(
            cfg!(debug_assertions)
                || std::env::var_os(brand::env_name("WEBVIEW_DEVTOOLS")).is_some(),
        )
        .initialization_script(shell::init_script(origin))
        .on_navigation(move |url| navigation_allowed(&app_handle, url));
    // The resource benchmark needs a WebView2 debugging endpoint to read the
    // first-interactive-frame timestamp. This is an environment-only hook; the
    // app never enables it by itself.
    if let Some(args) = std::env::var_os(brand::env_name("WEBVIEW_ARGS")) {
        builder = builder.additional_browser_args(&args.to_string_lossy());
    }
    let window = builder.build()?;

    // Closing the window keeps the recorder alive in the tray. Quit is an
    // explicit action from the tray menu.
    let close_handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_handle.hide();
        }
    });
    window.show()?;
    Ok(())
}

/// A GUI process has no usable stdout. When `PANDU_SMOKE_ORIGIN` is set, write
/// the ephemeral daemon origin there so the packaged smoke test can probe
/// health and the bundled UI without guessing the port.
fn write_smoke_origin(boot: &DaemonBoot) {
    let Some(path) = std::env::var_os(brand::env_name("SMOKE_ORIGIN")) else {
        return;
    };
    let payload = serde_json::json!({
        "origin": boot.origin,
        "attached": boot.attached,
    });
    let _ = std::fs::write(path, payload.to_string());
}

async fn start_daemon(app: AppHandle) -> Result<DaemonBoot, String> {
    let mut config = Config::load().map_err(|error| error.to_string())?;
    let configured_port = config.port;

    if configured_port != 0
        && let Some(origin) = probe_existing(configured_port, &config.home).await
    {
        tracing::info!(%origin, "attached to the running daemon");
        return Ok(DaemonBoot {
            origin,
            handle: None,
            attached: true,
        });
    }

    // A desktop app must not fight a `pandu serve` on the default port. An
    // explicit PANDU_PORT is respected; otherwise the embedded daemon takes an
    // ephemeral loopback port.
    if std::env::var_os(brand::env_name("PORT")).is_none() {
        config.port = 0;
    }
    if let Some(ui_dir) = bundled_ui_dir(&app) {
        config.ui_dir = ui_dir;
    }
    for origin in [
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ] {
        if !config.allowed_origins.iter().any(|value| value == origin) {
            config.allowed_origins.push(origin.to_string());
        }
    }

    let handle = pandu_daemon::spawn(config)
        .await
        .map_err(|error| format!("The embedded daemon could not start: {error}"))?;
    let origin = format!("http://{}", handle.addr);
    tracing::info!(%origin, "embedded daemon started");
    Ok(DaemonBoot {
        origin,
        handle: Some(handle),
        attached: false,
    })
}

async fn probe_existing(port: u16, home: &Path) -> Option<String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(900))
        .build()
        .ok()?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    let data_dir = body.get("dataDir")?.as_str()?;
    let expected = std::path::absolute(home).ok()?;
    let expected = expected.to_string_lossy();
    if !data_dir.eq_ignore_ascii_case(&expected) {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}"))
}

fn bundled_ui_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource) = app.path().resource_dir() {
        let candidate = resource.join("ui").join("dist");
        if candidate.join("index.html").is_file() {
            return Some(candidate);
        }
    }
    // `tauri dev` runs before the installer resources exist.
    let candidate = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("ui")
        .join("dist");
    candidate.join("index.html").is_file().then_some(candidate)
}

fn navigation_allowed(app: &AppHandle, url: &Url) -> bool {
    if is_internal_url(url) {
        return true;
    }
    if url.scheme() == "https" {
        let app = app.clone();
        let target = url.to_string();
        tauri::async_runtime::spawn(async move {
            let _ = confirm_open_external(app, target).await;
        });
    }
    false
}

fn is_internal_url(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("127.0.0.1" | "localhost")) => {
            matches!(url.port(), Some(5174 | 4174))
        }
        ("about", _) => true,
        _ => false,
    }
}

fn register_deep_links(app: &tauri::App) {
    if let Err(error) = app.deep_link().register_all() {
        tracing::warn!(%error, "could not register the URL scheme");
    }
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            deliver_deep_link(&handle, url.as_str());
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            deliver_deep_link(app.handle(), url.as_str());
        }
    }
}

fn deliver_deep_link(app: &AppHandle, raw: &str) {
    let Some(route) = shell::route_from_deep_link(raw) else {
        tracing::warn!("refused a malformed deep link");
        return;
    };
    tracing::info!(%route, "opened a deep link");
    if let Some(state) = app.try_state::<ShellState>()
        && let Ok(mut slot) = state.deep_link.lock()
    {
        *slot = Some(route);
    }
    show_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let event = serde_json::to_string(&format!("{}:deep-link", brand::URL_SCHEME))
            .expect("an event name is serializable");
        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent({event}));"));
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Stop the embedded daemon. An attached daemon belongs to `pandu serve` and is
/// left running.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let handle = state.handle.lock().ok().and_then(|mut slot| slot.take());
    let Some(handle) = handle else {
        return;
    };
    let _ = tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_secs(4), handle.shutdown()).await
    });
}

fn show_fatal(app: &tauri::App, message: &str) {
    tracing::error!("{message}");
    let app = app.handle().clone();
    let message = message.to_string();
    // The setup hook runs on the main thread; rfd's blocking dialog must not.
    let _ = std::thread::spawn(move || {
        app.dialog()
            .message(message)
            .title(brand::PRODUCT_NAME)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::Ok)
            .blocking_show();
    })
    .join();
}

#[tauri::command]
pub fn desktop_info(app: AppHandle, state: State<'_, ShellState>) -> DesktopInfo {
    DesktopInfo {
        origin: state.origin.clone(),
        version: pandu_core::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        attached: state.attached,
    }
}

#[tauri::command]
pub async fn confirm_open_external(app: AppHandle, url: String) -> Result<bool, String> {
    let target = shell::validate_external_url(&url)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Open this link in your browser?\n\n{}\n\nOnly continue if you trust the site.",
            target.as_str()
        ))
        .title(format!("Open external link in {}", brand::PRODUCT_NAME))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    if !receiver.await.unwrap_or(false) {
        return Ok(false);
    }
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn take_deep_link(state: State<'_, ShellState>) -> Option<String> {
    state.deep_link.lock().ok().and_then(|mut slot| slot.take())
}

#[tauri::command]
pub fn set_autostart(
    app: AppHandle,
    state: State<'_, ShellState>,
    enabled: bool,
) -> Result<bool, String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|error| error.to_string())?;
    let actual = manager.is_enabled().unwrap_or(enabled);
    if let Ok(slot) = state.autostart_item.lock()
        && let Some(item) = slot.as_ref()
    {
        let _ = item.set_checked(actual);
    }
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_urls_are_the_tauri_origins_and_the_dev_server() {
        assert!(is_internal_url(
            &Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(is_internal_url(
            &Url::parse("tauri://localhost/settings").unwrap()
        ));
        assert!(is_internal_url(
            &Url::parse("http://127.0.0.1:5174/").unwrap()
        ));
        assert!(!is_internal_url(
            &Url::parse("https://example.com/").unwrap()
        ));
        assert!(!is_internal_url(
            &Url::parse("http://127.0.0.1:4319/").unwrap()
        ));
    }
}
